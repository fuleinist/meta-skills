#!/usr/bin/env node

/**
 * meta-skills v1.8 — Recipe Runner
 *
 * Parse, validate, and execute multi-step skill activation workflows.
 *
 * Recipe file formats (auto-detected by extension):
 *   .recipe   — simple YAML-style lines, no external YAML lib
 *                 # name: release-flow
 *                 # description: cut a release from validated code
 *                 step validate: run tests, lint, type-check
 *                 step changelog: meta-skills record git-commits
 *                 step commit: meta-skills record git-commits --outcome success
 *   .json     — native JSON object
 *                 { "name": "release-flow",
 *                   "description": "cut a release from validated code",
 *                   "steps": [{ "skill": "validate", "params": {}, "on_failure": "stop" }] }
 *
 * Each step writes a usage log entry {skill, timestamp, outcome, source: 'recipe',
 * recipe: <name>, step: <n>}. Validates that all skill IDs exist in the index.
 *
 * Zero new npm deps. Pure regex YAML parser + native JSON.parse.
 *
 * Usage:
 *   node src/recipe-runner.mjs run <file> [--dry-run|--write] [--stop-on-failure]
 *   node src/recipe-runner.mjs validate <file>
 *   node src/recipe-runner.mjs init <name> [--out <path>]
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildActivationEvents, todayLogFilename } from './bundle-manager.mjs';

// --------------------------------------------------------------------------
// Errors
// --------------------------------------------------------------------------

export class RecipeError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'RecipeError';
    this.code = code || 'RECIPE_ERROR';
  }
}

export class RecipeParseError extends RecipeError {
  constructor(message) {
    super(message, 'RECIPE_PARSE');
    this.name = 'RecipeParseError';
  }
}

export class RecipeValidationError extends RecipeError {
  constructor(message, errors = []) {
    super(message, 'RECIPE_VALIDATION');
    this.name = 'RecipeValidationError';
    this.errors = errors;
  }
}

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

export const RECIPE_SOURCE = 'recipe';

export const FAILURE_BEHAVIORS = new Set(['stop', 'continue']);

export const VALID_RECIPE_EXTENSIONS = new Set(['.recipe', '.json']);

// --------------------------------------------------------------------------
// Format detection
// --------------------------------------------------------------------------

/**
 * Detect recipe format from a file path's extension.
 *
 * @param {string} filePath
 * @returns {'recipe'|'json'}
 */
export function detectFormat(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.json') return 'json';
  if (ext === '.recipe') return 'recipe';
  // Default to YAML-style .recipe for unknown extensions.
  return 'recipe';
}

// --------------------------------------------------------------------------
// Parsing
// --------------------------------------------------------------------------

/**
 * Parse a YAML-style recipe. Supports comment headers (# name:, # description:)
 * and `step <skill>: <description>` lines. Multi-space separators allowed.
 *
 * @param {string} text
 * @returns {object} parsed recipe
 * @throws {RecipeParseError}
 */
export function parseYamlRecipe(text) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new RecipeParseError('recipe text is empty');
  }

  let name = '';
  let description = '';
  const steps = [];

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();

    if (line.length === 0) continue;
    if (line.startsWith('#')) {
      // Header line: "# key: value"
      const m = line.match(/^#\s*([a-z_]+)\s*:\s*(.+?)\s*$/i);
      if (m) {
        const key = m[1].toLowerCase();
        const value = m[2];
        if (key === 'name') name = value;
        else if (key === 'description') description = value;
        // Other comment keys are ignored (forward-compat).
      }
      continue;
    }

    // Step line: "step <skill>: <description>" or "step <skill>" (no description).
    const stepMatch = line.match(/^step\s+([a-z0-9][a-z0-9_-]*)\s*(?::\s*(.+?))?$/i);
    if (stepMatch) {
      const skill = stepMatch[1];
      const desc = stepMatch[2] || '';
      steps.push({
        skill,
        description: desc,
        // YAML recipes default to "continue" — failure simulation is a v1.9+
        // feature, so per-step on_failure is parsed but currently a no-op.
        on_failure: 'continue',
      });
      continue;
    }

    // Unrecognized line — strict parser, error out.
    throw new RecipeParseError(`recipe: unrecognized line ${i + 1}: ${JSON.stringify(raw)}`);
  }

  if (steps.length === 0) {
    throw new RecipeParseError('recipe: no steps defined');
  }

  return {
    name: name || '',
    description,
    steps,
    format: 'recipe',
  };
}

/**
 * Parse a JSON recipe.
 *
 * @param {string} text
 * @returns {object}
 * @throws {RecipeParseError}
 */
export function parseJsonRecipe(text) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new RecipeParseError('recipe text is empty');
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new RecipeParseError(`recipe: invalid JSON: ${err.message}`);
  }
  if (!data || typeof data !== 'object') {
    throw new RecipeParseError('recipe: JSON must be an object');
  }
  if (!Array.isArray(data.steps) || data.steps.length === 0) {
    throw new RecipeParseError('recipe: JSON must have a non-empty "steps" array');
  }
  const steps = data.steps.map((s, i) => {
    if (!s || typeof s !== 'object') {
      throw new RecipeParseError(`recipe: step ${i + 1} must be an object`);
    }
    if (typeof s.skill !== 'string' || s.skill.length === 0) {
      throw new RecipeParseError(`recipe: step ${i + 1} must have a "skill" string`);
    }
    const onFailure = s.on_failure || 'stop';
    if (!FAILURE_BEHAVIORS.has(onFailure)) {
      throw new RecipeParseError(`recipe: step ${i + 1} on_failure must be 'stop' or 'continue', got ${JSON.stringify(onFailure)}`);
    }
    return {
      skill: s.skill,
      description: typeof s.description === 'string' ? s.description : '',
      on_failure: onFailure,
      params: (s.params && typeof s.params === 'object') ? s.params : {},
    };
  });
  return {
    name: typeof data.name === 'string' ? data.name : '',
    description: typeof data.description === 'string' ? data.description : '',
    steps,
    format: 'json',
  };
}

/**
 * Parse a recipe from text given a format hint.
 *
 * @param {string} text
 * @param {'recipe'|'json'} format
 * @returns {object}
 */
export function parseRecipe(text, format = 'recipe') {
  return format === 'json' ? parseJsonRecipe(text) : parseYamlRecipe(text);
}

/**
 * Read a recipe file and parse it.
 *
 * @param {string} filePath
 * @returns {object}
 */
export function readRecipe(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new RecipeParseError(`recipe: file not found: ${filePath}`);
  }
  const text = fs.readFileSync(filePath, 'utf8');
  const format = detectFormat(filePath);
  return parseRecipe(text, format);
}

// --------------------------------------------------------------------------
// Validation
// --------------------------------------------------------------------------

/**
 * Validate a recipe against an index. Checks structural integrity and that
 * all referenced skill IDs exist.
 *
 * @param {object} recipe
 * @param {object} index - parsed global.json
 * @returns {{valid: true, warnings: string[]} | never throws RecipeValidationError}
 */
export function validateRecipe(recipe, index) {
  if (!recipe || typeof recipe !== 'object') {
    throw new RecipeValidationError('recipe must be an object');
  }
  if (!Array.isArray(recipe.steps) || recipe.steps.length === 0) {
    throw new RecipeValidationError('recipe must have a non-empty steps array');
  }

  const errors = [];
  const knownSkills = new Set(
    (Array.isArray(index && index.skills) ? index.skills : []).map(s => s && s.id).filter(Boolean)
  );

  for (let i = 0; i < recipe.steps.length; i++) {
    const step = recipe.steps[i];
    if (!step || typeof step !== 'object') {
      errors.push(`step ${i + 1}: must be an object`);
      continue;
    }
    if (typeof step.skill !== 'string' || step.skill.length === 0) {
      errors.push(`step ${i + 1}: skill must be a non-empty string`);
      continue;
    }
    if (!knownSkills.has(step.skill)) {
      errors.push(`step ${i + 1}: unknown skill id "${step.skill}"`);
    }
    if (step.on_failure != null && !FAILURE_BEHAVIORS.has(step.on_failure)) {
      errors.push(`step ${i + 1}: on_failure must be 'stop' or 'continue', got ${JSON.stringify(step.on_failure)}`);
    }
  }

  if (errors.length > 0) {
    throw new RecipeValidationError(
      `recipe has ${errors.length} error(s): ${errors[0]}`,
      errors
    );
  }

  return { valid: true, warnings: [] };
}

// --------------------------------------------------------------------------
// Execution
// --------------------------------------------------------------------------

/**
 * Write activation log events for a recipe step.
 *
 * @param {object} recipe
 * @param {number} stepIndex
 * @param {object} opts
 * @param {string} [opts.outcome='success']
 * @param {Date} [opts.now]
 * @returns {object} the written event
 */
export function buildRecipeEvent(recipe, stepIndex, opts = {}) {
  const step = recipe.steps[stepIndex];
  const now = (opts.now || new Date()).toISOString();
  return {
    skill: step.skill,
    timestamp: now,
    outcome: typeof opts.outcome === 'string' ? opts.outcome : 'success',
    source: RECIPE_SOURCE,
    recipe: recipe.name || '(unnamed)',
    step: stepIndex + 1,
  };
}

/**
 * Run a recipe. For each step, writes a usage log entry to today's log file.
 *
 * @param {object} recipe
 * @param {object} index - parsed global.json (used only to validate skill IDs)
 * @param {object} [opts]
 * @param {string} [opts.logDir] - defaults to ~/.meta-skills/logs
 * @param {boolean} [opts.dryRun=true]
 * @param {boolean} [opts.stopOnFailure=true]
 * @returns {{executed: number, failed: number, results: Array<{step: number, skill: string, outcome: string, written: boolean, halted: boolean}>}}
 */
export async function runRecipe(recipe, index, opts = {}) {
  if (!recipe || !Array.isArray(recipe.steps) || recipe.steps.length === 0) {
    throw new RecipeValidationError('recipe must have a non-empty steps array');
  }
  // Validate first (throws on hard errors).
  validateRecipe(recipe, index);

  const logDir = opts.logDir || path.join(os.homedir(), '.meta-skills', 'logs');
  const dryRun = opts.dryRun !== false; // default true
  // stopOnFailure is parsed for forward-compat with v1.9+ failure simulation,
  // but in v1.8 every step runs to completion (no failure injection yet).
  const stopOnFailure = opts.stopOnFailure !== false;

  const results = [];

  for (let i = 0; i < recipe.steps.length; i++) {
    const step = recipe.steps[i];
    const event = buildRecipeEvent(recipe, i);

    if (!dryRun) {
      fs.mkdirSync(logDir, { recursive: true });
      const filePath = path.join(logDir, todayLogFilename());
      fs.appendFileSync(filePath, JSON.stringify(event) + '\n', 'utf8');
    }

    results.push({
      step: i + 1,
      skill: step.skill,
      outcome: event.outcome,
      written: !dryRun,
      on_failure: step.on_failure,
      stopOnFailure,
    });
  }

  return {
    executed: results.length,
    failed: 0,
    results,
    dryRun,
  };
}

/**
 * Initialize a starter recipe file at `outPath`.
 *
 * @param {string} name
 * @param {object} [opts]
 * @param {string} [opts.outPath]
 * @returns {string} the file path written
 */
export function initRecipe(name, opts = {}) {
  const slug = String(name || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) {
    throw new RecipeParseError('recipe name must produce a non-empty slug');
  }
  const fileName = `${slug}.recipe`;
  const outPath = opts.outPath || path.join(process.cwd(), fileName);

  const text = [
    `# name: ${slug}`,
    `# description: my multi-step ${slug} workflow`,
    '',
    `# Edit the step lines below to reference real skill IDs from`,
    `# ~/.meta-skills/global.json. Each line is: step <skill-id>: <description>`,
    `step validate: run validation checks first`,
    `step changelog: generate changelog entries`,
    `step commit: commit changes with conventional message`,
    '',
    `# Or use the JSON variant — same content, structured:`,
    `# {`,
    `#   "name": "${slug}",`,
    `#   "description": "my multi-step ${slug} workflow",`,
    `#   "steps": [`,
    `#     { "skill": "validate", "description": "run validation", "on_failure": "stop" },`,
    `#     { "skill": "changelog", "on_failure": "continue" },`,
    `#     { "skill": "commit", "on_failure": "stop" }`,
    `#   ]`,
    `# }`,
    '',
  ].join('\n');

  fs.writeFileSync(outPath, text, 'utf8');
  return outPath;
}

// --------------------------------------------------------------------------
// CLI entry (when run directly via `node src/recipe-runner.mjs`)
// --------------------------------------------------------------------------

const isMain = process.argv[1] && (process.argv[1].endsWith('recipe-runner.mjs') || process.argv[1].endsWith('recipe-runner'));

if (isMain) {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === 'validate') {
    const file = args[1];
    if (!file) {
      console.error('recipe-runner validate: file argument required');
      process.exit(1);
    }
    try {
      const recipe = readRecipe(file);
      // Try to read index for skill validation
      const globalPath = path.join(os.homedir(), '.meta-skills', 'global.json');
      let index = { skills: [] };
      try { index = JSON.parse(fs.readFileSync(globalPath, 'utf8')); } catch { /* ignore */ }
      validateRecipe(recipe, index);
      console.log(`✓ recipe valid: ${recipe.steps.length} step(s)`);
    } catch (err) {
      console.error(`✗ ${err.message}`);
      process.exit(1);
    }
  } else if (cmd === 'init') {
    const name = args[1];
    if (!name) {
      console.error('recipe-runner init: name argument required');
      process.exit(1);
    }
    const out = initRecipe(name);
    console.log(`✓ recipe scaffolded: ${out}`);
  } else if (cmd === 'run') {
    const file = args[1];
    if (!file) {
      console.error('recipe-runner run: file argument required');
      process.exit(1);
    }
    const dryRun = !args.includes('--write');
    const continueOnFailure = args.includes('--continue-on-failure');
    try {
      const recipe = readRecipe(file);
      const globalPath = path.join(os.homedir(), '.meta-skills', 'global.json');
      let index = { skills: [] };
      try { index = JSON.parse(fs.readFileSync(globalPath, 'utf8')); } catch { /* ignore */ }
      runRecipe(recipe, index, { dryRun, stopOnFailure: !continueOnFailure }).then(r => {
        console.log(`recipe ${recipe.name || '(unnamed)'}: ${r.executed} step(s) ${dryRun ? 'previewed' : 'executed'}`);
        for (const res of r.results) {
          const tag = res.written ? '✓' : '~';
          console.log(`  ${tag} step ${res.step}: ${res.skill} (${res.outcome})`);
        }
        if (dryRun) console.log('\n(dry-run — pass --write to actually log activations)');
      }).catch(err => {
        console.error(`✗ ${err.message}`);
        process.exit(1);
      });
    } catch (err) {
      console.error(`✗ ${err.message}`);
      process.exit(1);
    }
  } else {
    console.log('Usage: node src/recipe-runner.mjs <validate|init|run> <file-or-name>');
  }
}