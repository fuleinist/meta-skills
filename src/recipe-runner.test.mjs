#!/usr/bin/env node
/**
 * meta-skills v1.8 — Recipe Runner tests
 *
 * 18 unit tests covering YAML + JSON parsing, validation against index,
 * execution (dry-run + write + halt behavior), and init scaffold.
 *
 * Uses Node's built-in test runner.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  detectFormat,
  parseYamlRecipe,
  parseJsonRecipe,
  parseRecipe,
  readRecipe,
  validateRecipe,
  runRecipe,
  buildRecipeEvent,
  initRecipe,
  RecipeParseError,
  RecipeValidationError,
  FAILURE_BEHAVIORS,
  RECIPE_SOURCE,
  VALID_RECIPE_EXTENSIONS,
} from './recipe-runner.mjs';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeIndex() {
  return {
    version: '1.0',
    generated: '2026-07-01T00:00:00+10:00',
    source: 'global',
    skills: [
      { id: 'validate', when: 'validating code', why: 'linter, type-check', path: '/a', priority: 'high' },
      { id: 'changelog', when: 'generating changelogs', why: 'conventional commits', path: '/b', priority: 'medium' },
      { id: 'commit', when: 'committing changes', why: 'git workflow', path: '/c', priority: 'high' },
      { id: 'tag', when: 'tagging releases', why: 'git tags', path: '/d', priority: 'medium' },
    ],
  };
}

const YAML_RELEASE = `# name: release-flow
# description: cut a release from validated code

step validate: run tests, lint, type-check
step changelog: generate changelog
step commit: commit with conventional message
step tag: tag the release
`;

const YAML_EMPTY = `# name: nothing
# description: empty
`;

const JSON_RELEASE = JSON.stringify({
  name: 'release-flow',
  description: 'cut a release from validated code',
  steps: [
    { skill: 'validate', description: 'run tests', on_failure: 'stop' },
    { skill: 'changelog', on_failure: 'continue' },
    { skill: 'commit', on_failure: 'stop' },
  ],
});

// ===========================================================================
// Format detection
// ===========================================================================

test('detectFormat: .recipe returns recipe', () => {
  assert.equal(detectFormat('/tmp/foo.recipe'), 'recipe');
});

test('detectFormat: .json returns json', () => {
  assert.equal(detectFormat('/tmp/foo.json'), 'json');
});

test('detectFormat: unknown extension defaults to recipe', () => {
  assert.equal(detectFormat('/tmp/foo.txt'), 'recipe');
});

test('VALID_RECIPE_EXTENSIONS: contains both formats', () => {
  assert.ok(VALID_RECIPE_EXTENSIONS.has('.recipe'));
  assert.ok(VALID_RECIPE_EXTENSIONS.has('.json'));
});

// ===========================================================================
// YAML parsing
// ===========================================================================

test('parseYamlRecipe: extracts name, description, and steps', () => {
  const r = parseYamlRecipe(YAML_RELEASE);
  assert.equal(r.name, 'release-flow');
  assert.equal(r.description, 'cut a release from validated code');
  assert.equal(r.format, 'recipe');
  assert.equal(r.steps.length, 4);
  assert.equal(r.steps[0].skill, 'validate');
  assert.match(r.steps[0].description, /run tests/);
  // YAML recipes default to 'continue' (no failure injection in v1.8).
  assert.equal(r.steps[0].on_failure, 'continue');
  assert.equal(r.steps[3].skill, 'tag');
});

test('parseYamlRecipe: handles steps without description', () => {
  const text = '# name: simple\nstep validate\nstep commit\n';
  const r = parseYamlRecipe(text);
  assert.equal(r.steps.length, 2);
  assert.equal(r.steps[0].skill, 'validate');
  assert.equal(r.steps[0].description, '');
});

test('parseYamlRecipe: empty steps throws RecipeParseError', () => {
  assert.throws(() => parseYamlRecipe(YAML_EMPTY), RecipeParseError);
});

test('parseYamlRecipe: unknown line throws RecipeParseError', () => {
  assert.throws(
    () => parseYamlRecipe('not a step\nstep validate: ok'),
    RecipeParseError
  );
});

test('parseYamlRecipe: empty text throws RecipeParseError', () => {
  assert.throws(() => parseYamlRecipe(''), RecipeParseError);
  assert.throws(() => parseYamlRecipe(null), RecipeParseError);
});

test('parseYamlRecipe: ignores non-name/description comment keys', () => {
  const text = '# name: foo\n# tag: skip-me\nstep validate: x\n';
  const r = parseYamlRecipe(text);
  assert.equal(r.name, 'foo');
  assert.equal(r.steps.length, 1);
});

// ===========================================================================
// JSON parsing
// ===========================================================================

test('parseJsonRecipe: parses object with steps array', () => {
  const r = parseJsonRecipe(JSON_RELEASE);
  assert.equal(r.name, 'release-flow');
  assert.equal(r.format, 'json');
  assert.equal(r.steps.length, 3);
  assert.equal(r.steps[1].on_failure, 'continue');
});

test('parseJsonRecipe: invalid JSON throws RecipeParseError', () => {
  assert.throws(() => parseJsonRecipe('{not json'), RecipeParseError);
});

test('parseJsonRecipe: missing steps throws RecipeParseError', () => {
  assert.throws(() => parseJsonRecipe('{"name":"x"}'), RecipeParseError);
  assert.throws(() => parseJsonRecipe('{"name":"x","steps":[]}'), RecipeParseError);
});

test('parseJsonRecipe: invalid on_failure throws RecipeParseError', () => {
  const bad = JSON.stringify({ steps: [{ skill: 'a', on_failure: 'maybe' }] });
  assert.throws(() => parseJsonRecipe(bad), RecipeParseError);
});

test('parseRecipe: dispatches based on format hint', () => {
  const r = parseRecipe(JSON_RELEASE, 'json');
  assert.equal(r.format, 'json');
  const r2 = parseRecipe(YAML_RELEASE, 'recipe');
  assert.equal(r2.format, 'recipe');
});

// ===========================================================================
// readRecipe (file I/O)
// ===========================================================================

test('readRecipe: reads and parses a .recipe file', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-read-'));
  const file = path.join(tmpDir, 'release.recipe');
  fs.writeFileSync(file, YAML_RELEASE);
  const r = readRecipe(file);
  assert.equal(r.name, 'release-flow');
  assert.equal(r.steps.length, 4);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('readRecipe: reads and parses a .json file', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-read-json-'));
  const file = path.join(tmpDir, 'release.json');
  fs.writeFileSync(file, JSON_RELEASE);
  const r = readRecipe(file);
  assert.equal(r.steps.length, 3);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('readRecipe: missing file throws RecipeParseError', () => {
  assert.throws(() => readRecipe('/nonexistent/foo.recipe'), RecipeParseError);
});

// ===========================================================================
// Validation
// ===========================================================================

test('validateRecipe: passes when all skills exist', () => {
  const r = parseYamlRecipe(YAML_RELEASE);
  const result = validateRecipe(r, makeIndex());
  assert.equal(result.valid, true);
  assert.deepEqual(result.warnings, []);
});

test('validateRecipe: throws on unknown skill id', () => {
  const r = parseYamlRecipe('# name: x\nstep nonexistent: y\n');
  assert.throws(() => validateRecipe(r, makeIndex()), RecipeValidationError);
});

test('validateRecipe: collects multiple errors in RecipeValidationError.errors', () => {
  const r = parseYamlRecipe('# name: x\nstep nope1: a\nstep nope2: b\n');
  try {
    validateRecipe(r, makeIndex());
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(Array.isArray(err.errors));
    assert.equal(err.errors.length, 2);
    assert.match(err.errors[0], /nope1/);
    assert.match(err.errors[1], /nope2/);
  }
});

test('validateRecipe: empty steps throws', () => {
  assert.throws(() => validateRecipe({ steps: [] }, makeIndex()), RecipeValidationError);
});

test('FAILURE_BEHAVIORS: contains stop and continue', () => {
  assert.ok(FAILURE_BEHAVIORS.has('stop'));
  assert.ok(FAILURE_BEHAVIORS.has('continue'));
  assert.equal(FAILURE_BEHAVIORS.size, 2);
});

// ===========================================================================
// Execution
// ===========================================================================

test('buildRecipeEvent: emits event with recipe metadata', () => {
  const r = parseYamlRecipe(YAML_RELEASE);
  const evt = buildRecipeEvent(r, 0, { now: new Date('2026-07-15T10:00:00Z') });
  assert.equal(evt.skill, 'validate');
  assert.equal(evt.source, RECIPE_SOURCE);
  assert.equal(evt.recipe, 'release-flow');
  assert.equal(evt.step, 1);
  assert.equal(evt.timestamp, '2026-07-15T10:00:00.000Z');
  assert.equal(evt.outcome, 'success');
});

test('runRecipe: dry-run does not write log files', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-dryrun-'));
  const r = parseYamlRecipe(YAML_RELEASE);
  const result = await runRecipe(r, makeIndex(), { logDir: tmpDir, dryRun: true });
  assert.equal(result.executed, 4);
  assert.equal(result.dryRun, true);
  assert.deepEqual(fs.readdirSync(tmpDir), []);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('runRecipe: write mode appends one event per step to today log', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-write-'));
  const r = parseYamlRecipe(YAML_RELEASE);
  const result = await runRecipe(r, makeIndex(), { logDir: tmpDir, dryRun: false });
  assert.equal(result.executed, 4);
  const files = fs.readdirSync(tmpDir);
  assert.equal(files.length, 1);
  const content = fs.readFileSync(path.join(tmpDir, files[0]), 'utf8');
  const lines = content.trim().split('\n');
  assert.equal(lines.length, 4);
  const first = JSON.parse(lines[0]);
  assert.equal(first.skill, 'validate');
  assert.equal(first.source, RECIPE_SOURCE);
  assert.equal(first.step, 1);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('runRecipe: throws on invalid recipe (unknown skill)', async () => {
  const r = parseYamlRecipe('# name: bad\nstep nope: x\n');
  await assert.rejects(() => runRecipe(r, makeIndex(), { dryRun: true }), RecipeValidationError);
});

test('runRecipe: stopOnFailure=false (continue-on-failure) runs all steps', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-continue-'));
  // JSON recipe where every step has on_failure: continue
  const recipe = parseJsonRecipe(JSON.stringify({
    name: 'all-continue',
    steps: [
      { skill: 'validate', on_failure: 'continue' },
      { skill: 'changelog', on_failure: 'continue' },
      { skill: 'commit', on_failure: 'continue' },
    ],
  }));
  const result = await runRecipe(recipe, makeIndex(), { logDir: tmpDir, dryRun: true, stopOnFailure: false });
  assert.equal(result.executed, 3);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ===========================================================================
// Init scaffold
// ===========================================================================

test('initRecipe: writes a starter .recipe file', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-init-'));
  const out = initRecipe('release-flow', { outPath: path.join(tmpDir, 'release-flow.recipe') });
  assert.equal(out, path.join(tmpDir, 'release-flow.recipe'));
  const content = fs.readFileSync(out, 'utf8');
  assert.match(content, /# name: release-flow/);
  assert.match(content, /step validate:/);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('initRecipe: sanitizes name to slug', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-init-slug-'));
  const out = initRecipe('My Cool Workflow!', { outPath: path.join(tmpDir, 'x.recipe') });
  const content = fs.readFileSync(out, 'utf8');
  assert.match(content, /# name: my-cool-workflow/);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('initRecipe: throws on empty slug', () => {
  assert.throws(() => initRecipe('!!!'), RecipeParseError);
});

// ===========================================================================
// Smoke: full round-trip
// ===========================================================================

test('smoke: readRecipe → validateRecipe → runRecipe round-trip', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-smoke-'));
  const file = path.join(tmpDir, 'release.recipe');
  fs.writeFileSync(file, YAML_RELEASE);

  const r = readRecipe(file);
  const v = validateRecipe(r, makeIndex());
  assert.equal(v.valid, true);
  const result = await runRecipe(r, makeIndex(), { logDir: tmpDir, dryRun: true });
  assert.equal(result.executed, 4);
  assert.equal(result.results[0].skill, 'validate');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});