#!/usr/bin/env node

/**
 * Smoke test for self-improve.mjs
 *
 * Tests promotion, demotion, stale detection, and co-occurrence.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const improvePath = path.join(__dirname, 'self-improve.mjs');

// ── Setup temp dirs ───────────────────────────────────────────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-skills-improve-'));
const logDir = path.join(tmpDir, 'logs');
fs.mkdirSync(logDir, { recursive: true });

// Create global.json with varied skill states
const now = new Date();
const recent = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString();  // 1 day ago
const old = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000).toISOString();   // 100 days ago

const globalJson = path.join(tmpDir, 'global.json');
fs.writeFileSync(globalJson, JSON.stringify({
  $schema: 'https://meta-skills.dev/schema/v1.json',
  version: '1.0',
  generated: now.toISOString(),
  source: 'global',
  skills: [
    // Should promote to high (25 uses, recent)
    { id: 'git-commits', when: 'writing commits', why: 'conventional commits', path: '/tmp/skills/git/SKILL.md', priority: 'medium', usage_count: 25, last_used: recent },
    // Should demote to low (1 use, recent)
    { id: 'rare-skill', when: 'rare task', why: 'rarely needed', path: '/tmp/skills/rare/SKILL.md', priority: 'medium', usage_count: 1, last_used: recent },
    // Should archive (unused 100 days)
    { id: 'dead-skill', when: 'old task', why: 'no longer used', path: '/tmp/skills/dead/SKILL.md', priority: 'low', usage_count: 5, last_used: old },
    // Should stay medium (10 uses, recent)
    { id: 'steady-skill', when: 'steady task', why: 'regular use', path: '/tmp/skills/steady/SKILL.md', priority: 'medium', usage_count: 10, last_used: recent },
  ],
  stale: [],
}, null, 2));

// Create log files for co-occurrence detection
const todayStr = now.toISOString().slice(0, 10);
const logFile = path.join(logDir, `${todayStr}.jsonl`);
const logLines = [];
for (let i = 0; i < 5; i++) {
  logLines.push(JSON.stringify({ skill: 'git-commits', timestamp: new Date(now.getTime() + i * 60000).toISOString(), outcome: 'success' }));
  logLines.push(JSON.stringify({ skill: 'code-review', timestamp: new Date(now.getTime() + i * 60000 + 30000).toISOString(), outcome: 'success' }));
}
fs.writeFileSync(logFile, logLines.join('\n') + '\n');

// ── Run self-improve (dry-run first) ──────────────────────────────────
console.log('--- Dry Run ---');
let output;
try {
  output = execSync(`node "${improvePath}" --global-json "${globalJson}" --log-dir "${logDir}" --dry-run`, {
    stdio: 'pipe',
    encoding: 'utf-8',
  });
} catch (e) {
  console.error('FAILED:', e.stderr || e.message);
  process.exit(1);
}

console.log(output);

// ── Run for real ──────────────────────────────────────────────────────
console.log('--- Real Run ---');
try {
  output = execSync(`node "${improvePath}" --global-json "${globalJson}" --log-dir "${logDir}" --out "${globalJson}"`, {
    stdio: 'pipe',
    encoding: 'utf-8',
  });
} catch (e) {
  console.error('FAILED:', e.stderr || e.message);
  process.exit(1);
}

// ── Verify ────────────────────────────────────────────────────────────
const updated = JSON.parse(fs.readFileSync(globalJson, 'utf-8'));

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

const gitSkill = updated.skills.find(s => s.id === 'git-commits');
check('git-commits promoted to high', gitSkill && gitSkill.priority === 'high');

const rareSkill = updated.skills.find(s => s.id === 'rare-skill');
check('rare-skill demoted to low', rareSkill && rareSkill.priority === 'low');

const deadSkill = updated.skills.find(s => s.id === 'dead-skill');
check('dead-skill removed from active', !deadSkill);

const deadStale = updated.stale.find(s => s.id === 'dead-skill');
check('dead-skill in stale array', deadStale && deadStale.priority === 'archived');
check('dead-skill has archived timestamp', deadStale && typeof deadStale.archived === 'string');

const steadySkill = updated.skills.find(s => s.id === 'steady-skill');
check('steady-skill stays medium', steadySkill && steadySkill.priority === 'medium');

check('has suggested_bundles', Array.isArray(updated.suggested_bundles));

// ── Cleanup ───────────────────────────────────────────────────────────
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
