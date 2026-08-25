#!/usr/bin/env node

/**
 * Smoke test for reputation.mjs (v0.1.8 — offline reputation metrics)
 *
 * No network. Tests:
 *   - computeReputation signals & tiers
 *   - buildReputationIndex dedupe (keeps highest score per id)
 *   - loadBaseline fallback on missing/corrupt file
 *   - annotateWithReputation + filterByReputation
 *   - build/check round-trip via cache dir
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rep = await import(pathToFileURL(path.join(__dirname, 'reputation.mjs')).href);

let passed = 0;
let failed = 0;

function check(label, condition) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else           { console.log(`  ✗ ${label}`); failed++; }
}

const BASELINE = {
  repos: { 'anthropics/skills': { stars: 12400, forks: 1350 } },
  orgs: ['anthropics'],
};

// ── computeReputation ─────────────────────────────────────────────────

const officialEntry = {
  id: 'docx',
  owner: 'anthropics',
  repo: 'skills',
  source: 'awesome-agent-skills',
  url: 'https://officialskills.sh/anthropics/skills/docx',
};
const r1 = rep.computeReputation(officialEntry, BASELINE);
check('official skill gets stars signal', r1.signals.some(s => s.startsWith('stars:12400')));
check('official skill gets curated-list signal', r1.signals.includes('curated-list'));
check('official skill gets official-hosting signal', r1.signals.includes('official-hosting'));
check('official skill gets known-org signal', r1.signals.includes('known-org'));
check('official skill rated trusted tier', r1.tier === 'trusted');
check('score capped at 100', r1.score <= 100);

const anonymousEntry = {
  id: 'some-random',
  owner: 'anon123',
  repo: 'my-skills',
  source: 'agentskills-io',
  url: 'https://anon.example.com/skill',
};
const r2 = rep.computeReputation(anonymousEntry, BASELINE);
check('anonymous skill unrated', r2.tier === 'unrated' && r2.score === 0);
check('anonymous skill has no signals', r2.signals.length === 0);

const treeEntry = {
  id: 'vercel-next',
  owner: 'vercel-labs',
  repo: 'next-skills',
  source: 'awesome-agent-skills',
  url: 'https://github.com/vercel-labs/next-skills/tree/main/skills/x',
};
const r3 = rep.computeReputation(treeEntry, { repos: {}, orgs: [] });
check('github tree URL adds github-tree signal', r3.signals.includes('github-tree'));
check('curated-only entry is unproven tier (score < 30)', r3.tier === 'unproven');

// ── starsScore / forksScore caps ──────────────────────────────────────

check('starsScore(0) = 0', rep.starsScore(0) === 0);
check('starsScore capped at 40', rep.starsScore(1000000000) <= 40);
check('forksScore capped at 15', rep.forksScore(1000000000) <= 15);

// ── buildReputationIndex ──────────────────────────────────────────────

const idx = rep.buildReputationIndex([officialEntry, anonymousEntry], BASELINE);
check('index schema set', idx.schema === rep.INDEX_SCHEMA);
check('index counts both skills', idx.skillCount === 2);
check('index keeps official score', idx.scores.docx.tier === 'trusted');
check('index marks anonymous unrated', idx.scores['some-random'].tier === 'unrated');

// dedupe: same id from two sources keeps higher score
const dupeLow = { ...officialEntry, source: 'agentskills-io', url: 'https://x.example/y' };
const idx2 = rep.buildReputationIndex([dupeLow, officialEntry], BASELINE);
check('dedupe keeps highest score per id', idx2.scores.docx.signals.includes('official-hosting'));

// ── loadBaseline fallback ─────────────────────────────────────────────

const missing = rep.loadBaseline(path.join(os.tmpdir(), 'nope-baseline.json'));
check('missing baseline returns empty', Object.keys(missing.repos).length === 0);

const corrupt = path.join(os.tmpdir(), 'corrupt-baseline.json');
fs.writeFileSync(corrupt, '{not json');
const bad = rep.loadBaseline(corrupt);
check('corrupt baseline returns empty', Object.keys(bad.repos).length === 0);
fs.unlinkSync(corrupt);

// bundled baseline loads
const bundled = rep.loadBaseline();
check('bundled baseline has repos', Object.keys(bundled.repos).length > 0);
check('bundled baseline has orgs', bundled.orgs.length > 0);

// ── annotate + filter ─────────────────────────────────────────────────

const annotated = rep.annotateWithReputation([officialEntry, anonymousEntry], idx);
check('annotate attaches reputation', annotated[0].reputation.tier === 'trusted');
check('annotate gives unrated default', annotated[1].reputation.tier === 'unrated');

const filtered = rep.filterByReputation(annotated, idx, { minScore: 30, includeUnrated: false });
check('filter drops low/unrated below minScore', filtered.length === 1 && filtered[0].id === 'docx');

const withUnrated = rep.filterByReputation(annotated, idx, { minScore: 30, includeUnrated: true });
check('filter keeps unrated when includeUnrated', withUnrated.length === 2);

// ── build/check round-trip ────────────────────────────────────────────

const tmpCache = fs.mkdtempSync(path.join(os.tmpdir(), 'rep-test-'));
const built = rep.cmdReputationBuild([], { cacheDir: tmpCache, loadAllEntries: () => [officialEntry, anonymousEntry] });
check('build writes index file', fs.existsSync(rep.reputationPath(tmpCache)));
check('build returns index with scores', built.scores.docx.score > 0);

const loaded = rep.loadReputationIndex(tmpCache);
check('loadReputationIndex round-trips', loaded.scores.docx.tier === 'trusted');

const checked = rep.cmdReputationCheck(['docx'], { cacheDir: tmpCache });
check('check returns score for known skill', checked && checked.tier === 'trusted');
const unknown = rep.cmdReputationCheck(['nope'], { cacheDir: tmpCache });
check('check returns null for unknown skill', unknown === null);

fs.rmSync(tmpCache, { recursive: true, force: true });

// ── Summary ───────────────────────────────────────────────────────────

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
