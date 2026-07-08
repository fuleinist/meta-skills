#!/usr/bin/env node

/**
 * meta-skills v1.4 - Dashboard tests
 *
 * Tests the analytics functions and the HTTP server end-to-end.
 * Uses temp directories for global.json and logs.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import {
  readIndex,
  readLogs,
  buildStaleList,
  buildPriorityDistribution,
  buildCooccurrence,
  buildHeatmap,
  buildBundles,
  startServer,
  stopServer,
  getHtml,
} from './dashboard.mjs';

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log('  ok   ' + name); })
    .catch(e => { failed++; console.error('  FAIL ' + name + ': ' + e.message); if (e.stack) console.error(e.stack.split('\n').slice(1, 4).join('\n')); });
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'meta-skills-dash-'));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ---- Analytics tests -------------------------------------------------------

const now = new Date('2026-07-09T12:00:00Z');
const fiveDaysAgo = new Date(now.getTime() - 5 * 86400000).toISOString();
const fortyDaysAgo = new Date(now.getTime() - 40 * 86400000).toISOString();

const sampleIndex = {
  $schema: 'https://meta-skills.dev/schema/v1.json',
  version: '1.0',
  generated: now.toISOString(),
  skills: [
    { id: 'a', name: 'Alpha', priority: 'high', usage_count: 10, last_used: now.toISOString() },
    { id: 'b', name: 'Beta',  priority: 'medium', usage_count: 3, last_used: fiveDaysAgo },
    { id: 'c', name: 'Gamma', priority: 'low', usage_count: 0, last_used: fortyDaysAgo },
    { id: 'd', name: 'Delta', priority: 'high' }, // no last_used
  ],
  stale: [],
  suggested_bundles: [
    { name: 'core', skills: ['a', 'b'], description: 'core skills' },
    { name: 'ops',  skills: ['b', 'c'] },
  ],
};

const sampleEvents = [
  { skill: 'a', timestamp: '2026-07-09T10:00:00Z', outcome: 'success' },
  { skill: 'b', timestamp: '2026-07-09T10:01:00Z', outcome: 'success' },
  { skill: 'a', timestamp: '2026-07-09T10:02:00Z', outcome: 'success' },
  { skill: 'c', timestamp: '2026-07-09T11:30:00Z', outcome: 'failure' },
  // Pair outside window
  { skill: 'b', timestamp: '2026-07-09T10:30:00Z', outcome: 'success' },
  // Old events
  { skill: 'a', timestamp: '2026-05-01T10:00:00Z', outcome: 'success' },
];

console.log('analytics:');

await test('buildPriorityDistribution counts by priority', () => {
  const dist = buildPriorityDistribution(sampleIndex);
  assert.equal(dist.high, 2);
  assert.equal(dist.medium, 1);
  assert.equal(dist.low, 1);
  assert.equal(dist.unset, 0);
});

const FIXED_NOW = new Date('2026-07-09T12:00:00Z').getTime();

await test('buildStaleList returns skills older than threshold', () => {
  const stale = buildStaleList(sampleIndex, 30, FIXED_NOW);
  const ids = stale.map(s => s.id);
  assert.ok(ids.includes('c'), 'expected c in stale (40 days)');
  assert.ok(!ids.includes('a'), 'a is recent');
  assert.ok(ids.includes('d'), 'd has no last_used so is stale');
  assert.equal(stale[0].daysSince, 40);
});

await test('buildStaleList respects custom threshold', () => {
  // At 7-day threshold, b (5 days) is NOT stale, c (40 days) IS stale, d (no last_used) IS stale.
  const stale = buildStaleList(sampleIndex, 7, FIXED_NOW);
  const ids = stale.map(s => s.id);
  assert.ok(!ids.includes('b'), 'b (5 days) should NOT be in stale at 7-day threshold');
  assert.ok(ids.includes('c'), 'c (40 days) should be in stale at 7-day threshold');
  assert.ok(ids.includes('d'), 'd (no last_used) should be in stale at 7-day threshold');
});

await test('buildCooccurrence finds pairs within window', () => {
  const pairs = buildCooccurrence(sampleEvents, 5 * 60 * 1000);
  // a+b at 10:00-10:01 (1), a+a skipped, b+a at 10:01-10:02 (1), c at 11:30 isolated
  // Note: pairs are unique combos (a,b) regardless of order
  const ab = pairs.find(p => (p.a === 'a' && p.b === 'b') || (p.a === 'b' && p.b === 'a'));
  assert.ok(ab, 'a+b pair should exist');
  assert.equal(ab.count, 2, 'a+b should co-occur twice within 5min');
});

await test('buildCooccurrence respects window', () => {
  // Events at 10:00:a, 10:01:b, 10:02:a — min diff is 60s.
  // 50s window: 0 pairs (no events within 50s).
  const tight = buildCooccurrence(sampleEvents, 50 * 1000);
  assert.equal(tight.length, 0, '50s window: no co-occurrences (min event diff is 60s)');
  // 90s window: 10:00-10:01 (60s) and 10:01-10:02 (60s) both fit.
  const loose = buildCooccurrence(sampleEvents, 90 * 1000);
  const ab = loose.find(p => (p.a === 'a' && p.b === 'b') || (p.a === 'b' && p.b === 'a'));
  assert.ok(ab, 'a+b should co-occur in 90s window');
  assert.equal(ab.count, 2);
});

await test('buildHeatmap produces skills x days matrix', () => {
  // Use last 7 days from 2026-07-09 (use a fixed reference date so events match)
  const heat = buildHeatmap(sampleEvents, sampleIndex.skills, 7, new Date('2026-07-09T12:00:00Z'));
  assert.equal(heat.days.length, 7);
  assert.ok(heat.skills.length >= 3);
  // Skill 'a' should have counts on 2026-07-09 (2 events: 10:00, 10:02)
  const aRow = heat.skills.find(s => s.id === 'a');
  assert.ok(aRow);
  const dayIdx = heat.days.indexOf('2026-07-09');
  assert.equal(aRow.counts[dayIdx], 2);
});

await test('buildHeatmap sorts by total desc', () => {
  const heat = buildHeatmap(sampleEvents, sampleIndex.skills, 7, new Date('2026-07-09T12:00:00Z'));
  for (let i = 1; i < heat.skills.length; i++) {
    assert.ok(heat.skills[i - 1].total >= heat.skills[i].total, 'must be sorted by total desc');
  }
});

await test('buildBundles returns suggested bundles', () => {
  const bundles = buildBundles(sampleIndex);
  assert.equal(bundles.length, 2);
  assert.equal(bundles[0].name, 'core');
  assert.deepEqual(bundles[0].skills, ['a', 'b']);
  assert.equal(bundles[0].description, 'core skills');
  assert.equal(bundles[1].description, ''); // missing desc defaults to ''
});

// ---- File I/O tests --------------------------------------------------------

console.log('file I/O:');

await test('readIndex returns empty index for missing file', () => {
  const idx = readIndex(path.join(makeTempDir(), 'nope.json'));
  assert.equal(idx.skills.length, 0);
  assert.equal(idx.stale.length, 0);
});

await test('readIndex parses valid file', () => {
  const dir = makeTempDir();
  const f = path.join(dir, 'global.json');
  fs.writeFileSync(f, JSON.stringify(sampleIndex));
  const idx = readIndex(f);
  assert.equal(idx.skills.length, 4);
  cleanup(dir);
});

await test('readIndex throws on invalid JSON', () => {
  const dir = makeTempDir();
  const f = path.join(dir, 'bad.json');
  fs.writeFileSync(f, 'not json');
  assert.throws(() => readIndex(f));
  cleanup(dir);
});

await test('readLogs parses jsonl and filters by date', () => {
  const dir = makeTempDir();
  // Old file
  fs.writeFileSync(path.join(dir, '2026-05-01.jsonl'), sampleEvents.filter(e => e.timestamp.startsWith('2026-05')).map(e => JSON.stringify(e)).join('\n'));
  // Recent file
  fs.writeFileSync(path.join(dir, '2026-07-09.jsonl'), sampleEvents.filter(e => e.timestamp.startsWith('2026-07-09')).map(e => JSON.stringify(e)).join('\n'));
  const events = readLogs(dir, 7);
  assert.ok(events.length > 0, 'should find recent events');
  assert.ok(events.every(e => e.timestamp >= '2026-07-02'), 'all events within last 7 days');
  cleanup(dir);
});

await test('readLogs skips malformed lines', () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, '2026-07-09.jsonl'),
    JSON.stringify({ skill: 'a', timestamp: '2026-07-09T10:00:00Z' }) + '\n' +
    'this is not json\n' +
    JSON.stringify({ skill: 'b', timestamp: '2026-07-09T10:01:00Z' }) + '\n');
  const events = readLogs(dir, 7);
  assert.equal(events.length, 2);
  cleanup(dir);
});

await test('readLogs returns [] for missing dir', () => {
  const events = readLogs(path.join(makeTempDir(), 'nope'), 7);
  assert.deepEqual(events, []);
});

// ---- HTML page test --------------------------------------------------------

console.log('html:');

await test('getHtml returns non-empty HTML with all panels', () => {
  const html = getHtml();
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('meta-skills dashboard'));
  for (const id of ['summary', 'heatmap', 'stale-body', 'priority-body', 'cooc-body', 'bundles-body']) {
    assert.ok(html.includes('id="' + id + '"'), 'missing panel ' + id);
  }
  for (const api of ['/api/health', '/api/index', '/api/stale', '/api/priority', '/api/cooccurrence', '/api/heatmap', '/api/bundles']) {
    assert.ok(html.includes(api), 'missing endpoint ' + api);
  }
});

// ---- HTTP server test ------------------------------------------------------

console.log('http:');

let serverHandle;

await test('startServer + stopServer lifecycle on ephemeral port', async () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'global.json'), JSON.stringify(sampleIndex));
  fs.writeFileSync(path.join(dir, '2026-07-09.jsonl'),
    sampleEvents.filter(e => e.timestamp.startsWith('2026-07-09')).map(e => JSON.stringify(e)).join('\n'));
  serverHandle = await startServer({ port: 0, globalJson: path.join(dir, 'global.json'), logDir: dir });
  assert.ok(serverHandle.port > 0, 'ephemeral port assigned');
  assert.equal(serverHandle.host, '127.0.0.1');
  // Stop immediately; we use it again in subsequent tests with a fresh handle.
  await stopServer(serverHandle);
  serverHandle = null;
  cleanup(dir);
});

await test('GET / returns HTML', async () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'global.json'), JSON.stringify(sampleIndex));
  serverHandle = await startServer({ port: 0, globalJson: path.join(dir, 'global.json'), logDir: dir });
  const body = await httpGet(serverHandle.port, '/');
  assert.ok(body.startsWith('<!doctype html>'));
  assert.ok(body.includes('meta-skills dashboard'));
  await stopServer(serverHandle);
  serverHandle = null;
  cleanup(dir);
});

await test('GET /api/health returns ok', async () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'global.json'), JSON.stringify(sampleIndex));
  serverHandle = await startServer({ port: 0, globalJson: path.join(dir, 'global.json'), logDir: dir });
  const body = await httpGet(serverHandle.port, '/api/health');
  const j = JSON.parse(body);
  assert.equal(j.ok, true);
  assert.equal(j.version, '1.4');
  await stopServer(serverHandle);
  serverHandle = null;
  cleanup(dir);
});

await test('GET /api/index returns full index', async () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'global.json'), JSON.stringify(sampleIndex));
  serverHandle = await startServer({ port: 0, globalJson: path.join(dir, 'global.json'), logDir: dir });
  const body = await httpGet(serverHandle.port, '/api/index');
  const j = JSON.parse(body);
  assert.equal(j.skills.length, 4);
  await stopServer(serverHandle);
  serverHandle = null;
  cleanup(dir);
});

await test('GET /api/priority returns distribution', async () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'global.json'), JSON.stringify(sampleIndex));
  serverHandle = await startServer({ port: 0, globalJson: path.join(dir, 'global.json'), logDir: dir });
  const body = await httpGet(serverHandle.port, '/api/priority');
  const j = JSON.parse(body);
  assert.equal(j.high, 2);
  assert.equal(j.medium, 1);
  await stopServer(serverHandle);
  serverHandle = null;
  cleanup(dir);
});

await test('GET /api/stale?days=30 returns stale skills', async () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'global.json'), JSON.stringify(sampleIndex));
  serverHandle = await startServer({ port: 0, globalJson: path.join(dir, 'global.json'), logDir: dir });
  const body = await httpGet(serverHandle.port, '/api/stale?days=30');
  const j = JSON.parse(body);
  assert.equal(j.thresholdDays, 30);
  const ids = j.skills.map(s => s.id);
  assert.ok(ids.includes('c'));
  await stopServer(serverHandle);
  serverHandle = null;
  cleanup(dir);
});

await test('GET /api/bundles returns bundles', async () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'global.json'), JSON.stringify(sampleIndex));
  serverHandle = await startServer({ port: 0, globalJson: path.join(dir, 'global.json'), logDir: dir });
  const body = await httpGet(serverHandle.port, '/api/bundles');
  const j = JSON.parse(body);
  assert.equal(j.bundles.length, 2);
  await stopServer(serverHandle);
  serverHandle = null;
  cleanup(dir);
});

await test('GET /api/heatmap returns matrix', async () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'global.json'), JSON.stringify(sampleIndex));
  fs.writeFileSync(path.join(dir, '2026-07-09.jsonl'),
    sampleEvents.filter(e => e.timestamp.startsWith('2026-07-09')).map(e => JSON.stringify(e)).join('\n'));
  serverHandle = await startServer({ port: 0, globalJson: path.join(dir, 'global.json'), logDir: dir });
  const body = await httpGet(serverHandle.port, '/api/heatmap?days=7');
  const j = JSON.parse(body);
  assert.equal(j.days.length, 7);
  assert.ok(j.skills.length >= 3);
  await stopServer(serverHandle);
  serverHandle = null;
  cleanup(dir);
});

await test('GET /api/cooccurrence returns pairs', async () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'global.json'), JSON.stringify(sampleIndex));
  fs.writeFileSync(path.join(dir, '2026-07-09.jsonl'),
    sampleEvents.filter(e => e.timestamp.startsWith('2026-07-09')).map(e => JSON.stringify(e)).join('\n'));
  serverHandle = await startServer({ port: 0, globalJson: path.join(dir, 'global.json'), logDir: dir });
  const body = await httpGet(serverHandle.port, '/api/cooccurrence?since=7&window=5');
  const j = JSON.parse(body);
  assert.equal(j.windowMs, 5 * 60 * 1000);
  assert.ok(Array.isArray(j.pairs));
  await stopServer(serverHandle);
  serverHandle = null;
  cleanup(dir);
});

await test('GET /nope returns 404', async () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'global.json'), JSON.stringify(sampleIndex));
  serverHandle = await startServer({ port: 0, globalJson: path.join(dir, 'global.json'), logDir: dir });
  const r = await httpGetRaw(serverHandle.port, '/nope');
  assert.equal(r.status, 404);
  await stopServer(serverHandle);
  serverHandle = null;
  cleanup(dir);
});

await test('POST /api/health returns 405', async () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'global.json'), JSON.stringify(sampleIndex));
  serverHandle = await startServer({ port: 0, globalJson: path.join(dir, 'global.json'), logDir: dir });
  const r = await httpRequest(serverHandle.port, '/api/health', 'POST');
  assert.equal(r.status, 405);
  await stopServer(serverHandle);
  serverHandle = null;
  cleanup(dir);
});

// ---- helpers ---------------------------------------------------------------

function httpGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function httpGetRaw(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath }, res => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode }));
    }).on('error', reject);
  });
}

function httpRequest(port, urlPath, method) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method }, res => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('error', reject);
    req.end();
  });
}

if (serverHandle) await stopServer(serverHandle);

console.log('');
console.log(`results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
