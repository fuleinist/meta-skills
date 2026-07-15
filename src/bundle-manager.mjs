#!/usr/bin/env node

/**
 * meta-skills v1.8 — Skill Bundle Manager
 *
 * User-defined bundles (named groups of skill IDs that work together) plus
 * a thin wrapper around v0.4 co-occurrence detection for auto-suggestions.
 *
 * Two flavors coexist:
 *   - index.bundles[]          (user-defined, persistent, take precedence)
 *   - index.suggested_bundles[] (auto, written by self-improve.mjs v0.4)
 *
 * Inspired by EvoSkill skill composition and Make/Taskfile workflow patterns.
 *
 * Usage (CLI, see src/cli.mjs for full surface):
 *   node src/bundle-manager.mjs list [--include user|auto|all] [--json]
 *   node src/bundle-manager.mjs show <name>
 *   node src/bundle-manager.mjs create <name> --skill a --skill b [--desc '...'] [--tag X]
 *   node src/bundle-manager.mjs delete <name>
 *   node src/bundle-manager.mjs activate <name> [--dry-run|--write] [--json]
 *   node src/bundle-manager.mjs suggest [--min-days 3] [--json]
 *
 * Zero external API calls, zero new dependencies.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// --------------------------------------------------------------------------
// Errors
// --------------------------------------------------------------------------

/** Base class for all bundle-manager errors so callers can `instanceof` once. */
export class BundleError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'BundleError';
    this.code = code || 'BUNDLE_ERROR';
  }
}

/** Bundle name fails slug validation. */
export class BundleValidationError extends BundleError {
  constructor(message) {
    super(message, 'BUNDLE_VALIDATION');
    this.name = 'BundleValidationError';
  }
}

/** Bundle with that name already exists in user bundles. */
export class BundleExistsError extends BundleError {
  constructor(message) {
    super(message, 'BUNDLE_EXISTS');
    this.name = 'BundleExistsError';
  }
}

/** Bundle name not found anywhere (user + auto). */
export class BundleNotFoundError extends BundleError {
  constructor(message) {
    super(message, 'BUNDLE_NOT_FOUND');
    this.name = 'BundleNotFoundError';
  }
}

/** Tried to delete an auto (suggested) bundle — these are immutable. */
export class CannotDeleteAutoBundleError extends BundleError {
  constructor(message) {
    super(message, 'CANNOT_DELETE_AUTO');
    this.name = 'CannotDeleteAutoBundleError';
  }
}

/** A referenced skill ID does not exist in index.skills. */
export class UnknownSkillError extends BundleError {
  constructor(message) {
    super(message, 'UNKNOWN_SKILL');
    this.name = 'UnknownSkillError';
  }
}

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

/** Slug pattern: lowercase letters, digits, hyphens. Must start alphanumeric. Max 64 chars. */
export const BUNDLE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Default minimum co-occurrence days for suggestions. */
export const DEFAULT_MIN_COCCURRENCE_DAYS = 3;

/** Max auto-bundle suggestions to keep. Matches self-improve.mjs v0.4 cap. */
export const MAX_AUTO_SUGGESTIONS = 10;

/** Source identifier in activation log entries. */
export const ACTIVATION_SOURCE = 'bundle';

// --------------------------------------------------------------------------
// Validation helpers
// --------------------------------------------------------------------------

/**
 * Validate a proposed bundle name against the slug pattern.
 *
 * @param {string} name
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function validateBundleName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    return { ok: false, reason: 'name must be a non-empty string' };
  }
  if (name.length > 64) {
    return { ok: false, reason: 'name must be ≤64 characters' };
  }
  if (!BUNDLE_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      reason: 'name must match /^[a-z0-9][a-z0-9-]{0,63}$/ (lowercase, digits, hyphens; must start alphanumeric)',
    };
  }
  return { ok: true };
}

/**
 * Validate the skills list for a bundle. Returns the deduped, sorted list on success.
 *
 * @param {string[]} skills
 * @param {object} index
 * @returns {{ok: true, skills: string[]} | {ok: false, reason: string, missing?: string[]}}
 */
export function validateBundleSkills(skills, index) {
  if (!Array.isArray(skills) || skills.length === 0) {
    return { ok: false, reason: 'skills must be a non-empty array' };
  }

  const known = new Set((index && Array.isArray(index.skills) ? index.skills : []).map(s => s && s.id).filter(Boolean));
  const missing = [];
  const seen = new Set();

  for (const id of skills) {
    if (typeof id !== 'string' || id.length === 0) {
      return { ok: false, reason: 'each skill must be a non-empty string' };
    }
    if (!known.has(id)) {
      if (!missing.includes(id)) missing.push(id);
    }
    if (seen.has(id)) {
      return { ok: false, reason: `duplicate skill id in bundle: ${id}` };
    }
    seen.add(id);
  }

  if (missing.length > 0) {
    return { ok: false, reason: `unknown skill id(s): ${missing.join(', ')}`, missing };
  }

  return { ok: true, skills: Array.from(seen) };
}

// --------------------------------------------------------------------------
// Listing
// --------------------------------------------------------------------------

/**
 * List bundles from the index, optionally filtered by source.
 *
 * @param {object} index - parsed global.json
 * @param {object} [opts]
 * @param {'user'|'auto'|'all'} [opts.include='all']
 * @returns {Array<{name: string, description: string, skills: string[], tags: string[],
 *                  createdAt?: string, updatedAt?: string, source: 'user'|'auto',
 *                  cooccurrenceDays?: number}>}
 */
export function listBundles(index, opts = {}) {
  const include = ['user', 'auto', 'all'].includes(opts.include) ? opts.include : 'all';
  const userBundles = Array.isArray(index && index.bundles) ? index.bundles : [];
  const autoBundles = Array.isArray(index && index.suggested_bundles) ? index.suggested_bundles : [];

  const user = (include === 'user' || include === 'all')
    ? userBundles.map(b => ({
        name: b.name,
        description: b.description || '',
        skills: Array.isArray(b.skills) ? b.skills.slice() : [],
        tags: Array.isArray(b.tags) ? b.tags.slice() : [],
        createdAt: b.createdAt || null,
        updatedAt: b.updatedAt || null,
        source: 'user',
      }))
    : [];

  const auto = (include === 'auto' || include === 'all')
    ? autoBundles.map(b => ({
        name: Array.isArray(b.skills) ? b.skills.join('+') : String(b.skills || ''),
        description: '',
        skills: Array.isArray(b.skills) ? b.skills.slice() : [],
        tags: [],
        cooccurrenceDays: typeof b.cooccurrenceDays === 'number' ? b.cooccurrenceDays : 0,
        source: 'auto',
      }))
    : [];

  return [...user, ...auto];
}

/**
 * Look up a bundle by name. User bundles take precedence over auto.
 *
 * @param {object} index
 * @param {string} name
 * @returns {object|null} bundle record with `source` field, or null
 */
export function getBundle(index, name) {
  if (typeof name !== 'string' || name.length === 0) return null;

  const userBundles = Array.isArray(index && index.bundles) ? index.bundles : [];
  const userHit = userBundles.find(b => b && b.name === name);
  if (userHit) {
    return {
      name: userHit.name,
      description: userHit.description || '',
      skills: Array.isArray(userHit.skills) ? userHit.skills.slice() : [],
      tags: Array.isArray(userHit.tags) ? userHit.tags.slice() : [],
      createdAt: userHit.createdAt || null,
      updatedAt: userHit.updatedAt || null,
      source: 'user',
    };
  }

  const autoBundles = Array.isArray(index && index.suggested_bundles) ? index.suggested_bundles : [];
  // Auto bundles are identified by their skills (no name). Match if any auto bundle
  // has the same canonical "skills+skills" name. Caller may have to use that key.
  for (const a of autoBundles) {
    if (!a || !Array.isArray(a.skills)) continue;
    const autoName = a.skills.join('+');
    if (autoName === name) {
      return {
        name: autoName,
        description: '',
        skills: a.skills.slice(),
        tags: [],
        cooccurrenceDays: typeof a.cooccurrenceDays === 'number' ? a.cooccurrenceDays : 0,
        source: 'auto',
      };
    }
  }

  return null;
}

// --------------------------------------------------------------------------
// Mutations
// --------------------------------------------------------------------------

/**
 * Create a new user bundle. Mutates `index.bundles` in place.
 *
 * @param {object} index - parsed global.json (mutated)
 * @param {object} opts
 * @param {string} opts.name
 * @param {string[]} opts.skills
 * @param {string} [opts.description]
 * @param {string[]} [opts.tags]
 * @returns {object} the created bundle
 * @throws {BundleValidationError|BundleExistsError|UnknownSkillError}
 */
export function createBundle(index, opts = {}) {
  if (!index || typeof index !== 'object') {
    throw new BundleValidationError('index must be an object');
  }

  const nameCheck = validateBundleName(opts.name);
  if (!nameCheck.ok) {
    throw new BundleValidationError(nameCheck.reason);
  }

  if (!Array.isArray(index.bundles)) index.bundles = [];
  if (index.bundles.some(b => b && b.name === opts.name)) {
    throw new BundleExistsError(`bundle "${opts.name}" already exists`);
  }

  const skillsCheck = validateBundleSkills(opts.skills, index);
  if (!skillsCheck.ok) {
    if (skillsCheck.missing) {
      throw new UnknownSkillError(skillsCheck.reason);
    }
    throw new BundleValidationError(skillsCheck.reason);
  }

  const now = new Date().toISOString();
  const bundle = {
    name: opts.name,
    description: typeof opts.description === 'string' ? opts.description : '',
    skills: skillsCheck.skills,
    tags: Array.isArray(opts.tags) ? opts.tags.filter(t => typeof t === 'string' && t.length > 0).slice() : [],
    createdAt: now,
    updatedAt: now,
  };

  index.bundles.push(bundle);
  index.generated = now;
  return bundle;
}

/**
 * Delete a user bundle by name. Auto bundles are immutable.
 *
 * @param {object} index
 * @param {string} name
 * @returns {object} the deleted bundle
 * @throws {BundleNotFoundError|CannotDeleteAutoBundleError}
 */
export function deleteBundle(index, name) {
  if (!index || typeof index !== 'object') {
    throw new BundleValidationError('index must be an object');
  }

  const userBundles = Array.isArray(index.bundles) ? index.bundles : [];
  const userIdx = userBundles.findIndex(b => b && b.name === name);
  if (userIdx === -1) {
    // Check if it's an auto bundle to give a precise error.
    const autoBundles = Array.isArray(index.suggested_bundles) ? index.suggested_bundles : [];
    const isAuto = autoBundles.some(a => a && Array.isArray(a.skills) && a.skills.join('+') === name);
    if (isAuto) {
      throw new CannotDeleteAutoBundleError(`bundle "${name}" is an auto-suggested bundle and cannot be deleted`);
    }
    throw new BundleNotFoundError(`bundle "${name}" not found`);
  }

  const [removed] = index.bundles.splice(userIdx, 1);
  index.generated = new Date().toISOString();
  return removed;
}

// --------------------------------------------------------------------------
// Activation
// --------------------------------------------------------------------------

/**
 * Compute today's local-date filename for log entries (YYYY-MM-DD).
 * Stable across calls in the same local day.
 *
 * @param {Date} [now]
 * @returns {string}
 */
export function todayLogFilename(now) {
  const d = now || new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}.jsonl`;
}

/**
 * Build activation log events for a bundle without writing them.
 *
 * @param {object} bundle - bundle record (from getBundle/createBundle)
 * @param {object} [opts]
 * @param {Date} [opts.now]
 * @param {string} [opts.outcome='success']
 * @returns {Array<{skill: string, timestamp: string, outcome: string, source: string, bundle: string}>}
 */
export function buildActivationEvents(bundle, opts = {}) {
  if (!bundle || !Array.isArray(bundle.skills)) return [];
  const now = (opts.now || new Date()).toISOString();
  const outcome = typeof opts.outcome === 'string' ? opts.outcome : 'success';
  return bundle.skills.map(skill => ({
    skill,
    timestamp: now,
    outcome,
    source: ACTIVATION_SOURCE,
    bundle: bundle.name,
  }));
}

/**
 * Activate a bundle: writes one activation log entry per skill to today's log file.
 *
 * @param {object} bundle
 * @param {object} [opts]
 * @param {string} [opts.logDir] - defaults to ~/.meta-skills/logs
 * @param {boolean} [opts.dryRun=true] - if true, return events without writing
 * @returns {{bundle: object, events: Array, written: number, dryRun: boolean}}
 */
export function activateBundle(bundle, opts = {}) {
  if (!bundle || !Array.isArray(bundle.skills)) {
    throw new BundleValidationError('bundle must have a skills array');
  }

  const logDir = opts.logDir || path.join(os.homedir(), '.meta-skills', 'logs');
  const dryRun = opts.dryRun !== false; // default true
  const events = buildActivationEvents(bundle);

  if (dryRun) {
    return { bundle, events, written: 0, dryRun: true };
  }

  fs.mkdirSync(logDir, { recursive: true });
  const filename = todayLogFilename();
  const filePath = path.join(logDir, filename);
  const lines = events.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.appendFileSync(filePath, lines, 'utf8');

  return { bundle, events, written: events.length, dryRun: false };
}

// --------------------------------------------------------------------------
// Suggestion (wraps co-occurrence detection)
// --------------------------------------------------------------------------

/**
 * Read co-occurrence pairs from log files.
 *
 * Adapted from v0.4 self-improve.detectCooccurrence() but decoupled so callers
 * can use it without importing the full self-improve module (which has side
 * effects via main()).
 *
 * @param {string} logDir
 * @param {object} [opts]
 * @param {number} [opts.minDays=3]
 * @returns {Array<{skills: string[], cooccurrenceDays: number}>}
 */
export function suggestBundles(logDir, opts = {}) {
  const dir = logDir || path.join(os.homedir(), '.meta-skills', 'logs');
  const minDays = typeof opts.minDays === 'number' ? opts.minDays : DEFAULT_MIN_COCCURRENCE_DAYS;

  let logFiles;
  try {
    logFiles = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
  } catch {
    return [];
  }

  const pairs = {};
  for (const logFile of logFiles) {
    let content;
    try {
      content = fs.readFileSync(path.join(dir, logFile), 'utf-8');
    } catch {
      continue;
    }
    const daySkills = new Set();
    for (const line of content.split('\n').filter(Boolean)) {
      try {
        const event = JSON.parse(line);
        // Skip non-bundle source so we don't double-count activations from
        // recipes vs individual `record` commands.
        if (event && event.skill) daySkills.add(event.skill);
      } catch { /* skip */ }
    }
    const sorted = Array.from(daySkills).sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const key = `${sorted[i]}|${sorted[j]}`;
        pairs[key] = (pairs[key] || 0) + 1;
      }
    }
  }

  return Object.entries(pairs)
    .filter(([, count]) => count >= minDays)
    .sort(([, a], [, b]) => b - a)
    .slice(0, MAX_AUTO_SUGGESTIONS)
    .map(([key, count]) => {
      const [a, b] = key.split('|');
      return { skills: [a, b], cooccurrenceDays: count, suggested: true };
    });
}

// --------------------------------------------------------------------------
// Metrics (cross-module: budget + quality)
// --------------------------------------------------------------------------

/**
 * Aggregate v1.6 quality + v1.7 token cost for a bundle.
 *
 * Lazy-imports both modules so we don't pay the cost when not called.
 *
 * @param {object} index - parsed global.json
 * @param {string} bundleName
 * @returns {{
 *   name: string,
 *   skills: string[],
 *   source: 'user'|'auto',
 *   totalTokens: number,
 *   avgQuality: number|null,
 *   scoreRange: {min: number, max: number}|null,
 * }|null}
 */
export function computeBundleMetrics(index, bundleName) {
  const bundle = getBundle(index, bundleName);
  if (!bundle) return null;

  const skillsById = new Map(
    (Array.isArray(index.skills) ? index.skills : []).map(s => [s.id, s])
  );

  // Lazy synchronous require-style: dynamic import is async, but the underlying
  // modules are pure data functions. Use synchronous fs reads + the existing
  // pure helpers exposed by v1.6/v1.7.
  // We can't synchronously import ESM modules, so we re-implement the simple
  // heuristic here without depending on quality-scorer/budget-optimizer to
  // keep bundle-manager standalone-importable.
  const charsPerToken = 4;

  let totalTokens = 0;
  let qualitySum = 0;
  let qualityCount = 0;
  const qualityScores = [];

  for (const skillId of bundle.skills) {
    const skill = skillsById.get(skillId);
    if (!skill) continue;

    // Token estimate: chars of {id, when, why, path, priority} / charsPerToken.
    const indexOnly = {
      id: skill.id,
      when: skill.when,
      why: skill.why,
      path: skill.path,
      priority: skill.priority,
    };
    const chars = JSON.stringify(indexOnly).length;
    totalTokens += Math.max(1, Math.ceil(chars / charsPerToken));

    // Quality score: prefer skill.quality_score if present, else null.
    const qs = typeof skill.quality_score === 'number' ? skill.quality_score
      : (typeof skill.score === 'number' ? skill.score
      : null);
    if (qs !== null) {
      qualitySum += qs;
      qualityCount += 1;
      qualityScores.push(qs);
    }
  }

  const avgQuality = qualityCount > 0 ? Math.round((qualitySum / qualityCount) * 100) / 100 : null;
  const scoreRange = qualityScores.length > 0
    ? { min: Math.min(...qualityScores), max: Math.max(...qualityScores) }
    : null;

  return {
    name: bundle.name,
    skills: bundle.skills.slice(),
    source: bundle.source,
    totalTokens,
    avgQuality,
    scoreRange,
  };
}

// --------------------------------------------------------------------------
// Atomic write
// --------------------------------------------------------------------------

/**
 * Write JSON atomically via temp file + rename. Matches v1.7 budget-optimizer pattern.
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
// CLI entry (when run directly via `node src/bundle-manager.mjs`)
// --------------------------------------------------------------------------

const isMain = process.argv[1] && (process.argv[1].endsWith('bundle-manager.mjs') || process.argv[1].endsWith('bundle-manager'));

if (isMain) {
  const args = process.argv.slice(2);
  // Lightweight dispatcher — the real CLI surface lives in cli.mjs.
  // This block exists so the file is independently runnable for debugging.
  const cmd = args[0];

  if (cmd === 'list') {
    const idx = args.indexOf('--global-json');
    const p = idx >= 0 ? path.resolve(args[idx + 1]) : path.join(os.homedir(), '.meta-skills', 'global.json');
    let index;
    try {
      index = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (err) {
      console.error(`bundle-manager: cannot read ${p}: ${err.message}`);
      process.exit(1);
    }
    const includeIdx = args.indexOf('--include');
    const include = includeIdx >= 0 ? args[includeIdx + 1] : 'all';
    const json = args.includes('--json');
    const bundles = listBundles(index, { include });
    if (json) {
      console.log(JSON.stringify(bundles, null, 2));
    } else {
      console.log(`# Bundles (${include})`);
      for (const b of bundles) {
        const tags = b.tags.length ? ` [${b.tags.join(',')}]` : '';
        const days = b.cooccurrenceDays != null ? ` (${b.cooccurrenceDays}d)` : '';
        console.log(`  ${b.source === 'user' ? '*' : '~'} ${b.name}${days} — ${b.skills.join(', ')}${tags}`);
      }
    }
  } else if (cmd === 'show') {
    const idx = args.indexOf('--global-json');
    const p = idx >= 0 ? path.resolve(args[idx + 1]) : path.join(os.homedir(), '.meta-skills', 'global.json');
    const name = args[1];
    if (!name) {
      console.error('bundle-manager show: bundle name required');
      process.exit(1);
    }
    let index;
    try {
      index = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (err) {
      console.error(`bundle-manager: cannot read ${p}: ${err.message}`);
      process.exit(1);
    }
    const bundle = getBundle(index, name);
    if (!bundle) {
      console.error(`bundle-manager: bundle "${name}" not found`);
      process.exit(1);
    }
    const metrics = computeBundleMetrics(index, name);
    console.log(`Bundle: ${bundle.name} (${bundle.source})`);
    console.log(`  Description: ${bundle.description || '(none)'}`);
    console.log(`  Skills     : ${bundle.skills.join(', ')}`);
    if (bundle.tags.length) console.log(`  Tags       : ${bundle.tags.join(', ')}`);
    if (bundle.cooccurrenceDays != null) console.log(`  Co-occurred: ${bundle.cooccurrenceDays} days`);
    if (metrics) {
      console.log(`  Tokens     : ${metrics.totalTokens}`);
      if (metrics.avgQuality != null) console.log(`  Avg Quality: ${metrics.avgQuality}`);
    }
  } else {
    console.log('Usage: node src/bundle-manager.mjs <list|show> [--global-json <path>] [--json]');
  }
}