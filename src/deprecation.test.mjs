#!/usr/bin/env node

/**
 * Tests for v0.1.7 — Deprecation & Successor Routing
 * Run: node src/deprecation.test.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strict as assert } from 'node:assert';

// Import the module under test
const mod = await import('./deprecation.mjs');
const {
  isDeprecated,
  getSuccessor,
  warnIfDeprecated,
  resolveActiveSkill,
  findDeprecatedActive,
  excludeFromBudget,
  deprecateSkill,
  undeprecateSkill,
} = mod;

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
  }
}

console.log('deprecation.test.mjs — v0.1.7\n');

// ── isDeprecated ──────────────────────────────────────────────────────

test('isDeprecated returns true when deprecated is true', () => {
  assert.equal(isDeprecated({ deprecated: true }), true);
});

test('isDeprecated returns false when deprecated is absent', () => {
  assert.equal(isDeprecated({ id: 'foo' }), false);
});

test('isDeprecated returns false when deprecated is false', () => {
  assert.equal(isDeprecated({ id: 'foo', deprecated: false }), false);
});

test('isDeprecated returns false for null/undefined', () => {
  assert.equal(isDeprecated(null), false);
  assert.equal(isDeprecated(undefined), false);
});

// ── getSuccessor ──────────────────────────────────────────────────────

test('getSuccessor returns successor string', () => {
  assert.equal(getSuccessor({ successor: 'new-skill' }), 'new-skill');
});

test('getSuccessor returns null when no successor', () => {
  assert.equal(getSuccessor({ deprecated: true }), null);
});

test('getSuccessor returns null for empty string', () => {
  assert.equal(getSuccessor({ successor: '   ' }), null);
});

test('getSuccessor returns null for non-string', () => {
  assert.equal(getSuccessor({ successor: 42 }), null);
});

// ── warnIfDeprecated ─────────────────────────────────────────────────

test('warnIfDeprecated returns false for non-deprecated', () => {
  assert.equal(warnIfDeprecated('foo', { id: 'foo' }), false);
});

test('warnIfDeprecated returns true for deprecated', () => {
  assert.equal(warnIfDeprecated('foo', { id: 'foo', deprecated: true }), true);
});

test('warnIfDeprecated returns true for deprecated with successor', () => {
  assert.equal(warnIfDeprecated('foo', { id: 'foo', deprecated: true, successor: 'bar' }), true);
});

// ── resolveActiveSkill ───────────────────────────────────────────────

test('resolveActiveSkill returns entry for non-deprecated skill', () => {
  const index = { skills: [{ id: 'foo', when: 'x' }] };
  const result = resolveActiveSkill(index, 'foo');
  assert.equal(result.entry.id, 'foo');
  assert.deepEqual(result.chain, ['foo']);
  assert.deepEqual(result.skipped, []);
});

test('resolveActiveSkill follows successor chain', () => {
  const index = {
    skills: [
      { id: 'old', deprecated: true, successor: 'new' },
      { id: 'new', when: 'x' },
    ],
  };
  const result = resolveActiveSkill(index, 'old');
  assert.equal(result.entry.id, 'new');
  assert.deepEqual(result.chain, ['old', 'new']);
  assert.deepEqual(result.skipped, ['old']);
});

test('resolveActiveSkill follows multi-hop chain', () => {
  const index = {
    skills: [
      { id: 'a', deprecated: true, successor: 'b' },
      { id: 'b', deprecated: true, successor: 'c' },
      { id: 'c', when: 'x' },
    ],
  };
  const result = resolveActiveSkill(index, 'a');
  assert.equal(result.entry.id, 'c');
  assert.deepEqual(result.chain, ['a', 'b', 'c']);
  assert.deepEqual(result.skipped, ['a', 'b']);
});

test('resolveActiveSkill handles cycle safely', () => {
  const index = {
    skills: [
      { id: 'a', deprecated: true, successor: 'b' },
      { id: 'b', deprecated: true, successor: 'a' },
    ],
  };
  const result = resolveActiveSkill(index, 'a');
  // Should not hang — returns original entry
  assert.equal(result.entry.id, 'a');
});

test('resolveActiveSkill handles missing skill', () => {
  const index = { skills: [] };
  const result = resolveActiveSkill(index, 'ghost');
  assert.equal(result.entry, null);
  assert.deepEqual(result.chain, ['ghost']);
});

test('resolveActiveSkill handles deprecated with no successor', () => {
  const index = {
    skills: [{ id: 'dead', deprecated: true }],
  };
  const result = resolveActiveSkill(index, 'dead');
  assert.equal(result.entry.id, 'dead');
  assert.deepEqual(result.skipped, []);
});

// ── findDeprecatedActive ─────────────────────────────────────────────

test('findDeprecatedActive returns only deprecated non-archived', () => {
  const index = {
    skills: [
      { id: 'a', deprecated: true },
      { id: 'b' },
      { id: 'c', deprecated: true, priority: 'archived' },
    ],
  };
  const result = findDeprecatedActive(index);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'a');
});

test('findDeprecatedActive returns empty for clean index', () => {
  const index = { skills: [{ id: 'a' }, { id: 'b' }] };
  assert.equal(findDeprecatedActive(index).length, 0);
});

// ── excludeFromBudget ────────────────────────────────────────────────

test('excludeFromBudget removes deprecated skills', () => {
  const skills = [
    { id: 'a' },
    { id: 'b', deprecated: true },
    { id: 'c' },
  ];
  const result = excludeFromBudget(skills);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map(s => s.id), ['a', 'c']);
});

test('excludeFromBudget handles empty array', () => {
  assert.equal(excludeFromBudget([]).length, 0);
});

test('excludeFromBudget handles non-array', () => {
  assert.equal(excludeFromBudget(null).length, 0);
});

// ── deprecateSkill / undeprecateSkill (file-based) ──────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deprecation-test-'));
const tmpGj = path.join(tmpDir, 'global.json');

function makeTestIndex() {
  return {
    $schema: 'https://meta-skills.dev/schema/v1.json',
    version: '1.0',
    generated: '2026-01-01T00:00:00Z',
    source: 'global',
    skills: [
      { id: 'keep', when: 'x' },
      { id: 'retire', when: 'y' },
    ],
    stale: [],
  };
}

test('deprecateSkill marks skill and sets successor', () => {
  fs.writeFileSync(tmpGj, JSON.stringify(makeTestIndex(), null, 2));
  const ok = deprecateSkill(tmpGj, 'retire', 'keep');
  assert.equal(ok, true);
  const index = JSON.parse(fs.readFileSync(tmpGj, 'utf-8'));
  const skill = index.skills.find(s => s.id === 'retire');
  assert.equal(skill.deprecated, true);
  assert.equal(skill.successor, 'keep');
});

test('deprecateSkill returns false for missing skill', () => {
  fs.writeFileSync(tmpGj, JSON.stringify(makeTestIndex(), null, 2));
  const ok = deprecateSkill(tmpGj, 'ghost');
  assert.equal(ok, false);
});

test('undeprecateSkill removes deprecated fields', () => {
  fs.writeFileSync(tmpGj, JSON.stringify({
    ...makeTestIndex(),
    skills: [
      { id: 'keep', when: 'x' },
      { id: 'retire', when: 'y', deprecated: true, successor: 'keep' },
    ],
  }, null, 2));
  const ok = undeprecateSkill(tmpGj, 'retire');
  assert.equal(ok, true);
  const index = JSON.parse(fs.readFileSync(tmpGj, 'utf-8'));
  const skill = index.skills.find(s => s.id === 'retire');
  assert.equal(skill.deprecated, undefined);
  assert.equal(skill.successor, undefined);
});

// ── Summary ──────────────────────────────────────────────────────────

console.log(`\nResults: ${passed} passed, ${failed} failed`);

// Cleanup
try { fs.rmSync(tmpDir, { recursive: true }); } catch {}

process.exit(failed > 0 ? 1 : 0);
