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
  };

  fs.appendFileSync(logFile, JSON.stringify(event) + '\n', 'utf-8');
  console.log(`✓ recorded: ${skillId} (${outcome}) → ${logFile}`);
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
          usage[event.skill] = { count: 0, lastTimestamp: null };
        }
        usage[event.skill].count++;
        if (!usage[event.skill].lastTimestamp || event.timestamp > usage[event.skill].lastTimestamp) {
          usage[event.skill].lastTimestamp = event.timestamp;
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
  meta-skills record <skill-id> [--outcome success|failure] [--log-dir <path>]
  meta-skills aggregate [--global-json <path>] [--log-dir <path>] [--out <path>]
  meta-skills rotate [--log-dir <path>] [--keep-days 90]`);
    process.exit(0);
  }

  const command = args[0];
  const options = {};

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--outcome' && i + 1 < args.length) options.outcome = args[++i];
    else if (args[i] === '--log-dir' && i + 1 < args.length) options.logDir = path.resolve(args[++i]);
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
