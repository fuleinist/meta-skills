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

// ── Signature extraction ─────────────────────────────────────────────────

// Inline copy of the selfheal stopword set (kept here so this module stays
// standalone — src/selfheal.mjs is not imported by issue #38).
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'was', 'were', 'are', 'is',
  'from', 'have', 'has', 'had', 'not', 'but', 'you', 'your', 'our', 'its',
  'can', 'could', 'should', 'would', 'will', 'shall', 'please', 'when',
  'what', 'which', 'who', 'how', 'why', 'then', 'than', 'them', 'they',
  'there', 'here', 'into', 'out', 'about', 'after', 'before', 'over',
  'under', 'again', 'very', 'just', 'also', 'only', 'more', 'most', 'some',
  'any', 'all', 'each', 'every', 'been', 'being', 'does', 'did', 'doing',
  'want', 'need', 'make', 'made', 'using', 'use', 'used', 'like', 'get',
  'got', 'let', 'say', 'said', 'see', 'saw', 'one', 'two', 'now', 'still',
  'skill', 'failed', 'failure', 'error', 'meta', 'skills',
]);

/**
 * Deterministic signature from an excerpt: tokenize → lowercase → strip
 * stopwords/markdown → len>=3 → sort by (freq desc, alpha asc) → top <=6.
 * @param {string} text
 * @param {number} [max=SIGNATURE_MAX]
 * @returns {string[]}
 */
function extractSignature(text, max = SIGNATURE_MAX) {
  if (!text || typeof text !== 'string') return [];

  const cleaned = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/[#*_>\-\[\](){}|]/g, ' ')
    .toLowerCase();

  const freq = new Map();
  for (const raw of cleaned.split(/[^a-z0-9]+/)) {
    const tok = raw.trim();
    if (tok.length < 3 || STOPWORDS.has(tok) || /^\d+$/.test(tok)) continue;
    freq.set(tok, (freq.get(tok) || 0) + 1);
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([tok]) => tok);
}

/** Evidence bullet: `- <ts> <skill> [trace <id>] — <excerpt first 60 chars>` */
function evidenceBullet(item) {
  const ts = item.timestamp || 'unknown';
  const skill = item.skill || 'unknown';
  const trace = item.traceId ? ` [trace ${item.traceId}]` : '';
  const excerpt = String(item.excerpt || '').replace(/\s+/g, ' ').trim().slice(0, EXCERPT_MAX) || '(no excerpt)';
  return `- ${ts} ${skill}${trace} — ${excerpt}`;
}

// ── Grouping ─────────────────────────────────────────────────────────────

/**
 * Group evidence items by (skill, signature).
 * @param {Array<object>} evidence
 * @returns {Map<string, {skill: string, signature: string[], items: Array<object>}>}
 */
function groupEvidence(evidence) {
  const groups = new Map();

  for (const item of evidence) {
    if (!item || typeof item !== 'object') continue;
    const outcome = item.outcome === 'success' ? 'success' : 'failure';
    const skill = item.skill || 'unknown';
    const signature = extractSignature(item.excerpt);
    const key = `${outcome}::${skill}::${signature.join('-') || 'unknown'}`;

    if (!groups.has(key)) groups.set(key, { outcome, skill, signature, items: [] });
    groups.get(key).items.push(item);
  }

  for (const group of groups.values()) {
    group.items.sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
  }

  return groups;
}

/**
 * Turn one qualifying group into a pattern candidate.
 * @param {{outcome: string, skill: string, signature: string[], items: Array<object>}} group
 * @returns {object} pattern accepted by upsertPattern
 */
function buildPattern(group) {
  const sigSlug = slugifyPatternName(group.signature.join('-') || 'unknown');
  const skillSlug = slugifyPatternName(group.skill) || 'unknown';
  const keywords = group.signature.length ? group.signature.join(', ') : '(no keywords)';
  const evidence = group.items.map(evidenceBullet);

  if (group.outcome === 'success') {
    return {
      name: `success-${skillSlug}-${sigSlug}`,
      description: `Effective strategy for ${group.skill}`,
      rootCause: `Observed consistent success: ${keywords}`,
      evidence,
      fix: `Reinforce this approach in ${group.skill} guidance.`,
    };
  }

  return {
    name: `failure-${skillSlug}-${sigSlug}`,
    description: `Recurring failure pattern for ${group.skill}`,
    rootCause: `≥${group.items.length} recorded failures share signature: ${keywords}; likely gap in guidance/triggers (see evidence)`,
    evidence,
    fix: `Review guidance for ${group.skill}: add anti-pattern notes or tighten triggers.`,
  };
}

// ── Orchestrator ─────────────────────────────────────────────────────────

/**
 * Consolidate raw evidence into wiki pattern pages.
 *
 * Dry-run by default: everything is computed, nothing is written. Writes
 * happen only when `opts.write === true` (CLI `--write`).
 *
 * @param {string} dir - wiki dir (defaultWikiDir() when omitted)
 * @param {Array<{skill: string, outcome: 'failure'|'success', timestamp?: string, excerpt?: string, traceId?: string}>} evidence
 * @param {object} [opts]
 * @param {number} [opts.minEvidence=2] - minimum group size to become a pattern
 * @param {boolean} [opts.write] - apply writes
 * @param {boolean} [opts.dryRun] - force dry-run even with --write
 * @returns {{dryRun: boolean, created: string[], updated: string[], evidenceCount: number, skippedBelowThreshold: number}}
 */
function consolidate(dir, evidence, opts = {}) {
  const wikiDir = dir || defaultWikiDir();
  const minEvidence = Number.isInteger(opts.minEvidence) && opts.minEvidence > 0 ? opts.minEvidence : 2;
  const apply = opts.write === true && opts.dryRun !== true;
  const dryRun = !apply;

  const items = Array.isArray(evidence) ? evidence : [];
  const groups = groupEvidence(items);

  const created = [];
  const updated = [];
  let skippedBelowThreshold = 0;

  for (const group of groups.values()) {
    if (group.items.length < minEvidence) {
      skippedBelowThreshold++;
      continue;
    }

    const pattern = buildPattern(group);
    const slug = slugifyPatternName(pattern.name);

    if (dryRun) {
      // Compute the outcome without touching disk.
      (fs.existsSync(path.join(wikiDir, 'patterns', `${slug}.md`)) ? updated : created).push(pattern.name);
      continue;
    }

    const res = upsertPattern(wikiDir, pattern);
    (res.created ? created : updated).push(pattern.name);
  }

  created.sort();
  updated.sort();

  if (!dryRun) {
    updateIndex(wikiDir);
    appendLog(wikiDir, `consolidation: ${created.length} created, ${updated.length} updated ` +
      `from ${items.length} evidence item(s), ${skippedBelowThreshold} group(s) below threshold ${minEvidence}`);
  }

  return { dryRun, created, updated, evidenceCount: items.length, skippedBelowThreshold };
}

// ── Evidence loading ─────────────────────────────────────────────────────

/**
 * Load evidence items from a `.jsonl` file or a directory of `.jsonl` files.
 * Corrupt lines are skipped; total entries are capped at 500.
 * @param {string} inputPath
 * @param {{cap?: number}} [opts]
 * @returns {Array<object>}
 */
function loadEvidence(inputPath, opts = {}) {
  const cap = opts.cap ?? MAX_EVIDENCE_ENTRIES;
  let files = [];
  let baseDir = '';

  try {
    const stat = fs.statSync(inputPath);
    if (stat.isDirectory()) {
      baseDir = inputPath;
      files = fs.readdirSync(inputPath).filter(f => f.endsWith('.jsonl')).sort();
    } else {
      baseDir = path.dirname(inputPath);
      files = [path.basename(inputPath)];
    }
  } catch {
    return [];
  }

  const items = [];
  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(path.join(baseDir, file), 'utf-8');
    } catch {
      continue;
    }

    for (const line of content.split('\n')) {
      if (items.length >= cap) return items;
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const item = JSON.parse(trimmed);
        if (item && typeof item === 'object' && !Array.isArray(item)) items.push(item);
      } catch {
        // skip corrupt lines
      }
    }
  }

  return items;
}

// ── CLI ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const options = {
    input: null,
    wikiDir: null,
    minEvidence: 2,
    write: false,
    asJson: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input' && i + 1 < argv.length) options.input = path.resolve(argv[++i]);
    else if (a === '--dir' && i + 1 < argv.length) options.wikiDir = path.resolve(argv[++i]);
    else if (a === '--min-evidence' && i + 1 < argv.length) options.minEvidence = parseInt(argv[++i], 10) || 2;
    else if (a === '--write') options.write = true;
    else if (a === '--json') options.asJson = true;
  }

  return options;
}

async function cmdConsolidate(argv) {
  const options = parseArgs(argv);
  if (!options.input) throw new Error('consolidate: --input <file|dir> required');

  const wikiDir = options.wikiDir || defaultWikiDir();
  const evidence = loadEvidence(options.input);
  const result = consolidate(wikiDir, evidence, { minEvidence: options.minEvidence, write: options.write });

  if (options.asJson) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  console.log(`Consolidation ${result.dryRun ? '(dry-run — nothing written)' : '(applied)'}`);
  console.log(`  wiki: ${wikiDir}`);
  console.log(`  evidence: ${result.evidenceCount} item(s), ${result.skippedBelowThreshold} group(s) below threshold`);

  if (result.created.length) {
    console.log(`  created (${result.created.length}):`);
    for (const name of result.created) console.log(`    + ${name}`);
  }
  if (result.updated.length) {
    console.log(`  updated (${result.updated.length}):`);
    for (const name of result.updated) console.log(`    ~ ${name}`);
  }
  if (!result.created.length && !result.updated.length) {
    console.log('  No pattern reached the evidence threshold — nothing to write.');
  }
  if (result.dryRun) {
    console.log('\n  Re-run with --write to apply.');
  }

  return result;
}

// ── Standalone entry ─────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(`Usage:
  meta-skills consolidate --input <file|dir> [--dir <wikiDir>] [--min-evidence N] [--write] [--json]`);
    process.exit(0);
  }

  try {
    await cmdConsolidate(args);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
}

const isMain = process.argv[1] && (
  process.argv[1] === fileURLToPath(import.meta.url)
  || process.argv[1].endsWith('consolidate.mjs')
);
if (isMain) main();

export {
  defaultWikiDir,
  slugifyPatternName,
  renderPattern,
  upsertPattern,
  updateIndex,
  appendLog,
  extractSignature,
  evidenceBullet,
  groupEvidence,
  buildPattern,
  consolidate,
  loadEvidence,
  cmdConsolidate,
};
