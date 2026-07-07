#!/usr/bin/env node

/**
 * Smoke test for failure-analyzer.mjs
 *
 * Tests:
 *   - groupFailuresBySkill on fixture logs
 *   - readSkillMd with a mock global.json
 *   - generatePatch (all 4 patch types)
 *   - analyzeFailurePatterns
 *   - writeProposal / listProposals / readProposal / deleteProposal
 *   - CLI subcommands
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const faPath = path.join(__dirname, 'failure-analyzer.mjs');

const fa = await import(pathToFileURL(faPath).href);

let passed = 0;
let failed = 0;

function check(label, condition) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else           { console.log(`  ✗ ${label}`); failed++; }
}

// ── Fixture setup ──────────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-skills-fa-'));
const logDir = path.join(tmpDir, 'logs');
const proposalsDir = path.join(tmpDir, 'proposals');
const globalJson = path.join(tmpDir, 'global.json');
const skillsDir = path.join(tmpDir, 'skills');

fs.mkdirSync(logDir, { recursive: true });
fs.mkdirSync(proposalsDir, { recursive: true });
fs.mkdirSync(skillsDir, { recursive: true });
fs.mkdirSync(path.join(skillsDir, 'test-skill'), { recursive: true });
fs.mkdirSync(path.join(skillsDir, 'vague-skill'), { recursive: true });
fs.mkdirSync(path.join(skillsDir, 'short-skill'), { recursive: true });

// Write fixture SKILL.md files
const testSkillContent = `---
name: test-skill
description: A test skill for failure analysis
when: Use this skill for testing purposes
---

# Test Skill

This is a test skill used for failure analysis testing.

## Usage

Run this skill when you need to test something.

## Examples

\`\`\`
meta-skills test --verbose
\`\`\`
`;

const vagueSkillContent = `---
name: vague-skill
description: A vague skill
---

# Vague Skill

This skill has no clear when field.
`;

const shortSkillContent = `---
name: short-skill
description: Very short
when: General use
---

# Short Skill

Hi.
`;

fs.writeFileSync(path.join(skillsDir, 'test-skill', 'SKILL.md'), testSkillContent, 'utf-8');
fs.writeFileSync(path.join(skillsDir, 'vague-skill', 'SKILL.md'), vagueSkillContent, 'utf-8');
fs.writeFileSync(path.join(skillsDir, 'short-skill', 'SKILL.md'), shortSkillContent, 'utf-8');

// Write global.json
fs.writeFileSync(globalJson, JSON.stringify({
  $schema: 'https://meta-skills.dev/schema/v1.json',
  version: '1.0',
  generated: new Date().toISOString(),
  source: 'global',
  skills: [
    { id: 'test-skill', when: 'testing', why: 'test', path: path.join(skillsDir, 'test-skill', 'SKILL.md'), priority: 'medium', usage_count: 10, last_used: new Date().toISOString() },
    { id: 'vague-skill', when: 'vague', why: 'vague', path: path.join(skillsDir, 'vague-skill', 'SKILL.md'), priority: 'low', usage_count: 5, last_used: new Date().toISOString() },
    { id: 'short-skill', when: 'General use', why: 'short', path: path.join(skillsDir, 'short-skill', 'SKILL.md'), priority: 'low', usage_count: 3, last_used: new Date().toISOString() },
    { id: 'clean-skill', when: 'clean', why: 'clean', path: path.join(skillsDir, 'test-skill', 'SKILL.md'), priority: 'medium', usage_count: 20, last_used: new Date().toISOString() },
  ],
  stale: [],
}, null, 2));

// Write fixture log files with failures
const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);

function writeLog(date, entries) {
  const content = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(path.join(logDir, `${date}.jsonl`), content, 'utf-8');
}

writeLog(today, [
  { skill: 'test-skill', timestamp: `${today}T10:00:00Z`, outcome: 'failure' },
  { skill: 'test-skill', timestamp: `${today}T11:00:00Z`, outcome: 'success' },
  { skill: 'vague-skill', timestamp: `${today}T10:30:00Z`, outcome: 'failure' },
  { skill: 'vague-skill', timestamp: `${today}T12:00:00Z`, outcome: 'failure' },
  { skill: 'short-skill', timestamp: `${today}T09:00:00Z`, outcome: 'failure' },
  { skill: 'short-skill', timestamp: `${today}T09:30:00Z`, outcome: 'failure' },
  { skill: 'clean-skill', timestamp: `${today}T08:00:00Z`, outcome: 'success' },
]);

writeLog(yesterday, [
  { skill: 'vague-skill', timestamp: `${yesterday}T14:00:00Z`, outcome: 'failure' },
  { skill: 'vague-skill', timestamp: `${yesterday}T15:00:00Z`, outcome: 'failure' },
  { skill: 'test-skill', timestamp: `${yesterday}T16:00:00Z`, outcome: 'failure' },
  { skill: 'short-skill', timestamp: `${yesterday}T11:00:00Z`, outcome: 'failure' },
]);

writeLog(threeDaysAgo, [
  { skill: 'vague-skill', timestamp: `${threeDaysAgo}T10:00:00Z`, outcome: 'failure' },
  { skill: 'vague-skill', timestamp: `${threeDaysAgo}T11:00:00Z`, outcome: 'failure' },
  { skill: 'vague-skill', timestamp: `${threeDaysAgo}T12:00:00Z`, outcome: 'failure' },
]);

// ── Test 1: groupFailuresBySkill ───────────────────────────────

console.log('\n--- groupFailuresBySkill ---');
const failures = fa.groupFailuresBySkill(logDir, 7);
check('found failures for test-skill', failures.has('test-skill'));
check('found failures for vague-skill', failures.has('vague-skill'));
check('found failures for short-skill', failures.has('short-skill'));
check('test-skill has 2 failures', failures.get('test-skill').length === 2);
check('vague-skill has 7 failures', failures.get('vague-skill').length === 7);
check('short-skill has 3 failures', failures.get('short-skill').length === 3);
check('clean-skill not in failures (no failures)', !failures.has('clean-skill'));

// ── Test 2: readSkillMd ────────────────────────────────────────

console.log('\n--- readSkillMd ---');
const testResult = fa.readSkillMd('test-skill', globalJson);
check('readSkillMd returns content for test-skill', testResult.content !== null);
check('readSkillMd returns entry for test-skill', testResult.entry !== null);
check('readSkillMd content contains "Test Skill"', testResult.content.includes('Test Skill'));

const missingResult = fa.readSkillMd('nonexistent', globalJson);
check('readSkillMd returns null for nonexistent', missingResult.content === null);

// ── Test 3: analyzeFailurePatterns ─────────────────────────────

console.log('\n--- analyzeFailurePatterns ---');
const testFailures = failures.get('test-skill');
const testPatterns = fa.analyzeFailurePatterns(testFailures, testSkillContent);
check('test-skill patterns exist', testPatterns.failureCount === 2);

const vagueFailures = failures.get('vague-skill');
const vaguePatterns = fa.analyzeFailurePatterns(vagueFailures, vagueSkillContent);
check('vague-skill suggests wrong trigger', vaguePatterns.suggestsWrongTrigger === true);
check('vague-skill has reasons', vaguePatterns.reasons.length > 0);

const shortFailures = failures.get('short-skill');
const shortPatterns = fa.analyzeFailurePatterns(shortFailures, shortSkillContent);
check('short-skill suggests anti-pattern', shortPatterns.suggestsAntiPattern === true);

// ── Test 4: generatePatch ──────────────────────────────────────

console.log('\n--- generatePatch ---');

// vague-skill → tighten-when
const vagueEntry = { id: 'vague-skill', when: 'vague', path: path.join(skillsDir, 'vague-skill', 'SKILL.md') };
const vaguePatch = fa.generatePatch('vague-skill', vagueFailures, vagueSkillContent, vagueEntry);
check('vague-skill patch generated', vaguePatch.patch !== null);
check('vague-skill patch type is tighten-when or add-when',
  vaguePatch.type === 'tighten-when' || vaguePatch.type === 'add-when');

// short-skill → add-anti-patterns
const shortEntry = { id: 'short-skill', when: 'General use', path: path.join(skillsDir, 'short-skill', 'SKILL.md') };
const shortPatch = fa.generatePatch('short-skill', shortFailures, shortSkillContent, shortEntry);
check('short-skill patch generated', shortPatch.patch !== null);
check('short-skill patch type is tighten-when or add-anti-patterns',
  shortPatch.type === 'tighten-when' || shortPatch.type === 'add-anti-patterns');

// test-skill (2 failures, moderate content) → generic-improvement
const testEntry = { id: 'test-skill', when: 'testing', path: path.join(skillsDir, 'test-skill', 'SKILL.md') };
const testPatch = fa.generatePatch('test-skill', testFailures, testSkillContent, testEntry);
check('test-skill patch generated', testPatch.patch !== null);

// No content → no-content
const noContentPatch = fa.generatePatch('missing', [], null, {});
check('no-content returns null patch', noContentPatch.patch === null);
check('no-content type is no-content', noContentPatch.type === 'no-content');

// ── Test 5: writeProposal / listProposals / readProposal / deleteProposal ──

console.log('\n--- Proposal file management ---');
const filePath = fa.writeProposal('test-skill', '--- a/skills/test-skill/SKILL.md\n+++ b/skills/test-skill/SKILL.md\n@@ -1 +1 @@\n-old\n+new\n', 'generic-improvement', 'Test proposal', proposalsDir);
check('proposal file created', fs.existsSync(filePath));

const proposals = fa.listProposals(proposalsDir);
check('listProposals returns 1 proposal', proposals.length === 1);
check('proposal has skill field', proposals[0].skill === 'test-skill');
check('proposal has type field', proposals[0].type === 'generic-improvement');

const readBack = fa.readProposal(path.basename(filePath), proposalsDir);
check('readProposal returns parsed proposal', readBack !== null);
check('readProposal has meta', readBack.meta.skill === 'test-skill');
check('readProposal has diff', readBack.diff.includes('--- a/'));

const deletedPath = fa.deleteProposal(path.basename(filePath), proposalsDir);
check('deleteProposal removes file', !fs.existsSync(deletedPath));
check('listProposals returns 0 after delete', fa.listProposals(proposalsDir).length === 0);

// ── Test 6: analyzeFailures (dry-run) ──────────────────────────

console.log('\n--- analyzeFailures (dry-run) ---');
const dryRunResults = fa.analyzeFailures({
  logDir,
  globalJson,
  proposalsDir,
  sinceDays: 7,
  dryRun: true,
});
check('dry-run returns 0 proposals (not written)', dryRunResults.length === 0);

// ── Test 7: analyzeFailures (real) ─────────────────────────────

console.log('\n--- analyzeFailures (real) ---');
const realResults = fa.analyzeFailures({
  logDir,
  globalJson,
  proposalsDir,
  sinceDays: 7,
  dryRun: false,
});
check('real run generates proposals', realResults.length > 0);

const afterProposals = fa.listProposals(proposalsDir);
check('proposals written to disk', afterProposals.length === realResults.length);

// ── Test 8: CLI subcommands ────────────────────────────────────

console.log('\n--- CLI subcommands ---');

function runCli(args) {
  try {
    return execSync(`node "${faPath}" ${args}`, {
      stdio: 'pipe',
      encoding: 'utf-8',
      env: { ...process.env },
    });
  } catch (e) {
    return e.stdout || e.message;
  }
}

const listOut = runCli(`list --proposals-dir "${proposalsDir}"`);
check('CLI list shows proposals', /test-skill/.test(listOut));

// ── Cleanup ────────────────────────────────────────────────────

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
