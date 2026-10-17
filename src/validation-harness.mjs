#!/usr/bin/env node

/**
 * meta-skills v0.2.5 — Validation Harness (issue #35)
 *
 * Held-out task suites that gate skill changes under a STRICT acceptance rule:
 * a candidate SKILL.md is accepted only when its aggregate suite score
 * strictly exceeds the recorded baseline. Equal or worse ⇒ reject. No neutral
 * accept, no regression — `force` is the only escape hatch.
 *
 * Files (under ~/.meta-skills/validation/):
 *   suites/<skill-id>.json     curated held-out cases
 *   baselines/<skill-id>.json  last accepted aggregate + per-case scores
 *
 * Commands:
 *   validation run <suitePath> --skill <skillMdPath> [--json] [--validation-dir <dir>]
 *   validation baseline <suitePath> --skill <skillMdPath> [--update] [--json]
 *
 * Guarantees: offline, deterministic, stdlib-only. No network, no LLM calls,
 * no arbitrary command execution — file reads only.
 *
 * Inspired by:
 *   - EvoSkill Pareto-filtered validation (issue #35 strict variant)
 *   - selfheal micro-test suites (v0.2.0) — scoring reused, not modified
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DEFAULT_THRESHOLD, scoreSkillAgainstCase } from './selfheal.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Defaults ───────────────────────────────────────────────────

function defaultValidationDir() {
  return path.join(os.homedir(), '.meta-skills', 'validation');
}

function suitePathFor(skillId, dir = defaultValidationDir()) {
  if (!skillId) throw new Error('suitePathFor: skill-id required');
  return path.join(dir, 'suites', `${skillId}.json`);
}

function baselinePathFor(skillId, dir = defaultValidationDir()) {
  if (!skillId) throw new Error('baselinePathFor: skill-id required');
  return path.join(dir, 'baselines', `${skillId}.json`);
}

/** Strip a leading BOM (Windows writers) so JSON.parse stays deterministic. */
function stripBom(text) {
  return text.replace(/^\uFEFF/, '');
}

/** Atomic write (temp + rename), same pattern as rollback-ledger. */
function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  if (dir) fs.mkdirSync(dir, { recursive: true });
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

// ── Suite loading ──────────────────────────────────────────────

/**
 * Load and validate a suite JSON file.
 * Shape:
 *   { "skill": "<skill-id>", "cases": [
 *       { "id": "...", "prompt": "...", "keywords": ["..."],
 *         "mustNotContain": ["..."], "minScore": 50, "weight": 1 } ] }
 * @param {string} suitePath
 * @returns {{ skill: string, cases: object[] }}
 */
function loadSuite(suitePath) {
  let raw;
  try {
    raw = stripBom(fs.readFileSync(suitePath, 'utf-8'));
  } catch {
    throw new Error(`cannot read suite: ${suitePath}`);
  }

  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    throw new Error(`invalid JSON in suite: ${suitePath} (${e.message})`);
  }

  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`malformed suite: ${suitePath} — expected an object`);
  }
  if (typeof doc.skill !== 'string' || !doc.skill.trim()) {
    throw new Error(`malformed suite: ${suitePath} — "skill" must be a non-empty string`);
  }
  if (!Array.isArray(doc.cases)) {
    throw new Error(`malformed suite: ${suitePath} — "cases" must be an array`);
  }

  const cases = doc.cases.map((c, i) => {
    const where = `cases[${i}]`;
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      throw new Error(`malformed suite: ${suitePath} — ${where} must be an object`);
    }
    if (typeof c.id !== 'string' || !c.id.trim()) {
      throw new Error(`malformed suite: ${suitePath} — ${where}.id must be a non-empty string`);
    }
    if (typeof c.prompt !== 'string' || !c.prompt.trim()) {
      throw new Error(`malformed suite: ${suitePath} — ${where}.prompt must be a non-empty string`);
    }
    if (!Array.isArray(c.keywords) || c.keywords.some(k => typeof k !== 'string')) {
      throw new Error(`malformed suite: ${suitePath} — ${where}.keywords must be an array of strings`);
    }
    if (c.mustNotContain !== undefined
      && (!Array.isArray(c.mustNotContain) || c.mustNotContain.some(k => typeof k !== 'string'))) {
      throw new Error(`malformed suite: ${suitePath} — ${where}.mustNotContain must be an array of strings`);
    }
    if (c.minScore !== undefined
      && (typeof c.minScore !== 'number' || !Number.isFinite(c.minScore) || c.minScore < 0 || c.minScore > 100)) {
      throw new Error(`malformed suite: ${suitePath} — ${where}.minScore must be a number in 0-100`);
    }
    if (c.weight !== undefined
      && (typeof c.weight !== 'number' || !Number.isFinite(c.weight) || c.weight <= 0)) {
      throw new Error(`malformed suite: ${suitePath} — ${where}.weight must be a positive number`);
    }
    return {
      id: c.id,
      prompt: c.prompt,
      keywords: c.keywords,
      mustNotContain: c.mustNotContain || [],
      minScore: c.minScore ?? DEFAULT_THRESHOLD,
      weight: c.weight ?? 1,
    };
  });

  return { skill: doc.skill, cases };
}

// ── Scoring ────────────────────────────────────────────────────

/**
 * Deterministic 0..100 score for one held-out case.
 * Keyword coverage + structural guidance + caution guidance come from
 * selfheal's scorer (imported, not modified); any `mustNotContain` hit
 * zeroes the case outright.
 * @param {string} skillText
 * @param {object} caseObj
 * @returns {number}
 */
function scoreCase(skillText, caseObj) {
  if (!skillText || !caseObj) return 0;

  const banned = caseObj.mustNotContain || [];
  const lower = String(skillText).toLowerCase();
  for (const needle of banned) {
    if (typeof needle === 'string' && needle && lower.includes(needle.toLowerCase())) {
      return 0;
    }
  }

  return scoreSkillAgainstCase(skillText, { keywords: caseObj.keywords || [] });
}

/**
 * Score a skill text against a whole suite.
 * Aggregate = weighted mean of per-case scores (0-100, one decimal).
 * Per-case pass = score >= (case.minScore ?? 50).
 * @param {object} suite — from loadSuite
 * @param {string} skillText
 * @param {{skill?: string}} [opts]
 * @returns {{skill:string, aggregate:number, cases:Array<{id,score,pass,weight}>, passed:number, failed:number, total:number}}
 */
function runSuite(suite, skillText, opts = {}) {
  if (!suite || typeof suite !== 'object') throw new Error('runSuite: suite required');

  const cases = (suite.cases || []).map(c => {
    const score = scoreCase(skillText, c);
    const weight = typeof c.weight === 'number' && Number.isFinite(c.weight) ? c.weight : 1;
    const minScore = typeof c.minScore === 'number' && Number.isFinite(c.minScore) ? c.minScore : DEFAULT_THRESHOLD;
    return { id: c.id, score, pass: score >= minScore, weight, minScore };
  });

  const totalWeight = cases.reduce((s, c) => s + c.weight, 0);
  const aggregate = totalWeight > 0
    ? Math.round((cases.reduce((s, c) => s + c.score * c.weight, 0) / totalWeight) * 10) / 10
    : 0;

  return {
    skill: opts.skill || suite.skill || null,
    aggregate,
    cases,
    passed: cases.filter(c => c.pass).length,
    failed: cases.filter(c => !c.pass).length,
    total: cases.length,
  };
}

// ── Baselines ──────────────────────────────────────────────────

/**
 * Read the persisted baseline for a skill, or null when none exists.
 * @param {string} skillId
 * @param {string} [dir]
 * @returns {{skill:string, aggregate:number, cases:object[], ts:string}|null}
 */
function readBaseline(skillId, dir = defaultValidationDir()) {
  if (!skillId) throw new Error('readBaseline: skill-id required');
  const file = baselinePathFor(skillId, dir);
  let raw;
  try {
    raw = stripBom(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`invalid JSON in baseline: ${file} (${e.message})`);
  }
}

/**
 * Write a baseline atomically (temp + rename).
 * @param {string} skillId
 * @param {object} data — { skill, aggregate, cases, ts }
 * @param {string} [dir]
 * @returns {object} the record as written
 */
function writeBaseline(skillId, data, dir = defaultValidationDir()) {
  if (!skillId) throw new Error('writeBaseline: skill-id required');
  if (!data || typeof data !== 'object') throw new Error('writeBaseline: data required');

  const record = {
    skill: data.skill || skillId,
    aggregate: typeof data.aggregate === 'number' ? data.aggregate : 0,
    cases: Array.isArray(data.cases) ? data.cases : [],
    ts: data.ts || new Date().toISOString(),
  };

  atomicWriteJson(baselinePathFor(skillId, dir), record);
  return record;
}

// ── Strict gate ────────────────────────────────────────────────

/**
 * STRICT acceptance rule: accept only when candidate strictly exceeds baseline.
 * Equal ⇒ reject ("no improvement"); lower ⇒ reject ("regression").
 * @param {number} candidateAggregate
 * @param {number|null} baselineAggregate
 * @returns {{accept: boolean, reason: string}}
 */
function gate(candidateAggregate, baselineAggregate) {
  const cand = typeof candidateAggregate === 'number' ? candidateAggregate : 0;
  if (baselineAggregate === null || baselineAggregate === undefined) {
    return { accept: false, reason: 'no baseline recorded — run `validation baseline <suite> --skill <SKILL.md> --update` first' };
  }
  const base = typeof baselineAggregate === 'number' ? baselineAggregate : 0;

  if (cand > base) {
    return { accept: true, reason: `strict improvement: ${base} → ${cand}` };
  }
  if (cand === base) {
    return { accept: false, reason: `no improvement: ${base} → ${cand} (equal is a reject — no neutral accept)` };
  }
  return { accept: false, reason: `regression: ${base} → ${cand}` };
}

/**
 * Evaluate a skill file against a suite plus its persisted baseline.
 * @param {string} suitePath
 * @param {string} skillPath
 * @param {{validationDir?: string, force?: boolean}} [opts]
 * @returns {{result: object, gate: {accept:boolean, reason:string}, baseline: object|null}}
 */
function evaluateGate(suitePath, skillPath, opts = {}) {
  const dir = opts.validationDir || defaultValidationDir();
  const suite = loadSuite(suitePath);

  let skillText;
  try {
    skillText = fs.readFileSync(skillPath, 'utf-8');
  } catch {
    throw new Error(`cannot read skill file: ${skillPath}`);
  }

  const result = runSuite(suite, skillText);
  const baseline = readBaseline(suite.skill, dir);
  const verdict = gate(result.aggregate, baseline ? baseline.aggregate : null);

  if (opts.force) {
    verdict.reason = `${verdict.reason} (forced)`;
  }

  return { result, gate: verdict, baseline };
}

/**
 * Guarded gate for evolution approval: returns null (silent no-op) when the
 * suite or the baseline is missing for the skill.
 * @param {string} skillId
 * @param {string} skillPath
 * @param {{validationDir?: string, force?: boolean}} [opts]
 * @returns {{result: object, gate: object, baseline: object}|null}
 */
function checkGateForSkill(skillId, skillPath, opts = {}) {
  const dir = opts.validationDir || defaultValidationDir();
  const suitePath = suitePathFor(skillId, dir);
  if (!fs.existsSync(suitePath)) return null;

  const baseline = readBaseline(skillId, dir);
  if (!baseline) return null;

  return evaluateGate(suitePath, skillPath, { validationDir: dir, force: opts.force });
}

// ── CLI ────────────────────────────────────────────────────────

function parseArgs(args) {
  const opts = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--skill') opts.skillPath = args[++i];
    else if (a === '--validation-dir') opts.validationDir = args[++i];
    else if (a === '--update') opts.update = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--json') opts.json = true;
    else opts._.push(a);
  }
  return opts;
}

const USAGE = `validation-harness — held-out suites + strict gate (issue #35)

Usage:
  node src/validation-harness.mjs run <suitePath> --skill <SKILL.md> [--json] [--validation-dir <dir>]
  node src/validation-harness.mjs baseline <suitePath> --skill <SKILL.md> [--update] [--json]`;

async function main() {
  const args = process.argv.slice(2);
  const opts = parseArgs(args);
  const cmd = opts._[0];
  const suitePath = opts._[1];
  const dir = opts.validationDir || defaultValidationDir();

  if (!cmd || cmd === 'help' || !suitePath) {
    console.log(USAGE);
    process.exit(cmd ? 1 : 0);
  }

  const suite = loadSuite(suitePath);
  const skillPath = opts.skillPath;
  if (!skillPath) {
    console.error('validation: --skill <SKILL.md> required');
    process.exit(1);
  }

  const { result, gate: verdict, baseline } = evaluateGate(suitePath, skillPath, { validationDir: dir, force: opts.force });

  if (cmd === 'run') {
    if (opts.json) {
      console.log(JSON.stringify({ result, gate: verdict, baseline }, null, 2));
    } else {
      const icon = verdict.accept ? '✓' : '✗';
      console.log(`${icon} ${verdict.accept ? 'ACCEPT' : 'REJECT'} — ${result.skill} (strict gate)`);
      console.log(`  baseline: ${baseline ? baseline.aggregate : 'none'} → candidate: ${result.aggregate}`);
      console.log(`  ${verdict.reason}`);
      for (const c of result.cases) {
        console.log(`  ${c.pass ? '✓' : '✗'} ${c.id} — ${c.score} (min ${c.minScore}, weight ${c.weight})`);
      }
      console.log(`  cases: ${result.passed}/${result.total} pass`);
    }
    if (!verdict.accept && !opts.force) process.exit(1);
    return;
  }

  if (cmd === 'baseline') {
    if (opts.update) {
      const record = writeBaseline(result.skill, result, dir);
      console.log(`✓ baseline ${opts.force ? 'forced ' : ''}written for ${record.skill}`);
      console.log(`  aggregate: ${record.aggregate}`);
      console.log(`  file: ${baselinePathFor(record.skill, dir)}`);
    } else if (baseline) {
      console.log(`baseline for ${result.skill}: ${baseline.aggregate}`);
      console.log(`  recorded: ${baseline.ts}`);
      console.log(`  candidate now: ${result.aggregate}`);
      console.log(`  gate: ${verdict.accept ? 'accept' : 'reject'} — ${verdict.reason}`);
    } else {
      console.log(`no baseline for ${result.skill} — use --update to record one`);
    }
    return;
  }

  console.error('validation-harness: unknown subcommand (expected: run|baseline)');
  console.log(USAGE);
  process.exit(1);
}

const isMain = process.argv[1] && (
  process.argv[1] === fileURLToPath(import.meta.url)
  || process.argv[1].endsWith('validation-harness.mjs')
);
if (isMain) main();

export {
  DEFAULT_THRESHOLD,
  defaultValidationDir,
  suitePathFor,
  baselinePathFor,
  atomicWriteJson,
  loadSuite,
  scoreCase,
  runSuite,
  readBaseline,
  writeBaseline,
  gate,
  evaluateGate,
  checkGateForSkill,
  main,
};
