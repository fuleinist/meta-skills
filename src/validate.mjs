#!/usr/bin/env node

/**
 * meta-skills v1.1 — Schema Validator
 *
 * Validates meta-skills JSON files against the v1 schema.
 *
 * Usage: node src/validate.mjs [--schema <path>] [files...]
 *   node src/validate.mjs ~/.meta-skills/global.json
 *   node src/validate.mjs .meta-skills/project.json --schema schema/v1.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSemver, checkEngines } from './semver-compat.mjs';
import { validatePermissions } from './permissions.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCHEMA = path.resolve(__dirname, '..', 'schema', 'v1.json');

// ── Inline JSON Schema validator (no deps) ────────────────────────────
// Validates the subset of JSON Schema Draft-07 that our schema uses.

function validateAgainstSchema(data, schema) {
  const errors = [];
  const rootDefinitions = schema.definitions || {};

  function _validate(value, schema, pathStr, definitions) {
    definitions = definitions || rootDefinitions;
    if (schema === null || schema === undefined) return;

    // type check
    if (schema.type) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      const actualType = Array.isArray(value) ? 'array' : typeof value;
      const actualTypeMapped = actualType === 'number' && types.includes('integer') ? 'integer' : actualType;
      const nullOk = types.includes('null');
      if (value === null && nullOk) { /* null is ok */ }
      else if (!types.includes(actualTypeMapped) && !types.includes(actualType)) {
        errors.push(`${pathStr}: expected type ${schema.type}, got ${actualType}`);
        return;
      }
    }

    // enum check
    if (schema.enum && !schema.enum.includes(value)) {
      errors.push(`${pathStr}: must be one of [${schema.enum.join(', ')}], got "${value}"`);
    }

    // pattern check (string)
    if (schema.pattern && typeof value === 'string') {
      const re = new RegExp(schema.pattern);
      if (!re.test(value)) {
        errors.push(`${pathStr}: does not match pattern ${schema.pattern}`);
      }
    }

    // format check
    if (schema.format === 'date-time' && typeof value === 'string') {
      const ts = Date.parse(value);
      if (isNaN(ts)) {
        errors.push(`${pathStr}: invalid date-time format "${value}"`);
      }
    }

    // maxLength
    if (schema.maxLength && typeof value === 'string' && value.length > schema.maxLength) {
      errors.push(`${pathStr}: exceeds maxLength ${schema.maxLength} (${value.length})`);
    }

    // minimum
    if (schema.minimum !== undefined && typeof value === 'number' && value < schema.minimum) {
      errors.push(`${pathStr}: less than minimum ${schema.minimum} (${value})`);
    }

    // required properties (object)
    if (schema.required && Array.isArray(schema.required) && typeof value === 'object' && !Array.isArray(value)) {
      for (const req of schema.required) {
        if (!(req in value)) {
          errors.push(`${pathStr}: missing required property "${req}"`);
        }
      }
    }

    // properties (object)
    if (schema.properties && typeof value === 'object' && !Array.isArray(value)) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in value) {
          _validate(value[key], propSchema, `${pathStr}.${key}`, definitions);
        }
      }
    }

    // additionalProperties
    if (schema.additionalProperties === false && typeof value === 'object' && !Array.isArray(value)) {
      const allowed = new Set(Object.keys(schema.properties || {}));
      for (const key of Object.keys(value)) {
        if (!allowed.has(key) && key !== '$schema') {
          errors.push(`${pathStr}: unexpected property "${key}"`);
        }
      }
    }

    // items (array)
    if (schema.items && Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        _validate(value[i], schema.items, `${pathStr}[${i}]`, definitions);
      }
    }

    // $ref
    if (schema.$ref) {
      const defName = schema.$ref.replace('#/definitions/', '');
      const def = definitions[defName];
      if (def) {
        _validate(value, def, pathStr, definitions);
      }
    }
  }

  _validate(data, schema, '');
  return errors;
}

// ── Engine compatibility checker (v0.1.1) ────────────────────────────

function parseSemverRange(range) {
  // Supports: >=X.Y.Z, ^X.Y.Z, ~X.Y.Z, X.Y.Z, * (any)
  if (!range || range === '*') return { op: 'any', major: 0, minor: 0, patch: 0 };
  const m = range.match(/^(>=|\^|~)?(\d+)\.(\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  const op = m[1] || '>=';
  const major = parseInt(m[2], 10);
  const minor = parseInt(m[3], 10);
  const patch = m[4] !== undefined ? parseInt(m[4], 10) : 0;
  return { op, major, minor, patch };
}

function semverGte(actual, required) {
  // actual and required are {major, minor, patch}
  if (actual.major !== required.major) return actual.major >= required.major;
  if (actual.minor !== required.minor) return actual.minor >= required.minor;
  return actual.patch >= required.patch;
}

function checkEngineRange(current, rangeStr) {
  const req = parseSemverRange(rangeStr);
  if (!req || req.op === 'any') return true;
  const cur = { major: process.version.replace('v', '').split('.').map(Number)[0],
                minor: process.version.replace('v', '').split('.')[1],
                patch: process.version.replace('v', '').split('.')[2] };
  if (req.op === '^') return semverGte(cur, req);
  if (req.op === '~') {
    // tilde: same major.minor, patch >= required
    return cur.major === req.major && cur.minor === req.minor && cur.patch >= req.patch;
  }
  // >=
  return semverGte(cur, req);
}

function checkSkillEngines(index) {
  const warnings = [];
  const nodeConstraint = index?.skills?.flatMap(s => s.engines?.node ? [s.engines.node] : []).pop();
  // Check each skill with an engines constraint
  for (const skill of index.skills || []) {
    if (!skill.engines?.node) continue;
    if (!checkEngineRange(process.version, skill.engines.node)) {
      warnings.push(`${skill.id}: requires node ${skill.engines.node}, current is ${process.version}`);
    }
  }
  return warnings;
}

// ── Main ──────────────────────────────────────────────────────────────

function main(options) {
  const opts = options || {};
  let schemaPath = opts.schemaPath || DEFAULT_SCHEMA;
  const files = opts.files || [];
  const checkEnginesFlag = opts.checkEngines || false;

  // If called standalone (no options), parse from argv
  if (!opts || Object.keys(opts).length === 0) {
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--schema' && i + 1 < args.length) {
        schemaPath = path.resolve(args[++i]);
      } else if (args[i] === '--check-engines') {
        // flag handled below via opts
      } else {
        files.push(path.resolve(args[i]));
      }
    }
    if (args.includes('--check-engines')) opts.checkEngines = true;
  }

  // Load schema
  let schema;
  try {
    schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
  } catch (e) {
    console.error(`✗ cannot load schema: ${schemaPath} — ${e.message}`);
    process.exit(1);
  }

  if (files.length === 0) {
    console.log(`Usage: node src/validate.mjs [--schema <path>] <file1.json> [file2.json ...]`);
    process.exit(0);
  }

  let totalErrors = 0;
  for (const filePath of files) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (e) {
      console.error(`✗ ${filePath}: cannot parse — ${e.message}`);
      totalErrors++;
      continue;
    }

    const errors = validateAgainstSchema(data, schema);

    // v0.1.1 — semver compatibility check on skill entries
    const semverIssues = [];
    if (Array.isArray(data.skills)) {
      for (const skill of data.skills) {
        if (skill.engines) {
          const engResult = checkEngines(skill.engines);
          if (!engResult.compatible) {
            for (const issue of engResult.issues) {
              semverIssues.push(`[${skill.id}] ${issue}`);
            }
          }
        }
        // Warn on deprecated skills still in active list
        if (skill.deprecated && skill.priority !== 'archived') {
          semverIssues.push(`[${skill.id}] deprecated but still active (successor: ${skill.successor || 'none'})`);
        }
      }
    }

    // v0.1.5 — permissions manifest validation
    const permIssues = [];
    if (Array.isArray(data.skills)) {
      for (const skill of data.skills) {
        const permResult = validatePermissions(skill);
        if (!permResult.valid) {
          for (const inv of permResult.invalid) {
            permIssues.push(`[${skill.id}] ${inv}`);
          }
          for (const unk of permResult.unknown) {
            permIssues.push(`[${skill.id}] unknown permission "${unk}"`);
          }
        }
      }
    }

    if (errors.length === 0 && semverIssues.length === 0 && permIssues.length === 0) {
      console.log(`✓ ${filePath}: valid`);
    } else {
      if (errors.length > 0) {
        console.log(`✗ ${filePath}: ${errors.length} schema error(s)`);
        for (const err of errors) {
          console.log(`    ${err}`);
        }
        totalErrors += errors.length;
      }
      if (semverIssues.length > 0) {
        console.log(`  ⚠ ${semverIssues.length} compatibility warning(s):`);
        for (const w of semverIssues) {
          console.log(`    ${w}`);
        }
        totalErrors += semverIssues.length;
      }
      if (permIssues.length > 0) {
        console.log(`  ✗ ${permIssues.length} permission error(s):`);
        for (const p of permIssues) {
          console.log(`    ${p}`);
        }
        totalErrors += permIssues.length;
      }
    }

    // Engine compatibility warnings (non-fatal)
    if (checkEnginesFlag) {
      const warnings = checkSkillEngines(data);
      for (const w of warnings) {
        console.log(`⚠ ${filePath}: ${w}`);
      }
    }
  }

  process.exit(totalErrors > 0 ? 1 : 0);
}

const isMain = process.argv[1] && (process.argv[1] === fileURLToPath(import.meta.url) || process.argv[1].endsWith('validate.mjs'));
if (isMain) main({});

export { main, validateAgainstSchema, parseSemverRange, checkSkillEngines };
