#!/usr/bin/env node

/**
 * Smoke test for sampling.mjs (issue #42)
 *
 * Tests:
 *   - exported constants and MIN_EVIDENCE values
 *   - dedupeByContent: stability, first-occurrence-wins, hash correctness
 *   - stratify: per-class caps + recency order
 *   - enforceCaps: count cap, truncation marker, truncated flag, no mutation
 *   - selectEvidence: combined pipeline stats
 *   - validateEvidenceCount: known kinds, unknown kind → generic
 */

import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as s from './sampling.mjs';

let passed = 0;
let failed = 0;

function check(label, condition) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else           { console.log(`  ✗ ${label}`); failed++; }
}

// ── Test 1: constants ──────────────────────────────────────────

console.log('\n--- constants ---');
check('MAX_TRACES_PER_CYCLE is 8', s.MAX_TRACES_PER_CYCLE === 8);
check('MAX_FAIL_TRACES is 5', s.MAX_FAIL_TRACES === 5);
check('MAX_PASS_TRACES is 3', s.MAX_PASS_TRACES === 3);
check('MAX_TRACE_CHARS is 15000', s.MAX_TRACE_CHARS === 15000);
check('MIN_EVIDENCE values match issue #42',
  s.MIN_EVIDENCE.antiPattern === 2 && s.MIN_EVIDENCE.whenTighten === 2 &&
  s.MIN_EVIDENCE.split === 5 && s.MIN_EVIDENCE.generic === 2);

// ── Test 2: dedupeByContent ────────────────────────────────────

console.log('\n--- dedupeByContent ---');
const dupInput = [
  { id: 'a', outcome: 'failure', timestamp: '2025-01-01T00:00:00Z' },
  { id: 'b', outcome: 'failure', timestamp: '2025-01-02T00:00:00Z' },
  { id: 'a', outcome: 'failure', timestamp: '2025-01-01T00:00:00Z' }, // dup of first
  { id: 'c', outcome: 'pass',    timestamp: '2025-01-03T00:00:00Z' },
  { id: 'b', outcome: 'failure', timestamp: '2025-01-02T00:00:00Z' }, // dup
];
const dedup = s.dedupeByContent(dupInput);
check('dedupe drops 2 duplicates', dedup.removed === 2);
check('dedupe keeps 3 items', dedup.items.length === 3);
check('dedupe is stable (first occurrence wins)', dedup.items[0].id === 'a' && dedup.items[1].id === 'b');
check('dedupe does not mutate input', dupInput.length === 5);
check('keyFn dedupe uses the given key', s.dedupeByContent(dupInput, i => i.id).removed === 2);
const expectedHash = crypto.createHash('sha256').update(JSON.stringify(dupInput[0])).digest('hex').slice(0, 12);
check('hash is sha256 truncated to 12 hex chars', s.contentHash(JSON.stringify(dupInput[0])) === expectedHash);
check('hash is deterministic', s.contentHash('trace-x') === s.contentHash('trace-x'));

// ── Test 3: stratify ───────────────────────────────────────────

console.log('\n--- stratify ---');
const strataInput = [];
for (let i = 0; i < 8; i++) {
  strataInput.push({ id: `f${i}`, outcome: 'failure', timestamp: `2025-01-0${i + 1}T00:00:00Z` });
}
for (let i = 0; i < 4; i++) {
  strataInput.push({ id: `p${i}`, outcome: 'pass', timestamp: `2025-02-0${i + 1}T00:00:00Z` });
}
const strata = s.stratify(strataInput);
check('stratify caps failing at MAX_FAIL_TRACES', strata.failing.length === 5);
check('stratify caps passing at MAX_PASS_TRACES', strata.passing.length === 3);
check('stratify reports 4 dropped', strata.dropped === 4);
check('stratify orders by recency (newest failure first)', strata.failing[0].id === 'f7');
check('stratify orders passing by recency too', strata.passing[0].id === 'p3');
check('stratify honors explicit caps', s.stratify(strataInput, { maxFail: 2, maxPass: 1 }).failing.length === 2);
check('stratify classifies outcome=fail as failing',
  s.stratify([{ outcome: 'fail' }, { outcome: 'success' }]).failing.length === 1);

// ── Test 4: enforceCaps ────────────────────────────────────────

console.log('\n--- enforceCaps ---');
const longText = 'x'.repeat(s.MAX_TRACE_CHARS + 500);
const capInput = [
  { id: 'big', outcome: 'failure', text: longText },
  'y'.repeat(s.MAX_TRACE_CHARS + 10),
  ...Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, outcome: 'failure', text: 'short' })),
];
const capped = s.enforceCaps(capInput);
check('enforceCaps caps count at MAX_TRACES_PER_CYCLE', capped.items.length === 8);
check('enforceCaps counts truncated items', capped.truncatedCount === 2);
check('truncated object carries the marker', capped.items[0].text.endsWith(s.TRUNCATION_MARKER));
check('truncated object sets truncated flag', capped.items[0].truncated === true);
check('truncated object respects maxChars',
  capped.items[0].text.length === s.MAX_TRACE_CHARS + s.TRUNCATION_MARKER.length);
check('string item is truncated with marker', capped.items[1].endsWith(s.TRUNCATION_MARKER));
check('enforceCaps does not mutate inputs', capInput[0].text.length === longText.length && capInput[0].truncated === undefined);

// ── Test 5: selectEvidence ─────────────────────────────────────

console.log('\n--- selectEvidence ---');
const pipelineInput = [
  ...strataInput,
  { id: 'f0', outcome: 'failure', timestamp: '2025-01-01T00:00:00Z' }, // dup
  { id: 'huge', outcome: 'failure', timestamp: '2025-03-01T00:00:00Z', text: longText },
];
const sel = s.selectEvidence(pipelineInput);
check('selectEvidence stats shape',
  typeof sel.stats === 'object' && 'input' in sel.stats && 'deduped' in sel.stats &&
  'failing' in sel.stats && 'passing' in sel.stats && 'truncated' in sel.stats);
check('selectEvidence reports input count', sel.stats.input === pipelineInput.length);
check('selectEvidence dedupes before stratifying', sel.stats.deduped === pipelineInput.length - 1);
check('selectEvidence respects the per-cycle cap', sel.selected.length <= s.MAX_TRACES_PER_CYCLE);
check('selectEvidence counts truncated items', sel.stats.truncated === 1);
check('selectEvidence newest failure wins', sel.selected[0].id === 'huge');

// ── Test 6: validateEvidenceCount ──────────────────────────────

console.log('\n--- validateEvidenceCount ---');
const splitOk = s.validateEvidenceCount(5, 'split');
check('split passes at its minimum', splitOk.ok === true && splitOk.required === 5);
const splitFail = s.validateEvidenceCount(4, 'split');
check('split fails below its minimum', splitFail.ok === false && splitFail.actual === 4);
check('failure message names the kind and minimum', /split/.test(splitFail.message) && /5/.test(splitFail.message));
check('antiPattern gate works', s.validateEvidenceCount(2, 'antiPattern').ok === true && s.validateEvidenceCount(1, 'antiPattern').ok === false);
check('whenTighten gate works', s.validateEvidenceCount(3, 'whenTighten').ok === true);
const unknown = s.validateEvidenceCount(1, 'mystery-kind');
check('unknown kind falls back to generic minimum', unknown.required === s.MIN_EVIDENCE.generic && unknown.ok === false);

// ── Summary ────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
