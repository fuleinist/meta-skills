#!/usr/bin/env node

/**
 * meta-skills v0.1.7 — Deprecation & Successor Routing
 *
 * Provides lifecycle management for skills: mark as deprecated, route to
 * successor, warn on usage, and exclude from budget optimization.
 *
 * A skill entry in global.json can carry:
 *   deprecated: true
 *   successor: "skill-id"   // the replacement skill
 *
 * Functions:
 *   isDeprecated(entry)           → boolean
 *   getSuccessor(entry)           → string | null
 *   warnIfDeprecated(skillId, entry) → logs stderr warning if deprecated
 *   resolveActiveSkill(index, skillId) → follows successor chain, returns final entry
 *   findDeprecatedActive(index)   → skills[] that are deprecated but not archived
 *   excludeFromBudget(skills)     → skills[] with deprecated removed
 */

import fs from 'node:fs';

// --------------------------------------------------------------------------
// Core checks
// --------------------------------------------------------------------------

/**
 * Check if a skill entry is deprecated.
 * @param {object} entry
 * @returns {boolean}
 */
export function isDeprecated(entry) {
  return !!(entry && entry.deprecated === true);
}

/**
 * Get the successor skill id for a deprecated entry.
 * @param {object} entry
 * @returns {string | null}
 */
export function getSuccessor(entry) {
  if (!entry || !entry.successor || typeof entry.successor !== 'string') return null;
  return entry.successor.trim() || null;
}

/**
 * Print a stderr warning if the skill is deprecated.
 * Returns true if a warning was printed.
 * @param {string} skillId
 * @param {object} entry
 * @returns {boolean}
 */
export function warnIfDeprecated(skillId, entry) {
  if (!isDeprecated(entry)) return false;
  const successor = getSuccessor(entry);
  const msg = successor
    ? `⚠ skill "${skillId}" is deprecated — use "${successor}" instead`
    : `⚠ skill "${skillId}" is deprecated — no successor specified`;
  process.stderr.write(msg + '\n');
  return true;
}

// --------------------------------------------------------------------------
// Successor chain resolution
// --------------------------------------------------------------------------

/**
 * Resolve the active skill by following successor chains.
 *
 * If skillId is deprecated, look up its successor. If that successor is
 * *also* deprecated, follow again (loop-safe). Returns the first
 * non-deprecated entry in the chain, or the original if no deprecation.
 *
 * @param {object} index - parsed global.json (must have skills array)
 * @param {string} skillId
 * @returns {{ entry: object|null, chain: string[], skipped: string[] }}
 */
export function resolveActiveSkill(index, skillId) {
  const skills = (index && Array.isArray(index.skills)) ? index.skills : [];
  const all = [...skills, ...(Array.isArray(index.archived_skills) ? index.archived_skills : [])];

  const chain = [skillId];
  const skipped = [];
  let currentId = skillId;
  const seen = new Set();

  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    const entry = all.find(s => s && s.id === currentId);
    if (!entry) break;
    if (!isDeprecated(entry)) {
      return { entry, chain, skipped };
    }
    const successor = getSuccessor(entry);
    if (!successor) {
      // Deprecated with no successor — return it as-is (graceful degradation)
      return { entry, chain, skipped };
    }
    skipped.push(currentId);
    currentId = successor;
    chain.push(currentId);
  }

  // Cycle detected or dead end — return original
  const origEntry = all.find(s => s && s.id === skillId) || null;
  return { entry: origEntry, chain, skipped };
}

// --------------------------------------------------------------------------
// Index queries
// --------------------------------------------------------------------------

/**
 * Find all deprecated skills that are still in the active list.
 * @param {object} index
 * @returns {object[]} deprecated entries with priority !== 'archived'
 */
export function findDeprecatedActive(index) {
  const skills = (index && Array.isArray(index.skills)) ? index.skills : [];
  return skills.filter(s => isDeprecated(s) && s.priority !== 'archived');
}

/**
 * Filter deprecated skills out of a candidate list (for budget optimizer).
 * @param {object[]} skills
 * @returns {object[]} skills that are not deprecated
 */
export function excludeFromBudget(skills) {
  if (!Array.isArray(skills)) return [];
  return skills.filter(s => !isDeprecated(s));
}

// --------------------------------------------------------------------------
// CLI integration: deprecate / undeprecate commands
// --------------------------------------------------------------------------

/**
 * Mark a skill as deprecated in global.json.
 * @param {string} globalJsonPath
 * @param {string} skillId
 * @param {string} [successorId]
 * @returns {boolean} true if skill was found and updated
 */
export function deprecateSkill(globalJsonPath, skillId, successorId) {
  const index = JSON.parse(fs.readFileSync(globalJsonPath, 'utf-8'));
  const skill = (index.skills || []).find(s => s.id === skillId);
  if (!skill) return false;
  skill.deprecated = true;
  if (successorId) skill.successor = successorId;
  fs.writeFileSync(globalJsonPath, JSON.stringify(index, null, 2) + '\n', 'utf-8');
  return true;
}

/**
 * Remove deprecated status from a skill.
 * @param {string} globalJsonPath
 * @param {string} skillId
 * @returns {boolean} true if skill was found and updated
 */
export function undeprecateSkill(globalJsonPath, skillId) {
  const index = JSON.parse(fs.readFileSync(globalJsonPath, 'utf-8'));
  const skill = (index.skills || []).find(s => s.id === skillId);
  if (!skill) return false;
  delete skill.deprecated;
  delete skill.successor;
  fs.writeFileSync(globalJsonPath, JSON.stringify(index, null, 2) + '\n', 'utf-8');
  return true;
}

// --------------------------------------------------------------------------
// CLI (standalone usage)
// --------------------------------------------------------------------------

function defaultGlobalJsonPath() {
  import('node:os').then(os => {
    return require('node:path').join(os.homedir(), '.meta-skills', 'global.json');
  });
}

const isMain = process.argv[1] && (
  process.argv[1] === new URL(import.meta.url).pathname ||
  process.argv[1].endsWith('deprecation.mjs')
);

if (isMain) {
  const args = process.argv.slice(2);
  const cmd = args[0];

  // Lazy import for default path
  Promise.all([import('node:fs'), import('node:os'), import('node:path')]).then(([fsMod, osMod, pathMod]) => {
    const fs = fsMod.default || fsMod;
    const os = osMod.default || osMod;
    const path = pathMod.default || pathMod;
    const gjPath = path.join(os.homedir(), '.meta-skills', 'global.json');

    if (!cmd || cmd === 'list') {
      if (!fs.existsSync(gjPath)) {
        process.stderr.write('no global.json found\n');
        process.exit(1);
      }
      const index = JSON.parse(fs.readFileSync(gjPath, 'utf-8'));
      const deprecated = findDeprecatedActive(index);
      if (deprecated.length === 0) {
        process.stdout.write('No deprecated skills in active index\n');
      } else {
        process.stdout.write(`Deprecated skills (${deprecated.length}):\n`);
        for (const s of deprecated) {
          const succ = s.successor ? ` → ${s.successor}` : ' (no successor)';
          process.stdout.write(`  ${s.id}${succ}\n`);
        }
      }
      return;
    }

    if (cmd === 'deprecate') {
      const skillId = args[1];
      const successor = args[2] || undefined;
      if (!skillId) {
        process.stderr.write('Usage: node src/deprecation.mjs deprecate <skill-id> [successor-id]\n');
        process.exit(1);
      }
      if (!fs.existsSync(gjPath)) {
        process.stderr.write('no global.json found\n');
        process.exit(1);
      }
      const ok = deprecateSkill(gjPath, skillId, successor);
      if (ok) {
        process.stdout.write(`✓ ${skillId} marked as deprecated${successor ? ` → ${successor}` : ''}\n`);
      } else {
        process.stderr.write(`✗ skill '${skillId}' not found in index\n`);
        process.exit(1);
      }
      return;
    }

    if (cmd === 'undeprecate') {
      const skillId = args[1];
      if (!skillId) {
        process.stderr.write('Usage: node src/deprecation.mjs undeprecate <skill-id>\n');
        process.exit(1);
      }
      if (!fs.existsSync(gjPath)) {
        process.stderr.write('no global.json found\n');
        process.exit(1);
      }
      const ok = undeprecateSkill(gjPath, skillId);
      if (ok) {
        process.stdout.write(`✓ ${skillId} un-deprecated\n`);
      } else {
        process.stderr.write(`✗ skill '${skillId}' not found in index\n`);
        process.exit(1);
      }
      return;
    }

    process.stderr.write(`Unknown command: ${cmd}\n`);
    process.stderr.write('Usage: node src/deprecation.mjs [list|deprecate|undeprecate]\n');
    process.exit(1);
  });
}

export default { isDeprecated, getSuccessor, warnIfDeprecated, resolveActiveSkill, findDeprecatedActive, excludeFromBudget, deprecateSkill, undeprecateSkill };
