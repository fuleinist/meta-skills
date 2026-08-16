#!/usr/bin/env node

/**
 * meta-skills v0.1.1 — Semantic Version Compatibility
 *
 * Parses semantic versions and checks compatibility between skill
 * version constraints and the current runtime version.
 *
 * Supports:
 *   - Full semver parsing (major.minor.patch)
 *   - Range matching: ^1.2.0, ~1.2.0, >=1.0.0, 1.x, *
 *   - Engine compatibility checking (meta-skills runtime version)
 *
 * Zero external dependencies — pure JS implementation.
 */

// ── Semver parsing ────────────────────────────────────────────────────

/**
 * Parse a semver string into { major, minor, patch, prerelease }.
 * Returns null if invalid.
 */
export function parseSemver(version) {
  if (!version || typeof version !== 'string') return null;
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9.-]+))?$/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4] || null,
    raw: version,
  };
}

/**
 * Compare two semver objects.
 * Returns: -1 (a < b), 0 (a === b), 1 (a > b)
 */
export function compareSemver(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  // Prerelease has lower precedence than release
  if (a.prerelease && !b.prerelease) return -1;
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && b.prerelease) return a.prerelease.localeCompare(b.prerelease);
  return 0;
}

// ── Range matching ────────────────────────────────────────────────────

/**
 * Check if a version satisfies a range constraint.
 * Supports: *, ^, ~, >=, <=, >, <, ==, !=, hyphen ranges, x-ranges
 */
export function satisfies(versionStr, rangeStr) {
  if (!rangeStr || rangeStr === '*') return true;
  const ver = parseSemver(versionStr);
  if (!ver) return false;

  // Handle comma-separated OR conditions
  if (rangeStr.includes(',')) {
    return rangeStr.split(',').every(r => satisfies(versionStr, r.trim()));
  }

  // Handle hyphen ranges: 1.0.0 - 2.0.0
  const hyphenMatch = rangeStr.match(/^([\d.]+)\s*-\s*([\d.]+)$/);
  if (hyphenMatch) {
    const lo = parseSemver(hyphenMatch[1]);
    const hi = parseSemver(hyphenMatch[2]);
    if (!lo || !hi) return false;
    return compareSemver(ver, lo) >= 0 && compareSemver(ver, hi) <= 0;
  }

  // Caret ^: compatible with version (same major)
  if (rangeStr.startsWith('^')) {
    const target = parseSemver(rangeStr.slice(1));
    if (!target) return false;
    if (target.major !== ver.major) return false;
    return compareSemver(ver, target) >= 0;
  }

  // Tilde ~: patch-level compatibility
  if (rangeStr.startsWith('~')) {
    const target = parseSemver(rangeStr.slice(1));
    if (!target) return false;
    if (target.major !== ver.major || target.minor !== ver.minor) return false;
    return ver.patch >= target.patch;
  }

  // Comparison operators
  const compMatch = rangeStr.match(/^(>=|<=|!=|==|>|<)\s*(.+)$/);
  if (compMatch) {
    const op = compMatch[1];
    const target = parseSemver(compMatch[2].trim());
    if (!target) return false;
    const cmp = compareSemver(ver, target);
    switch (op) {
      case '>=': return cmp >= 0;
      case '<=': return cmp <= 0;
      case '>':  return cmp > 0;
      case '<':  return cmp < 0;
      case '==': return cmp === 0;
      case '!=': return cmp !== 0;
    }
  }

  // Bare version (exact match)
  const bare = parseSemver(rangeStr);
  if (bare) return compareSemver(ver, bare) === 0;

  return false;
}

// ── X-range support (e.g., "1.x", "1.2.x") ──────────────────────────

function parseXRange(rangeStr) {
  const match = rangeStr.match(/^(\d+)\.x(?:\.x?)?$/);
  if (match) return { major: parseInt(match[1], 10), minor: null, patch: null };
  const match2 = rangeStr.match(/^(\d+)\.(\d+)\.x$/);
  if (match2) return { major: parseInt(match2[1], 10), minor: parseInt(match2[2], 10), patch: null };
  return null;
}

// ── Engine compatibility ─────────────────────────────────────────────

const RUNTIME_VERSION = '1.8.0'; // Will be updated per release

/**
 * Check if a skill's engines constraint is compatible with the runtime.
 * @param {object} engines — skill's engines field (e.g., { "meta-skills": "^1.0.0" })
 * @param {string} [runtimeVersion] — current runtime version (defaults to RUNTIME_VERSION)
 * @returns {{ compatible, issues: string[] }}
 */
export function checkEngines(engines, runtimeVersion = RUNTIME_VERSION) {
  const issues = [];

  if (!engines || typeof engines !== 'object') return { compatible: true, issues: [] };

  const msVersion = engines['meta-skills'];
  if (msVersion) {
    if (!satisfies(runtimeVersion, msVersion)) {
      issues.push(`meta-skills engine ${msVersion} not satisfied by runtime ${runtimeVersion}`);
    }
  }

  return {
    compatible: issues.length === 0,
    issues,
  };
}

// ── Deprecation routing ──────────────────────────────────────────────

/**
 * Check if a skill is deprecated and return successor info.
 * @param {object} entry — skill entry from global.json
 * @returns {{ deprecated, successor, warning }}
 */
export function checkDeprecation(entry) {
  if (!entry || !entry.deprecated) return { deprecated: false, successor: null, warning: null };

  let warning = `⚠ Skill "${entry.id}" is deprecated`;
  if (entry.successor) {
    warning += ` — use "${entry.successor}" instead`;
  }
  warning += '.';

  return {
    deprecated: true,
    successor: entry.successor || null,
    warning,
  };
}

// ── Dependency validation ────────────────────────────────────────────

/**
 * Validate that all `requires` dependencies exist in the index.
 * Also checks for circular dependencies via DFS.
 *
 * @param {object} index — meta-skills index
 * @returns {{ valid, errors: string[], cycles: string[][] }}
 */
export function validateDependencies(index) {
  const errors = [];
  const cycles = [];
  const skillMap = new Map();

  for (const skill of [...(index.skills || []), ...(index.stale || [])]) {
    skillMap.set(skill.id, skill);
  }

  // Check that required skills exist
  for (const skill of index.skills || []) {
    if (!skill.requires || skill.requires.length === 0) continue;
    for (const depId of skill.requires) {
      if (!skillMap.has(depId)) {
        errors.push(`"${skill.id}" requires "${depId}" but it is not in the index`);
      }
    }
  }

  // DFS cycle detection
  const visited = new Set();
  const recStack = new Set();

  function dfs(skillId, path) {
    if (recStack.has(skillId)) {
      const cycleStart = path.indexOf(skillId);
      cycles.push(path.slice(cycleStart).concat(skillId));
      return;
    }
    if (visited.has(skillId)) return;

    visited.add(skillId);
    recStack.add(skillId);
    path.push(skillId);

    const skill = skillMap.get(skillId);
    if (skill && skill.requires) {
      for (const dep of skill.requires) {
        dfs(dep, [...path]);
      }
    }

    recStack.delete(skillId);
  }

  for (const skill of index.skills || []) {
    visited.clear();
    recStack.clear();
    dfs(skill.id, []);
  }

  return { valid: errors.length === 0 && cycles.length === 0, errors, cycles };
}

// ── CLI ───────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`meta-skills semver — Semantic version compatibility checking (v0.1.1)

Usage:
  meta-skills semver check <version> <range>     Check if version satisfies range
  meta-skills semver engines <skill-id>          Check engine compatibility for a skill
  meta-skills semver deps [--global-json <path>] Validate dependency graph

Examples:
  meta-skills semver check 1.2.3 "^1.0.0"        → true
  meta-skills semver check 1.2.3 "~1.2.0"        → true
  meta-skills semver check 2.0.0 "^1.0.0"        → false`);
    process.exit(0);
  }

  const cmd = args[0];

  switch (cmd) {
    case 'check': {
      const version = args[1];
      const range = args[2];
      if (!version || !range) {
        console.error('Usage: meta-skills semver check <version> <range>');
        process.exit(1);
      }
      const result = satisfies(version, range);
      console.log(`${version} ${result ? 'satisfies' : 'does not satisfy'} ${range}`);
      process.exit(result ? 0 : 1);
      break;
    }

    case 'engines': {
      const skillId = args[1];
      const gjPath = args[args.indexOf('--global-json') + 1] ||
        require('node:os').homedir() + '/.meta-skills/global.json';
      const index = JSON.parse(require('node:fs').readFileSync(gjPath, 'utf-8'));
      const skill = [...(index.skills || []), ...(index.stale || [])].find(s => s.id === skillId);
      if (!skill) {
        console.error(`Skill "${skillId}" not found`);
        process.exit(1);
      }
      const result = checkEngines(skill.engines);
      if (result.compatible) {
        console.log(`✓ ${skillId}: engines compatible`);
      } else {
        console.log(`✗ ${skillId}: engine incompatibility`);
        for (const issue of result.issues) {
          console.log(`  - ${issue}`);
        }
        process.exit(1);
      }
      break;
    }

    case 'deps': {
      const gjIdx = args.indexOf('--global-json');
      const gjPath = gjIdx >= 0 ? args[gjIdx + 1] :
        require('node:os').homedir() + '/.meta-skills/global.json';
      const index = JSON.parse(require('node:fs').readFileSync(gjPath, 'utf-8'));
      const result = validateDependencies(index);

      if (result.errors.length > 0) {
        console.log(`✗ Dependency errors (${result.errors.length}):`);
        for (const e of result.errors) console.log(`  - ${e}`);
        process.exit(1);
      }
      if (result.cycles.length > 0) {
        console.log(`✗ Circular dependencies detected:`);
        for (const cycle of result.cycles) {
          console.log(`  ${cycle.join(' → ')}`);
        }
        process.exit(1);
      }
      console.log('✓ Dependency graph is valid');
      break;
    }

    default:
      console.error(`Unknown subcommand: ${cmd}`);
      process.exit(1);
  }
}

const isMain = process.argv[1] && (
  process.argv[1].endsWith('semver-compat.mjs')
  || process.argv[1] === new URL(import.meta.url).pathname
);
if (isMain) main();

// RUNTIME_VERSION is the only non-function export, re-export it here.
export { RUNTIME_VERSION };
