#!/usr/bin/env node

/**
 * Tests for rollback-ledger.mjs (v0.1.2)
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { takeSnapshot, listSnapshots, rollback, pruneSnapshots, defaultHistoryPath } from './rollback-ledger.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-skills-rb-'));

let passed = 0;
let failed = 0;

function check(label, condition) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label}`); failed++; }
}

function cleanup() {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── Helpers ───────────────────────────────────────────────────────────

function writeGlobalJson(content, gjPath) {
  fs.writeFileSync(gjPath, JSON.stringify(content, null, 2) + '\n', 'utf-8');
}

// ── Tests ─────────────────────────────────────────────────────────────

try {
  const gjPath = path.join(tmpDir, 'global.json');
  const historyPath = path.join(tmpDir, 'history.jsonl');

  // Setup: write initial global.json
  const initialIndex = {
    $schema: 'https://meta-skills.dev/schema/v1.json',
    version: '1.0',
    generated: '2026-01-01T00:00:00.000Z',
    source: 'global',
    skills: [{ id: 'test-skill', when: 'test', why: 'test', path: '/tmp/SKILL.md', priority: 'medium' }],
    stale: [],
  };
  writeGlobalJson(initialIndex, gjPath);

  console.log('takeSnapshot:');
  const snap = takeSnapshot({ globalJsonPath: gjPath, historyPath, comment: 'initial' });
  check('snapshot returns hash', !!snap.hash);
  check('snapshot returns ts', !!snap.ts);
  check('history file created', fs.existsSync(historyPath));

  // Mutate global.json
  initialIndex.skills.push({ id: 'new-skill', when: 'new', why: 'new', path: '/tmp/SKILL2.md', priority: 'low' });
  writeGlobalJson(initialIndex, gjPath);

  const snap2 = takeSnapshot({ globalJsonPath: gjPath, historyPath, comment: 'after add' });
  check('second snapshot has different hash', snap.hash !== snap2.hash);

  // Read the actual history path from the snapshot result
  const actualHistoryPath = snap.historyPath || historyPath;
  // Cleanup any leftover history from previous runs
  if (fs.existsSync(actualHistoryPath)) {
    fs.unlinkSync(actualHistoryPath);
  }

  console.log('\nlistSnapshots:');
  const list = listSnapshots({ historyPath: actualHistoryPath, asJson: false });
  check('lists 2 snapshots', list.length === 2);

  console.log('\nrollback:');
  // Rollback 1 step — should restore to the first snapshot (1 skill)
  const result = rollback(1, { globalJsonPath: gjPath, historyPath: actualHistoryPath, dryRun: false });
  check('rollback returns target', !!result.target);
  const restored = JSON.parse(fs.readFileSync(gjPath, 'utf-8'));
  check('restored has 1 skill', restored.skills.length === 1);
  check('restored skill is test-skill', restored.skills[0].id === 'test-skill');

  console.log('\nrollback --dry-run:');
  const dryResult = rollback(1, { globalJsonPath: gjPath, historyPath: actualHistoryPath, dryRun: true });
  check('dry-run returns target', !!dryResult.target);
  check('dry-run does not modify file', JSON.parse(fs.readFileSync(gjPath, 'utf-8')).skills.length === 1);

  console.log('\npruneSnapshots:');
  // Read current state from disk and add more snapshots from there
  const currentState = JSON.parse(fs.readFileSync(gjPath, 'utf-8'));
  for (let i = 0; i < 5; i++) {
    currentState.skills.push({ id: `extra-${i}`, when: 'x', why: 'x', path: '/tmp/x.md', priority: 'low' });
    writeGlobalJson(currentState, gjPath);
    takeSnapshot({ globalJsonPath: gjPath, historyPath, comment: `extra-${i}` });
  }
  const beforePrune = listSnapshots({ historyPath: actualHistoryPath });
  check('have >=7 snapshots before prune', beforePrune.length >= 7);

  pruneSnapshots({ historyPath: actualHistoryPath, keep: 3, olderThanDays: 0 });
  const afterPrune = listSnapshots({ historyPath: actualHistoryPath });
  check('pruned to <=3 snapshots', afterPrune.length <= 3);

  console.log('\nerror cases:');
  check('rollback beyond range throws', (() => {
    try { rollback(999, { globalJsonPath: gjPath, historyPath: actualHistoryPath }); return false; }
    catch { return true; }
  })());

  check('rollback missing history throws', (() => {
    try { rollback(0, { globalJsonPath: gjPath, historyPath: '/nonexistent/history.jsonl' }); return false; }
    catch { return true; }
  })());

  // Cleanup
  cleanup();
} catch (e) {
  console.error('Test error:', e);
  cleanup();
  process.exit(1);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
