#!/usr/bin/env node

/**
 * meta-skills v1.5 — Agent Config Injection (Phase 1: Detection)
 *
 * Detects existing agent config files (CLAUDE.md, .cursorrules, AGENTS.md,
 * Gemini CLI config) in a target directory and parses their content to
 * determine whether a meta-skills scan-instructions block already exists.
 *
 * Detection is read-only: this module never writes to disk. Write-back
 * lives in the same module (Phase 2, next cycle).
 *
 * Supported file types:
 *   markdown   — CLAUDE.md, AGENTS.md
 *                delimiters: <!-- meta-skills:start --> … <!-- meta-skills:end -->
 *   text       — .cursorrules, gemini-cli config.yaml
 *                delimiters: # meta-skills:start … # meta-skills:end
 *   json       — gemini-cli config.json
 *                reserved top-level key: _meta_skills
 *
 * Usage:
 *   import { detectConfigs, parseForBlock, defaultConfigSpecs } from './agent-config.mjs';
 *
 *   const specs = defaultConfigSpecs(targetDir);
 *   const found = detectConfigs(targetDir, specs);
 *   for (const cfg of found) {
 *     const parsed = parseForBlock(fs.readFileSync(cfg.path, 'utf-8'), cfg);
 *     console.log(cfg.name, parsed.hasBlock ? 'has block' : 'no block');
 *   }
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---- Block delimiters ------------------------------------------------------

// Markdown: HTML-comment delimiters (survive markdown renderers)
export const MARKDOWN_BLOCK_START = '<!-- meta-skills:start -->';
export const MARKDOWN_BLOCK_END   = '<!-- meta-skills:end -->';

// Text / .cursorrules / YAML: line-comment delimiters
export const TEXT_BLOCK_START = '# meta-skills:start';
export const TEXT_BLOCK_END   = '# meta-skills:end';

// JSON: reserved top-level key (no comment support in JSON)
export const JSON_BLOCK_KEY = '_meta_skills';

// The block content that gets injected (single source of truth).
// Kept in this format so write-back (Phase 2) can reuse it unchanged.
export function blockContent({ mention = 'Always read ' } = {}) {
  return `${mention}~/.meta-skills/global.json and .meta-skills/project.json at startup ` +
         `— these files list all available skills with when/why context. ` +
         `Load full SKILL.md only when you decide to activate a skill.`;
}

// ---- Default config file specs --------------------------------------------

/**
 * Returns the canonical list of agent-config file specs to detect.
 * Specs with `globalOnly: true` are looked up in the user's HOME directory
 * (e.g. ~/.config/gemini-cli/config.yaml), not in the target dir.
 */
export function defaultConfigSpecs(targetDir = process.cwd()) {
  const home = os.homedir();
  return [
    {
      type: 'markdown',
      name: 'Claude Code',
      agent: 'claude-code',
      file: 'CLAUDE.md',
      path: path.join(targetDir, 'CLAUDE.md'),
      globalOnly: false,
      start: MARKDOWN_BLOCK_START,
      end: MARKDOWN_BLOCK_END,
    },
    {
      type: 'markdown',
      name: 'OpenClaw',
      agent: 'openclaw',
      file: 'AGENTS.md',
      path: path.join(targetDir, 'AGENTS.md'),
      globalOnly: false,
      start: MARKDOWN_BLOCK_START,
      end: MARKDOWN_BLOCK_END,
    },
    {
      type: 'text',
      name: 'Cursor',
      agent: 'cursor',
      file: '.cursorrules',
      path: path.join(targetDir, '.cursorrules'),
      globalOnly: false,
      start: TEXT_BLOCK_START,
      end: TEXT_BLOCK_END,
    },
    {
      type: 'text',
      name: 'Gemini CLI (YAML)',
      agent: 'gemini-cli',
      file: '.config/gemini-cli/config.yaml',
      path: path.join(home, '.config', 'gemini-cli', 'config.yaml'),
      globalOnly: true,
      start: TEXT_BLOCK_START,
      end: TEXT_BLOCK_END,
    },
    {
      type: 'json',
      name: 'Gemini CLI (JSON)',
      agent: 'gemini-cli',
      file: '.config/gemini-cli/config.json',
      path: path.join(home, '.config', 'gemini-cli', 'config.json'),
      globalOnly: true,
      key: JSON_BLOCK_KEY,
    },
  ];
}

// ---- Detection -------------------------------------------------------------

/**
 * Returns the subset of specs whose `path` actually exists on disk.
 * Wrapped in `{ spec, exists }` records for downstream use.
 */
export function detectConfigs(specs) {
  const found = [];
  for (const spec of specs) {
    if (fs.existsSync(spec.path)) {
      found.push({ spec, exists: true });
    }
  }
  return found;
}

/**
 * Reads the file at `spec.path` (if it exists) and parses it for an
 * existing meta-skills block.
 *
 * Returns:
 *   { exists: bool, hasBlock: bool, blockRange?: [start, end], blockText?: string,
 *     content: string, error?: string, contentMissing?: bool }
 *
 * - `exists` mirrors `fs.existsSync(spec.path)`.
 * - `hasBlock` is true iff a recognisable block delimiter range was found.
 * - `blockRange` is a [startIdx, endIdx] pair of character offsets into `content`
 *   (inclusive of delimiters), so callers can splice a replacement.
 * - `error` is set when the file exists but couldn't be read or parsed.
 *   `content` may then be the empty string. The caller should treat this as
 *   "couldn't decide, skip silently" rather than overwriting the file.
 */
export function parseForBlock(spec) {
  const result = {
    exists: false,
    hasBlock: false,
    blockRange: null,
    blockText: null,
    content: '',
    error: null,
  };

  if (!spec || !spec.path || !fs.existsSync(spec.path)) {
    return result;
  }
  result.exists = true;

  let content;
  try {
    content = fs.readFileSync(spec.path, 'utf-8');
  } catch (e) {
    result.error = `read failed: ${e.message}`;
    return result;
  }
  result.content = content;

  if (spec.type === 'json') {
    return parseJsonBlock(content, spec, result);
  }
  return parseTextBlock(content, spec, result);
}

// ---- Per-type parsers ------------------------------------------------------

function parseTextBlock(content, spec, result) {
  if (!spec.start || !spec.end) {
    result.error = `spec missing start/end delimiters (type=${spec.type})`;
    return result;
  }
  const startIdx = content.indexOf(spec.start);
  if (startIdx === -1) {
    return result; // hasBlock stays false
  }
  const endIdx = content.indexOf(spec.end, startIdx + spec.start.length);
  if (endIdx === -1) {
    // Start present but no end — treat as malformed; refuse to over-write.
    result.hasBlock = true;
    result.blockRange = [startIdx, startIdx + spec.start.length - 1];
    result.blockText = spec.start;
    result.error = 'unterminated block (start without end)';
    return result;
  }
  const endOfEnd = endIdx + spec.end.length;
  const lineStart = content.lastIndexOf('\n', startIdx) + 1;
  const lineEndExclusive = content.indexOf('\n', endOfEnd);
  const blockRange = [
    lineStart,
    lineEndExclusive === -1 ? content.length : lineEndExclusive + 1,
  ];
  result.hasBlock = true;
  result.blockRange = blockRange;
  result.blockText = content.slice(blockRange[0], blockRange[1]);
  return result;
}

function parseJsonBlock(content, spec, result) {
  if (!spec.key) {
    result.error = `spec missing key (type=${spec.type})`;
    return result;
  }
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    result.error = `json parse failed: ${e.message}`;
    return result;
  }
  if (parsed && Object.prototype.hasOwnProperty.call(parsed, spec.key)) {
    result.hasBlock = true;
    result.blockText = JSON.stringify(parsed[spec.key], null, 2);
  }
  return result;
}

// ---- Module entry (CLI dispatch lives in cli.mjs) -------------------------

const isMain = process.argv[1] && (
  process.argv[1] === (new URL(import.meta.url)).pathname ||
  process.argv[1].endsWith('agent-config.mjs')
);
if (isMain) {
  // Standalone: `node src/agent-config.mjs [--target <dir>]`
  const args = process.argv.slice(2);
  let targetIdx = args.indexOf('--target');
  const targetDir = targetIdx >= 0 && args[targetIdx + 1]
    ? path.resolve(args[targetIdx + 1])
    : process.cwd();
  const specs = defaultConfigSpecs(targetDir);
  const found = detectConfigs(specs);
  if (found.length === 0) {
    console.log(`agent-config: no supported config files found in ${targetDir}`);
  } else {
    console.log(`agent-config: found ${found.length} config file(s) in ${targetDir}`);
    for (const { spec } of found) {
      const parsed = parseForBlock(spec);
      const flag = parsed.hasBlock ? 'has block' : (parsed.error ? `error: ${parsed.error}` : 'no block');
      console.log(`  - ${spec.name} (${spec.file}) — ${flag}`);
    }
  }
}

export { defaultConfigSpecs as specs };
