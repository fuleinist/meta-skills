#!/usr/bin/env node

/**
 * meta-skills v0.2.5 — Persistent Knowledge Layer (wiki, issue #33)
 *
 * Raw usage events record what happened; the wiki records what was learned
 * from them. It lives beside the index but is a separate store: skills get
 * rolled back, the wiki never does — knowledge is append/update only.
 *
 * Layout (default ~/.meta-skills/wiki/):
 *   index.md         — one entry per pattern: PROBLEM + ROOT CAUSE + FIX
 *   logs.md          — append-only timestamped activity log
 *   skill-impact.md  — machine-written lines: which skill changed and why
 *   patterns/        — one page per pattern, ~10-30 lines
 *
 * Rules:
 *   - Index entries are 1-2 sentences in PROBLEM + ROOT CAUSE + FIX form.
 *   - Pattern pages hold the root cause, the exact observed sequence, and the
 *     concrete fix. Success patterns are captured as well as failures.
 *   - Update an existing pattern instead of creating a near-duplicate.
 *
 * Zero external API calls, zero new dependencies.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// ── Default paths ───────────────────────────────────────────────────

export function defaultWikiDir() {
  return path.join(os.homedir(), '.meta-skills', 'wiki');
}

/** Top-level wiki files, in the order ensureWiki creates them. */
export const WIKI_FILES = ['index.md', 'logs.md', 'skill-impact.md'];

/** Minimal default content for each file on first creation. */
const DEFAULT_CONTENT = {
  'index.md': '# Wiki Index\n',
  'logs.md': '# Wiki Log\n',
  'skill-impact.md': '# Skill Impact\n',
};

// ── Errors ──────────────────────────────────────────────────────────

/** Base class for all wiki errors so callers can `instanceof` once. */
export class WikiError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'WikiError';
    this.code = code || 'WIKI_ERROR';
  }
}

/** Pattern name fails slug validation. */
export class WikiValidationError extends WikiError {
  constructor(message) {
    super(message, 'WIKI_VALIDATION');
    this.name = 'WikiValidationError';
  }
}

/** Pattern with that slug already exists. */
export class PatternExistsError extends WikiError {
  constructor(message) {
    super(message, 'PATTERN_EXISTS');
    this.name = 'PatternExistsError';
  }
}

/** Pattern slug not found on disk. */
export class PatternNotFoundError extends WikiError {
  constructor(message) {
    super(message, 'PATTERN_NOT_FOUND');
    this.name = 'PatternNotFoundError';
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Normalize a pattern name to a slug: lowercase, [a-z0-9-] only, `.md`
 * extension optional and dropped. Matches the bundle-manager slug rules.
 *
 * @param {string} name
 * @returns {string} slug (no extension)
 * @throws {WikiValidationError}
 */
export function slugifyPatternName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new WikiValidationError('pattern name must be a non-empty string');
  }
  const base = name
    .replace(/\.md$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!base) {
    throw new WikiValidationError(`pattern name "${name}" produces an empty slug`);
  }
  if (base.length > 64) {
    throw new WikiValidationError('pattern slug must be ≤64 characters');
  }
  return base;
}

function wikiDir(dir) {
  return dir || defaultWikiDir();
}

function patternsDir(dir) {
  return path.join(wikiDir(dir), 'patterns');
}

function patternFile(dir, name) {
  return path.join(patternsDir(dir), `${slugifyPatternName(name)}.md`);
}

/**
 * Write text atomically via temp file + rename. Matches the house
 * atomicWriteJson pattern (bundle-manager v1.8).
 *
 * @param {string} targetPath
 * @param {string} content
 * @returns {void}
 */
function atomicWriteText(targetPath, content) {
  const tmp = `${targetPath}.tmp`;
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, targetPath);
}

// ── Structure ───────────────────────────────────────────────────────

/**
 * Idempotently create the wiki structure. Existing files are never
 * overwritten — calling this repeatedly is safe and cheap.
 *
 * @param {string} [dir] - defaults to ~/.meta-skills/wiki
 * @returns {{dir: string, patternsDir: string, created: string[]}}
 *   `created` lists the paths that did not exist before this call.
 */
export function ensureWiki(dir) {
  const root = wikiDir(dir);
  const patterns = patternsDir(root);
  const created = [];

  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(patterns, { recursive: true });

  for (const name of WIKI_FILES) {
    const target = path.join(root, name);
    if (!fs.existsSync(target)) {
      atomicWriteText(target, DEFAULT_CONTENT[name]);
      created.push(target);
    }
  }

  return { dir: root, patternsDir: patterns, created };
}

// ── Index ───────────────────────────────────────────────────────────

/**
 * Read index.md. Returns '' when the wiki does not exist yet, so callers can
 * inspect a fresh workspace without throwing.
 *
 * @param {string} [dir]
 * @returns {string} index.md content
 */
export function readWikiIndex(dir) {
  const target = path.join(wikiDir(dir), 'index.md');
  try {
    return fs.readFileSync(target, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Read the wiki as a whole: index content + pattern file names (sorted).
 *
 * @param {string} [dir]
 * @returns {{index: string, patterns: string[]}}
 */
export function readWiki(dir) {
  return { index: readWikiIndex(dir), patterns: listPatterns(dir) };
}

/**
 * Replace index.md atomically. Ensures the structure exists first.
 *
 * @param {string} [dir]
 * @param {string} content - full replacement content
 * @returns {{file: string, bytes: number}}
 * @throws {WikiValidationError} on non-string content
 */
export function updateIndex(dir, content) {
  if (typeof content !== 'string') {
    throw new WikiValidationError('index content must be a string');
  }
  ensureWiki(dir);
  const target = path.join(wikiDir(dir), 'index.md');
  const text = content.endsWith('\n') ? content : `${content}\n`;
  atomicWriteText(target, text);
  return { file: target, bytes: Buffer.byteLength(text) };
}

// ── Log ─────────────────────────────────────────────────────────────

/**
 * Append one timestamped entry to logs.md. Preserves existing content —
 * the log is append-only; nothing in the wiki is ever rewritten by this
 * module except through updateIndex/updatePattern.
 *
 * @param {string} [dir]
 * @param {string} text - entry text (single line; newlines are collapsed)
 * @returns {{ts: string, line: string, file: string}}
 * @throws {WikiValidationError} on empty entry
 */
export function appendLog(dir, text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new WikiValidationError('log entry must be a non-empty string');
  }
  ensureWiki(dir);
  const target = path.join(wikiDir(dir), 'logs.md');
  const ts = new Date().toISOString();
  const entry = text.replace(/\s+/g, ' ').trim();
  const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf-8') : '# Wiki Log\n';
  const base = existing.endsWith('\n') ? existing : `${existing}\n`;
  const line = `- ${ts} ${entry}`;
  atomicWriteText(target, base + line + '\n');
  return { ts, line, file: target };
}

// ── Patterns ────────────────────────────────────────────────────────

/**
 * List pattern file names in patterns/, sorted ascending. Empty when the
 * wiki (or the subdirectory) does not exist yet.
 *
 * @param {string} [dir]
 * @returns {string[]} e.g. ['deploy-timeout.md', 'green-preflight.md']
 */
export function listPatterns(dir) {
  const patterns = patternsDir(dir);
  try {
    return fs.readdirSync(patterns).filter(f => f.endsWith('.md')).sort();
  } catch {
    return [];
  }
}

/**
 * Create a pattern page. Fails if the slug already exists — callers should
 * update the existing pattern instead of duplicating it.
 *
 * @param {string} [dir]
 * @param {string} name - pattern name (slugified; `.md` optional)
 * @param {string} content - page body, ~10-30 lines: root cause + observed
 *   sequence + concrete fix
 * @returns {{name: string, file: string}}
 * @throws {WikiValidationError|PatternExistsError}
 */
export function createPattern(dir, name, content) {
  const slug = slugifyPatternName(name);
  if (typeof content !== 'string') {
    throw new WikiValidationError('pattern content must be a string');
  }
  ensureWiki(dir);
  const target = path.join(patternsDir(dir), `${slug}.md`);
  if (fs.existsSync(target)) {
    throw new PatternExistsError(`pattern "${slug}" already exists — update it instead of duplicating`);
  }
  const text = content.endsWith('\n') ? content : `${content}\n`;
  atomicWriteText(target, text);
  return { name: slug, file: target };
}

/**
 * Read a pattern page.
 *
 * @param {string} [dir]
 * @param {string} name - pattern name (slugified; `.md` optional)
 * @returns {string} page content
 * @throws {PatternNotFoundError}
 */
export function readPattern(dir, name) {
  const slug = slugifyPatternName(name);
  const target = path.join(patternsDir(dir), `${slug}.md`);
  if (!fs.existsSync(target)) {
    throw new PatternNotFoundError(`pattern "${slug}" not found`);
  }
  return fs.readFileSync(target, 'utf-8');
}

/**
 * Replace a pattern page atomically. Fails if the pattern does not exist —
 * the wiki prefers updating an existing pattern over creating a near-duplicate.
 *
 * @param {string} [dir]
 * @param {string} name - pattern name (slugified; `.md` optional)
 * @param {string} content - full replacement content
 * @returns {{name: string, file: string, bytes: number}}
 * @throws {WikiValidationError|PatternNotFoundError}
 */
export function updatePattern(dir, name, content) {
  const slug = slugifyPatternName(name);
  if (typeof content !== 'string') {
    throw new WikiValidationError('pattern content must be a string');
  }
  const target = path.join(patternsDir(dir), `${slug}.md`);
  if (!fs.existsSync(target)) {
    throw new PatternNotFoundError(`pattern "${slug}" not found`);
  }
  const text = content.endsWith('\n') ? content : `${content}\n`;
  atomicWriteText(target, text);
  return { name: slug, file: target, bytes: Buffer.byteLength(text) };
}

// ── Skill impact ────────────────────────────────────────────────────

/**
 * Append one timestamped line to skill-impact.md — the machine-written
 * record of which skill changed and why. One line per event, so the file
 * stays greppable without a parser.
 *
 * Format: `- <ISO ts> | skill=<id> | change=<text> | pattern=<slug>`
 *
 * @param {string} [dir]
 * @param {string|{skill?: string, change?: string, pattern?: string}} entry
 * @returns {{ts: string, line: string, file: string}}
 * @throws {WikiValidationError}
 */
export function recordSkillImpact(dir, entry) {
  ensureWiki(dir);
  const target = path.join(wikiDir(dir), 'skill-impact.md');
  const ts = new Date().toISOString();

  let fields;
  if (typeof entry === 'string') {
    fields = { skill: null, change: entry, pattern: null };
  } else if (entry && typeof entry === 'object') {
    fields = {
      skill: typeof entry.skill === 'string' && entry.skill.trim() ? entry.skill.trim() : null,
      change: typeof entry.change === 'string' ? entry.change.trim() : '',
      pattern: typeof entry.pattern === 'string' && entry.pattern.trim() ? entry.pattern.trim() : null,
    };
  } else {
    throw new WikiValidationError('skill impact entry must be a string or an object');
  }

  if (!fields.skill && !fields.change) {
    throw new WikiValidationError('skill impact entry needs a skill or a change description');
  }

  const parts = [ts, `skill=${fields.skill || '(none)'}`, `change=${fields.change || '(none)'}`];
  if (fields.pattern) parts.push(`pattern=${slugifyPatternName(fields.pattern)}`);
  const line = `- ${parts.join(' | ')}`;

  const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf-8') : '# Skill Impact\n';
  const base = existing.endsWith('\n') ? existing : `${existing}\n`;
  atomicWriteText(target, base + line + '\n');
  return { ts, line, file: target };
}

// ── Status ──────────────────────────────────────────────────────────

/**
 * Snapshot of the wiki: which files exist, how many patterns, last log line.
 *
 * @param {string} [dir]
 * @returns {{dir: string, files: string[], patterns: string[], lastLog: string|null}}
 */
export function wikiStatus(dir) {
  const root = wikiDir(dir);
  const files = WIKI_FILES.filter(f => fs.existsSync(path.join(root, f)));
  return { dir: root, files, patterns: listPatterns(root), lastLog: lastEntry(path.join(root, 'logs.md')) };
}

/** Last entry line (`- ...`) of a markdown file, or null when it has none. */
function lastEntry(file) {
  try {
    const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(l => l.startsWith('- '));
    return lines.length > 0 ? lines[lines.length - 1] : null;
  } catch {
    return null;
  }
}

// ── CLI ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(0);
  const command = args[0];
  const options = { wikiDir: null, asJson: false };

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--wiki-dir' && i + 1 < args.length) {
      options.wikiDir = path.resolve(args[++i]);
    } else if (args[i] === '--json') {
      options.asJson = true;
    }
  }

  return { command, options };
}

function printUsage() {
  console.log(`Usage:
  node src/wiki.mjs init [--wiki-dir <path>] [--json]
  node src/wiki.mjs status [--wiki-dir <path>] [--json]`);
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const dir = options.wikiDir || defaultWikiDir();

  if (command === 'init') {
    const result = ensureWiki(dir);
    if (options.asJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Wiki: ${result.dir}`);
      console.log(result.created.length > 0
        ? `  created ${result.created.length} file(s)`
        : '  already initialized');
      console.log(`  patterns: ${result.patternsDir}`);
    }
    return;
  }

  if (command === 'status') {
    const status = wikiStatus(dir);
    if (options.asJson) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    console.log(`Wiki: ${status.dir}`);
    console.log(status.files.length > 0
      ? `  files:    ${status.files.join(', ')}`
      : '  files:    (not initialized)');
    console.log(`  patterns: ${status.patterns.length}`);
    for (const p of status.patterns) console.log(`    ${p}`);
    console.log(`  last log: ${status.lastLog || '(none)'}`);
    return;
  }

  printUsage();
}

const isMain = process.argv[1] && (
  process.argv[1] === fileURLToPath(import.meta.url)
  || process.argv[1].endsWith('wiki.mjs')
);
if (isMain) {
  main().catch(e => {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  });
}
