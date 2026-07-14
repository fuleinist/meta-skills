#!/usr/bin/env node

/**
 * meta-skills v1.4 - Local Web Dashboard
 *
 * Read-only HTTP server that visualizes the meta-skills index in a browser.
 * Serves a single-page HTML+CSS+vanilla-JS app at GET / and JSON APIs at
 * GET /api/*. Binds to 127.0.0.1 only (no external network exposure).
 *
 * Commands:
 *   start [--port 7777] [--host 127.0.0.1] [--global-json <path>] [--log-dir <path>]
 *     -> boots dashboard server; shuts down on SIGINT/SIGTERM
 *
 * Endpoints:
 *   GET /                       HTML page
 *   GET /api/index              full meta-skills index JSON
 *   GET /api/logs?since=7       log events from last N days
 *   GET /api/stale?days=30      skills unused for N+ days
 *   GET /api/priority           priority distribution counts
 *   GET /api/cooccurrence       skill pairs that activated within 5min window
 *   GET /api/heatmap?days=7     skills x days matrix
 *   GET /api/bundles            suggested bundles from global.json
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildBudgetPanel } from './budget-optimizer.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 7777;
const DEFAULT_STALE_DAYS = 30;
const DEFAULT_HEATMAP_DAYS = 7;
const DEFAULT_COOCCURRENCE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_LOG_LOOKBACK_DAYS = 30;
const SCHEMA_URL = 'https://meta-skills.dev/schema/v1.json';

// ---- Default paths ---------------------------------------------------------

export function defaultGlobalJson() {
  return path.join(os.homedir(), '.meta-skills', 'global.json');
}

export function defaultLogDir() {
  return path.join(os.homedir(), '.meta-skills', 'logs');
}

// ---- Data loading ----------------------------------------------------------

export function readIndex(globalPath) {
  if (!fs.existsSync(globalPath)) {
    return { $schema: SCHEMA_URL, version: '1.0', generated: null, skills: [], stale: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(globalPath, 'utf-8'));
  } catch (e) {
    throw new Error(`failed to parse ${globalPath}: ${e.message}`);
  }
}

export function readLogs(logDir, sinceDays = DEFAULT_LOG_LOOKBACK_DAYS) {
  if (!fs.existsSync(logDir)) return [];
  const cutoff = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
  const files = fs.readdirSync(logDir).filter(f => f.endsWith('.jsonl'));
  const events = [];
  for (const file of files) {
    const dateStr = file.replace('.jsonl', '');
    const fileDate = new Date(dateStr + 'T00:00:00Z').getTime();
    if (isNaN(fileDate) || fileDate < cutoff) continue;
    const content = fs.readFileSync(path.join(logDir, file), 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const ev = JSON.parse(trimmed);
        if (ev.skill && ev.timestamp) events.push(ev);
      } catch {
        // skip malformed
      }
    }
  }
  events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return events;
}

// ---- Analytics -------------------------------------------------------------

export function buildStaleList(index, thresholdDays = DEFAULT_STALE_DAYS, now = Date.now()) {
  const cutoff = now - thresholdDays * 24 * 60 * 60 * 1000;
  const result = [];
  for (const s of index.skills || []) {
    if (!s.last_used) {
      result.push({ id: s.id, name: s.name, daysSince: null, last_used: null, priority: s.priority || 'low' });
      continue;
    }
    const lastMs = new Date(s.last_used).getTime();
    if (isNaN(lastMs) || lastMs < cutoff) {
      const days = isNaN(lastMs) ? null : Math.floor((now - lastMs) / (24 * 60 * 60 * 1000));
      result.push({ id: s.id, name: s.name, daysSince: days, last_used: s.last_used, priority: s.priority || 'low' });
    }
  }
  // Sort: largest daysSince first; nulls (never used) at the end.
  return result.sort((a, b) => (b.daysSince ?? -1) - (a.daysSince ?? -1));
}

export function buildPriorityDistribution(index) {
  const counts = { high: 0, medium: 0, low: 0, unset: 0 };
  for (const s of index.skills || []) {
    const p = s.priority;
    if (p === 'high' || p === 'medium' || p === 'low') counts[p]++;
    else counts.unset++;
  }
  return counts;
}

export function buildCooccurrence(events, windowMs = DEFAULT_COOCCURRENCE_WINDOW_MS) {
  // Sort ascending by timestamp so we can break out of the inner loop
  // when the next event is past the window.
  const sorted = [...events].sort((x, y) => {
    const xt = new Date(x.timestamp).getTime();
    const yt = new Date(y.timestamp).getTime();
    if (isNaN(xt) && isNaN(yt)) return 0;
    if (isNaN(xt)) return 1;
    if (isNaN(yt)) return -1;
    return xt - yt;
  });
  const pairCounts = new Map();
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    const aTs = new Date(a.timestamp).getTime();
    if (isNaN(aTs)) continue;
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j];
      const bTs = new Date(b.timestamp).getTime();
      if (isNaN(bTs)) continue;
      if (bTs - aTs > windowMs) break;
      if (a.skill === b.skill) continue;
      const key = a.skill < b.skill ? `${a.skill}|${b.skill}` : `${b.skill}|${a.skill}`;
      pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
    }
  }
  const pairs = [];
  for (const [key, count] of pairCounts) {
    const [a, b] = key.split('|');
    pairs.push({ a, b, count });
  }
  pairs.sort((x, y) => y.count - x.count);
  return pairs;
}

export function buildHeatmap(events, skills, days = DEFAULT_HEATMAP_DAYS, referenceDate = new Date()) {
  // For each skill, count events per day for the last N days.
  // Returns: { days: ['2026-07-03', ...], skills: [{id, name, counts: [n,n,...]}, ...] }
  const today = new Date(referenceDate);
  today.setUTCHours(0, 0, 0, 0);
  const dayList = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    dayList.push(d.toISOString().slice(0, 10));
  }
  const skillMeta = new Map();
  for (const s of skills) skillMeta.set(s.id, s);
  // Initialize zero matrix
  const matrix = new Map();
  for (const s of skills) {
    matrix.set(s.id, new Array(days).fill(0));
  }
  for (const ev of events) {
    const day = ev.timestamp.slice(0, 10);
    const dayIdx = dayList.indexOf(day);
    if (dayIdx === -1) continue;
    if (!matrix.has(ev.skill)) {
      // Skill activated but not in current index (could be a marketplace install)
      const row = new Array(days).fill(0);
      row[dayIdx] = 1;
      matrix.set(ev.skill, row);
      skillMeta.set(ev.skill, { id: ev.skill, name: ev.skill });
    } else {
      matrix.get(ev.skill)[dayIdx]++;
    }
  }
  const result = [];
  for (const [id, counts] of matrix) {
    const total = counts.reduce((s, n) => s + n, 0);
    if (total === 0 && !skillMeta.has(id)) continue; // skip empty + unknown
    result.push({
      id,
      name: (skillMeta.get(id) || {}).name || id,
      counts,
      total,
    });
  }
  result.sort((a, b) => b.total - a.total);
  return { days: dayList, skills: result };
}

export function buildBundles(index) {
  return (index.suggested_bundles || []).map(b => ({
    name: b.name,
    skills: b.skills || [],
    description: b.description || '',
  }));
}

// ---- HTTP handler ----------------------------------------------------------

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body, 'utf-8'),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendHtml(res, body) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body, 'utf-8'),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function send404(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
}

function parseQuery(url) {
  const idx = url.indexOf('?');
  if (idx === -1) return { path: url, params: {} };
  const path = url.slice(0, idx);
  const qs = url.slice(idx + 1);
  const params = {};
  for (const pair of qs.split('&')) {
    if (!pair) continue;
    const [k, v] = pair.split('=');
    params[decodeURIComponent(k)] = v === undefined ? '' : decodeURIComponent(v || '');
  }
  return { path, params };
}

function makeHandler(options) {
  const globalPath = options.globalJson || defaultGlobalJson();
  const logDir = options.logDir || defaultLogDir();
  return function handle(req, res) {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method Not Allowed');
      return;
    }
    const { path: urlPath, params } = parseQuery(req.url || '/');
    try {
      if (urlPath === '/' || urlPath === '/index.html') {
        sendHtml(res, getHtml());
        return;
      }
      if (urlPath === '/api/index') {
        sendJson(res, 200, readIndex(globalPath));
        return;
      }
      if (urlPath === '/api/logs') {
        const since = parseInt(params.since || '7', 10);
        sendJson(res, 200, { events: readLogs(logDir, since) });
        return;
      }
      if (urlPath === '/api/stale') {
        const days = parseInt(params.days || String(DEFAULT_STALE_DAYS), 10);
        sendJson(res, 200, { thresholdDays: days, skills: buildStaleList(readIndex(globalPath), days, Date.now()) });
        return;
      }
      if (urlPath === '/api/priority') {
        sendJson(res, 200, buildPriorityDistribution(readIndex(globalPath)));
        return;
      }
      if (urlPath === '/api/cooccurrence') {
        const windowMs = parseInt(params.window || String(Math.floor(DEFAULT_COOCCURRENCE_WINDOW_MS / 60000)), 10) * 60 * 1000;
        const since = parseInt(params.since || '30', 10);
        const events = readLogs(logDir, since);
        sendJson(res, 200, { windowMs, pairs: buildCooccurrence(events, windowMs) });
        return;
      }
      if (urlPath === '/api/heatmap') {
        const days = parseInt(params.days || String(DEFAULT_HEATMAP_DAYS), 10);
        const index = readIndex(globalPath);
        const events = readLogs(logDir, days);
        sendJson(res, 200, buildHeatmap(events, index.skills || [], days));
        return;
      }
      if (urlPath === '/api/bundles') {
        sendJson(res, 200, { bundles: buildBundles(readIndex(globalPath)) });
        return;
      }
      if (urlPath === '/api/budget') {
        const max = parseInt(params.max || '500', 10);
        const action = params.action === 'archive' ? 'archive' : 'demote';
        const index = readIndex(globalPath);
        sendJson(res, 200, buildBudgetPanel(index, { maxTokens: max, action }));
        return;
      }
      if (urlPath === '/api/health') {
        sendJson(res, 200, { ok: true, version: '1.4', generated: readIndex(globalPath).generated });
        return;
      }
      send404(res);
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
  };
}

// ---- Server lifecycle ------------------------------------------------------

export function startServer(options = {}) {
  const host = options.host || DEFAULT_HOST;
  // Use ?? so port: 0 (ephemeral) is honored, not treated as falsy.
  const port = options.port ?? DEFAULT_PORT;
  const server = http.createServer(makeHandler(options));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actualPort = server.address().port;
      server.removeListener('error', reject);
      resolve({ server, host, port: actualPort });
    });
  });
}

export function stopServer(handle) {
  if (!handle || !handle.server) return Promise.resolve();
  return new Promise(resolve => {
    handle.server.close(() => resolve());
    // Force close any keep-alive connections
    handle.server.closeAllConnections && handle.server.closeAllConnections();
  });
}

// ---- Command ---------------------------------------------------------------

export async function cmdDashboard(args) {
  const options = { host: DEFAULT_HOST, port: DEFAULT_PORT };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && i + 1 < args.length) options.port = parseInt(args[++i], 10);
    else if (args[i] === '--host' && i + 1 < args.length) options.host = args[++i];
    else if (args[i] === '--global-json' && i + 1 < args.length) options.globalJson = path.resolve(args[++i]);
    else if (args[i] === '--log-dir' && i + 1 < args.length) options.logDir = path.resolve(args[++i]);
  }
  if (Number.isNaN(options.port) || options.port < 1 || options.port > 65535) {
    console.error('error: --port must be 1-65535');
    process.exit(1);
  }
  // Bind only to loopback for security
  if (options.host !== '127.0.0.1' && options.host !== 'localhost' && options.host !== '::1') {
    console.error(`error: refusing to bind to non-loopback host "${options.host}" (security: dashboard is local-only)`);
    process.exit(1);
  }
  options.host = '127.0.0.1';

  const handle = await startServer(options);
  console.log(`meta-skills dashboard listening on http://${handle.host}:${handle.port}`);
  console.log('  open the URL above in your browser. ctrl-c to stop.');

  const shutdown = async (signal) => {
    console.log(`\nreceived ${signal}, shutting down...`);
    await stopServer(handle);
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

// ---- HTML page (single-file vanilla JS+CSS) --------------------------------

export function getHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>meta-skills dashboard</title>
<style>
  :root {
    --bg: #0f1115; --panel: #1a1d23; --panel-2: #22262e; --fg: #e6e6e6;
    --muted: #8a8f99; --accent: #7c9eff; --hot: #ff7c7c; --cold: #5a6478;
    --border: #2c313a; --green: #7cd1a8; --yellow: #e6c07b;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; background: var(--bg); color: var(--fg); }
  header { padding: 16px 24px; background: var(--panel); border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
  header h1 { margin: 0; font-size: 16px; font-weight: 600; }
  header .meta { color: var(--muted); font-size: 12px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding: 16px; }
  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 16px; }
  .panel h2 { margin: 0 0 12px 0; font-size: 13px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .panel.full { grid-column: 1 / -1; }
  .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; }
  .stat { background: var(--panel-2); padding: 8px 12px; border-radius: 4px; }
  .stat .label { color: var(--muted); font-size: 11px; text-transform: uppercase; }
  .stat .value { font-size: 20px; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 500; text-transform: uppercase; font-size: 10px; }
  tr:hover td { background: var(--panel-2); }
  .heatmap { overflow-x: auto; }
  .heatmap table { font-size: 11px; }
  .heatmap td.heat { width: 24px; height: 18px; text-align: center; padding: 0; }
  .heatmap td.label { white-space: nowrap; padding-right: 12px; }
  .heatmap th.day { font-weight: 400; color: var(--muted); }
  .cooc { font-size: 12px; }
  .cooc .pair { display: flex; justify-content: space-between; padding: 2px 0; border-bottom: 1px dotted var(--border); }
  .bundle { background: var(--panel-2); padding: 8px 12px; border-radius: 4px; margin-bottom: 6px; }
  .bundle .name { font-weight: 600; }
  .bundle .skills { color: var(--muted); font-size: 11px; margin-top: 2px; }
  .pbar { display: flex; height: 8px; border-radius: 4px; overflow: hidden; margin-top: 4px; }
  .pbar .seg { transition: width 0.3s; }
  .pbar .high { background: var(--hot); }
  .pbar .med { background: var(--yellow); }
  .pbar .low { background: var(--green); }
  .pbar .unset { background: var(--cold); }
  .empty { color: var(--muted); font-style: italic; padding: 8px 0; }
  .error { color: var(--hot); padding: 4px 0; }
  footer { padding: 12px 24px; color: var(--muted); font-size: 11px; border-top: 1px solid var(--border); }
</style>
</head>
<body>
<header>
  <h1>meta-skills dashboard</h1>
  <div class="meta" id="meta">loading...</div>
</header>

<div class="grid">
  <section class="panel full" id="summary">
    <h2>Summary</h2>
    <div class="stat-grid" id="stats"></div>
  </section>

  <section class="panel full" id="heatmap">
    <h2>Usage Heatmap (last 7 days)</h2>
    <div id="heatmap-body"></div>
  </section>

  <section class="panel">
    <h2>Stale Skills (30+ days)</h2>
    <div id="stale-body"></div>
  </section>

  <section class="panel">
    <h2>Priority Distribution</h2>
    <div id="priority-body"></div>
  </section>

  <section class="panel">
    <h2>Token Budget (v1.7)</h2>
    <div id="budget-body"></div>
  </section>

  <section class="panel">
    <h2>Co-occurrence (5min window, last 30d)</h2>
    <div class="cooc" id="cooc-body"></div>
  </section>

  <section class="panel">
    <h2>Suggested Bundles</h2>
    <div id="bundles-body"></div>
  </section>
</div>

<footer>
  auto-refresh every 30s. read-only. server is local-only (127.0.0.1).
</footer>

<script>
const $ = (id) => document.getElementById(id);
const REFRESH_MS = 30000;

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(url + ' -> ' + r.status);
  return r.json();
}

function heatColor(n) {
  if (n <= 0) return 'transparent';
  // 1..10 maps to opacity 0.15..1.0
  const alpha = Math.min(1, 0.15 + Math.log10(1 + n * 9) / 1);
  return 'rgba(124, 158, 255, ' + alpha.toFixed(2) + ')';
}

async function refresh() {
  try {
    const [health, stats, heat, stale, prio, cooc, bundles, budget] = await Promise.all([
      fetchJson('/api/health'),
      fetchJson('/api/index'),
      fetchJson('/api/heatmap?days=7'),
      fetchJson('/api/stale?days=30'),
      fetchJson('/api/priority'),
      fetchJson('/api/cooccurrence?since=30&window=5'),
      fetchJson('/api/bundles'),
      fetchJson('/api/budget?max=500'),
    ]);

    $('meta').textContent = 'v' + (health.version || '?') + ' · index generated ' + (health.generated || 'never') + ' · ' + new Date().toLocaleTimeString();

    // Summary stats
    const total = (stats.skills || []).reduce((s, x) => s + (x.usage_count || 0), 0);
    const bundles_n = (stats.suggested_bundles || 0);
    $('stats').innerHTML = \`
      <div class="stat"><div class="label">Active</div><div class="value">\${(stats.skills || []).length}</div></div>
      <div class="stat"><div class="label">Stale</div><div class="value">\${(stats.stale || []).length}</div></div>
      <div class="stat"><div class="label">Activations</div><div class="value">\${total}</div></div>
      <div class="stat"><div class="label">Bundles</div><div class="value">\${bundles_n}</div></div>
    \`;

    // Heatmap
    let heatHtml = '<div class="heatmap"><table>';
    heatHtml += '<thead><tr><th></th>';
    for (const d of heat.days) heatHtml += '<th class="day">' + d.slice(5) + '</th>';
    heatHtml += '<th class="day">total</th></tr></thead><tbody>';
    for (const row of heat.skills.slice(0, 50)) {
      heatHtml += '<tr><td class="label">' + escape(row.name || row.id) + '</td>';
      for (const n of row.counts) heatHtml += '<td class="heat" style="background:' + heatColor(n) + '" title="' + n + '">' + (n || '') + '</td>';
      heatHtml += '<td class="heat" style="background:' + heatColor(row.total) + ';color:var(--muted)">' + row.total + '</td></tr>';
    }
    heatHtml += '</tbody></table></div>';
    $('heatmap-body').innerHTML = heat.days.length === 0 ? '<div class="empty">no data</div>' : heatHtml;

    // Stale
    if (stale.skills.length === 0) {
      $('stale-body').innerHTML = '<div class="empty">no stale skills</div>';
    } else {
      let s = '<table><thead><tr><th>Skill</th><th>Last used</th><th>Days</th></tr></thead><tbody>';
      for (const x of stale.skills.slice(0, 20)) {
        s += '<tr><td>' + escape(x.name || x.id) + '</td><td>' + (x.last_used || 'never') + '</td><td>' + (x.daysSince == null ? '?' : x.daysSince) + '</td></tr>';
      }
      s += '</tbody></table>';
      $('stale-body').innerHTML = s;
    }

    // Priority
    const total2 = prio.high + prio.medium + prio.low + prio.unset || 1;
    $('priority-body').innerHTML = \`
      <div class="stat-grid">
        <div class="stat"><div class="label">High</div><div class="value">\${prio.high}</div></div>
        <div class="stat"><div class="label">Medium</div><div class="value">\${prio.medium}</div></div>
        <div class="stat"><div class="label">Low</div><div class="value">\${prio.low}</div></div>
        <div class="stat"><div class="label">Unset</div><div class="value">\${prio.unset}</div></div>
      </div>
      <div class="pbar" title="priority distribution">
        <div class="seg high" style="width:\${(prio.high / total2 * 100).toFixed(1)}%"></div>
        <div class="seg med"  style="width:\${(prio.medium / total2 * 100).toFixed(1)}%"></div>
        <div class="seg low"  style="width:\${(prio.low / total2 * 100).toFixed(1)}%"></div>
        <div class="seg unset" style="width:\${(prio.unset / total2 * 100).toFixed(1)}%"></div>
      </div>
    \`;

    // Co-occurrence
    if (cooc.pairs.length === 0) {
      $('cooc-body').innerHTML = '<div class="empty">no co-occurrence detected</div>';
    } else {
      let c = '';
      for (const p of cooc.pairs.slice(0, 20)) {
        c += '<div class="pair"><span>' + escape(p.a) + ' + ' + escape(p.b) + '</span><span style="color:var(--accent)">' + p.count + '</span></div>';
      }
      $('cooc-body').innerHTML = c;
    }

    // Bundles
    if (bundles.bundles.length === 0) {
      $('bundles-body').innerHTML = '<div class="empty">no bundles defined</div>';
    } else {
      let b = '';
      for (const x of bundles.bundles) {
        b += '<div class="bundle"><div class="name">' + escape(x.name) + '</div><div class="skills">' + x.skills.map(escape).join(' · ') + '</div>' + (x.description ? '<div style="margin-top:4px;font-size:11px">' + escape(x.description) + '</div>' : '') + '</div>';
      }
      $('bundles-body').innerHTML = b;
    }

    // Token budget (v1.7)
    {
      const utilPct = Math.min(100, (budget.utilization * 100)).toFixed(0);
      const utilColor = budget.utilization <= 1.0 ? 'var(--green)' : (budget.utilization <= 1.2 ? 'var(--yellow)' : 'var(--hot)');
      let bHtml = '';
      bHtml += '<div class="stat-grid">';
      bHtml += '<div class="stat"><div class="label">Current</div><div class="value">' + budget.current + '</div></div>';
      bHtml += '<div class="stat"><div class="label">Cap</div><div class="value">' + budget.max + '</div></div>';
      bHtml += '<div class="stat"><div class="label">Over by</div><div class="value" style="color:' + (budget.over > 0 ? 'var(--hot)' : 'var(--green)') + '">' + budget.over + '</div></div>';
      bHtml += '<div class="stat"><div class="label">Projected</div><div class="value">' + budget.projected + '</div></div>';
      bHtml += '</div>';
      bHtml += '<div class="pbar" title="budget utilization"><div class="seg" style="background:' + utilColor + ';width:' + utilPct + '%"></div></div>';
      bHtml += '<div style="font-size:11px;color:var(--muted);margin-top:4px">' + utilPct + '% utilized';
      if (budget.unfixable) bHtml += ' · <span style="color:var(--hot)">all remaining skills are high-priority</span>';
      bHtml += '</div>';
      if (budget.suggestions.length === 0) {
        bHtml += '<div class="empty">no suggestions — under budget</div>';
      } else {
        bHtml += '<table style="margin-top:8px"><thead><tr><th>Skill</th><th>Pri</th><th>Tokens</th><th>Density</th><th>Action</th></tr></thead><tbody>';
        for (const s of budget.suggestions.slice(0, 10)) {
          bHtml += '<tr><td>' + escape(s.id) + '</td><td>' + s.currentPriority + '</td><td>' + s.currentTokens + '</td><td>' + s.valueDensity + '</td><td>' + s.action + '</td></tr>';
        }
        bHtml += '</tbody></table>';
        bHtml += '<div style="font-size:10px;color:var(--muted);margin-top:4px">run <code>meta-skills budget --max-tokens ' + budget.max + ' --write</code> to apply</div>';
      }
      $('budget-body').innerHTML = bHtml;
    }
  } catch (e) {
    $('meta').textContent = 'error: ' + e.message;
  }
}

function escape(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

refresh();
setInterval(refresh, REFRESH_MS);
</script>
</body>
</html>
`;
}

// ---- Module entry ----------------------------------------------------------

const isMain = process.argv[1] && (
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1].endsWith('dashboard.mjs')
);
if (isMain) cmdDashboard(process.argv.slice(2));

export { cmdDashboard as main };
