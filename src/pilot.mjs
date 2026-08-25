#!/usr/bin/env node

/**
 * meta-skills v0.1.9 — Skill A/B testing (pilot)
 *
 * Runs live A/B experiments over two instruction variants of a skill
 * (e.g. SKILL_variant_A.md vs SKILL_variant_B.md) and declares a winner
 * from empirical success/failure outcomes.
 *
 * Offline by design: no network calls, no dependencies. Variant assignment
 * is deterministic (alternating by run count) so experiments replay
 * identically. Statistics use a pooled two-proportion z-test.
 *
 * Storage: ~/.meta-skills/pilots.json (override with --pilots-json).
 *
 * Commands:
 *   pilot start <skill-id> --variant-a <path> --variant-b <path> [--min-runs N]
 *     → Register a pilot. Both variant files must exist. Default min-runs 25.
 *
 *   pilot next <skill-id>
 *     → Print which variant (id + path) to use for the next run.
 *
 *   pilot record <skill-id> --outcome success|failure [--variant A|B]
 *     → Append a run. Without --variant, uses the `next` assignment.
 *
 *   pilot status <skill-id> [--json]
 *     → Per-variant stats, z-score, verdict (running|inconclusive|winner).
 *
 *   pilot conclude <skill-id> [--global-json <path>] [--dry-run]
 *     → If a winner exists, write its summary onto the skill entry in
 *       global.json as skill.pilot = {...}. Dry-run previews only.
 *
 *   pilot stop <skill-id>
 *     → Delete the pilot without concluding.
 *
 *   pilot list
 *     → One-line status for every registered pilot.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEFAULT_MIN_RUNS = 25;
const Z_THRESHOLD = 1.96; // 95% two-sided

// ── Storage ───────────────────────────────────────────────────────────

function defaultPilotsJson() {
  const dir = path.join(os.homedir(), '.meta-skills');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'pilots.json');
}

function loadPilots(pilotsJson) {
  try {
    return JSON.parse(fs.readFileSync(pilotsJson, 'utf-8'));
  } catch {
    return {};
  }
}

function savePilots(pilotsJson, pilots) {
  fs.writeFileSync(pilotsJson, JSON.stringify(pilots, null, 2) + '\n', 'utf-8');
}

// ── Core operations ───────────────────────────────────────────────────

function startPilot(skillId, { variantA, variantB, minRuns = DEFAULT_MIN_RUNS, pilotsJson }) {
  if (!skillId) throw new Error('missing skill-id');
  if (!variantA || !variantB) throw new Error('both --variant-a and --variant-b are required');
  const pathA = path.resolve(variantA);
  const pathB = path.resolve(variantB);
  if (!fs.existsSync(pathA)) throw new Error(`variant A file not found: ${pathA}`);
  if (!fs.existsSync(pathB)) throw new Error(`variant B file not found: ${pathB}`);
  if (minRuns < 1) throw new Error('min-runs must be >= 1');

  const pj = pilotsJson || defaultPilotsJson();
  const pilots = loadPilots(pj);
  if (pilots[skillId]) throw new Error(`pilot already exists for "${skillId}" (stop it first)`);

  pilots[skillId] = {
    created: new Date().toISOString(),
    min_runs: minRuns,
    variants: [
      { id: 'A', path: pathA },
      { id: 'B', path: pathB },
    ],
    runs: [],
  };
  savePilots(pj, pilots);
  return pilots[skillId];
}

/**
 * Deterministic alternating assignment: with no recorded runs → variant A,
 * then B, then A, ... Replays identically for a given run history.
 */
function assignVariant(pilot) {
  const idx = (pilot.runs || []).length % pilot.variants.length;
  return pilot.variants[idx];
}

function recordRun(skillId, { outcome, variant, pilotsJson }) {
  if (!outcome || !['success', 'failure'].includes(outcome)) {
    throw new Error('outcome must be success|failure');
  }
  const pj = pilotsJson || defaultPilotsJson();
  const pilots = loadPilots(pj);
  const pilot = pilots[skillId];
  if (!pilot) throw new Error(`no pilot for "${skillId}" — run pilot start first`);

  let assigned;
  if (variant) {
    assigned = pilot.variants.find(v => v.id === variant);
    if (!assigned) throw new Error(`unknown variant "${variant}" (expected ${pilot.variants.map(v => v.id).join('|')})`);
  } else {
    assigned = assignVariant(pilot);
  }

  const run = { variant: assigned.id, outcome, timestamp: new Date().toISOString() };
  pilot.runs.push(run);
  savePilots(pj, pilots);
  return run;
}

/**
 * Pooled two-proportion z-test over per-variant success rates.
 * Verdict: running (min_runs not met) | inconclusive | winner.
 */
function analyzePilot(pilot) {
  const stats = {};
  for (const v of pilot.variants) stats[v.id] = { runs: 0, successes: 0, rate: 0 };
  for (const r of pilot.runs || []) {
    if (!stats[r.variant]) continue;
    stats[r.variant].runs++;
    if (r.outcome === 'success') stats[r.variant].successes++;
  }
  for (const id of Object.keys(stats)) {
    const s = stats[id];
    s.rate = s.runs > 0 ? s.successes / s.runs : 0;
  }

  const [aId, bId] = pilot.variants.map(v => v.id);
  const a = stats[aId];
  const b = stats[bId];

  let z = 0;
  if (a.runs > 0 && b.runs > 0) {
    const pPool = (a.successes + b.successes) / (a.runs + b.runs);
    if (pPool > 0 && pPool < 1) {
      const se = Math.sqrt(pPool * (1 - pPool) * (1 / a.runs + 1 / b.runs));
      z = (a.rate - b.rate) / se;
    }
  }

  const minRuns = pilot.min_runs || DEFAULT_MIN_RUNS;
  const sufficient = a.runs >= minRuns && b.runs >= minRuns;
  const significant = sufficient && Math.abs(z) >= Z_THRESHOLD;

  let verdict = 'running';
  let winner = null;
  if (sufficient) {
    if (significant) {
      verdict = 'winner';
      winner = z > 0 ? aId : bId;
    } else {
      verdict = 'inconclusive';
    }
  }

  return { stats, z, verdict, winner, uplift: a.rate - b.rate, sufficient, min_runs: minRuns };
}

function concludePilot(skillId, { globalJson, dryRun = false, pilotsJson } = {}) {
  const pj = pilotsJson || defaultPilotsJson();
  const pilots = loadPilots(pj);
  const pilot = pilots[skillId];
  if (!pilot) throw new Error(`no pilot for "${skillId}"`);

  const analysis = analyzePilot(pilot);
  if (analysis.verdict !== 'winner') {
    return { concluded: false, analysis };
  }

  const winnerVariant = pilot.variants.find(v => v.id === analysis.winner);
  const summary = {
    winner: analysis.winner,
    winner_path: winnerVariant ? winnerVariant.path : null,
    rates: Object.fromEntries(Object.entries(analysis.stats).map(([id, s]) => [id, s.rate])),
    uplift: analysis.uplift,
    z: analysis.z,
    runs: pilot.runs.length,
    concluded: new Date().toISOString(),
  };

  const gjPath = globalJson || path.join(os.homedir(), '.meta-skills', 'global.json');
  let index = null;
  try {
    index = JSON.parse(fs.readFileSync(gjPath, 'utf-8'));
  } catch {
    throw new Error(`cannot read ${gjPath} — run init --global first`);
  }
  const entry = [...(index.skills || []), ...(index.stale || [])].find(s => s && s.id === skillId);
  if (!entry) throw new Error(`skill "${skillId}" not found in ${gjPath}`);

  entry.pilot = summary;
  if (!dryRun) {
    fs.writeFileSync(gjPath, JSON.stringify(index, null, 2) + '\n', 'utf-8');
  }
  return { concluded: true, analysis, summary, dryRun };
}

function stopPilot(skillId, { pilotsJson } = {}) {
  const pj = pilotsJson || defaultPilotsJson();
  const pilots = loadPilots(pj);
  if (!pilots[skillId]) throw new Error(`no pilot for "${skillId}"`);
  delete pilots[skillId];
  savePilots(pj, pilots);
  return true;
}

function listPilots({ pilotsJson } = {}) {
  const pj = pilotsJson || defaultPilotsJson();
  const pilots = loadPilots(pj);
  return Object.entries(pilots).map(([skillId, pilot]) => {
    const analysis = analyzePilot(pilot);
    return { skill: skillId, runs: pilot.runs.length, verdict: analysis.verdict, winner: analysis.winner };
  });
}

// ── CLI commands ──────────────────────────────────────────────────────

function cmdPilot(args) {
  const sub = args[0];
  if (!sub) {
    console.log(`Usage:
  meta-skills pilot start <skill-id> --variant-a <path> --variant-b <path> [--min-runs N]
  meta-skills pilot next <skill-id> [--pilots-json <path>]
  meta-skills pilot record <skill-id> --outcome success|failure [--variant A|B]
  meta-skills pilot status <skill-id> [--json]
  meta-skills pilot conclude <skill-id> [--global-json <path>] [--dry-run]
  meta-skills pilot stop <skill-id>
  meta-skills pilot list

v0.1.9 — A/B test two skill instruction variants against live outcomes.
Assignment alternates deterministically; winner needs min-runs per variant
(default ${DEFAULT_MIN_RUNS}) and |z| >= ${Z_THRESHOLD} (pooled two-proportion test).`);
    return;
  }

  const options = {};
  const positional = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--variant-a' && i + 1 < args.length) options.variantA = args[++i];
    else if (args[i] === '--variant-b' && i + 1 < args.length) options.variantB = args[++i];
    else if (args[i] === '--min-runs' && i + 1 < args.length) options.minRuns = parseInt(args[++i], 10);
    else if (args[i] === '--outcome' && i + 1 < args.length) options.outcome = args[++i];
    else if (args[i] === '--variant' && i + 1 < args.length) options.variant = args[++i];
    else if (args[i] === '--pilots-json' && i + 1 < args.length) options.pilotsJson = path.resolve(args[++i]);
    else if (args[i] === '--global-json' && i + 1 < args.length) options.globalJson = path.resolve(args[++i]);
    else if (args[i] === '--json') options.json = true;
    else if (args[i] === '--dry-run') options.dryRun = true;
    else positional.push(args[i]);
  }
  const skillId = positional[0];

  switch (sub) {
    case 'start': {
      const pilot = startPilot(skillId, options);
      console.log(`✓ pilot started for "${skillId}"`);
      for (const v of pilot.variants) console.log(`  variant ${v.id}: ${v.path}`);
      console.log(`  min-runs per variant: ${pilot.min_runs}`);
      break;
    }
    case 'next': {
      const pilots = loadPilots(options.pilotsJson || defaultPilotsJson());
      const pilot = pilots[skillId];
      if (!pilot) { console.error(`✗ no pilot for "${skillId}"`); process.exit(1); }
      const v = assignVariant(pilot);
      console.log(`use variant ${v.id}: ${v.path}`);
      break;
    }
    case 'record': {
      const run = recordRun(skillId, options);
      console.log(`✓ recorded: ${skillId} variant ${run.variant} (${run.outcome})`);
      break;
    }
    case 'status': {
      const pilots = loadPilots(options.pilotsJson || defaultPilotsJson());
      const pilot = pilots[skillId];
      if (!pilot) { console.error(`✗ no pilot for "${skillId}"`); process.exit(1); }
      const analysis = analyzePilot(pilot);
      if (options.json) {
        console.log(JSON.stringify({ skill: skillId, ...analysis }, null, 2));
        break;
      }
      console.log(`pilot: ${skillId} (${pilot.runs.length} runs, min ${analysis.min_runs}/variant)`);
      for (const v of pilot.variants) {
        const s = analysis.stats[v.id];
        console.log(`  ${v.id}: ${s.runs} runs, ${(s.rate * 100).toFixed(1)}% success — ${v.path}`);
      }
      console.log(`  z = ${analysis.z.toFixed(3)} (|z| >= ${Z_THRESHOLD} to win)`);
      if (analysis.verdict === 'winner') console.log(`  verdict: WINNER ${analysis.winner} (uplift ${(analysis.uplift * 100).toFixed(1)}pp)`);
      else if (analysis.verdict === 'inconclusive') console.log('  verdict: inconclusive');
      else console.log('  verdict: still running');
      break;
    }
    case 'conclude': {
      const result = concludePilot(skillId, options);
      if (!result.concluded) {
        console.log(`✗ no winner yet (verdict: ${result.analysis.verdict}) — keep recording runs`);
        process.exit(1);
      }
      const prefix = result.dryRun ? '[dry-run] would write' : '✓ wrote';
      console.log(`${prefix} pilot summary for "${skillId}": winner ${result.summary.winner} (z = ${result.summary.z.toFixed(3)}, ${result.summary.runs} runs)`);
      break;
    }
    case 'stop': {
      stopPilot(skillId, options);
      console.log(`✓ pilot stopped for "${skillId}"`);
      break;
    }
    case 'list': {
      const rows = listPilots(options);
      if (rows.length === 0) { console.log('no active pilots'); break; }
      for (const r of rows) {
        const win = r.winner ? ` → winner ${r.winner}` : '';
        console.log(`  ${r.skill}: ${r.runs} runs, ${r.verdict}${win}`);
      }
      break;
    }
    default:
      console.error(`✗ unknown pilot subcommand: ${sub}`);
      process.exit(1);
  }
}

const isMain = process.argv[1] && process.argv[1].endsWith('pilot.mjs');
if (isMain) {
  try {
    cmdPilot(process.argv.slice(2));
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
}

export {
  DEFAULT_MIN_RUNS,
  Z_THRESHOLD,
  defaultPilotsJson,
  loadPilots,
  savePilots,
  startPilot,
  assignVariant,
  recordRun,
  analyzePilot,
  concludePilot,
  stopPilot,
  listPilots,
  cmdPilot,
};
