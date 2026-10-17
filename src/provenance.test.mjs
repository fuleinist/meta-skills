#!/usr/bin/env node

/**
 * Tests for provenance.mjs (issue #40)
 * Temp dirs only — nothing outside os.tmpdir() is touched.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  PURPOSE_FILENAME,
  renderPurpose,
  writePurpose,
  ensurePurpose,
  appendHistory,
  readPurpose,
  hasPurpose,
  skillsMissingProvenance,
} from './provenance.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-skills-prov-'));

let passed = 0;
let failed = 0;

function check(label, condition) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label}`); failed++; }
}

function cleanup() {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function throws(fn) {
  try { fn(); return false; } catch { return true; }
}

// ── Tests ─────────────────────────────────────────────────────────────

try {
  console.log('renderPurpose:');
  const md = renderPurpose({
    name: 'git-commits',
    description: 'Writes commit messages in house style.',
    origin: 'Derived from the wiki pattern "commit as narrative".',
    evidence: ['3 reviews flagged vague messages', 'usage_count=42'],
    history: [{ date: '2026-01-02', version: '0.2.0', summary: 'tightened trigger' }],
  });
  check('title section rendered', md.includes('# PURPOSE: git-commits'));
  check('description section rendered', md.includes('## What this skill is') && md.includes('house style'));
  check('origin section rendered', md.includes('## Origin') && md.includes('commit as narrative'));
  check('evidence bullets rendered', md.includes('## Evidence') && md.includes('- 3 reviews flagged vague messages'));
  check('history section rendered', md.includes('## Evolution History'));
  check('history entry rendered', md.includes('- 2026-01-02 0.2.0 — tightened trigger'));

  const empty = renderPurpose({ name: 'bare' });
  check('empty history allowed', empty.includes('## Evolution History') && !/- \d{4}-/.test(empty));

  console.log('\nwrite → read roundtrip:');
  const dirA = path.join(tmpDir, 'skill-a');
  const written = writePurpose(dirA, {
    name: 'skill-a',
    description: 'Alpha skill',
    origin: 'Created by evolution approval p-1',
    evidence: ['baseline score 41'],
    history: [],
  });
  check('write returns path', written === path.join(dirA, PURPOSE_FILENAME));
  check('file exists', hasPurpose(dirA));
  check('read roundtrip matches render', readPurpose(dirA) === renderPurpose({
    name: 'skill-a',
    description: 'Alpha skill',
    origin: 'Created by evolution approval p-1',
    evidence: ['baseline score 41'],
    history: [],
  }));

  console.log('\ncreate guard:');
  check('refuses overwrite without flag', throws(() => writePurpose(dirA, { name: 'skill-a' })));
  check('original content preserved after refused overwrite', readPurpose(dirA).includes('Alpha skill'));
  check('overwrite allowed with opts.overwrite', !throws(() => writePurpose(dirA, { name: 'skill-a', description: 'replaced' }, { overwrite: true })));
  check('ensurePurpose does not clobber', readPurpose(dirA).includes('replaced') && !throws(() => ensurePurpose(dirA, { name: 'skill-a' })));

  console.log('\nappendHistory (append-only, newest first):');
  // restore a clean file for ordering checks
  writePurpose(dirA, { name: 'skill-a', description: 'Alpha skill', origin: 'seed', history: [] }, { overwrite: true });
  appendHistory(dirA, { date: '2026-02-01', version: '0.1.0', summary: 'first entry' });
  appendHistory(dirA, { date: '2026-03-01', summary: 'second entry (no version)' });
  const after = readPurpose(dirA);
  const histBlock = after.slice(after.indexOf('## Evolution History'));
  check('newest entry is first', histBlock.indexOf('- 2026-03-01 — second entry') < histBlock.indexOf('- 2026-02-01 0.1.0 — first entry'));
  check('older entry preserved (append-only)', histBlock.includes('- 2026-02-01 0.1.0 — first entry'));
  check('entry inserted directly after header', histBlock.split('\n')[1] === '- 2026-03-01 — second entry (no version)');
  check('header text preserved', after.includes('# PURPOSE: skill-a') && after.includes('## Origin'));

  console.log('\nerror cases:');
  const dirB = path.join(tmpDir, 'skill-b');
  fs.mkdirSync(dirB, { recursive: true });
  check('hasPurpose false when missing', hasPurpose(dirB) === false);  check('appendHistory throws when PURPOSE.md missing', throws(() => appendHistory(dirB, { summary: 'nope' })));
  check('readPurpose throws when PURPOSE.md missing', throws(() => readPurpose(dirB)));

  console.log('\nskillsMissingProvenance:');
  writePurpose(dirB, { name: 'skill-b', origin: 'seed' });
  const index = {
    skills: [
      { id: 'skill-b', path: path.join(dirB, 'SKILL.md') },
      { id: 'skill-c', path: path.join(tmpDir, 'skill-c', 'SKILL.md') }, // dir exists, no PURPOSE.md
      { id: 'skill-d', path: null },                                      // skipped
      { id: 'skill-e', path: path.join(tmpDir, 'no-such-dir', 'SKILL.md') }, // unresolvable — skipped
    ],
  };
  fs.mkdirSync(path.join(tmpDir, 'skill-c'), { recursive: true });
  const missing = skillsMissingProvenance(index);
  check('flags skill-c only', missing.length === 1 && missing[0] === 'skill-c');
  check('skips entries without path', !missing.includes('skill-d'));
  check('skips unresolvable dirs', !missing.includes('skill-e'));

  console.log('\natomic write hygiene:');
  const leftovers = fs.readdirSync(dirA).filter(f => f.endsWith('.tmp'));
  check('no .tmp leftovers in skill dir', leftovers.length === 0);

  cleanup();
} catch (e) {
  console.error('Test error:', e);
  cleanup();
  process.exit(1);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
