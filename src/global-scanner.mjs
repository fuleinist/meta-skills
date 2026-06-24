#!/usr/bin/env node

/**
 * meta-skills v0.1 — Global Scanner
 *
 * Scans agent skill directories (Claude Code, Cursor, OpenClaw, Hermes)
 * and generates ~/.meta-skills/global.json
 *
 * Usage: node src/global-scanner.mjs [--out <path>] [--dirs <dir1,dir2,...>]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_URL = 'https://meta-skills.dev/schema/v1.json';

// ── Default agent skill directories ──────────────────────────────────
const DEFAULT_DIRS = [
  // Claude Code
  path.join(os.homedir(), '.claude', 'skills'),
  // Cursor
  path.join(os.homedir(), '.cursor', 'skills'),
  // OpenClaw
  path.join(os.homedir(), '.openclaw', 'skills'),
  // Hermes
  path.join(os.homedir(), '.hermes', 'skills'),
];

// ── Helpers ───────────────────────────────────────────────────────────

function parseFrontmatter(text) {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  const yaml = match[1];
  const obj = {};
  for (const line of yaml.split('\n')) {
    const kv = line.match(/^\s*(\w+)\s*:\s*(.+)$/);
    if (kv) {
      let val = kv[2].trim();
      // Strip quotes
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      obj[kv[1]] = val;
    }
  }
  return obj;
}

function scanDir(skillsDir) {
  const entries = [];
  if (!fs.existsSync(skillsDir)) return entries;

  let skillDirs;
  try {
    skillDirs = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return entries;
  }

  for (const dirent of skillDirs) {
    if (!dirent.isDirectory()) continue;
    const skillPath = path.join(skillsDir, dirent.name, 'SKILL.md');
    if (!fs.existsSync(skillPath)) continue;

    const content = fs.readFileSync(skillPath, 'utf-8');
    const frontmatter = parseFrontmatter(content);
    const id = frontmatter.name || dirent.name;
    const desc = frontmatter.description || '';

    entries.push({
      id,
      when: desc,
      why: desc,
      path: skillPath,
      priority: 'medium',
      usage_count: 0,
      last_used: null,
    });
  }
  return entries;
}

function mergeEntries(entries) {
  const map = new Map();
  for (const e of entries) {
    if (map.has(e.id)) {
      const existing = map.get(e.id);
      // Prefer entry with more specific path (shorter = more general)
      if (e.path.length < existing.path.length) {
        map.set(e.id, e);
      }
    } else {
      map.set(e.id, e);
    }
  }
  return Array.from(map.values());
}

// ── Main ──────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  let outPath = path.join(os.homedir(), '.meta-skills', 'global.json');
  let dirs = DEFAULT_DIRS;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out' && i + 1 < args.length) {
      outPath = path.resolve(args[++i]);
    }
    if (args[i] === '--dirs' && i + 1 < args.length) {
      dirs = args[++i].split(',').map(s => s.trim());
    }
  }

  const allEntries = [];
  for (const dir of dirs) {
    const found = scanDir(dir);
    allEntries.push(...found);
  }

  const merged = mergeEntries(allEntries);

  const output = {
    $schema: SCHEMA_URL,
    version: '1.0',
    generated: new Date().toISOString(),
    source: 'global',
    skills: merged,
    stale: [],
  };

  const outDir = path.dirname(outPath);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n', 'utf-8');
  console.log(`✓ global.json written to ${outPath}`);
  console.log(`  ${merged.length} skills found across ${dirs.length} directories`);
}

import os from 'node:os';
main();
