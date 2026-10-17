#!/usr/bin/env node

/**
 * meta-skills v0.2.5 — Persistent knowledge layer (wiki) tests
 * Run: node src/wiki.test.mjs
 *
 * Every test runs inside a temp directory; the real ~/.meta-skills is
 * never touched.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert';
import {
  defaultWikiDir,
  ensureWiki,
  readWikiIndex,
  readWiki,
  updateIndex,
  appendLog,
  createPattern,
  readPattern,
  updatePattern,
  listPatterns,
  recordSkillImpact,
  wikiStatus,
  slugifyPatternName,
  PatternExistsError,
  PatternNotFoundError,
} from './wiki.mjs';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}: ${e.message}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-'));
const wiki = path.join(tmp, 'wiki');

function tmpFiles(dir) {
  return fs.readdirSync(dir).filter(f => f.endsWith('.tmp'));
}

// ── Structure ────────────────────────────────────────────────────

test('defaultWikiDir: ~/.meta-skills/wiki', () => {
  assert.strictEqual(defaultWikiDir(), path.join(os.homedir(), '.meta-skills', 'wiki'));
});

test('ensureWiki: creates index.md, logs.md, skill-impact.md, patterns/', () => {
  const result = ensureWiki(wiki);
  assert.ok(fs.existsSync(path.join(wiki, 'index.md')));
  assert.ok(fs.existsSync(path.join(wiki, 'logs.md')));
  assert.ok(fs.existsSync(path.join(wiki, 'skill-impact.md')));
  assert.ok(fs.statSync(result.patternsDir).isDirectory());
  assert.strictEqual(result.created.length, 3);
});

test('ensureWiki: idempotent — second call creates nothing', () => {
  const again = ensureWiki(wiki);
  assert.deepStrictEqual(again.created, []);
  assert.strictEqual(again.dir, wiki);
});

test('ensureWiki: does not clobber existing content', () => {
  updateIndex(wiki, '# Wiki Index\n- alpha — root cause — fix\n');
  ensureWiki(wiki);
  assert.ok(readWikiIndex(wiki).includes('- alpha — root cause — fix'));
});

test('readWikiIndex: empty wiki returns empty string', () => {
  assert.strictEqual(readWikiIndex(path.join(tmp, 'nope')), '');
});

// ── Index ────────────────────────────────────────────────────────

test('updateIndex/readWikiIndex: roundtrip', () => {
  const content = '# Wiki Index\n\n- deploy timeout — no preflight — check health before retry\n';
  const result = updateIndex(wiki, content);
  assert.strictEqual(readWikiIndex(wiki), content);
  assert.ok(result.file.endsWith('index.md'));
  assert.strictEqual(result.bytes, Buffer.byteLength(content));
});

test('readWiki: index content + pattern listing', () => {
  createPattern(wiki, 'deploy-timeout', '# Deploy Timeout\n\nRoot cause: no preflight.\n');
  const snapshot = readWiki(wiki);
  assert.ok(snapshot.index.includes('deploy timeout'));
  assert.deepStrictEqual(snapshot.patterns, ['deploy-timeout.md']);
});

test('updateIndex: rejects non-string content', () => {
  assert.throws(() => updateIndex(wiki, 42), /must be a string/);
});

// ── Log ──────────────────────────────────────────────────────────

test('appendLog: writes a timestamped entry', () => {
  const entry = appendLog(wiki, 'captured pattern deploy-timeout from run 2026-08-27');
  assert.match(entry.line, /^- \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /);
  const log = fs.readFileSync(path.join(wiki, 'logs.md'), 'utf-8');
  assert.ok(log.startsWith('# Wiki Log\n'));
  assert.ok(log.includes(entry.line));
});

test('appendLog: preserves previous entries', () => {
  const before = fs.readFileSync(path.join(wiki, 'logs.md'), 'utf-8')
    .split('\n').filter(l => l.startsWith('- ')).length;
  const first = appendLog(wiki, 'first entry');
  const second = appendLog(wiki, 'second entry');
  const log = fs.readFileSync(path.join(wiki, 'logs.md'), 'utf-8');
  assert.ok(log.includes(first.line));
  assert.ok(log.includes(second.line));
  assert.strictEqual(log.split('\n').filter(l => l.startsWith('- ')).length, before + 2);
});

test('appendLog: rejects empty entry', () => {
  assert.throws(() => appendLog(wiki, '   '), /non-empty/);
});

// ── Patterns ─────────────────────────────────────────────────────

test('slugifyPatternName: normalizes case, spaces, extension', () => {
  assert.strictEqual(slugifyPatternName('Deploy Timeout'), 'deploy-timeout');
  assert.strictEqual(slugifyPatternName('Deploy-Timeout.md'), 'deploy-timeout');
  assert.strictEqual(slugifyPatternName('  Green_Preflight  '), 'green-preflight');
});

test('pattern CRUD: create/read/update roundtrip', () => {
  const created = createPattern(wiki, 'green-preflight', '# Green Preflight\n\nSuccess pattern: preflight before deploy.\n');
  assert.strictEqual(created.name, 'green-preflight');
  assert.ok(readPattern(wiki, 'green-preflight').includes('Success pattern'));
  updatePattern(wiki, 'green-preflight.md', '# Green Preflight\n\nSuccess pattern: preflight before deploy.\nObserved: 12 runs, zero failures.\n');
  assert.ok(readPattern(wiki, 'green-preflight').includes('zero failures'));
  assert.deepStrictEqual(listPatterns(wiki), ['deploy-timeout.md', 'green-preflight.md']);
});

test('listPatterns: sorted names', () => {
  createPattern(wiki, 'alpha-first', '# Alpha\n\nRoot cause: typo.\n');
  assert.deepStrictEqual(listPatterns(wiki), ['alpha-first.md', 'deploy-timeout.md', 'green-preflight.md']);
});

test('createPattern: duplicate throws', () => {
  assert.throws(() => createPattern(wiki, 'deploy-timeout', 'again'), PatternExistsError);
});

test('updatePattern: missing pattern throws', () => {
  assert.throws(() => updatePattern(wiki, 'no-such-pattern', 'body'), PatternNotFoundError);
});

test('readPattern: missing pattern throws', () => {
  assert.throws(() => readPattern(wiki, 'no-such-pattern'), PatternNotFoundError);
});

test('createPattern: empty slug throws', () => {
  assert.throws(() => createPattern(wiki, '...', 'body'), /produces an empty slug/);
});

// ── Skill impact ─────────────────────────────────────────────────

test('recordSkillImpact: appends a machine line and keeps history', () => {
  const a = recordSkillImpact(wiki, { skill: 'deploy-app', change: 'added preflight step', pattern: 'deploy-timeout' });
  const b = recordSkillImpact(wiki, 'success: preflight caught the timeout before deploy');
  const impact = fs.readFileSync(path.join(wiki, 'skill-impact.md'), 'utf-8');
  assert.ok(impact.startsWith('# Skill Impact\n'));
  assert.ok(impact.includes(a.line));
  assert.ok(impact.includes(b.line));
  assert.ok(a.line.includes('skill=deploy-app'));
  assert.ok(a.line.includes('pattern=deploy-timeout'));
  assert.ok(b.line.includes('skill=(none)'));
});

test('recordSkillImpact: rejects empty entry', () => {
  assert.throws(() => recordSkillImpact(wiki, {}), /skill or a change/);
});

// ── Status + atomicity ───────────────────────────────────────────

test('wikiStatus: reports files, patterns, last entry', () => {
  const status = wikiStatus(wiki);
  assert.strictEqual(status.dir, wiki);
  assert.strictEqual(status.files.length, 3);
  assert.strictEqual(status.patterns.length, 3);
  assert.ok(status.lastLog.includes('second entry'));
});

test('no leftover .tmp files after writes', () => {
  assert.deepStrictEqual(tmpFiles(wiki), []);
  assert.deepStrictEqual(tmpFiles(path.join(wiki, 'patterns')), []);
});

// ── summary ──────────────────────────────────────────────────────

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nwiki: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
