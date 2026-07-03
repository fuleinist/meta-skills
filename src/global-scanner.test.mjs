#!/usr/bin/env node

/**
 * Smoke test for global-scanner.mjs
 *
 * Scans the meta-skills repo itself as a minimal test fixture.
 * Creates a fake skill dir to verify frontmatter parsing.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Import scanner directly ───────────────────────────────────────────
const scanner = await import(pathToFileURL(path.join(__dirname, 'global-scanner.mjs')).href);

// ── Create a temp skill directory ─────────────────────────────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-skills-test-'));
const testSkillDir = path.join(tmpDir, 'skills');
fs.mkdirSync(testSkillDir, { recursive: true });

// Create a fake skill
const testSkillPath = path.join(testSkillDir, 'test-skill', 'SKILL.md');
fs.mkdirSync(path.dirname(testSkillPath), { recursive: true });
fs.writeFileSync(testSkillPath, `---
name: test-skill
description: A test skill for smoke testing the global scanner
---

# Test Skill

This is a test.
`);

// ── Run scanner via direct import ─────────────────────────────────────
const outPath = path.join(tmpDir, 'global.json');
const entries = scanner.scanDir(testSkillDir);
const merged = scanner.mergeEntries(entries);

const output = {
  $schema: scanner.SCHEMA_URL,
  version: '1.0',
  generated: new Date().toISOString(),
  source: 'global',
  skills: merged,
  stale: [],
};

fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n', 'utf-8');

// ── Verify output ─────────────────────────────────────────────────────
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
check('source is global', output.source === 'global');
check('has generated timestamp', typeof output.generated === 'string');
check('skills is array', Array.isArray(output.skills));
check('found test-skill', output.skills.some(s => s.id === 'test-skill'));
check('stale is array', Array.isArray(output.stale));

const skill = output.skills.find(s => s.id === 'test-skill');
check('skill has when', skill && typeof skill.when === 'string');
check('skill has why', skill && typeof skill.why === 'string');
check('skill has path', skill && typeof skill.path === 'string');
check('skill has priority', skill && skill.priority === 'medium');
check('skill has usage_count', skill && skill.usage_count === 0);
check('skill has last_used', skill && skill.last_used === null);

// ── Test getConfigDir ─────────────────────────────────────────────────
check('getConfigDir returns string', typeof scanner.getConfigDir() === 'string');

// ── Test DEFAULT_DIRS includes new agents ─────────────────────────────
const dirs = scanner.DEFAULT_DIRS;
check('DEFAULT_DIRS includes Claude Code', dirs.some(d => d.includes('.claude')));
check('DEFAULT_DIRS includes Codex CLI', dirs.some(d => d.includes('.codex')));
check('DEFAULT_DIRS includes Gemini', dirs.some(d => d.includes('gemini')));
check('DEFAULT_DIRS includes OpenCode', dirs.some(d => d.includes('opencode')));
check('DEFAULT_DIRS includes Cline', dirs.some(d => d.includes('cline')));
check('DEFAULT_DIRS includes Windsurf', dirs.some(d => d.includes('windsurf')));

// ── Cleanup ───────────────────────────────────────────────────────────
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
