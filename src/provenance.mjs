#!/usr/bin/env node

/**
 * meta-skills v0.2.5 — Skill Provenance (issue #40)
 *
 * Every skill carries its story: why it exists, what evidence motivated it,
 * and an append-only history of how it changed. This is the meta-skills
 * analogue of WikiSkill's PURPOSE.md — the file that maps a skill back to the
 * patterns that inspired it, so audits like "why does this rule exist?" are
 * answerable months later.
 *
 * Layout: <skillDir>/PURPOSE.md
 *
 *   # PURPOSE: <name>
 *   ## What this skill is
 *   ## Origin
 *   ## Evidence
 *   ## Evolution History   <- append-only, newest entry first
 *
 * Commands:
 *   init <skillDir> --name X [--description ..] [--origin ..] [--overwrite]
 *     Create PURPOSE.md from the template.
 *
 *   append <skillDir> --summary ".." [--version ..] [--date ..]
 *     Append-only: insert one history entry directly under the header.
 *
 *   show <skillDir>
 *     Print PURPOSE.md raw.
 *
 *   check [--global-json <p>] [--json]
 *     List skills whose resolved directory has no PURPOSE.md.
 *
 * Integration points (documented, not wired here):
 *   - evolution.mjs calls ensurePurpose()/appendHistory() after approve.
 *   - validate.mjs --check-provenance reports missing PURPOSE.md as warnings.
 *   - cli.mjs may expose `meta-skills provenance <subcommand>` later.
 *
 * Zero deps — Node stdlib only.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PURPOSE_FILENAME = 'PURPOSE.md';
const HISTORY_HEADER = '## Evolution History';

function defaultGlobalJson() {
  return path.join(os.homedir(), '.meta-skills', 'global.json');
}

// ── Entry formatting ──────────────────────────────────────────────────

/**
 * Render one history line: `- <date> <version?> — <summary>`.
 * Newest entries are inserted first, so the file reads newest→oldest.
 */
function formatHistoryEntry(entry) {
  const e = entry || {};
  const date = e.date || new Date().toISOString().slice(0, 10);
  const version = e.version ? ` ${e.version}` : '';
  const summary = e.summary || '(no summary)';
  return `- ${date}${version} — ${summary}`;
}

// ── Render ────────────────────────────────────────────────────────────

/**
 * Render the full PURPOSE.md text from structured data.
 * @param {object} data
 * @param {string} data.name
 * @param {string} [data.description]
 * @param {string} [data.origin]
 * @param {string[]} [data.evidence]
 * @param {Array<{date, version, summary}>} [data.history]
 * @returns {string} markdown
 */
function renderPurpose(data = {}) {
  const name = data.name || '(unnamed skill)';
  const out = [`# PURPOSE: ${name}`, ''];

  out.push('## What this skill is', '');
  out.push(data.description || '(no description recorded)', '');

  out.push('## Origin', '');
  out.push(data.origin || '(no origin recorded)', '');

  out.push('## Evidence', '');
  const evidence = Array.isArray(data.evidence) ? data.evidence : [];
  if (evidence.length === 0) {
    out.push('- (no evidence recorded)');
  } else {
    for (const item of evidence) out.push(`- ${item}`);
  }
  out.push('');

  out.push(HISTORY_HEADER, '');
  const history = Array.isArray(data.history) ? data.history : [];
  for (const entry of history) out.push(formatHistoryEntry(entry));
  out.push('');

  return out.join('\n');
}

// ── Atomic write helper ───────────────────────────────────────────────

function atomicWrite(target, content) {
  const tmpPath = target + '.tmp';
  fs.writeFileSync(tmpPath, content, 'utf-8');
  fs.renameSync(tmpPath, target);
  return target;
}

// ── Create ────────────────────────────────────────────────────────────

/**
 * Create PURPOSE.md from the template.
 * Refuses to clobber an existing file unless opts.overwrite is true.
 * @param {string} skillDir
 * @param {object} data — see renderPurpose
 * @param {object} [opts]
 * @param {boolean} [opts.overwrite]
 * @returns {string} path written
 */
function writePurpose(skillDir, data, opts = {}) {
  if (!skillDir) throw new Error('skillDir is required');
  const target = path.join(skillDir, PURPOSE_FILENAME);

  if (fs.existsSync(target) && !opts.overwrite) {
    throw new Error(`PURPOSE.md already exists: ${target} (use opts.overwrite to replace)`);
  }

  if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true });
  return atomicWrite(target, renderPurpose(data));
}

/**
 * Ensure PURPOSE.md exists; create it from the template when missing.
 * Returns the path. Never overwrites an existing file.
 */
function ensurePurpose(skillDir, data, opts = {}) {
  const target = path.join(skillDir, PURPOSE_FILENAME);
  if (fs.existsSync(target)) return target;
  return writePurpose(skillDir, data, opts);
}

// ── Append-only history ───────────────────────────────────────────────

/**
 * Append a history entry as the FIRST list item under `## Evolution History`
 * (exact-substring insertion directly after the header line), then atomic write.
 * Existing entries are preserved — the file is append-only, never rewritten.
 * @param {string} skillDir
 * @param {{date?: string, version?: string, summary: string}} entry
 * @returns {string} path written
 */
function appendHistory(skillDir, entry) {
  if (!skillDir) throw new Error('skillDir is required');
  const target = path.join(skillDir, PURPOSE_FILENAME);

  if (!fs.existsSync(target)) {
    throw new Error(`PURPOSE.md missing: ${target} (run provenance init first)`);
  }

  const content = fs.readFileSync(target, 'utf-8');
  const lines = content.split('\n');
  const headerIdx = lines.findIndex(l => l.trim() === HISTORY_HEADER);
  if (headerIdx < 0) {
    throw new Error(`no "${HISTORY_HEADER}" section in ${target}`);
  }

  lines.splice(headerIdx + 1, 0, formatHistoryEntry(entry));
  return atomicWrite(target, lines.join('\n'));
}

// ── Read / presence ───────────────────────────────────────────────────

/**
 * Read PURPOSE.md raw text. Throws if missing.
 */
function readPurpose(skillDir) {
  const target = path.join(skillDir, PURPOSE_FILENAME);
  return fs.readFileSync(target, 'utf-8');
}

function hasPurpose(skillDir) {
  return fs.existsSync(path.join(skillDir, PURPOSE_FILENAME));
}

/**
 * Skill ids whose resolved skill directory (dirname of entry.path) has no
 * PURPOSE.md. Entries with a missing/unresolvable path are skipped.
 * @param {object} index — parsed global.json
 * @returns {string[]}
 */
function skillsMissingProvenance(index) {
  const missing = [];
  for (const skill of (index && index.skills) || []) {
    if (!skill || !skill.path) continue;
    const dir = path.dirname(skill.path);
    if (!fs.existsSync(dir)) continue; // unresolvable — skip silently
    if (!hasPurpose(dir)) missing.push(skill.id);
  }
  return missing;
}

// ── CLI ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(0);
  const command = args[0];
  const options = {
    skillDir: null,
    name: null,
    description: null,
    origin: null,
    summary: null,
    version: null,
    date: null,
    overwrite: false,
    globalJsonPath: null,
    asJson: false,
  };

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--name' && i + 1 < args.length) options.name = args[++i];
    else if (args[i] === '--description' && i + 1 < args.length) options.description = args[++i];
    else if (args[i] === '--origin' && i + 1 < args.length) options.origin = args[++i];
    else if (args[i] === '--summary' && i + 1 < args.length) options.summary = args[++i];
    else if (args[i] === '--version' && i + 1 < args.length) options.version = args[++i];
    else if (args[i] === '--date' && i + 1 < args.length) options.date = args[++i];
    else if (args[i] === '--overwrite') options.overwrite = true;
    else if (args[i] === '--global-json' && i + 1 < args.length) options.globalJsonPath = path.resolve(args[++i]);
    else if (args[i] === '--json') options.asJson = true;
    else if (!options.skillDir) options.skillDir = path.resolve(args[i]);
  }

  return { command, options };
}

const USAGE = `Usage:
  meta-skills provenance init <skillDir> --name X [--description ..] [--origin ..] [--overwrite]
  meta-skills provenance append <skillDir> --summary ".." [--version ..] [--date YYYY-MM-DD]
  meta-skills provenance show <skillDir>
  meta-skills provenance check [--global-json <path>] [--json]`;

async function cmdProvenance(argv) {
  const { command, options } = parseArgs(argv);

  switch (command) {
    case 'init': {
      if (!options.skillDir) throw new Error('skillDir is required');
      const written = writePurpose(options.skillDir, {
        name: options.name || path.basename(options.skillDir),
        description: options.description,
        origin: options.origin,
        evidence: [],
        history: [],
      }, { overwrite: options.overwrite });
      console.log(`✓ ${written}`);
      break;
    }

    case 'append': {
      if (!options.skillDir) throw new Error('skillDir is required');
      if (!options.summary) throw new Error('--summary is required');
      const written = appendHistory(options.skillDir, {
        date: options.date,
        version: options.version,
        summary: options.summary,
      });
      console.log(`✓ appended: ${formatHistoryEntry({
        date: options.date, version: options.version, summary: options.summary,
      })}`);
      console.log(`  ${written}`);
      break;
    }

    case 'show': {
      if (!options.skillDir) throw new Error('skillDir is required');
      console.log(readPurpose(options.skillDir));
      break;
    }

    case 'check': {
      const gjPath = options.globalJsonPath || defaultGlobalJson();
      let index;
      try {
        index = JSON.parse(fs.readFileSync(gjPath, 'utf-8'));
      } catch (e) {
        throw new Error(`cannot read ${gjPath} — ${e.message}`);
      }
      const missing = skillsMissingProvenance(index);
      if (options.asJson) {
        console.log(JSON.stringify({ globalJson: gjPath, missing, total: missing.length }, null, 2));
      } else if (missing.length === 0) {
        console.log(`✓ ${gjPath}: all resolvable skills have ${PURPOSE_FILENAME}`);
      } else {
        console.log(`⚠ ${missing.length} skill(s) missing ${PURPOSE_FILENAME}:`);
        for (const id of missing) console.log(`    ${id}`);
      }
      break;
    }

    default:
      console.log(USAGE);
      process.exit(0);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(USAGE);
    process.exit(0);
  }
  try {
    await cmdProvenance(args);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
}

const isMain = process.argv[1] && (
  process.argv[1] === fileURLToPath(import.meta.url)
  || process.argv[1].endsWith('provenance.mjs')
);
if (isMain) main();

export {
  PURPOSE_FILENAME,
  HISTORY_HEADER,
  formatHistoryEntry,
  renderPurpose,
  writePurpose,
  ensurePurpose,
  appendHistory,
  readPurpose,
  hasPurpose,
  skillsMissingProvenance,
  defaultGlobalJson,
};
