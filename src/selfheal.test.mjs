#!/usr/bin/env node

/**
 * meta-skills v0.2.0 — Self-healing skill instructions: tests
 * Run: node src/selfheal.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert';
import {
  DEFAULT_THRESHOLD,
  extractKeywords,
  hash6,
  captureTestCase,
  captureFromFailureEvent,
  scoreSkillAgainstCase,
  listTestCases,
  runSuite,
  validateMutation,
} from './selfheal.mjs';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`✗ ${name}: ${e.message}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'selfheal-test-'));
const testsDir = path.join(tmp, 'tests');

// ── extractKeywords ────────────────────────────────────────────

test('extractKeywords: basic tokenization', () => {
  const kws = extractKeywords('Deploy the rollback script to production');
  assert.ok(kws.includes('deploy'));
  assert.ok(kws.includes('rollback'));
  assert.ok(kws.includes('production'));
});

test('extractKeywords: stopwords removed', () => {
  const kws = extractKeywords('the and for with please can should');
  assert.deepStrictEqual(kws, []);
});

test('extractKeywords: markdown stripped', () => {
  const kws = extractKeywords('# Heading\n**bold** `inline code` ```block```');
  assert.ok(!kws.includes('block'));
  assert.ok(!kws.includes('inline code'));
});

test('extractKeywords: short tokens dropped', () => {
  const kws = extractKeywords('go up it ok do');
  assert.deepStrictEqual(kws, []);
});

test('extractKeywords: numeric tokens dropped', () => {
  const kws = extractKeywords('run 12345 times with timeout');
  assert.ok(!kws.includes('12345'));
  assert.ok(kws.includes('timeout'));
});

test('extractKeywords: sorted by freq desc then alpha', () => {
  const kws = extractKeywords('alpha beta beta gamma gamma gamma');
  assert.strictEqual(kws[0], 'gamma');
  assert.strictEqual(kws[1], 'beta');
  assert.strictEqual(kws[2], 'alpha');
});

test('extractKeywords: respects max', () => {
  const kws = extractKeywords('aaa bbb ccc ddd eee fff ggg hhh iii jjj kkk lll mmm', { max: 3 });
  assert.strictEqual(kws.length, 3);
});

test('extractKeywords: deterministic', () => {
  const text = 'chaos monkey deploys rollback during deploy window';
  assert.deepStrictEqual(extractKeywords(text), extractKeywords(text));
});

test('extractKeywords: empty/null input', () => {
  assert.deepStrictEqual(extractKeywords(''), []);
  assert.deepStrictEqual(extractKeywords(null), []);
});

// ── hash6 ──────────────────────────────────────────────────────

test('hash6: deterministic, 6 chars', () => {
  const h = hash6('some prompt');
  assert.strictEqual(h.length, 6);
  assert.strictEqual(h, hash6('some prompt'));
});

test('hash6: different inputs differ', () => {
  assert.notStrictEqual(hash6('prompt one'), hash6('prompt two'));
});

// ── captureTestCase ────────────────────────────────────────────

test('captureTestCase: writes file with correct shape', () => {
  const tc = captureTestCase('git-commits', 'Deploy rollback failed on production', {
    hint: 'rollback step missing',
    testsDir,
    now: new Date('2026-08-27T01:30:00Z'),
  });
  assert.strictEqual(tc.skill_id, 'git-commits');
  assert.strictEqual(tc.source, 'manual');
  assert.ok(tc.id.startsWith('tc-'));
  assert.ok(fs.existsSync(tc.file));
  const onDisk = JSON.parse(fs.readFileSync(tc.file, 'utf-8'));
  assert.strictEqual(onDisk.hint, 'rollback step missing');
  assert.ok(onDisk.keywords.includes('rollback'));
});

test('captureTestCase: id contains timestamp + hash', () => {
  const tc = captureTestCase('s1', 'unique prompt content here', {
    testsDir,
    now: new Date('2026-08-27T02:00:00Z'),
  });
  assert.match(tc.id, /^tc-\d{8}T\d{6}-[a-z0-9]{6}$/);
});

test('captureTestCase: deterministic id for same prompt+time', () => {
  const a = captureTestCase('det', 'same prompt', { testsDir, now: new Date('2026-08-27T03:00:00Z') });
  const b = captureTestCase('det', 'same prompt', { testsDir, now: new Date('2026-08-27T03:00:00Z') });
  assert.strictEqual(a.id, b.id);
});

test('captureTestCase: throws without prompt', () => {
  assert.throws(() => captureTestCase('x', '', { testsDir }), /prompt required/);
});

test('captureTestCase: throws without skill-id', () => {
  assert.throws(() => captureTestCase('', 'prompt', { testsDir }), /skill-id required/);
});

// ── captureFromFailureEvent ────────────────────────────────────

test('captureFromFailureEvent: synthesizes prompt, source=failure', () => {
  const tc = captureFromFailureEvent('deploy-app', {
    timestamp: '2026-08-26T10:00:00Z',
    hint: 'ssh timeout on step 3',
  }, { testsDir, now: new Date('2026-08-27T04:00:00Z') });
  assert.strictEqual(tc.source, 'failure');
  assert.ok(tc.prompt.includes('deploy-app'));
  assert.ok(tc.prompt.includes('ssh timeout on step 3'));
  assert.ok(fs.existsSync(tc.file));
});

test('captureFromFailureEvent: fallback when no hint', () => {
  const tc = captureFromFailureEvent('nohint-skill', { timestamp: '2026-08-26T11:00:00Z' }, { testsDir });
  assert.ok(tc.prompt.includes('no reason recorded'));
});

// ── scoreSkillAgainstCase ──────────────────────────────────────

const GOOD_SKILL = `---
when: deploying applications to production
---
# Deploy App

1. Run preflight checks
2. Execute deploy script
3. Verify health endpoint

Avoid deploying during the freeze window. Do not skip rollback testing.
`;

test('scoreSkillAgainstCase: full coverage + structure + caution = 100', () => {
  const tc = { keywords: ['deploy', 'production'] };
  const score = scoreSkillAgainstCase(GOOD_SKILL, tc);
  assert.strictEqual(score, 100);
});

test('scoreSkillAgainstCase: zero keyword coverage', () => {
  const tc = { keywords: ['zebra', 'xylophone'] };
  const score = scoreSkillAgainstCase(GOOD_SKILL, tc);
  assert.strictEqual(score, 40); // 0 + 20 structure + 20 caution
});

test('scoreSkillAgainstCase: no structure, no caution', () => {
  const score = scoreSkillAgainstCase('deploy production notes', { keywords: ['deploy'] });
  assert.strictEqual(score, 60);
});

test('scoreSkillAgainstCase: empty keywords → full coverage credit', () => {
  const score = scoreSkillAgainstCase(GOOD_SKILL, { keywords: [] });
  assert.strictEqual(score, 100);
});

test('scoreSkillAgainstCase: null inputs → 0', () => {
  assert.strictEqual(scoreSkillAgainstCase(null, { keywords: [] }), 0);
  assert.strictEqual(scoreSkillAgainstCase('text', null), 0);
});

test('scoreSkillAgainstCase: partial coverage proportional', () => {
  const score = scoreSkillAgainstCase('deploy only', { keywords: ['deploy', 'missing'] });
  assert.strictEqual(score, 30); // 0.5*60
});

// ── listTestCases ──────────────────────────────────────────────

test('listTestCases: lists one skill', () => {
  const cases = listTestCases('git-commits', { testsDir });
  assert.strictEqual(cases.length, 1);
  assert.strictEqual(cases[0].skill_id, 'git-commits');
});

test('listTestCases: lists all skills', () => {
  const cases = listTestCases(null, { testsDir });
  assert.ok(cases.length >= 4);
  const skills = new Set(cases.map(c => c.skill_id));
  assert.ok(skills.has('git-commits'));
  assert.ok(skills.has('deploy-app'));
});

test('listTestCases: sorted by captured_at asc', () => {
  const cases = listTestCases(null, { testsDir });
  const stamps = cases.map(c => c.captured_at);
  assert.deepStrictEqual(stamps, [...stamps].sort());
});

test('listTestCases: missing dir → empty', () => {
  assert.deepStrictEqual(listTestCases('ghost', { testsDir: path.join(tmp, 'nope') }), []);
});

// ── runSuite ───────────────────────────────────────────────────

test('runSuite: scores all cases against content', () => {
  const result = runSuite('git-commits', { skillContent: GOOD_SKILL, testsDir });
  assert.strictEqual(result.total, 1);
  assert.strictEqual(result.cases.length, 1);
  assert.ok(result.cases[0].score >= 0 && result.cases[0].score <= 100);
});

test('runSuite: threshold controls pass', () => {
  const low = runSuite('git-commits', { skillContent: GOOD_SKILL, testsDir, threshold: 1 });
  const high = runSuite('git-commits', { skillContent: 'nothing relevant', testsDir, threshold: 99 });
  assert.strictEqual(low.passed, 1);
  assert.strictEqual(high.passed, 0);
});

test('runSuite: empty suite', () => {
  const result = runSuite('ghost-skill', { skillContent: GOOD_SKILL, testsDir });
  assert.strictEqual(result.total, 0);
  assert.strictEqual(result.passed, 0);
});

test('runSuite: default threshold is DEFAULT_THRESHOLD', () => {
  const result = runSuite('git-commits', { skillContent: GOOD_SKILL, testsDir });
  assert.strictEqual(result.threshold, DEFAULT_THRESHOLD);
});

test('runSuite: missing skillPath → all scores 0', () => {
  const result = runSuite('git-commits', { skillPath: path.join(tmp, 'missing.md'), testsDir });
  assert.strictEqual(result.cases[0].score, 0);
});

// ── validateMutation ───────────────────────────────────────────

test('validateMutation: accept when mutation improves', () => {
  const result = validateMutation('git-commits', {
    originalContent: 'deploy notes',
    mutatedContent: GOOD_SKILL,
    testsDir,
    threshold: 50,
  });
  assert.strictEqual(result.verdict, 'accept');
  assert.strictEqual(result.cases[0].delta >= 0, true);
});

test('validateMutation: reject on regression', () => {
  const result = validateMutation('git-commits', {
    originalContent: GOOD_SKILL,
    mutatedContent: 'deploy only',
    testsDir,
    threshold: 50,
  });
  assert.strictEqual(result.verdict, 'reject');
  assert.ok(result.reasons.some(r => /regression/.test(r)));
});

test('validateMutation: reject when no cases exist', () => {
  const result = validateMutation('ghost-skill', {
    originalContent: 'x',
    mutatedContent: 'y',
    testsDir,
  });
  assert.strictEqual(result.verdict, 'reject');
  assert.ok(result.reasons.some(r => /no test cases/));
});

test('validateMutation: means reported', () => {
  const result = validateMutation('git-commits', {
    originalContent: 'deploy notes',
    mutatedContent: GOOD_SKILL,
    testsDir,
  });
  assert.strictEqual(typeof result.means.original, 'number');
  assert.strictEqual(typeof result.means.mutated, 'number');
});

test('validateMutation: throws without skill-id', () => {
  assert.throws(() => validateMutation('', { originalContent: '', mutatedContent: '' }), /skill-id required/);
});

test('validateMutation: equal scores → accept (Pareto non-regression)', () => {
  const result = validateMutation('git-commits', {
    originalContent: GOOD_SKILL,
    mutatedContent: GOOD_SKILL + '\nMore deploy guidance for production.',
    testsDir,
  });
  assert.strictEqual(result.verdict, 'accept');
});

// ── summary ────────────────────────────────────────────────────

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`selfheal: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
