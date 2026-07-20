#!/usr/bin/env node
/**
 * meta-skills v1.8 — Skill Bundle Manager tests
 *
 * 28 unit tests covering name validation, skill validation, CRUD operations,
 * activation (dry-run + write), atomic write, suggest, and metrics.
 *
 * Uses Node's built-in test runner (matches v1.6/v1.7 test style).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  validateBundleName,
  validateBundleSkills,
  listBundles,
  getBundle,
  createBundle,
  deleteBundle,
  activateBundle,
  buildActivationEvents,
  suggestBundles,
  computeBundleMetrics,
  atomicWriteJson,
  todayLogFilename,
  BundleValidationError,
  BundleExistsError,
  BundleNotFoundError,
  CannotDeleteAutoBundleError,
  UnknownSkillError,
  BUNDLE_NAME_PATTERN,
  DEFAULT_MIN_COCCURRENCE_DAYS,
  ACTIVATION_SOURCE,
} from './bundle-manager.mjs';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeFixtureIndex(overrides = {}) {
  return {
    version: '1.0',
    generated: '2026-07-01T00:00:00+10:00',
    source: 'global',
    skills: [
      { id: 'react-skill', when: 'building React components and hooks', why: 'idiomatic React', path: '/a', priority: 'high', usage_count: 10 },
      { id: 'css-skill', when: 'writing CSS, styling components, layouts', why: 'modern CSS patterns', path: '/b', priority: 'medium', usage_count: 5 },
      { id: 'api-testing-skill', when: 'testing REST APIs and GraphQL endpoints', why: 'API test patterns', path: '/c', priority: 'medium', usage_count: 8 },
      { id: 'git-commits', when: 'writing commit messages, changelogs', why: 'conventional commits', path: '/d', priority: 'high', usage_count: 42 },
      { id: 'unused-skill', when: 'rarely used', why: 'legacy', path: '/e', priority: 'low', usage_count: 0 },
    ],
    bundles: [],
    suggested_bundles: [],
    ...overrides,
  };
}

function makeUserBundle(overrides = {}) {
  return {
    name: 'web-dev',
    description: 'web stack',
    skills: ['react-skill', 'css-skill', 'api-testing-skill'],
    tags: ['frontend'],
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeAutoBundle(skills, days) {
  return { skills, cooccurrenceDays: days };
}

// ===========================================================================
// AC: Name validation
// ===========================================================================

test('validateBundleName: accepts simple lowercase', () => {
  const r = validateBundleName('web-dev');
  assert.equal(r.ok, true);
});

test('validateBundleName: accepts digits and hyphens', () => {
  assert.equal(validateBundleName('web-dev-2').ok, true);
  assert.equal(validateBundleName('a1').ok, true);
  assert.equal(validateBundleName('release-flow-2026').ok, true);
});

test('validateBundleName: rejects empty / non-string', () => {
  assert.equal(validateBundleName('').ok, false);
  assert.equal(validateBundleName(null).ok, false);
  assert.equal(validateBundleName(undefined).ok, false);
  assert.equal(validateBundleName(123).ok, false);
});

test('validateBundleName: rejects uppercase', () => {
  const r = validateBundleName('WebDev');
  assert.equal(r.ok, false);
  assert.match(r.reason, /lowercase/);
});

test('validateBundleName: rejects underscore', () => {
  assert.equal(validateBundleName('web_dev').ok, false);
});

test('validateBundleName: rejects names > 64 chars', () => {
  const long = 'a'.repeat(65);
  const r = validateBundleName(long);
  assert.equal(r.ok, false);
});

test('validateBundleName: rejects leading hyphen', () => {
  assert.equal(validateBundleName('-web').ok, false);
});

test('BUNDLE_NAME_PATTERN: matches documented examples', () => {
  assert.match('web-dev', BUNDLE_NAME_PATTERN);
  assert.match('a', BUNDLE_NAME_PATTERN);
  assert.match('release-flow-2026', BUNDLE_NAME_PATTERN);
  assert.doesNotMatch('Web-Dev', BUNDLE_NAME_PATTERN);
  assert.doesNotMatch('-leading', BUNDLE_NAME_PATTERN);
  assert.doesNotMatch('', BUNDLE_NAME_PATTERN);
});

// ===========================================================================
// AC: Skill validation
// ===========================================================================

test('validateBundleSkills: accepts valid skills list', () => {
  const idx = makeFixtureIndex();
  const r = validateBundleSkills(['react-skill', 'css-skill'], idx);
  assert.equal(r.ok, true);
  assert.deepEqual(r.skills, ['react-skill', 'css-skill']);
});

test('validateBundleSkills: rejects empty array', () => {
  const r = validateBundleSkills([], makeFixtureIndex());
  assert.equal(r.ok, false);
});

test('validateBundleSkills: rejects non-array', () => {
  assert.equal(validateBundleSkills('react-skill', makeFixtureIndex()).ok, false);
  assert.equal(validateBundleSkills(null, makeFixtureIndex()).ok, false);
});

test('validateBundleSkills: rejects unknown skill id', () => {
  const idx = makeFixtureIndex();
  const r = validateBundleSkills(['react-skill', 'does-not-exist'], idx);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['does-not-exist']);
});

test('validateBundleSkills: rejects duplicates', () => {
  const idx = makeFixtureIndex();
  const r = validateBundleSkills(['react-skill', 'react-skill'], idx);
  assert.equal(r.ok, false);
  assert.match(r.reason, /duplicate/);
});

test('validateBundleSkills: rejects non-string skill id', () => {
  const r = validateBundleSkills(['react-skill', 42], makeFixtureIndex());
  assert.equal(r.ok, false);
});

// ===========================================================================
// AC1: listBundles with include filter
// ===========================================================================

test('listBundles: include=user returns only user bundles', () => {
  const idx = makeFixtureIndex({
    bundles: [makeUserBundle({ name: 'frontend' })],
    suggested_bundles: [makeAutoBundle(['git-commits', 'react-skill'], 5)],
  });
  const r = listBundles(idx, { include: 'user' });
  assert.equal(r.length, 1);
  assert.equal(r[0].name, 'frontend');
  assert.equal(r[0].source, 'user');
});

test('listBundles: include=auto returns only auto bundles', () => {
  const idx = makeFixtureIndex({
    bundles: [makeUserBundle({ name: 'frontend' })],
    suggested_bundles: [makeAutoBundle(['git-commits', 'react-skill'], 5)],
  });
  const r = listBundles(idx, { include: 'auto' });
  assert.equal(r.length, 1);
  assert.equal(r[0].source, 'auto');
  assert.equal(r[0].skills.length, 2);
  assert.equal(r[0].cooccurrenceDays, 5);
  assert.equal(r[0].name, 'git-commits+react-skill');
});

test('listBundles: include=all returns user then auto, with source tags', () => {
  const idx = makeFixtureIndex({
    bundles: [makeUserBundle({ name: 'frontend' })],
    suggested_bundles: [makeAutoBundle(['git-commits', 'react-skill'], 5)],
  });
  const r = listBundles(idx, { include: 'all' });
  assert.equal(r.length, 2);
  assert.equal(r[0].source, 'user');
  assert.equal(r[1].source, 'auto');
});

test('listBundles: returns empty arrays when index has no bundles', () => {
  const idx = makeFixtureIndex();
  // Defensive: remove the arrays to simulate a partial index.
  delete idx.bundles;
  delete idx.suggested_bundles;
  assert.deepEqual(listBundles(idx), []);
});

// ===========================================================================
// AC2 + AC3: createBundle + getBundle
// ===========================================================================

test('createBundle: adds bundle with timestamps and tags', () => {
  const idx = makeFixtureIndex();
  const before = new Date().toISOString();
  const b = createBundle(idx, {
    name: 'web-dev',
    skills: ['react-skill', 'css-skill'],
    description: 'frontend stack',
    tags: ['frontend', 'spa'],
  });
  const after = new Date().toISOString();
  assert.equal(b.name, 'web-dev');
  assert.equal(b.description, 'frontend stack');
  assert.deepEqual(b.skills, ['react-skill', 'css-skill']);
  assert.deepEqual(b.tags, ['frontend', 'spa']);
  assert.ok(b.createdAt >= before && b.createdAt <= after, 'createdAt within window');
  assert.equal(b.createdAt, b.updatedAt);
  assert.equal(idx.bundles.length, 1);
  assert.equal(idx.bundles[0].name, 'web-dev');
  assert.ok(idx.generated >= before);
});

test('createBundle: throws BundleValidationError on bad name', () => {
  const idx = makeFixtureIndex();
  assert.throws(
    () => createBundle(idx, { name: 'BadName', skills: ['react-skill'] }),
    BundleValidationError
  );
});

test('createBundle: throws BundleExistsError on duplicate name', () => {
  const idx = makeFixtureIndex({
    bundles: [makeUserBundle({ name: 'web-dev' })],
  });
  assert.throws(
    () => createBundle(idx, { name: 'web-dev', skills: ['react-skill'] }),
    BundleExistsError
  );
});

test('createBundle: throws UnknownSkillError when skill not in index', () => {
  const idx = makeFixtureIndex();
  assert.throws(
    () => createBundle(idx, { name: 'weird', skills: ['nope-skill'] }),
    UnknownSkillError
  );
});

test('createBundle: initializes index.bundles if missing', () => {
  const idx = makeFixtureIndex();
  delete idx.bundles;
  const b = createBundle(idx, { name: 'web-dev', skills: ['react-skill'] });
  assert.ok(Array.isArray(idx.bundles));
  assert.equal(idx.bundles[0].name, 'web-dev');
});

test('getBundle: returns user bundle by name', () => {
  const idx = makeFixtureIndex({ bundles: [makeUserBundle({ name: 'web-dev' })] });
  const b = getBundle(idx, 'web-dev');
  assert.equal(b.name, 'web-dev');
  assert.equal(b.source, 'user');
});

test('getBundle: returns auto bundle by skills+skills key', () => {
  const idx = makeFixtureIndex({
    suggested_bundles: [makeAutoBundle(['git-commits', 'react-skill'], 5)],
  });
  const b = getBundle(idx, 'git-commits+react-skill');
  assert.ok(b);
  assert.equal(b.source, 'auto');
  assert.deepEqual(b.skills, ['git-commits', 'react-skill']);
  assert.equal(b.cooccurrenceDays, 5);
});

test('getBundle: returns null when not found', () => {
  const idx = makeFixtureIndex();
  assert.equal(getBundle(idx, 'nope'), null);
});

test('getBundle: user bundle takes precedence over auto with same key', () => {
  const idx = makeFixtureIndex({
    bundles: [makeUserBundle({ name: 'react-skill+css-skill' })],
    suggested_bundles: [makeAutoBundle(['react-skill', 'css-skill'], 5)],
  });
  const b = getBundle(idx, 'react-skill+css-skill');
  assert.equal(b.source, 'user');
});

// ===========================================================================
// AC4: deleteBundle
// ===========================================================================

test('deleteBundle: removes user bundle and updates generated', () => {
  const idx = makeFixtureIndex({
    bundles: [makeUserBundle({ name: 'web-dev' })],
  });
  const before = idx.generated;
  const removed = deleteBundle(idx, 'web-dev');
  assert.equal(removed.name, 'web-dev');
  assert.equal(idx.bundles.length, 0);
  assert.notEqual(idx.generated, before);
});

test('deleteBundle: throws CannotDeleteAutoBundleError for auto bundle', () => {
  const idx = makeFixtureIndex({
    suggested_bundles: [makeAutoBundle(['react-skill', 'css-skill'], 5)],
  });
  assert.throws(
    () => deleteBundle(idx, 'react-skill+css-skill'),
    CannotDeleteAutoBundleError
  );
});

test('deleteBundle: throws BundleNotFoundError for missing name', () => {
  assert.throws(
    () => deleteBundle(makeFixtureIndex(), 'nope'),
    BundleNotFoundError
  );
});

// ===========================================================================
// AC5: activateBundle + log writing
// ===========================================================================

test('buildActivationEvents: emits one event per skill with bundle metadata', () => {
  const bundle = makeUserBundle({ name: 'web-dev' });
  const events = buildActivationEvents(bundle, { now: new Date('2026-07-15T10:00:00Z') });
  assert.equal(events.length, 3);
  assert.equal(events[0].skill, 'react-skill');
  assert.equal(events[0].source, ACTIVATION_SOURCE);
  assert.equal(events[0].bundle, 'web-dev');
  assert.equal(events[0].outcome, 'success');
  assert.equal(events[0].timestamp, '2026-07-15T10:00:00.000Z');
});

test('activateBundle: dry-run returns events without writing', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-dryrun-'));
  const bundle = makeUserBundle({ name: 'web-dev' });
  const r = activateBundle(bundle, { logDir: tmpDir, dryRun: true });
  assert.equal(r.dryRun, true);
  assert.equal(r.written, 0);
  assert.equal(r.events.length, 3);
  // No files written.
  assert.deepEqual(fs.readdirSync(tmpDir), []);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('activateBundle: write mode appends to YYYY-MM-DD.jsonl', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-write-'));
  const bundle = makeUserBundle({ name: 'web-dev' });
  const r = activateBundle(bundle, { logDir: tmpDir, dryRun: false });
  assert.equal(r.dryRun, false);
  assert.equal(r.written, 3);
  const files = fs.readdirSync(tmpDir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^\d{4}-\d{2}-\d{2}\.jsonl$/);
  const content = fs.readFileSync(path.join(tmpDir, files[0]), 'utf8');
  const lines = content.trim().split('\n');
  assert.equal(lines.length, 3);
  const first = JSON.parse(lines[0]);
  assert.equal(first.skill, 'react-skill');
  assert.equal(first.bundle, 'web-dev');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('todayLogFilename: formats YYYY-MM-DD with leading zeros', () => {
  const d = new Date(2026, 0, 5); // Jan 5, 2026 local
  assert.equal(todayLogFilename(d), '2026-01-05.jsonl');
  const d2 = new Date(2026, 11, 31); // Dec 31
  assert.equal(todayLogFilename(d2), '2026-12-31.jsonl');
});

// ===========================================================================
// AC6: suggestBundles (co-occurrence detection)
// ===========================================================================

test('suggestBundles: returns pairs that co-occurred ≥ minDays', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-suggest-'));
  // Day 1: a + b
  fs.writeFileSync(path.join(tmpDir, '2026-07-01.jsonl'),
    `${JSON.stringify({ skill: 'a', timestamp: '2026-07-01T10:00:00Z' })}\n${JSON.stringify({ skill: 'b', timestamp: '2026-07-01T10:01:00Z' })}\n`);
  // Day 2: a + b again
  fs.writeFileSync(path.join(tmpDir, '2026-07-02.jsonl'),
    `${JSON.stringify({ skill: 'a', timestamp: '2026-07-02T10:00:00Z' })}\n${JSON.stringify({ skill: 'b', timestamp: '2026-07-02T10:01:00Z' })}\n`);
  // Day 3: a + b (third co-occurrence)
  fs.writeFileSync(path.join(tmpDir, '2026-07-03.jsonl'),
    `${JSON.stringify({ skill: 'a', timestamp: '2026-07-03T10:00:00Z' })}\n${JSON.stringify({ skill: 'b', timestamp: '2026-07-03T10:01:00Z' })}\n`);
  // Day 4: only c
  fs.writeFileSync(path.join(tmpDir, '2026-07-04.jsonl'),
    `${JSON.stringify({ skill: 'c', timestamp: '2026-07-04T10:00:00Z' })}\n`);

  const r = suggestBundles(tmpDir, { minDays: 3 });
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].skills, ['a', 'b']);
  assert.equal(r[0].cooccurrenceDays, 3);
  assert.equal(r[0].suggested, true);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('suggestBundles: returns empty when log dir does not exist', () => {
  const r = suggestBundles('/nonexistent/path/that/never/exists', { minDays: 3 });
  assert.deepEqual(r, []);
});

test('DEFAULT_MIN_COCCURRENCE_DAYS: is 3 (matches v0.4 self-improve)', () => {
  assert.equal(DEFAULT_MIN_COCCURRENCE_DAYS, 3);
});

// ===========================================================================
// AC7: atomicWriteJson
// ===========================================================================

test('atomicWriteJson: writes via temp file then rename', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-atomic-'));
  const target = path.join(tmpDir, 'global.json');
  const data = { hello: 'world', skills: [] };
  atomicWriteJson(target, data);
  // No leftover .tmp file
  assert.deepEqual(fs.readdirSync(tmpDir), ['global.json']);
  const read = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.deepEqual(read, data);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ===========================================================================
// AC8: computeBundleMetrics
// ===========================================================================

test('computeBundleMetrics: aggregates tokens and quality across skills', () => {
  const idx = makeFixtureIndex({
    skills: [
      { id: 'react-skill', when: 'react components', why: 'idiomatic React', path: '/a', priority: 'high', quality_score: 80 },
      { id: 'css-skill', when: 'css layouts', why: 'modern CSS', path: '/b', priority: 'medium', quality_score: 60 },
    ],
    bundles: [
      makeUserBundle({ name: 'web-dev', skills: ['react-skill', 'css-skill'] }),
    ],
  });
  const m = computeBundleMetrics(idx, 'web-dev');
  assert.ok(m);
  assert.equal(m.name, 'web-dev');
  assert.equal(m.source, 'user');
  assert.equal(m.skills.length, 2);
  assert.ok(m.totalTokens > 0);
  assert.equal(m.avgQuality, 70); // (80 + 60) / 2
  assert.deepEqual(m.scoreRange, { min: 60, max: 80 });
});

test('computeBundleMetrics: returns null for missing bundle', () => {
  assert.equal(computeBundleMetrics(makeFixtureIndex(), 'nope'), null);
});

test('computeBundleMetrics: handles skills with no quality_score', () => {
  const idx = makeFixtureIndex({
    skills: [
      { id: 'react-skill', when: 'react', why: 'react', path: '/a', priority: 'high' },
    ],
    bundles: [makeUserBundle({ name: 'web-dev', skills: ['react-skill'] })],
  });
  const m = computeBundleMetrics(idx, 'web-dev');
  assert.equal(m.avgQuality, null);
  assert.equal(m.scoreRange, null);
});

// ===========================================================================
// Smoke: standalone CLI dispatcher
// ===========================================================================

test('smoke: bundle-manager API surface is sufficient for CLI integration', () => {
  // The standalone CLI dispatcher at the bottom of bundle-manager.mjs uses
  // these same exports — this test ensures the surface is complete.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-cli-'));
  const globalPath = path.join(tmpDir, 'global.json');
  fs.writeFileSync(globalPath, JSON.stringify(makeFixtureIndex({
    bundles: [makeUserBundle({ name: 'web-dev' })],
  })));

  try {
    const idx = JSON.parse(fs.readFileSync(globalPath, 'utf8'));

    // Round-trip: create -> list -> show -> activate -> metrics -> delete.
    createBundle(idx, { name: 'cli-smoke', skills: ['react-skill', 'css-skill'], description: 'cli test', tags: ['test'] });
    atomicWriteJson(globalPath, idx);

    const after = JSON.parse(fs.readFileSync(globalPath, 'utf8'));
    const list = listBundles(after, { include: 'user' });
    assert.equal(list.length, 2); // original web-dev + new cli-smoke

    const got = getBundle(after, 'cli-smoke');
    assert.equal(got.source, 'user');
    assert.equal(got.tags[0], 'test');

    const metrics = computeBundleMetrics(after, 'cli-smoke');
    assert.ok(metrics);
    assert.ok(metrics.totalTokens > 0);

    const activation = activateBundle(got, { logDir: tmpDir, dryRun: true });
    assert.equal(activation.dryRun, true);
    assert.equal(activation.events.length, 2);

    deleteBundle(after, 'cli-smoke');
    atomicWriteJson(globalPath, after);

    const final = JSON.parse(fs.readFileSync(globalPath, 'utf8'));
    assert.equal(final.bundles.length, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});