#!/usr/bin/env node

/**
 * meta-skills v0.2.5 — Multi-iteration evolution loop (issue #36)
 *
 * Turns the one-shot `evolve --all` pipeline into a K-iteration loop that
 * mirrors WikiSkill Algorithm 1 (measure → propose → gate → optionally apply):
 *
 *   for k = 1..K:
 *     measure  → scalar progress metric (0-100)
 *     analyze  → mutation opportunities
 *     propose  → proposals + Pareto gate
 *     apply    → snapshot, mutate, re-measure; rollback on regression (write mode)
 *     record   → one JSONL line per iteration
 *     stop     → ceiling | no-progress | max-iterations | manual
 *
 * Every iteration is recorded in ~/.meta-skills/evolve/iterations.jsonl and a
 * summary record closes the run.
 *
 * Integration points (documented, not imported — those modules may not exist yet):
 *   - issue #35 validation harness will replace the default `measure` dep. Keep
 *     the contract: measure(globalJsonPath, baseline) → scalar 0-100.
 *   - src/wiki.mjs (in-flight) can feed `analyze` with wiki-derived proposals;
 *     the loop only requires analyze(index, baseline) → opportunities array.
 *
 * Commands:
 *   node src/evolution-loop.mjs run [--iterations K] [--ceiling N]
 *       [--no-progress-stop N] [--write] [--json] [--global-json <path>]
 *       [--iterations-path <path>] [--proposals-path <path>]
 *   node src/evolution-loop.mjs status [--json]
 *
 * DRY-RUN is the default: the index is never mutated, only estimates are
 * recorded. `--write` opts in to apply + rollback.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { scoreAll } from './quality-scorer.mjs';
import {
  analyzeMutations,
  generateProposals,
  paretoFilter,
  applyMutation,
  writeProposals,
  defaultEvolveDir,
  defaultProposalsPath,
} from './evolution.mjs';
import { takeSnapshot } from './rollback-ledger.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Defaults ────────────────────────────────────────────────────────

const DEFAULT_ITERATIONS = 5;
const DEFAULT_CEILING = 100;
const DEFAULT_NO_PROGRESS_STOP = 2;

/** Stage bucket for an iteration number: early = 1-2, mid = 3-5, late = 6+. */
function stageOf(k) {
  return k <= 2 ? 'early' : k <= 5 ? 'mid' : 'late';
}

function defaultIterationsPath() {
  return path.join(defaultEvolveDir(), 'iterations.jsonl');
}

function defaultGlobalJson() {
  return path.join(os.homedir(), '.meta-skills', 'global.json');
}

// ── Small numeric / id helpers ──────────────────────────────────────

function roundRate(accepted, attempted) {
  if (!attempted) return 0;
  return Math.round((accepted / attempted) * 1000) / 1000;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Deterministic-ish run id: ev-<compact-ts>-<hash6>. */
function newRunId(now = new Date()) {
  const iso = now.toISOString();
  const compact = iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').slice(0, 15);
  let h = 5381;
  for (let i = 0; i < iso.length; i++) h = ((h << 5) + h + iso.charCodeAt(i)) >>> 0;
  return `ev-${compact}-${h.toString(36).slice(0, 6)}`;
}

// ── JSONL record storage ────────────────────────────────────────────

/** Append one record as a JSONL line (atomic-enough: single append). */
function appendRecord(record, iterationsPath = defaultIterationsPath()) {
  const dir = path.dirname(iterationsPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(iterationsPath, JSON.stringify(record) + '\n', 'utf-8');
  return record;
}

/**
 * Read iteration/summary records. Corrupt or half-written lines are skipped.
 * @param {string} [iterationsPath]
 * @returns {Array<object>}
 */
function readIterations(iterationsPath = defaultIterationsPath()) {
  let raw;
  try {
    raw = fs.readFileSync(iterationsPath, 'utf-8');
  } catch {
    return [];
  }
  const records = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      records.push(JSON.parse(t));
    } catch {
      // corrupt / half line — tolerated, skip it
    }
  }
  return records;
}

// ── Summary math ────────────────────────────────────────────────────

/** Delta for one iteration: measured delta when available, else the estimate. */
function iterationDelta(rec) {
  if (rec.scoreAfter != null) return rec.scoreAfter - rec.scoreBefore;
  return rec.estimatedDelta || 0;
}

/**
 * Build the summary record shape for one run.
 * @param {Array<object>} records
 * @param {{ runId: string|null, termination: string|null }} ctx
 * @returns {object} summary record shape
 */
function buildSummary(records, ctx = {}) {
  const runId = ctx.runId ?? null;
  const run = records.filter(r => r && r.type === 'iteration' && r.runId === runId);

  const attempted = run.reduce((s, r) => s + (r.proposalsAttempted || 0), 0);
  const accepted = run.reduce((s, r) => s + (r.accepted || 0), 0);
  const applied = run.reduce((s, r) => s + (r.applied || 0), 0);

  const stageStats = { early: 0, mid: 0, late: 0 };
  const perSkill = {};
  for (const r of run) {
    const stage = r.stage || stageOf(r.iteration);
    stageStats[stage] = (stageStats[stage] || 0) + 1;
    for (const id of r.skillIds || []) {
      if (!perSkill[id]) perSkill[id] = { attempted: 0, accepted: 0 };
      perSkill[id].attempted++;
      if ((r.accepted || 0) > 0) perSkill[id].accepted++;
    }
  }

  const deltas = run.map(iterationDelta);
  const avgDelta = deltas.length ? round2(deltas.reduce((a, b) => a + b, 0) / deltas.length) : 0;

  return {
    ts: new Date().toISOString(),
    type: 'summary',
    runId,
    iterationsRun: run.length,
    acceptanceRate: roundRate(accepted, attempted),
    applied,
    termination: ctx.termination ?? null,
    avgDelta,
    stageStats,
    perSkill,
  };
}

/**
 * Summarize a records file: last-run shape + overall counts.
 * @param {Array<object>} records — from readIterations()
 * @returns {object}
 */
function summarizeIterations(records) {
  const iters = (records || []).filter(r => r && r.type === 'iteration');
  const summaries = (records || []).filter(r => r && r.type === 'summary');

  const overall = {
    runs: new Set(iters.map(r => r.runId)).size,
    acceptanceRate: roundRate(
      iters.reduce((s, r) => s + (r.accepted || 0), 0),
      iters.reduce((s, r) => s + (r.proposalsAttempted || 0), 0),
    ),
    terminationCounts: {},
    avgScoreDelta: iters.length
      ? round2(iters.map(iterationDelta).reduce((a, b) => a + b, 0) / iters.length)
      : 0,
  };
  for (const r of iters) {
    if (r.termination) overall.terminationCounts[r.termination] = (overall.terminationCounts[r.termination] || 0) + 1;
  }

  if (iters.length === 0) {
    const last = summaries.length ? summaries[summaries.length - 1] : null;
    return {
      ...(last || {}),
      runId: last?.runId ?? null,
      iterationsRun: last?.iterationsRun ?? 0,
      stageStats: { early: 0, mid: 0, late: 0 },
      perSkill: {},
      overall,
    };
  }

  const lastIter = iters[iters.length - 1];
  const lastRunId = lastIter.runId;
  const lastSummary = summaries.filter(s => s.runId === lastRunId).pop();
  const termination = lastSummary?.termination ?? lastIter.termination ?? null;

  return { ...buildSummary(records, { runId: lastRunId, termination }), overall };
}

/**
 * Best-effort manual termination (SIGINT path): write a summary with
 * termination 'manual' from whatever iterations were already recorded.
 * @param {Array<object>} records
 * @param {{ runId?: string, iterationsPath?: string }} [options]
 * @returns {object} the summary record
 */
function finalizeManual(records, options = {}) {
  const iters = (records || []).filter(r => r && r.type === 'iteration');
  const runId = options.runId ?? (iters.length ? iters[iters.length - 1].runId : null);
  const summary = buildSummary(records, { runId, termination: 'manual' });
  try {
    appendRecord(summary, options.iterationsPath || defaultIterationsPath());
  } catch {
    // best-effort: never throw on the interrupt path
  }
  return summary;
}

// ── Default deps (wired to the real modules) ────────────────────────

function atomicWriteJson(obj, targetPath) {
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = targetPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, targetPath);
}

const DEFAULT_DEPS = {
  /** Per-iteration score snapshot (shape compatible with evolution.mjs baseline). */
  baseline: (globalJsonPath) => {
    const { results, summary } = scoreAll(globalJsonPath, { threshold: 0 });
    if (summary.error) throw new Error(summary.error);
    return {
      averageScore: summary.averageScore,
      skills: results.map(r => ({ id: r.id, score: r.score, dimensions: r.dimensions, flags: r.flags })),
    };
  },

  /**
   * Scalar progress metric 0-100. Integration point for issue #35: the
   * validation harness can replace this dep with a pass-rate metric; the loop
   * only requires a number here.
   */
  measure: (globalJsonPath, baseline) => {
    if (baseline && typeof baseline.averageScore === 'number') return baseline.averageScore;
    const { summary } = scoreAll(globalJsonPath, { threshold: 0 });
    if (summary.error) throw new Error(summary.error);
    return summary.averageScore;
  },

  readIndex: (globalJsonPath) => JSON.parse(fs.readFileSync(globalJsonPath, 'utf-8')),
  analyze: (index, baseline) => analyzeMutations(index, baseline),
  propose: (index, baseline, opportunities) => generateProposals(index, baseline, opportunities),
  gate: (proposals, baseline) => paretoFilter(proposals, baseline),

  snapshot: (globalJsonPath, comment, options = {}) => {
    const content = fs.readFileSync(globalJsonPath, 'utf-8');
    const handle = takeSnapshot({ globalJsonPath, comment, historyPath: options.historyPath });
    return { ...handle, content };
  },
  restore: (handle, globalJsonPath) => {
    if (!handle || !handle.content) return false;
    fs.writeFileSync(globalJsonPath, handle.content, 'utf-8');
    return true;
  },

  apply: (proposal, index) => applyMutation(proposal, index),
  writeIndex: (index, globalJsonPath) => atomicWriteJson(index, globalJsonPath),
  writeProposals: (kept, proposalsPath) => writeProposals(kept, proposalsPath),
  record: (rec, iterationsPath) => appendRecord(rec, iterationsPath),
};

// ── Loop controller ─────────────────────────────────────────────────

/**
 * Run the K-iteration evolution loop.
 *
 * @param {object} options
 * @param {number} [options.iterations=5]
 * @param {number} [options.ceiling=100]
 * @param {boolean} [options.stopAtCeiling=true]
 * @param {number} [options.noProgressStop=2]
 * @param {boolean} [options.write=false] — dry-run is the default
 * @param {string} [options.globalJson]
 * @param {string} [options.proposalsPath]
 * @param {string} [options.iterationsPath]
 * @param {Array<object>} [options.records] — shared array the loop appends into
 *   (used by the SIGINT path so finalizeManual sees the recorded iterations)
 * @param {boolean} [options.quiet]
 * @param {object} [deps] — overrides for DEFAULT_DEPS (testability)
 * @returns {Promise<{ runId, records, summary, termination }>}
 */
async function runEvolutionLoop(options = {}, deps = {}) {
  const globalJson = options.globalJson || defaultGlobalJson();
  const iterations = Math.max(1, Number(options.iterations ?? DEFAULT_ITERATIONS));
  const ceiling = Number(options.ceiling ?? DEFAULT_CEILING);
  const stopAtCeiling = options.stopAtCeiling !== false;
  const noProgressStop = Math.max(1, Number(options.noProgressStop ?? DEFAULT_NO_PROGRESS_STOP));
  const write = !!options.write;
  const proposalsPath = options.proposalsPath || defaultProposalsPath();
  const iterationsPath = options.iterationsPath || defaultIterationsPath();
  const runId = options.runId || newRunId();

  const d = { ...DEFAULT_DEPS, ...deps };
  const records = Array.isArray(options.records) ? options.records : [];
  const emit = (rec) => { records.push(rec); d.record(rec, iterationsPath); return rec; };
  const say = (msg) => { if (!options.quiet) console.log(msg); };

  say(`═══ Evolution loop (issue #36) — run ${runId} ═══`);
  say(`  iterations=${iterations} ceiling=${ceiling} no-progress-stop=${noProgressStop} mode=${write ? 'write' : 'dry-run'}`);

  let noProgress = 0;
  let termination = null;

  for (let k = 1; k <= iterations; k++) {
    // 1. measure → analyze → propose → gate
    const baseline = d.baseline(globalJson);
    const scoreBefore = d.measure(globalJson, baseline);
    const index = d.readIndex(globalJson);
    const opportunities = d.analyze(index, baseline);
    const proposals = d.propose(index, baseline, opportunities);
    const { kept, discarded } = d.gate(proposals, baseline);

    const skillIds = [...new Set(proposals.flatMap(p => p.skillIds || []))];
    const estimatedDelta = kept.length
      ? round2(kept.reduce((s, p) => s + (p.scoreDelta?.overall ?? 0), 0) / kept.length)
      : 0;

    // 2. apply (write mode only) — snapshot, mutate, re-measure, rollback on regression
    let accepted = 0;
    let applied = 0;
    let scoreAfter = null;
    let rejected = null;
    let rolledBack = false;

    if (write && kept.length > 0) {
      const handle = d.snapshot(globalJson, `evolve-loop:${runId}:${k}`, options);
      d.writeProposals(kept, proposalsPath);

      let mutated = index;
      for (const p of kept) {
        const next = d.apply(p, mutated);
        if (next) mutated = next;
      }
      d.writeIndex(mutated, globalJson);
      applied = kept.length;

      const afterBaseline = d.baseline(globalJson);
      scoreAfter = d.measure(globalJson, afterBaseline);

      if (scoreAfter < scoreBefore) {
        d.restore(handle, globalJson);
        applied = 0;
        rejected = 'regression';
        rolledBack = true;
      } else {
        accepted = kept.length;
      }
    } else {
      // dry-run: gate acceptance is recorded, but nothing is applied
      accepted = kept.length;
    }

    // 3. iteration record
    const improved = scoreAfter != null ? scoreAfter > scoreBefore : estimatedDelta > 0;
    const rec = {
      ts: new Date().toISOString(),
      type: 'iteration',
      runId,
      iteration: k,
      mode: write ? 'write' : 'dry-run',
      proposalsAttempted: proposals.length,
      proposalsKept: kept.length,
      applied,
      accepted,
      scoreBefore,
      scoreAfter,
      estimatedDelta,
      skillIds,
      stage: stageOf(k),
      termination: null,
      rejected,
      rolledBack,
    };

    // 4. stop checks, in order: ceiling → no-progress → max-iterations
    if (stopAtCeiling && (scoreAfter ?? scoreBefore) >= ceiling) {
      rec.termination = 'ceiling';
    } else {
      if (improved) noProgress = 0;
      else noProgress++;
      if (noProgress >= noProgressStop) rec.termination = 'no-progress';
    }
    if (!rec.termination && k === iterations) rec.termination = 'max-iterations';

    emit(rec);
    say(`  iter ${k} [${rec.stage}] ${scoreBefore} → ${scoreAfter ?? 'n/a'} (est ${estimatedDelta}) `
      + `kept=${kept.length} accepted=${rec.accepted} discarded=${discarded.length}`
      + (rec.termination ? `  stop=${rec.termination}` : ''));

    if (rec.termination) {
      termination = rec.termination;
      break;
    }
  }

  // 5. summary record for the run
  const summary = buildSummary(records, { runId, termination });
  emit(summary);
  say(`\n  run ${runId}: ${summary.iterationsRun} iteration(s), acceptance ${summary.acceptanceRate}, `
    + `avg delta ${summary.avgDelta}, termination ${summary.termination}`);

  return { runId, records, summary, termination };
}

// ── Read-only view (used by MCP tool + dashboard endpoint) ──────────

function printSummary(summary) {
  const o = summary.overall || {};
  console.log(`Evolution loop summary (issue #36)`);
  console.log(`  runs: ${o.runs ?? 0}`);
  console.log(`  last run: ${summary.runId || '(none)'}`);
  console.log(`  iterations run (last run): ${summary.iterationsRun}`);
  console.log(`  acceptance rate: last run ${summary.acceptanceRate}, overall ${o.acceptanceRate}`);
  console.log(`  applied (last run): ${summary.applied}`);
  console.log(`  termination: ${summary.termination || '(none)'}`);
  if (o.terminationCounts && Object.keys(o.terminationCounts).length) {
    console.log(`  termination reasons: ${Object.entries(o.terminationCounts).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
  console.log(`  avg delta: last run ${summary.avgDelta}, overall ${o.avgScoreDelta}`);
  const st = summary.stageStats || { early: 0, mid: 0, late: 0 };
  console.log(`  stage stats: early=${st.early} mid=${st.mid} late=${st.late}`);
  const per = summary.perSkill || {};
  const ids = Object.keys(per);
  if (ids.length) {
    console.log('  per skill:');
    for (const id of ids) console.log(`    ${id}: attempted=${per[id].attempted} accepted=${per[id].accepted}`);
  }
}

// ── CLI ─────────────────────────────────────────────────────────────

function parseLoopArgs(args) {
  const options = { asJson: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--iterations' && i + 1 < args.length) options.iterations = parseInt(args[++i], 10);
    else if (args[i] === '--ceiling' && i + 1 < args.length) options.ceiling = parseInt(args[++i], 10);
    else if (args[i] === '--no-progress-stop' && i + 1 < args.length) options.noProgressStop = parseInt(args[++i], 10);
    else if (args[i] === '--global-json' && i + 1 < args.length) options.globalJson = path.resolve(args[++i]);
    else if (args[i] === '--iterations-path' && i + 1 < args.length) options.iterationsPath = path.resolve(args[++i]);
    else if (args[i] === '--proposals-path' && i + 1 < args.length) options.proposalsPath = path.resolve(args[++i]);
    else if (args[i] === '--write') options.write = true;
    else if (args[i] === '--json') options.asJson = true;
  }
  return options;
}

async function cmdLoop(args) {
  const sub = args[0] && !args[0].startsWith('--') ? args[0] : 'run';
  const options = parseLoopArgs(sub === 'run' ? args.slice(1) : args);

  if (sub === 'status') {
    const path_ = options.iterationsPath || defaultIterationsPath();
    const summary = summarizeIterations(readIterations(path_));
    if (options.asJson) console.log(JSON.stringify(summary, null, 2));
    else printSummary(summary);
    return summary;
  }

  if (sub !== 'run') {
    console.error(`evolve loop: unknown subcommand "${sub}" (expected: run|status)`);
    process.exit(1);
  }

  const records = [];
  options.records = records;

  // SIGINT during a run: best-effort manual summary, exit 130.
  let finalized = false;
  process.on('SIGINT', () => {
    if (finalized) return;
    finalized = true;
    console.log('\n✗ interrupted — writing manual summary');
    finalizeManual(records, { iterationsPath: options.iterationsPath || defaultIterationsPath() });
    process.exit(130);
  });

  const result = await runEvolutionLoop(options);
  if (options.asJson) {
    console.log(JSON.stringify({ runId: result.runId, summary: result.summary, records: result.records }, null, 2));
  }
  return result;
}

function usage() {
  return `meta-skills evolve loop — multi-iteration evolution loop (issue #36)

Usage:
  meta-skills evolve loop run [--iterations 5] [--ceiling 100] [--no-progress-stop 2] [--write] [--json]
  meta-skills evolve loop status [--json]

Options:
  --iterations <K>          Iterations per run (default 5)
  --ceiling <N>             Stop early when the metric reaches N (default 100)
  --no-progress-stop <N>    Stop after N iterations without improvement (default 2)
  --write                   Apply accepted mutations + rollback on regression (dry-run is default)
  --global-json <path>      Custom global.json path
  --iterations-path <path>  Custom iterations JSONL (default ~/.meta-skills/evolve/iterations.jsonl)
  --proposals-path <path>   Custom proposals JSONL
  --json                    Machine-readable output`;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(usage());
    process.exit(0);
  }
  cmdLoop(args).catch((e) => {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  });
}

const isMain = process.argv[1] && (
  process.argv[1] === fileURLToPath(import.meta.url)
  || process.argv[1].endsWith('evolution-loop.mjs')
);
if (isMain) main();

export {
  runEvolutionLoop,
  readIterations,
  summarizeIterations,
  finalizeManual,
  buildSummary,
  appendRecord,
  stageOf,
  cmdLoop,
  defaultIterationsPath,
  defaultGlobalJson,
  DEFAULT_DEPS,
};
