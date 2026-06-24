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
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

// ── Run scanner ───────────────────────────────────────────────────────
const outPath = path.join(tmpDir, 'global.json');
const { execSync } = await import('node:child_process');
const scannerPath = path.join(__dirname, 'global-scanner.mjs');

try {
  execSync(`node "${scannerPath}" --out "${outPath}" --dirs "${testSkillDir}"`, {
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

// ── Cleanup ───────────────────────────────────────────────────────────
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
