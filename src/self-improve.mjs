#!/usr/bin/env node

/**
 * meta-skills v0.4 — Self-Improvement Loop
 *
 * Promotes/demotes skills based on usage patterns, archives stale entries,
 * and detects skill co-occurrence for bundle suggestions.
 *
 * Usage: node src/self-improve.mjs [--global-json <path>] [--out <path>] [--dry-run]
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SCHEMA_URL = 'https://meta-skills.dev/schema/v1.json';

// ── Promotion/Demotion thresholds ─────────────────────────────────────
const THRESHOLDS = {
  promoteToHigh: { minUsage: 20, windowDays: 30 },
  demoteToLow: { maxUsage: 3, windowDays: 30 },
  staleDays: 60,
  archiveDays: 90,
};

// ── Helpers ───────────────────────────────────────────────────────────

function daysAgo(dateStr) {
  if (!dateStr) return Infinity;
  const then = new Date(dateStr).getTime();
  const now = Date.now();
  return (now - then) / (1000 * 60 * 60 * 24);
}

function isInWindow(dateStr, windowDays) {
  return daysAgo(dateStr) <= windowDays;
}

// ── Promotion/Demotion ────────────────────────────────────────────────

function applyPromotionDemotion(skills, thresholds) {
  const changes = [];

  for (const skill of skills) {
    const oldPriority = skill.priority;

    // Skip archived skills
    if (oldPriority === 'archived') continue;

    const recent = isInWindow(skill.last_used, thresholds.promoteToHigh.windowDays);
    const usage = skill.usage_count || 0;

    if (recent && usage >= thresholds.promoteToHigh.minUsage && oldPriority !== 'high') {
      skill.priority = 'high';
      changes.push({ id: skill.id, from: oldPriority, to: 'high', reason: `used ${usage}x in ${thresholds.promoteToHigh.windowDays}d` });
    } else if (recent && usage <= thresholds.demoteToLow.maxUsage && oldPriority !== 'low' && oldPriority !== 'archived') {
      skill.priority = 'low';
      changes.push({ id: skill.id, from: oldPriority, to: 'low', reason: `used only ${usage}x in ${thresholds.demoteToLow.windowDays}d` });
    } else if (oldPriority === 'low' && usage > thresholds.promoteToHigh.minUsage) {
      // Low usage but high count — promote to medium
      skill.priority = 'medium';
      changes.push({ id: skill.id, from: oldPriority, to: 'medium', reason: `recovered usage: ${usage}x` });
    }
  }

  return changes;
}

// ── Stale detection ───────────────────────────────────────────────────

function detectStale(skills, stale, thresholds) {
  const newlyStale = [];
  const remaining = [];

  for (const skill of skills) {
    if (skill.priority === 'archived') {
      remaining.push(skill);
      continue;
    }

    const age = daysAgo(skill.last_used);

    if (age > thresholds.archiveDays) {
      // Archive: move to stale[]
      skill.priority = 'archived';
      skill.archived = new Date().toISOString();
      newlyStale.push(skill);
    } else if (age > thresholds.staleDays) {
      // Flag for review: demote to low
      if (skill.priority !== 'low') {
        skill.priority = 'low';
      }
      remaining.push(skill);
    } else {
      remaining.push(skill);
    }
  }

  // Merge newly stale into existing stale (deduplicate by id)
  const staleMap = new Map();
  for (const s of (stale || [])) staleMap.set(s.id, s);
  for (const s of newlyStale) staleMap.set(s.id, s);

  return { active: remaining, stale: Array.from(staleMap.values()), newlyStale: newlyStale.map(s => s.id) };
}

// ── Co-occurrence detection ───────────────────────────────────────────

function detectCooccurrence(logDir) {
  const pairs = {}; // "skillA|skillB" -> count

  let logFiles;
  try {
    logFiles = fs.readdirSync(logDir).filter(f => f.endsWith('.jsonl'));
  } catch {
    return [];
  }

  for (const logFile of logFiles) {
    const content = fs.readFileSync(path.join(logDir, logFile), 'utf-8');
    const daySkills = new Set();

    for (const line of content.trim().split('\n').filter(Boolean)) {
      try {
        const event = JSON.parse(line);
        daySkills.add(event.skill);
      } catch { /* skip */ }
    }

    const sorted = Array.from(daySkills).sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const key = `${sorted[i]}|${sorted[j]}`;
        pairs[key] = (pairs[key] || 0) + 1;
      }
    }
  }

  // Return top bundles (co-occurred >= 3 days)
  return Object.entries(pairs)
    .filter(([, count]) => count >= 3)
    .sort(([, a], [, b]) => b - a)
    .map(([key, count]) => {
      const [a, b] = key.split('|');
      return { skills: [a, b], cooccurrenceDays: count };
    });
}

// ── Main ──────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  let globalJsonPath = path.join(os.homedir(), '.meta-skills', 'global.json');
  let outPath = null;
  let dryRun = false;
  let logDir = path.join(os.homedir(), '.meta-skills', 'logs');

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--global-json' && i + 1 < args.length) globalJsonPath = path.resolve(args[++i]);
    else if (args[i] === '--out' && i + 1 < args.length) outPath = path.resolve(args[++i]);
    else if (args[i] === '--log-dir' && i + 1 < args.length) logDir = path.resolve(args[++i]);
    else if (args[i] === '--dry-run') dryRun = true;
  }

  if (!outPath) outPath = globalJsonPath;

  // Read index
  let index;
  try {
    index = JSON.parse(fs.readFileSync(globalJsonPath, 'utf-8'));
  } catch {
    console.error(`✗ cannot read ${globalJsonPath}`);
    process.exit(1);
  }

  const thresholds = { ...THRESHOLDS };

  // Phase 1: Promotion/Demotion
  console.log('── Promotion/Demotion ──');
  const promDem = applyPromotionDemotion(index.skills, thresholds);
  if (promDem.length === 0) {
    console.log('  no changes');
  } else {
    for (const c of promDem) {
      console.log(`  ${c.id}: ${c.from} → ${c.to} (${c.reason})`);
    }
  }

  // Phase 2: Stale detection
  console.log('\n── Stale Detection ──');
  const { active, stale, newlyStale } = detectStale(index.skills, index.stale, thresholds);
  if (newlyStale.length === 0) {
    console.log('  no stale skills detected');
  } else {
    for (const id of newlyStale) {
      console.log(`  ${id}: archived (unused >${thresholds.archiveDays}d)`);
    }
  }

  // Phase 3: Co-occurrence
  console.log('\n── Skill Bundles (co-occurrence) ──');
  const bundles = detectCooccurrence(logDir);
  if (bundles.length === 0) {
    console.log('  no bundles detected (need more usage data)');
  } else {
    for (const b of bundles.slice(0, 5)) {
      console.log(`  ${b.skills.join(' + ')} (${b.cooccurrenceDays}d together)`);
    }
  }

  if (dryRun) {
    console.log('\n── DRY RUN — no changes written ──');
    process.exit(0);
  }

  // Write updated index
  index.skills = active;
  index.stale = stale;
  index.generated = new Date().toISOString();
  index.suggested_bundles = bundles.slice(0, 10);

  fs.writeFileSync(outPath, JSON.stringify(index, null, 2) + '\n', 'utf-8');
  console.log(`\n✓ self-improvement applied to ${outPath}`);
  console.log(`  ${active.length} active, ${stale.length} stale, ${bundles.length} bundle suggestions`);
}

main();
