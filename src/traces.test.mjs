#!/usr/bin/env node

/**
 * Tests for traces.mjs (issue #37 — raw evidence capture)
 *
 * Temp dirs only; nothing touches ~/.meta-skills/traces.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  storeTrace, readTrace, listTraces, traceStats, sampleTraces,
  MAX_TRACES_PER_CYCLE, MAX_FAIL_TRACES, MAX_PASS_TRACES, MAX_TRACE_CHARS,
} from './traces.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-skills-traces-'));

let passed = 0;
let failed = 0;

function check(label, condition) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label}`); failed++; }
}

// ── Roundtrip + default id ───────────────────────────────────────

console.log('storeTrace → readTrace:');
const content = 'reasoning excerpt\n\ntool_call: read src/usage-tracker.mjs\noutcome: failure';
const stored = storeTrace(content, { dir: tmpDir });
check('store returns id', typeof stored.id === 'string' && stored.id.length > 0);
check('file exists on disk', fs.existsSync(stored.path));
check('roundtrip content identical', readTrace(stored.id, { dir: tmpDir }) === content);
check('originalChars = content length', stored.originalChars === content.length);
check('default id shape yyyymmdd-hhmmss-hash6', /^\d{8}-\d{6}-[0-9a-f]{6}$/.test(stored.id));

// ── Write-once immutability ──────────────────────────────────────

console.log('write-once:');
const explicit = storeTrace('first version of the trace', { dir: tmpDir, id: 'fixed-id-000001' });
let threw = false;
try {
  storeTrace('second version of the trace', { dir: tmpDir, id: 'fixed-id-000001' });
} catch (e) {
  threw = /write-once/.test(e.message);
}
check('second store with same id throws', threw);
check('existing content unchanged after rejected store', readTrace('fixed-id-000001', { dir: tmpDir }) === 'first version of the trace');

// ── Truncation ───────────────────────────────────────────────────

console.log('truncation:');
const big = 'x'.repeat(MAX_TRACE_CHARS + 500);
const cut = storeTrace(big, { dir: tmpDir, id: 'fixed-id-000002' });
const cutText = readTrace('fixed-id-000002', { dir: tmpDir });
check('truncated flag true', cut.truncated === true);
check('originalChars reports full length', cut.originalChars === big.length);
check('marker appended', cutText.endsWith(`\n\n[truncated: kept ${MAX_TRACE_CHARS} of ${big.length} chars]`));
check('kept prefix is intact', cutText.startsWith('x'.repeat(MAX_TRACE_CHARS)));

// ── List + stats ─────────────────────────────────────────────────

console.log('listTraces / traceStats:');
storeTrace('aaa', { dir: tmpDir, id: '20260101-000001-aaaaaa' });
storeTrace('bbb', { dir: tmpDir, id: '20260102-000002-bbbbbb' });
const listed = listTraces({ dir: tmpDir });
check('list sorted by id', listed.map(t => t.id).join(',') === ['20260101-000001-aaaaaa', '20260102-000002-bbbbbb', 'fixed-id-000001', 'fixed-id-000002', stored.id].sort((a, b) => a.localeCompare(b)).join(','));
check('list entries carry path and bytes', listed.every(t => t.path.endsWith('.md') && t.bytes > 0));
const stats = traceStats({ dir: tmpDir });
check('stats count = 5 traces', stats.count === 5);
check('stats totalBytes = sum of entries', stats.totalBytes === listed.reduce((s, t) => s + t.bytes, 0));

console.log('readTrace missing:');
let missingThrew = false;
try { readTrace('does-not-exist', { dir: tmpDir }); } catch (e) { missingThrew = /no trace/.test(e.message); }
check('read-missing throws clear error', missingThrew);

// ── Sampling ─────────────────────────────────────────────────────

console.log('sampleTraces:');
const items = [];
for (let i = 0; i < 10; i++) items.push({ id: `f${i}`, outcome: 'failure' });
for (let i = 0; i < 6; i++) items.push({ id: `p${i}`, outcome: 'success' });
items.push({ id: 'm1', outcome: 'mixed' });
const sample = sampleTraces(items);
check('constants exported', MAX_TRACES_PER_CYCLE === 8 && MAX_FAIL_TRACES === 5 && MAX_PASS_TRACES === 3 && MAX_TRACE_CHARS === 15000);
check('fail cap applied (5 of 10)', sample.failing.length === 5);
check('pass cap applied (3 of 6)', sample.passing.length === 3);
check('sampled = failing + passing', sample.sampled.length === 8);
check('classification keeps input order', sample.failing[0].id === 'f0' && sample.passing[0].id === 'p0');
check('alias outcomes (fail/pass) classified', sampleTraces([{ outcome: 'fail' }, { outcome: 'pass' }]).sampled.length === 2);
check('overrides respected', sampleTraces(items, { maxFail: 2, maxPass: 1 }).sampled.length === 3);

// ── Cleanup ──────────────────────────────────────────────────────

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
