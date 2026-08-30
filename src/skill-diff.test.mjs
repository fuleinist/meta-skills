#!/usr/bin/env node

/**
 * Tests for meta-skills v0.2.2 - Cross-workspace skill diff & migration
 * Zero-dependency; uses node:test-free assert style consistent with repo.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listSkills, diffSkills, migrationPlan, applyMigration, sha256 } from './skill-diff.mjs';

let passed = 0;
const tmpRoots = [];

function tmpdir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-skilldiff-'));
  tmpRoots.push(d);
  return d;
}

function addSkill(dir, name, body, extraFiles = {}) {
  const skillDir = path.join(dir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), body);
  for (const [rel, content] of Object.entries(extraFiles)) {
    const p = path.join(skillDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}

function t(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    throw err;
  }
}

console.log('skill-diff tests');

t('listSkills throws on missing directory', () => {
  assert.throws(() => listSkills(path.join(os.tmpdir(), 'ms-nope-' + Date.now())), /not found/);
});

t('listSkills ignores dirs without SKILL.md', () => {
  const d = tmpdir();
  addSkill(d, 'alpha', '# alpha');
  fs.mkdirSync(path.join(d, 'not-a-skill'));
  fs.writeFileSync(path.join(d, 'not-a-skill', 'README.md'), 'no skill here');
  const skills = listSkills(d);
  assert.deepStrictEqual([...skills.keys()], ['alpha']);
});

t('listSkills ignores loose files', () => {
  const d = tmpdir();
  addSkill(d, 'alpha', '# alpha');
  fs.writeFileSync(path.join(d, 'stray.md'), '# stray');
  const skills = listSkills(d);
  assert.deepStrictEqual([...skills.keys()], ['alpha']);
});

t('identical skill sets report identical only', () => {
  const a = tmpdir();
  const b = tmpdir();
  addSkill(a, 'one', '# one');
  addSkill(b, 'one', '# one');
  const diff = diffSkills(a, b);
  assert.deepStrictEqual(diff.identical, ['one']);
  assert.deepStrictEqual(diff.onlyA, []);
  assert.deepStrictEqual(diff.onlyB, []);
  assert.deepStrictEqual(diff.changed, []);
});

t('detects skills only in A', () => {
  const a = tmpdir();
  const b = tmpdir();
  addSkill(a, 'one', '# one');
  addSkill(a, 'two', '# two');
  addSkill(b, 'one', '# one');
  const diff = diffSkills(a, b);
  assert.deepStrictEqual(diff.onlyA, ['two']);
});

t('detects skills only in B', () => {
  const a = tmpdir();
  const b = tmpdir();
  addSkill(a, 'one', '# one');
  addSkill(b, 'one', '# one');
  addSkill(b, 'extra', '# extra');
  const diff = diffSkills(a, b);
  assert.deepStrictEqual(diff.onlyB, ['extra']);
});

t('detects changed SKILL.md content', () => {
  const a = tmpdir();
  const b = tmpdir();
  addSkill(a, 'one', '# one v2');
  addSkill(b, 'one', '# one v1');
  const diff = diffSkills(a, b);
  assert.deepStrictEqual(diff.changed, ['one']);
  assert.deepStrictEqual(diff.identical, []);
});

t('diff output is sorted and deterministic', () => {
  const a = tmpdir();
  const b = tmpdir();
  for (const name of ['zeta', 'alpha', 'mid']) addSkill(a, name, `# ${name}`);
  const diff = diffSkills(a, b);
  assert.deepStrictEqual(diff.onlyA, ['alpha', 'mid', 'zeta']);
});

t('sha256 is content-sensitive', () => {
  assert.notStrictEqual(sha256('a'), sha256('b'));
  assert.strictEqual(sha256('same'), sha256('same'));
});

t('migrationPlan plans copy for onlyA and update for changed', () => {
  const a = tmpdir();
  const b = tmpdir();
  addSkill(a, 'new-skill', '# new');
  addSkill(a, 'drifted', '# v2');
  addSkill(b, 'drifted', '# v1');
  const diff = diffSkills(a, b);
  const plan = migrationPlan(diff, { from: a, to: b });
  assert.strictEqual(plan.length, 2);
  const bySkill = Object.fromEntries(plan.map(p => [p.skill, p]));
  assert.strictEqual(bySkill['new-skill'].type, 'copy');
  assert.strictEqual(bySkill['drifted'].type, 'update');
});

t('migrationPlan never plans deletions for onlyB skills', () => {
  const a = tmpdir();
  const b = tmpdir();
  addSkill(b, 'orphan', '# only in b');
  const diff = diffSkills(a, b);
  const plan = migrationPlan(diff, { from: a, to: b });
  assert.deepStrictEqual(plan, []);
});

t('applyMigration dry-run writes nothing', () => {
  const a = tmpdir();
  const b = tmpdir();
  addSkill(a, 'new-skill', '# new');
  const diff = diffSkills(a, b);
  const plan = migrationPlan(diff, { from: a, to: b });
  const results = applyMigration(plan); // dryRun default true
  assert.strictEqual(results[0].applied, false);
  assert.strictEqual(fs.existsSync(path.join(b, 'new-skill')), false);
});

t('applyMigration copies SKILL.md and support files', () => {
  const a = tmpdir();
  const b = tmpdir();
  addSkill(a, 'rich', '# rich', { 'scripts/run.sh': 'echo hi', 'references/doc.md': 'doc' });
  const diff = diffSkills(a, b);
  const plan = migrationPlan(diff, { from: a, to: b });
  const results = applyMigration(plan, { dryRun: false });
  assert.strictEqual(results[0].applied, true);
  assert.strictEqual(fs.readFileSync(path.join(b, 'rich', 'SKILL.md'), 'utf8'), '# rich');
  assert.strictEqual(fs.readFileSync(path.join(b, 'rich', 'scripts', 'run.sh'), 'utf8'), 'echo hi');
  assert.strictEqual(fs.readFileSync(path.join(b, 'rich', 'references', 'doc.md'), 'utf8'), 'doc');
});

t('applyMigration overwrites changed SKILL.md; re-diff is clean', () => {
  const a = tmpdir();
  const b = tmpdir();
  addSkill(a, 'drifted', '# v2');
  addSkill(b, 'drifted', '# v1');
  const diff = diffSkills(a, b);
  const plan = migrationPlan(diff, { from: a, to: b });
  applyMigration(plan, { dryRun: false });
  const after = diffSkills(a, b);
  assert.deepStrictEqual(after.identical, ['drifted']);
  assert.deepStrictEqual(after.changed, []);
});

console.log(`\n${passed} tests passed`);

for (const d of tmpRoots) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
}
