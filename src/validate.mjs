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

// ── Main ──────────────────────────────────────────────────────────────

function main(options) {
  const opts = options || {};
  let schemaPath = opts.schemaPath || DEFAULT_SCHEMA;
  const files = opts.files || [];

  // If called standalone (no options), parse from argv
  if (!opts || Object.keys(opts).length === 0) {
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--schema' && i + 1 < args.length) {
        schemaPath = path.resolve(args[++i]);
      } else {
        files.push(path.resolve(args[i]));
      }
    }
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
    if (errors.length === 0) {
      console.log(`✓ ${filePath}: valid`);
    } else {
      console.log(`✗ ${filePath}: ${errors.length} error(s)`);
      for (const err of errors) {
        console.log(`    ${err}`);
      }
      totalErrors += errors.length;
    }
  }

  process.exit(totalErrors > 0 ? 1 : 0);
}

const isMain = process.argv[1] && (process.argv[1] === fileURLToPath(import.meta.url) || process.argv[1].endsWith('validate.mjs'));
if (isMain) main({});

export { main, validateAgainstSchema };
