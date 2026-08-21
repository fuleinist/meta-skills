#!/usr/bin/env node

/**
 * meta-skills v0.1.6 — Live Skill Hot-Reloading
 *
 * Background file watcher (fs.watch) detects changes to registered
 * SKILL.md files during active sessions. On change, logs the event
 * and updates the in-memory index entry so agents always see fresh
 * skill metadata without manual re-indexing.
 *
 * Inspired by: webpack HMR, nodemon, developer experience patterns.
 *
 * Usage:
 *   node src/skill-watcher.mjs [--global-json <path>]
 *   const watcher = createSkillWatcher(index, { onReload });
 *   watcher.start();  // returns Promise that resolves on stop
 *   watcher.stop();
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from './global-scanner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Debounce helper ──────────────────────────────────────────────────

/**
 * Create a debounced wrapper. Rapid successive calls collapse into
 * one invocation after `waitMs` of quiet.
 */
export function debounce(fn, waitMs = 100) {
  let timer = null;
  let lastArgs = null;
  return (...args) => {
    lastArgs = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...lastArgs);
    }, waitMs);
  };
}

// ── Extract reloadable fields from a SKILL.md ────────────────────────

/**
 * Parse a SKILL.md file and extract the fields the index cares about.
 * Returns null if the file doesn't exist or has no usable frontmatter.
 */
export function extractSkillMeta(skillPath) {
  if (!fs.existsSync(skillPath)) return null;
  let content;
  try {
    content = fs.readFileSync(skillPath, 'utf-8');
  } catch {
    return null;
  }
  const fm = parseFrontmatter(content);
  const dirName = path.basename(path.dirname(skillPath));
  return {
    id: fm.name || dirName,
    when: fm.description || '',
    why: fm.description || '',
    path: skillPath,
    version: fm.version || null,
    engines: fm.engines || null,
    requires: fm.requires || null,
    permissions: fm.permissions || null,
    deprecated: fm.deprecated || null,
    successor: fm.successor || null,
  };
}

// ── Core watcher ─────────────────────────────────────────────────────

/**
 * Create a skill watcher for the given index.
 *
 * @param {object} index — meta-skills index (mutated in place on reload)
 * @param {object} options
 * @param {function(string, object): void} [options.onReload] — called with (skillId, meta) after each reload
 * @param {function(string, Error): void} [options.onError] — called on watcher errors
 * @param {number} [options.debounceMs] — debounce window (default 100)
 * @returns {{ start: () => Promise<void>, stop: () => void, getWatchedCount: () => number }}
 */
export function createSkillWatcher(index, options = {}) {
  const {
    onReload = null,
    onError = null,
    debounceMs = 100,
  } = options;

  /** @type {Map<string, fs.FSWatcher>} */
  const watchers = new Map();
  /** @type {NodeJS.Timeout|null} */
  let doneTimer = null;
  let stopped = false;

  // Build a map of skill-id → SKILL.md path from the index
  function getSkillPaths() {
    const result = new Map();
    for (const skill of index.skills || []) {
      if (skill.path && skill.id) {
        result.set(skill.id, skill.path);
      }
    }
    return result;
  }

  function reloadSkill(skillId) {
    const skillIndex = (index.skills || []).findIndex(s => s.id === skillId);
    if (skillIndex === -1) return;

    const skillPath = index.skills[skillIndex].path;
    if (!skillPath || !fs.existsSync(skillPath)) return;

    const meta = extractSkillMeta(skillPath);
    if (!meta) return;

    // Preserve runtime-only fields that aren't in SKILL.md
    const existing = index.skills[skillIndex];
    index.skills[skillIndex] = {
      ...meta,
      priority: existing.priority || 'medium',
      usage_count: existing.usage_count || 0,
      last_used: existing.last_used || null,
      empirical_tokens: existing.empirical_tokens ?? null,
    };

    const ts = new Date().toISOString();
    console.log(`[skill-watcher] reloaded "${skillId}" at ${ts}`);
    if (onReload) onReload(skillId, index.skills[skillIndex]);
  }

  const debouncedReload = debounce(reloadSkill, debounceMs);

  function watchFile(skillId, skillPath) {
    const dir = path.dirname(skillPath);
    const fileName = path.basename(skillPath);
    if (watchers.has(skillId)) return; // already watching

    try {
      const watcher = fs.watch(dir, { persistent: true }, (eventType, filename) => {
        if (filename === fileName) {
          debouncedReload(skillId);
        }
      });
      watcher.on('error', (err) => {
        console.error(`[skill-watcher] watcher error for "${skillId}": ${err.message}`);
        if (onError) onError(skillId, err);
      });
      watchers.set(skillId, watcher);
    } catch (err) {
      console.error(`[skill-watcher] failed to watch "${skillPath}": ${err.message}`);
      if (onError) onError(skillId, err);
    }
  }

  return {
    /**
     * Start watching all registered skill files.
     * Returns a Promise that resolves when stop() is called.
     */
    start() {
      const skillPaths = getSkillPaths();
      for (const [skillId, skillPath] of skillPaths) {
        if (fs.existsSync(skillPath)) {
          watchFile(skillId, skillPath);
        }
      }
      console.log(`[skill-watcher] watching ${watchers.size} skill file(s)`);

      return new Promise((resolve) => {
        doneTimer = setInterval(() => {
          if (stopped) {
            clearInterval(doneTimer);
            resolve();
          }
        }, 200);
      });
    },

    /**
     * Stop all watchers and clean up.
     */
    stop() {
      stopped = true;
      for (const [skillId, watcher] of watchers) {
        try { watcher.close(); } catch { /* ignore */ }
      }
      watchers.clear();
    },

    /**
     * Number of files currently being watched.
     */
    getWatchedCount() {
      return watchers.size;
    },
  };
}

// ── CLI entry point ──────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  let globalJsonPath = path.join(
    process.env.HOME || process.env.USERPROFILE || '.',
    '.meta-skills',
    'global.json'
  );

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--global-json' && i + 1 < args.length) {
      globalJsonPath = path.resolve(args[++i]);
    }
  }

  if (!fs.existsSync(globalJsonPath)) {
    console.error(`global.json not found at ${globalJsonPath}`);
    console.error('Run `meta-skills init --global` first.');
    process.exit(1);
  }

  const index = JSON.parse(fs.readFileSync(globalJsonPath, 'utf-8'));
  const skills = index.skills || [];

  if (skills.length === 0) {
    console.log('[skill-watcher] no skills in index. Nothing to watch.');
    process.exit(0);
  }

  console.log(`meta-skills v0.1.6 — Live Skill Hot-Reloading`);
  console.log(`  Watching ${skills.length} skill(s) from ${globalJsonPath}`);
  console.log(`  Press Ctrl+C to stop.\n`);

  const watcher = createSkillWatcher(index, {
    onReload(skillId, meta) {
      // After reload, persist the updated index back to disk
      try {
        const tmpPath = globalJsonPath + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(index, null, 2) + '\n', 'utf-8');
        fs.renameSync(tmpPath, globalJsonPath);
        console.log(`  ✓ index persisted (${meta.id}: ${meta.when.slice(0, 40)}...)`);
      } catch (err) {
        console.error(`  ✗ failed to persist index: ${err.message}`);
      }
    },
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n[skill-watcher] shutting down...');
    watcher.stop();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    watcher.stop();
    process.exit(0);
  });

  watcher.start();
}

// Only run when executed directly
const isMain = process.argv[1] && (
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1].endsWith('skill-watcher.mjs')
);
if (isMain) main();

export { main };
