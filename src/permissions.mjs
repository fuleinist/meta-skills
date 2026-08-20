#!/usr/bin/env node

/**
 * meta-skills v0.1.5 — Capabilities & permissions manifest
 *
 * Declarative `permissions` block in skill frontmatter cataloging
 * authorized access levels. Agent config files instruct agents to
 * decline execution if actions exceed declared permissions.
 *
 * Inspired by: POSIX capabilities, Docker security model, agent safety.
 *
 * Usage:
 *   node src/permissions.mjs --check <skill-json>
 *   node src/permissions.mjs --validate <skill-json>
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// ── Canonical permission set ──────────────────────────────────────────

export const VALID_PERMISSIONS = [
  'fs-read',
  'fs-write',
  'network',
  'shell-exec',
  'env-read',
  'process-exec',
];

export const PERMISSION_DESCRIPTIONS = {
  'fs-read':    'Read files on the local filesystem',
  'fs-write':   'Create, modify, or delete files',
  'network':    'Make outbound network requests (HTTP, WebSocket, etc.)',
  'shell-exec': 'Execute shell commands',
  'env-read':   'Read environment variables',
  'process-exec': 'Spawn child processes',
};

// ── Validation ────────────────────────────────────────────────────────

/**
 * Validate a skill's permissions field.
 * Returns { valid: bool, invalid: string[], unknown: string[] }
 */
export function validatePermissions(skill) {
  const perms = skill.permissions;

  // null/undefined/absent = no permissions declared (valid, no-op)
  if (perms === null || perms === undefined) {
    return { valid: true, invalid: [], unknown: [] };
  }

  if (!Array.isArray(perms)) {
    return { valid: false, invalid: ['permissions must be an array'], unknown: [] };
  }

  const validSet = new Set(VALID_PERMISSIONS);
  const invalid = [];
  const unknown = [];

  for (const p of perms) {
    if (typeof p !== 'string') {
      invalid.push(`permission must be a string, got ${typeof p}`);
      continue;
    }
    if (p === '*') {
      invalid.push('wildcard "*" not allowed — list specific permissions');
      continue;
    }
    if (!validSet.has(p)) {
      unknown.push(p);
    }
  }

  // Duplicates
  const seen = new Set();
  for (const p of perms) {
    if (typeof p === 'string' && seen.has(p)) {
      invalid.push(`duplicate permission "${p}"`);
    }
    seen.add(p);
  }

  return {
    valid: invalid.length === 0 && unknown.length === 0,
    invalid,
    unknown,
  };
}

// ── Capability checking ──────────────────────────────────────────────

/**
 * Check whether a skill is authorized for a given action.
 * Returns { authorized: boolean, reason?: string }
 *
 * @param {object} skill - skill entry with optional permissions array
 * @param {string} action - one of VALID_PERMISSIONS values
 */
export function canPerform(skill, action) {
  const perms = skill?.permissions;

  if (!Array.isArray(perms) || perms.length === 0) {
    return {
      authorized: false,
      reason: `skill "${skill?.id ?? 'unknown'}" declares no permissions — action "${action}" blocked`,
    };
  }

  if (!VALID_PERMISSIONS.includes(action)) {
    return {
      authorized: false,
      reason: `unknown action "${action}" — must be one of: ${VALID_PERMISSIONS.join(', ')}`,
    };
  }

  if (perms.includes(action)) {
    return { authorized: true };
  }

  return {
    authorized: false,
    reason: `skill "${skill.id}" lacks permission "${action}" — has: [${perms.join(', ')}]`,
  };
}

/**
 * Given a list of actions, return which are blocked for a skill.
 * Useful for agent config injection to show "you cannot do X with this skill".
 */
export function listBlockedActions(skill, actions) {
  const blocked = [];
  for (const action of actions) {
    const result = canPerform(skill, action);
    if (!result.authorized) {
      blocked.push({ action, reason: result.reason });
    }
  }
  return blocked;
}

/**
 * Generate a permissions summary for a meta-skills index.
 * Returns per-skill breakdown suitable for agent config injection.
 */
export function summarizePermissions(index) {
  const summary = [];
  for (const skill of index?.skills || []) {
    const perms = skill.permissions;
    summary.push({
      id: skill.id,
      permissions: Array.isArray(perms) ? perms : [],
      capabilities: (Array.isArray(perms) ? perms : []).map(p => PERMISSION_DESCRIPTIONS[p] || p),
    });
  }
  return summary;
}

// ── CLI ───────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help') {
    console.log(`Usage: node src/permissions.mjs <command> [args]

Commands:
  --check <file>     Check permissions in a meta-skills JSON file
  --validate <file>  Validate all skill permissions (exit 1 on errors)
  --can <skill-json> <action>  Test if a skill can perform an action
  --list <file>      Summarize all skill permissions
  --help             Show this message`);
    process.exit(0);
  }

  if (command === '--list') {
    const file = args[1];
    if (!file) { console.error('error: --list requires a file path'); process.exit(1); }
    const index = JSON.parse(require('node:fs').readFileSync(file, 'utf-8'));
    const summary = summarizePermissions(index);
    for (const s of summary) {
      console.log(`${s.id}:`);
      if (s.permissions.length === 0) {
        console.log('  (no permissions declared)');
      } else {
        for (const cap of s.capabilities) {
          console.log(`  • ${cap}`);
        }
      }
    }
    process.exit(0);
  }

  if (command === '--validate') {
    const file = args[1];
    if (!file) { console.error('error: --validate requires a file path'); process.exit(1); }
    const index = JSON.parse(require('node:fs').readFileSync(file, 'utf-8'));
    let totalErrors = 0;
    for (const skill of index.skills || []) {
      const result = validatePermissions(skill);
      if (!result.valid) {
        console.log(`✗ ${skill.id}:`);
        for (const inv of result.invalid) console.log(`    invalid: ${inv}`);
        for (const unk of result.unknown) console.log(`    unknown: "${unk}"`);
        totalErrors += result.invalid.length + result.unknown.length;
      }
    }
    if (totalErrors === 0) {
      console.log('✓ all skill permissions valid');
      process.exit(0);
    } else {
      console.log(`\n${totalErrors} permission error(s)`);
      process.exit(1);
    }
  }

  if (command === '--can') {
    const skillJson = args[1];
    const action = args[2];
    if (!skillJson || !action) { console.error('error: --can requires <skill-json> <action>'); process.exit(1); }
    const skill = JSON.parse(skillJson);
    const result = canPerform(skill, action);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.authorized ? 0 : 1);
  }

  console.error(`unknown command: ${command}`);
  process.exit(1);
}

const isMain = process.argv[1] && (process.argv[1] === fileURLToPath(import.meta.url) || process.argv[1].endsWith('permissions.mjs'));
if (isMain) main();

export default { validatePermissions, canPerform, listBlockedActions, summarizePermissions, VALID_PERMISSIONS };
