#!/usr/bin/env node

/**
 * Smoke test for project-scanner.mjs
 *
 * Creates a temp project with README.md, package.json, and a local skill
 * to verify project.json generation.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Create temp project ───────────────────────────────────────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-skills-project-'));
const metaDir = path.join(tmpDir, '.meta-skills');
fs.mkdirSync(metaDir, { recursive: true });

// README.md
fs.writeFileSync(path.join(tmpDir, 'README.md'), `# test-project

A test project for smoke testing the project scanner.

## Architecture

Uses clean architecture with repository pattern.

## Tech

Built with Node.js and React.
`);

// package.json
fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
  dependencies: { react: '^18.0.0', express: '^4.0.0' },
  devDependencies: { typescript: '^5.0.0' },
}));

// CLAUDE.md
fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# Claude config\n');

// Local skill
const localSkillDir = path.join(metaDir, 'local-test', 'SKILL.md');
fs.mkdirSync(path.dirname(localSkillDir), { recursive: true });
fs.writeFileSync(localSkillDir, `---
name: local-test
description: A project-specific test skill
---

# Local Test Skill
`);

// ── Run scanner ───────────────────────────────────────────────────────
const outPath = path.join(tmpDir, 'project.json');
const scannerPath = path.join(__dirname, 'project-scanner.mjs');

try {
  execSync(`node "${scannerPath}" --project-dir "${tmpDir}" --out "${outPath}"`, {
    stdio: 'pipe',
    encoding: 'utf-8',
  });
} catch (e) {
  console.error('FAILED:', e.stderr || e.message);
  process.exit(1);
}

// ── Verify output ─────────────────────────────────────────────────────
const output = JSON.parse(fs.readFileSync(outPath, 'utf-8'));

let passed = 0;
let failed = 0;

function check(label, condition) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}`);
    failed++;
  }
}

check('has $schema', output.$schema === 'https://meta-skills.dev/schema/v1.json');
check('version is 1.0', output.version === '1.0');
check('source is project', output.source === 'project');
check('has generated timestamp', typeof output.generated === 'string');
check('has project_context', typeof output.project_context === 'object');
check('project name', output.project_context.name === 'test-project');
check('tech_stack includes react', output.project_context.tech_stack.includes('react'));
check('tech_stack includes typescript', output.project_context.tech_stack.includes('typescript'));
check('tech_stack includes node.js', output.project_context.tech_stack.includes('node.js'));
check('key_files includes README.md', output.project_context.key_files.includes('README.md'));
check('key_files includes CLAUDE.md', output.project_context.key_files.includes('CLAUDE.md'));
check('patterns includes clean architecture', output.project_context.patterns.includes('clean architecture'));
check('patterns includes repository pattern', output.project_context.patterns.includes('repository pattern'));
check('skills is array', Array.isArray(output.skills));
check('found local-test skill', output.skills.some(s => s.id === 'local-test'));

const skill = output.skills.find(s => s.id === 'local-test');
check('local skill has when', skill && typeof skill.when === 'string');
check('local skill has path', skill && skill.path.includes('local-test'));

// ── Cleanup ───────────────────────────────────────────────────────────
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
