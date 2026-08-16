#!/usr/bin/env node

/**
 * meta-skills v0.1.2 — Git-style Rollback Ledger
 *
 * Maintains ~/.meta-skills/history.jsonl — a transaction log tracking
 * prior states of global.json before mutations. Supports restoring to
 * any known-good snapshot.
 *
 * Commands:
 *   snapshot [--global-json <path>] [--comment <text>]
 *     Take a named snapshot of the current index state.
 *
 *   list [--global-json <path>] [--json]
 *     List all recorded snapshots.
 *
 *   rollback <n> [--global-json <path>] [--dry-run]
 *     Restore index to the state N snapshots ago.
 *
 *   prune [--keep <n>] [--older-than <days>] [--global-json <path>]
 *     Remove old snapshots to keep history manageable.
 *
 * Safety net for autonomous evolution (v0.1 + v0.2.0).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Default paths ──────────────────────────────────────────────────────

function defaultHistoryPath() {
  return path.join(os.homedir(), '.meta-skills', 'history.jsonl');
}

function defaultGlobalJson() {
  return path.join(os.homedir(), '.meta-skills', 'global.json');
}

// ── Snapshot format ───────────────────────────────────────────────────

/**
 * Each line in history.jsonl is a JSON object:
 * {
 *   "ts": "<ISO-8601>",
 *   "hash": "<sha256 of index content>",
 *   "comment": "<optional>",
 *   "skills_active": <n>,
 *   "skills_stale": <n>,
 *   "snapshot": <full index JSON as string>
 * }
 */

function hashContent(content) {
  // Simple hash — use Node's crypto for sha256
  try {
    const { createHash } = require('node:crypto');
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
  } catch {
    // Fallback: length-based identifier
    let h = 0;
    for (let i = 0; i < content.length; i++) {
      h = ((h << 5) - h) + content.charCodeAt(i);
      h |= 0;
    }
    return Math.abs(h).toString(16).padStart(8, '0');
  }
}

// ── Snapshot ──────────────────────────────────────────────────────────

/**
 * Take a snapshot of the current global.json state.
 * @param {object} options
 * @param {string} options.globalJsonPath
 * @param {string} [options.comment]
 * @param {string} [options.historyPath]
 * @returns {{ hash, ts, snapshotPath }}
 */
function takeSnapshot(options = {}) {
  const gjPath = options.globalJsonPath || defaultGlobalJson();
  const historyPath = options.historyPath || defaultHistoryPath();

  let content;
  try {
    content = fs.readFileSync(gjPath, 'utf-8');
  } catch {
    throw new Error(`cannot read ${gjPath}`);
  }

  const hash = hashContent(content);
  const ts = new Date().toISOString();
  let index;
  try {
    index = JSON.parse(content);
  } catch {
    throw new Error(`invalid JSON in ${gjPath}`);
  }

  // Read existing history
  let history = [];
  try {
    const lines = fs.readFileSync(historyPath, 'utf-8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try { history.push(JSON.parse(line)); } catch { /* skip corrupt entries */ }
    }
  } catch { /* new file */ }

  const entry = {
    ts,
    hash,
    comment: options.comment || null,
    skills_active: (index.skills || []).length,
    skills_stale: (index.stale || []).length,
    snapshot: content,
  };

  // Append to history
  fs.appendFileSync(historyPath, JSON.stringify(entry) + '\n', 'utf-8');

  // Update rollback metadata in global.json
  try {
    const idx = JSON.parse(content);
    if (!idx.rollback) idx.rollback = {};
    idx.rollback.history_count = history.length + 1;
    idx.rollback.last_snapshot = ts;
    fs.writeFileSync(gjPath, JSON.stringify(idx, null, 2) + '\n', 'utf-8');
  } catch { /* metadata update is best-effort */ }

  console.log(`✓ snapshot taken: ${hash} (${entry.skills_active} active, ${entry.skills_stale} stale)`);
  if (entry.comment) console.log(`  comment: ${entry.comment}`);
  console.log(`  history: ${historyPath}`);

  return { hash, ts, historyPath };
}

// ── List ──────────────────────────────────────────────────────────────

/**
 * List all recorded snapshots.
 * @param {object} options
 * @param {string} [options.globalJsonPath]
 * @param {boolean} [options.asJson]
 * @returns {Array<{ts, hash, comment, skills_active, skills_stale}>}
 */
function listSnapshots(options = {}) {
  const historyPath = defaultHistoryPath();
  let entries = [];

  try {
    const lines = fs.readFileSync(historyPath, 'utf-8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try { entries.push(JSON.parse(line)); } catch { /* skip corrupt */ }
    }
  } catch {
    return [];
  }

  // Sort by timestamp descending (newest first)
  entries.sort((a, b) => b.ts.localeCompare(a.ts));

  const summary = entries.map(e => ({
    ts: e.ts,
    hash: e.hash,
    comment: e.comment,
    skills_active: e.skills_active,
    skills_stale: e.skills_stale,
  }));

  if (options.asJson) {
    console.log(JSON.stringify({ snapshots: summary, total: summary.length }, null, 2));
  } else {
    console.log(`Snapshots (${summary.length} total):\n`);
    for (let i = 0; i < summary.length; i++) {
      const s = summary[i];
      const date = s.ts.slice(0, 16).replace('T', ' ');
      const note = s.comment ? `  #${s.comment}` : '';
      console.log(`  #${i} ${date}  ${s.hash}  active=${s.skills_active} stale=${s.skills_stale}${note}`);
    }
  }

  return summary;
}

// ── Rollback ──────────────────────────────────────────────────────────

/**
 * Restore global.json to a previous snapshot.
 * @param {number} stepsBack — how many snapshots to go back (1 = previous)
 * @param {object} options
 * @param {string} [options.globalJsonPath]
 * @param {string} [options.historyPath]
 * @param {boolean} [options.dryRun]
 */
function rollback(stepsBack, options = {}) {
  const gjPath = options.globalJsonPath || defaultGlobalJson();
  const historyPath = options.historyPath || defaultHistoryPath();
  const dryRun = options.dryRun || false;

  let entries = [];
  try {
    const lines = fs.readFileSync(historyPath, 'utf-8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try { entries.push(JSON.parse(line)); } catch { /* skip corrupt */ }
    }
  } catch {
    throw new Error(`no history found at ${historyPath}`);
  }

  entries.sort((a, b) => b.ts.localeCompare(a.ts));

  const targetIdx = stepsBack;
  if (targetIdx < 0 || targetIdx >= entries.length) {
    throw new Error(`stepsBack=${stepsBack} out of range (0-${entries.length - 1}, got ${entries.length} snapshots)`);
  }

  const target = entries[targetIdx];
  console.log(`Rolling back ${stepsBack} step(s) to snapshot:`);
  console.log(`  hash: ${target.hash}`);
  console.log(`  ts:   ${target.ts}`);
  console.log(`  comment: ${target.comment || '(none)'}`);
  console.log(`  skills: ${target.skills_active} active, ${target.skills_stale} stale`);

  if (dryRun) {
    console.log('\n  (dry-run — no changes written)');
    return { target, dryRun: true };
  }

  // Write the snapshot content back to global.json
  const tmpPath = gjPath + '.tmp';
  fs.writeFileSync(tmpPath, target.snapshot, 'utf-8');
  fs.renameSync(tmpPath, gjPath);

  console.log(`\n✓ rolled back to ${target.hash}`);
  console.log(`  ${gjPath} restored (${target.skills_active} active, ${target.skills_stale} stale)`);

  return { target, dryRun: false };
}

// ── Prune ─────────────────────────────────────────────────────────────

/**
 * Remove old snapshots to keep history manageable.
 * @param {object} options
 * @param {number} [options.keep] — minimum number of snapshots to retain
 * @param {number} [options.olderThanDays] — remove snapshots older than N days
 * @param {string} [options.globalJsonPath]
 */
function pruneSnapshots(options = {}) {
  const historyPath = defaultHistoryPath();
  const keep = options.keep || 10;
  const olderThanDays = options.olderThanDays || 30;
  const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;

  let entries = [];
  try {
    const lines = fs.readFileSync(historyPath, 'utf-8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try { entries.push(JSON.parse(line)); } catch { /* skip corrupt */ }
    }
  } catch {
    console.log('No history to prune.');
    return { removed: 0 };
  }

  entries.sort((a, b) => b.ts.localeCompare(a.ts));

  // Keep the N most recent, plus any within the age window
  const keepSet = new Set();
  for (let i = 0; i < Math.min(keep, entries.length); i++) {
    keepSet.add(i);
  }
  for (let i = 0; i < entries.length; i++) {
    const ts = new Date(entries[i].ts).getTime();
    if (ts >= cutoff) keepSet.add(i);
  }

  if (keepSet.size === entries.length) {
    console.log('Nothing to prune (all snapshots within retention window).');
    return { removed: 0, kept: entries.length };
  }

  // Rebuild history file with only kept entries
  const kept = entries.filter((_, i) => keepSet.has(i));
  kept.sort((a, b) => a.ts.localeCompare(b.ts)); // restore chronological order

  const newContent = kept.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(historyPath, newContent, 'utf-8');

  console.log(`Pruned ${entries.length - kept.length} snapshot(s), ${kept.length} retained.`);
  return { removed: entries.length - kept.length, kept: kept.length };
}

// ── CLI ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const options = {
    stepsBack: 1,
    dryRun: false,
    globalJsonPath: null,
    historyPath: null,
    asJson: false,
    keep: 10,
    olderThanDays: 30,
    comment: null,
  };

  const args = argv.slice(0);
  const command = args[0];

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--global-json' && i + 1 < args.length) {
      options.globalJsonPath = path.resolve(args[++i]);
    } else if (args[i] === '--history-path' && i + 1 < args.length) {
      options.historyPath = path.resolve(args[++i]);
    } else if (args[i] === '--dry-run') {
      options.dryRun = true;
    } else if (args[i] === '--json') {
      options.asJson = true;
    } else if (args[i] === '--keep' && i + 1 < args.length) {
      options.keep = parseInt(args[++i], 10);
    } else if (args[i] === '--older-than' && i + 1 < args.length) {
      options.olderThanDays = parseInt(args[++i], 10);
    } else if (args[i] === '--comment' && i + 1 < args.length) {
      options.comment = args[++i];
    } else if (!options.stepsBackArg && /^\d+$/.test(args[i])) {
      options.stepsBack = parseInt(args[i], 10);
      options.stepsBackArg = true;
    }
  }

  return { command, options };
}

async function cmdRollback(argv) {
  const { command, options } = parseArgs(argv);

  switch (command) {
    case 'snapshot': {
      takeSnapshot({ globalJsonPath: options.globalJsonPath, comment: options.comment });
      break;
    }

    case 'list': {
      listSnapshots({ globalJsonPath: options.globalJsonPath, asJson: options.asJson });
      break;
    }

    case 'rollback': {
      const stepsBack = options.stepsBack;
      rollback(stepsBack, {
        globalJsonPath: options.globalJsonPath,
        historyPath: options.historyPath,
        dryRun: options.dryRun,
      });
      break;
    }

    case 'prune': {
      pruneSnapshots({
        keep: options.keep,
        olderThanDays: options.olderThanDays,
        globalJsonPath: options.globalJsonPath,
      });
      break;
    }

    default: {
      console.log(`Usage:
  meta-skills rollback snapshot [--comment "text"] [--global-json <path>]
  meta-skills rollback list [--json]
  meta-skills rollback <n> [--dry-run] [--global-json <path>]
  meta-skills rollback prune [--keep 10] [--older-than 30]`);
      process.exit(0);
    }
  }
}

// ── Auto-snapshot on mutation ─────────────────────────────────────────

/**
 * Call this after any write to global.json to auto-create a snapshot.
 * Useful for integration with other modules (maintain, improve, budget, etc.)
 */
function autoSnapshot(globalJsonPath = defaultGlobalJson(), comment = null) {
  try {
    takeSnapshot({ globalJsonPath, comment });
  } catch {
    // Non-fatal — snapshot failure should not block the main operation
  }
}

// ── Standalone entry ─────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(`Usage:
  meta-skills rollback snapshot [--comment "text"] [--global-json <path>]
  meta-skills rollback list [--json]
  meta-skills rollback <n> [--dry-run] [--global-json <path>]
  meta-skills rollback prune [--keep 10] [--older-than 30]`);
    process.exit(0);
  }

  try {
    await cmdRollback(args);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
}

const isMain = process.argv[1] && (
  process.argv[1] === fileURLToPath(import.meta.url)
  || process.argv[1].endsWith('rollback-ledger.mjs')
);
if (isMain) main();

export {
  takeSnapshot,
  listSnapshots,
  rollback,
  pruneSnapshots,
  autoSnapshot,
  hashContent,
  defaultHistoryPath,
  defaultGlobalJson,
};
