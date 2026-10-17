#!/usr/bin/env node

/**
 * meta-skills v1.9 — Analysis sampling & evidence budget (issue #42)
 *
 * Bounded sampling rules so failure analysis stays tractable and trustworthy:
 *   1. dedupe      — identical traces count once (sha256 of content)
 *   2. stratify    — separate failing vs passing evidence, per-class caps
 *   3. cap         — total items per cycle + per-item char budget
 *   4. gate        — minimum evidence per patch kind before a proposal
 *
 * WikiSkill rule codified here: <= 8 traces per analysis cycle
 * (<= 5 failing + <= 3 passing), each <= 15,000 chars, and the proposer
 * must read at least 4 traces.
 *
 * Zero new npm deps — Node stdlib only.
 *
 * CLI:
 *   node src/sampling.mjs check --input <file.jsonl> [--json]
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Constants ──────────────────────────────────────────────────

/** Total traces an analysis cycle may read (WikiSkill: 8). */
export const MAX_TRACES_PER_CYCLE = 8;

/** Cap on failing traces per cycle (WikiSkill: 5). */
export const MAX_FAIL_TRACES = 5;

/** Cap on passing traces per cycle (WikiSkill: 3). */
export const MAX_PASS_TRACES = 3;

/** Per-trace character budget (WikiSkill: 15,000 chars). */
export const MAX_TRACE_CHARS = 15000;

/**
 * Minimum evidence required before a proposal of each patch kind.
 *   antiPattern — a repeated mistake pattern needs >= 2 matching traces
 *   whenTighten — a wrong-context trigger needs >= 2 traces to be credible
 *   split       — heterogeneous use cases need >= 5 traces (this repo's
 *                 existing split heuristic)
 *   generic     — any other proposal needs >= 2 traces
 * Unknown kinds fall back to `generic`.
 */
export const MIN_EVIDENCE = {
  antiPattern: 2,
  whenTighten: 2,
  split: 5,
  generic: 2,
};

/** Marker appended to a trace that exceeded MAX_TRACE_CHARS. */
export const TRUNCATION_MARKER = '…[truncated]';

/** Hash prefix length used for dedupe keys (12 hex chars). */
export const HASH_LENGTH = 12;

// ── Helpers ────────────────────────────────────────────────────

/** sha256 hex of a string, truncated to HASH_LENGTH chars. */
export function contentHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, HASH_LENGTH);
}

/** Text representation of an item (string items as-is, otherwise JSON). */
function itemText(item) {
  if (typeof item === 'string') return item;
  if (item && typeof item.text === 'string') return item.text;
  return JSON.stringify(item);
}

// ── Dedupe ─────────────────────────────────────────────────────

/**
 * Stable dedupe by content hash.
 * Key = sha256(keyFn(item)) truncated to 12 hex chars; first occurrence wins
 * and input order is preserved.
 * @param {Array} items - trace items
 * @param {(item: any) => string} [keyFn] - defaults to JSON of the item
 * @returns {{ items: Array, removed: number }} - `removed` is the number of
 *   duplicate items dropped.
 */
function dedupeByContent(items, keyFn) {
  const key = keyFn || itemText;
  const seen = new Set();
  const kept = [];
  let removed = 0;

  for (const item of items) {
    const hash = contentHash(key(item));
    if (seen.has(hash)) {
      removed++;
      continue;
    }
    seen.add(hash);
    kept.push(item);
  }

  return { items: kept, removed };
}

// ── Stratify ───────────────────────────────────────────────────

/** Outcome bucket for an item: 'failure' or 'success'. */
function outcomeClass(item) {
  const outcome = String((item && item.outcome) || '').toLowerCase();
  if (outcome === 'success' || outcome === 'pass') return 'success';
  return 'failure';
}

/** Parseable timestamp, or -Infinity when absent (sorts last in desc order). */
function timeOf(item) {
  const t = item && item.timestamp ? Date.parse(item.timestamp) : NaN;
  return Number.isFinite(t) ? t : -Infinity;
}

/**
 * Classify traces into failing / passing and apply per-class caps.
 * Items are ordered by timestamp descending first (only when at least one
 * item has a timestamp), so recency wins over volume.
 * @param {Array} items
 * @param {{maxFail?: number, maxPass?: number}} [opts]
 * @returns {{ failing: Array, passing: Array, dropped: number }}
 */
function stratify(items, opts = {}) {
  const maxFail = opts.maxFail ?? MAX_FAIL_TRACES;
  const maxPass = opts.maxPass ?? MAX_PASS_TRACES;

  const indexed = items.map((item, i) => ({ item, i }));
  if (items.some(item => item && item.timestamp)) {
    indexed.sort((a, b) => (timeOf(b.item) - timeOf(a.item)) || (a.i - b.i));
  }

  const failing = [];
  const passing = [];
  for (const { item } of indexed) {
    if (outcomeClass(item) === 'success') passing.push(item);
    else failing.push(item);
  }

  const keptFail = failing.slice(0, maxFail);
  const keptPass = passing.slice(0, maxPass);

  return {
    failing: keptFail,
    passing: keptPass,
    dropped: (failing.length - keptFail.length) + (passing.length - keptPass.length),
  };
}

// ── Caps ───────────────────────────────────────────────────────

/**
 * Enforce the per-cycle count cap and the per-item character cap.
 * Truncated items get TRUNCATION_MARKER appended and `truncated: true` set on
 * a shallow copy — input items are never mutated. String items are returned as
 * truncated strings (a primitive cannot carry the flag).
 * @param {Array} items
 * @param {{max?: number, maxChars?: number}} [opts]
 * @returns {{ items: Array, truncatedCount: number }}
 */
function enforceCaps(items, opts = {}) {
  const max = opts.max ?? MAX_TRACES_PER_CYCLE;
  const maxChars = opts.maxChars ?? MAX_TRACE_CHARS;

  const capped = items.slice(0, max);
  const out = [];
  let truncatedCount = 0;

  for (const item of capped) {
    const text = itemText(item);
    if (text.length <= maxChars) {
      out.push(item);
      continue;
    }
    truncatedCount++;
    if (typeof item === 'string') {
      out.push(text.slice(0, maxChars) + TRUNCATION_MARKER);
    } else {
      out.push({ ...item, text: text.slice(0, maxChars) + TRUNCATION_MARKER, truncated: true });
    }
  }

  return { items: out, truncatedCount };
}

// ── Selection pipeline ─────────────────────────────────────────

/**
 * dedupe → stratify → caps. The whole cycle stays inside the evidence budget.
 * @param {Array} items
 * @param {object} [opts] - passed through to each stage
 * @returns {{ selected: Array, stats: { input, deduped, failing, passing, truncated } }}
 */
function selectEvidence(items, opts = {}) {
  const input = items.length;
  const dedup = dedupeByContent(items, opts.keyFn);
  const strata = stratify(dedup.items, opts);
  const capped = enforceCaps([...strata.failing, ...strata.passing], opts);

  return {
    selected: capped.items,
    stats: {
      input,
      deduped: dedup.items.length,
      failing: strata.failing.length,
      passing: strata.passing.length,
      truncated: capped.truncatedCount,
    },
  };
}

// ── Minimum-evidence gate ──────────────────────────────────────

/**
 * Check whether a proposal kind has enough evidence.
 * Unknown kinds fall back to `generic`.
 * @param {number} count - evidence items actually read
 * @param {string} kind - patch kind (antiPattern | whenTighten | split | generic)
 * @returns {{ ok: boolean, required: number, actual: number, message: string }}
 */
function validateEvidenceCount(count, kind) {
  const required = MIN_EVIDENCE[kind] ?? MIN_EVIDENCE.generic;
  const actual = Number.isFinite(count) ? count : 0;
  const ok = actual >= required;
  const message = ok
    ? `${kind}: ${actual} evidence item(s) — meets minimum of ${required}`
    : `${kind}: only ${actual} evidence item(s), needs at least ${required} — proposal is below the documented evidence minimum`;

  return { ok, required, actual, message };
}

// ── CLI ────────────────────────────────────────────────────────

function readJsonl(file) {
  const content = fs.readFileSync(file, 'utf-8');
  return content.split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] !== 'check') {
    console.log(`Usage:
  node src/sampling.mjs check --input <file.jsonl> [--json]

  Runs the sampling pipeline (dedupe → stratify → caps) over a JSONL log
  and prints the evidence-budget stats for one analysis cycle.`);
    process.exit(0);
  }

  const options = {};
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--input' && i + 1 < args.length) options.input = path.resolve(args[++i]);
    else if (args[i] === '--json') options.json = true;
  }

  if (!options.input) {
    console.error('✗ --input <file.jsonl> required');
    process.exit(1);
  }

  let items;
  try {
    items = readJsonl(options.input);
  } catch (e) {
    console.error(`✗ cannot read ${options.input}: ${e.message}`);
    process.exit(1);
  }

  const { selected, stats } = selectEvidence(items);

  if (options.json) {
    console.log(JSON.stringify({ stats, selected }, null, 2));
  } else {
    console.log(`🔎 sampling cycle (max ${MAX_TRACES_PER_CYCLE} traces, ` +
      `${MAX_FAIL_TRACES} fail / ${MAX_PASS_TRACES} pass, ${MAX_TRACE_CHARS} chars each)`);
    console.log(`  input: ${stats.input}  deduped: ${stats.deduped}  ` +
      `failing: ${stats.failing}  passing: ${stats.passing}  truncated: ${stats.truncated}`);
    console.log(`  selected: ${selected.length} trace(s)`);
  }
}

const isMain = process.argv[1] && (
  process.argv[1] === fileURLToPath(import.meta.url)
  || process.argv[1].endsWith('sampling.mjs')
);
if (isMain) main();

export {
  dedupeByContent,
  stratify,
  enforceCaps,
  selectEvidence,
  validateEvidenceCount,
  main,
};
