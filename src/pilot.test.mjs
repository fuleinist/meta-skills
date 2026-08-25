#!/usr/bin/env node

/**
 * Smoke test for pilot.mjs (v0.1.9 — skill A/B testing)
 *
 * No network. Tests:
 *   - start validation (missing files, duplicate start, bad min-runs)
 *   - deterministic alternating assignment
 *   - record aggregation & explicit variant override
 *   - pooled two-proportion z-test against hand-computed values
 *   - verdict transitions: running → inconclusive → winner
 *   - conclude writes pilot summary into global.json; dry-run doesn't
 *   - stop removes pilot; list reports pilots
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pilot = await import(pathToFileURL(path.join(__dirname, 'pilot.mjs')).href);

let passed = 0;
let failed = 0;

function check(label, condition) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else           { console.log(`  ✗ ${label}`); failed++; }
}

function throws(fn, msgPart) {
  try { fn(); return false; } catch (e) { return e.message.includes(msgPart); }
}

// ── Temp workspace ────────────────────────────────────────────────────

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-test-'));
const pilotsJson = path.join(tmp, 'pilots.json');
const fileA = path.join(tmp, 'SKILL_variant_A.md');
const fileB = path.join(tmp, 'SKILL_variant_B.md');
fs.writeFileSync(fileA, '# variant A\n');
fs.writeFileSync(fileB, '# variant B\n');
const O = { pilotsJson };

// ── start validation ──────────────────────────────────────────────────

check('start rejects missing variant A file',
  throws(() => pilot.startPilot('s1', { variantA: path.join(tmp, 'nope.md'), variantB: fileB, ...O }), 'variant A file not found'));
check('start rejects missing variant B file',
  throws(() => pilot.startPilot('s1', { variantA: fileA, variantB: path.join(tmp, 'nope.md'), ...O }), 'variant B file not found'));
check('start rejects missing skill-id',
  throws(() => pilot.startPilot('', { variantA: fileA, variantB: fileB, ...O }), 'missing skill-id'));
check('start rejects missing variants',
  throws(() => pilot.startPilot('s1', { variantA: fileA, ...O }), 'both --variant-a and --variant-b'));
check('start rejects min-runs < 1',
  throws(() => pilot.startPilot('s1', { variantA: fileA, variantB: fileB, minRuns: 0, ...O }), 'min-runs must be >= 1'));

const p1 = pilot.startPilot('s1', { variantA: fileA, variantB: fileB, minRuns: 2, ...O });
check('start creates pilot with two variants', p1.variants.length === 2 && p1.variants[0].id === 'A' && p1.variants[1].id === 'B');
check('start stores absolute variant paths', p1.variants[0].path === fileA && p1.variants[1].path === fileB);
check('start persists to pilots.json', pilot.loadPilots(pilotsJson).s1 !== undefined);
check('duplicate start rejected',
  throws(() => pilot.startPilot('s1', { variantA: fileA, variantB: fileB, ...O }), 'already exists'));

// ── alternating assignment ────────────────────────────────────────────

const pilots = pilot.loadPilots(pilotsJson);
check('first assignment is variant A (0 runs)', pilot.assignVariant(pilots.s1).id === 'A');
pilot.recordRun('s1', { outcome: 'success', ...O });
const after1 = pilot.loadPilots(pilotsJson);
check('after 1 run, next assignment is variant B', pilot.assignVariant(after1.s1).id === 'B');
pilot.recordRun('s1', { outcome: 'failure', ...O });
const after2 = pilot.loadPilots(pilotsJson);
check('after 2 runs, next assignment is variant A again', pilot.assignVariant(after2.s1).id === 'A');

// ── recording ─────────────────────────────────────────────────────────

check('record rejects bad outcome',
  throws(() => pilot.recordRun('s1', { outcome: 'maybe', ...O }), 'outcome must be success|failure'));
check('record rejects unknown pilot',
  throws(() => pilot.recordRun('ghost', { outcome: 'success', ...O }), 'no pilot'));
check('record rejects unknown variant',
  throws(() => pilot.recordRun('s1', { outcome: 'success', variant: 'Z', ...O }), 'unknown variant'));

pilot.recordRun('s1', { outcome: 'success', variant: 'B', ...O }); // explicit override
const s1 = pilot.loadPilots(pilotsJson).s1;
check('explicit variant override recorded on B', s1.runs[s1.runs.length - 1].variant === 'B');
check('runs carry outcome and timestamp', s1.runs.every(r => r.outcome && r.timestamp));

// ── z-test math (hand-computed) ───────────────────────────────────────

// Construct: A 20/25 success (0.80), B 10/25 success (0.40).
// pooled = 30/50 = 0.6; se = sqrt(0.6*0.4*(2/25)) = sqrt(0.0192) ≈ 0.138564
// z = (0.8-0.4)/0.138564 ≈ 2.886751
const fakePilot = {
  min_runs: 2,
  variants: [{ id: 'A', path: fileA }, { id: 'B', path: fileB }],
  runs: [
    ...Array.from({ length: 20 }, () => ({ variant: 'A', outcome: 'success', timestamp: 't' })),
    ...Array.from({ length: 5 }, () => ({ variant: 'A', outcome: 'failure', timestamp: 't' })),
    ...Array.from({ length: 10 }, () => ({ variant: 'B', outcome: 'success', timestamp: 't' })),
    ...Array.from({ length: 15 }, () => ({ variant: 'B', outcome: 'failure', timestamp: 't' })),
  ],
};
const an1 = pilot.analyzePilot(fakePilot);
check('stats count runs per variant', an1.stats.A.runs === 25 && an1.stats.B.runs === 25);
check('rates match hand computation', Math.abs(an1.stats.A.rate - 0.8) < 1e-9 && Math.abs(an1.stats.B.rate - 0.4) < 1e-9);
check('z matches pooled two-proportion formula', Math.abs(an1.z - 2.886751345948129) < 1e-9);
check('clear difference declares winner A', an1.verdict === 'winner' && an1.winner === 'A');
check('uplift is A minus B', Math.abs(an1.uplift - 0.4) < 1e-9);

// Equal rates → z = 0 → inconclusive (not winner)
const tiePilot = {
  min_runs: 2,
  variants: [{ id: 'A', path: fileA }, { id: 'B', path: fileB }],
  runs: [
    ...Array.from({ length: 10 }, () => ({ variant: 'A', outcome: 'success', timestamp: 't' })),
    ...Array.from({ length: 10 }, () => ({ variant: 'B', outcome: 'success', timestamp: 't' })),
  ],
};
const an2 = pilot.analyzePilot(tiePilot);
check('identical rates give z = 0', an2.z === 0);
check('identical rates are inconclusive, never winner', an2.verdict === 'inconclusive' && an2.winner === null);

// All-success both arms → pooled p = 1 → z forced to 0, inconclusive
const allWin = {
  min_runs: 2,
  variants: [{ id: 'A', path: fileA }, { id: 'B', path: fileB }],
  runs: [
    ...Array.from({ length: 5 }, () => ({ variant: 'A', outcome: 'success', timestamp: 't' })),
    ...Array.from({ length: 5 }, () => ({ variant: 'B', outcome: 'success', timestamp: 't' })),
  ],
};
check('degenerate pooled p stays finite and inconclusive', pilot.analyzePilot(allWin).z === 0 && pilot.analyzePilot(allWin).verdict === 'inconclusive');

// Insufficient samples → running, even with huge gap
const earlyPilot = {
  min_runs: 25,
  variants: [{ id: 'A', path: fileA }, { id: 'B', path: fileB }],
  runs: [
    ...Array.from({ length: 3 }, () => ({ variant: 'A', outcome: 'success', timestamp: 't' })),
    ...Array.from({ length: 3 }, () => ({ variant: 'B', outcome: 'failure', timestamp: 't' })),
  ],
};
check('insufficient samples keep verdict running', pilot.analyzePilot(earlyPilot).verdict === 'running');

// B better than A → winner B (sign handling)
const bWins = {
  min_runs: 2,
  variants: [{ id: 'A', path: fileA }, { id: 'B', path: fileB }],
  runs: [
    ...Array.from({ length: 5 }, () => ({ variant: 'A', outcome: 'success', timestamp: 't' })),
    ...Array.from({ length: 20 }, () => ({ variant: 'A', outcome: 'failure', timestamp: 't' })),
    ...Array.from({ length: 20 }, () => ({ variant: 'B', outcome: 'success', timestamp: 't' })),
    ...Array.from({ length: 5 }, () => ({ variant: 'B', outcome: 'failure', timestamp: 't' })),
  ],
};
const an3 = pilot.analyzePilot(bWins);
check('negative z declares winner B', an3.verdict === 'winner' && an3.winner === 'B' && an3.z < 0);

// ── conclude ──────────────────────────────────────────────────────────

const gj = path.join(tmp, 'global.json');
fs.writeFileSync(gj, JSON.stringify({ version: '1.0', skills: [{ id: 's1', name: 'Test skill' }, { id: 's2', name: 'Pilot skill' }], stale: [] }) + '\n');

// s1 pilot has 3 runs, min_runs 2, mixed outcomes → no guaranteed winner; use a fresh pilot with forced data.
pilot.startPilot('s2', { variantA: fileA, variantB: fileB, minRuns: 2, ...O });
const s2Runs = [
  ...Array.from({ length: 20 }, () => ({ variant: 'A', outcome: 'success', timestamp: 't' })),
  ...Array.from({ length: 5 }, () => ({ variant: 'A', outcome: 'failure', timestamp: 't' })),
  ...Array.from({ length: 10 }, () => ({ variant: 'B', outcome: 'success', timestamp: 't' })),
  ...Array.from({ length: 15 }, () => ({ variant: 'B', outcome: 'failure', timestamp: 't' })),
];
const raw = pilot.loadPilots(pilotsJson);
raw.s2.runs = s2Runs;
pilot.savePilots(pilotsJson, raw);

check('conclude refuses without winner',
  (() => { pilot.startPilot('s3', { variantA: fileA, variantB: fileB, minRuns: 50, ...O });
    const r = pilot.concludePilot('s3', { globalJson: gj, pilotsJson }); return r.concluded === false && r.analysis.verdict === 'running'; })());

const dry = pilot.concludePilot('s2', { globalJson: gj, dryRun: true, pilotsJson });
check('conclude dry-run reports winner', dry.concluded === true && dry.summary.winner === 'A');
const gjAfterDry = JSON.parse(fs.readFileSync(gj, 'utf-8'));
check('dry-run does not write global.json', gjAfterDry.skills[1].pilot === undefined);

const real = pilot.concludePilot('s2', { globalJson: gj, pilotsJson });
check('conclude writes winner summary', real.concluded === true && real.summary.winner === 'A');
const gjAfter = JSON.parse(fs.readFileSync(gj, 'utf-8'));
check('skill entry gains pilot object', gjAfter.skills[1].pilot && gjAfter.skills[1].pilot.winner === 'A');
check('pilot summary carries rates and z', gjAfter.skills[1].pilot.rates.A === 0.8 && Math.abs(gjAfter.skills[1].pilot.z - 2.886751345948129) < 1e-9);
check('pilot summary records total runs', gjAfter.skills[1].pilot.runs === 50);

check('conclude errors for unknown pilot', throws(() => pilot.concludePilot('ghost', { globalJson: gj, pilotsJson }), 'no pilot'));

// Winner exists but skill absent from global.json → 'not found' error
pilot.startPilot('s-ghost', { variantA: fileA, variantB: fileB, minRuns: 2, ...O });
const rawGhost = pilot.loadPilots(pilotsJson);
rawGhost['s-ghost'].runs = [
  ...Array.from({ length: 20 }, () => ({ variant: 'A', outcome: 'success', timestamp: 't' })),
  ...Array.from({ length: 5 }, () => ({ variant: 'A', outcome: 'failure', timestamp: 't' })),
  ...Array.from({ length: 10 }, () => ({ variant: 'B', outcome: 'success', timestamp: 't' })),
  ...Array.from({ length: 15 }, () => ({ variant: 'B', outcome: 'failure', timestamp: 't' })),
];
pilot.savePilots(pilotsJson, rawGhost);
check('conclude errors for unknown skill in index', throws(() => pilot.concludePilot('s-ghost', { globalJson: gj, pilotsJson }), 'not found'));

// ── stop & list ───────────────────────────────────────────────────────

const before = pilot.listPilots({ pilotsJson }).map(r => r.skill).sort();
check('list reports registered pilots', before.includes('s1') && before.includes('s2') && before.includes('s3'));
check('list includes verdicts', pilot.listPilots({ pilotsJson }).every(r => ['running', 'inconclusive', 'winner'].includes(r.verdict)));

pilot.stopPilot('s3', O);
check('stop removes the pilot', pilot.loadPilots(pilotsJson).s3 === undefined);
check('stop errors for unknown pilot', throws(() => pilot.stopPilot('ghost', O), 'no pilot'));
check('list shrinks after stop', !pilot.listPilots({ pilotsJson }).some(r => r.skill === 's3'));

// ── Summary ───────────────────────────────────────────────────────────

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
