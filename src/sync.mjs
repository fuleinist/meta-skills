#!/usr/bin/env node

/**
 * meta-skills v1.1 Ã¢â‚¬â€ Cross-Agent Sync
 *
 * Share usage patterns and skill metadata across multiple AI agents
 * (Claude Code, Cursor, OpenClaw, Gemini CLI, etc.) via a shared
 * ~/.meta-skills/sync/ directory.
 *
 * Each agent writes its own events to a per-agent JSONL file.
 * A sync pulls from all agents, merges usage data into global.json.
 *
 * Commands:
 *   push [--sync-dir <path>]        Push local usage logs Ã¢â€ â€™ shared sync store
 *   pull [--sync-dir <path>] [--global-json <path>] [--out <path>]
 *                                   Pull from sync store Ã¢â€ â€™ update global.json
 *   sync  [--sync-dir <path>]      Push then pull
 *   status [--sync-dir <path>]     Show per-agent contribution summary
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// Ã¢â€â‚¬Ã¢â€â‚¬ Agent detection Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

const AGENT_ENV_VARS = {
  claude:    ['CLAUDE_API_KEY', 'CLAUDE_INTEGRATION_KEY'],
  cursor:    ['CURSOR_API_KEY', 'CURSOR_DISTINCT_ID'],
  openclaw:  ['OPENCLAW_CONFIG_DIR', 'OPENCLAW_SESSION_ID'],
  gemini:    ['GEMINI_API_KEY', 'CLOUDSDK_CORE_PROJECT'],
  codex:     ['OPENAI_API_KEY', 'CODEX_API_KEY'],
  hermes:    ['HERMES_API_KEY', 'HERMES_CONFIG'],
  opencode:  ['OPENCODE_API_KEY'],
  windsurf:  ['WINDSURF_API_KEY'],
};

const AGENT_ALIASES = {
  'claude-code':  'claude',
  'claude_code':  'claude',
  'cursor':       'cursor',
  'openclaw':     'openclaw',
  'gemini-cli':   'gemini',
  'gemini_cli':   'gemini',
  'codex-cli':    'codex',
  'codex':        'codex',
  'hermes':       'hermes',
  'opencode':     'opencode',
  'windsurf':     'windsurf',
  'cline':        'cline',
  'roo':          'roo',
};

function detectAgent() {
  // Explicit override takes priority
  if (process.env.META_SKILLS_AGENT) {
    const alias = AGENT_ALIASES[process.env.META_SKILLS_AGENT.toLowerCase()];
    return alias || process.env.META_SKILLS_AGENT.toLowerCase();
  }

  // Check environment variables for each agent
  for (const [agent, vars] of Object.entries(AGENT_ENV_VARS)) {
    for (const v of vars) {
      if (process.env[v]) return agent;
    }
  }

  // Heuristic: check process title or argv
  const argv0 = process.argv[0] || '';
  const argv1 = process.argv[1] || '';
  const combined = (argv0 + ' ' + argv1).toLowerCase();

  for (const [alias, agent] of Object.entries(AGENT_ALIASES)) {
    if (combined.includes(alias.replace('_', '-'))) return agent;
  }

  return 'unknown';
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Default paths Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

function defaultSyncDir() {
  return path.join(os.homedir(), '.meta-skills', 'sync');
}

function defaultGlobalJson() {
  return path.join(os.homedir(), '.meta-skills', 'global.json');
}

function defaultLogDir() {
  return path.join(os.homedir(), '.meta-skills', 'logs');
}

function agentSyncPath(syncDir, agent) {
  return path.join(syncDir, agent, 'events.jsonl');
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Push: merge local logs into shared sync store Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

function cmdPush(options) {
  const syncDir = options.syncDir || defaultSyncDir();
  const logDir = options.logDir || defaultLogDir();
  const agent = detectAgent();
  const agentFile = agentSyncPath(syncDir, agent);

  // Ensure agent subdir exists
  const agentDir = path.dirname(agentFile);
  if (!fs.existsSync(agentDir)) {
    fs.mkdirSync(agentDir, { recursive: true });
  }

  // Read today's local log
  const today = new Date().toISOString().slice(0, 10);
  const localLog = path.join(logDir, `${today}.jsonl`);

  if (!fs.existsSync(localLog)) {
    console.log(`  no local events to push (${localLog} not found)`);
    return;
  }

  const content = fs.readFileSync(localLog, 'utf-8');
  const lines = content.trim().split('\n').filter(Boolean);

  if (lines.length === 0) {
    console.log('  no local events to push');
    return;
  }

  // Read existing remote events, filter out any that already exist locally
  // (dedup by timestamp + skill)
  let remoteEvents = [];
  if (fs.existsSync(agentFile)) {
    const remote = fs.readFileSync(agentFile, 'utf-8');
    remoteEvents = remote.trim().split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  }

  const remoteKeys = new Set(remoteEvents.map(e => `${e.timestamp}:${e.skill}`));

  let pushed = 0;
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      const key = `${event.timestamp}:${event.skill}`;
      if (!remoteKeys.has(key)) {
        fs.appendFileSync(agentFile, line + '\n', 'utf-8');
        remoteKeys.add(key);
        pushed++;
      }
    } catch {
      // skip malformed lines
    }
  }

  console.log(`Ã¢Å“â€œ pushed ${pushed} events to ${agentFile}`);
  console.log(`  agent: ${agent}`);
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Pull: merge all agents' events into global.json Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

function cmdPull(options) {
  const syncDir = options.syncDir || defaultSyncDir();
  const globalJsonPath = options.globalJson || defaultGlobalJson();
  const outPath = options.out || globalJsonPath;

  // Read existing global.json
  let index;
  try {
    index = JSON.parse(fs.readFileSync(globalJsonPath, 'utf-8'));
  } catch {
    console.error(`Ã¢Å“â€” cannot read ${globalJsonPath} Ã¢â‚¬â€ run \`meta-skills init --global\` first`);
    process.exit(1);
  }

  // Collect all events from all agents
  const allEvents = []; // { agent, skill, timestamp, outcome }
  if (!fs.existsSync(syncDir)) {
    console.log('  sync directory empty Ã¢â‚¬â€ nothing to pull');
  } else {
    let agentDirs;
    try {
      agentDirs = fs.readdirSync(syncDir, { withFileTypes: true });
    } catch {
      agentDirs = [];
    }

    for (const dirent of agentDirs) {
      if (!dirent.isDirectory()) continue;
      const agentName = dirent.name;
      const agentFile = path.join(syncDir, agentName, 'events.jsonl');
      if (!fs.existsSync(agentFile)) continue;

      const content = fs.readFileSync(agentFile, 'utf-8');
      for (const line of content.trim().split('\n').filter(Boolean)) {
        try {
          const event = JSON.parse(line);
          allEvents.push({ agent: agentName, ...event });
        } catch {
          // skip malformed lines
        }
      }
    }
  }

  if (allEvents.length === 0) {
    console.log('  no remote events to pull');
    return;
  }

  // Aggregate per skill: count + latest timestamp per agent
  const skillUsage = {}; // skillId -> { total: 0, lastTimestamp: null, agents: Set }
  for (const ev of allEvents) {
    if (!skillUsage[ev.skill]) {
      skillUsage[ev.skill] = { total: 0, lastTimestamp: null, agents: new Set() };
    }
    skillUsage[ev.skill].total++;
    skillUsage[ev.skill].agents.add(ev.agent);
    if (!skillUsage[ev.skill].lastTimestamp || ev.timestamp > skillUsage[ev.skill].lastTimestamp) {
      skillUsage[ev.skill].lastTimestamp = ev.timestamp;
    }
  }

  // Merge into skills array
  let updatedCount = 0;
  for (const skill of index.skills) {
    const u = skillUsage[skill.id];
    if (u) {
      // Add agents that have used this skill
      if (!skill.last_agents) skill.last_agents = [];
      for (const agent of u.agents) {
        if (!skill.last_agents.includes(agent)) {
          skill.last_agents.push(agent);
        }
      }
      // Update counts and timestamp
      skill.usage_count = (skill.usage_count || 0) + u.total;
      if (u.lastTimestamp && (!skill.last_used || u.lastTimestamp > skill.last_used)) {
        skill.last_used = u.lastTimestamp;
      }
      // Track last_synced_agent
      const lastEvent = allEvents
        .filter(e => e.skill === skill.id)
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
      if (lastEvent) {
        skill.last_synced_agent = lastEvent.agent;
      }
      updatedCount++;
    }
  }

  index.generated = new Date().toISOString();
  index._sync = {
    synced_at: new Date().toISOString(),
    agents_count: new Set(allEvents.map(e => e.agent)).size,
    events_pulled: allEvents.length,
  };

  fs.writeFileSync(outPath, JSON.stringify(index, null, 2) + '\n', 'utf-8');

  const agents = [...new Set(allEvents.map(e => e.agent))];
  console.log(`Ã¢Å“â€œ pulled ${allEvents.length} events from ${agents.length} agent(s): ${agents.join(', ')}`);
  console.log(`  ${updatedCount} skills updated in ${outPath}`);
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Sync: push then pull Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

function cmdSync(options) {
  console.log('--- push ---');
  cmdPush(options);
  console.log('--- pull ---');
  cmdPull(options);
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Status: show per-agent contribution summary Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

function cmdStatus(options) {
  const syncDir = options.syncDir || defaultSyncDir();

  if (!fs.existsSync(syncDir)) {
    console.log('meta-skills sync: no sync directory found');
    return;
  }

  const agentStats = [];
  let totalEvents = 0;

  let agentDirs;
  try {
    agentDirs = fs.readdirSync(syncDir, { withFileTypes: true });
  } catch {
    agentDirs = [];
  }

  for (const dirent of agentDirs) {
    if (!dirent.isDirectory()) continue;
    const agentName = dirent.name;
    const agentFile = path.join(syncDir, agentName, 'events.jsonl');
    if (!fs.existsSync(agentFile)) continue;

    const content = fs.readFileSync(agentFile, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    const events = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

    const skillCounts = {};
    for (const ev of events) {
      skillCounts[ev.skill] = (skillCounts[ev.skill] || 0) + 1;
    }

    const lastEvent = events.sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];

    agentStats.push({
      agent: agentName,
      count: events.length,
      skillCount: Object.keys(skillCounts).length,
      lastTimestamp: lastEvent?.timestamp || null,
    });
    totalEvents += events.length;
  }

  if (agentStats.length === 0) {
    console.log('meta-skills sync: no events found');
    return;
  }

  agentStats.sort((a, b) => b.count - a.count);

  const agent = detectAgent();
  console.log(`meta-skills sync Ã¢â‚¬â€ current agent: ${agent}`);
  console.log(`  Total events: ${totalEvents} across ${agentStats.length} agent(s)`);
  console.log('');
  for (const s of agentStats) {
    const marker = s.agent === agent ? ' Ã¢â€ Â you' : '';
    const ts = s.lastTimestamp ? ` (last: ${s.lastTimestamp.slice(0, 16)})` : '';
    console.log(`  ${s.agent}: ${s.count} events, ${s.skillCount} skills${ts}${marker}`);
  }
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Main Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(`Usage:
  meta-skills sync push   [--sync-dir <path>] [--log-dir <path>]
  meta-skills sync pull   [--sync-dir <path>] [--global-json <path>] [--out <path>]
  meta-skills sync         [--sync-dir <path>] [--log-dir <path>] [--global-json <path>] [--out <path>]
  meta-skills sync status  [--sync-dir <path>]
  meta-skills sync --help`);
    process.exit(0);
  }

  const options = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--sync-dir' && i + 1 < args.length) options.syncDir = path.resolve(args[++i]);
    else if (args[i] === '--log-dir' && i + 1 < args.length) options.logDir = path.resolve(args[++i]);
    else if (args[i] === '--global-json' && i + 1 < args.length) options.globalJson = path.resolve(args[++i]);
    else if (args[i] === '--out' && i + 1 < args.length) options.out = path.resolve(args[++i]);
    else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`meta-skills sync Ã¢â‚¬â€ Cross-agent usage sync`);
      console.log('');
      console.log('Usage:');
      console.log('  sync push   [--sync-dir <path>] [--log-dir <path>]');
      console.log('  sync pull   [--sync-dir <path>] [--global-json <path>] [--out <path>]');
      console.log('  sync         (push + pull)');
      console.log('  sync status [--sync-dir <path>]');
      process.exit(0);
    }
  }

  const subcommand = args[0];

  switch (subcommand) {
    case 'push':
      cmdPush(options);
      break;
    case 'pull':
      cmdPull(options);
      break;
    case 'sync':
      cmdSync(options);
      break;
    case 'status':
      cmdStatus(options);
      break;
    default:
      // Treat as sync (push + pull) if unknown
      cmdSync(options);
  }
}

const isMain = process.argv[1] && (process.argv[1] === fileURLToPath(import.meta.url) || process.argv[1].endsWith('sync.mjs'));
if (isMain) main();

export { detectAgent, cmdPush, cmdPull, cmdSync, cmdStatus, main, defaultSyncDir, agentSyncPath };
