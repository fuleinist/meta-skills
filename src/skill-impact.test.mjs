#!/usr/bin/env node

/**
 * Tests for skill-impact.mjs (issue #34)
 *
 * Covers path derivation, append/read roundtrip, ts auto-fill, corrupt-line
 * tolerance, missing-file behaviour, and directory auto-creation.
 * Temp dirs only — nothing touches ~/.meta-skills.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  impactLogPath,
  impactKey,
  appendImpact,
  readImpact,
  rejectedKeysFromLog,
} from './skill-impact.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'meta-skills-impact-'));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

let passed = 0;
function check(label, condition) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label}`); throw new Error(`failed: ${label}`); }
}

try {
  // ── Path derivation ──────────────────────────────────────────
  console.log('impactLogPath:');
  {
    const dir = tmpDir();
    try {
      const storeDir = path.join(dir, 'proposals');
      check('directory store → <dir>/skill-impact.jsonl',
        impactLogPath(storeDir) === path.join(storeDir, 'skill-impact.jsonl'));

      const storeFile = path.join(storeDir, 'proposals.jsonl');
      check('file store → parent dir + skill-impact.jsonl',
        impactLogPath(storeFile) === path.join(storeDir, 'skill-impact.jsonl'));

      // Existing file on disk is resolved through dirname, not extension.
      fs.mkdirSync(storeDir, { recursive: true });
      fs.writeFileSync(storeFile, '', 'utf-8');
      check('existing file store resolves to its directory',
        impactLogPath(storeFile) === path.join(storeDir, 'skill-impact.jsonl'));

      check('key shape for merge is type|a+b', impactKey('merge', ['a', 'b']) === 'merge|a+b');
      check('key shape for single skill is type|id', impactKey('rewrite', 'x') === 'rewrite|x');
    } finally {
      cleanup(dir);
    }
  }

  // ── Append / read roundtrip ──────────────────────────────────
  console.log('\nappendImpact / readImpact:');
  {
    const dir = tmpDir();
    try {
      const logPath = impactLogPath(dir);
      check('missing file reads as empty trail', readImpact(logPath).length === 0);

      const stored = appendImpact(
        { proposalId: 'p-1', type: 'rewrite', skills: ['x'], outcome: 'accepted' },
        logPath,
      );
      check('append returns the stored entry', stored && stored.proposalId === 'p-1');
      check('ts auto-added when missing', typeof stored.ts === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(stored.ts));
      check('dir auto-created for the log', fs.existsSync(path.dirname(logPath)));
      check('log file exists after append', fs.existsSync(logPath));

      const roundtrip = readImpact(logPath);
      check('roundtrip reads one entry', roundtrip.length === 1);
      check('roundtrip preserves fields',
        roundtrip[0].outcome === 'accepted' && roundtrip[0].skills.join(',') === 'x');

      const explicit = appendImpact(
        { ts: '2024-01-01T00:00:00.000Z', proposalId: 'p-2', type: 'merge', skills: ['a', 'b'],
          outcome: 'rejected', reason: 'too broad' },
        logPath,
      );
      check('explicit ts is preserved', explicit.ts === '2024-01-01T00:00:00.000Z');

      // Corrupt line must be skipped, not fatal.
      fs.appendFileSync(logPath, 'not-json\n', 'utf-8');
      const afterCorrupt = readImpact(logPath);
      check('corrupt line skipped', afterCorrupt.length === 2);
      check('corrupt line does not corrupt neighbours', afterCorrupt[1].proposalId === 'p-2');

      const keys = rejectedKeysFromLog(logPath);
      check('rejected keys from log', keys.has('merge|a+b') && keys.size === 1);
    } finally {
      cleanup(dir);
    }
  }

  console.log(`\n${passed} passed`);
  console.log('═══ All skill-impact tests passed ═══');
} catch (e) {
  console.error('\n✗ Test failed:', e.message);
  console.error(e.stack);
  process.exit(1);
}
