#!/usr/bin/env node

/**
 * meta-skills v1.1 — Background Cron (Maintenance)
 *
 * Orchestrates all previous modules in a single daily maintenance run:
 * 1. Re-scan global skill directories
 * 2. Aggregate usage logs
 * 3. Apply self-improvement loop
 * 4. Re-generate project context
 * 5. Git-commit changes (if version-controlled)
 *
 * Usage: node src/maintenance.mjs [--project-dir <path>] [--dry-run]
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_URL = 'https://meta-skills.dev/schema/v1.json';

// ── Default paths ─────────────────────────────────────────────────────

const META_SKILLS_DIR = path.join(os.homedir(), '.meta-skills');
const GLOBAL_JSON = path.join(META_SKILLS_DIR, 'global.json');
const LOG_DIR = path.join(META_SKILLS_DIR, 'logs');

// ── Agent skill directories to scan ───────────────────────────────────

const AGENT_DIRS = [
  path.join(os.homedir(), '.claude', 'skills'),
  path.join(os.homedir(), '.cursor', 'skills'),
  path.join(os.homedir(), '.openclaw', 'skills'),
  path.join(os.homedir(), '.hermes', 'skills'),
];

// ── Helpers ───────────────────────────────────────────────────────────

function parseFrontmatter(text) {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  const obj = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^\s*(\w+)\s*:\s*(.+)$/);
    if (kv) {
      let val = kv[2].trim();
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
    } else {
      map.set(e.id, e);
    }
  }
  return Array.from(map.values());
}

function readIfExists(filePath) {
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
}

function detectTechStack(projectDir) {
  const stack = new Set();
  const pkgPath = path.join(projectDir, 'package.json');
  const pkgContent = readIfExists(pkgPath);
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

// ── Step 1: Re-scan global ────────────────────────────────────────────

function stepRescan() {
  console.log('── Step 1: Re-scan global skill directories ──');
  const allEntries = [];
  for (const dir of AGENT_DIRS) {
    const found = scanDir(dir);
    allEntries.push(...found);
  }
  const merged = mergeEntries(allEntries);
  console.log(`  found ${merged.length} skills across ${AGENT_DIRS.length} directories`);
  return merged;
}

// ── Step 2: Aggregate usage ───────────────────────────────────────────

function stepAggregate(index) {
  console.log('\n── Step 2: Aggregate usage logs ──');
  const usage = {};
  let logFiles;
  try { logFiles = fs.readdirSync(LOG_DIR).filter(f => f.endsWith('.jsonl')); } catch { logFiles = []; }

  for (const logFile of logFiles) {
    const content = readIfExists(path.join(LOG_DIR, logFile));
    if (!content) continue;
    for (const line of content.trim().split('\n').filter(Boolean)) {
      try {
        const event = JSON.parse(line);
        if (!usage[event.skill]) usage[event.skill] = { count: 0, lastTimestamp: null };
        usage[event.skill].count++;
        if (!usage[event.skill].lastTimestamp || event.timestamp > usage[event.skill].lastTimestamp) {
          usage[event.skill].lastTimestamp = event.timestamp;
        }
      } catch { /* skip */ }
    }
  }

  let updatedCount = 0;
  const allSkills = [...(index.skills || []), ...(index.stale || [])];
  for (const skill of allSkills) {
    const u = usage[skill.id];
    if (u) {
      skill.usage_count = (skill.usage_count || 0) + u.count;
      if (u.lastTimestamp && (!skill.last_used || u.lastTimestamp > skill.last_used)) {
        skill.last_used = u.lastTimestamp;
      }
      updatedCount++;
    }
  }

  console.log(`  ${Object.keys(usage).length} skills in logs, ${updatedCount} matched in index`);
  return usage;
}

// ── Step 3: Self-improvement ──────────────────────────────────────────

function stepSelfImprove(index) {
  console.log('\n── Step 3: Self-improvement loop ──');
  const thresholds = { promoteToHigh: { minUsage: 20, windowDays: 30 }, demoteToLow: { maxUsage: 3, windowDays: 30 }, staleDays: 60, archiveDays: 90 };

  function daysAgo(dateStr) {
    if (!dateStr) return Infinity;
    return (Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24);
  }
  function isInWindow(dateStr, windowDays) {
    return daysAgo(dateStr) <= windowDays;
  }

  // Promotion/Demotion
  let changes = 0;
  for (const skill of index.skills) {
    if (skill.priority === 'archived') continue;
    const oldP = skill.priority;
    const recent = isInWindow(skill.last_used, thresholds.promoteToHigh.windowDays);
    const usage = skill.usage_count || 0;

    if (recent && usage >= thresholds.promoteToHigh.minUsage && oldP !== 'high') {
      skill.priority = 'high';
      changes++;
    } else if (recent && usage <= thresholds.demoteToLow.maxUsage && oldP !== 'low') {
      skill.priority = 'low';
      changes++;
    } else if (oldP === 'low' && usage > thresholds.promoteToHigh.minUsage) {
      skill.priority = 'medium';
      changes++;
    }
  }
  console.log(`  ${changes} priority changes`);

  // Stale detection
  const active = [];
  const staleMap = new Map();
  for (const s of (index.stale || [])) staleMap.set(s.id, s);
  let archived = 0;

  for (const skill of index.skills) {
    if (skill.priority === 'archived') { active.push(skill); continue; }
    const age = daysAgo(skill.last_used);
    if (age > thresholds.archiveDays) {
      skill.priority = 'archived';
      skill.archived = new Date().toISOString();
      staleMap.set(skill.id, skill);
      archived++;
    } else {
      if (age > thresholds.staleDays && skill.priority !== 'low') skill.priority = 'low';
      active.push(skill);
    }
  }

  index.skills = active;
  index.stale = Array.from(staleMap.values());
  console.log(`  ${archived} archived, ${active.length} active, ${index.stale.length} stale`);
}

// ── Step 4: Re-generate project context ───────────────────────────────

function stepProjectContext(projectDir) {
  console.log('\n── Step 4: Project context ──');
  const projectJsonPath = path.join(projectDir, '.meta-skills', 'project.json');
  const readme = readIfExists(path.join(projectDir, 'README.md'));
  const projectName = readme
    ? (readme.match(/^#\s+(.+)/m)?.[1]?.trim() || path.basename(projectDir))
    : path.basename(projectDir);

  const projectOutput = {
    $schema: SCHEMA_URL,
    version: '1.0',
    generated: new Date().toISOString(),
    source: 'project',
    project_context: {
      name: projectName,
      tech_stack: detectTechStack(projectDir),
      key_files: detectKeyFiles(projectDir),
      patterns: detectPatterns(readme),
    },
    skills: [],
  };

  const outDir = path.dirname(projectJsonPath);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(projectJsonPath, JSON.stringify(projectOutput, null, 2) + '\n', 'utf-8');
  console.log(`  project.json updated for ${projectName}`);
}

// ── Step 5: Git-commit ────────────────────────────────────────────────

function stepGitCommit(projectDir, dryRun) {
  console.log('\n── Step 5: Git commit ──');
  const metaDir = path.join(projectDir, '.meta-skills');
  if (!fs.existsSync(path.join(metaDir, '.git'))) {
    console.log('  not a git repo, skipping');
    return;
  }

  try {
    const status = execSync('git status --porcelain', { cwd: metaDir, encoding: 'utf-8', stdio: 'pipe' }).trim();
    if (!status) {
      console.log('  no changes to commit');
      return;
    }
    console.log(`  changes detected:\n${status}`);

    if (dryRun) {
      console.log('  (dry-run, skipping commit)');
      return;
    }

    execSync('git add -A', { cwd: metaDir, stdio: 'pipe' });
    execSync('git commit -m "chore: meta-skills daily maintenance"', { cwd: metaDir, stdio: 'pipe' });
    console.log('  committed');
  } catch (e) {
    console.log('  git error:', e.message);
  }
}

// ── Main ──────────────────────────────────────────────────────────────

function main(options) {
  const opts = options || {};
  let projectDir = opts.projectDir || process.cwd();
  let dryRun = opts.dryRun || false;

  // If called standalone (no options), parse from argv
  if (!opts || Object.keys(opts).length === 0) {
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--project-dir' && i + 1 < args.length) projectDir = path.resolve(args[++i]);
      else if (args[i] === '--dry-run') dryRun = true;
    }
  }

  // Ensure meta-skills dir exists
  if (!fs.existsSync(META_SKILLS_DIR)) fs.mkdirSync(META_SKILLS_DIR, { recursive: true });

  // Read existing index or create new
  let index;
  try {
    index = JSON.parse(fs.readFileSync(GLOBAL_JSON, 'utf-8'));
  } catch {
    index = { $schema: SCHEMA_URL, version: '1.0', generated: new Date().toISOString(), source: 'global', skills: [], stale: [] };
  }

  // Run steps
  const scannedSkills = stepRescan();
  stepAggregate(index);
  stepSelfImprove(index);
  stepProjectContext(projectDir);
  stepGitCommit(projectDir, dryRun);

  // Merge scanned skills (preserve existing usage data)
  const existingMap = new Map();
  for (const s of [...(index.skills || []), ...(index.stale || [])]) existingMap.set(s.id, s);

  for (const scanned of scannedSkills) {
    if (!existingMap.has(scanned.id)) {
      index.skills.push(scanned);
    }
  }

  // Write global.json
  index.generated = new Date().toISOString();
  if (!dryRun) {
    fs.writeFileSync(GLOBAL_JSON, JSON.stringify(index, null, 2) + '\n', 'utf-8');
    console.log(`\n✓ global.json written (${index.skills.length} active, ${index.stale.length} stale)`);
  } else {
    console.log(`\n── DRY RUN — global.json not written ──`);
  }
}

const isMain = process.argv[1] && (process.argv[1] === fileURLToPath(import.meta.url) || process.argv[1].endsWith('maintenance.mjs'));
if (isMain) main({});

export { main, stepRescan, stepAggregate, stepSelfImprove, stepProjectContext, stepGitCommit };
