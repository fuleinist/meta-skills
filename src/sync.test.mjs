#!/usr/bin/env node

/**
 * Smoke test for sync.mjs
 *
 * Tests push Ã¢â€ â€™ pull Ã¢â€ â€™ status pipeline across simulated agents.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const syncPath = path.join(__dirname, 'sync.mjs');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-skills-sync-'));
const syncDir = path.join(tmpDir, 'sync');
const logDir = path.join(tmpDir, 'logs');
const globalJson = path.join(tmpDir, 'global.json');

fs.mkdirSync(logDir, { recursive: true });
fs.mkdirSync(path.join(syncDir, 'claude'), { recursive: true });
fs.mkdirSync(path.join(syncDir, 'cursor'), { recursive: true });

// Create a minimal global.json
fs.writeFileSync(globalJson, JSON.stringify({
  $schema: 'https://meta-skills.dev/schema/v1.json',
  version: '1.0',
  generated: '2026-06-24T00:00:00.000Z',
  source: 'global',
  skills: [
    { id: 'git-commits', when: 'writing commits', why: 'conventional commits', path: '/tmp/skills/git/SKILL.md', priority: 'medium', usage_count: 5, last_used: null },
    { id: 'code-review', when: 'reviewing PRs', why: 'structured review', path: '/tmp/skills/review/SKILL.md', priority: 'medium', usage_count: 3, last_used: null },
    { id: 'web-search', when: 'searching the web', why: 'web info retrieval', path: '/tmp/skills/web/SKILL.md', priority: 'medium', usage_count: 0, last_used: null },
  ],
  stale: [],
}, null, 2));

let passed = 0;
let failed = 0;

function check(label, condition) {
  if (condition) { console.log(`  Ã¢Å“â€œ ${label}`); passed++; }
  else           { console.log(`  Ã¢Å“â€” ${label}`); failed++; }
}

function run(args, env = {}) {
  try {
    return execSync(`node "${syncPath}" ${args}`, {
      cwd: tmpDir,
      stdio: 'pipe',
      encoding: 'utf-8',
      env: { ...process.env, ...env },
    });
  } catch (e) {
    return e.stdout || e.message;
  }
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Test 1: Push (simulate claude agent writing events) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
console.log('\n--- Push (claude) ---');
const today = new Date().toISOString().slice(0, 10);
const claudeEvents = [
  { skill: 'git-commits', timestamp: `${today}T09:00:00.000Z`, outcome: 'success' },
  { skill: 'code-review', timestamp: `${today}T09:30:00.000Z`, outcome: 'success' },
];
fs.writeFileSync(path.join(logDir, `${today}.jsonl`), claudeEvents.map(e => JSON.stringify(e)).join('\n') + '\n');

run('push --sync-dir "' + syncDir + '" --log-dir "' + logDir + '"', { META_SKILLS_AGENT: 'claude' });
const claudeFile = path.join(syncDir, 'claude', 'events.jsonl');
check('claude events file created', fs.existsSync(claudeFile));
const claudeContent = fs.readFileSync(claudeFile, 'utf-8');
check('2 events in claude file', claudeContent.trim().split('\n').filter(Boolean).length === 2);

// Ã¢â€â‚¬Ã¢â€â‚¬ Test 2: Push (simulate cursor agent writing events) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
console.log('\n--- Push (cursor) ---');
const cursorEvents = [
  { skill: 'git-commits', timestamp: `${today}T10:00:00.000Z`, outcome: 'success' },
  { skill: 'web-search', timestamp: `${today}T10:05:00.000Z`, outcome: 'success' },
];
fs.writeFileSync(path.join(logDir, `${today}.jsonl`), cursorEvents.map(e => JSON.stringify(e)).join('\n') + '\n');

run('push --sync-dir "' + syncDir + '" --log-dir "' + logDir + '"', { META_SKILLS_AGENT: 'cursor' });
const cursorFile = path.join(syncDir, 'cursor', 'events.jsonl');
check('cursor events file created', fs.existsSync(cursorFile));

// Ã¢â€â‚¬Ã¢â€â‚¬ Test 3: Pull Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
console.log('\n--- Pull ---');
const outJson = path.join(tmpDir, 'global-synced.json');
run('pull --sync-dir "' + syncDir + '" --global-json "' + globalJson + '" --out "' + outJson + '"');

check('pulled global.json created', fs.existsSync(outJson));
const pulled = JSON.parse(fs.readFileSync(outJson, 'utf-8'));
const gitSkill = pulled.skills.find(s => s.id === 'git-commits');
const reviewSkill = pulled.skills.find(s => s.id === 'code-review');
const webSkill = pulled.skills.find(s => s.id === 'web-search');

check('git-commits count += 2', gitSkill.usage_count === 7); // 5 + 2
check('code-review count += 1', reviewSkill.usage_count === 4); // 3 + 1
check('web-search count += 1', webSkill.usage_count === 1);
check('git-commits last_synced_agent set', gitSkill.last_synced_agent === 'cursor');
check('git-commits last_agents includes claude', gitSkill.last_agents?.includes('claude'));
check('git-commits last_agents includes cursor', gitSkill.last_agents?.includes('cursor'));
check('pull has _sync metadata', !!pulled._sync);
check('_sync has agents_count', pulled._sync.agents_count === 2);
check('_sync has events_pulled', pulled._sync.events_pulled === 4);

// Ã¢â€â‚¬Ã¢â€â‚¬ Test 4: Status Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
console.log('\n--- Status ---');
const statusOut = run('status --sync-dir "' + syncDir + '"', { META_SKILLS_AGENT: 'cursor' });
check('status shows claude agent', statusOut.includes('claude'));
check('status shows cursor agent', statusOut.includes('cursor'));
check('status shows event counts', statusOut.includes('events'));
check('status shows skill counts', statusOut.includes('skills'));

// Ã¢â€â‚¬Ã¢â€â‚¬ Test 5: Sync (push + pull combined) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
// First write a new event for a third agent (openclaw)
console.log('\n--- Sync (combined) ---');
const oaEvents = [
  { skill: 'git-commits', timestamp: `${today}T11:00:00.000Z`, outcome: 'success' },
];
fs.writeFileSync(path.join(logDir, `${today}.jsonl`), oaEvents.map(e => JSON.stringify(e)).join('\n') + '\n');

const syncOut = path.join(tmpDir, 'global-sync.json');
run('sync --sync-dir "' + syncDir + '" --log-dir "' + logDir + '" --global-json "' + globalJson + '" --out "' + syncOut + '"', { META_SKILLS_AGENT: 'openclaw' });

check('sync creates output file', fs.existsSync(syncOut));
const synced = JSON.parse(fs.readFileSync(syncOut, 'utf-8'));
const gitSynced = synced.skills.find(s => s.id === 'git-commits');
check('sync updates git-commits count', gitSynced.usage_count >= 8);
check('sync records openclaw agent', gitSynced.last_agents?.includes('openclaw'));

// Ã¢â€â‚¬Ã¢â€â‚¬ Cleanup Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
