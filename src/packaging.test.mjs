#!/usr/bin/env node

/**
 * Tests for meta-skills v0.2.3 - npm publish packaging guards
 * Zero-dependency; uses node:test-free assert style consistent with repo.
 *
 * Verifies the package is publish-ready:
 *   - bin entry points at an existing file with a POSIX shebang
 *   - version is valid semver on the v0.x release line
 *   - every `files` entry exists
 *   - engines.node is declared
 *   - prepublishOnly guard runs the test suite
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBaseline } from './reputation.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;

function t(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL - ${name}`);
    console.error(`    ${err.message}`);
  }
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

console.log('packaging.test.mjs');

t('bin entry exists and points at a real file', () => {
  assert.ok(pkg.bin && typeof pkg.bin === 'object', 'package.json must declare a bin object');
  const target = pkg.bin['meta-skills'];
  assert.ok(target, 'bin must map the "meta-skills" command');
  const binPath = path.join(root, target);
  assert.ok(fs.existsSync(binPath), `bin target missing: ${target}`);
  assert.ok(fs.statSync(binPath).isFile(), `bin target is not a file: ${target}`);
});

t('bin target starts with a POSIX node shebang', () => {
  const binPath = path.join(root, pkg.bin['meta-skills']);
  const head = fs.readFileSync(binPath, 'utf8').slice(0, 64);
  assert.ok(head.startsWith('#!/usr/bin/env node'), 'cli entry needs "#!/usr/bin/env node" so npm can exec it');
});

t('version is valid semver on the v0.x release line', () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, `not plain semver: ${pkg.version}`);
  assert.ok(pkg.version.startsWith('0.'), `expected 0.x release line, got ${pkg.version}`);
});

t('every files[] entry exists', () => {
  assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0, 'package.json must declare files[]');
  for (const entry of pkg.files) {
    const p = path.join(root, entry);
    assert.ok(fs.existsSync(p), `files[] entry missing: ${entry}`);
  }
});

t('engines.node is declared', () => {
  assert.ok(pkg.engines && typeof pkg.engines.node === 'string' && pkg.engines.node.length > 0,
    'engines.node required so npm warns on unsupported runtimes');
});

t('prepublishOnly guard runs the test suite', () => {
  assert.strictEqual(pkg.scripts && pkg.scripts.prepublishOnly, 'npm test',
    'prepublishOnly must be "npm test" so publish refuses on red tests');
});

t('test script includes the packaging test itself', () => {
  assert.ok(pkg.scripts && /packaging\.test\.mjs/.test(pkg.scripts.test),
    'npm test must run packaging.test.mjs');
});

t('files[] covers every root-level runtime read path', () => {
  const srcDir = path.join(root, 'src');
  const srcFiles = fs.readdirSync(srcDir).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'));
  const reads = new Set();
  const re = /__dirname,\s*'\.\.'(?:,\s*'([^']+)')?/g;
  for (const f of srcFiles) {
    const text = fs.readFileSync(path.join(srcDir, f), 'utf8');
    for (const m of text.matchAll(re)) {
      // Directory reads only; root files like package.json are always shipped by npm.
      if (m[1] && !m[1].includes('.')) reads.add(m[1]);
    }
  }
  // package.json reads need no coverage - npm always ships it (dot-filter above).
  const covered = new Set((pkg.files || []).map((e) => e.replace(/\/+$/, '')));
  for (const dir of reads) {
    assert.ok(covered.has(dir), `runtime reads ${dir}/ but it is not in package.json files[]`);
  }
});

t('reputation baseline is bundled and loadBaseline() resolves to it', () => {
  const file = path.join(root, 'data', 'reputation-baseline.json');
  assert.ok(fs.existsSync(file), 'data/reputation-baseline.json must ship with the package');
  const direct = JSON.parse(fs.readFileSync(file, 'utf8'));
  const viaModule = loadBaseline();
  assert.strictEqual(
    Object.keys(viaModule.repos).length,
    Object.keys(direct.repos || {}).length,
    'loadBaseline() default path must resolve to the bundled baseline'
  );
});

console.log(`\npackaging: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
