#!/usr/bin/env node

/**
 * meta-skills v0.2.5 — Validation harness tests (issue #35)
 * Run: node src/validation-harness.test.mjs
 *
 * Temp dirs only — never touches the real ~/.meta-skills.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert';

import {
  defaultValidationDir,
  suitePathFor,
  baselinePathFor,
  loadSuite,
  scoreCase,
  runSuite,
  readBaseline,
  writeBaseline,
  gate,
  evaluateGate,
  checkGateForSkill,
} from './validation-harness.mjs';
import { approveProposal } from './evolution.mjs';

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'validation-harness-test-'));
const validationDir = path.join(tmp, 'validation');
const suitesDir = path.join(validationDir, 'suites');
const baselinesDir = path.join(validationDir, 'baselines');

function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf-8');
}

const GOOD_SKILL = `---
when: deploying applications to production
---
# Deploy App

1. Run preflight checks
2. Execute deploy script
3. Verify health endpoint

Avoid deploying during the freeze window. Do not skip rollback testing.
`;

const WEAK_SKILL = `deploy production notes\n`;

// ── Paths + defaults ───────────────────────────────────────────

test('defaultValidationDir: home-based layout', () => {
  const dir = defaultValidationDir();
  assert.ok(dir.endsWith(path.join('.meta-skills', 'validation')));
  assert.strictEqual(suitePathFor('abc', tmp), path.join(tmp, 'suites', 'abc.json'));
  assert.strictEqual(baselinePathFor('abc', tmp), path.join(tmp, 'baselines', 'abc.json'));
});

// ── loadSuite ──────────────────────────────────────────────────

const VALID_SUITE = {
  skill: 'deploy-app',
  cases: [
    { id: 'c1', prompt: 'Deploy rollback to production', keywords: ['deploy', 'production'], minScore: 50, weight: 1 },
    { id: 'c2', prompt: 'Handle a failed deploy', keywords: ['zebra'], mustNotContain: ['freeze window'], minScore: 30, weight: 3 },
  ],
};
const validSuitePath = path.join(suitesDir, 'deploy-app.json');
writeFile(validSuitePath, JSON.stringify(VALID_SUITE, null, 2) + '\n');

test('loadSuite: valid shape round-trips with defaults applied', () => {
  const suite = loadSuite(validSuitePath);
  assert.strictEqual(suite.skill, 'deploy-app');
  assert.strictEqual(suite.cases.length, 2);
  assert.strictEqual(suite.cases[0].minScore, 50);
  assert.strictEqual(suite.cases[1].weight, 3);
  assert.deepStrictEqual(suite.cases[0].mustNotContain, []);
});

test('loadSuite: malformed JSON → clear error', () => {
  const p = path.join(suitesDir, 'bad-json.json');
  writeFile(p, '{ "skill": "x", "cases": [');
  assert.throws(() => loadSuite(p), /invalid JSON in suite/);
});

test('loadSuite: missing skill / cases → clear errors', () => {
  const p = path.join(suitesDir, 'bad-shape.json');
  writeFile(p, JSON.stringify({ cases: [] }));
  assert.throws(() => loadSuite(p), /"skill" must be a non-empty string/);
  writeFile(p, JSON.stringify({ skill: 'x', cases: 'nope' }));
  assert.throws(() => loadSuite(p), /"cases" must be an array/);
  writeFile(p, JSON.stringify({ skill: 'x', cases: [{ id: 'a', prompt: 'p', keywords: 'not-an-array' }] }));
  assert.throws(() => loadSuite(p), /keywords must be an array of strings/);
  assert.throws(() => loadSuite(path.join(suitesDir, 'missing.json')), /cannot read suite/);
});

// ── scoreCase ──────────────────────────────────────────────────

test('scoreCase: deterministic for identical input', () => {
  const c = VALID_SUITE.cases[0];
  assert.strictEqual(scoreCase(GOOD_SKILL, c), scoreCase(GOOD_SKILL, c));
  assert.strictEqual(scoreCase(GOOD_SKILL, c), 100);
});

test('scoreCase: mustNotContain hit zeroes the case', () => {
  const c = VALID_SUITE.cases[1];
  assert.strictEqual(scoreCase(GOOD_SKILL, c), 0); // "freeze window" present
  assert.strictEqual(scoreCase(GOOD_SKILL.replace('freeze window', 'maintenance window'), c), 40); // same skill, no banned phrase
});

test('scoreCase: null inputs → 0', () => {
  assert.strictEqual(scoreCase(null, VALID_SUITE.cases[0]), 0);
  assert.strictEqual(scoreCase(GOOD_SKILL, null), 0);
});

// ── runSuite ───────────────────────────────────────────────────

test('runSuite: weighted aggregate + per-case pass', () => {
  const result = runSuite(VALID_SUITE, GOOD_SKILL);
  assert.strictEqual(result.skill, 'deploy-app');
  assert.strictEqual(result.aggregate, 25); // (100*1 + 0*3) / 4
  assert.strictEqual(result.total, 2);
  assert.strictEqual(result.passed, 1);
  assert.strictEqual(result.failed, 1);
  assert.strictEqual(result.cases[1].weight, 3);
});

test('runSuite: minScore controls pass', () => {
  const suite = { skill: 's', cases: [{ id: 'x', prompt: 'p', keywords: ['zebra'], minScore: 30 }] };
  const loose = runSuite(suite, GOOD_SKILL);
  const strict = runSuite({ ...suite, cases: [{ ...suite.cases[0], minScore: 60 }] }, GOOD_SKILL);
  assert.strictEqual(loose.cases[0].score, 40);
  assert.strictEqual(loose.passed, 1);
  assert.strictEqual(strict.passed, 0);
});

test('runSuite: empty suite → aggregate 0', () => {
  const result = runSuite({ skill: 'ghost', cases: [] }, GOOD_SKILL);
  assert.strictEqual(result.total, 0);
  assert.strictEqual(result.aggregate, 0);
});

// ── Baselines ──────────────────────────────────────────────────

test('writeBaseline/readBaseline: roundtrip + atomic (no .tmp left)', () => {
  const record = writeBaseline('deploy-app', runSuite(VALID_SUITE, WEAK_SKILL), validationDir);
  assert.strictEqual(record.skill, 'deploy-app');
  const back = readBaseline('deploy-app', validationDir);
  assert.strictEqual(back.aggregate, record.aggregate);
  assert.strictEqual(back.cases.length, 2);
  assert.ok(back.ts);
  const leftovers = fs.readdirSync(baselinesDir).filter(f => f.endsWith('.tmp'));
  assert.deepStrictEqual(leftovers, [], `leftover tmp files: ${leftovers.join(', ')}`);
});

test('readBaseline: missing → null', () => {
  assert.strictEqual(readBaseline('ghost-skill', validationDir), null);
});

// ── Strict gate ────────────────────────────────────────────────

test('gate: strict improvement accepts', () => {
  const g = gate(60, 50);
  assert.strictEqual(g.accept, true);
  assert.ok(/strict improvement/.test(g.reason));
});

test('gate: equal rejects (no neutral accept)', () => {
  const g = gate(50, 50);
  assert.strictEqual(g.accept, false);
  assert.ok(/no improvement/.test(g.reason));
});

test('gate: lower rejects (regression)', () => {
  const g = gate(49, 50);
  assert.strictEqual(g.accept, false);
  assert.ok(/regression/.test(g.reason));
});

test('gate: missing baseline rejects', () => {
  const g = gate(100, null);
  assert.strictEqual(g.accept, false);
  assert.ok(/no baseline/.test(g.reason));
});

// ── evaluateGate end-to-end ────────────────────────────────────

const skillPath = path.join(tmp, 'deploy-app-SKILL.md');
writeFile(skillPath, GOOD_SKILL);

test('evaluateGate: accept when candidate beats baseline', () => {
  writeBaseline('deploy-app', { skill: 'deploy-app', aggregate: 25, cases: [] }, validationDir);
  const equal = evaluateGate(validSuitePath, skillPath, { validationDir });
  assert.strictEqual(equal.result.aggregate, 25);
  assert.strictEqual(equal.baseline.aggregate, 25);
  assert.strictEqual(equal.gate.accept, false); // equal → reject
  writeBaseline('deploy-app', { skill: 'deploy-app', aggregate: 20, cases: [] }, validationDir);
  const improved = evaluateGate(validSuitePath, skillPath, { validationDir });
  assert.strictEqual(improved.gate.accept, true);
});

test('evaluateGate: reject path + force escape hatch', () => {
  writeBaseline('deploy-app', { skill: 'deploy-app', aggregate: 30, cases: [] }, validationDir);
  const out = evaluateGate(validSuitePath, skillPath, { validationDir });
  assert.strictEqual(out.gate.accept, false);
  assert.ok(/regression/.test(out.gate.reason));
  const forced = evaluateGate(validSuitePath, skillPath, { validationDir, force: true });
  assert.ok(/forced/.test(forced.gate.reason));
});

test('checkGateForSkill: silent no-op without suite or baseline', () => {
  assert.strictEqual(checkGateForSkill('no-suite-skill', skillPath, { validationDir }), null);
  writeBaseline('deploy-app', { skill: 'deploy-app', aggregate: 20, cases: [] }, validationDir);
  const hit = checkGateForSkill('deploy-app', skillPath, { validationDir });
  assert.ok(hit && hit.gate.accept, 'gate evaluated when suite + baseline exist');
});

// ── evolution approve integration (refusal path) ───────────────

test('evolution approve: refuses when the strict gate rejects', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-skills-ev-'));
  const gjPath = path.join(dir, 'global.json');
  const pp = path.join(dir, 'proposals.jsonl');
  const md = path.join(dir, 'skill.md');

  writeFile(md, GOOD_SKILL);
  writeFile(gjPath, JSON.stringify({ skills: [{ id: 'deploy-app', when: 'x', path: md }] }, null, 2));
  writeFile(pp, JSON.stringify({ id: 'p-gate', type: 'rewrite', skillIds: ['deploy-app'], status: 'pending' }) + '\n');

  // Candidate (100 on this single-keyword case) equals the baseline → strict reject.
  const suitePath = path.join(suitesDir, 'ev-skill.json');
  writeFile(suitePath, JSON.stringify({
    skill: 'deploy-app',
    cases: [{ id: 'e1', prompt: 'deploy production', keywords: ['deploy', 'production'] }],
  }));
  writeBaseline('deploy-app', { skill: 'deploy-app', aggregate: 100, cases: [] }, validationDir);

  assert.throws(() => approveProposal('p-gate', gjPath, pp, { validationDir }), /validation gate/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── summary ────────────────────────────────────────────────────

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`validation-harness: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
