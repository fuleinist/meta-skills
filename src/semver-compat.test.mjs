#!/usr/bin/env node

/**
 * Tests for semver-compat.mjs (v0.1.1)
 */

import { parseSemver, compareSemver, satisfies, checkEngines, checkDeprecation, validateDependencies } from './semver-compat.mjs';

let passed = 0;
let failed = 0;

function check(label, condition) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label}`); failed++; }
}

// ── parseSemver ───────────────────────────────────────────────────────
console.log('parseSemver:');
check('parses 1.2.3', JSON.stringify(parseSemver('1.2.3')) === JSON.stringify({ major: 1, minor: 2, patch: 3, prerelease: null, raw: '1.2.3' }));
check('parses with prerelease', parseSemver('2.0.0-alpha.1').prerelease === 'alpha.1');
check('returns null for invalid', parseSemver('abc') === null);
check('returns null for empty', parseSemver('') === null);
check('parses 0.1.0', parseSemver('0.1.0').major === 0);

// ── compareSemver ─────────────────────────────────────────────────────
console.log('\ncompareSemver:');
check('equal versions', compareSemver(parseSemver('1.2.3'), parseSemver('1.2.3')) === 0);
check('higher major', compareSemver(parseSemver('2.0.0'), parseSemver('1.0.0')) > 0);
check('lower major', compareSemver(parseSemver('1.0.0'), parseSemver('2.0.0')) < 0);
check('higher minor', compareSemver(parseSemver('1.2.0'), parseSemver('1.1.0')) > 0);
check('higher patch', compareSemver(parseSemver('1.1.2'), parseSemver('1.1.1')) > 0);
check('prerelease < release', compareSemver(parseSemver('1.0.0-alpha'), parseSemver('1.0.0')) < 0);

// ── satisfies ─────────────────────────────────────────────────────────
console.log('\nsatisfies:');
check('exact match', satisfies('1.2.3', '1.2.3'));
check('caret allows same major', satisfies('1.5.0', '^1.2.0'));
check('caret blocks major bump', !satisfies('2.0.0', '^1.2.0'));
check('tilde allows patch bump', satisfies('1.2.5', '~1.2.0'));
check('tilde blocks minor bump', !satisfies('1.3.0', '~1.2.0'));
check('gte', satisfies('2.0.0', '>=1.0.0'));
check('lt', satisfies('0.9.0', '<1.0.0'));
check('wildcard', satisfies('1.5.0', '*'));
check('comma AND', satisfies('1.5.0', '>=1.0.0, <2.0.0'));
check('hyphen range', satisfies('1.5.0', '1.0.0 - 2.0.0'));

// ── checkEngines ──────────────────────────────────────────────────────
console.log('\ncheckEngines:');
check('no engines is compatible', checkEngines(null).compatible);
check('missing engines is compatible', checkEngines({}).compatible);
check('matching engine is compatible', checkEngines({ 'meta-skills': '^1.0.0' }).compatible);
check('mismatched engine fails', !checkEngines({ 'meta-skills': '^2.0.0' }).compatible);

// ── checkDeprecation ──────────────────────────────────────────────────
console.log('\ncheckDeprecation:');
check('non-deprecated skill', !checkDeprecation({ id: 'test' }).deprecated);
check('deprecated skill', checkDeprecation({ id: 'old', deprecated: true }).deprecated);
check('deprecated has successor', checkDeprecation({ id: 'old', deprecated: true, successor: 'new' }).successor === 'new');
check('deprecated has warning', checkDeprecation({ id: 'old', deprecated: true }).warning.includes('old'));

// ── validateDependencies ──────────────────────────────────────────────
console.log('\nvalidateDependencies:');
const validIdx = { skills: [{ id: 'a', requires: ['b'] }, { id: 'b' }], stale: [] };
check('valid deps pass', validateDependencies(validIdx).valid);

const missingDep = { skills: [{ id: 'a', requires: ['missing'] }], stale: [] };
check('missing dep fails', !validateDependencies(missingDep).valid);
check('missing dep reports error', validateDependencies(missingDep).errors.length > 0);

const cycleIdx = { skills: [{ id: 'a', requires: ['b'] }, { id: 'b', requires: ['a'] }], stale: [] };
check('cycle detected', validateDependencies(cycleIdx).cycles.length > 0);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
