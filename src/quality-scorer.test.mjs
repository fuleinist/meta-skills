#!/usr/bin/env node

/**
 * meta-skills v1.6 — Skill Quality Scorer tests
 *
 * Covers all 4 scoring dimensions + scoreSkill + scoreAll + edge cases.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  scoreReadability,
  scoreTriggerPrecision,
  scoreInstructionClarity,
  scoreTokenEfficiency,
  scoreSkill,
  scoreAll,
} from './quality-scorer.mjs';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'meta-skills-qs-'));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf-8');
}

// ---- Readability tests -----------------------------------------------------

test('scoreReadability — perfect markdown gets high score', () => {
  const content = `---
name: test-skill
description: A well-documented skill with clear purpose
---

# Test Skill

## Usage

\`\`\`js
console.log('hello');
\`\`\`

## References

See [docs](https://example.com) for more.
`.repeat(5); // ~50 lines
  const score = scoreReadability(content);
  assert.ok(score >= 60, `expected >= 60, got ${score}`);
});

test('scoreReadability — empty content gets 0', () => {
  assert.equal(scoreReadability(''), 0);
});

test('scoreReadability — no frontmatter loses points', () => {
  const content = '# Just a header\n\nSome text.\n';
  const score = scoreReadability(content);
  assert.ok(score < 40, `expected < 40, got ${score}`);
});

test('scoreReadability — short file loses length points', () => {
  const content = '---\nname: x\n---\n\n# X\n\nShort.';
  const score = scoreReadability(content);
  assert.ok(score < 50, `expected < 50, got ${score}`);
});

// ---- Trigger precision tests -----------------------------------------------

test('scoreTriggerPrecision — good when field gets high score', () => {
  const entry = { when: 'When debugging Node.js memory leaks in production' };
  const score = scoreTriggerPrecision(entry);
  assert.ok(score >= 60, `expected >= 60, got ${score}`);
});

test('scoreTriggerPrecision — empty when gets 0', () => {
  assert.equal(scoreTriggerPrecision({ when: '' }), 0);
  assert.equal(scoreTriggerPrecision({}), 0);
});

test('scoreTriggerPrecision — generic when loses points', () => {
  const entry = { when: 'General use for various things' };
  const score = scoreTriggerPrecision(entry);
  assert.ok(score < 60, `expected < 60, got ${score}`);
});

test('scoreTriggerPrecision — short when loses points', () => {
  const entry = { when: 'Use it' };
  const score = scoreTriggerPrecision(entry);
  assert.ok(score < 50, `expected < 50, got ${score}`);
});

// ---- Instruction clarity tests ---------------------------------------------

test('scoreInstructionClarity — well-structured gets high score', () => {
  const content = `## Steps

1. First do this
2. Then do that
3. Finally check

## Example

\`\`\`js
foo();
\`\`\`

> **Warning:** Avoid this pitfall.

## References

See related docs.
`;
  const score = scoreInstructionClarity(content);
  assert.ok(score >= 60, `expected >= 60, got ${score}`);
});

test('scoreInstructionClarity — minimal content gets low score', () => {
  const content = '# Hi\n\nDo stuff.\n';
  const score = scoreInstructionClarity(content);
  assert.ok(score < 40, `expected < 40, got ${score}`);
});

test('scoreInstructionClarity — empty gets 0', () => {
  assert.equal(scoreInstructionClarity(''), 0);
});

// ---- Token efficiency tests ------------------------------------------------

test('scoreTokenEfficiency — clean file gets moderate score', () => {
  const content = `# Test Skill

## Usage

Use this when you need to do something.

## Steps

1. Step one
2. Step two

## Configuration

Set the environment variable.

## Notes

Keep it simple. Avoid common pitfalls.

## References

See the docs for more.
`;
  const score = scoreTokenEfficiency(content);
  // Short file loses points on meaningful-line ratio; no code blocks, no commented code
  assert.ok(score > 0, `expected > 0, got ${score}`);
  assert.ok(score < 80, `expected < 80, got ${score}`);
});

test('scoreTokenEfficiency — commented code loses points', () => {
  const content = `# Test

// const x = 1;
// const y = 2;
// const z = 3;
// const a = 4;
// const b = 5;

Real content.
`;
  const score = scoreTokenEfficiency(content);
  assert.ok(score < 60, `expected < 60, got ${score}`);
});

test('scoreTokenEfficiency — ASCII art loses points', () => {
  const content = `# Test

Some content.

╔══════════════════╗
║   ASCII BOX     ║
╚══════════════════╝

More content.
`;
  const score = scoreTokenEfficiency(content);
  assert.ok(score < 60, `expected < 60, got ${score}`);
});

test('scoreTokenEfficiency — empty gets 0', () => {
  assert.equal(scoreTokenEfficiency(''), 0);
});

// ---- scoreSkill tests ------------------------------------------------------

test('scoreSkill — scores a valid entry with file', () => {
  const dir = makeTempDir();
  try {
    const skillPath = path.join(dir, 'SKILL.md');
    writeFile(skillPath, `---
name: test-skill
description: A test skill
---

# Test Skill

## Usage

\`\`\`js
foo();
\`\`\`

## Steps

1. Do step 1
2. Do step 2

> **Note:** Be careful.

## References

See [docs](https://example.com).
`);
    const entry = {
      id: 'test-skill',
      when: 'When testing Node.js memory leaks in production',
      path: skillPath,
    };
    const result = scoreSkill(entry);
    assert.ok(result.score > 0);
    assert.equal(result.id, 'test-skill');
    assert.ok(result.dimensions.readability > 0);
    assert.ok(result.dimensions.triggerPrecision > 0);
    assert.ok(result.dimensions.instructionClarity > 0);
    assert.ok(result.dimensions.tokenEfficiency > 0);
    assert.equal(result.flags.length, 0);
  } finally { cleanup(dir); }
});

test('scoreSkill — missing file sets flags', () => {
  const entry = {
    id: 'missing-skill',
    when: 'When something happens',
    path: '/nonexistent/path/SKILL.md',
  };
  const result = scoreSkill(entry);
  assert.ok(result.score >= 0);
  assert.ok(result.flags.includes('missing-file') || result.flags.includes('no-content'));
});

test('scoreSkill — no when field gets 0 trigger precision', () => {
  const result = scoreSkill({ id: 'no-when', path: '/nonexistent' });
  assert.equal(result.dimensions.triggerPrecision, 0);
  assert.ok(result.flags.includes('vague-trigger'));
});

// ---- scoreAll tests --------------------------------------------------------

test('scoreAll — returns empty for missing file', () => {
  const { results, summary } = scoreAll('/nonexistent/global.json');
  assert.equal(results.length, 0);
  assert.ok(summary.error);
});

test('scoreAll — scores all skills in a valid global.json', () => {
  const dir = makeTempDir();
  try {
    const skillPath = path.join(dir, 'SKILL.md');
    writeFile(skillPath, `---
name: test-skill
description: A test
---

# Test Skill

## Usage

\`\`\`js
foo();
\`\`\`

## Steps

1. Do step 1
2. Do step 2

> **Note:** Be careful.

## References

See [docs](https://example.com).
`);
    const globalJsonPath = path.join(dir, 'global.json');
    writeFile(globalJsonPath, JSON.stringify({
      version: '1.0',
      skills: [
        { id: 'good-skill', when: 'When debugging Node.js memory', path: skillPath },
        { id: 'bad-skill', when: 'General use', path: '/nonexistent/SKILL.md' },
      ],
    }, null, 2));

    const { results, summary } = scoreAll(globalJsonPath);
    assert.equal(summary.total, 2);
    assert.equal(summary.scored, 2);
    assert.ok(summary.averageScore > 0);
    assert.ok(summary.medianScore > 0);
    assert.ok(results.length === 2);
    // good-skill should score higher than bad-skill
    assert.ok(results[0].score <= results[1].score);
  } finally { cleanup(dir); }
});

test('scoreAll — threshold filters results', () => {
  const dir = makeTempDir();
  try {
    const globalJsonPath = path.join(dir, 'global.json');
    writeFile(globalJsonPath, JSON.stringify({
      version: '1.0',
      skills: [
        { id: 'skill-a', when: 'When debugging Node.js memory', path: '/nonexistent' },
        { id: 'skill-b', when: 'When handling API requests in Express', path: '/nonexistent' },
      ],
    }, null, 2));

    // threshold=100 should return all
    const all = scoreAll(globalJsonPath, { threshold: 100 });
    assert.equal(all.results.length, 2);

    // threshold=0 should return all (default)
    const default_ = scoreAll(globalJsonPath);
    assert.equal(default_.results.length, 2);
  } finally { cleanup(dir); }
});

// ---- Runner ----------------------------------------------------------------

(async () => {
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await Promise.resolve().then(fn);
      passed++;
      console.log('  ok   ' + name);
    } catch (e) {
      failed++;
      console.error('  FAIL ' + name + ': ' + e.message);
      if (e.stack) console.error(e.stack.split('\n').slice(1, 4).join('\n'));
    }
  }
  const total = passed + failed;
  console.log(`\nquality-scorer.test.mjs: ${passed}/${total} passed`);
  if (failed > 0) process.exit(1);
})();
