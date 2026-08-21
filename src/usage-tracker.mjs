#!/usr/bin/env node

/**
 * meta-skills v1.1 — Usage Tracking
 *
 * Records skill activations and aggregates usage logs into meta-skills JSON.
 *
 * Commands:
 *   record <skill-id> [--outcome success|failure] [--log-dir <path>]
 *     → Appends a usage event to the daily log
 *
 *   aggregate [--global-json <path>] [--log-dir <path>] [--out <path>]
 *     → Reads daily logs, updates usage_count + last_used in global.json
 *
 *   rotate [--log-dir <path>] [--keep-days 90]
 *     → Removes log files older than keep-days
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveDependencies } from './semver-compat.mjs';
import { warnIfDeprecated } from './deprecation.mjs';

const SCHEMA_URL = 'https://meta-skills.dev/schema/v1.json';

// ── Default paths ─────────────────────────────────────────────────────

function defaultLogDir() {
  const dir = path.join(os.homedir(), '.meta-skills', 'logs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function defaultGlobalJson() {
  return path.join(os.homedir(), '.meta-skills', 'global.json');
}

// ── Record ────────────────────────────────────────────────────────────

function cmdRecord(skillId, options) {
  const logDir = options.logDir || defaultLogDir();
  const outcome = options.outcome || 'success';
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const logFile = path.join(logDir, `${today}.jsonl`);

  const event = {
    skill: skillId,
    timestamp: new Date().toISOString(),
    outcome,
    ...(options.tokens != null ? { tokens: options.tokens } : {}),
  };

  fs.appendFileSync(logFile, JSON.stringify(event) + '\n', 'utf-8');
  console.log(`✓ recorded: ${skillId} (${outcome}) → ${logFile}`);

  // v0.1.7 — warn if skill is deprecated
  try {
    const gjPath = options.globalJson || defaultGlobalJson();
    const index = JSON.parse(fs.readFileSync(gjPath, 'utf-8'));
    const entry = [...(index.skills || []), ...(index.stale || [])].find(s => s && s.id === skillId);
    if (entry) warnIfDeprecated(skillId, entry);
  } catch {
    // non-fatal: record still succeeds without index
  }

  // v0.1.3 — auto-load required sub-skills on activation.
  if (options.noDeps) return;
  let index = null;
  const gjPath = options.globalJson || defaultGlobalJson();
  try {
    index = JSON.parse(fs.readFileSync(gjPath, 'utf-8'));
  } catch {
    // No readable index — record still succeeds (backward compatible).
    return;
  }
  const root = [...(index.skills || []), ...(index.stale || [])]
    .find(s => s && s.id === skillId);
  if (!root || !Array.isArray(root.requires) || root.requires.length === 0) return;

  const { order, missing, cycle } = resolveDependencies(skillId, index);
  if (cycle) {
    console.warn(`⚠ dependency cycle around "${skillId}" (${cycle.join(' → ')}) — auto-load skipped for the cycle`);
  }
  for (const id of missing) {
    console.warn(`⚠ "${skillId}" requires "${id}" but it is not in the index`);
  }
  for (const dep of order) {
    const depEvent = {
      skill: dep,
      timestamp: new Date().toISOString(),
      outcome,
      source: 'dependency',
      parent: skillId,
    };
    fs.appendFileSync(logFile, JSON.stringify(depEvent) + '\n', 'utf-8');
    console.log(`✓ auto-loaded dependency: ${dep}`);
  }
}

// ── Aggregate ─────────────────────────────────────────────────────────

function cmdAggregate(options) {
  const logDir = options.logDir || defaultLogDir();
  const globalJsonPath = options.globalJson || defaultGlobalJson();
  const outPath = options.out || globalJsonPath;

  // Read existing global.json
  let index;
  try {
    index = JSON.parse(fs.readFileSync(globalJsonPath, 'utf-8'));
  } catch {
    console.error(`✗ cannot read ${globalJsonPath} — run global-scanner first`);
    process.exit(1);
  }

  // Scan log files
  const usage = {}; // skillId -> { count, lastTimestamp }
  let logFiles;
  try {
    logFiles = fs.readdirSync(logDir).filter(f => f.endsWith('.jsonl'));
  } catch {
    logFiles = [];
  }

  for (const logFile of logFiles) {
    const content = fs.readFileSync(path.join(logDir, logFile), 'utf-8');
    for (const line of content.trim().split('\n').filter(Boolean)) {
      try {
        const event = JSON.parse(line);
        if (!usage[event.skill]) {
          usage[event.skill] = { count: 0, lastTimestamp: null, tokens: [] };
        }
        usage[event.skill].count++;
        if (!usage[event.skill].lastTimestamp || event.timestamp > usage[event.skill].lastTimestamp) {
          usage[event.skill].lastTimestamp = event.timestamp;
        }
        if (event.tokens != null) {
          usage[event.skill].tokens.push(event.tokens);
        }
      } catch {
        // skip malformed lines
      }
    }
  }

  // Update skills in index
  let updatedCount = 0;
  for (const skill of index.skills) {
    const u = usage[skill.id];
    if (u) {
      skill.usage_count = (skill.usage_count || 0) + u.count;
      if (u.lastTimestamp && (!skill.last_used || u.lastTimestamp > skill.last_used)) {
        skill.last_used = u.lastTimestamp;
      }
      // v0.1.4 — empirical token telemetry
      if (u.tokens && u.tokens.length > 0) {
        const avg = Math.round(u.tokens.reduce((a, b) => a + b, 0) / u.tokens.length);
        if (avg > 0) skill.empirical_tokens = avg;
      }
      updatedCount++;
    }
  }

  // Update stale entries too
  if (index.stale) {
    for (const skill of index.stale) {
      const u = usage[skill.id];
      if (u) {
        skill.usage_count = (skill.usage_count || 0) + u.count;
        if (u.lastTimestamp && (!skill.last_used || u.lastTimestamp > skill.last_used)) {
          skill.last_used = u.lastTimestamp;
        }
        if (u.tokens && u.tokens.length > 0) {
          const avg = Math.round(u.tokens.reduce((a, b) => a + b, 0) / u.tokens.length);
          if (avg > 0) skill.empirical_tokens = avg;
        }
        updatedCount++;
      }
    }
  }

  index.generated = new Date().toISOString();

  fs.writeFileSync(outPath, JSON.stringify(index, null, 2) + '\n', 'utf-8');
  console.log(`✓ aggregated ${Object.keys(usage).length} skills from ${logFiles.length} log files`);
  console.log(`  ${updatedCount} skills updated in ${outPath}`);
}

// ── Rotate ────────────────────────────────────────────────────────────

function cmdRotate(options) {
  const logDir = options.logDir || defaultLogDir();
  const keepDays = options.keepDays || 90;
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;

  let logFiles;
  try {
    logFiles = fs.readdirSync(logDir).filter(f => f.endsWith('.jsonl'));
  } catch {
    console.log('  no log files to rotate');
    return;
  }

  let removed = 0;
  for (const logFile of logFiles) {
    const dateStr = logFile.replace('.jsonl', '');
    const fileDate = new Date(dateStr + 'T00:00:00Z').getTime();
    if (isNaN(fileDate)) continue;
    if (fileDate < cutoff) {
      fs.unlinkSync(path.join(logDir, logFile));
      removed++;
    }
  }

  console.log(`✓ rotated ${removed} log files (kept last ${keepDays} days)`);
}

// ── Main ──────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(`Usage:
  meta-skills record <skill-id> [--outcome success|failure] [--tokens <n>] [--log-dir <path>] [--no-deps]
  meta-skills aggregate [--global-json <path>] [--log-dir <path>] [--out <path>]
  meta-skills rotate [--log-dir <path>] [--keep-days 90]

  v0.1.4 --tokens <n>: Record empirical token count for this activation.
    The average across all recorded tokens becomes the skill's empirical_tokens,
    which the budget optimizer (v1.7) uses instead of the chars/4 heuristic.

  v0.1.3 auto-load: if the skill declares "requires", its transitive
    dependencies are logged as dependency activations in the same file.
    Use --no-deps to skip auto-load.`);
    process.exit(0);
  }

  const command = args[0];
  const options = {};

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--outcome' && i + 1 < args.length) options.outcome = args[++i];
    else if (args[i] === '--tokens' && i + 1 < args.length) options.tokens = parseInt(args[++i], 10);
    else if (args[i] === '--log-dir' && i + 1 < args.length) options.logDir = path.resolve(args[++i]);
    else if (args[i] === '--global-json' && i + 1 < args.length) options.globalJson = path.resolve(args[++i]);
    else if (args[i] === '--no-deps') options.noDeps = true;
    else if (args[i] === '--global-json' && i + 1 < args.length) options.globalJson = path.resolve(args[++i]);
    else if (args[i] === '--out' && i + 1 < args.length) options.out = path.resolve(args[++i]);
    else if (args[i] === '--keep-days' && i + 1 < args.length) options.keepDays = parseInt(args[++i], 10);
    else if (!options.skillId) options.skillId = args[i];
  }

  switch (command) {
    case 'record':
      if (!options.skillId) { console.error('✗ missing skill-id'); process.exit(1); }
      cmdRecord(options.skillId, options);
      break;
    case 'aggregate':
      cmdAggregate(options);
      break;
    case 'rotate':
      cmdRotate(options);
      break;
    default:
      console.error(`✗ unknown command: ${command}`);
      process.exit(1);
  }
}

const isMain = process.argv[1] && (process.argv[1] === fileURLToPath(import.meta.url) || process.argv[1].endsWith('usage-tracker.mjs'));
if (isMain) main();

export { cmdRecord, cmdAggregate, cmdRotate, main };
