#!/usr/bin/env node

/**
 * meta-skills v1.2 — Skill Marketplace Integration
 *
 * Query community skill registries (awesome-agent-skills, agentskills.io)
 * directly from the CLI. Discover skills by query string, install them
 * to a local skills directory, and optionally register them in global.json.
 *
 * Commands:
 *   search <query> [--source <name>] [--limit <n>] [--refresh] [--json]
 *                                   Search the marketplace(s) for skills
 *                                   matching a query string.
 *   install <skill-id> [--target <dir>] [--no-register]
 *                                   Fetch SKILL.md from the source repo and
 *                                   write it to the local skills directory.
 *   list [--source <name>] [--limit <n>] [--json]
 *                                   List all known marketplace skills.
 *   refresh                          Force re-fetch of all marketplace caches.
 *
 * Inspired by:
 *   - VoltAgent/awesome-agent-skills (1497+ curated skills)
 *   - agentskills.io (the SKILL.md spec hub)
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Registry sources ──────────────────────────────────────────────────

const SOURCES = {
  'awesome-agent-skills': {
    name: 'awesome-agent-skills',
    label: 'Awesome Agent Skills (VoltAgent)',
    url: 'https://raw.githubusercontent.com/VoltAgent/awesome-agent-skills/main/README.md',
    cacheFile: 'awesome-agent-skills.json',
    type: 'awesome-list',
  },
  'agentskills-io': {
    name: 'agentskills-io',
    label: 'AgentSkills.io Index',
    url: 'https://agentskills.io/llms.txt',
    cacheFile: 'agentskills-io.json',
    type: 'llms-txt',
  },
};

// ── Default paths ─────────────────────────────────────────────────────

function defaultCacheDir() {
  return path.join(os.homedir(), '.meta-skills', 'marketplace');
}

function defaultInstallDir() {
  // Default to the OpenClaw skills dir (XDG-aware would be nicer, kept simple)
  return path.join(os.homedir(), '.meta-skills', 'installed');
}

function defaultGlobalJson() {
  return path.join(os.homedir(), '.meta-skills', 'global.json');
}

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── HTTP fetch with timeout (Node 18+ has global fetch) ───────────────

async function httpGet(url, { timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ── Cache management ──────────────────────────────────────────────────

function ensureCacheDir(cacheDir) {
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
  return cacheDir;
}

function cachePath(cacheDir, source) {
  return path.join(ensureCacheDir(cacheDir), SOURCES[source].cacheFile);
}

function isCacheFresh(cacheFile) {
  if (!fs.existsSync(cacheFile)) return false;
  const stat = fs.statSync(cacheFile);
  return (Date.now() - stat.mtimeMs) < CACHE_TTL_MS;
}

function readCache(cacheFile) {
  if (!fs.existsSync(cacheFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
  } catch {
    return null;
  }
}

function writeCache(cacheFile, data) {
  ensureCacheDir(path.dirname(cacheFile));
  fs.writeFileSync(cacheFile, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

// ── Parsing: awesome-agent-skills README ──────────────────────────────
//
// Format inside <details><summary><h3>Section</h3></summary>...</details>:
//   - **[owner/repo](https://officialskills.sh/owner/skills/slug)** - Description
//   - **[owner/repo](https://github.com/owner/repo)** - Description
//   - **[owner/repo](https://github.com/owner/repo/tree/main/skills/slug)** - Description

function parseAwesomeList(markdown, { source = 'awesome-agent-skills' } = {}) {
  const skills = [];

  // Split by sections: track current section heading
  const sectionRe = /<summary><h3[^>]*>(.*?)<\/h3>/g;
  const sections = [];
  let m;
  while ((m = sectionRe.exec(markdown)) !== null) {
    sections.push({ title: stripTags(m[1]).trim(), start: m.index });
  }
  // Also detect "## " style top-level headings for sections that aren't wrapped
  const topHeadingRe = /^## (.+)$/gm;
  while ((m = topHeadingRe.exec(markdown)) !== null) {
    const t = m[1].trim();
    if (/^(Skills|Quality|License|Sponsor|Contribut|Path)/i.test(t)) continue;
    sections.push({ title: t, start: m.index });
  }

  // Assign section to each skill entry by index
  const entryRe = /^\s*-\s+\*\*\[([^\]]+)\]\(([^)]+)\)\*\*\s*[-–—]\s*(.+?)\s*$/gm;
  while ((m = entryRe.exec(markdown)) !== null) {
    const [, nameWithSlash, url, description] = m;
    const slashIdx = nameWithSlash.indexOf('/');
    if (slashIdx < 0) continue;
    const owner = nameWithSlash.slice(0, slashIdx);
    const repoAndSkill = nameWithSlash.slice(slashIdx + 1);

    // Find enclosing section: last section whose start is <= m.index
    let section = 'Other';
    for (const s of sections) {
      if (s.start <= m.index) section = s.title;
      else break;
    }

    // Derive id: prefer last path segment of URL if it looks like a skill slug
    const urlPath = url.split('?')[0].split('#')[0];
    const urlParts = urlPath.split('/').filter(Boolean);
    let id;
    let installPath = null;
    let rawUrl = null;

    if (url.includes('officialskills.sh/')) {
      // https://officialskills.sh/{owner}/skills/{slug}
      const slug = urlParts[urlParts.length - 1];
      id = slug;
      installPath = `skills/${slug}/SKILL.md`;
      rawUrl = `https://raw.githubusercontent.com/${owner}/skills/main/${installPath}`;
    } else if (url.includes('github.com/')) {
      // Could be repo root, tree, or blob
      // patterns: /owner/repo, /owner/repo/tree/branch, /owner/repo/blob/branch/path
      const ghMatch = url.match(/github\.com\/([^/]+)\/([^/]+)(?:\/(tree|blob)\/([^/]+)\/(.+))?/);
      if (ghMatch) {
        const [, ghOwner, ghRepo, , branch, subPath] = ghMatch;
        // Use the last path segment as the id, with owner prefix for uniqueness
        const last = urlParts[urlParts.length - 1];
        id = `${owner}-${last}`.toLowerCase();
        if (subPath) {
          installPath = `${subPath}/SKILL.md`;
        } else {
          // Repo root — assume a top-level skills/<id>/SKILL.md layout is unlikely;
          // leave installPath null and let install fail gracefully.
          installPath = null;
        }
        const br = branch || 'main';
        if (installPath) {
          rawUrl = `https://raw.githubusercontent.com/${ghOwner}/${ghRepo}/${br}/${installPath}`;
        }
      }
    } else if (/^https?:\/\//.test(url)) {
      // Other URLs (e.g., direct SKILL.md hosting like paulo.com.br)
      const slug = urlParts[urlParts.length - 2] || urlParts[urlParts.length - 1] || nameWithSlash;
      id = `${owner}-${slug}`.toLowerCase();
      // Direct SKILL.md URL: derive a rawUrl from the URL if it ends in SKILL.md
      if (url.endsWith('/SKILL.md')) rawUrl = url;
    }

    if (!id) continue;

    skills.push({
      id,
      name: humanize(repoAndSkill),
      owner,
      repo: repoAndSkill,
      description: description.trim(),
      url,
      section,
      source,
      installPath,
      rawUrl,
    });
  }

  return skills;
}

function stripTags(s) {
  return s.replace(/<[^>]+>/g, '');
}

function humanize(slug) {
  return slug
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

// ── Parsing: agentskills.io llms.txt ───────────────────────────────────

function parseAgentskillsIndex(text, { source = 'agentskills-io' } = {}) {
  const skills = [];
  // Format varies; try common shapes:
  //   ## Skill Name
  //   Description...
  //   URL: https://...
  // or:
  //   - [Skill Name](https://url) - Description
  const lines = text.split('\n');
  let current = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const heading = line.match(/^#{1,3}\s+(.+)$/);
    if (heading) {
      if (current && current.url) skills.push(finalizeAgentskills(current, source));
      current = { name: stripTags(heading[1]).trim(), description: '', url: null };
      continue;
    }

    const linkMatch = line.match(/^\s*-\s+\[([^\]]+)\]\(([^)]+)\)(?:\s*[-–—]\s*(.+))?/);
    if (linkMatch) {
      if (current && current.url) skills.push(finalizeAgentskills(current, source));
      current = {
        name: linkMatch[1].trim(),
        description: (linkMatch[3] || '').trim(),
        url: linkMatch[2].trim(),
      };
      continue;
    }

    const urlMatch = line.match(/^(?:URL|Link|Homepage):\s*(\S+)/i);
    if (urlMatch && current) {
      current.url = urlMatch[1];
      continue;
    }

    if (current && !line.startsWith('>')) {
      current.description = current.description
        ? `${current.description} ${line}`
        : line;
    }
  }
  if (current && current.url) skills.push(finalizeAgentskills(current, source));
  return skills;
}

function finalizeAgentskills(entry, source) {
  const owner = (() => {
    try {
      const u = new URL(entry.url);
      return u.hostname.replace(/^www\./, '');
    } catch {
      return 'unknown';
    }
  })();
  const id = slugify(`${owner}-${entry.name}`);
  return {
    id,
    name: entry.name,
    owner,
    repo: '',
    description: entry.description,
    url: entry.url,
    section: 'agentskills.io',
    source,
    installPath: null,
    rawUrl: null,
  };
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ── Search / rank / dedupe ────────────────────────────────────────────

function tokenize(s) {
  return s.toLowerCase().match(/[a-z0-9]+/g) || [];
}

function scoreEntry(entry, queryTokens) {
  if (queryTokens.length === 0) return 0;
  const haystack = [
    entry.id,
    entry.name,
    entry.owner,
    entry.repo,
    entry.description,
    entry.section,
  ].join(' ').toLowerCase();
  const hayTokens = new Set(tokenize(haystack));

  let score = 0;
  for (const qt of queryTokens) {
    if (hayTokens.has(qt)) {
      score += 2;
      // Bonus for matching in name
      if (entry.name.toLowerCase().includes(qt)) score += 3;
      if (entry.id.toLowerCase().includes(qt)) score += 2;
      if (entry.description.toLowerCase().includes(qt)) score += 1;
    } else if (haystack.includes(qt)) {
      score += 1;
    }
  }
  return score;
}

function searchEntries(entries, query, { limit = 20 } = {}) {
  const tokens = tokenize(query || '');
  const scored = entries.map(e => ({ entry: e, score: scoreEntry(e, tokens) }));
  // Drop zero-score entries only if we have a query
  const filtered = tokens.length === 0
    ? scored
    : scored.filter(s => s.score > 0);
  filtered.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.entry.id.localeCompare(b.entry.id);
  });
  return filtered.slice(0, limit).map(s => s.entry);
}

function dedupeEntries(entries) {
  // Prefer awesome-agent-skills over agentskills.io for the same id
  const sourceRank = { 'awesome-agent-skills': 0, 'agentskills-io': 1 };
  const map = new Map();
  for (const e of entries) {
    const existing = map.get(e.id);
    if (!existing) {
      map.set(e.id, e);
    } else {
      const existingRank = sourceRank[existing.source] ?? 99;
      const newRank = sourceRank[e.source] ?? 99;
      if (newRank < existingRank) map.set(e.id, e);
    }
  }
  return [...map.values()];
}

// ── Source loading (with cache) ────────────────────────────────────────

async function loadSource(sourceName, { cacheDir, refresh = false } = {}) {
  const src = SOURCES[sourceName];
  if (!src) throw new Error(`unknown source: ${sourceName}`);

  const dir = cacheDir || defaultCacheDir();
  const file = cachePath(dir, sourceName);

  if (!refresh && isCacheFresh(file)) {
    const cached = readCache(file);
    if (cached && Array.isArray(cached.entries)) return cached.entries;
  }

  let entries;
  try {
    const text = await httpGet(src.url);
    if (src.type === 'awesome-list') entries = parseAwesomeList(text, { source: sourceName });
    else if (src.type === 'llms-txt') entries = parseAgentskillsIndex(text, { source: sourceName });
    else entries = [];
    writeCache(file, { fetchedAt: new Date().toISOString(), source: sourceName, entries });
    return entries;
  } catch (e) {
    // Network failed — try stale cache as a fallback
    const cached = readCache(file);
    if (cached && Array.isArray(cached.entries)) {
      console.error(`  ! using stale cache for ${sourceName} (${e.message})`);
      return cached.entries;
    }
    throw new Error(`failed to load ${sourceName} and no cache: ${e.message}`);
  }
}

async function loadAllSources(options = {}) {
  const allEntries = [];
  for (const name of Object.keys(SOURCES)) {
    try {
      const entries = await loadSource(name, options);
      allEntries.push(...entries);
    } catch (e) {
      console.error(`  ! ${e.message}`);
    }
  }
  return allEntries;
}

// ── Install: fetch SKILL.md and write to local skills dir ─────────────

function deriveInstallUrl(entry) {
  if (entry.rawUrl) return entry.rawUrl;
  if (entry.installPath && entry.owner && entry.repo) {
    return `https://raw.githubusercontent.com/${entry.owner}/${entry.repo}/main/${entry.installPath}`;
  }
  return null;
}

async function cmdInstall(args) {
  const options = parseInstallArgs(args);

  // Look up the skill in the marketplace (use cache if available)
  const all = await loadAllSources({ cacheDir: options.cacheDir });
  const dedup = dedupeEntries(all);
  const entry = dedup.find(e => e.id === options.skillId);

  if (!entry) {
    throw new Error(`skill not found in marketplace: ${options.skillId}\n    run \`meta-skills search <query>\` to discover skills`);
  }

  const rawUrl = deriveInstallUrl(entry);
  if (!rawUrl) {
    throw new Error(`no install URL available for ${options.skillId} (source: ${entry.url})`);
  }

  // Ensure target dir exists
  if (!fs.existsSync(options.target)) fs.mkdirSync(options.target, { recursive: true });
  const skillDir = path.join(options.target, entry.id);
  if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true });

  const outFile = path.join(skillDir, 'SKILL.md');

  let text;
  try {
    text = await httpGet(rawUrl);
  } catch (e) {
    throw new Error(`failed to fetch ${rawUrl}: ${e.message}`);
  }

  if (!text || !text.trim()) {
    throw new Error(`empty response from ${rawUrl}`);
  }

  fs.writeFileSync(outFile, text, 'utf-8');
  console.log(`  ✓ installed ${entry.id} -> ${outFile}`);

  if (options.register) {
    registerInGlobal(entry, outFile, options.globalJson);
  } else {
    console.log(`  (skipped global.json registration)`);
  }
}

function registerInGlobal(entry, installedPath, globalJsonPath) {
  if (!fs.existsSync(globalJsonPath)) {
    console.log(`  ! global.json not found at ${globalJsonPath}, skipping registration`);
    console.log(`    run \`meta-skills init --global\` first to enable registration`);
    return;
  }
  let index;
  try {
    index = JSON.parse(fs.readFileSync(globalJsonPath, 'utf-8'));
  } catch (e) {
    console.log(`  ! cannot parse global.json: ${e.message}, skipping registration`);
    return;
  }

  const whenHint = entry.description
    ? `marketplace: ${entry.description.slice(0, 80)}`
    : `marketplace: ${entry.id}`;
  const newSkill = {
    id: entry.id,
    when: whenHint,
    why: `Installed from ${entry.source} (${entry.url})`,
    path: installedPath,
    priority: 'low',
    usage_count: 0,
    last_used: null,
    source: 'marketplace',
    marketplace_url: entry.url,
  };

  // Upsert: replace if same id exists
  const existingIdx = index.skills.findIndex(s => s.id === entry.id);
  if (existingIdx >= 0) {
    index.skills[existingIdx] = { ...index.skills[existingIdx], ...newSkill };
    console.log(`  ✓ updated ${entry.id} in global.json`);
  } else {
    index.skills.push(newSkill);
    console.log(`  ✓ registered ${entry.id} in global.json`);
  }

  fs.writeFileSync(globalJsonPath, JSON.stringify(index, null, 2) + '\n', 'utf-8');
}

// ── Search / list CLI wrappers ─────────────────────────────────────────

async function cmdSearch(args) {
  const options = parseArgs(args, {
    source: null,        // null = all sources
    limit: 20,
    refresh: false,
    json: false,
    cacheDir: null,
  });

  if (!options.query) {
    throw new Error('missing query string\n    usage: meta-skills search <query> [--source <name>] [--limit <n>] [--json]');
  }

  let entries;
  if (options.source) {
    entries = await loadSource(options.source, { cacheDir: options.cacheDir, refresh: options.refresh });
  } else {
    if (options.refresh) {
      // Force refresh on all sources
      entries = [];
      for (const name of Object.keys(SOURCES)) {
        const loaded = await loadSource(name, { cacheDir: options.cacheDir, refresh: true });
        entries.push(...loaded);
      }
    } else {
      entries = await loadAllSources({ cacheDir: options.cacheDir });
    }
  }

  const dedup = dedupeEntries(entries);
  const results = searchEntries(dedup, options.query, { limit: options.limit });

  if (options.json) {
    console.log(JSON.stringify({
      query: options.query,
      source: options.source || 'all',
      totalMarketplaceSkills: dedup.length,
      resultCount: results.length,
      results,
    }, null, 2));
    return;
  }

  if (results.length === 0) {
    console.log(`  no marketplace skills match "${options.query}"`);
    return;
  }

  console.log(`  ${results.length} marketplace skill(s) match "${options.query}":\n`);
  for (const r of results) {
    const desc = r.description.length > 80 ? r.description.slice(0, 77) + '...' : r.description;
    console.log(`  - ${r.id}`);
    console.log(`    ${desc}`);
    console.log(`    [${r.source}] ${r.url}`);
  }
}

async function cmdList(args) {
  const options = parseArgs(args, {
    source: null,
    limit: 100,
    json: false,
    cacheDir: null,
  });

  let entries;
  if (options.source) {
    entries = await loadSource(options.source, { cacheDir: options.cacheDir });
  } else {
    entries = await loadAllSources({ cacheDir: options.cacheDir });
  }
  const dedup = dedupeEntries(entries);
  const results = dedup.slice(0, options.limit);

  if (options.json) {
    console.log(JSON.stringify({ count: results.length, skills: results }, null, 2));
    return;
  }

  console.log(`  ${results.length} marketplace skill(s):\n`);
  for (const r of results) {
    console.log(`  - ${r.id}  [${r.source}]  ${r.section}`);
  }
}

async function cmdRefresh(args) {
  const options = parseArgs(args, { cacheDir: null });
  for (const name of Object.keys(SOURCES)) {
    const before = readCache(cachePath(options.cacheDir || defaultCacheDir(), name));
    const count = before?.entries?.length || 0;
    try {
      const entries = await loadSource(name, { cacheDir: options.cacheDir, refresh: true });
      console.log(`  ✓ ${name}: ${entries.length} skills (was ${count})`);
    } catch (e) {
      console.error(`  ! ${name}: ${e.message}`);
    }
  }
}

// ── Tiny CLI arg parser (--flag value | --flag | positional) ──────────

function parseArgs(argv, defaults = {}) {
  const opts = { ...defaults };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--refresh') { opts.refresh = true; continue; }
    if (a === '--no-register') { opts.register = false; continue; }
    if (a === '--dry-run') { opts.dryRun = true; continue; }

    if (a.startsWith('--') && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      const key = camelize(a.slice(2));
      opts[key] = argv[++i];
      continue;
    }
    if (a.startsWith('--')) {
      // boolean flag with no value
      opts[camelize(a.slice(2))] = true;
      continue;
    }
    // Positional: first non-flag is query / skillId
    if (!opts.query) opts.query = a;
    else if (!opts.skillId) opts.skillId = a;
  }
  return opts;
}

function parseInstallArgs(argv) {
  // For install, the first positional is the skill-id, not a query.
  const opts = {
    target: defaultInstallDir(),
    register: true,
    globalJson: defaultGlobalJson(),
    cacheDir: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-register') { opts.register = false; continue; }
    if (a === '--dry-run') { opts.dryRun = true; continue; }
    if (a.startsWith('--') && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      const key = camelize(a.slice(2));
      opts[key] = argv[++i];
      continue;
    }
    if (!opts.skillId) opts.skillId = a;
  }
  if (!opts.skillId) {
    throw new Error('missing skill-id\n    usage: meta-skills install <skill-id> [--target <dir>] [--no-register]');
  }
  return opts;
}

function camelize(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

// ── Main entry (when run directly) ────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const subcommand = args[0];
  const rest = args.slice(1);

  try {
    switch (subcommand) {
      case 'search':  await cmdSearch(rest); break;
      case 'install': await cmdInstall(rest); break;
      case 'list':    await cmdList(rest); break;
      case 'refresh': await cmdRefresh(rest); break;
      default:
        console.error(`  ! unknown marketplace subcommand: ${subcommand || '(none)'}`);
        console.error('    usage: meta-skills marketplace <search|install|list|refresh> [args]');
        process.exit(1);
    }
  } catch (e) {
    console.error(`  ! ${e.message}`);
    process.exit(1);
  }
}

// Detect "run directly" (not imported) via import.meta.url comparison
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main();
}

// ── Exports for CLI integration ───────────────────────────────────────

export {
  parseAwesomeList,
  parseAgentskillsIndex,
  searchEntries,
  scoreEntry,
  tokenize,
  dedupeEntries,
  loadSource,
  loadAllSources,
  SOURCES,
  cmdSearch,
  cmdInstall,
  cmdList,
  cmdRefresh,
  defaultCacheDir,
  defaultInstallDir,
};
