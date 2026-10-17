#!/usr/bin/env node

/**
 * Tests for src/evolution-loop.mjs (issue #36)
 *
 * Mocked deps + temp dirs only — the real home dir is never touched.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  runEvolutionLoop,
  readIterations,
  summarizeIterations,
  finalizeManual,
  stageOf,
} from './evolution-loop.mjs';

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((e) => { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; });
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'meta-skills-loop-'));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf-8');
}

// ── Mock deps ───────────────────────────────────────────────────────────────

/** Scripted sequence: returns values[i], then repeats the last value. */
function scripted(values) {
  let i = 0;
  return () => (i < values.length ? values[i++] : values[values.length - 1]);
}

/**
 * Mock dep set driven by scripted scores + opportunity fixtures.
 * `opportunities` entries: { id, type, skillIds, delta, keep }
 */
function makeDeps(opts = {}) {
  const { scores = [], opportunities = [], index = { skills: [] }, extra = {} } = opts;
  const calls = { measure: 0, apply: 0, snapshot: 0, restore: 0, writeIndex: 0, writeProposals: 0 };
  const seq = scripted(scores);

  const deps = {
    baseline: () => ({ averageScore: 0, skills: [] }),
    measure: () => { calls.measure++; return seq(); },
    readIndex: () => index,
    analyze: () => opportunities,
    propose: (idx, baseline, opps) => opps.map(o => ({
      id: o.id,
      type: o.type,
      skillIds: o.skillIds || [o.id],
      scoreDelta: { overall: o.delta || 0 },
      _keep: !!o.keep,
    })),
    gate: (proposals) => ({
      kept: proposals.filter(p => p._keep),
      discarded: proposals.filter(p => !p._keep),
    }),
    snapshot: (globalJsonPath, comment) => {
      calls.snapshot++;
      return { hash: 'mock', ts: new Date().toISOString(), comment, content: fs.readFileSync(globalJsonPath, 'utf-8') };
    },
    restore: (handle, globalJsonPath) => {
      calls.restore++;
      fs.writeFileSync(globalJsonPath, handle.content, 'utf-8');
      return true;
    },
    apply: (proposal, idx) => {
      calls.apply++;
      return { ...idx, skills: [...(idx.skills || []), { id: proposal.id, applied: true }] };
    },
    writeIndex: (idx, globalJsonPath) => {
      calls.writeIndex++;
      writeFile(globalJsonPath, JSON.stringify(idx, null, 2));
    },
    writeProposals: (kept) => { calls.writeProposals += kept.length; },
    ...extra,
  };

  return { deps, calls };
}

function iterationRecords(records) {
  return records.filter(r => r && r.type === 'iteration');
}

// ── Tests ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('evolution-loop tests (issue #36)');

  await ok('K iterations run, JSONL records written and parseable', async () => {
    const dir = tmpDir();
    const iterationsPath = path.join(dir, 'iterations.jsonl');
    const { deps } = makeDeps({
      scores: [40, 45, 50, 55, 60],
      opportunities: [{ id: 'skill-a', type: 'rewrite', delta: 5, keep: true }],
    });

    const result = await runEvolutionLoop({ iterations: 5, iterationsPath, quiet: true, runId: 'run-test-1' }, deps);

    assert.equal(result.records.length, 6, `6 records (5 iterations + summary), got ${result.records.length}`);
    assert.equal(iterationRecords(result.records).length, 5, '5 iteration records');

    const lines = fs.readFileSync(iterationsPath, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 6, 'JSONL file has 6 parseable lines');
    const parsed = lines.map(l => JSON.parse(l));
    assert.equal(parsed[0].type, 'iteration', 'first record is an iteration');
    assert.equal(parsed[5].type, 'summary', 'last record is the summary');

    const first = parsed[0];
    for (const field of ['ts', 'runId', 'iteration', 'mode', 'proposalsAttempted', 'proposalsKept',
      'applied', 'accepted', 'scoreBefore', 'scoreAfter', 'estimatedDelta', 'skillIds', 'stage', 'termination']) {
      assert.ok(field in first, `iteration record has field "${field}"`);
    }
    assert.equal(first.runId, 'run-test-1', 'runId recorded on every record');
    assert.equal(first.mode, 'dry-run', 'dry-run mode recorded');
    assert.equal(first.scoreAfter, null, 'scoreAfter is null in dry-run');
    assert.equal(parsed[1].stage, 'early', 'iteration 2 is in the early bucket');
    assert.equal(parsed[4].stage, 'mid', 'iteration 5 is in the mid bucket');
    assert.equal(parsed[4].termination, 'max-iterations', 'last iteration terminates with max-iterations');
    cleanup(dir);
  });

  await ok('early stop at ceiling', async () => {
    const dir = tmpDir();
    const iterationsPath = path.join(dir, 'iterations.jsonl');
    const { deps } = makeDeps({
      scores: [40, 95],
      opportunities: [{ id: 'skill-a', type: 'rewrite', delta: 5, keep: true }],
    });

    const result = await runEvolutionLoop({ iterations: 5, ceiling: 90, iterationsPath, quiet: true, runId: 'run-ceiling' }, deps);

    assert.equal(result.termination, 'ceiling', 'termination reason is ceiling');
    assert.equal(result.summary.iterationsRun, 2, `stopped after 2 iterations, got ${result.summary.iterationsRun}`);
    assert.equal(result.summary.termination, 'ceiling', 'summary carries the termination reason');
    assert.equal(iterationRecords(result.records)[1].termination, 'ceiling', 'the stopping iteration records ceiling');
    cleanup(dir);
  });

  await ok('no-progress stop after N stalled iterations', async () => {
    const dir = tmpDir();
    const iterationsPath = path.join(dir, 'iterations.jsonl');
    const { deps } = makeDeps({
      scores: [50, 50, 50, 50],
      opportunities: [{ id: 'skill-a', type: 'rewrite', delta: 0, keep: false }],
    });

    const result = await runEvolutionLoop({ iterations: 5, noProgressStop: 2, iterationsPath, quiet: true, runId: 'run-noprog' }, deps);

    assert.equal(result.termination, 'no-progress', 'termination reason is no-progress');
    assert.equal(result.summary.iterationsRun, 2, `stopped after 2 stalled iterations, got ${result.summary.iterationsRun}`);
    cleanup(dir);
  });

  await ok('max-iterations default (K = 5)', async () => {
    const dir = tmpDir();
    const iterationsPath = path.join(dir, 'iterations.jsonl');
    const { deps } = makeDeps({
      scores: [40, 41, 42, 43, 44, 45],
      opportunities: [{ id: 'skill-a', type: 'rewrite', delta: 1, keep: true }],
    });

    const result = await runEvolutionLoop({ iterationsPath, quiet: true, runId: 'run-default' }, deps);

    assert.equal(result.summary.iterationsRun, 5, 'default K is 5');
    assert.equal(result.termination, 'max-iterations', 'termination reason is max-iterations');
    cleanup(dir);
  });

  await ok('acceptance rate + stageStats + perSkill math', async () => {
    const dir = tmpDir();
    const iterationsPath = path.join(dir, 'iterations.jsonl');
    // Alternating gate outcome keeps the no-progress counter below its limit.
    const keepFlags = [true, false, true, false, true, false, true, false];
    let k = 0;
    const { deps } = makeDeps({
      scores: [40, 40, 44, 44, 48, 48, 52, 52],
      extra: {
        analyze: () => {
          const keep = keepFlags[k++];
          return [
            { id: 'skill-a', type: 'rewrite', delta: 5, keep },
            { id: 'skill-b', type: 'merge', delta: 3, keep },
          ];
        },
      },
    });

    const result = await runEvolutionLoop({ iterations: 8, iterationsPath, quiet: true, runId: 'run-math' }, deps);

    assert.equal(result.summary.iterationsRun, 8, '8 iterations recorded');
    assert.equal(result.termination, 'max-iterations', 'ends on max-iterations, not no-progress');
    assert.equal(result.summary.acceptanceRate, 0.5, `acceptance rate 8/16 = 0.5, got ${result.summary.acceptanceRate}`);
    assert.deepEqual(result.summary.stageStats, { early: 2, mid: 3, late: 3 }, 'stage buckets 1-2 / 3-5 / 6+');
    assert.deepEqual(result.summary.perSkill, {
      'skill-a': { attempted: 8, accepted: 4 },
      'skill-b': { attempted: 8, accepted: 4 },
    }, 'per-skill attempted/accepted counts');
    assert.equal(result.summary.avgDelta, 2, `avg delta (4+0)*4 / 8 = 2, got ${result.summary.avgDelta}`);
    cleanup(dir);
  });

  await ok('dry-run makes no index mutations', async () => {
    const dir = tmpDir();
    const gjPath = path.join(dir, 'global.json');
    const original = JSON.stringify({ version: '1.0', skills: [{ id: 'skill-a' }] }, null, 2);
    writeFile(gjPath, original);
    const iterationsPath = path.join(dir, 'iterations.jsonl');

    const { deps, calls } = makeDeps({
      scores: [40, 45],
      opportunities: [{ id: 'skill-a', type: 'rewrite', delta: 5, keep: true }],
    });

    await runEvolutionLoop({ iterations: 2, globalJson: gjPath, iterationsPath, quiet: true, runId: 'run-dry' }, deps);

    assert.equal(calls.apply, 0, 'apply dep never called in dry-run');
    assert.equal(calls.writeIndex, 0, 'index never written in dry-run');
    assert.equal(calls.writeProposals, 0, 'no proposals recorded in dry-run');
    assert.equal(fs.readFileSync(gjPath, 'utf-8'), original, 'global.json content unchanged');
    cleanup(dir);
  });

  await ok('write mode: regression rolls back and marks the iteration rejected', async () => {
    const dir = tmpDir();
    const gjPath = path.join(dir, 'global.json');
    const original = JSON.stringify({ version: '1.0', skills: [{ id: 'skill-a' }] }, null, 2);
    writeFile(gjPath, original);
    const iterationsPath = path.join(dir, 'iterations.jsonl');

    const { deps, calls } = makeDeps({
      scores: [60, 50], // before, after → regression
      opportunities: [{ id: 'skill-a', type: 'rewrite', delta: 5, keep: true }],
      index: { version: '1.0', skills: [{ id: 'skill-a' }] },
    });

    const result = await runEvolutionLoop({ iterations: 1, globalJson: gjPath, iterationsPath, quiet: true, write: true, runId: 'run-reg' }, deps);

    const rec = iterationRecords(result.records)[0];
    assert.equal(calls.snapshot, 1, 'snapshot taken before applying');
    assert.equal(calls.apply, 1, 'mutation applied');
    assert.equal(calls.restore, 1, 'snapshot restored on regression');
    assert.equal(rec.mode, 'write', 'record mode is write');
    assert.equal(rec.applied, 0, 'applied count is 0 after rollback');
    assert.equal(rec.accepted, 0, 'iteration marked rejected');
    assert.equal(rec.rejected, 'regression', 'rejection reason is regression');
    assert.equal(rec.rolledBack, true, 'rollback recorded');
    assert.equal(fs.readFileSync(gjPath, 'utf-8'), original, 'index restored to the snapshot content');
    cleanup(dir);
  });

  await ok('write mode: improvement is accepted and kept', async () => {
    const dir = tmpDir();
    const gjPath = path.join(dir, 'global.json');
    writeFile(gjPath, JSON.stringify({ version: '1.0', skills: [{ id: 'skill-a' }] }, null, 2));
    const iterationsPath = path.join(dir, 'iterations.jsonl');

    const { deps, calls } = makeDeps({
      scores: [60, 70], // before, after → improvement
      opportunities: [{ id: 'skill-a', type: 'rewrite', delta: 10, keep: true }],
      index: { version: '1.0', skills: [{ id: 'skill-a' }] },
    });

    const result = await runEvolutionLoop({ iterations: 1, globalJson: gjPath, iterationsPath, quiet: true, write: true, runId: 'run-keep' }, deps);

    const rec = iterationRecords(result.records)[0];
    assert.equal(calls.restore, 0, 'no rollback on improvement');
    assert.equal(rec.applied, 1, 'mutation kept');
    assert.equal(rec.accepted, 1, 'iteration accepted');
    assert.equal(rec.scoreAfter, 70, 're-measured after apply');
    const mutated = JSON.parse(fs.readFileSync(gjPath, 'utf-8'));
    assert.equal(mutated.skills.length, 2, 'mutated index written to disk');
    cleanup(dir);
  });

  await ok('finalizeManual() writes a manual summary', async () => {
    const dir = tmpDir();
    const iterationsPath = path.join(dir, 'iterations.jsonl');
    const records = [
      { ts: 'x', type: 'iteration', runId: 'run-manual', iteration: 1, mode: 'dry-run',
        proposalsAttempted: 2, proposalsKept: 1, applied: 0, accepted: 1, scoreBefore: 40,
        scoreAfter: null, estimatedDelta: 4, skillIds: ['skill-a'], stage: 'early', termination: null },
      { ts: 'y', type: 'iteration', runId: 'run-manual', iteration: 2, mode: 'dry-run',
        proposalsAttempted: 2, proposalsKept: 0, applied: 0, accepted: 0, scoreBefore: 40,
        scoreAfter: null, estimatedDelta: 0, skillIds: ['skill-a'], stage: 'mid', termination: null },
    ];

    const summary = finalizeManual(records, { iterationsPath });
    assert.equal(summary.termination, 'manual', 'termination reason is manual');
    assert.equal(summary.iterationsRun, 2, 'two iterations in the manual summary');
    assert.equal(summary.acceptanceRate, 0.25, 'acceptance rate 1/4 = 0.25');

    const onDisk = readIterations(iterationsPath);
    assert.equal(onDisk.length, 1, 'manual summary appended to the records file');
    assert.equal(onDisk[0].type, 'summary', 'appended record is a summary');
    assert.equal(onDisk[0].termination, 'manual', 'summary on disk says manual');
    cleanup(dir);
  });

  await ok('corrupt / half-written lines are tolerated', async () => {
    const dir = tmpDir();
    const iterationsPath = path.join(dir, 'iterations.jsonl');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(iterationsPath, [
      JSON.stringify({ ts: 'x', type: 'iteration', runId: 'run-x', iteration: 1, mode: 'dry-run',
        proposalsAttempted: 3, proposalsKept: 2, applied: 0, accepted: 2, scoreBefore: 50,
        scoreAfter: null, estimatedDelta: 4, skillIds: ['skill-a'], stage: 'early', termination: 'ceiling' }),
      '{"ts":"y","type":"iteration","runId":"run-x"',            // half line
      '',
      JSON.stringify({ ts: 'z', type: 'summary', runId: 'run-x', iterationsRun: 1, acceptanceRate: 0.667,
        applied: 0, termination: 'ceiling', avgDelta: 4, stageStats: { early: 1, mid: 0, late: 0 },
        perSkill: { 'skill-a': { attempted: 1, accepted: 1 } } }),
    ].join('\n') + '\n', 'utf-8');

    const records = readIterations(iterationsPath);
    assert.equal(records.length, 2, 'corrupt line skipped, 2 records read');

    const summary = summarizeIterations(records);
    assert.equal(summary.overall.runs, 1, 'one run counted');
    assert.equal(summary.iterationsRun, 1, 'last-run iteration count');
    assert.equal(summary.termination, 'ceiling', 'termination reason preserved');
    assert.equal(summary.acceptanceRate, 0.667, 'acceptance rate from the stored summary');
    assert.deepEqual(summary.overall.terminationCounts, { ceiling: 1 }, 'termination counts');
    assert.equal(summarizeIterations([]).overall.runs, 0, 'empty records → zero runs');
    cleanup(dir);
  });

  await ok('stage buckets: early 1-2, mid 3-5, late 6+', async () => {
    assert.equal(stageOf(1), 'early', 'iteration 1 → early');
    assert.equal(stageOf(2), 'early', 'iteration 2 → early');
    assert.equal(stageOf(3), 'mid', 'iteration 3 → mid');
    assert.equal(stageOf(5), 'mid', 'iteration 5 → mid');
    assert.equal(stageOf(6), 'late', 'iteration 6 → late');
  });

  console.log(`\n═══ All evolution-loop tests passed (${passed}) ═══`);
  if (process.exitCode) process.exit(1);
}

main();
