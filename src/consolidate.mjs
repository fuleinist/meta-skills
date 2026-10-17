#!/usr/bin/env node

/**
 * meta-skills v1.9 — Consolidation step (issue #38)
 *
 * Turns raw evidence (usage-log events, execution traces) into structured
 * knowledge: wiki pattern pages with root-cause analysis, plus index + log
 * upkeep.
 *
 * Target layout (created on demand):
 *   <dir>/patterns/<name>.md   — one page per pattern
 *   <dir>/index.md             — catalog, one line per pattern
 *   <dir>/logs.md              — timestamped consolidation activity log
 *
 * Commands:
 *   consolidate --input <file|dir> [--dir <wikiDir>] [--min-evidence N]
 *               [--write] [--json]
 *     Group evidence into pattern candidates. Dry-run by default: nothing is
 *     written unless --write is passed.
 *
 * Integration points:
 *   - Raw trace capture (issue #37, src/traces.mjs) feeds `traceId` values
 *     into evidence items; this module does not import it.
 *   - The wiki layer (issue #33, src/wiki.mjs) owns page rendering elsewhere;
 *     this module writes plain markdown pages directly so it stays standalone.
 *
 * Zero new npm deps — Node stdlib only.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MAX_EVIDENCE_ENTRIES = 500;
const EXCERPT_MAX = 60;
const SIGNATURE_MAX = 6;

// ── Default paths ──────────────────────────────────────────────────────

function defaultWikiDir() {
  return path.join(os.homedir(), '.meta-skills', 'wiki');
}

// ── Slug ─────────────────────────────────────────────────────────────────

/**
 * Normalize a pattern name into a safe filename stem.
 * Lowercase, keep [a-z0-9-], collapse runs, strip a trailing `.md`.
 * @param {string} name
 * @returns {string} slug (no extension)
 */
function slugifyPatternName(name) {
  if (!name || typeof name !== 'string') return '';
  const base = name.replace(/\.md$/i, '').toLowerCase();
  return base
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ── Atomic write ─────────────────────────────────────────────────────────

/**
 * Write via temp + rename so a crash never leaves a half-written page.
 * The temp file is removed on failure — no `.tmp` leftovers.
 */
function atomicWrite(filePath, content) {
  const tmpPath = `${filePath}.tmp`;
  try {
    fs.writeFileSync(tmpPath, content, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
    throw e;
  }
}

// ── Pattern rendering ────────────────────────────────────────────────────

/**
 * Render a pattern page with the enforced section order:
 *   # <name> / ## Description / ## Root Cause / ## Evidence / ## Fix / ## Last Updated
 * @param {{name: string, description: string, rootCause: string, evidence: string[], fix: string, lastUpdated?: string}} pattern
 * @returns {string} markdown
 */
function renderPattern(pattern) {
  const name = pattern.name || '(unnamed pattern)';
  const evidence = (pattern.evidence || []).map(line => (line.startsWith('- ') ? line : `- ${line}`));
  const lastUpdated = pattern.lastUpdated || new Date().toISOString();

  return [
    `# ${name}`,
    '',
    '## Description',
    '',
    pattern.description || '(no description)',
    '',
    '## Root Cause',
    '',
    pattern.rootCause || '(no root cause recorded)',
    '',
    '## Evidence',
    '',
    ...(evidence.length ? evidence : ['- (no evidence recorded)']),
    '',
    '## Fix',
    '',
    pattern.fix || '(no fix recorded)',
    '',
    '## Last Updated',
    '',
    lastUpdated,
    '',
  ].join('\n');
}

// ── Pattern pages ────────────────────────────────────────────────────────

/**
 * Upsert one pattern page.
 *
 * Update-don't-duplicate rule: when `<name>.md` already exists, the page is
 * edited in place — new evidence bullets are inserted right after the
 * `## Evidence` header (exact-substring insertion) and `## Last Updated` is
 * refreshed. The file is never rewritten from scratch and never duplicated.
 *
 * @param {string} dir - wiki dir
 * @param {object} pattern - as accepted by renderPattern
 * @returns {{file: string, slug: string, created: boolean, addedEvidence: number}}
 */
function upsertPattern(dir, pattern) {
  const slug = slugifyPatternName(pattern.name);
  if (!slug) throw new Error('upsertPattern: pattern name required');

  const patternsDir = path.join(dir, 'patterns');
  fs.mkdirSync(patternsDir, { recursive: true });
  const file = path.join(patternsDir, `${slug}.md`);
  const lastUpdated = pattern.lastUpdated || new Date().toISOString();

  if (!fs.existsSync(file)) {
    const content = renderPattern({ ...pattern, lastUpdated });
    atomicWrite(file, content);
    return { file, slug, created: true, addedEvidence: (pattern.evidence || []).length };
  }

  let content;
  try {
    content = fs.readFileSync(file, 'utf-8');
  } catch (e) {
    throw new Error(`upsertPattern: cannot read ${file}: ${e.message}`);
  }

  const bullets = (pattern.evidence || []).map(line => (line.startsWith('- ') ? line : `- ${line}`));

  // Exact-substring insertion right after the `## Evidence` header.
  const header = '## Evidence';
  const idx = content.indexOf(header);
  if (idx >= 0 && bullets.length > 0) {
    let pos = idx + header.length;
    if (content.slice(pos, pos + 2) === '\n\n') pos += 2;
    content = content.slice(0, pos) + bullets.join('\n') + '\n' + content.slice(pos);
  } else if (bullets.length > 0) {
    // Legacy page without the section — append it rather than lose evidence.
    content = content.replace(/\s+$/, '') + `\n\n${header}\n\n${bullets.join('\n')}\n`;
  }

  // Refresh `## Last Updated`.
  const stampHeader = '## Last Updated';
  const stampIdx = content.indexOf(stampHeader);
  if (stampIdx >= 0) {
    const after = content.slice(stampIdx + stampHeader.length);
    const nl = after.indexOf('\n');
    if (nl >= 0) {
      content = content.slice(0, stampIdx + stampHeader.length) + '\n' + lastUpdated + '\n' + after.slice(nl + 1);
    } else {
      content = content.slice(0, stampIdx + stampHeader.length) + '\n' + lastUpdated + '\n';
    }
  } else {
    content = content.replace(/\s+$/, '') + `\n\n${stampHeader}\n\n${lastUpdated}\n`;
  }

  atomicWrite(file, content);
  return { file, slug, created: false, addedEvidence: bullets.length };
}

// ── Index upkeep ─────────────────────────────────────────────────────────

/** First sentence of a description (used for the index line). */
function firstSentence(text) {
  const s = (text || '').trim().replace(/\s+/g, ' ');
  if (!s) return '';
  const m = s.match(/^[^.!?;]+/);
  return (m ? m[0] : s).trim();
}

/** Read name + description from an existing pattern page. */
function readPatternPage(file) {
  const content = fs.readFileSync(file, 'utf-8');
  const nameMatch = content.match(/^#\s+(.+)$/m);
  const descMatch = content.match(/^##\s+Description\s*\n+\n?([^\n]*)/m);
  return {
    name: nameMatch ? nameMatch[1].trim() : path.basename(file).replace(/\.md$/, ''),
    description: descMatch ? descMatch[1].trim() : '',
  };
}

/**
 * Rewrite `index.md`: one sorted line per pattern page.
 * @param {string} dir - wiki dir
 * @returns {Array<{name: string, file: string, description: string}>}
 */
function updateIndex(dir) {
  const patternsDir = path.join(dir, 'patterns');
  let files;
  try {
    files = fs.readdirSync(patternsDir).filter(f => f.endsWith('.md'));
  } catch {
    files = [];
  }

  const entries = files.map(f => {
    const full = path.join(patternsDir, f);
    const { name, description } = readPatternPage(full);
    return { name, file: `patterns/${f}`, description: firstSentence(description) };
  }).sort((a, b) => a.name.localeCompare(b.name));

  const lines = ['# Pattern Index', ''];
  if (entries.length === 0) {
    lines.push('- (no patterns yet)');
  } else {
    for (const e of entries) {
      lines.push(`- [${e.name}](${e.file}): ${e.description || '(no description)'}`);
    }
  }

  atomicWrite(path.join(dir, 'index.md'), lines.join('\n') + '\n');
  return entries;
}

// ── Log upkeep ───────────────────────────────────────────────────────────

/**
 * Append one timestamped summary line to `logs.md` (atomic read-append-write).
 * @param {string} dir - wiki dir
 * @param {string} entry
 * @returns {{file: string, line: string}}
 */
function appendLog(dir, entry) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'logs.md');

  let content = '';
  try {
    content = fs.readFileSync(file, 'utf-8');
  } catch {
    content = '# Consolidation Log\n';
  }

  const line = `- ${new Date().toISOString()} ${entry}`;
  const next = content.replace(/\s+$/, '') + '\n' + line + '\n';
  atomicWrite(file, next);
  return { file, line };
}
