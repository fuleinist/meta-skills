#!/usr/bin/env node

/**
 * meta-skills v1.7 — Token Budget Optimizer
 *
 * Estimates per-skill token cost and greedily demotes/archives the lowest
 * value-density skills until the active set fits under a configurable cap.
 *
 * Value density = (priority_weight × (1 + ln(1 + usage_count)) × quality_multiplier) / estimated_tokens
 *
 * Zero external API calls, zero new dependencies, pure heuristic.
 * Inspired by: progressive disclosure research (10-tool accuracy ceiling),
 * Anthropic 150-token meta-skills target, EvoSkill value-density evaluation.
 *
 * Usage (CLI):
 *   node src/budget-optimizer.mjs [--global-json <path>] [--max-tokens 500]
 *                                  [--dry-run] [--json] [--archive]
 *                                  [--use-quality] [--include-skill-md]
 *                                  [--write]
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

/** OpenAI-style chars-per-token heuristic. Conservative. */
export const CHARS_PER_TOKEN = 4;

/** Kept for backwards-compat with prior tests; not used by the estimator
 *  (we now serialize real JSON to get exact cost). */
export const ENTRY_JSON_OVERHEAD_CHARS = 52;

/** Priority weight: how much agent attention a skill gets. */
export const PRIORITY_WEIGHT = {
  high: 3.0,
  medium: 2.0,
  low: 1.0,
};

/** Default quality multiplier when no score available or --use-quality is off. */
export const DEFAULT_QUALITY_MULTIPLIER = 1.0;

/** Quality multiplier clamps (Anthropic guidance: don't zero out a skill). */
export const QUALITY_MULTIPLIER_MIN = 0.1;
export const QUALITY_MULTIPLIER_MAX = 1.5;

/** Default token budget for the active set. */
export const DEFAULT_MAX_TOKENS = 500;

// --------------------------------------------------------------------------
// Token estimation
// --------------------------------------------------------------------------

/**
 * Estimate the token cost of a skill's *index* entry.
 *
 * Index entry = the JSON object the agent reads every turn:
 *   { "id": "...", "when": "...", "why": "...", "path": "...", "priority": "..." }
 *
 * @param {object} entry - skill entry with id, when, why, path, priority
 * @returns {number} estimated tokens (>= 1 for any non-empty entry)
 */
export function estimateIndexTokens(entry) {
  if (!entry || typeof entry !== 'object') return 0;

  // Strip volatile / high-cardinality fields that don't add to the agent's
  // *index* decision (usage_count, last_used — the agent cares about
  // when/why/path/priority, not usage telemetry which is internal).
  const { usage_count, last_used, ...indexOnly } = entry;

  // Empty entry (no indexable fields) = 0 tokens.
  const hasContent =
    indexOnly.id || indexOnly.when || indexOnly.why ||
    indexOnly.path || indexOnly.priority;
  if (!hasContent) return 0;

  // Use real JSON serialization to get exact cost. The 5 fields serialize
  // to ~52 chars of syntax overhead, which the prior constant missed.
  const json = JSON.stringify(indexOnly);
  return Math.max(1, Math.ceil(json.length / CHARS_PER_TOKEN));
}

/**
 * Estimate the full token cost of a skill: index entry + SKILL.md file content.
 *
 * @param {object} entry - skill entry
 * @param {object} [options]
 * @param {boolean} [options.includeSkillMd=false] - if true, add file content cost
 * @returns {number} estimated tokens
 */
export function estimateSkillTokens(entry, { includeSkillMd = false } = {}) {
  const indexTokens = estimateIndexTokens(entry);

  if (!includeSkillMd) return indexTokens;
  if (!entry || typeof entry.path !== 'string' || entry.path.length === 0) {
    return indexTokens;
  }

  // Resolve path: expand ~, then read.
  let resolved = entry.path;
  if (resolved.startsWith('~')) {
    resolved = path.join(os.homedir(), resolved.slice(1));
  }

  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return indexTokens;
    const content = fs.readFileSync(resolved, 'utf8');
    return indexTokens + Math.ceil(content.length / CHARS_PER_TOKEN);
  } catch {
    // File missing or unreadable: index-only
    return indexTokens;
  }
}

/**
 * Sum the index-entry cost of all non-archived skills in an index.
 *
 * @param {object[]} skills
 * @param {object} [options]
 * @param {boolean} [options.includeSkillMd=false]
 * @returns {number} total tokens for the active set
 */
export function totalActiveTokens(skills, options = {}) {
  if (!Array.isArray(skills)) return 0;
  return skills
    .filter((s) => s && s.priority !== 'archived')
    .reduce((sum, s) => sum + estimateSkillTokens(s, options), 0);
}

// --------------------------------------------------------------------------
// Value density
// --------------------------------------------------------------------------

/**
 * Compute value density for a single skill.
 *
 * @param {object} entry
 * @param {object} [options]
 * @param {number} [options.usageCount] - override entry.usage_count
 * @param {number} [options.qualityScore] - 0-100, applies multiplier
 * @returns {number} value_density (0 if no tokens)
 */
export function valueDensity(entry, options = {}) {
  if (!entry || typeof entry !== 'object') return 0;

  const priority = (entry.priority || 'low').toLowerCase();
  const weight = PRIORITY_WEIGHT[priority] != null ? PRIORITY_WEIGHT[priority] : 1.0;

  const usage = options.usageCount != null
    ? options.usageCount
    : (typeof entry.usage_count === 'number' ? entry.usage_count : 0);

  // Log-curve on usage: 0 uses -> 1.0, 10 uses -> ~3.4, 100 uses -> ~5.6
  // Encodes "recent use > cold storage" with diminishing returns.
  const usageFactor = 1 + Math.log1p(Math.max(0, usage));

  let qualityMultiplier = DEFAULT_QUALITY_MULTIPLIER;
  if (typeof options.qualityScore === 'number' && options.qualityScore > 0) {
    const raw = options.qualityScore / 100;
    qualityMultiplier = Math.max(QUALITY_MULTIPLIER_MIN, Math.min(QUALITY_MULTIPLIER_MAX, raw));
  }

  const tokens = estimateIndexTokens(entry);
  if (tokens <= 0) return 0;

  return (weight * usageFactor * qualityMultiplier) / tokens;
}

// --------------------------------------------------------------------------
// Greedy optimizer
// --------------------------------------------------------------------------

/**
 * @typedef {object} Suggestion
 * @property {string} id
 * @property {'demote'|'archive'} action
 * @property {string} currentPriority
 * @property {string} newPriority
 * @property {number} currentTokens
 * @property {number} valueDensity
 * @property {string} reason
 */

/**
 * Generate demote/archive suggestions to fit `maxTokens`.
 *
 * Greedy: while total > maxTokens, find the lowest value-density skill that
 * is not 'high' priority and emit a suggestion. Sort output by density asc.
 *
 * @param {object[]} skills
 * @param {object} options
 * @param {number} options.maxTokens
 * @param {'demote'|'archive'} [options.action='demote']
 * @param {object} [options.qualityScores] - skillId -> 0-100 score
 * @returns {{ suggestions: Suggestion[], projectedTotal: number, unfixable: boolean }}
 */
export function generateSuggestions(skills, options) {
  const { maxTokens, action = 'demote', qualityScores = null } = options;

  if (!Array.isArray(skills)) {
    return { suggestions: [], projectedTotal: 0, unfixable: false };
  }
  if (typeof maxTokens !== 'number' || maxTokens <= 0) {
    return { suggestions: [], projectedTotal: 0, unfixable: false };
  }

  // Build working list of active, mutable skills (skip already-archived).
  const working = skills
    .filter((s) => s && s.priority !== 'archived')
    .map((s) => ({
      entry: s,
      tokens: estimateIndexTokens(s),
      density: valueDensity(s, {
        qualityScore: qualityScores ? qualityScores[s.id] : undefined,
      }),
    }));

  const total = working.reduce((sum, x) => sum + x.tokens, 0);
  const suggestions = [];

  if (total <= maxTokens) {
    return { suggestions, projectedTotal: total, unfixable: false };
  }

  // Greedy: pick lowest density that isn't 'high' priority.
  // We re-sort each iteration because densities don't change but we need
  // stable order on ties (sort ascending, shift the first non-high).
  const sortByDensity = (a, b) => a.density - b.density;

  let projectedTotal = total;
  let unfixable = false;

  while (projectedTotal > maxTokens) {
    const candidates = working
      .filter((x) => x.entry.priority !== 'high' && !x._suggested)
      .sort(sortByDensity);

    if (candidates.length === 0) {
      unfixable = true;
      break;
    }

    const victim = candidates[0];
    victim._suggested = true;

    const currentPriority = victim.entry.priority || 'low';
    const newPriority = 'low';
    const reason = buildReason(victim, currentPriority, action);

    suggestions.push({
      id: victim.entry.id,
      action,
      currentPriority,
      newPriority,
      currentTokens: victim.tokens,
      valueDensity: round4(victim.density),
      reason,
    });

    projectedTotal -= victim.tokens;
  }

  // Sort suggestions by density ascending (lowest first = best target).
  suggestions.sort((a, b) => a.valueDensity - b.valueDensity);

  return {
    suggestions,
    projectedTotal,
    unfixable,
  };
}

function buildReason(victim, currentPriority, action) {
  const usage = victim.entry.usage_count || 0;
  const verb = action === 'archive' ? 'archive' : 'demote';
  return `${verb}: priority=${currentPriority}, used ${usage}x, density=${round4(victim.density)} is lowest`;
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

// --------------------------------------------------------------------------
// Apply path (mutate global.json)
// --------------------------------------------------------------------------

/**
 * Apply suggestions to a global.json object (in-place mutation).
 *
 * - 'demote' actions: set priority = 'low'
 * - 'archive' actions: move entry from skills[] to archived_skills[]
 *
 * @param {object} globalJson - parsed global.json
 * @param {Suggestion[]} suggestions
 * @returns {{ applied: number, demoted: number, archived: number, errors: string[] }}
 */
export function applySuggestions(globalJson, suggestions) {
  const result = { applied: 0, demoted: 0, archived: 0, errors: [] };

  if (!globalJson || typeof globalJson !== 'object') {
    result.errors.push('global.json is not a valid object');
    return result;
  }
  if (!Array.isArray(globalJson.skills)) {
    result.errors.push('global.json.skills is not an array');
    return result;
  }
  if (!Array.isArray(suggestions)) {
    return result;
  }

  // Lazy-init archived_skills list (matches self-improve.mjs convention)
  if (!Array.isArray(globalJson.archived_skills)) {
    globalJson.archived_skills = [];
  }

  for (const s of suggestions) {
    const idx = globalJson.skills.findIndex((e) => e && e.id === s.id);
    if (idx === -1) {
      result.errors.push(`skill not found: ${s.id}`);
      continue;
    }

    if (s.action === 'archive') {
      const [entry] = globalJson.skills.splice(idx, 1);
      entry.priority = 'archived';
      globalJson.archived_skills.push(entry);
      result.archived += 1;
    } else if (s.action === 'demote') {
      globalJson.skills[idx].priority = 'low';
      result.demoted += 1;
    } else {
      result.errors.push(`unknown action for ${s.id}: ${s.action}`);
      continue;
    }
    result.applied += 1;
  }

  if (result.applied > 0) {
    globalJson.generated = new Date().toISOString();
  }

  return result;
}

/**
 * Atomic write: write to <path>.tmp, then rename.
 *
 * @param {string} targetPath
 * @param {object} data
 * @returns {void}
 */
export function atomicWriteJson(targetPath, data) {
  const tmp = `${targetPath}.tmp`;
  const json = JSON.stringify(data, null, 2) + '\n';
  fs.writeFileSync(tmp, json, 'utf8');
  fs.renameSync(tmp, targetPath);
}

// --------------------------------------------------------------------------
// CLI (called by src/cli.mjs)
// --------------------------------------------------------------------------

/**
 * Run the budget command. Returns exit code (0 = success, 1 = over budget unfixable).
 *
 * @param {object} args
 * @param {string} [args.globalJson] - path to global.json
 * @param {number} [args.maxTokens] - budget cap (default 500)
 * @param {boolean} [args.dryRun=true]
 * @param {boolean} [args.json] - emit JSON instead of table
 * @param {boolean} [args.archive] - use 'archive' action (default: 'demote')
 * @param {boolean} [args.useQuality] - apply v1.6 quality scores as multiplier
 * @param {boolean} [args.includeSkillMd] - include SKILL.md file cost in estimate
 * @param {boolean} [args.write] - actually apply (default false; only relevant when not --archive)
 * @returns {number} exit code
 */
export async function cmdBudget(args = {}) {
  const globalPath = args.globalJson || defaultGlobalJsonPath();
  const maxTokens = typeof args.maxTokens === 'number' ? args.maxTokens : DEFAULT_MAX_TOKENS;
  const dryRun = args.dryRun !== false; // default true
  const useArchive = args.archive === true;
  const useQuality = args.useQuality === true;
  const includeSkillMd = args.includeSkillMd === true;
  const apply = useArchive || args.write === true;

  if (!fs.existsSync(globalPath)) {
    process.stderr.write(`budget: global.json not found at ${globalPath}\n`);
    return 1;
  }

  let globalJson;
  try {
    globalJson = JSON.parse(fs.readFileSync(globalPath, 'utf8'));
  } catch (err) {
    process.stderr.write(`budget: failed to parse ${globalPath}: ${err.message}\n`);
    return 1;
  }

  const skills = Array.isArray(globalJson.skills) ? globalJson.skills : [];

  // Optionally load quality scores. Lazily import the v1.6 scorer so
  // we don't pay the import cost when --use-quality is off, and so
  // circular-import risk stays at zero.
  let qualityScores = null;
  if (useQuality) {
    try {
      qualityScores = await loadQualityScores(globalPath);
    } catch (err) {
      process.stderr.write(`budget: --use-quality failed: ${err.message}\n`);
      return 1;
    }
  }

  const action = useArchive ? 'archive' : 'demote';
  const result = generateSuggestions(skills, {
    maxTokens,
    action,
    qualityScores,
  });

  const current = totalActiveTokens(skills, { includeSkillMd });

  if (args.json) {
    const output = {
      max: maxTokens,
      current,
      projected: result.projectedTotal,
      over: Math.max(0, current - maxTokens),
      utilization: round4(current / maxTokens),
      unfixable: result.unfixable,
      action,
      dryRun: !apply,
      skillMdIncluded: includeSkillMd,
      qualityWeighted: useQuality,
      suggestions: result.suggestions,
    };
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  } else {
    printBudgetTable({ current, max: maxTokens, result, action, apply, includeSkillMd, useQuality });
  }

  if (apply && result.suggestions.length > 0) {
    const applied = applySuggestions(globalJson, result.suggestions);
    try {
      atomicWriteJson(globalPath, globalJson);
      if (!args.json) {
        process.stdout.write(
          `\nApplied: ${applied.applied} (${applied.demoted} demoted, ${applied.archived} archived)\n`
        );
      }
    } catch (err) {
      process.stderr.write(`budget: failed to write ${globalPath}: ${err.message}\n`);
      return 1;
    }
  }

  return result.unfixable ? 1 : 0;
}


function defaultGlobalJsonPath() {
  return path.join(os.homedir(), '.meta-skills', 'global.json');
}

async function loadQualityScores(globalPath) {
  // Lazy dynamic import of v1.6 scorer. ESM only.
  const mod = await import('./quality-scorer.mjs');
  if (!mod || typeof mod.scoreAll !== 'function') return {};
  const result = mod.scoreAll(globalPath, { threshold: 0 }) || {};
  // scoreAll returns array of { id, overall } entries.
  const map = {};
  if (Array.isArray(result)) {
    for (const entry of result) {
      if (entry && entry.id) {
        map[entry.id] = typeof entry.overall === 'number' ? entry.overall : 0;
      }
    }
  }
  return map;
}

function printBudgetTable({ current, max, result, action, apply, includeSkillMd, useQuality }) {
  const lines = [];
  lines.push('');
  lines.push('  Token Budget Optimizer (v1.7)');
  lines.push('  ' + '-'.repeat(60));
  lines.push(`  Global JSON   : ${result.suggestions.length} skills active`);
  lines.push(`  Current total : ${current} tokens`);
  lines.push(`  Budget cap    : ${max} tokens`);
  lines.push(`  Projected     : ${result.projectedTotal} tokens (after ${action})`);
  lines.push(`  Over by       : ${Math.max(0, current - max)} tokens`);
  lines.push(`  Mode          : ${apply ? 'APPLY' : 'dry-run'}${useQuality ? ' + quality' : ''}${includeSkillMd ? ' + skill-md' : ''}`);
  lines.push('');

  if (result.suggestions.length === 0) {
    if (current <= max) {
      lines.push('  Under budget — no action needed.');
    } else if (result.unfixable) {
      lines.push('  OVER BUDGET but all remaining skills are HIGH priority — cannot fix without manual override.');
    } else {
      lines.push('  No suggestions produced.');
    }
  } else {
    lines.push('  Suggested actions:');
    lines.push('  ' + '-'.repeat(76));
    lines.push('  ' + pad('skill', 24) + pad('priority', 10) + pad('tokens', 8) + pad('density', 10) + 'action');
    for (const s of result.suggestions) {
      lines.push(
        '  ' + pad(s.id, 24) + pad(s.currentPriority, 10) + pad(String(s.currentTokens), 8) + pad(String(s.valueDensity), 10) + s.action
      );
    }
  }
  lines.push('');
  process.stdout.write(lines.join('\n'));
}

function pad(s, n) {
  s = String(s);
  if (s.length >= n) return s.slice(0, n - 1) + ' ';
  return s + ' '.repeat(n - s.length);
}
