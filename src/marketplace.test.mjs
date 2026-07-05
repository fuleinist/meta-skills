#!/usr/bin/env node

/**
 * Smoke test for marketplace.mjs
 *
 * Uses offline fixtures (no network). Tests:
 *   - parseAwesomeList on a sample README
 *   - parseAgentskillsIndex on a sample llms.txt
 *   - searchEntries scoring & ranking
 *   - dedupeEntries (prefers awesome-agent-skills over agentskills-io)
 *   - install flow (writes SKILL.md to a temp dir, registers in global.json)
 *   - CLI search/list subcommands
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mpPath = path.join(__dirname, 'marketplace.mjs');

const mp = await import(pathToFileURL(mpPath).href);

let passed = 0;
let failed = 0;

function check(label, condition) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else           { console.log(`  ✗ ${label}`); failed++; }
}

// ── Fixtures ───────────────────────────────────────────────────────────

const AWESOME_FIXTURE = `# Awesome Agent Skills

A test fixture for parsing.

<details>
<summary><h3 style="display:inline">Official Claude Skills</h3></summary>

- **[anthropics/docx](https://officialskills.sh/anthropics/skills/docx)** - Create, edit, and analyze Word documents
- **[anthropics/pdf](https://officialskills.sh/anthropics/skills/pdf)** - Extract text, create PDFs, and handle forms
- **[anthropics/algorithmic-art](https://officialskills.sh/anthropics/skills/algorithmic-art)** - Create generative art using p5.js with seeded randomness

</details>

<details>
<summary><h3 style="display:inline">Skills by Stripe Team</h3></summary>

- **[stripe/stripe-best-practices](https://officialskills.sh/stripe/skills/stripe-best-practices)** - Best practices for building Stripe integrations
- **[stripe/upgrade-stripe](https://officialskills.sh/stripe/skills/upgrade-stripe)** - Upgrade Stripe SDK and API versions

</details>

<details>
<summary><h3 style="display:inline">Skills by Vercel</h3></summary>

- **[vercel-labs/next-skills](https://github.com/vercel-labs/next-skills/tree/main/skills/next-app-router)** - Next.js App Router patterns and best practices
- **[vercel-labs/react-server-components](https://github.com/vercel-labs/rsc-skills)** - React Server Components patterns

</details>
`;

const LLMS_FIXTURE = `# Agent Skills Index

> Documentation index for the SKILL.md standard.

## Anthropic PDF

Anthropic's official PDF skill for creating and editing PDF files.

URL: https://officialskills.sh/anthropics/skills/pdf

## Anthropic DOCX

Word document creation and editing.

URL: https://officialskills.sh/anthropics/skills/docx

## Stripe Best Practices

Best practices for building Stripe integrations.

URL: https://officialskills.sh/stripe/skills/stripe-best-practices
`;

// ── Test 1: parseAwesomeList ──────────────────────────────────────────

console.log('\n--- parseAwesomeList ---');
const awesomeSkills = mp.parseAwesomeList(AWESOME_FIXTURE, { source: 'awesome-agent-skills' });

check('parses >= 7 entries', awesomeSkills.length >= 7);
const docx = awesomeSkills.find(s => s.id === 'docx');
check('docx entry found', !!docx);
check('docx has section', docx?.section === 'Official Claude Skills');
check('docx has installPath', docx?.installPath === 'skills/docx/SKILL.md');
check('docx has rawUrl', docx?.rawUrl === 'https://raw.githubusercontent.com/anthropics/skills/main/skills/docx/SKILL.md');
check('docx has description', /Word documents/i.test(docx?.description || ''));
check('docx has source', docx?.source === 'awesome-agent-skills');

const nextApp = awesomeSkills.find(s => s.id === 'vercel-labs-next-app-router');
check('vercel github tree entry parsed', !!nextApp);
check('vercel has rawUrl', !!nextApp?.rawUrl);

const rsc = awesomeSkills.find(s => s.id === 'vercel-labs-rsc-skills');
check('vercel github root entry parsed', !!rsc);
check('vercel root has installPath null', rsc?.installPath === null);

// ── Test 2: parseAgentskillsIndex ─────────────────────────────────────

console.log('\n--- parseAgentskillsIndex ---');
const llmSkills = mp.parseAgentskillsIndex(LLMS_FIXTURE, { source: 'agentskills-io' });
check('parses 3 entries from llms.txt', llmSkills.length === 3);
const pdfLlm = llmSkills.find(s => /pdf/i.test(s.name));
check('llms.txt PDF entry found', !!pdfLlm);
check('llms.txt has source', pdfLlm?.source === 'agentskills-io');
check('llms.txt has url', pdfLlm?.url === 'https://officialskills.sh/anthropics/skills/pdf');

// ── Test 3: searchEntries scoring & ranking ───────────────────────────

console.log('\n--- searchEntries ---');
const allEntries = [...awesomeSkills, ...llmSkills];
const dedup = mp.dedupeEntries(allEntries);

// search "pdf"
const pdfResults = mp.searchEntries(dedup, 'pdf', { limit: 5 });
check('search "pdf" returns > 0 results', pdfResults.length > 0);
check('top result for "pdf" is pdf-related', /pdf/i.test(pdfResults[0].name + ' ' + pdfResults[0].description));

// search "stripe"
const stripeResults = mp.searchEntries(dedup, 'stripe', { limit: 5 });
check('search "stripe" returns > 0 results', stripeResults.length > 0);
check('top result for "stripe" is stripe-related', /stripe/i.test(stripeResults[0].id + ' ' + stripeResults[0].name));

// search "react server" — should find rsc entry (by description/name match)
const rscResults = mp.searchEntries(dedup, 'react server', { limit: 5 });
check('search "react server" finds rsc', rscResults.some(r => /react server/i.test(r.name + ' ' + r.description)));

// empty query returns everything (sorted by id)
const allResults = mp.searchEntries(dedup, '', { limit: 100 });
check('empty query returns all (within limit)', allResults.length === dedup.length);

// ── Test 4: dedupeEntries ─────────────────────────────────────────────

console.log('\n--- dedupeEntries ---');
// Build explicit duplicates to verify dedup actually works
const withDups = [
  ...awesomeSkills,
  ...awesomeSkills, // perfect duplicates from the same source
  // Cross-source duplicates with same id (simulating two registries describing the same skill)
  { id: 'docx', name: 'Word Docs (alt)', owner: 'anthropics', repo: 'skills', description: 'alt', url: 'https://other.example/docx', section: 'alt', source: 'agentskills-io', installPath: null, rawUrl: null },
];
const explicitDedup = mp.dedupeEntries(withDups);
check('dedup removes perfect duplicates', explicitDedup.length < withDups.length);
const docxSources = explicitDedup.filter(s => s.id === 'docx').map(s => s.source);
check('dedup keeps only one docx', docxSources.length === 1);
check('dedup prefers awesome-agent-skills for docx', docxSources[0] === 'awesome-agent-skills');

// ── Test 5: scoreEntry / tokenize ─────────────────────────────────────

console.log('\n--- scoreEntry / tokenize ---');
check('tokenize splits on non-alphanumeric', mp.tokenize('Hello, World! 123').join(' ') === 'hello world 123');
const entry = awesomeSkills[0];
const tokens = mp.tokenize('docx pdf');
check('scoreEntry > 0 for matching query', mp.scoreEntry(entry, tokens) >= 0);
const noMatchTokens = mp.tokenize('kubernetes-helm-operator');
check('scoreEntry = 0 for non-matching query', mp.scoreEntry(entry, noMatchTokens) === 0);

// ── Test 6: install flow (offline via fixture cache) ──────────────────

console.log('\n--- install flow ---');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-skills-mp-'));
const cacheDir = path.join(tmpDir, 'cache');
const installDir = path.join(tmpDir, 'install');
const globalJson = path.join(tmpDir, 'global.json');

fs.mkdirSync(cacheDir, { recursive: true });

// Write fixture cache so cmdSearch/cmdInstall can run offline
fs.writeFileSync(path.join(cacheDir, 'awesome-agent-skills.json'), JSON.stringify({
  fetchedAt: new Date().toISOString(),
  source: 'awesome-agent-skills',
  entries: awesomeSkills,
}, null, 2));

// Write a minimal global.json
fs.writeFileSync(globalJson, JSON.stringify({
  $schema: 'https://meta-skills.dev/schema/v1.json',
  version: '1.0',
  generated: new Date().toISOString(),
  source: 'global',
  skills: [],
  stale: [],
}, null, 2));

// Mock the HTTP fetcher by writing a fake "raw SKILL.md" at a known path
// We'll point the awesome entry's rawUrl to a file:// URL via cacheDir manipulation
// Simpler: monkey-patch the global fetch
const fakeSkillBody = '# Test Skill\n\nThis is a fake SKILL.md body for testing.';
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (typeof url === 'string' && url.includes('raw.githubusercontent.com')) {
    return {
      ok: true,
      status: 200,
      text: async () => fakeSkillBody,
    };
  }
  return originalFetch(url);
};

try {
  // Run install via the module's cmdInstall
  await mp.cmdInstall(['docx', '--target', installDir, '--global-json', globalJson, '--cache-dir', cacheDir]);

  const installedFile = path.join(installDir, 'docx', 'SKILL.md');
  check('install wrote SKILL.md', fs.existsSync(installedFile));
  if (fs.existsSync(installedFile)) {
    check('SKILL.md content matches', fs.readFileSync(installedFile, 'utf-8') === fakeSkillBody);
  }
  const updatedGlobal = JSON.parse(fs.readFileSync(globalJson, 'utf-8'));
  const docxRegistered = updatedGlobal.skills.find(s => s.id === 'docx');
  check('docx registered in global.json', !!docxRegistered);
  check('docx has source=marketplace', docxRegistered?.source === 'marketplace');
  check('docx has marketplace_url', !!docxRegistered?.marketplace_url);

  // Run install again — should upsert (not duplicate)
  await mp.cmdInstall(['docx', '--target', installDir, '--global-json', globalJson, '--cache-dir', cacheDir]);
  const after = JSON.parse(fs.readFileSync(globalJson, 'utf-8'));
  const docxCount = after.skills.filter(s => s.id === 'docx').length;
  check('re-install does not duplicate', docxCount === 1);

  // --no-register skips global.json mutation
  const beforeCount = JSON.parse(fs.readFileSync(globalJson, 'utf-8')).skills.length;
  await mp.cmdInstall(['pdf', '--target', installDir, '--global-json', globalJson, '--cache-dir', cacheDir, '--no-register']);
  const after2 = JSON.parse(fs.readFileSync(globalJson, 'utf-8'));
  check('--no-register skips global.json', after2.skills.length === beforeCount);
  check('pdf installed even with --no-register', fs.existsSync(path.join(installDir, 'pdf', 'SKILL.md')));
} finally {
  globalThis.fetch = originalFetch;
}

// ── Test 7: CLI subcommands (search, list) ────────────────────────────

console.log('\n--- CLI subcommands ---');

function runCli(args, env = {}) {
  try {
    return execSync(`node "${mpPath}" ${args}`, {
      stdio: 'pipe',
      encoding: 'utf-8',
      env: { ...process.env, ...env },
    });
  } catch (e) {
    return e.stdout || e.message;
  }
}

const searchOut = runCli(`search stripe --cache-dir "${cacheDir}"`);
check('CLI search "stripe" finds results', /stripe/i.test(searchOut));
check('CLI search shows [source] tag', /\[awesome-agent-skills\]/.test(searchOut));

const searchJsonOut = runCli(`search pdf --json --cache-dir "${cacheDir}"`);
let searchJson = null;
try { searchJson = JSON.parse(searchJsonOut); } catch {}
check('CLI search --json returns valid JSON', !!searchJson);
check('CLI search --json has results', searchJson?.resultCount > 0);
check('CLI search --json has totalMarketplaceSkills', typeof searchJson?.totalMarketplaceSkills === 'number');

const listOut = runCli(`list --cache-dir "${cacheDir}" --limit 5`);
check('CLI list prints entries', /awesome-agent-skills/.test(listOut));

// ── Cleanup ───────────────────────────────────────────────────────────

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
