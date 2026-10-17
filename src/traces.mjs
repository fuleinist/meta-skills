#!/usr/bin/env node

/**
 * meta-skills v0.2.5 — Raw Evidence Trace Store (issue #37)
 *
 * Stores the actual execution evidence behind usage/outcome events so
 * downstream analysis (failure-analyzer, selfheal, propose) can be
 * root-cause based instead of merely structural.
 *
 * Design (WikiSkill Raw Layer):
 *   - one file per trace: <dir>/<id>.md, complete and immutable
 *   - write-once: an existing trace is never overwritten
 *   - bounded: content capped at MAX_TRACE_CHARS, sampling caps per cycle
 *   - no delete/prune API — traces are immutable by design
 *
 * Privacy: traces are user-provided and may contain sensitive data. They
 * stay local and are never uploaded; sync remains metadata/usage-only.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

// ── Shared caps (imported by sampling/consolidation work) ────────

const MAX_TRACES_PER_CYCLE = 8;
const MAX_FAIL_TRACES = 5;
const MAX_PASS_TRACES = 3;
const MAX_TRACE_CHARS = 15000;

// ── Default paths ────────────────────────────────────────────────

function defaultTracesDir() {
  const dir = path.join(os.homedir(), '.meta-skills', 'traces');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Ids ──────────────────────────────────────────────────────────

/** sha256(content) → 6 hex chars, deterministic. */
function hash6(str) {
  return createHash('sha256').update(str).digest('hex').slice(0, 6);
}

/** <yyyymmdd-hhmmss>-<hash6> — sortable, collision-resistant. */
function traceId(content, now = new Date()) {
  const ts = new Date(now).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${ts}-${hash6(content)}`;
}

// ── Store (write-once) ───────────────────────────────────────────

/**
 * Write one trace as <dir>/<id>.md. Immutable: a second store of the same
 * id throws instead of overwriting. Written via temp file + rename.
 * @param {string} content
 * @param {object} [opts]
 * @param {string} [opts.id] explicit id (tests / callers)
 * @param {string} [opts.dir] traces directory (default defaultTracesDir())
 * @param {Date} [opts.now] timestamp for the generated id
 * @returns {{ id, path, bytes, originalChars, truncated }}
 */
function storeTrace(content, opts = {}) {
  if (typeof content !== 'string') throw new Error('storeTrace: content must be a string');
  if (!content.length) throw new Error('storeTrace: content is empty');

  const dir = opts.dir || defaultTracesDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const id = opts.id || traceId(content, opts.now);
  const target = path.join(dir, `${id}.md`);
  if (fs.existsSync(target)) {
    throw new Error(`storeTrace: trace "${id}" already exists — traces are write-once (${target})`);
  }

  const originalChars = content.length;
  const truncated = originalChars > MAX_TRACE_CHARS;
  const body = truncated
    ? content.slice(0, MAX_TRACE_CHARS) + `\n\n[truncated: kept ${MAX_TRACE_CHARS} of ${originalChars} chars]`
    : content;

  const tmpPath = path.join(dir, `.${id}.md.tmp-${process.pid}`);
  try {
    fs.writeFileSync(tmpPath, body, 'utf-8');
    fs.renameSync(tmpPath, target);
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch { /* temp already gone */ }
    throw new Error(`storeTrace: cannot write ${target}: ${e.message}`);
  }

  return { id, path: target, bytes: fs.statSync(target).size, originalChars, truncated };
}

// ── Read / list / stats ──────────────────────────────────────────

/** Read a trace's content. Throws with a clear error if missing. */
function readTrace(id, opts = {}) {
  const dir = opts.dir || defaultTracesDir();
  const target = path.join(dir, `${id}.md`);
  try {
    return fs.readFileSync(target, 'utf-8');
  } catch {
    throw new Error(`readTrace: no trace "${id}" in ${dir}`);
  }
}

/** All traces, sorted by id (chronological for generated ids). */
function listTraces(opts = {}) {
  const dir = opts.dir || defaultTracesDir();
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const traces = entries.filter(f => f.endsWith('.md')).map(f => {
    const full = path.join(dir, f);
    let bytes = 0;
    try { bytes = fs.statSync(full).size; } catch { /* vanished entry */ }
    return { id: f.slice(0, -3), path: full, bytes };
  });
  traces.sort((a, b) => a.id.localeCompare(b.id));
  return traces;
}

/** Aggregate size of the trace store. */
function traceStats(opts = {}) {
  const traces = listTraces(opts);
  return { count: traces.length, totalBytes: traces.reduce((sum, t) => sum + t.bytes, 0) };
}

// ── Sampling ─────────────────────────────────────────────────────

/**
 * Stratified sample of event/trace items: up to MAX_FAIL_TRACES failing and
 * MAX_PASS_TRACES passing (the two caps sum to MAX_TRACES_PER_CYCLE).
 * Deterministic — input order is preserved.
 * @param {Array<{outcome?: string}>} items
 * @param {object} [opts]
 * @param {number} [opts.maxFail] override MAX_FAIL_TRACES
 * @param {number} [opts.maxPass] override MAX_PASS_TRACES
 * @returns {{ failing, passing, sampled, total }}
 */
function sampleTraces(items, opts = {}) {
  const maxFail = opts.maxFail ?? MAX_FAIL_TRACES;
  const maxPass = opts.maxPass ?? MAX_PASS_TRACES;
  const all = Array.isArray(items) ? items : [];

  const failing = [];
  const passing = [];
  for (const item of all) {
    const outcome = String((item && item.outcome) || '').toLowerCase();
    if (outcome === 'failure' || outcome === 'fail') {
      if (failing.length < maxFail) failing.push(item);
    } else if (outcome === 'success' || outcome === 'pass') {
      if (passing.length < maxPass) passing.push(item);
    }
  }

  return {
    failing,
    passing,
    sampled: [...failing, ...passing],
    total: all.length,
  };
}

// ── Exports ──────────────────────────────────────────────────────

export {
  defaultTracesDir,
  storeTrace,
  readTrace,
  listTraces,
  traceStats,
  sampleTraces,
  traceId,
  hash6,
  MAX_TRACES_PER_CYCLE,
  MAX_FAIL_TRACES,
  MAX_PASS_TRACES,
  MAX_TRACE_CHARS,
};
