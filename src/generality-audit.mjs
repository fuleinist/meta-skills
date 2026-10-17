#!/usr/bin/env node

/**
 * meta-skills v0.2.5 — Generality / Transferability Audit (issue #41)
 *
 * Skills are supposed to transfer across projects, machines and agents. A
 * skill that encodes a localized workaround ("on this machine use
 * C:\Users\bob\app\cfg.json", "in this repo, patch build.py first") carries
 * context that does not transfer — and can actively hurt.
 *
 * WikiSkill transfer study: negative transfer from localized skills. A
 * stronger model dropped from 50.5 to 18.1 on one benchmark when it used a
 * weaker model's localized skills; general skills raised it to 63.4.
 *
 * This module is a deterministic, stdlib-only signal scan over skill content
 * (usually a proposal diff). No I/O in the audit functions.
 *
 * Integration points (kept deliberately small):
 *   - src/evolution.mjs `listProposals` prints one generality line per pending
 *     proposal via formatGeneralityReport().
 *   - src/evolution.mjs `evolve approve --strict` refuses approval when the
 *     content is `localized` and the target index entry's `scope` is `global`
 *     (or absent, which defaults to `global`). `scope: "project"` is the
 *     escape hatch for genuinely project-local skills.
 *   - `scope` is not in schema/v1.json yet; it is read opportunistically.
 */

import fs from 'node:fs';
import path from 'node:path';

// A "specific filename token" — used to qualify repo-local phrases, so that
// "in this project" alone is not treated as a localized workaround.
const FILE_TOKEN = '[A-Za-z0-9_.-]+\\.[A-Za-z0-9]{1,5}';

// ---- Signals ---------------------------------------------------------------

const SIGNALS = [
  {
    kind: 'abs-path',
    weight: 12,
    cap: 48,
    pattern: /[A-Za-z]:\\|\/Users\/|\/home\/|\\\\server/g,
  },
  {
    // Weighted lightly: documentation URLs are borderline, but still counted.
    kind: 'one-off-url',
    weight: 3,
    cap: 15,
    pattern: /https?:\/\/[^\s<>"')]+/g,
  },
  {
    kind: 'machine-name',
    weight: 8,
    cap: 40,
    pattern: /\b(this machine|this pc|my computer|this laptop|my laptop|this box|my box)\b/gi,
  },
  {
    // Repo-local only counts when a specific filename token is present, so a
    // generic "in this project" sentence is not penalized on its own.
    kind: 'repo-local',
    weight: 10,
    cap: 50,
    pattern: new RegExp(
      `\\b(in|for|within|local to|inside) this (repo|repository|project|codebase)\\b(?=[^\\n]*${FILE_TOKEN})`,
      'gi',
    ),
  },
  {
    // Overlaps abs-path; counted as its own kind only when a <name> subpath is
    // actually present (C:\Users\<name>\... or /Users/<name>/...).
    kind: 'user-name',
    weight: 10,
    cap: 40,
    pattern: /(?:[A-Za-z]:\\Users\\|\/Users\/)[^\s\\/]+(?=[\\/])/g,
  },
];

const DEFAULT_WEIGHTS = Object.fromEntries(SIGNALS.map(s => [s.kind, s.weight]));
const DEFAULT_CAPS = Object.fromEntries(SIGNALS.map(s => [s.kind, s.cap]));

/** Label for a score: general >= 80, mixed 50-79, localized < 50. */
export function labelFor(score) {
  if (score >= 80) return 'general';
  if (score >= 50) return 'mixed';
  return 'localized';
}

/**
 * Audit skill content (SKILL.md text or a proposal diff string) for
 * repo-/machine-specific signals.
 *
 * @param {string} content — content to scan
 * @param {object} [opts]
 * @param {object} [opts.weights] — per-kind penalty overrides
 * @param {object} [opts.caps] — per-kind penalty caps
 * @param {string[]} [opts.signals] — restrict to these kinds
 * @returns {{ score: number, label: string, flags: Array<{kind, match, count}>, ratio: number }}
 */
export function auditGenerality(content, opts = {}) {
  const text = typeof content === 'string' ? content : String(content ?? '');
  const weights = { ...DEFAULT_WEIGHTS, ...(opts.weights || {}) };
  const caps = { ...DEFAULT_CAPS, ...(opts.caps || {}) };
  const kinds = opts.signals || SIGNALS.map(s => s.kind);

  const flags = [];
  let penalty = 0;

  for (const signal of SIGNALS) {
    if (!kinds.includes(signal.kind)) continue;
    const matches = text.match(signal.pattern) || [];
    if (matches.length === 0) continue;

    const weight = weights[signal.kind] ?? signal.weight;
    const cap = caps[signal.kind] ?? signal.cap;
    penalty += Math.min(matches.length * weight, cap);

    flags.push({ kind: signal.kind, match: matches[0], count: matches.length });
  }

  const score = Math.max(0, Math.min(100, 100 - penalty));
  const totalFlags = flags.reduce((sum, f) => sum + f.count, 0);
  const ratio = Math.round((totalFlags / Math.max(text.length, 1)) * 1000 * 100) / 100;

  return { score, label: labelFor(score), flags, ratio };
}

/**
 * One short line for CLI/review display, e.g.
 *   generality: 78/100 (mixed) — flags: abs-path x2, repo-local x1
 */
export function formatGeneralityReport(report) {
  const line = `generality: ${report.score}/100 (${report.label})`;
  const parts = (report.flags || []).filter(f => f.count > 0).map(f => `${f.kind} x${f.count}`);
  return parts.length > 0 ? `${line} — flags: ${parts.join(', ')}` : `${line} — no localized signals`;
}

// ---- CLI -------------------------------------------------------------------

const isMain = process.argv[1] && (
  process.argv[1] === (new URL(import.meta.url)).pathname ||
  process.argv[1].endsWith('generality-audit.mjs')
);

if (isMain) {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));

  if (!file) {
    console.log(`generality-audit — scan skill content for localized signals (issue #41)

Usage:
  node src/generality-audit.mjs <file> [--json]`);
    process.exit(0);
  }

  let content = '';
  try {
    content = fs.readFileSync(path.resolve(file), 'utf-8');
  } catch (e) {
    console.error(`Cannot read ${file}: ${e.message}`);
    process.exit(1);
  }

  const report = auditGenerality(content);
  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatGeneralityReport(report));
  }
  process.exit(0);
}

export { SIGNALS, DEFAULT_WEIGHTS, DEFAULT_CAPS };
