#!/usr/bin/env node

/**
 * meta-skills v0.1.8 — Offline reputation metrics for marketplace
 *
 * Community skill registries (awesome-agent-skills, agentskills.io) have no
 * quality signal: a SKILL.md from an anonymous repo sits next to one from
 * Anthropic. This module ships a static weekly reputation index mapping
 * skills to scores derived from GitHub stars, forks, curated-list inclusion,
 * and known-org signals — all computed OFFLINE so searches never need
 * runtime API calls.
 *
 * Flow:
 *   1. `cmdReputationBuild` merges the bundled baseline (data/reputation-baseline.json)
 *      with any cached marketplace entries and writes
 *      ~/.meta-skills/marketplace/reputation.json
 *   2. `annotateWithReputation` attaches scores to search/list results
 *   3. `filterByReputation` drops skills below a trust threshold
 *
 * Commands (via `meta-skills marketplace reputation <sub>`):
 *   build [--min-score <n>]   Build/refresh the offline reputation index
 *   check <skill-id>          Show reputation breakdown for one skill
 *
 * Inspired by: npm download counts, GitHub stars, awesome-list curation.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const INDEX_SCHEMA = 'meta-skills-reputation-v1';
const REPUTATION_FILE = 'reputation.json';

// ── Bundled baseline ──────────────────────────────────────────────────
// Weekly static snapshot of repo-level signals for well-known skill repos.
// Regenerated offline (stars/forks drift slowly; weekly is plenty).

function defaultBaselinePath() {
  return path.join(__dirname, '..', 'data', 'reputation-baseline.json');
}

function loadBaseline(baselinePath) {
  const file = baselinePath || defaultBaselinePath();
  if (!fs.existsSync(file)) return { repos: {}, orgs: [] };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return { repos: data.repos || {}, orgs: data.orgs || [] };
  } catch {
    return { repos: {}, orgs: [] };
  }
}

// ── Scoring ───────────────────────────────────────────────────────────
//
// Deterministic, offline-only. Signals (additive, capped at 100):
//   stars        log-scaled: 10*log10(stars+1), capped 40
//   forks        5*log10(forks+1), capped 15
//   curated      +20 — listed in a curated awesome-list (human vetting)
//   official     +20 — hosted on officialskills.sh (official team skills)
//   known-org    +15 — owner appears in baseline orgs (anthropics, etc.)
//   github-tree  +5  — entry resolves to a real GitHub repo tree path

function starsScore(stars) {
  if (!stars || stars < 0) return 0;
  return Math.min(40, 10 * Math.log10(stars + 1));
}

function forksScore(forks) {
  if (!forks || forks < 0) return 0;
  return Math.min(15, 5 * Math.log10(forks + 1));
}

function computeReputation(entry, baseline) {
  const repos = baseline.repos || {};
  const orgs = new Set((baseline.orgs || []).map(o => o.toLowerCase()));

  // Baseline lookup keys: "owner/repo", then owner, then skill id
  const repoKey = entry.owner && entry.repo
    ? `${entry.owner}/${entry.repo}`.toLowerCase()
    : null;
  const meta = repos[repoKey] || repos[String(entry.owner || '').toLowerCase()] || null;

  const signals = [];
  let score = 0;

  const stars = meta?.stars ?? 0;
  const forks = meta?.forks ?? 0;
  const s1 = starsScore(stars);
  if (s1 > 0) { signals.push(`stars:${stars}`); score += s1; }
  const s2 = forksScore(forks);
  if (s2 > 0) { signals.push(`forks:${forks}`); score += s2; }

  if (entry.source === 'awesome-agent-skills') {
    signals.push('curated-list');
    score += 20;
  }
  if (entry.url && entry.url.includes('officialskills.sh/')) {
    signals.push('official-hosting');
    score += 20;
  }
  if (entry.owner && orgs.has(String(entry.owner).toLowerCase())) {
    signals.push('known-org');
    score += 15;
  }
  if (entry.url && /github\.com\/[^/]+\/[^/]+\/tree\//.test(entry.url)) {
    signals.push('github-tree');
    score += 5;
  }

  const total = Math.min(100, Math.round(score));
  return {
    score: total,
    tier: tierFor(total, !!meta),
    signals,
    stars,
    forks,
    rated: signals.length > 0,
  };
}

function tierFor(score, hasBaseline) {
  if (score >= 60) return 'trusted';
  if (score >= 30) return 'community';
  if (hasBaseline || score > 0) return 'unproven';
  return 'unrated';
}

// ── Index build / load ────────────────────────────────────────────────

function buildReputationIndex(entries, baseline) {
  const scores = {};
  for (const entry of entries) {
    if (!entry.id) continue;
    const r = computeReputation(entry, baseline);
    // Keep the highest score if a skill id appears from multiple sources
    if (!scores[entry.id] || r.score > scores[entry.id].score) {
      scores[entry.id] = r;
    }
  }
  return {
    schema: INDEX_SCHEMA,
    generatedAt: new Date().toISOString(),
    skillCount: Object.keys(scores).length,
    scores,
  };
}

function reputationPath(cacheDir) {
  return path.join(cacheDir, REPUTATION_FILE);
}

function writeReputationIndex(cacheDir, index) {
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(reputationPath(cacheDir), JSON.stringify(index, null, 2) + '\n', 'utf-8');
}

function loadReputationIndex(cacheDir) {
  const file = reputationPath(cacheDir);
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (data && data.scores) return data;
    return null;
  } catch {
    return null;
  }
}

// ── Annotate / filter ─────────────────────────────────────────────────

function annotateWithReputation(entries, index) {
  if (!index || !index.scores) return entries;
  return entries.map(e => {
    const r = index.scores[e.id];
    return r ? { ...e, reputation: r } : { ...e, reputation: { score: 0, tier: 'unrated', signals: [], stars: 0, forks: 0, rated: false } };
  });
}

function filterByReputation(entries, index, { minScore = 0, includeUnrated = true } = {}) {
  return entries.filter(e => {
    const r = e.reputation || index?.scores?.[e.id];
    if (!r || !r.rated) return includeUnrated;
    return r.score >= minScore;
  });
}

// ── CLI commands ──────────────────────────────────────────────────────

function cmdReputationBuild(args, { cacheDir, loadAllEntries } = {}) {
  const opts = parseReputationArgs(args);
  const baseline = loadBaseline(opts.baseline);
  const entries = typeof loadAllEntries === 'function' ? loadAllEntries() : [];

  const index = buildReputationIndex(entries, baseline);
  writeReputationIndex(cacheDir, index);

  const tiers = { trusted: 0, community: 0, unproven: 0, unrated: 0 };
  for (const r of Object.values(index.scores)) tiers[r.tier]++;

  console.log(`  ✓ reputation index built: ${index.skillCount} skills`);
  console.log(`    trusted: ${tiers.trusted}  community: ${tiers.community}  unproven: ${tiers.unproven}  unrated: ${tiers.unrated}`);
  console.log(`    written to ${reputationPath(cacheDir)}`);
  if (opts.minScore > 0) {
    const kept = Object.values(index.scores).filter(r => r.rated && r.score >= opts.minScore).length;
    console.log(`    ${kept} skills pass --min-score ${opts.minScore}`);
  }
  return index;
}

function cmdReputationCheck(args, { cacheDir, baselinePath } = {}) {
  const skillId = args.find(a => !a.startsWith('--'));
  if (!skillId) {
    throw new Error('missing skill-id\n    usage: meta-skills marketplace reputation check <skill-id>');
  }
  const index = loadReputationIndex(cacheDir);
  if (!index) {
    throw new Error('no reputation index found\n    run `meta-skills marketplace reputation build` first');
  }
  const r = index.scores[skillId];
  if (!r) {
    console.log(`  ${skillId}: unrated (not in index)`);
    return null;
  }
  console.log(`  ${skillId}: ${r.score}/100 [${r.tier}]`);
  console.log(`    stars: ${r.stars}  forks: ${r.forks}`);
  console.log(`    signals: ${r.signals.length ? r.signals.join(', ') : '(none)'}`);
  return r;
}

function parseReputationArgs(argv) {
  const opts = { minScore: 0, baseline: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--min-score' && i + 1 < argv.length) { opts.minScore = Number(argv[++i]) || 0; continue; }
    if (a === '--baseline' && i + 1 < argv.length) { opts.baseline = argv[++i]; continue; }
  }
  return opts;
}

// ── Exports ───────────────────────────────────────────────────────────

export {
  computeReputation,
  buildReputationIndex,
  loadBaseline,
  loadReputationIndex,
  writeReputationIndex,
  annotateWithReputation,
  filterByReputation,
  reputationPath,
  cmdReputationBuild,
  cmdReputationCheck,
  starsScore,
  forksScore,
  INDEX_SCHEMA,
};
