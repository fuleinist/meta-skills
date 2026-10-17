#!/usr/bin/env node

/**
 * Tests for success-miner.mjs (issue #39)
 * Run: node src/success-miner.test.mjs
 *
 * Covers:
 *   - loadSuccessEvents: outcome filter, corrupt-line skip, maxEvents cap
 *   - analyzeSuccesses: grouping, min-count, deterministic keywords, timestamps
 *   - clustersToNotes: note shape
 *   - writeNotes / readNotes: append, roundtrip, corrupt skip, missing file
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  DEFAULT_MAX_EVENTS,
  DEFAULT_MIN_COUNT,
  defaultLogDir,
  defaultNotesPath,
  loadSuccessEvents,
  analyzeSuccesses,
  clustersToNotes,
  writeNotes,
  readNotes,
} from './success-miner.mjs';

let passed = 0;
let failed = 0;

function check(label, condition) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else           { console.log(`  ✗ ${label}`); failed++; }
}

// ── Fixture setup ──────────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-skills-sm-'));
const logDir = path.join(tmpDir, 'logs');
const notesPath = path.join(tmpDir, 'evolve', 'reinforce-notes.jsonl');
fs.mkdirSync(logDir, { recursive: true });

function writeLog(date, entries) {
  const content = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(path.join(logDir, `${date}.jsonl`), content, 'utf-8');
}

writeLog('2026-08-26', [
  { skill: 'deploy-app', timestamp: '2026-08-26T10:00:00Z', outcome: 'success', excerpt: 'deploy rollback verified health endpoint' },
  { skill: 'deploy-app', timestamp: '2026-08-26T11:30:00Z', outcome: 'failure', reason: 'ssh timeout' },
  'this line is not json',
  { skill: 'deploy-app', timestamp: '2026-08-26T12:00:00Z', outcome: 'success', excerpt: 'deploy rollback verified health endpoint again' },
  { skill: 'solo-skill', timestamp: '2026-08-26T12:30:00Z', outcome: 'success' },
  { skill: 'no-excerpt-skill', timestamp: '2026-08-26T13:00:00Z', outcome: 'success' },
  { skill: 'no-excerpt-skill', timestamp: '2026-08-26T14:00:00Z', outcome: 'success' },
]);

writeLog('2026-08-25', [
  { skill: 'deploy-app', timestamp: '2026-08-25T09:00:00Z', outcome: 'success', excerpt: 'deploy rollback verified health endpoint first' },
  'corrupt}',
  { skill: 'deploy-app', timestamp: '2026-08-25T09:30:00Z', outcome: 'success' },
]);

// ── Test 1: loadSuccessEvents ──────────────────────────────────

console.log('\n--- loadSuccessEvents ---');
const events = loadSuccessEvents({ logDir });
check('only success events kept', events.every(e => e.outcome === 'success'));
check('success events counted (7)', events.length === 7);
check('corrupt lines skipped', events.every(e => e.skill));
check('missing log dir returns []', loadSuccessEvents({ logDir: path.join(tmpDir, 'nope') }).length === 0);
const bomDir = path.join(tmpDir, 'bom-logs');
fs.mkdirSync(bomDir, { recursive: true });
fs.writeFileSync(path.join(bomDir, '2026-08-24.jsonl'),
  '\uFEFF' + JSON.stringify({ skill: 'deploy-app', timestamp: '2026-08-24T09:00:00Z', outcome: 'success' }) + '\n', 'utf-8');
check('BOM-prefixed log file still parses', loadSuccessEvents({ logDir: bomDir }).length === 1);
check('cap respected at maxEvents', loadSuccessEvents({ logDir, maxEvents: 3 }).length === 3);
check('default cap is DEFAULT_MAX_EVENTS', DEFAULT_MAX_EVENTS === 500 && loadSuccessEvents({ logDir }).length <= DEFAULT_MAX_EVENTS);
check('default log dir is ~/.meta-skills/logs', defaultLogDir() === path.join(os.homedir(), '.meta-skills', 'logs'));
check('default notes path is evolve/reinforce-notes.jsonl',
  defaultNotesPath() === path.join(os.homedir(), '.meta-skills', 'evolve', 'reinforce-notes.jsonl'));

// ── Test 2: analyzeSuccesses ───────────────────────────────────

console.log('\n--- analyzeSuccesses ---');
const clusters = analyzeSuccesses(events);
check('two clusters (deploy-app, no-excerpt-skill)', clusters.length === 2);
check('default min-count is 2', DEFAULT_MIN_COUNT === 2);
check('solo skill below min-count is dropped', !clusters.some(c => c.skill === 'solo-skill'));
check('deploy-app cluster has 4 successes', clusters[0].skill === 'deploy-app' && clusters[0].count === 4);
check('firstAt/lastAt from timestamps',
  clusters[0].firstAt === '2026-08-25T09:00:00Z' && clusters[0].lastAt === '2026-08-26T12:00:00Z');
check('keywords are deterministic and <= 6', clusters[0].keywords.length <= 6 &&
  JSON.stringify(clusters[0].keywords) === JSON.stringify(analyzeSuccesses(events)[0].keywords));
check('keywords reflect the excerpts', clusters[0].keywords.includes('deploy') && clusters[0].keywords.includes('rollback'));
check('excerpts capped at 3', clusters[0].excerpts.length === 3);
check('cluster without excerpt data has empty excerpts',
  clusters.find(c => c.skill === 'no-excerpt-skill').excerpts.length === 0);
check('min-count filter raises the bar', analyzeSuccesses(events, { minCount: 4 }).length === 1);

// ── Test 3: clustersToNotes ────────────────────────────────────

console.log('\n--- clustersToNotes ---');
const notes = clustersToNotes(clusters, { now: new Date('2026-08-27T00:00:00Z') });
check('one note per cluster', notes.length === 2);
const note = notes[0];
check('note shape', typeof note.skill === 'string' && note.kind === 'reinforce' &&
  typeof note.generated === 'string' && typeof note.reason === 'string' && Array.isArray(note.suggestedGuidance));
check('reason reports the count', note.reason === 'Consistent successes (4) observed — reinforce this approach');
check('generated is ISO', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(note.generated));
check('guidance is 1-2 concrete bullets', note.suggestedGuidance.length >= 1 && note.suggestedGuidance.length <= 2);

// ── Test 4: writeNotes / readNotes ─────────────────────────────

console.log('\n--- writeNotes / readNotes ---');
const written = writeNotes(notes, notesPath);
check('writeNotes returns count', written === 2);
check('notes file created', fs.existsSync(notesPath));
check('readNotes roundtrip', readNotes(notesPath).length === 2);
check('roundtrip preserves fields', readNotes(notesPath)[0].skill === note.skill &&
  readNotes(notesPath)[0].kind === 'reinforce');
writeNotes([notes[1]], notesPath);
check('write appends (does not overwrite)', readNotes(notesPath).length === 3);
fs.appendFileSync(notesPath, 'not-json-line\n', 'utf-8');
check('readNotes skips corrupt lines', readNotes(notesPath).length === 3);
check('readNotes on missing file returns []', readNotes(path.join(tmpDir, 'missing.jsonl')).length === 0);

// ── Cleanup + summary ──────────────────────────────────────────

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\nsuccess-miner: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
