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
run(`record git-commits --log-dir "${logDir}"`);
run(`record code-review --log-dir "${logDir}"`);
run(`record git-commits --log-dir "${logDir}" --outcome failure`);

const logFiles = fs.readdirSync(logDir).filter(f => f.endsWith('.jsonl'));
check('log file created', logFiles.length === 1);

const logContent = fs.readFileSync(path.join(logDir, logFiles[0]), 'utf-8');
const lines = logContent.trim().split('\n');
check('3 events recorded', lines.length === 3);

const events = lines.map(l => JSON.parse(l));
check('first event is git-commits', events[0].skill === 'git-commits');
check('second event is code-review', events[1].skill === 'code-review');
check('third event has outcome failure', events[2].outcome === 'failure');

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
