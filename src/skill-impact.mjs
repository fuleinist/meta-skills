#!/usr/bin/env node

/**
 * meta-skills v0.2.5 — Skill-impact audit trail (issue #34)
 *
 * Every proposal outcome is recorded as one JSONL line so that history
 * survives rejection. The evolution engine reads this trail back before
 * generating proposals and never re-suggests a target+direction that was
 * already rejected by a human.
 *
 * Entry shape:
 *   { ts, proposalId, type, skills: [..], outcome: 'accepted'|'rejected', reason? }
 *
 * The log lives next to the proposal store it audits — `<dir>/skill-impact.jsonl`
 * — so tests stay hermetic and each store carries its own memory.
 *
 * Commands:
 *   skill-impact list [--store <dir-or-file>] [--json]
 *     Show the recorded outcomes.
 *
 * Zero new npm deps — Node stdlib only.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const LOG_BASENAME = 'skill-impact.jsonl';

// ── Default paths ──────────────────────────────────────────────

function defaultStoreDir() {
  return path.join(os.homedir(), '.meta-skills', 'evolve');
}

/**
 * Derive the audit-log path from a proposals directory or a proposals file.
 * Files are reduced to their parent directory; directories are used as-is.
 * @param {string} [storeDirOrFile]
 * @returns {string} `<dir>/skill-impact.jsonl`
 */
function impactLogPath(storeDirOrFile) {
  const target = storeDirOrFile || defaultStoreDir();
  let isFile;
  try {
    isFile = fs.statSync(target).isFile();
  } catch {
    // Not on disk yet — fall back to the extension heuristic.
    isFile = Boolean(path.extname(target));
  }
  const dir = isFile ? path.dirname(target) : target;
  return path.join(dir, LOG_BASENAME);
}

/**
 * Canonical read-back key: `type|target`, where target is a skill id or the
 * skill ids joined with '+' for a merge. Same shape the proposal constructor
 * uses, so both pipelines agree.
 * @param {string} type
 * @param {string|string[]} target
 * @returns {string}
 */
function impactKey(type, target) {
  const t = Array.isArray(target) ? target.join('+') : String(target);
  return `${type}|${t}`;
}

// ── Append ─────────────────────────────────────────────────────

/**
 * Append one outcome to the audit trail.
 * @param {object} entry — { ts?, proposalId, type, skills, outcome, reason? }
 * @param {string} [logPath]
 * @returns {object} the stored entry (with `ts` filled in)
 */
function appendImpact(entry, logPath) {
  if (!entry || typeof entry !== 'object') {
    throw new Error('appendImpact: entry required');
  }
  const file = logPath || impactLogPath(null);
  const stored = { ...entry };
  if (!stored.ts) stored.ts = new Date().toISOString();

  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  fs.appendFileSync(file, JSON.stringify(stored) + '\n', 'utf-8');
  return stored;
}

// ── Read ───────────────────────────────────────────────────────

/**
 * Parse the whole audit trail. Corrupt lines are skipped; a missing file
 * reads as an empty trail.
 * @param {string} [logPath]
 * @returns {Array<object>} entries in write order
 */
function readImpact(logPath) {
  const file = logPath || impactLogPath(null);
  let content;
  try {
    content = fs.readFileSync(file, 'utf-8');
  } catch {
    return [];
  }

  const entries = [];
  for (const line of content.trim().split('\n').filter(Boolean)) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') entries.push(parsed);
    } catch {
      // skip corrupt entries — the trail must stay readable
    }
  }
  return entries;
}

/**
 * Rejected keys from the trail alone (the caller merges these with the
 * rejected proposals already in the store).
 * @param {string} [logPath]
 * @returns {Set<string>}
 */
function rejectedKeysFromLog(logPath) {
  const keys = new Set();
  for (const e of readImpact(logPath)) {
    if (e.outcome === 'rejected') keys.add(impactKey(e.type, e.skills));
  }
  return keys;
}

// ── CLI ────────────────────────────────────────────────────────

async function cmdSkillImpact(args) {
  const sub = args[0];
  let store = null;
  let asJson = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--store' && i + 1 < args.length) store = path.resolve(args[++i]);
    else if (args[i] === '--json') asJson = true;
  }

  const logPath = impactLogPath(store);
  const entries = readImpact(logPath);

  if (sub && sub !== 'list') {
    throw new Error(`skill-impact: unknown subcommand (expected: list) — ${sub}`);
  }

  if (asJson) {
    console.log(JSON.stringify({ logPath, total: entries.length, entries }, null, 2));
    return entries;
  }

  if (entries.length === 0) {
    console.log(`  No recorded outcomes (${logPath}).`);
    return entries;
  }

  console.log(`  Skill-impact trail (${entries.length} entries): ${logPath}\n`);
  for (const e of entries) {
    const ts = (e.ts || '').slice(0, 16).replace('T', ' ');
    const skills = Array.isArray(e.skills) ? e.skills.join(', ') : String(e.skills || '');
    const icon = e.outcome === 'accepted' ? '✓' : '✗';
    console.log(`  ${icon} ${ts}  ${e.type}  ${skills}  ${e.outcome}`);
    if (e.reason) console.log(`      ${e.reason}`);
  }
  return entries;
}

// ── Standalone entry ───────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(`Usage:
  meta-skills skill-impact list [--store <dir-or-file>] [--json]`);
    process.exit(0);
  }

  try {
    await cmdSkillImpact(args);
  } catch (e) {
    console.error(`  ! ${e.message}`);
    process.exit(1);
  }
}

const isMain = process.argv[1] && (
  process.argv[1] === fileURLToPath(import.meta.url)
  || process.argv[1].endsWith('skill-impact.mjs')
);
if (isMain) main();

export {
  LOG_BASENAME,
  defaultStoreDir,
  impactLogPath,
  impactKey,
  appendImpact,
  readImpact,
  rejectedKeysFromLog,
  cmdSkillImpact,
};
