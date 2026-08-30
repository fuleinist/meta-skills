/**
 * Tests for src/mcp-telemetry.mjs (v0.2.1)
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';

import { handleRequest, loadIndex, startServer, TOOLS, defaultIndexPath } from './mcp-telemetry.mjs';

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((e) => { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; });
}

function fixtureIndex() {
  return {
    path: '/tmp/fake-global.json',
    meta: { version: 1 },
    skills: [
      { id: 'alpha', when: 'w', why: 'y', path: '/no/such/file.md', priority: 'high', usage_count: 5, last_used: new Date().toISOString() },
      { id: 'beta', when: 'w', why: 'y', path: '/no/such/file.md', priority: 'low', usage_count: 0, deprecated: true },
      { id: 'gamma', when: 'w', why: 'y', path: '/no/such/file.md', priority: 'medium', usage_count: 12, last_used: '2020-01-01T00:00:00Z' },
    ],
  };
}

const index = fixtureIndex();

async function main() {
  console.log('mcp-telemetry tests');

  await ok('handleRequest: initialize handshake', async () => {
    const res = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, index);
    assert.equal(res.result.protocolVersion, '2024-11-05');
    assert.deepEqual(res.result.capabilities, { tools: {} });
    assert.equal(res.result.serverInfo.name, 'meta-skills-telemetry');
  });

  await ok('handleRequest: ping', async () => {
    const res = await handleRequest({ jsonrpc: '2.0', id: 2, method: 'ping' }, index);
    assert.deepEqual(res.result, {});
  });

  await ok('handleRequest: tools/list returns 5 tools', async () => {
    const res = await handleRequest({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, index);
    assert.equal(res.result.tools.length, 5);
    assert.deepEqual(res.result.tools.map((t) => t.name), TOOLS.map((t) => t.name));
  });

  await ok('handleRequest: notifications/initialized returns null', async () => {
    const res = await handleRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }, index);
    assert.equal(res, null);
  });

  await ok('handleRequest: invalid request -> -32600', async () => {
    const res = await handleRequest({ id: 4, method: 'x' }, index);
    assert.equal(res.error.code, -32600);
  });

  await ok('handleRequest: unknown method -> -32601', async () => {
    const res = await handleRequest({ jsonrpc: '2.0', id: 5, method: 'nope' }, index);
    assert.equal(res.error.code, -32601);
  });

  await ok('tools/call: skills_overview buckets + top', async () => {
    const res = await handleRequest({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'skills_overview', arguments: { limit: 2 } } }, index);
    const data = JSON.parse(res.result.content[0].text);
    assert.equal(data.total, 3);
    assert.equal(data.priority_buckets.high, 1);
    assert.equal(data.top_by_priority.length, 2);
  });

  await ok('tools/call: skill_lookup found + not found', async () => {
    const res = await handleRequest({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'skill_lookup', arguments: { id: 'alpha' } } }, index);
    assert.equal(JSON.parse(res.result.content[0].text).id, 'alpha');
    const miss = await handleRequest({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'skill_lookup', arguments: { id: 'zzz' } } }, index);
    assert.equal(miss.result.isError, true);
  });

  await ok('tools/call: skills_top_used sorted by usage desc', async () => {
    const res = await handleRequest({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'skills_top_used', arguments: {} } }, index);
    const data = JSON.parse(res.result.content[0].text);
    assert.deepEqual(data.map((d) => d.id), ['gamma', 'alpha', 'beta']);
  });

  await ok('tools/call: telemetry_summary aggregates', async () => {
    const res = await handleRequest({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'telemetry_summary', arguments: {} } }, index);
    const data = JSON.parse(res.result.content[0].text);
    assert.equal(data.total_skills, 3);
    assert.equal(data.total_uses, 17);
    assert.equal(data.never_used, 1);
    assert.equal(data.deprecated, 1);
    assert.equal(data.used_last_7d, 1);
  });

  await ok('tools/call: skill_quality_report tolerates missing SKILL.md', async () => {
    const res = await handleRequest({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'skill_quality_report', arguments: { id: 'alpha' } } }, index);
    const data = JSON.parse(res.result.content[0].text);
    assert.equal(data.id, 'alpha');
  });

  await ok('tools/call: unknown tool -> isError', async () => {
    const res = await handleRequest({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'bogus' } }, index);
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /unknown tool/);
  });

  await ok('loadIndex: reads real fixture from disk', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-tele-'));
    const p = path.join(dir, 'global.json');
    fs.writeFileSync(p, JSON.stringify({ version: 1, skills: [{ id: 'x' }] }));
    const idx = loadIndex(p);
    assert.equal(idx.skills.length, 1);
    assert.equal(idx.path, p);
    fs.rmSync(dir, { recursive: true });
  });

  await ok('loadIndex: missing file throws', async () => {
    assert.throws(() => loadIndex('/no/such/global.json'), /index not found/);
  });

  await ok('startServer: round-trip over fake streams', async () => {
    const lines = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'telemetry_summary', arguments: {} } }),
      'not-json',
    ].join('\n') + '\n';
    const input = Readable.from([lines]);
    const chunks = [];
    const output = new Writable({
      write(chunk, _enc, cb) { chunks.push(chunk.toString()); cb(); },
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-tele-'));
    const p = path.join(dir, 'global.json');
    fs.writeFileSync(p, JSON.stringify({ version: 1, skills: [{ id: 'a', usage_count: 3 }] }));
    await startServer({ input, output, indexPath: p });
    // Response order is not guaranteed (async scheduling); JSON-RPC clients
    // match by id, so assert by id instead.
    const responses = chunks.join('').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(responses.length, 3); // notification gets no reply
    const byId = Object.fromEntries(responses.filter((r) => r.id != null).map((r) => [r.id, r]));
    const errs = responses.filter((r) => r.error);
    assert.equal(byId[1].result.serverInfo.name, 'meta-skills-telemetry');
    assert.equal(byId[2].result.content[0].type, 'text');
    assert.equal(errs.length, 1);
    assert.equal(errs[0].error.code, -32700);
    fs.rmSync(dir, { recursive: true });
  });

  await ok('defaultIndexPath under home dir', async () => {
    assert.ok(defaultIndexPath().includes('.meta-skills'));
  });

  console.log(`mcp-telemetry: ${passed} passed${process.exitCode ? ' (with failures)' : ''}`);
}

main();
