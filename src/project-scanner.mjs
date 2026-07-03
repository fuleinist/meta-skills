#!/usr/bin/env node

/**
 * meta-skills v0.2 — Project Scanner
 *
 * Scans project files (README.md, CLAUDE.md, .cursorrules, package.json,
 * pyproject.toml, Cargo.toml, Gemfile) and generates .meta-skills/project.json
 *
 * Usage: node src/project-scanner.mjs [--project-dir <path>] [--out <path>]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_URL = 'https://meta-skills.dev/schema/v1.json';

// ── Tech stack detectors ──────────────────────────────────────────────

const DETECTORS = [
  // package.json
  { file: 'package.json', detect: (pkg) => {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const stack = [];
    if (deps.react || deps['react-dom']) stack.push('react');
    if (deps.vue || deps['nuxt']) stack.push('vue');
    if (deps.next) stack.push('next.js');
    if (deps.express || deps.fastify || deps.koa) stack.push('node.js');
    if (deps.typescript || pkg.devDependencies?.typescript) stack.push('typescript');
    if (deps.electron) stack.push('electron');
    return stack;
  }},
  // pyproject.toml
  { file: 'pyproject.toml', detect: (content) => {
    const stack = [];
    if (content.includes('django')) stack.push('django');
    if (content.includes('fastapi')) stack.push('fastapi');
    if (content.includes('flask')) stack.push('flask');
    if (content.includes('pytorch') || content.includes('torch')) stack.push('pytorch');
    if (content.includes('tensorflow')) stack.push('tensorflow');
    return stack;
  }},
  // Cargo.toml
  { file: 'Cargo.toml', detect: (content) => {
    const stack = [];
    if (content.includes('axum') || content.includes('actix')) stack.push('rust');
    if (content.includes('tokio')) stack.push('tokio');
    if (content.includes('serde')) stack.push('serde');
    if (content.includes('leptos') || content.includes('yew') || content.includes('dioxus')) stack.push('wasm');
    if (content.includes('bevy')) stack.push('bevy');
    if (content.includes('tauri')) stack.push('tauri');
    return stack;
  }},
  // Gemfile
  { file: 'Gemfile', detect: (content) => {
    const stack = [];
    if (content.includes('rails') || content.includes('railst')) stack.push('rails');
    if (content.includes('sinatra')) stack.push('sinatra');
    if (content.includes('jekyll')) stack.push('jekyll');
    return stack;
  }},
  // go.mod
  { file: 'go.mod', detect: (content) => {
    const stack = ['go'];
    if (content.includes('github.com/gin-gonic/gin')) stack.push('gin');
    if (content.includes('github.com/labstack/echo')) stack.push('echo');
    if (content.includes('github.com/gofiber/fiber')) stack.push('fiber');
    if (content.includes('github.com/gorilla/mux')) stack.push('gorilla');
    return stack;
  }},
  // requirements.txt (Python)
  { file: 'requirements.txt', detect: (content) => {
    const stack = [];
    if (content.includes('django')) stack.push('django');
    if (content.includes('fastapi')) stack.push('fastapi');
    if (content.includes('flask')) stack.push('flask');
    if (content.includes('torch') || content.includes('pytorch')) stack.push('pytorch');
    if (content.includes('tensorflow')) stack.push('tensorflow');
    if (content.includes('pandas')) stack.push('pandas');
    if (content.includes('numpy')) stack.push('numpy');
    return stack;
  }},
  // pubspec.yaml (Dart/Flutter)
  { file: 'pubspec.yaml', detect: (content) => {
    const stack = [];
    if (content.includes('flutter')) stack.push('flutter');
    if (content.includes('dart')) stack.push('dart');
    return stack;
  }},
  // build.gradle (Kotlin/Java)
  { file: 'build.gradle', detect: (content) => {
    const stack = [];
    if (content.includes('kotlin')) stack.push('kotlin');
    if (content.includes('spring')) stack.push('spring');
    if (content.includes('android')) stack.push('android');
    return stack;
  }},
  // build.gradle.kts (Kotlin DSL)
  { file: 'build.gradle.kts', detect: (content) => {
    const stack = [];
    if (content.includes('kotlin')) stack.push('kotlin');
    if (content.includes('spring')) stack.push('spring');
    if (content.includes('android')) stack.push('android');
    return stack;
  }},
  // CMakeLists.txt
  { file: 'CMakeLists.txt', detect: () => ['cmake'] },
  // Deno
  { file: 'deno.json', detect: () => ['deno'] },
  { file: 'deno.jsonc', detect: () => ['deno'] },
  // Bun
  { file: 'bun.lock', detect: () => ['bun'] },
  { file: 'bun.lockb', detect: () => ['bun'] },
];

// ── Helpers ───────────────────────────────────────────────────────────

function readIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function detectTechStack(projectDir) {
  const stack = new Set();

  for (const detector of DETECTORS) {
    const filePath = path.join(projectDir, detector.file);
    const content = readIfExists(filePath);
    if (content === null) continue;

    let parsed;
    if (detector.file === 'package.json') {
      try { parsed = JSON.parse(content); } catch { continue; }
    }

    const detected = detector.file === 'package.json'
      ? detector.detect(parsed)
      : detector.detect(content);

    for (const item of detected) stack.add(item);
  }

  return Array.from(stack).sort();
}

function detectKeyFiles(projectDir) {
  const candidates = [
    'README.md', 'CLAUDE.md', '.cursorrules', 'AGENTS.md',
    'CONTRIBUTING.md', 'CHANGELOG.md', 'docker-compose.yml',
    'Dockerfile', '.env.example', 'Makefile', 'justfile',
    '.github/workflows', '.gitlab-ci.yml', '.gitignore',
  ];
  return candidates.filter(f => fs.existsSync(path.join(projectDir, f)));
}

function detectPatterns(readmeContent) {
  const patterns = [];
  if (!readmeContent) return patterns;

  const keywords = [
    ['clean architecture', 'clean architecture'],
    ['repository pattern', 'repository pattern'],
    ['microservices', 'microservices'],
    ['event-driven', 'event-driven'],
    ['cqs', 'CQRS'],
    ['event sourcing', 'event sourcing'],
    ['domain-driven', 'domain-driven design'],
    ['test-driven', 'test-driven development'],
    ['ci/cd', 'CI/CD'],
    ['monorepo', 'monorepo'],
  ];

  const lower = readmeContent.toLowerCase();
  for (const [keyword, label] of keywords) {
    if (lower.includes(keyword)) patterns.push(label);
  }

  return patterns;
}

function scanLocalSkills(projectDir) {
  const metaSkillsDir = path.join(projectDir, '.meta-skills');
  if (!fs.existsSync(metaSkillsDir)) return [];

  const entries = [];
  let dirs;
  try {
    dirs = fs.readdirSync(metaSkillsDir, { withFileTypes: true });
  } catch {
    return entries;
  }

  for (const dirent of dirs) {
    if (!dirent.isDirectory()) continue;
    const skillPath = path.join(metaSkillsDir, dirent.name, 'SKILL.md');
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

// ── Main ──────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  let projectDir = process.cwd();
  let outPath = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project-dir' && i + 1 < args.length) {
      projectDir = path.resolve(args[++i]);
    }
    if (args[i] === '--out' && i + 1 < args.length) {
      outPath = path.resolve(args[++i]);
    }
  }

  if (!outPath) {
    outPath = path.join(projectDir, '.meta-skills', 'project.json');
  }

  const readme = readIfExists(path.join(projectDir, 'README.md'));
  const projectName = readme
    ? (readme.match(/^#\s+(.+)/m)?.[1]?.trim() || path.basename(projectDir))
    : path.basename(projectDir);

  const techStack = detectTechStack(projectDir);
  const keyFiles = detectKeyFiles(projectDir);
  const patterns = detectPatterns(readme);
  const localSkills = scanLocalSkills(projectDir);

  const output = {
    $schema: SCHEMA_URL,
    version: '1.0',
    generated: new Date().toISOString(),
    source: 'project',
    project_context: {
      name: projectName,
      tech_stack: techStack,
      key_files: keyFiles,
      patterns: patterns,
    },
    skills: localSkills,
  };

  const outDir = path.dirname(outPath);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n', 'utf-8');
  console.log(`✓ project.json written to ${outPath}`);
  console.log(`  project: ${projectName}`);
  console.log(`  tech stack: ${techStack.join(', ') || '(none detected)'}`);
  console.log(`  key files: ${keyFiles.length}`);
  console.log(`  patterns: ${patterns.length}`);
  console.log(`  local skills: ${localSkills.length}`);
}

const isMain = process.argv[1] && (process.argv[1] === fileURLToPath(import.meta.url) || process.argv[1].endsWith('project-scanner.mjs'));
if (isMain) main();

export { main, detectTechStack, detectKeyFiles, detectPatterns, scanLocalSkills, parseFrontmatter, readIfExists };
