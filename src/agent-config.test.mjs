#!/usr/bin/env node

/**
 * meta-skills v1.5 — Agent Config tests (Phase 1: detection only)
 *
 * Covers parseForBlock across all supported types, detectConfigs filtering,
 * and defaultConfigSpecs shape. Tests use temp directories + temp files
 * to avoid touching the real workspace.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MARKDOWN_BLOCK_START,
  MARKDOWN_BLOCK_END,
  TEXT_BLOCK_START,
  TEXT_BLOCK_END,
  JSON_BLOCK_KEY,
  blockContent,
  defaultConfigSpecs,
  detectConfigs,
  parseForBlock,
} from './agent-config.mjs';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'meta-skills-agent-config-'));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf-8');
}

// ---- Tests -----------------------------------------------------------------

test('blockContent is a non-empty instruction string', () => {
  const c = blockContent();
  assert.ok(typeof c === 'string' && c.length > 20);
  assert.ok(c.includes('meta-skills'));
});

test('blockContent ignores unknown options and falls back to default', () => {
  const c = blockContent({ notAField: 'x' });
  assert.ok(c.includes('Always read'));
});

test('defaultConfigSpecs returns the canonical 5 entries', () => {
  const dir = makeTempDir();
  try {
    const specs = defaultConfigSpecs(dir);
    assert.equal(specs.length, 5);
    const agents = specs.map(s => s.agent).sort();
    assert.deepEqual(agents, ['claude-code', 'cursor', 'gemini-cli', 'gemini-cli', 'openclaw']);
    const types = new Set(specs.map(s => s.type));
    assert.ok(types.has('markdown'));
    assert.ok(types.has('text'));
    assert.ok(types.has('json'));
  } finally { cleanup(dir); }
});

test('defaultConfigSpecs respects targetDir for project files', () => {
  const dir = makeTempDir();
  try {
    const specs = defaultConfigSpecs(dir);
    const claude = specs.find(s => s.agent === 'claude-code');
    assert.ok(claude.path.endsWith(path.join(dir, 'CLAUDE.md')));
    const cursor = specs.find(s => s.agent === 'cursor');
    assert.ok(cursor.path.endsWith(path.join(dir, '.cursorrules')));
  } finally { cleanup(dir); }
});

test('defaultConfigSpecs flags gemini-cli entries as globalOnly', () => {
  const specs = defaultConfigSpecs('/tmp/whatever');
  const gemini = specs.filter(s => s.agent === 'gemini-cli');
  assert.equal(gemini.length, 2);
  for (const g of gemini) {
    assert.equal(g.globalOnly, true);
    // globalOnly means path is in HOME, not the target dir
    assert.ok(!g.path.includes('/tmp/whatever'));
  }
});

test('detectConfigs returns only existing files', () => {
  const dir = makeTempDir();
  try {
    writeFile(path.join(dir, 'CLAUDE.md'), '# hi');
    writeFile(path.join(dir, '.cursorrules'), 'be concise');
    const specs = defaultConfigSpecs(dir);
    const found = detectConfigs(specs);
    const names = found.map(f => f.spec.name).sort();
    assert.deepEqual(names, ['Claude Code', 'Cursor']);
    for (const f of found) {
      assert.equal(f.exists, true);
    }
  } finally { cleanup(dir); }
});

test('detectConfigs returns empty array when no configs exist', () => {
  const dir = makeTempDir();
  try {
    const specs = defaultConfigSpecs(dir);
    const found = detectConfigs(specs);
    assert.equal(found.length, 0);
  } finally { cleanup(dir); }
});

test('parseForBlock(markdown) — no block present', () => {
  const dir = makeTempDir();
  try {
    const p = path.join(dir, 'CLAUDE.md');
    writeFile(p, '# Project\n\nSome user content.\n');
    const specs = defaultConfigSpecs(dir);
    const spec = specs.find(s => s.agent === 'claude-code');
    const r = parseForBlock(spec);
    assert.equal(r.exists, true);
    assert.equal(r.hasBlock, false);
    assert.equal(r.blockRange, null);
    assert.equal(r.error, null);
    assert.ok(r.content.includes('Some user content'));
  } finally { cleanup(dir); }
});

test('parseForBlock(markdown) — full block detected with correct range', () => {
  const dir = makeTempDir();
  try {
    const p = path.join(dir, 'CLAUDE.md');
    const original = '# Project\n\nUser content.\n\n' +
      `${MARKDOWN_BLOCK_START}\n${blockContent()}\n${MARKDOWN_BLOCK_END}\n` +
      '\nMore user content.\n';
    writeFile(p, original);
    const specs = defaultConfigSpecs(dir);
    const spec = specs.find(s => s.agent === 'claude-code');
    const r = parseForBlock(spec);
    assert.equal(r.hasBlock, true);
    assert.ok(Array.isArray(r.blockRange));
    const [s, e] = r.blockRange;
    assert.ok(s >= 0 && e > s);
    const slice = r.content.slice(s, e);
    assert.ok(slice.includes(MARKDOWN_BLOCK_START));
    assert.ok(slice.includes(MARKDOWN_BLOCK_END));
    assert.ok(slice.includes(blockContent()));
    // Range must cover full line containing start and end markers
    assert.ok(!slice.includes('User content'));
  } finally { cleanup(dir); }
});

test('parseForBlock(markdown) — start without end is flagged as error', () => {
  const dir = makeTempDir();
  try {
    const p = path.join(dir, 'CLAUDE.md');
    writeFile(p, `# Project\n\n${MARKDOWN_BLOCK_START}\n${blockContent()}\n`);
    const specs = defaultConfigSpecs(dir);
    const spec = specs.find(s => s.agent === 'claude-code');
    const r = parseForBlock(spec);
    assert.equal(r.hasBlock, true);
    assert.ok(r.error && r.error.includes('unterminated'));
  } finally { cleanup(dir); }
});

test('parseForBlock(text) — no block present', () => {
  const dir = makeTempDir();
  try {
    const p = path.join(dir, '.cursorrules');
    writeFile(p, 'be concise.\nno fluff.\n');
    const specs = defaultConfigSpecs(dir);
    const spec = specs.find(s => s.agent === 'cursor');
    const r = parseForBlock(spec);
    assert.equal(r.exists, true);
    assert.equal(r.hasBlock, false);
    assert.equal(r.error, null);
  } finally { cleanup(dir); }
});

test('parseForBlock(text) — full block detected', () => {
  const dir = makeTempDir();
  try {
    const p = path.join(dir, '.cursorrules');
    const original = 'be concise.\n' +
      `\n${TEXT_BLOCK_START}\n${blockContent()}\n${TEXT_BLOCK_END}\n` +
      '\nno fluff.\n';
    writeFile(p, original);
    const specs = defaultConfigSpecs(dir);
    const spec = specs.find(s => s.agent === 'cursor');
    const r = parseForBlock(spec);
    assert.equal(r.hasBlock, true);
    assert.ok(Array.isArray(r.blockRange));
    const slice = r.content.slice(r.blockRange[0], r.blockRange[1]);
    assert.ok(slice.includes(TEXT_BLOCK_START));
    assert.ok(slice.includes(TEXT_BLOCK_END));
  } finally { cleanup(dir); }
});

test('parseForBlock(text) — YAML config detected correctly', () => {
  const dir = makeTempDir();
  const p = path.join(os.homedir(), '.config', 'gemini-cli', 'config.yaml');
  writeFile(p, `model: gemini-3-pro\n\n${TEXT_BLOCK_START}\n${blockContent()}\n${TEXT_BLOCK_END}\n`);
  try {
    const specs = defaultConfigSpecs(dir);
    const spec = specs.find(s => s.agent === 'gemini-cli' && s.type === 'text');
    const r = parseForBlock(spec);
    assert.equal(r.exists, true);
    assert.equal(r.hasBlock, true);
  } finally {
    try { fs.unlinkSync(p); } catch {}
    cleanup(dir);
  }
});

test('parseForBlock(json) — no _meta_skills key', () => {
  const dir = makeTempDir();
  const p = path.join(os.homedir(), '.config', 'gemini-cli', 'config.json');
  writeFile(p, JSON.stringify({ model: 'gemini-3-pro', temperature: 0.7 }, null, 2));
  try {
    const specs = defaultConfigSpecs(dir);
    const spec = specs.find(s => s.agent === 'gemini-cli' && s.type === 'json');
    const r = parseForBlock(spec);
    assert.equal(r.exists, true);
    assert.equal(r.hasBlock, false);
    assert.equal(r.error, null);
  } finally {
    try { fs.unlinkSync(p); } catch {}
    cleanup(dir);
  }
});

test('parseForBlock(json) — _meta_skills key detected', () => {
  const dir = makeTempDir();
  const p = path.join(os.homedir(), '.config', 'gemini-cli', 'config.json');
  const obj = { model: 'gemini-3-pro', [JSON_BLOCK_KEY]: { instructions: blockContent() } };
  writeFile(p, JSON.stringify(obj, null, 2));
  try {
    const specs = defaultConfigSpecs(dir);
    const spec = specs.find(s => s.agent === 'gemini-cli' && s.type === 'json');
    const r = parseForBlock(spec);
    assert.equal(r.hasBlock, true);
    assert.ok(r.blockText.includes('instructions'));
  } finally {
    try { fs.unlinkSync(p); } catch {}
    cleanup(dir);
  }
});

test('parseForBlock(json) — invalid JSON surfaces error but does not throw', () => {
  const dir = makeTempDir();
  const p = path.join(os.homedir(), '.config', 'gemini-cli', 'config.json');
  writeFile(p, '{ this is not: valid json');
  try {
    const specs = defaultConfigSpecs(dir);
    const spec = specs.find(s => s.agent === 'gemini-cli' && s.type === 'json');
    const r = parseForBlock(spec);
    assert.equal(r.exists, true);
    assert.equal(r.hasBlock, false);
    assert.ok(r.error && r.error.includes('json parse failed'));
  } finally {
    try { fs.unlinkSync(p); } catch {}
    cleanup(dir);
  }
});

test('parseForBlock — missing file returns exists=false', () => {
  const dir = makeTempDir();
  try {
    const specs = defaultConfigSpecs(dir);
    const spec = specs.find(s => s.agent === 'claude-code');
    const r = parseForBlock(spec);
    assert.equal(r.exists, false);
    assert.equal(r.hasBlock, false);
    assert.equal(r.error, null);
    assert.equal(r.content, '');
  } finally { cleanup(dir); }
});

// ---- Runner ----------------------------------------------------------------

(async () => {
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await Promise.resolve().then(fn);
      passed++;
      console.log('  ok   ' + name);
    } catch (e) {
      failed++;
      console.error('  FAIL ' + name + ': ' + e.message);
      if (e.stack) console.error(e.stack.split('\n').slice(1, 4).join('\n'));
    }
  }
  const total = passed + failed;
  console.log(`\nagent-config.test.mjs: ${passed}/${total} passed`);
  if (failed > 0) process.exit(1);
})();
