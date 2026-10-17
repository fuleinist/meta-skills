#!/usr/bin/env node

/**
 * meta-skills v0.2.5 — Generality / transferability audit tests (issue #41)
 *
 * Pure functions only: no temp dirs, no filesystem.
 */

import assert from 'node:assert/strict';

import {
  auditGenerality,
  formatGeneralityReport,
  labelFor,
} from './generality-audit.mjs';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ---- True positives --------------------------------------------------------

test('abs-path — Windows absolute path is flagged', () => {
  const report = auditGenerality('Write output to D:\\out\\report.txt before shipping.');
  const abs = report.flags.find(f => f.kind === 'abs-path');
  assert.ok(abs, 'abs-path flag present');
  assert.equal(abs.count, 1);
  assert.equal(abs.match, 'D:\\');
  // single stray path should not wreck the score
  assert.equal(report.score, 88);
  assert.equal(report.label, 'general');
});

test('abs-path — /Users/ path is flagged and overlaps user-name', () => {
  const report = auditGenerality('Load C:\\Users\\bob\\app\\cfg.json when debugging.');
  assert.ok(report.flags.some(f => f.kind === 'abs-path'), 'abs-path counted');
  const user = report.flags.find(f => f.kind === 'user-name');
  assert.ok(user, 'user-name counted as its own kind');
  assert.equal(user.count, 1);
  assert.equal(report.score, 78); // 12 + 10
  assert.equal(report.label, 'mixed');
});

test('abs-path — UNC share is flagged', () => {
  const report = auditGenerality('copy from \\\\server\\share\\logs to the cache');
  const abs = report.flags.find(f => f.kind === 'abs-path');
  assert.ok(abs, 'UNC path counted');
  assert.equal(abs.match, '\\\\server');
});

test('machine-name — machine phrasing is flagged', () => {
  const report = auditGenerality('On this machine, run npm install first.');
  const mn = report.flags.find(f => f.kind === 'machine-name');
  assert.ok(mn, 'machine-name counted');
  assert.equal(mn.match, 'this machine');
  assert.equal(report.score, 92);
});

test('repo-local — phrase plus filename token is flagged', () => {
  const report = auditGenerality('In this repo, patch build.py before running tests.');
  const rl = report.flags.find(f => f.kind === 'repo-local');
  assert.ok(rl, 'repo-local counted');
  assert.equal(rl.count, 1);
  assert.equal(report.score, 90);
});

test('repo-local — phrase without a filename token is not flagged', () => {
  const report = auditGenerality('In this repo we prefer tabs over spaces.');
  assert.ok(!report.flags.some(f => f.kind === 'repo-local'), 'no repo-local flag');
  assert.equal(report.score, 100);
});

test('one-off-url — docs URL is counted but weighted lightly', () => {
  const report = auditGenerality('See https://nodejs.org/api/fs.html for details.');
  const url = report.flags.find(f => f.kind === 'one-off-url');
  assert.ok(url, 'url counted');
  assert.equal(report.score, 97);
  assert.equal(report.label, 'general');
});

// ---- Fixtures --------------------------------------------------------------

test('clean fixture — general skill scores high', () => {
  const content = `---
name: commit-messages
description: Writes conventional commit messages
---

# Commit Messages

## Steps

1. Read the staged diff
2. Classify the change type
3. Write a one-line summary under 72 chars

## Notes

Keep the summary imperative and avoid filler words.
`;
  const report = auditGenerality(content);
  assert.equal(report.flags.length, 0, 'no flags');
  assert.equal(report.score, 100);
  assert.equal(report.label, 'general');
  assert.equal(report.ratio, 0);
});

test('mixed fixture — a few localized signals land in the mixed band', () => {
  const content = 'Use C:\\cache\\data on this machine. ' +
    'Also check E:\\tmp\\work on this machine.';
  const report = auditGenerality(content);
  assert.equal(report.flags.find(f => f.kind === 'abs-path').count, 2);
  assert.equal(report.flags.find(f => f.kind === 'machine-name').count, 2);
  assert.equal(report.score, 60); // 24 + 16
  assert.equal(report.label, 'mixed');
});

test('localized fixture — heavy localized content drops below 50', () => {
  const content = Array.from({ length: 4 }, (_, i) => `read C:\\p${i}\\f`).join(' ') +
    ' on this machine and this machine';
  const report = auditGenerality(content);
  assert.equal(report.flags.find(f => f.kind === 'abs-path').count, 4);
  assert.equal(report.score, 36); // 48 + 16
  assert.equal(report.label, 'localized');
});

test('ratio — flags per 1000 chars, rounded to 2 decimals', () => {
  const content = 'C:\\Users\\bob\\x'; // 14 chars, 2 flags (abs-path + user-name)
  const report = auditGenerality(content);
  assert.equal(report.flags.length, 2);
  assert.equal(report.ratio, Math.round((2 / 14) * 1000 * 100) / 100);
  assert.equal(report.ratio, 142.86);
});

test('caps — repeated signals cannot sink the score past the cap', () => {
  const content = Array.from({ length: 10 }, (_, i) => `C:\\a${i}`).join(' ');
  const report = auditGenerality(content);
  assert.equal(report.flags.find(f => f.kind === 'abs-path').count, 10);
  assert.equal(report.score, 52); // capped at 48
});

// ---- Label boundaries ------------------------------------------------------

test('label boundaries — 80/79 and 50/49', () => {
  assert.equal(labelFor(80), 'general');
  assert.equal(labelFor(79), 'mixed');
  assert.equal(labelFor(50), 'mixed');
  assert.equal(labelFor(49), 'localized');

  // driven through the scorer, not just the label helper
  assert.equal(auditGenerality('C:\\x', { weights: { 'abs-path': 20 } }).score, 80);
  assert.equal(auditGenerality('C:\\x', { weights: { 'abs-path': 20 } }).label, 'general');
  assert.equal(auditGenerality('C:\\x', { weights: { 'abs-path': 21 } }).label, 'mixed');
  assert.equal(auditGenerality('C:\\x', { weights: { 'abs-path': 50 }, caps: { 'abs-path': 100 } }).label, 'mixed');
  assert.equal(auditGenerality('C:\\x', { weights: { 'abs-path': 51 }, caps: { 'abs-path': 100 } }).label, 'localized');
});

test('opts.signals — restricts which kinds are scanned', () => {
  const report = auditGenerality('C:\\Users\\bob\\x', { signals: ['abs-path'] });
  assert.equal(report.flags.length, 1);
  assert.equal(report.flags[0].kind, 'abs-path');
  assert.equal(report.score, 88);
});

test('empty content — clean, no flags', () => {
  const report = auditGenerality('');
  assert.equal(report.score, 100);
  assert.equal(report.label, 'general');
  assert.equal(report.ratio, 0);
});

// ---- Format rendering ------------------------------------------------------

test('formatGeneralityReport — one short line', () => {
  const report = auditGenerality('Use D:\\out\\report.txt on this machine');
  assert.equal(report.score, 80);
  assert.equal(
    formatGeneralityReport(report),
    'generality: 80/100 (general) — flags: abs-path x1, machine-name x1',
  );
});

test('formatGeneralityReport — clean report says no localized signals', () => {
  assert.equal(
    formatGeneralityReport(auditGenerality('Run the tests before shipping.')),
    'generality: 100/100 (general) — no localized signals',
  );
});

// ---- Runner ----------------------------------------------------------------

(async () => {
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await Promise.resolve().then(fn);
      passed++;
      console.log('  ok   ' + name);
    } catch (e) {
      failed++;
      console.error('  FAIL ' + name + ': ' + e.message);
      if (e.stack) console.error(e.stack.split('\n').slice(1, 4).join('\n'));
    }
  }
  const total = passed + failed;
  console.log(`\ngenerality-audit.test.mjs: ${passed}/${total} passed`);
  if (failed > 0) process.exit(1);
})();
