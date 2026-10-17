#!/usr/bin/env node

/**
 * meta-skills v1.9 (issue #39) — Success-strategy mining
 *
 * Learn from successes, not only from failures. failure-analyzer (v1.3)
 * reads outcome=failure events; this module reads outcome=success events,
 * groups them per skill, and emits "reinforce" notes so working behavior
 * is preserved instead of accidentally regressed.
 *
 * Commands:
 *   analyze [--log-dir <path>] [--min-count 2] [--max-events 500] [--json]
 *     Cluster success events per skill and print the clusters.
 *   notes [--log-dir <path>] [--min-count 2] [--max-events 500]
 *         [--notes-path <path>] [--write] [--json]
 *     Build reinforce notes. Dry-run by default; --write appends them.
 *
 * Design notes:
 *   - Keyword extraction reuses selfheal's approach (same stopwords, same
 *     freq-desc/alpha-asc ordering) so both sides of the loop agree.
 *   - Notes are JSONL and appended (ledger style, like history.jsonl and
 *     the daily usage logs). See writeNotes() for the append-vs-rewrite
 *     tradeoff.
 *
 * Inspired by:
 *   - WikiSkill trace sampling (passing traces are kept to identify
 *     effective strategies and prevent regressions in working behaviors)
 *   - EvoSkill / self-improve (human-in-the-loop, review before apply)
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { extractKeywords } from './selfheal.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Defaults ───────────────────────────────────────────────────

const DEFAULT_MAX_EVENTS = 500;
const DEFAULT_MIN_COUNT = 2;
const DEFAULT_MAX_KEYWORDS = 6;
const DEFAULT_MAX_EXCERPTS = 3;
const EXCERPT_MAX_LEN = 200;

function defaultLogDir() {
  return path.join(os.homedir(), '.meta-skills', 'logs');
}

function defaultNotesPath() {
  return path.join(os.homedir(), '.meta-skills', 'evolve', 'reinforce-notes.jsonl');
}

// ── Load success events ────────────────────────────────────────

/**
 * Read daily *.jsonl log files and keep outcome=success events.
 * Files are processed in name order (YYYY-MM-DD.jsonl sorts by date) and
 * lines in file order, so the result is deterministic for a fixed log dir.
 * Corrupt lines are skipped; a missing/unreadable log dir yields [].
 *
 * @param {object} [opts]
 * @param {string} [opts.logDir] - defaults to ~/.meta-skills/logs
 * @param {number} [opts.maxEvents=500] - hard cap on returned events
 * @returns {Array<object>} success events, in load order
 */
function loadSuccessEvents(opts = {}) {
  const logDir = opts.logDir || defaultLogDir();
  const maxEvents = opts.maxEvents ?? DEFAULT_MAX_EVENTS;
  const events = [];

  let logFiles;
  try {
    logFiles = fs.readdirSync(logDir).filter(f => f.endsWith('.jsonl')).sort();
  } catch {
    return events;
  }

  for (const logFile of logFiles) {
    let content;
    try {
      content = fs.readFileSync(path.join(logDir, logFile), 'utf-8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue; // skip corrupt lines
      }
      if (!event || typeof event !== 'object' || Array.isArray(event)) continue;
      if (event.outcome !== 'success') continue;
      events.push(event);
      if (events.length >= maxEvents) return events;
    }
  }

  return events;
}

// ── Excerpt helpers ────────────────────────────────────────────

/**
 * Best-effort short excerpt from a success event. Events may carry no text
 * at all (usage-tracker records only skill/timestamp/outcome/tokens), in
 * which case the cluster simply has no excerpts.
 * @param {object} event
 * @returns {string|null}
 */
function eventExcerpt(event) {
  const raw = event.excerpt ?? event.prompt ?? event.hint ?? event.reason ?? event.summary;
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > EXCERPT_MAX_LEN ? text.slice(0, EXCERPT_MAX_LEN) + '…' : text;
}

// ── Clustering ─────────────────────────────────────────────────

/**
 * Group success events by skill and build clusters for skills with
 * count >= minCount.
 *
 * @param {Array<object>} events - success events (from loadSuccessEvents)
 * @param {object} [opts]
 * @param {number} [opts.minCount=2] - skills below this count are ignored
 * @param {number} [opts.maxKeywords=6] - keywords per cluster
 * @param {number} [opts.maxExcerpts=3] - excerpts per cluster
 * @returns {Array<{skill, count, firstAt, lastAt, keywords: string[], excerpts: string[]}>}
 *          sorted by (count desc, skill asc) — deterministic
 */
function analyzeSuccesses(events, opts = {}) {
  const minCount = opts.minCount ?? DEFAULT_MIN_COUNT;
  const maxKeywords = opts.maxKeywords ?? DEFAULT_MAX_KEYWORDS;
  const maxExcerpts = opts.maxExcerpts ?? DEFAULT_MAX_EXCERPTS;

  const bySkill = new Map();
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const skill = event.skill;
    if (!skill) continue;
    if (!bySkill.has(skill)) bySkill.set(skill, []);
    bySkill.get(skill).push(event);
  }

  const clusters = [];
  for (const [skill, group] of bySkill) {
    if (group.length < minCount) continue;

    const timestamps = group.map(e => e.timestamp).filter(t => typeof t === 'string' && t);
    const excerpts = [];
    for (const event of group) {
      const excerpt = eventExcerpt(event);
      if (excerpt) excerpts.push(excerpt);
      if (excerpts.length >= maxExcerpts) break;
    }

    // Keywords come from the same text the excerpts carry; deterministic
    // frequency sort (freq desc, alpha asc) via selfheal's extractor.
    const keywords = extractKeywords(excerpts.join(' '), { max: maxKeywords });

    clusters.push({
      skill,
      count: group.length,
      firstAt: timestamps.length ? timestamps.slice().sort()[0] : null,
      lastAt: timestamps.length ? timestamps.slice().sort().at(-1) : null,
      keywords,
      excerpts,
    });
  }

  return clusters.sort((a, b) => b.count - a.count || String(a.skill).localeCompare(String(b.skill)));
}

// ── Reinforce notes ────────────────────────────────────────────

/**
 * Concrete guidance bullets derived from a cluster's keywords.
 * Deterministic: same keywords → same bullets.
 */
function guidanceBullets(skill, keywords) {
  if (keywords.length === 0) {
    return [`Keep the current ${skill} instructions — repeated successes show they already fit the task.`];
  }
  const top = keywords.slice(0, 3).join(', ');
  const bullets = [`Keep the ${skill} approach for ${top}: these contexts succeeded repeatedly.`];
  if (keywords.length >= 2) {
    bullets.push(`Do not rewrite the steps covering ${keywords[0]} or ${keywords[1]} — no regression recorded.`);
  }
  return bullets;
}

/**
 * Map clusters to reinforce notes (one per cluster).
 * @param {Array<object>} clusters - from analyzeSuccesses
 * @param {object} [opts]
 * @param {Date} [opts.now] - injectable clock for deterministic tests
 * @returns {Array<{skill, kind, generated, reason, suggestedGuidance: string[]}>}
 */
function clustersToNotes(clusters, opts = {}) {
  const generated = (opts.now || new Date()).toISOString();
  return clusters.map(cluster => ({
    skill: cluster.skill,
    kind: 'reinforce',
    generated,
    reason: `Consistent successes (${cluster.count}) observed — reinforce this approach`,
    suggestedGuidance: guidanceBullets(cluster.skill, cluster.keywords),
  }));
}

// ── Notes storage (JSONL) ──────────────────────────────────────

/**
 * Append notes to the notes file, one JSON object per line.
 *
 * Write choice: plain append. Notes are an append-only ledger (like
 * history.jsonl and the daily usage logs) — cheap, crash-safe, and no
 * read-modify-write race with other writers. If notes ever need dedupe or
 * in-place update, switch to read + append + atomic write (temp file +
 * rename); that costs a full rewrite per call and can clobber concurrent
 * writers, so it is not used here.
 *
 * @param {Array<object>} notes
 * @param {string} [notesPath] - defaults to ~/.meta-skills/evolve/reinforce-notes.jsonl
 * @returns {number} notes written
 */
function writeNotes(notes, notesPath) {
  const file = notesPath || defaultNotesPath();
  const list = Array.isArray(notes) ? notes : [notes];
  if (list.length === 0) return 0;

  const dir = path.dirname(file);
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const lines = list.map(n => JSON.stringify(n) + '\n').join('');
  fs.appendFileSync(file, lines, 'utf-8');
  return list.length;
}

/**
 * Read notes back. Corrupt lines are skipped; a missing file returns [].
 * @param {string} [notesPath]
 * @returns {Array<object>}
 */
function readNotes(notesPath) {
  const file = notesPath || defaultNotesPath();
  let content;
  try {
    content = fs.readFileSync(file, 'utf-8');
  } catch {
    return [];
  }

  const notes = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const note = JSON.parse(line);
      if (note && typeof note === 'object' && !Array.isArray(note)) notes.push(note);
    } catch {
      // skip corrupt lines
    }
  }
  return notes;
}

// ── CLI ────────────────────────────────────────────────────────

function parseArgs(args) {
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--log-dir' && i + 1 < args.length) opts.logDir = path.resolve(args[++i]);
    else if (a === '--notes-path' && i + 1 < args.length) opts.notesPath = path.resolve(args[++i]);
    else if (a === '--min-count' && i + 1 < args.length) opts.minCount = parseInt(args[++i], 10);
    else if (a === '--max-events' && i + 1 < args.length) opts.maxEvents = parseInt(args[++i], 10);
    else if (a === '--write') opts.write = true;
    else if (a === '--json') opts.json = true;
  }
  return opts;
}

function cmdAnalyze(opts) {
  const events = loadSuccessEvents(opts);
  const clusters = analyzeSuccesses(events, opts);

  if (opts.json) {
    console.log(JSON.stringify({
      logDir: opts.logDir || defaultLogDir(),
      events: events.length,
      minCount: opts.minCount ?? DEFAULT_MIN_COUNT,
      clusters,
    }, null, 2));
    return clusters;
  }

  console.log(`🌱 Success mining — ${events.length} success event(s)`);
  if (clusters.length === 0) {
    console.log(`  No skill reached min-count ${opts.minCount ?? DEFAULT_MIN_COUNT}.`);
    return clusters;
  }

  console.log(`  ${clusters.length} cluster(s):`);
  for (const c of clusters) {
    console.log(`  ${c.skill}  ${c.count} success(es)  ${c.firstAt || '?'} → ${c.lastAt || '?'}`);
    console.log(`    keywords: ${c.keywords.join(', ') || '(none)'}`);
    for (const excerpt of c.excerpts) console.log(`    excerpt: ${excerpt}`);
  }
  return clusters;
}

function cmdNotes(opts) {
  const clusters = analyzeSuccesses(loadSuccessEvents(opts), opts);
  const notes = clustersToNotes(clusters);

  if (opts.write) {
    const written = writeNotes(notes, opts.notesPath);
    if (opts.json) {
      console.log(JSON.stringify({ notesPath: opts.notesPath || defaultNotesPath(), written, notes }, null, 2));
    } else {
      console.log(`✓ wrote ${written} reinforce note(s) → ${opts.notesPath || defaultNotesPath()}`);
      for (const n of notes) console.log(`  ${n.skill}: ${n.reason}`);
    }
    return written;
  }

  // Dry-run default: nothing is written.
  if (opts.json) {
    console.log(JSON.stringify({ dryRun: true, notes }, null, 2));
    return notes;
  }

  console.log(`🌱 Reinforce notes (dry-run, ${notes.length} note(s))`);
  if (notes.length === 0) {
    console.log('  Nothing to reinforce — no clusters met min-count.');
    return notes;
  }
  for (const n of notes) {
    console.log(`  ${n.skill} — ${n.reason}`);
    for (const bullet of n.suggestedGuidance) console.log(`    - ${bullet}`);
  }
  console.log('  Pass --write to append them.');
  return notes;
}

function usage() {
  console.log(`Usage:
  meta-skills success analyze [--log-dir <path>] [--min-count 2] [--max-events 500] [--json]
  meta-skills success notes [--log-dir <path>] [--min-count 2] [--max-events 500]
                            [--notes-path <path>] [--write] [--json]

  Dry-run is the default for notes; --write appends to
  ~/.meta-skills/evolve/reinforce-notes.jsonl.

  Integration: \`meta-skills propose --with-success\` mines success clusters
  through this module (see src/failure-analyzer.mjs).`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    usage();
    process.exit(0);
  }

  const command = args[0];
  const opts = parseArgs(args.slice(1));

  switch (command) {
    case 'analyze':
      cmdAnalyze(opts);
      break;
    case 'notes':
      cmdNotes(opts);
      break;
    default:
      console.error(`✗ unknown command: ${command}`);
      usage();
      process.exit(1);
  }
}

const isMain = process.argv[1] && (
  process.argv[1] === fileURLToPath(import.meta.url)
  || process.argv[1].endsWith('success-miner.mjs')
);
if (isMain) main();

export {
  DEFAULT_MAX_EVENTS,
  DEFAULT_MIN_COUNT,
  DEFAULT_MAX_KEYWORDS,
  DEFAULT_MAX_EXCERPTS,
  defaultLogDir,
  defaultNotesPath,
  loadSuccessEvents,
  analyzeSuccesses,
  clustersToNotes,
  writeNotes,
  readNotes,
  cmdAnalyze,
  cmdNotes,
  main,
};
