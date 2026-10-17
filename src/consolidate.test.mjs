#!/usr/bin/env node

/**
 * Tests for consolidate.mjs (issue #38)
 *
 * Temp dirs only — nothing is written outside os.tmpdir().
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  slugifyPatternName,
  renderPattern,
  upsertPattern,
  updateIndex,
  appendLog,
  consolidate,
  loadEvidence,
  defaultWikiDir,
} from './consolidate.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-skills-cons-'));

let passed = 0;
let failed = 0;

function check(label, condition) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label}`); failed++; }
}

function cleanup() {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function tmpName(name) {
  return path.join(tmpDir, name);
}

// ── Tests ────────────────────────────────────────────────────────────────

try {
  console.log('slugifyPatternName:');
  check('slug lowercases and strips .md', slugifyPatternName('Failure Auth Token Timeout.md') === 'failure-auth-token-timeout');

  console.log('\nrenderPattern:');
  const page = renderPattern({
    name: 'failure-auth-token',
    description: 'Recurring failure pattern for auth',
    rootCause: '≥2 recorded failures share signature: token, timeout',
    evidence: ['- 2026-01-01T00:00:00Z auth — token timeout'],
    fix: 'Review guidance for auth: add anti-pattern notes.',
    lastUpdated: '2026-01-05T00:00:00.000Z',
  });
  check('title + all enforced sections present',
    page.startsWith('# failure-auth-token') &&
    ['## Description', '## Root Cause', '## Evidence', '## Fix', '## Last Updated'].every(s => page.includes(s)));
  check('Last Updated is the ISO date', page.includes('2026-01-05T00:00:00.000Z'));

  console.log('\ndry-run (default) writes nothing:');
  const dryDir = tmpName('wiki-dry');
  const dryEvidence = [
    { skill: 'auth', outcome: 'failure', timestamp: '2026-01-01T00:00:00Z', excerpt: 'token timeout refresh loop' },
    { skill: 'auth', outcome: 'failure', timestamp: '2026-01-02T00:00:00Z', excerpt: 'token timeout refresh loop', traceId: 'tr-1' },
    { skill: 'auth', outcome: 'failure', timestamp: '2026-01-03T00:00:00Z', excerpt: 'single item below threshold unique word' },
  ];
  const dry = consolidate(dryDir, dryEvidence);
  check('dry-run flag defaults to true', dry.dryRun === true);
  check('dry-run reports one created pattern', dry.created.length === 1);
  check('dry-run skipped the below-threshold group', dry.skippedBelowThreshold === 1);
  check('dry-run created no files', !fs.existsSync(dryDir));

  console.log('\nwrite path (--write):');
  const writeDir = tmpName('wiki-write');
  const evidence = [
    { skill: 'auth', outcome: 'failure', timestamp: '2026-01-01T00:00:00Z', excerpt: 'token timeout refresh loop' },
    { skill: 'auth', outcome: 'failure', timestamp: '2026-01-02T00:00:00Z', excerpt: 'token timeout refresh loop', traceId: 'tr-2' },
    { skill: 'search', outcome: 'success', timestamp: '2026-01-03T00:00:00Z', excerpt: 'grep ripgrep pattern fast index' },
    { skill: 'search', outcome: 'success', timestamp: '2026-01-04T00:00:00Z', excerpt: 'grep ripgrep pattern fast index' },
    { skill: 'lonely', outcome: 'failure', timestamp: '2026-01-05T00:00:00Z', excerpt: 'one off unique singleton item' },
  ];
  const applied = consolidate(writeDir, evidence, { write: true });
  check('write path is not dry-run', applied.dryRun === false);
  check('write path created 2 patterns', applied.created.length === 2);
  check('failure + success patterns named <kind>-<skill>-<signature>',
    applied.created.some(n => n.startsWith('failure-auth-')) && applied.created.some(n => n.startsWith('success-search-')));
  check('below-threshold group skipped', applied.skippedBelowThreshold === 1);
  check('index.md written', fs.existsSync(path.join(writeDir, 'index.md')));
  check('logs.md written', fs.existsSync(path.join(writeDir, 'logs.md')));

  const failureFile = path.join(writeDir, 'patterns', `${applied.created.find(n => n.startsWith('failure-'))}.md`);
  const failurePage = fs.readFileSync(failureFile, 'utf-8');
  check('pattern page has enforced sections',
    ['## Description', '## Root Cause', '## Evidence', '## Fix', '## Last Updated'].every(s => failurePage.includes(s)));
  check('evidence bullet includes trace id', failurePage.includes('[trace tr-2]'));
  check('log has one timestamped entry', (fs.readFileSync(path.join(writeDir, 'logs.md'), 'utf-8').match(/^- /gm) || []).length === 1);

  console.log('\nsecond run updates in place (no duplicate file):');
  sleep(20);
  const rerun = consolidate(writeDir, evidence, { write: true });
  check('second run reports updates, not creations', rerun.created.length === 0 && rerun.updated.length === 2);
  const patternFiles = fs.readdirSync(path.join(writeDir, 'patterns')).filter(f => f.endsWith('.md'));
  check('no duplicate pattern files', patternFiles.length === 2);
  const updatedPage = fs.readFileSync(failureFile, 'utf-8');
  check('evidence bullets grew', (updatedPage.match(/^- /gm) || []).length === 4);
  check('Last Updated changed', updatedPage.includes('## Last Updated') && updatedPage.split('## Last Updated')[1].trim() !== failurePage.split('## Last Updated')[1].trim());
  const indexLines = fs.readFileSync(path.join(writeDir, 'index.md'), 'utf-8').split('\n').filter(l => l.startsWith('- ['));
  const indexNames = indexLines.map(l => l.slice(2, l.indexOf(']')));
  check('index is sorted', indexNames.join('|') === [...indexNames].sort().join('|'));
  check('log gained a second entry', (fs.readFileSync(path.join(writeDir, 'logs.md'), 'utf-8').match(/^- /gm) || []).length === 2);

  console.log('\nupsertPattern (update-don\'t-duplicate):');
  const upDir = tmpName('wiki-upsert');
  const first = upsertPattern(upDir, { name: 'Failure Auth Token', description: 'd', rootCause: 'r', evidence: ['- old bullet'], fix: 'f' });
  const second = upsertPattern(upDir, { name: 'failure-auth-token.md', description: 'd', rootCause: 'r', evidence: ['- new bullet'], fix: 'f' });
  check('first call creates, second call updates the same file', first.created === true && second.created === false && second.file === first.file);
  const upPage = fs.readFileSync(first.file, 'utf-8');
  check('new bullets land right after the Evidence header',
    upPage.indexOf('## Evidence') < upPage.indexOf('- new bullet') && upPage.indexOf('- new bullet') < upPage.indexOf('- old bullet'));
  check('only one pattern file exists', fs.readdirSync(path.join(upDir, 'patterns')).length === 1);

  console.log('\nloadEvidence:');
  const jsonlPath = tmpName('evidence.jsonl');
  fs.writeFileSync(jsonlPath, [
    '{"skill":"auth","outcome":"failure","timestamp":"2026-01-01T00:00:00Z","excerpt":"token timeout"}',
    'this line is corrupt and must be skipped',
    '{"skill":"auth","outcome":"failure","timestamp":"2026-01-02T00:00:00Z","excerpt":"token timeout"}',
    '',
  ].join('\n'), 'utf-8');
  const loaded = loadEvidence(jsonlPath);
  check('corrupt lines skipped', loaded.length === 2);

  const inputDir = tmpName('input-dir');
  fs.mkdirSync(inputDir, { recursive: true });
  fs.writeFileSync(path.join(inputDir, 'a.jsonl'), '{"skill":"auth","outcome":"failure","excerpt":"token timeout"}\n', 'utf-8');
  fs.writeFileSync(path.join(inputDir, 'b.jsonl'), '{"skill":"auth","outcome":"failure","excerpt":"token timeout"}\nnot json\n', 'utf-8');
  fs.writeFileSync(path.join(inputDir, 'ignored.txt'), 'not jsonl\n', 'utf-8');
  const fromDir = loadEvidence(inputDir);
  check('directory loader reads *.jsonl only', fromDir.length === 2);

  console.log('\natomic writes:');
  const leftovers = [];
  for (const dir of [writeDir, inputDir]) {
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.tmp')) leftovers.push(f);
  }
  check('no .tmp leftovers', leftovers.length === 0);
  check('defaultWikiDir is ~/.meta-skills/wiki', defaultWikiDir().endsWith(path.join('.meta-skills', 'wiki')));

  cleanup();
} catch (e) {
  console.error('Test error:', e);
  cleanup();
  process.exit(1);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
