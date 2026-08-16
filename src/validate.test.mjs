#!/usr/bin/env node

/**
 * Smoke test for validate.mjs (v0.6)
 *
 * Tests schema validation against valid and invalid meta-skills JSON files.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const validatePath = path.join(__dirname, 'validate.mjs');
const schemaPath = path.resolve(__dirname, '..', 'schema', 'v1.json');

// ── Setup temp ────────────────────────────────────────────────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-skills-validate-'));

function writeJson(name, data) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
  return p;
}

function run(filePath) {
  try {
    const out = execSync(`node "${validatePath}" --schema "${schemaPath}" "${filePath}"`, {
      stdio: 'pipe',
      encoding: 'utf-8',
    });
    return { valid: true, output: out.trim() };
  } catch (e) {
    return { valid: false, output: (e.stdout || '').trim() };
  }
}

let passed = 0;
let failed = 0;

function check(label, condition) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label}`); failed++; }
}

// ── Test 1: Valid global.json ─────────────────────────────────────────
console.log('--- Valid global.json ---');
const validGlobal = writeJson('valid-global.json', {
  $schema: 'https://meta-skills.dev/schema/v1.json',
  version: '1.0',
  generated: '2026-06-24T08:48:00+10:00',
  source: 'global',
  skills: [
    { id: 'git-commits', when: 'writing commits', why: 'conventional commits', path: '/tmp/SKILL.md', priority: 'high', usage_count: 42, last_used: '2026-06-23T14:30:00+10:00' },
  ],
  stale: [],
});
const r1 = run(validGlobal);
check('valid global.json passes', r1.valid);
check('output says valid', r1.output.includes('valid'));

// ── Test 2: Valid project.json ────────────────────────────────────────
console.log('\n--- Valid project.json ---');
const validProject = writeJson('valid-project.json', {
  $schema: 'https://meta-skills.dev/schema/v1.json',
  version: '1.0',
  generated: '2026-06-24T08:48:00+10:00',
  source: 'project',
  project_context: {
    name: 'test',
    tech_stack: ['node.js'],
    key_files: ['README.md'],
    patterns: ['clean architecture'],
  },
  skills: [],
});
const r2 = run(validProject);
check('valid project.json passes', r2.valid);

// ── Test 3: Invalid — missing required ────────────────────────────────
console.log('\n--- Invalid: missing required ---');
const missingReq = writeJson('missing-req.json', {
  version: '1.0',
  generated: '2026-06-24T08:48:00+10:00',
  // missing source, skills
});
const r3 = run(missingReq);
check('missing required fails', !r3.valid);
check('reports missing source', r3.output.includes('source'));
check('reports missing skills', r3.output.includes('skills'));

// ── Test 4: Invalid — wrong type ──────────────────────────────────────
console.log('\n--- Invalid: wrong type ---');
const wrongType = writeJson('wrong-type.json', {
  $schema: 'https://meta-skills.dev/schema/v1.json',
  version: '1.0',
  generated: '2026-06-24T08:48:00+10:00',
  source: 'global',
  skills: 'not-an-array',
});
const r4 = run(wrongType);
check('wrong type fails', !r4.valid);

// ── Test 5: Invalid — bad enum ────────────────────────────────────────
console.log('\n--- Invalid: bad enum ---');
const badEnum = writeJson('bad-enum.json', {
  $schema: 'https://meta-skills.dev/schema/v1.json',
  version: '1.0',
  generated: '2026-06-24T08:48:00+10:00',
  source: 'invalid-source',
  skills: [],
});
const r5 = run(badEnum);
check('bad enum fails', !r5.valid);

// ── Test 6: Invalid — bad priority ────────────────────────────────────
console.log('\n--- Invalid: bad priority ---');
const badPriority = writeJson('bad-priority.json', {
  $schema: 'https://meta-skills.dev/schema/v1.json',
  version: '1.0',
  generated: '2026-06-24T08:48:00+10:00',
  source: 'global',
  skills: [{ id: 'test', when: 'test', why: 'test', path: '/tmp/SKILL.md', priority: 'super-high' }],
  stale: [],
});
const r6 = run(badPriority);
check('bad priority fails', !r6.valid);

// ── Test 7: Invalid — bad date ────────────────────────────────────────
console.log('\n--- Invalid: bad date ---');
const badDate = writeJson('bad-date.json', {
  $schema: 'https://meta-skills.dev/schema/v1.json',
  version: '1.0',
  generated: 'not-a-date',
  source: 'global',
  skills: [],
  stale: [],
});
const r7 = run(badDate);
check('bad date fails', !r7.valid);

// ── Test 8: Invalid — bad version pattern ───────────────────────────
console.log('\n--- Invalid: bad version pattern ---');
const badVersion = writeJson('bad-version.json', {
  $schema: 'https://meta-skills.dev/schema/v1.json',
  version: '1.0',
  generated: '2026-06-24T08:48:00+10:00',
  source: 'global',
  skills: [{ id: 'test', when: 'test', why: 'test', path: '/tmp/SKILL.md', priority: 'high', version: 'not-semver' }],
  stale: [],
});
const r8 = run(badVersion);
check('bad version pattern fails', !r8.valid);
check('reports bad version', r8.output.includes('version'));

// ── Test 9: Valid — skill with version and engines ────────────────────
console.log('\n--- Valid: skill with version + engines ---');
const withVersion = writeJson('with-version.json', {
  $schema: 'https://meta-skills.dev/schema/v1.json',
  version: '1.0',
  generated: '2026-06-24T08:48:00+10:00',
  source: 'global',
  skills: [{ id: 'test', when: 'test', why: 'test', path: '/tmp/SKILL.md', priority: 'high', version: '1.2.3', engines: { node: '>=18.0.0' } }],
  stale: [],
});
const r9 = run(withVersion);
check('valid version+engines passes', r9.valid);

// ── Engine compatibility checks (v0.1.1) ─────────────────────────────
const validator = await import(pathToFileURL(path.join(__dirname, 'validate.mjs')).href);

// parseSemverRange
check('parseSemverRange >=18.0.0 parses correctly', JSON.stringify(validator.parseSemverRange('>=18.0.0')) === JSON.stringify({ op: '>=', major: 18, minor: 0, patch: 0 }));
check('parseSemverRange ^18.0.0 parses correctly', JSON.stringify(validator.parseSemverRange('^18.0.0')) === JSON.stringify({ op: '^', major: 18, minor: 0, patch: 0 }));
check('parseSemverRange ~18.2.0 parses correctly', JSON.stringify(validator.parseSemverRange('~18.2.0')) === JSON.stringify({ op: '~', major: 18, minor: 2, patch: 0 }));
check('parseSemverRange * returns any', validator.parseSemverRange('*').op === 'any');

// checkEngines
const idxWithOldNode = { skills: [{ id: 'old-skill', engines: { node: '>=99.0.0' } }] };
const warnings = validator.checkEngines(idxWithOldNode);
check('checkEngines warns for incompatible node', warnings.length > 0);
check('checkEngines mentions skill id', warnings.some(w => w.includes('old-skill')));

const idxWithGoodNode = { skills: [{ id: 'good-skill', engines: { node: '>=18.0.0' } }] };
const goodWarnings = validator.checkEngines(idxWithGoodNode);
check('checkEngines no warning for compatible node', goodWarnings.length === 0);

const idxNoEngines = { skills: [{ id: 'no-engines', priority: 'high' }] };
const noWarnings = validator.checkEngines(idxNoEngines);
check('checkEngines no warnings when no engines', noWarnings.length === 0);

// ── Cleanup ───────────────────────────────────────────────────────────
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
