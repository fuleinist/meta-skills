#!/usr/bin/env node

/**
 * Smoke test for usage-tracker.mjs
 *
 * Tests record → aggregate → rotate pipeline end-to-end.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const trackerPath = path.join(__dirname, 'usage-tracker.mjs');

// ── Setup temp dirs ───────────────────────────────────────────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-skills-usage-'));
const logDir = path.join(tmpDir, 'logs');
fs.mkdirSync(logDir, { recursive: true });

// Create a minimal global.json to work with
const globalJson = path.join(tmpDir, 'global.json');
fs.writeFileSync(globalJson, JSON.stringify({
  $schema: 'https://meta-skills.dev/schema/v1.json',
  version: '1.0',
  generated: '2026-06-24T00:00:00.000Z',
  source: 'global',
  skills: [
    { id: 'git-commits', when: 'writing commits', why: 'conventional commits', path: '/tmp/skills/git/SKILL.md', priority: 'medium', usage_count: 0, last_used: null },
    { id: 'code-review', when: 'reviewing PRs', why: 'structured review', path: '/tmp/skills/review/SKILL.md', priority: 'medium', usage_count: 0, last_used: null },
    { id: 'deploy-app', when: 'deploying', why: 'composite deploy', path: '/tmp/skills/deploy/SKILL.md', priority: 'medium', usage_count: 0, last_used: null, requires: ['git-commits'] },
  ],
  stale: [],
}, null, 2));

let passed = 0;
let failed = 0;

function check(label, condition) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}`);
    failed++;
  }
}

function run(args) {
  try {
    return execSync(`node "${trackerPath}" ${args}`, {
      cwd: tmpDir,
      stdio: 'pipe',
      encoding: 'utf-8',
      env: { ...process.env, HOME: os.homedir() },
    });
  } catch (e) {
    return e.stdout || e.message;
  }
}

// ── Test 1: Record ────────────────────────────────────────────────────
console.log('\n--- Record ---');
run(`record git-commits --log-dir "${logDir}" --global-json "${globalJson}"`);
run(`record code-review --log-dir "${logDir}" --global-json "${globalJson}"`);
run(`record git-commits --log-dir "${logDir}" --global-json "${globalJson}" --outcome failure`);

const logFiles = fs.readdirSync(logDir).filter(f => f.endsWith('.jsonl'));
check('log file created', logFiles.length === 1);

const logContent = fs.readFileSync(path.join(logDir, logFiles[0]), 'utf-8');
const lines = logContent.trim().split('\n');
check('3 events recorded', lines.length === 3);

const events = lines.map(l => JSON.parse(l));
check('first event is git-commits', events[0].skill === 'git-commits');
check('second event is code-review', events[1].skill === 'code-review');
check('third event has outcome failure', events[2].outcome === 'failure');

// ── Test 1b: Dependency auto-load (v0.1.3) ───────────────────────
console.log('\n--- Dependency auto-load (v0.1.3) ---');
const logDir2 = path.join(tmpDir, 'logs-deps');
fs.mkdirSync(logDir2, { recursive: true });
run(`record deploy-app --log-dir "${logDir2}" --global-json "${globalJson}"`);

const depLogFiles = fs.readdirSync(logDir2).filter(f => f.endsWith('.jsonl'));
const depLines = fs.readFileSync(path.join(logDir2, depLogFiles[0]), 'utf-8').trim().split('\n');
const depEvents = depLines.map(l => JSON.parse(l));
check('primary + 1 dependency event', depEvents.length === 2);
check('dependency event targets git-commits', depEvents[1].skill === 'git-commits');
check('dependency event marked source=dependency', depEvents[1].source === 'dependency');
check('dependency event carries parent', depEvents[1].parent === 'deploy-app');

const logDir3 = path.join(tmpDir, 'logs-nodeps');
fs.mkdirSync(logDir3, { recursive: true });
run(`record deploy-app --log-dir "${logDir3}" --global-json "${globalJson}" --no-deps`);
const noDepsLines = fs.readdirSync(logDir3)
  .filter(f => f.endsWith('.jsonl'))
  .flatMap(f => fs.readFileSync(path.join(logDir3, f), 'utf-8').trim().split('\n'));
check('--no-deps writes only primary event', noDepsLines.length === 1);

// ── Test 1c: Empirical token telemetry (v0.1.4) ─────────────────
console.log('\n--- Empirical token telemetry (v0.1.4) ---');
const logDir4 = path.join(tmpDir, 'logs-tokens');
fs.mkdirSync(logDir4, { recursive: true });
const globalJson4 = path.join(tmpDir, 'global4.json');
fs.writeFileSync(globalJson4, JSON.stringify({
  $schema: 'https://meta-skills.dev/schema/v1.json',
  version: '1.0',
  generated: '2026-06-24T00:00:00.000Z',
  source: 'global',
  skills: [
    { id: 'git-commits', when: 'writing commits', why: 'conventional commits', path: '/tmp/skills/git/SKILL.md', priority: 'medium', usage_count: 0, last_used: null },
    { id: 'code-review', when: 'reviewing PRs', why: 'structured review', path: '/tmp/skills/review/SKILL.md', priority: 'medium', usage_count: 0, last_used: null },
  ],
  stale: [],
}, null, 2));

run(`record git-commits --tokens 800 --log-dir "${logDir4}" --global-json "${globalJson4}"`);
run(`record git-commits --tokens 1000 --log-dir "${logDir4}" --global-json "${globalJson4}"`);
run(`record git-commits --tokens 900 --log-dir "${logDir4}" --global-json "${globalJson4}"`);
run(`record code-review --log-dir "${logDir4}" --global-json "${globalJson4}"`);

const tokLines = fs.readdirSync(logDir4)
  .filter(f => f.endsWith('.jsonl'))
  .flatMap(f => fs.readFileSync(path.join(logDir4, f), 'utf-8').trim().split('\n'));
const tokEvents = tokLines.map(l => JSON.parse(l));
check('token events recorded (4)', tokEvents.length === 4);
check('token value persisted on event', tokEvents[0].tokens === 800);
check('event without --tokens omits field', !('tokens' in tokEvents[3]));

run(`aggregate --global-json "${globalJson4}" --log-dir "${logDir4}" --out "${globalJson4}"`);
const updated4 = JSON.parse(fs.readFileSync(globalJson4, 'utf-8'));
const git4 = updated4.skills.find(s => s.id === 'git-commits');
const review4 = updated4.skills.find(s => s.id === 'code-review');
check('empirical_tokens = avg(800,1000,900) = 900', git4.empirical_tokens === 900);
check('skill without token data has no empirical_tokens', !('empirical_tokens' in review4));

// ── Test 2: Aggregate ─────────────────────────────────────────────────
console.log('\n--- Aggregate ---');
run(`aggregate --global-json "${globalJson}" --log-dir "${logDir}" --out "${globalJson}"`);

const updated = JSON.parse(fs.readFileSync(globalJson, 'utf-8'));
const gitSkill = updated.skills.find(s => s.id === 'git-commits');
const reviewSkill = updated.skills.find(s => s.id === 'code-review');

check('git-commits usage_count = 2', gitSkill.usage_count === 2);
check('code-review usage_count = 1', reviewSkill.usage_count === 1);
check('git-commits has last_used', typeof gitSkill.last_used === 'string');
check('code-review has last_used', typeof reviewSkill.last_used === 'string');

// ── Test 3: Rotate ────────────────────────────────────────────────────
console.log('\n--- Rotate ---');
run(`rotate --log-dir "${logDir}" --keep-days 90`);

const afterRotate = fs.readdirSync(logDir).filter(f => f.endsWith('.jsonl'));
check('today log still exists', afterRotate.length === 1);

// ── Cleanup ───────────────────────────────────────────────────────────
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
