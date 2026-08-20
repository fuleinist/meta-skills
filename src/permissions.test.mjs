#!/usr/bin/env node

/**
 * Tests for permissions.mjs (v0.1.5)
 *
 * Covers: validatePermissions, canPerform, listBlockedActions, summarizePermissions
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validatePermissions,
  canPerform,
  listBlockedActions,
  summarizePermissions,
  VALID_PERMISSIONS,
} from './permissions.mjs';

// ── VALID_PERMISSIONS ─────────────────────────────────────────────────

test('VALID_PERMISSIONS contains expected values', () => {
  assert.deepEqual(VALID_PERMISSIONS, [
    'fs-read', 'fs-write', 'network', 'shell-exec', 'env-read', 'process-exec',
  ]);
});

// ── validatePermissions ───────────────────────────────────────────────

test('validatePermissions: null permissions is valid (no-op)', () => {
  const result = validatePermissions({ id: 'test', permissions: null });
  assert.equal(result.valid, true);
  assert.deepEqual(result.invalid, []);
  assert.deepEqual(result.unknown, []);
});

test('validatePermissions: undefined permissions is valid', () => {
  const result = validatePermissions({ id: 'test' });
  assert.equal(result.valid, true);
});

test('validatePermissions: empty array is valid', () => {
  const result = validatePermissions({ id: 'test', permissions: [] });
  assert.equal(result.valid, true);
});

test('validatePermissions: all valid permissions pass', () => {
  const result = validatePermissions({
    id: 'test',
    permissions: ['fs-read', 'network', 'shell-exec'],
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.invalid, []);
  assert.deepEqual(result.unknown, []);
});

test('validatePermissions: unknown permission flagged', () => {
  const result = validatePermissions({
    id: 'test',
    permissions: ['fs-read', 'admin-access'],
  });
  assert.equal(result.valid, false);
  assert.deepEqual(result.unknown, ['admin-access']);
});

test('validatePermissions: wildcard rejected', () => {
  const result = validatePermissions({
    id: 'test',
    permissions: ['*'],
  });
  assert.equal(result.valid, false);
  assert.ok(result.invalid.some(i => i.includes('wildcard')));
});

test('validatePermissions: non-string permission flagged', () => {
  const result = validatePermissions({
    id: 'test',
    permissions: [42],
  });
  assert.equal(result.valid, false);
  assert.ok(result.invalid.some(i => i.includes('string')));
});

test('validatePermissions: non-array permissions flagged', () => {
  const result = validatePermissions({
    id: 'test',
    permissions: 'fs-read',
  });
  assert.equal(result.valid, false);
  assert.ok(result.invalid.some(i => i.includes('array')));
});

test('validatePermissions: duplicate permission flagged', () => {
  const result = validatePermissions({
    id: 'test',
    permissions: ['fs-read', 'fs-read'],
  });
  assert.equal(result.valid, false);
  assert.ok(result.invalid.some(i => i.includes('duplicate')));
});

test('validatePermissions: multiple issues collected', () => {
  const result = validatePermissions({
    id: 'test',
    permissions: ['fs-read', 'bogus', '*', 42, 'fs-read'],
  });
  assert.equal(result.valid, false);
  assert.ok(result.invalid.length >= 3); // wildcard, non-string, duplicate
  assert.deepEqual(result.unknown, ['bogus']);
});

// ── canPerform ────────────────────────────────────────────────────────

test('canPerform: authorized when permission present', () => {
  const result = canPerform(
    { id: 'git-commits', permissions: ['fs-read', 'shell-exec'] },
    'shell-exec'
  );
  assert.equal(result.authorized, true);
});

test('canPerform: blocked when permission absent', () => {
  const result = canPerform(
    { id: 'git-commits', permissions: ['fs-read'] },
    'network'
  );
  assert.equal(result.authorized, false);
  assert.ok(result.reason.includes('lacks permission'));
});

test('canPerform: blocked when no permissions declared', () => {
  const result = canPerform({ id: 'test' }, 'fs-read');
  assert.equal(result.authorized, false);
  assert.ok(result.reason.includes('no permissions'));
});

test('canPerform: blocked when permissions is empty array', () => {
  const result = canPerform({ id: 'test', permissions: [] }, 'fs-read');
  assert.equal(result.authorized, false);
});

test('canPerform: blocked for unknown action', () => {
  const result = canPerform(
    { id: 'test', permissions: ['fs-read'] },
    'reformat-hard-drive'
  );
  assert.equal(result.authorized, false);
  assert.ok(result.reason.includes('unknown action'));
});

test('canPerform: null skill blocked', () => {
  const result = canPerform(null, 'fs-read');
  assert.equal(result.authorized, false);
});

// ── listBlockedActions ────────────────────────────────────────────────

test('listBlockedActions: returns only blocked actions', () => {
  const blocked = listBlockedActions(
    { id: 'deploy', permissions: ['network', 'shell-exec'] },
    ['fs-read', 'network', 'fs-write', 'shell-exec']
  );
  assert.equal(blocked.length, 2);
  assert.deepEqual(blocked.map(b => b.action).sort(), ['fs-read', 'fs-write']);
});

test('listBlockedActions: empty when all allowed', () => {
  const blocked = listBlockedActions(
    { id: 'full', permissions: ['fs-read', 'fs-write', 'network'] },
    ['fs-read', 'network']
  );
  assert.equal(blocked.length, 0);
});

test('listBlockedActions: all blocked when no permissions', () => {
  const blocked = listBlockedActions(
    { id: 'restricted' },
    ['fs-read', 'network']
  );
  assert.equal(blocked.length, 2);
});

// ── summarizePermissions ──────────────────────────────────────────────

test('summarizePermissions: maps skills to summaries', () => {
  const index = {
    skills: [
      { id: 'git-commits', permissions: ['fs-read', 'shell-exec'] },
      { id: 'web-scraper', permissions: ['network'] },
      { id: 'readonly-skill', permissions: null },
    ],
  };
  const summary = summarizePermissions(index);
  assert.equal(summary.length, 3);
  assert.equal(summary[0].id, 'git-commits');
  assert.equal(summary[0].permissions.length, 2);
  assert.equal(summary[0].capabilities.length, 2);
  assert.equal(summary[2].permissions.length, 0);
});

test('summarizePermissions: handles missing skills array', () => {
  const summary = summarizePermissions({});
  assert.deepEqual(summary, []);
});

test('summarizePermissions: handles null index', () => {
  const summary = summarizePermissions(null);
  assert.deepEqual(summary, []);
});
