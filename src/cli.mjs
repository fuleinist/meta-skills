#!/usr/bin/env node

/**
 * meta-skills v1.0 — CLI Entry Point
 *
 * Unified CLI that ties all modules together.
 *
 * Usage:
 *   meta-skills init --global          # Scan global skill dirs → global.json
 *   meta-skills init --local           # Scan project → project.json
 *   meta-skills record <skill-id>      # Record skill activation
 *   meta-skills aggregate              # Aggregate usage logs
 *   meta-skills improve                # Self-improvement loop
 *   meta-skills maintain               # Full maintenance run
 *   meta-skills validate <file>        # Validate against schema
 *   meta-skills status                 # Show index summary
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf-8'));

// ── Import all modules ────────────────────────────────────────────────

async function loadModule(name) {
  return import(path.resolve(__dirname, name));
}

// ── Commands ──────────────────────────────────────────────────────────

async function cmdInit(args) {
  const isGlobal = args.includes('--global');
  const isLocal = args.includes('--local');

  if (isGlobal) {
    const { default: scanner } = await loadModule('global-scanner.mjs');
    // We need to re-export main as a callable
    const outIdx = args.indexOf('--out');
    const outPath = outIdx >= 0 ? path.resolve(args[outIdx + 1]) : null;
    const dirsIdx = args.indexOf('--dirs');
    const dirs = dirsIdx >= 0 ? args[dirsIdx + 1].split(',').map(s => s.trim()) : null;

    // Call scanner programmatically
    const SCHEMA_URL = 'https://meta-skills.dev/schema/v1.json';
    const DEFAULT_DIRS = [
      path.join(os.homedir(), '.claude', 'skills'),
      path.join(os.homedir(), '.cursor', 'skills'),
      path.join(os.homedir(), '.openclaw', 'skills'),
      path.join(os.homedir(), '.hermes', 'skills'),
    ];

    const scanDirs = dirs || DEFAULT_DIRS;
    const allEntries = [];
    for (const dir of scanDirs) {
      const found = scanDir(dir);
      allEntries.push(...found);
    }
    const merged = mergeEntries(allEntries);

    const outputPath = outPath || path.join(os.homedir(), '.meta-skills', 'global.json');
    const outDir = path.dirname(outputPath);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const output = {
      $schema: SCHEMA_URL,
      version: '1.0',
      generated: new Date().toISOString(),
      source: 'global',
      skills: merged,
      stale: [],
    };

    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n', 'utf-8');
    console.log(`✓ global.json written to ${outputPath}`);
    console.log(`  ${merged.length} skills found`);
  }

  if (isLocal) {
    const projectDir = process.cwd();
    const { default: projectScanner } = await loadModule('project-scanner.mjs');

    const readme = readIfExists(path.join(projectDir, 'README.md'));
    const projectName = readme
      ? (readme.match(/^#\s+(.+)/m)?.[1]?.trim() || path.basename(projectDir))
      : path.basename(projectDir);

    const outputPath = path.join(projectDir, '.meta-skills', 'project.json');
    const outDir = path.dirname(outputPath);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const output = {
      $schema: 'https://meta-skills.dev/schema/v1.json',
      version: '1.0',
      generated: new Date().toISOString(),
      source: 'project',
      project_context: {
        name: projectName,
        tech_stack: detectTechStack(projectDir),
        key_files: detectKeyFiles(projectDir),
        patterns: detectPatterns(readme),
      },
      skills: scanLocalSkills(projectDir),
    };

    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n', 'utf-8');
    console.log(`✓ project.json written to ${outputPath}`);
    console.log(`  project: ${projectName}`);
  }
}

function scanDir(skillsDir) {
  const entries = [];
  if (!fs.existsSync(skillsDir)) return entries;
  let skillDirs;
  try { skillDirs = fs.readdirSync(skillsDir, { withFileTypes: true }); } catch { return entries; }
  for (const dirent of skillDirs) {
    if (!dirent.isDirectory()) continue;
    const skillPath = path.join(skillsDir, dirent.name, 'SKILL.md');
    if (!fs.existsSync(skillPath)) continue;
    const content = fs.readFileSync(skillPath, 'utf-8');
    const frontmatter = parseFrontmatter(content);
    entries.push({
      id: frontmatter.name || dirent.name,
      when: frontmatter.description || '',
      why: frontmatter.description || '',
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
      if (e.path.length < existing.path.length) map.set(e.id, e);
    } else map.set(e.id, e);
  }
  return Array.from(map.values());
}

function parseFrontmatter(text) {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  const obj = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^\s*(\w+)\s*:\s*(.+)$/);
    if (kv) {
      let val = kv[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      obj[kv[1]] = val;
    }
  }
  return obj;
}

function readIfExists(filePath) {
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
}

function detectTechStack(projectDir) {
  const stack = new Set();
  const pkgContent = readIfExists(path.join(projectDir, 'package.json'));
  if (pkgContent) {
    try {
      const pkg = JSON.parse(pkgContent);
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.react || deps['react-dom']) stack.add('react');
      if (deps.next) stack.add('next.js');
      if (deps.express || deps.fastify || deps.koa) stack.add('node.js');
      if (deps.typescript) stack.add('typescript');
    } catch { /* skip */ }
  }
  const pyContent = readIfExists(path.join(projectDir, 'pyproject.toml'));
  if (pyContent) {
    if (pyContent.includes('django')) stack.add('django');
    if (pyContent.includes('fastapi')) stack.add('fastapi');
  }
  return Array.from(stack).sort();
}

function detectKeyFiles(projectDir) {
  const candidates = ['README.md', 'CLAUDE.md', '.cursorrules', 'AGENTS.md', 'docker-compose.yml'];
  return candidates.filter(f => fs.existsSync(path.join(projectDir, f)));
}

function detectPatterns(readmeContent) {
  if (!readmeContent) return [];
  const patterns = [];
  const lower = readmeContent.toLowerCase();
  const keywords = [
    ['clean architecture', 'clean architecture'],
    ['repository pattern', 'repository pattern'],
    ['microservices', 'microservices'],
    ['event-driven', 'event-driven'],
    ['domain-driven', 'domain-driven design'],
    ['test-driven', 'test-driven development'],
    ['ci/cd', 'CI/CD'],
    ['monorepo', 'monorepo'],
  ];
  for (const [keyword, label] of keywords) {
    if (lower.includes(keyword)) patterns.push(label);
  }
  return patterns;
}

function scanLocalSkills(projectDir) {
  const metaDir = path.join(projectDir, '.meta-skills');
  if (!fs.existsSync(metaDir)) return [];
  const entries = [];
  let dirs;
  try { dirs = fs.readdirSync(metaDir, { withFileTypes: true }); } catch { return entries; }
  for (const dirent of dirs) {
    if (!dirent.isDirectory()) continue;
    const skillPath = path.join(metaDir, dirent.name, 'SKILL.md');
    if (!fs.existsSync(skillPath)) continue;
    const content = fs.readFileSync(skillPath, 'utf-8');
    const fm = parseFrontmatter(content);
    entries.push({ id: fm.name || dirent.name, when: fm.description || '', why: fm.description || '', path: skillPath, priority: 'medium', usage_count: 0, last_used: null });
  }
  return entries;
}

async function cmdRecord(args) {
  const { default: tracker } = await loadModule('usage-tracker.mjs');
  // Re-execute the tracker CLI with remaining args
  const { execSync } = await import('node:child_process');
  const trackerPath = path.resolve(__dirname, 'usage-tracker.mjs');
  const result = execSync(`node "${trackerPath}" record ${args.join(' ')}`, { stdio: 'inherit', encoding: 'utf-8' });
}

async function cmdAggregate(args) {
  const { execSync } = await import('node:child_process');
  const trackerPath = path.resolve(__dirname, 'usage-tracker.mjs');
  execSync(`node "${trackerPath}" aggregate ${args.join(' ')}`, { stdio: 'inherit', encoding: 'utf-8' });
}

async function cmdImprove(args) {
  const { execSync } = await import('node:child_process');
  const improvePath = path.resolve(__dirname, 'self-improve.mjs');
  execSync(`node "${improvePath}" ${args.join(' ')}`, { stdio: 'inherit', encoding: 'utf-8' });
}

async function cmdMaintain(args) {
  const { execSync } = await import('node:child_process');
  const maintPath = path.resolve(__dirname, 'maintenance.mjs');
  execSync(`node "${maintPath}" ${args.join(' ')}`, { stdio: 'inherit', encoding: 'utf-8' });
}

async function cmdValidate(args) {
  const { execSync } = await import('node:child_process');
  const validatePath = path.resolve(__dirname, 'validate.mjs');
  execSync(`node "${validatePath}" ${args.join(' ')}`, { stdio: 'inherit', encoding: 'utf-8' });
}

function cmdStatus() {
  const globalPath = path.join(os.homedir(), '.meta-skills', 'global.json');
  if (!fs.existsSync(globalPath)) {
    console.log('meta-skills: no global.json found. Run `meta-skills init --global` first.');
    return;
  }
  const index = JSON.parse(fs.readFileSync(globalPath, 'utf-8'));
  const active = index.skills.length;
  const stale = (index.stale || []).length;
  const high = index.skills.filter(s => s.priority === 'high').length;
  const medium = index.skills.filter(s => s.priority === 'medium').length;
  const low = index.skills.filter(s => s.priority === 'low').length;
  const totalUsage = index.skills.reduce((sum, s) => sum + (s.usage_count || 0), 0);
  const bundles = (index.suggested_bundles || []).length;

  console.log(`meta-skills v${PKG.version}`);
  console.log(`  Skills: ${active} active, ${stale} stale`);
  console.log(`  Priority: ${high} high, ${medium} medium, ${low} low`);
  console.log(`  Total activations: ${totalUsage}`);
  if (bundles > 0) console.log(`  Suggested bundles: ${bundles}`);
  console.log(`  Generated: ${index.generated}`);
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(`meta-skills v${PKG.version}`);
    console.log('');
    console.log('Usage:');
    console.log('  meta-skills init --global          Scan global skill dirs');
    console.log('  meta-skills init --local           Scan project for context');
    console.log('  meta-skills record <skill-id>      Record skill activation');
    console.log('  meta-skills aggregate              Aggregate usage logs');
    console.log('  meta-skills improve                Self-improvement loop');
    console.log('  meta-skills maintain               Full maintenance run');
    console.log('  meta-skills validate <file>        Validate against schema');
    console.log('  meta-skills status                 Show index summary');
    return;
  }

  const command = args[0];
  const rest = args.slice(1);

  try {
    switch (command) {
      case 'init':     await cmdInit(rest); break;
      case 'record':   await cmdRecord(rest); break;
      case 'aggregate': await cmdAggregate(rest); break;
      case 'improve':  await cmdImprove(rest); break;
      case 'maintain': await cmdMaintain(rest); break;
      case 'validate': await cmdValidate(rest); break;
      case 'status':   cmdStatus(); break;
      default:
        console.error(`✗ unknown command: ${command}`);
        process.exit(1);
    }
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
}

main();
