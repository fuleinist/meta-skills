#!/usr/bin/env node

/**
 * meta-skills v0.2.2 - Cross-workspace skill diff & migration
 *
 * Compare two skill directories and plan/apply an additive migration.
 * A folder counts as a skill iff it contains SKILL.md. Skill identity is
 * the folder name; equality is sha256(SKILL.md content).
 *
 * Zero dependencies. Offline, deterministic, additive-only (never deletes).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** sha256 hex of a string. */
export function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Scan a directory for skills.
 * @param {string} dir directory to scan
 * @returns {Map<string, {dir: string, hash: string}>} skill name -> metadata
 * @throws if dir does not exist
 */
export function listSkills(dir) {
  const resolved = path.resolve(dir);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Skills directory not found: ${resolved}`);
  }
  const out = new Map();
  const entries = fs.readdirSync(resolved, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = path.join(resolved, entry.name);
    const skillMd = path.join(skillDir, 'SKILL.md');
    if (!fs.existsSync(skillMd)) continue; // not a skill
    const hash = sha256(fs.readFileSync(skillMd, 'utf8'));
    out.set(entry.name, { dir: skillDir, hash });
  }
  return out;
}

/**
 * Diff two skill directories.
 * @param {string} dirA source-of-truth directory
 * @param {string} dirB target directory
 * @returns {{onlyA: string[], onlyB: string[], changed: string[], identical: string[]}}
 */
export function diffSkills(dirA, dirB) {
  const a = listSkills(dirA);
  const b = listSkills(dirB);
  const onlyA = [];
  const onlyB = [];
  const changed = [];
  const identical = [];
  for (const [name, metaA] of a) {
    const metaB = b.get(name);
    if (!metaB) onlyA.push(name);
    else if (metaA.hash !== metaB.hash) changed.push(name);
    else identical.push(name);
  }
  for (const name of b.keys()) {
    if (!a.has(name)) onlyB.push(name);
  }
  onlyA.sort();
  onlyB.sort();
  changed.sort();
  identical.sort();
  return { onlyA, onlyB, changed, identical };
}

/**
 * Build an additive migration plan: what must be copied from `from` to `to`
 * so that `to` has everything `from` has, at the same content.
 * Never plans deletions.
 * @param {{onlyA: string[], changed: string[]}} diff
 * @param {{from: string, to: string}} dirs
 * @returns {Array<{type: 'copy'|'update', skill: string, from: string, to: string}>}
 */
export function migrationPlan(diff, { from, to }) {
  const actions = [];
  for (const name of diff.onlyA) {
    actions.push({
      type: 'copy',
      skill: name,
      from: path.join(path.resolve(from), name),
      to: path.join(path.resolve(to), name),
    });
  }
  for (const name of diff.changed) {
    actions.push({
      type: 'update',
      skill: name,
      from: path.join(path.resolve(from), name),
      to: path.join(path.resolve(to), name),
    });
  }
  actions.sort((x, y) => x.skill.localeCompare(y.skill));
  return actions;
}

/** Recursively copy a directory tree. */
function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

/**
 * Apply a migration plan. Dry-run by default: nothing is written unless
 * `dryRun` is explicitly false.
 * @param {Array<{type: string, skill: string, from: string, to: string}>} plan
 * @param {{dryRun?: boolean}} opts
 * @returns {Array<{type: string, skill: string, from: string, to: string, applied: boolean}>}
 */
export function applyMigration(plan, { dryRun = true } = {}) {
  const results = [];
  for (const action of plan) {
    if (!dryRun) {
      copyDirRecursive(action.from, action.to);
    }
    results.push({ ...action, applied: !dryRun });
  }
  return results;
}
