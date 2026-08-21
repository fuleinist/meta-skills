#!/usr/bin/env node

/**
 * Tests for skill-watcher.mjs (v0.1.6 — Live Skill Hot-Reloading)
 *
 * Covers: debounce, extractSkillMeta, createSkillWatcher (start/stop/reload)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-watcher-test-'));
const skillDir = path.join(tmpDir, 'test-skill');
fs.mkdirSync(skillDir, { recursive: true });
const skillMdPath = path.join(skillDir, 'SKILL.md');

// Write a minimal SKILL.md
fs.writeFileSync(skillMdPath, `---
name: test-skill
description: a test skill for watcher
version: 1.0.0
---

# Test Skill

Some instructions here.
`);

const {
  debounce,
  extractSkillMeta,
  createSkillWatcher,
} = await import('./skill-watcher.mjs');

const { parseFrontmatter } = await import('./global-scanner.mjs');

// ── debounce ─────────────────────────────────────────────────────────

test('debounce: rapid calls collapse into one', async () => {
  let count = 0;
  const fn = debounce(() => { count++; }, 50);
  fn(); fn(); fn();
  assert.equal(count, 0, 'not called immediately');
  await new Promise(r => setTimeout(r, 80));
  assert.equal(count, 1, 'called once after quiet window');
});

test('debounce: separate bursts each fire', async () => {
  let count = 0;
  const fn = debounce(() => { count++; }, 30);
  fn();
  await new Promise(r => setTimeout(r, 50));
  assert.equal(count, 1);
  fn();
  await new Promise(r => setTimeout(r, 50));
  assert.equal(count, 2);
});

// ── extractSkillMeta ─────────────────────────────────────────────────

test('extractSkillMeta: reads frontmatter fields from SKILL.md', () => {
  const meta = extractSkillMeta(skillMdPath);
  assert.ok(meta);
  assert.equal(meta.id, 'test-skill');
  assert.equal(meta.version, '1.0.0');
  assert.equal(meta.path, skillMdPath);
  assert.ok(meta.when.length > 0);
});

test('extractSkillMeta: returns null for missing file', () => {
  const meta = extractSkillMeta(path.join(tmpDir, 'nonexistent', 'SKILL.md'));
  assert.equal(meta, null);
});

test('extractSkillMeta: falls back to directory name for id', () => {
  // Write a SKILL.md without name field
  const noNameDir = path.join(tmpDir, 'fallback-id-skill');
  fs.mkdirSync(noNameDir, { recursive: true });
  fs.writeFileSync(path.join(noNameDir, 'SKILL.md'), '---\ndescription: no name\n---\n\nBody.\n');
  const meta = extractSkillMeta(path.join(noNameDir, 'SKILL.md'));
  assert.equal(meta.id, 'fallback-id-skill');
});

// ── createSkillWatcher ───────────────────────────────────────────────

test('createSkillWatcher: starts and reports watched count', async () => {
  const index = {
    skills: [{ id: 'test-skill', path: skillMdPath, priority: 'medium', usage_count: 3 }],
  };
  const watcher = createSkillWatcher(index);
  // start() returns a promise that resolves on stop(); don't await it directly
  const startPromise = watcher.start();
  assert.equal(watcher.getWatchedCount(), 1);
  watcher.stop();
  await startPromise;
});

test('createSkillWatcher: skips missing files', async () => {
  const index = {
    skills: [{ id: 'missing', path: path.join(tmpDir, 'nope', 'SKILL.md') }],
  };
  const watcher = createSkillWatcher(index);
  const startPromise = watcher.start();
  assert.equal(watcher.getWatchedCount(), 0);
  watcher.stop();
  await startPromise;
});

test('createSkillWatcher: reloads index on file change', async () => {
  const index = {
    skills: [{
      id: 'test-skill',
      path: skillMdPath,
      priority: 'medium',
      usage_count: 5,
      last_used: '2026-01-01T00:00:00Z',
    }],
  };

  let reloadedId = null;
  let reloadedMeta = null;
  const watcher = createSkillWatcher(index, {
    onReload(id, meta) { reloadedId = id; reloadedMeta = meta; },
    debounceMs: 30,
  });

  const startPromise = watcher.start();

  // Mutate the SKILL.md
  await new Promise(r => setTimeout(r, 50));
  fs.writeFileSync(skillMdPath, `---
name: test-skill
description: updated description
version: 2.0.0
---

# Updated Skill

New instructions.
`);

  // Wait for debounce + reload
  await new Promise(r => setTimeout(r, 150));

  assert.equal(reloadedId, 'test-skill');
  assert.ok(reloadedMeta);
  assert.equal(reloadedMeta.version, '2.0.0');
  assert.equal(reloadedMeta.when, 'updated description');
  // Runtime fields preserved
  assert.equal(reloadedMeta.priority, 'medium');
  assert.equal(reloadedMeta.usage_count, 5);
  assert.equal(reloadedMeta.last_used, '2026-01-01T00:00:00Z');

  watcher.stop();
  await startPromise;
});

test('createSkillWatcher: empty index watches nothing', async () => {
  const index = { skills: [] };
  const watcher = createSkillWatcher(index);
  const startPromise = watcher.start();
  assert.equal(watcher.getWatchedCount(), 0);
  watcher.stop();
  await startPromise;
});

test('createSkillWatcher: no skills key watches nothing', async () => {
  const index = {};
  const watcher = createSkillWatcher(index);
  const startPromise = watcher.start();
  assert.equal(watcher.getWatchedCount(), 0);
  watcher.stop();
  await startPromise;
});

// ── Cleanup ──────────────────────────────────────────────────────────

test('cleanup: remove tmp dir', () => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.ok(!fs.existsSync(tmpDir));
});
