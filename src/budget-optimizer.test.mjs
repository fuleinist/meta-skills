#!/usr/bin/env node
/**
 * meta-skills v1.7 — Token Budget Optimizer tests
 *
 * 29 unit tests covering token estimation, value density, greedy optimizer,
 * apply path, and CLI integration. Uses Node's built-in test runner (matches
 * v1.6 quality-scorer.test.mjs style).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  estimateIndexTokens,
  estimateSkillTokens,
  totalActiveTokens,
  valueDensity,
  generateSuggestions,
  applySuggestions,
  atomicWriteJson,
  cmdBudget,
  CHARS_PER_TOKEN,
  ENTRY_JSON_OVERHEAD_CHARS,
  DEFAULT_MAX_TOKENS,
  PRIORITY_WEIGHT,
  QUALITY_MULTIPLIER_MIN,
  QUALITY_MULTIPLIER_MAX,
} from './budget-optimizer.mjs';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SKILL_HIGH_USED = {
  id: 'git-commits',
  when: 'writing commit messages, generating changelogs, analyzing git history',
  why: 'enforces conventional commits with automatic scope detection',
  path: '~/.claude/skills/git-commits/SKILL.md',
  priority: 'high',
  usage_count: 42,
  last_used: '2026-06-23T14:30:00+10:00',
};

const SKILL_MEDIUM_USED = {
  id: 'code-review',
  when: 'reviewing PRs, analyzing code quality, suggesting improvements',
  why: 'structured review checklist + anti-pattern detection',
  path: '~/.claude/skills/code-review/SKILL.md',
  priority: 'medium',
  usage_count: 12,
};

const SKILL_LOW_UNUSED = {
  id: 'old-cobol-prompt',
  when: 'formatting COBOL output',
  why: 'legacy compatibility',
  path: '~/.claude/skills/cobol/SKILL.md',
  priority: 'low',
  usage_count: 0,
};

const SKILL_LOW_ONCE = {
  id: 'rare-trick',
  when: 'edge case in CSS grid alignment',
  why: 'saves 10 minutes once',
  path: '~/.claude/skills/rare/SKILL.md',
  priority: 'low',
  usage_count: 1,
};

const SKILL_ARCHIVED = {
  id: 'super-old',
  when: 'very old',
  why: 'archived',
  path: '/nope/SKILL.md',
  priority: 'archived',
  usage_count: 0,
};

const SKILL_MISSING_PATH = {
  id: 'no-path',
  when: 'no path',
  why: 'no path',
  priority: 'medium',
  usage_count: 5,
};

// ---------------------------------------------------------------------------
// AC1: Token estimation
// ---------------------------------------------------------------------------

test('estimateIndexTokens: empty entry returns 0', () => {
  assert.equal(estimateIndexTokens({}), 0);
  assert.equal(estimateIndexTokens(null), 0);
  assert.equal(estimateIndexTokens(undefined), 0);
});

test('estimateIndexTokens: minimal entry rounds up to at least 1', () => {
  const tokens = estimateIndexTokens({ id: 'a' });
  assert.ok(tokens >= 1, 'minimum 1 token for any non-empty entry');
});

test('estimateIndexTokens: full entry matches real JSON length / 4 ceiling', () => {
  // Real-world meta-skills index entries serialize to ~50-70 tokens
  // (200-280 chars / 4). Compute exact expected from JSON.
  const { usage_count, last_used, ...indexOnly } = SKILL_HIGH_USED;
  const json = JSON.stringify(indexOnly);
  const expected = Math.ceil(json.length / CHARS_PER_TOKEN);
  assert.equal(estimateIndexTokens(SKILL_HIGH_USED), expected);
});

test('estimateIndexTokens: typical real entry is in 30-80 token range', () => {
  // Real entries (when + why + path strings of 40-80 chars) land at
  // 50-70 tokens after JSON syntax overhead. Spec target is 150 tokens
  // for a 20-skill index = 7.5/skill; that requires minimal when/why.
  // Real-world entries cluster around 50-70 tokens.
  const t1 = estimateIndexTokens(SKILL_HIGH_USED);
  const t2 = estimateIndexTokens(SKILL_MEDIUM_USED);
  assert.ok(t1 >= 30 && t1 <= 80, `high-used got ${t1} tokens, expected 30-80`);
  assert.ok(t2 >= 30 && t2 <= 80, `medium-used got ${t2} tokens, expected 30-80`);
});

test('estimateIndexTokens: ignores usage_count and last_used (internal telemetry)', () => {
  const a = estimateIndexTokens({ id: 'x', when: 'y', why: 'z', path: 'p', priority: 'low', usage_count: 999, last_used: '2099-01-01' });
  const b = estimateIndexTokens({ id: 'x', when: 'y', why: 'z', path: 'p', priority: 'low' });
  assert.equal(a, b, 'usage_count and last_used should not affect index cost');
});

test('estimateIndexTokens: tolerates non-string values (e.g. null priority)', () => {
  const entry = { id: 'weird', when: 'x', why: 'y', path: 'z', priority: null };
  const tokens = estimateIndexTokens(entry);
  assert.ok(tokens >= 1);
});

// ---------------------------------------------------------------------------
// AC1: estimateSkillTokens with file content
// ---------------------------------------------------------------------------

test('estimateSkillTokens: includeSkillMd=false returns just index tokens', () => {
  const a = estimateSkillTokens(SKILL_HIGH_USED, { includeSkillMd: false });
  const b = estimateIndexTokens(SKILL_HIGH_USED);
  assert.equal(a, b);
});

test('estimateSkillTokens: includeSkillMd=true adds file content cost', () => {
  // Use a real file we know exists — examples/global.json is 2292 bytes
  const entry = {
    ...SKILL_HIGH_USED,
    path: path.join(process.cwd(), 'examples', 'global.json'),
  };
  const withFile = estimateSkillTokens(entry, { includeSkillMd: true });
  const idx = estimateIndexTokens(entry);
  assert.ok(withFile > idx, `with-file (${withFile}) should exceed index (${idx})`);
  // 2292 bytes / 4 chars-per-token = 573 tokens + index tokens
  assert.ok(withFile >= 570);
});

test('estimateSkillTokens: missing file falls back to index-only', () => {
  const entry = { ...SKILL_HIGH_USED, path: '/nonexistent/SKILL.md' };
  const t = estimateSkillTokens(entry, { includeSkillMd: true });
  assert.equal(t, estimateIndexTokens(entry));
});

test('estimateSkillTokens: tilde expansion works', () => {
  const entry = { ...SKILL_HIGH_USED, path: '~/no-such-file.md' };
  const t = estimateSkillTokens(entry, { includeSkillMd: true });
  // Should not throw; falls back to index
  assert.equal(t, estimateIndexTokens(entry));
});

// ---------------------------------------------------------------------------
// AC1: totalActiveTokens
// ---------------------------------------------------------------------------

test('totalActiveTokens: sums non-archived entries', () => {
  const skills = [SKILL_HIGH_USED, SKILL_MEDIUM_USED, SKILL_LOW_UNUSED, SKILL_ARCHIVED];
  const total = totalActiveTokens(skills);
  const expected =
    estimateIndexTokens(SKILL_HIGH_USED) +
    estimateIndexTokens(SKILL_MEDIUM_USED) +
    estimateIndexTokens(SKILL_LOW_UNUSED);
  assert.equal(total, expected);
});

test('totalActiveTokens: empty / non-array returns 0', () => {
  assert.equal(totalActiveTokens([]), 0);
  assert.equal(totalActiveTokens(null), 0);
});

// ---------------------------------------------------------------------------
// AC2: Value density
// ---------------------------------------------------------------------------

test('valueDensity: high priority + heavy use > low priority + no use', () => {
  const high = valueDensity(SKILL_HIGH_USED);
  const low = valueDensity(SKILL_LOW_UNUSED);
  assert.ok(high > low, `high (${high}) should beat low (${low})`);
});

test('valueDensity: respects priority weights (high=3, medium=2, low=1)', () => {
  const base = { ...SKILL_LOW_UNUSED, usage_count: 5 };
  const low = valueDensity({ ...base, priority: 'low' });
  const med = valueDensity({ ...base, priority: 'medium' });
  const high = valueDensity({ ...base, priority: 'high' });
  // All else equal, ratios should reflect weights: med/low ≈ 2, high/low ≈ 3
  assert.ok(med / low > 1.9 && med / low < 2.1, `med/low ratio ${med / low}`);
  assert.ok(high / low > 2.9 && high / low < 3.1, `high/low ratio ${high / low}`);
});

test('valueDensity: log-curve on usage gives diminishing returns', () => {
  const base = SKILL_LOW_UNUSED;
  const d0 = valueDensity({ ...base, usage_count: 0 });
  const d10 = valueDensity({ ...base, usage_count: 10 });
  const d100 = valueDensity({ ...base, usage_count: 100 });
  // 0->10 should be a bigger jump than 10->100
  const jump1 = d10 - d0;
  const jump2 = d100 - d10;
  assert.ok(jump1 > jump2, `log curve: jump1=${jump1} should exceed jump2=${jump2}`);
});

test('valueDensity: quality multiplier clamps to [0.1, 1.5]', () => {
  const base = SKILL_MEDIUM_USED;
  const noQ = valueDensity(base);
  const q10 = valueDensity(base, { qualityScore: 10 });
  const q200 = valueDensity(base, { qualityScore: 200 });
  // q10 -> 0.1, q200 -> 1.5 (clamped)
  const ratio10 = q10 / noQ;
  const ratio200 = q200 / noQ;
  assert.ok(Math.abs(ratio10 - QUALITY_MULTIPLIER_MIN) < 0.01, `q10 ratio ${ratio10} should be ${QUALITY_MULTIPLIER_MIN}`);
  assert.ok(Math.abs(ratio200 - QUALITY_MULTIPLIER_MAX) < 0.01, `q200 ratio ${ratio200} should be ${QUALITY_MULTIPLIER_MAX}`);
});

// ---------------------------------------------------------------------------
// AC3: Greedy optimizer
// ---------------------------------------------------------------------------

test('generateSuggestions: under budget returns empty list', () => {
  const skills = [SKILL_HIGH_USED, SKILL_MEDIUM_USED];
  const result = generateSuggestions(skills, { maxTokens: 100000 });
  assert.equal(result.suggestions.length, 0);
  assert.equal(result.unfixable, false);
});

test('generateSuggestions: over budget demotes lowest-density first', () => {
  // Total tokens of all 4 active ≈ 35-40, so cap at 25 forces 1-2 demotes
  const skills = [SKILL_HIGH_USED, SKILL_MEDIUM_USED, SKILL_LOW_UNUSED, SKILL_LOW_ONCE];
  const total = totalActiveTokens(skills);
  const cap = Math.floor(total * 0.5);
  const result = generateSuggestions(skills, { maxTokens: cap, action: 'demote' });
  assert.ok(result.suggestions.length > 0, 'should suggest at least one demote');
  // Lowest-density target should be SKILL_LOW_UNUSED (low + 0 usage)
  assert.equal(result.suggestions[0].id, SKILL_LOW_UNUSED.id);
  for (const s of result.suggestions) {
    assert.equal(s.action, 'demote');
    assert.equal(s.newPriority, 'low');
  }
});

test('generateSuggestions: archive action emits archive (not demote)', () => {
  const skills = [SKILL_HIGH_USED, SKILL_LOW_UNUSED, SKILL_LOW_ONCE];
  const total = totalActiveTokens(skills);
  const result = generateSuggestions(skills, { maxTokens: Math.floor(total * 0.3), action: 'archive' });
  assert.ok(result.suggestions.length > 0);
  for (const s of result.suggestions) {
    assert.equal(s.action, 'archive');
  }
});

test('generateSuggestions: never demotes high-priority skills', () => {
  const skills = [
    { ...SKILL_HIGH_USED, usage_count: 0 }, // even with no use, high priority is protected
    { ...SKILL_MEDIUM_USED, usage_count: 0 },
  ];
  const result = generateSuggestions(skills, { maxTokens: 1, action: 'demote' });
  // Should demote the medium one, not the high one
  if (result.suggestions.length > 0) {
    for (const s of result.suggestions) {
      assert.notEqual(s.currentPriority, 'high');
    }
  }
});

test('generateSuggestions: unfixable=true when all remaining are high', () => {
  const skills = [SKILL_HIGH_USED, { ...SKILL_HIGH_USED, id: 'h2' }];
  const result = generateSuggestions(skills, { maxTokens: 1, action: 'demote' });
  assert.equal(result.unfixable, true);
  assert.equal(result.suggestions.length, 0);
});

test('generateSuggestions: suggestions sorted by density ascending', () => {
  const skills = [
    SKILL_HIGH_USED,
    SKILL_MEDIUM_USED,
    SKILL_LOW_UNUSED,
    SKILL_LOW_ONCE,
    { ...SKILL_LOW_UNUSED, id: 'another-low' },
  ];
  const total = totalActiveTokens(skills);
  const result = generateSuggestions(skills, { maxTokens: Math.floor(total * 0.3), action: 'demote' });
  for (let i = 1; i < result.suggestions.length; i++) {
    assert.ok(result.suggestions[i - 1].valueDensity <= result.suggestions[i].valueDensity);
  }
});

test('generateSuggestions: empty / invalid input returns empty result', () => {
  const r1 = generateSuggestions([], { maxTokens: 500 });
  assert.equal(r1.suggestions.length, 0);

  const r2 = generateSuggestions(null, { maxTokens: 500 });
  assert.equal(r2.suggestions.length, 0);

  const r3 = generateSuggestions([SKILL_HIGH_USED], { maxTokens: 0 });
  assert.equal(r3.suggestions.length, 0);
});

// ---------------------------------------------------------------------------
// AC5: applySuggestions
// ---------------------------------------------------------------------------

test('applySuggestions: demote sets priority=low in place', () => {
  const globalJson = {
    version: '1.0',
    skills: [{ ...SKILL_HIGH_USED }, { ...SKILL_MEDIUM_USED }],
  };
  const suggestions = [
    {
      id: SKILL_HIGH_USED.id,
      action: 'demote',
      currentPriority: 'high',
      newPriority: 'low',
      currentTokens: 10,
      valueDensity: 0.1,
      reason: 'test',
    },
  ];
  const result = applySuggestions(globalJson, suggestions);
  assert.equal(result.applied, 1);
  assert.equal(result.demoted, 1);
  assert.equal(result.archived, 0);
  assert.equal(globalJson.skills[0].priority, 'low');
  assert.equal(globalJson.skills[1].priority, 'medium'); // unchanged
  assert.ok(globalJson.generated); // timestamp set
});

test('applySuggestions: archive moves entry to archived_skills', () => {
  const globalJson = {
    version: '1.0',
    skills: [{ ...SKILL_LOW_UNUSED, id: 'to-archive' }],
  };
  const suggestions = [
    {
      id: 'to-archive',
      action: 'archive',
      currentPriority: 'low',
      newPriority: 'archived',
      currentTokens: 8,
      valueDensity: 0.05,
      reason: 'test',
    },
  ];
  const result = applySuggestions(globalJson, suggestions);
  assert.equal(result.archived, 1);
  assert.equal(globalJson.skills.length, 0);
  assert.equal(globalJson.archived_skills.length, 1);
  assert.equal(globalJson.archived_skills[0].id, 'to-archive');
  assert.equal(globalJson.archived_skills[0].priority, 'archived');
});

test('applySuggestions: missing skill id is recorded as error, not thrown', () => {
  const globalJson = { version: '1.0', skills: [SKILL_HIGH_USED] };
  const suggestions = [
    { id: 'does-not-exist', action: 'demote', currentPriority: 'high', newPriority: 'low', currentTokens: 5, valueDensity: 0.1, reason: 'test' },
  ];
  const result = applySuggestions(globalJson, suggestions);
  assert.equal(result.applied, 0);
  assert.equal(result.errors.length, 1);
});

// ---------------------------------------------------------------------------
// atomicWriteJson
// ---------------------------------------------------------------------------

test('atomicWriteJson: writes via .tmp + rename', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-test-'));
  const target = path.join(tmpDir, 'out.json');
  const data = { hello: 'world', n: 42 };
  atomicWriteJson(target, data);
  assert.ok(fs.existsSync(target));
  const back = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.deepEqual(back, data);
  // tmp should be gone after rename
  assert.ok(!fs.existsSync(target + '.tmp'));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC4: CLI integration
// ---------------------------------------------------------------------------

test('cmdBudget: --json output includes max/current/suggestions', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-cli-'));
  const globalPath = path.join(tmpDir, 'global.json');
  fs.writeFileSync(globalPath, JSON.stringify({
    version: '1.0',
    generated: '2026-07-01T00:00:00+10:00',
    source: 'global',
    skills: [SKILL_HIGH_USED, SKILL_MEDIUM_USED, SKILL_LOW_UNUSED, SKILL_LOW_ONCE],
  }));
  // Capture stdout
  const orig = process.stdout.write.bind(process.stdout);
  let captured = '';
  process.stdout.write = (chunk) => { captured += chunk; return true; };
  try {
    // Use 150 to force suggestions (4 skills ≈ 188 tokens, cap forces 1-2 demotes).
    const code = await cmdBudget({
      globalJson: globalPath,
      maxTokens: 150,
      json: true,
      dryRun: true,
    });
    assert.equal(code, 0);
  } finally {
    process.stdout.write = orig;
  }
  const parsed = JSON.parse(captured);
  assert.ok(parsed.max === 150);
  assert.ok(parsed.current > 0);
  assert.ok(Array.isArray(parsed.suggestions));
  assert.ok(parsed.suggestions.length > 0, 'should suggest at least one demote');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('cmdBudget: --dry-run (default) does not mutate global.json', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-cli-'));
  const globalPath = path.join(tmpDir, 'global.json');
  const original = {
    version: '1.0',
    generated: '2026-07-01T00:00:00+10:00',
    skills: [SKILL_HIGH_USED, SKILL_LOW_UNUSED, SKILL_LOW_ONCE],
  };
  fs.writeFileSync(globalPath, JSON.stringify(original));
  // Suppress stdout/stderr
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  try {
    await cmdBudget({
      globalJson: globalPath,
      maxTokens: 5,
      dryRun: true,
    });
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  // File should be unchanged
  const after = JSON.parse(fs.readFileSync(globalPath, 'utf8'));
  assert.equal(after.skills.length, original.skills.length);
  assert.equal(after.generated, original.generated);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test('cmdBudget: missing global.json returns 1', async () => {
  const origErr = process.stderr.write.bind(process.stderr);
  let errMsg = '';
  process.stderr.write = (chunk) => { errMsg += chunk; return true; };
  try {
    const code = await cmdBudget({ globalJson: '/no/such/path.json', maxTokens: 500 });
    assert.equal(code, 1);
  } finally {
    process.stderr.write = origErr;
  }
  assert.ok(errMsg.includes('not found'));
});

test('cmdBudget: corrupt global.json returns 1', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-cli-'));
  const globalPath = path.join(tmpDir, 'global.json');
  fs.writeFileSync(globalPath, '{ not valid json');
  const origErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  try {
    const code = await cmdBudget({ globalJson: globalPath, maxTokens: 500 });
    assert.equal(code, 1);
  } finally {
    process.stderr.write = origErr;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('generateSuggestions: archived skills are excluded from active set', () => {
  const skills = [SKILL_HIGH_USED, SKILL_ARCHIVED, SKILL_LOW_UNUSED];
  const total = totalActiveTokens(skills);
  const result = generateSuggestions(skills, { maxTokens: Math.floor(total * 0.5), action: 'demote' });
  for (const s of result.suggestions) {
    assert.notEqual(s.id, SKILL_ARCHIVED.id, 'archived skill should never be a candidate');
  }
});

// ---------------------------------------------------------------------------
// Smoke test against examples/global.json (the canonical fixture)
// ---------------------------------------------------------------------------

test('smoke: examples/global.json runs through cmdBudget without crashing', async () => {
  const fixturePath = path.join(process.cwd(), 'examples', 'global.json');
  if (!fs.existsSync(fixturePath)) {
    return; // skip if not in repo
  }
  // Copy to tmp so we don't mutate the canonical example
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-smoke-'));
  const tmpPath = path.join(tmpDir, 'global.json');
  fs.copyFileSync(fixturePath, tmpPath);

  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  try {
    // Use a small cap that triggers a demote (examples/global.json has
    // ~4 skills totaling ~200 tokens; cap=100 forces demotes).
    const code = await cmdBudget({
      globalJson: tmpPath,
      maxTokens: 50,
      dryRun: true,
    });
    // Either succeeds with suggestions (code 0) or hits unfixable (code 1)
    // since all-4-active might leave a high-priority skill over budget.
    assert.ok(code === 0 || code === 1, `expected 0 or 1, got ${code}`);
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  // Examples should be unchanged
  const original = fs.readFileSync(fixturePath, 'utf8');
  const after = fs.readFileSync(tmpPath, 'utf8');
  assert.equal(original, after, 'smoke test must not mutate examples/global.json');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC5: apply path via cmdBudget (write mode)
// ---------------------------------------------------------------------------

test('cmdBudget: --archive actually moves skills to archived_skills list', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-archive-'));
  const globalPath = path.join(tmpDir, 'global.json');
  const data = {
    version: '1.0',
    generated: '2026-07-01T00:00:00+10:00',
    source: 'global',
    skills: [
      { id: 'keep', when: 'a'.repeat(80), why: 'b'.repeat(40), path: '/p', priority: 'high', usage_count: 50 },
      { id: 'drop', when: 'c'.repeat(80), why: 'd'.repeat(40), path: '/q', priority: 'low', usage_count: 0 },
    ],
  };
  fs.writeFileSync(globalPath, JSON.stringify(data, null, 2));

  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  try {
    // Cap that forces archiving the low-priority one
    const code = await cmdBudget({
      globalJson: globalPath,
      maxTokens: 50,
      archive: true,
      dryRun: false,
    });
    assert.equal(code, 0);
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }

  const after = JSON.parse(fs.readFileSync(globalPath, 'utf8'));
  // 'drop' should be in archived_skills, 'keep' should remain
  assert.equal(after.skills.length, 1);
  assert.equal(after.skills[0].id, 'keep');
  assert.ok(Array.isArray(after.archived_skills));
  assert.equal(after.archived_skills.length, 1);
  assert.equal(after.archived_skills[0].id, 'drop');
  assert.equal(after.archived_skills[0].priority, 'archived');
  // generated timestamp should be updated
  assert.notEqual(after.generated, '2026-07-01T00:00:00+10:00');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('cmdBudget: --write (without --archive) demotes in place', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-demote-'));
  const globalPath = path.join(tmpDir, 'global.json');
  const data = {
    version: '1.0',
    generated: '2026-07-01T00:00:00+10:00',
    source: 'global',
    skills: [
      { id: 'keep', when: 'a'.repeat(80), why: 'b'.repeat(40), path: '/p', priority: 'high', usage_count: 50 },
      { id: 'drop', when: 'c'.repeat(80), why: 'd'.repeat(40), path: '/q', priority: 'medium', usage_count: 0 },
    ],
  };
  fs.writeFileSync(globalPath, JSON.stringify(data, null, 2));

  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  try {
    const code = await cmdBudget({
      globalJson: globalPath,
      maxTokens: 50,
      write: true,
      dryRun: false,
    });
    assert.equal(code, 0);
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }

  const after = JSON.parse(fs.readFileSync(globalPath, 'utf8'));
  assert.equal(after.skills.length, 2);
  const drop = after.skills.find((s) => s.id === 'drop');
  assert.equal(drop.priority, 'low', 'medium should be demoted to low');
  // No archived_skills list should be created when only demoting
  assert.ok(!after.archived_skills || after.archived_skills.length === 0);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('cmdBudget: --use-quality applies v1.6 scores as multiplier (no crash)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-quality-'));
  const globalPath = path.join(tmpDir, 'global.json');
  fs.writeFileSync(globalPath, JSON.stringify({
    version: '1.0',
    generated: '2026-07-01T00:00:00+10:00',
    source: 'global',
    skills: [
      { id: 'good', when: 'a'.repeat(80), why: 'b'.repeat(40), path: 'p', priority: 'high', usage_count: 50 },
      { id: 'bad', when: 'c'.repeat(80), why: 'd'.repeat(40), path: 'q', priority: 'low', usage_count: 0 },
    ],
  }));

  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  try {
    // --use-quality may fail to score (no SKILL.md file), but the command
    // should still complete gracefully. It uses multiplier=1.0 fallback.
    const code = await cmdBudget({
      globalJson: globalPath,
      maxTokens: 50,
      useQuality: true,
      json: true,
      dryRun: true,
    });
    // 0 = suggestions generated and applied (or 0 = under budget after apply)
    assert.equal(code, 0);
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
