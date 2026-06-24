#!/usr/bin/env node

/**
 * Smoke test for maintenance.mjs (v0.5)
 *
 * Tests the full pipeline: rescan → aggregate → self-improve → project context
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const maintenancePath = path.join(__dirname, 'maintenance.mjs');

// ── Setup temp dirs ───────────────────────────────────────────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-skills-maint-'));
const homeDir = path.join(tmpDir, 'home');
const metaDir = path.join(homeDir, '.meta-skills');
const logDir = path.join(metaDir, 'logs');
fs.mkdirSync(logDir, { recursive: true });

// Create a fake skill dir
const claudeSkills = path.join(homeDir, '.claude', 'skills', 'test-skill');
fs.mkdirSync(claudeSkills, { recursive: true });
fs.writeFileSync(path.join(claudeSkills, 'SKILL.md'), `---
name: test-skill
description: A test skill for maintenance cron
---

# Test Skill
`);

// Create a usage log
const now = new Date();
const todayStr = now.toISOString().slice(0, 10);
fs.writeFileSync(path.join(logDir, `${todayStr}.jsonl`),
  JSON.stringify({ skill: 'test-skill', timestamp: now.toISOString(), outcome: 'success' }) + '\n');

// Create project dir with README
const projectDir = path.join(tmpDir, 'project');
fs.mkdirSync(projectDir, { recursive: true });
fs.writeFileSync(path.join(projectDir, 'README.md'), `# test-project

A test project.

Uses clean architecture.
`);

// Create an initial global.json
fs.writeFileSync(path.join(metaDir, 'global.json'), JSON.stringify({
  $schema: 'https://meta-skills.dev/schema/v1.json',
  version: '1.0',
  generated: now.toISOString(),
  source: 'global',
  skills: [
    { id: 'test-skill', when: 'test', why: 'test', path: '/tmp/SKILL.md', priority: 'medium', usage_count: 0, last_used: null },
  ],
  stale: [],
}, null, 2));

// ── Run maintenance ───────────────────────────────────────────────────
console.log('--- Maintenance Run ---');
try {
  const result = execSync(`node "${maintenancePath}" --project-dir "${projectDir}"`, {
    stdio: 'pipe',
    encoding: 'utf-8',
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
  });
  console.log(result);
} catch (e) {
  console.error('FAILED:', e.stderr || e.message);
  process.exit(1);
}

// ── Verify ────────────────────────────────────────────────────────────
const updated = JSON.parse(fs.readFileSync(path.join(metaDir, 'global.json'), 'utf-8'));
const projectJson = JSON.parse(fs.readFileSync(path.join(projectDir, '.meta-skills', 'project.json'), 'utf-8'));

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

check('global.json exists', !!updated);
check('has skills array', Array.isArray(updated.skills));
check('test-skill in skills', updated.skills.some(s => s.id === 'test-skill'));
check('usage_count aggregated', updated.skills.find(s => s.id === 'test-skill').usage_count > 0);
check('has last_used', typeof updated.skills.find(s => s.id === 'test-skill').last_used === 'string');
check('project.json exists', !!projectJson);
check('project name correct', projectJson.project_context.name === 'test-project');
check('patterns detected', projectJson.project_context.patterns.includes('clean architecture'));

// ── Cleanup ───────────────────────────────────────────────────────────
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
