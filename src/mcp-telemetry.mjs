/**
 * meta-skills v0.2.1 — Skill Telemetry MCP Server
 *
 * Read-only stdio MCP server exposing skill telemetry (usage, priority,
 * quality, deprecation) to any MCP client. Zero dependencies: minimal
 * hand-rolled JSON-RPC 2.0 over newline-delimited stdio (MCP stdio transport).
 *
 * Usage:
 *   meta-skills mcp [--index <path>]
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf-8'));

const PROTOCOL_VERSION = '2024-11-05';

export function defaultIndexPath() {
  return path.join(os.homedir(), '.meta-skills', 'global.json');
}

export function loadIndex(indexPath = defaultIndexPath()) {
  if (!fs.existsSync(indexPath)) {
    throw new Error(`index not found: ${indexPath} (run \`meta-skills init --global\`)`);
  }
  const raw = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
  const skills = Array.isArray(raw.skills) ? raw.skills : [];
  return { path: indexPath, meta: { version: raw.version, generated: raw.generated, source: raw.source }, skills };
}

// ---------------------------------------------------------------------------
// Tool implementations (pure functions over the loaded index)
// ---------------------------------------------------------------------------

function toolSkillsOverview(index, args = {}) {
  const limit = Math.max(1, Number(args.limit ?? 10));
  const { skills } = index;
  const buckets = {};
  for (const s of skills) {
    const p = String(s.priority ?? 'unknown');
    buckets[p] = (buckets[p] ?? 0) + 1;
  }
  const top = [...skills]
    .sort((a, b) => String(b.priority ?? '').localeCompare(String(a.priority ?? '')))
    .slice(0, limit)
    .map((s) => ({ id: s.id, priority: s.priority, usage_count: s.usage_count ?? 0 }));
  return { total: skills.length, priority_buckets: buckets, top_by_priority: top };
}

function toolSkillLookup(index, args = {}) {
  const id = String(args.id ?? '');
  if (!id) throw paramError('skill_lookup requires "id"');
  const entry = index.skills.find((s) => s.id === id);
  if (!entry) throw paramError(`skill not found: ${id}`);
  return entry;
}

function toolSkillsTopUsed(index, args = {}) {
  const limit = Math.max(1, Number(args.limit ?? 10));
  return [...index.skills]
    .sort((a, b) => (b.usage_count ?? 0) - (a.usage_count ?? 0)
      || String(b.last_used ?? '').localeCompare(String(a.last_used ?? '')))
    .slice(0, limit)
    .map((s) => ({ id: s.id, usage_count: s.usage_count ?? 0, last_used: s.last_used ?? null }));
}

async function toolSkillQualityReport(index, args = {}) {
  const { scoreSkill, scoreAll } = await import('./quality-scorer.mjs');
  if (args.id) {
    const entry = index.skills.find((s) => s.id === String(args.id));
    if (!entry) throw paramError(`skill not found: ${args.id}`);
    return { id: entry.id, ...scoreSkill(entry) };
  }
  return scoreAll(index.path ?? defaultIndexPath());
}

function toolTelemetrySummary(index) {
  const now = Date.now();
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  let totalUses = 0;
  let usedLast7d = 0;
  let neverUsed = 0;
  let deprecated = 0;
  for (const s of index.skills) {
    const u = s.usage_count ?? 0;
    totalUses += u;
    if (u === 0) neverUsed++;
    if (s.last_used && now - Date.parse(s.last_used) <= weekMs) usedLast7d++;
    if (s.deprecated) deprecated++;
  }
  return {
    total_skills: index.skills.length,
    total_uses: totalUses,
    used_last_7d: usedLast7d,
    never_used: neverUsed,
    deprecated,
  };
}

function paramError(msg) {
  const e = new Error(msg);
  e.code = -32602;
  return e;
}

export const TOOLS = [
  {
    name: 'skills_overview',
    description: 'Skill index summary: total count, priority buckets, top skills by priority.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max top skills to return (default 10)' } },
    },
  },
  {
    name: 'skill_lookup',
    description: 'Full index entry for one skill by id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Skill id' } },
      required: ['id'],
    },
  },
  {
    name: 'skills_top_used',
    description: 'Skills sorted by usage count (desc), then last-used.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max results (default 10)' } },
    },
  },
  {
    name: 'skill_quality_report',
    description: 'Quality scores for one skill (pass id) or all skills (omit id).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Optional skill id' } },
    },
  },
  {
    name: 'telemetry_summary',
    description: 'Aggregate telemetry: total uses, skills used in last 7 days, never-used, deprecated counts.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ---------------------------------------------------------------------------
// JSON-RPC handler (pure: request object + index -> response object or null)
// ---------------------------------------------------------------------------

export function handleRequest(req, index) {
  const id = req && Object.hasOwn(req, 'id') ? req.id : null;
  const isNotification = req && !Object.hasOwn(req, 'id');
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const replyErr = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  if (!req || typeof req !== 'object' || req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
    return isNotification ? null : replyErr(-32600, 'invalid request');
  }

  switch (req.method) {
    case 'initialize':
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'meta-skills-telemetry', version: PKG.version },
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const name = req.params?.name;
      const args = req.params?.arguments ?? {};
      const call = async () => {
        switch (name) {
          case 'skills_overview': return toolSkillsOverview(index, args);
          case 'skill_lookup': return toolSkillLookup(index, args);
          case 'skills_top_used': return toolSkillsTopUsed(index, args);
          case 'skill_quality_report': return await toolSkillQualityReport(index, args);
          case 'telemetry_summary': return toolTelemetrySummary(index);
          default: throw paramError(`unknown tool: ${name}`);
        }
      };
      return call().then(
        (data) => reply({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }),
        (e) => reply({ content: [{ type: 'text', text: `error: ${e.message}` }], isError: true }),
      );
    }
    default:
      if (isNotification) return null; // notifications/initialized etc.
      return replyErr(-32601, `method not found: ${req.method}`);
  }
}

// ---------------------------------------------------------------------------
// Server runner (newline-delimited JSON-RPC over arbitrary streams)
// ---------------------------------------------------------------------------

export async function startServer({ input = process.stdin, output = process.stdout, indexPath = defaultIndexPath() } = {}) {
  const index = loadIndex(indexPath);
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req;
    try {
      req = JSON.parse(trimmed);
    } catch {
      output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n');
      return;
    }
    const res = await handleRequest(req, index);
    if (res) output.write(JSON.stringify(res) + '\n');
  });
  await new Promise((resolve) => rl.on('close', resolve));
}

export async function cmdMcp(args) {
  let indexPath = defaultIndexPath();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--index' && args[i + 1]) { indexPath = args[++i]; }
  }
  await startServer({ indexPath });
}
