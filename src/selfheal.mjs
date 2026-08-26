#!/usr/bin/env node

/**
 * meta-skills v0.2.0 — Self-healing skill instructions
 *
 * When a skill fails (v1.3 auto-improvement trigger), package the failed
 * conversation prompt as a micro-test-case. Mutated skills must pass the
 * specific case + the wider baseline suite before approval — guaranteeing
 * zero-regression. Dynamic test cases live in ~/.meta-skills/tests/.
 *
 * Commands:
 *   selfheal capture <skill-id> --prompt <text> | --prompt-file <path> [--hint <t>]
 *   selfheal test <skill-id> [--skill-path <p>] [--threshold N] [--json]
 *   selfheal validate <skill-id> --mutated <path> [--skill-path <p>] [--threshold N] [--json]
 *   selfheal list [skill-id]
 *
 * Inspired by:
 *   - EvoSkill Pareto-filtered validation (keep only non-regressing variants)
 *   - Regression testing / TDD
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Defaults ───────────────────────────────────────────────────

const DEFAULT_THRESHOLD = 50;

function defaultTestsDir() {
  return path.join(os.homedir(), '.meta-skills', 'tests');
}

function defaultGlobalJson() {
  return path.join(os.homedir(), '.meta-skills', 'global.json');
}

// ── Keyword extraction ─────────────────────────────────────────

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'was', 'were', 'are', 'is',
  'from', 'have', 'has', 'had', 'not', 'but', 'you', 'your', 'our', 'its',
  'can', 'could', 'should', 'would', 'will', 'shall', 'please', 'when',
  'what', 'which', 'who', 'how', 'why', 'then', 'than', 'them', 'they',
  'there', 'here', 'into', 'out', 'about', 'after', 'before', 'over',
  'under', 'again', 'very', 'just', 'also', 'only', 'more', 'most', 'some',
  'any', 'all', 'each', 'every', 'been', 'being', 'does', 'did', 'doing',
  'want', 'need', 'make', 'made', 'using', 'use', 'used', 'like', 'get',
  'got', 'let', 'say', 'said', 'see', 'saw', 'one', 'two', 'now', 'still',
  'skill', 'failed', 'failure', 'error', 'meta', 'skills',
]);

/**
 * Extract deterministic keywords from arbitrary text.
 * Tokenize → lowercase → strip stopwords/markdown → len>=3 →
 * sort by (freq desc, alpha asc) → top max.
 * @param {string} text
 * @param {{max?: number}} [opts]
 * @returns {string[]}
 */
function extractKeywords(text, opts = {}) {
  const max = opts.max ?? 12;
  if (!text || typeof text !== 'string') return [];

  const cleaned = text
    .replace(/```[\s\S]*?```/g, ' ')   // strip code blocks
    .replace(/`[^`]*`/g, ' ')           // strip inline code
    .replace(/[#*_>\-\[\](){}|]/g, ' ') // strip markdown markers
    .toLowerCase();

  const freq = new Map();
  for (const raw of cleaned.split(/[^a-z0-9]+/)) {
    const tok = raw.trim();
    if (tok.length < 3 || STOPWORDS.has(tok) || /^\d+$/.test(tok)) continue;
    freq.set(tok, (freq.get(tok) || 0) + 1);
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([tok]) => tok);
}

// ── Hash / id ──────────────────────────────────────────────────

/** djb2 hash → 6-char base36 suffix (deterministic). */
function hash6(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  }
  return h.toString(36).padStart(6, '0').slice(-6);
}

function compactTs(iso) {
  return iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', 'T').slice(0, 15);
}

// ── Capture ────────────────────────────────────────────────────

/**
 * Package a failed-conversation prompt as a micro-test-case on disk.
 * @param {string} skillId
 * @param {string} prompt
 * @param {{hint?: string, source?: string, testsDir?: string, now?: Date}} [opts]
 * @returns {object} the written test case (incl. file path at `.file`)
 */
function captureTestCase(skillId, prompt, opts = {}) {
  if (!skillId) throw new Error('capture: skill-id required');
  if (!prompt || !prompt.trim()) throw new Error('capture: prompt required');

  const testsDir = opts.testsDir || defaultTestsDir();
  const now = opts.now || new Date();
  const iso = now.toISOString();
  const keywords = extractKeywords(prompt + ' ' + (opts.hint || ''));

  const testCase = {
    id: `tc-${compactTs(iso)}-${hash6(prompt)}`,
    skill_id: skillId,
    captured_at: iso,
    source: opts.source || 'manual',
    prompt: prompt.trim(),
    hint: opts.hint || '',
    keywords,
  };

  const dir = path.join(testsDir, skillId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${testCase.id}.json`);
  fs.writeFileSync(file, JSON.stringify(testCase, null, 2) + '\n', 'utf-8');

  return { ...testCase, file };
}

/**
 * Synthesize a micro-test-case from a v1.3 failure event when no recorded
 * prompt exists. Called by failure-analyzer during `propose`.
 * @param {string} skillId
 * @param {{timestamp?: string, hint?: string, reason?: string, reasons?: string[]}} event
 * @param {{testsDir?: string, now?: Date}} [opts]
 * @returns {object} the written test case
 */
function captureFromFailureEvent(skillId, event, opts = {}) {
  const ts = event.timestamp || new Date().toISOString();
  const reason = event.hint || event.reason || (event.reasons || [])[0] || 'no reason recorded';
  const prompt = [
    `Skill "${skillId}" failed at ${ts}.`,
    `Reason: ${reason}`,
    `Outcome: failure.`,
    `Reproduce the task this skill was activated for and verify the instructions now handle it.`,
  ].join('\n');
  return captureTestCase(skillId, prompt, {
    hint: reason,
    source: 'failure',
    testsDir: opts.testsDir,
    now: opts.now,
  });
}

// ── Scoring ────────────────────────────────────────────────────

function normalizeSkillText(content) {
  return content
    .replace(/```[\s\S]*?```/g, m => m.toLowerCase())
    .toLowerCase();
}

/**
 * Deterministic 0..100 score of how well a skill's instructions would
 * handle a captured test case.
 *   60 pts × keyword coverage
 *   20 pts structural guidance (numbered steps / checklists)
 *   20 pts caution guidance (avoid / do not / warning / anti-pattern)
 * @param {string} skillContent
 * @param {object} testCase
 * @returns {number}
 */
function scoreSkillAgainstCase(skillContent, testCase) {
  if (!skillContent || !testCase) return 0;
  const text = normalizeSkillText(skillContent);

  // Keyword coverage — 60 pts
  const kws = testCase.keywords || [];
  let coverage = 0;
  if (kws.length > 0) {
    const hits = kws.filter(k => text.includes(k)).length;
    coverage = hits / kws.length;
  } else {
    coverage = 1; // no keywords to miss
  }

  // Structural guidance — 20 pts
  const hasSteps = /^\s*(\d+\.|- \[[ x]\]|\* step)/m.test(skillContent)
    || /^\s*step \d+/im.test(skillContent);

  // Caution guidance — 20 pts
  const hasCaution = /\b(avoid|do not|don't|warning|caution|anti-?pattern|never)\b/i.test(skillContent);

  return Math.round(coverage * 60 + (hasSteps ? 20 : 0) + (hasCaution ? 20 : 0));
}

// ── Suite ──────────────────────────────────────────────────────

/**
 * List test cases for one skill, or all skills when skillId is null.
 * @param {string|null} skillId
 * @param {{testsDir?: string}} [opts]
 * @returns {object[]} sorted by captured_at asc
 */
function listTestCases(skillId, opts = {}) {
  const testsDir = opts.testsDir || defaultTestsDir();
  const out = [];

  let skillDirs = [];
  try {
    if (skillId) {
      skillDirs = [path.join(testsDir, skillId)];
    } else {
      skillDirs = fs.readdirSync(testsDir)
        .map(d => path.join(testsDir, d))
        .filter(p => fs.statSync(p).isDirectory());
    }
  } catch {
    return out;
  }

  for (const dir of skillDirs) {
    let files;
    try {
      files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        const tc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
        out.push({ ...tc, file: path.join(dir, f) });
      } catch {
        // skip malformed
      }
    }
  }

  return out.sort((a, b) => String(a.captured_at).localeCompare(String(b.captured_at)));
}

/**
 * Run every captured case for a skill against a skill text.
 * @param {string} skillId
 * @param {{skillContent?: string, skillPath?: string, testsDir?: string, threshold?: number}} [opts]
 * @returns {{skillId: string, threshold: number, cases: Array<{id,score,pass}>, passed: number, total: number}}
 */
function runSuite(skillId, opts = {}) {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  let content = opts.skillContent;
  if (!content && opts.skillPath) {
    try {
      content = fs.readFileSync(opts.skillPath, 'utf-8');
    } catch {
      content = null;
    }
  }

  const cases = listTestCases(skillId, { testsDir: opts.testsDir })
    .map(tc => {
      const score = content ? scoreSkillAgainstCase(content, tc) : 0;
      return { id: tc.id, score, pass: score >= threshold };
    });

  return {
    skillId,
    threshold,
    cases,
    passed: cases.filter(c => c.pass).length,
    total: cases.length,
  };
}

// ── Zero-regression gate ───────────────────────────────────────

/**
 * Pareto gate: a mutation is accepted only if it never scores below the
 * original on any case, and meets the threshold on every case the original
 * passed.
 * @param {string} skillId
 * @param {{originalContent: string, mutatedContent: string, testsDir?: string, threshold?: number}} opts
 * @returns {{verdict: 'accept'|'reject', threshold: number, cases: Array<{id,original,mutated,delta,pass}>, means: {original:number, mutated:number}, reasons: string[]}}
 */
function validateMutation(skillId, opts) {
  if (!opts || !skillId) throw new Error('validate: skill-id required');
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const cases = listTestCases(skillId, { testsDir: opts.testsDir });
  const reasons = [];

  if (cases.length === 0) {
    return {
      verdict: 'reject',
      threshold,
      cases: [],
      means: { original: 0, mutated: 0 },
      reasons: ['no test cases captured — run `meta-skills selfheal capture` first'],
    };
  }

  const results = cases.map(tc => {
    const original = scoreSkillAgainstCase(opts.originalContent || '', tc);
    const mutated = scoreSkillAgainstCase(opts.mutatedContent || '', tc);
    return { id: tc.id, original, mutated, delta: mutated - original, pass: mutated >= threshold };
  });

  for (const r of results) {
    if (r.delta < 0) {
      reasons.push(`regression on ${r.id}: ${r.original} → ${r.mutated}`);
    }
  }
  // Every case the original passed must still meet the threshold.
  for (const r of results) {
    if (r.original >= threshold && r.mutated < threshold) {
      reasons.push(`case ${r.id} dropped below threshold (${threshold}): ${r.mutated}`);
    }
  }

  const mean = arr => Math.round((arr.reduce((s, x) => s + x, 0) / Math.max(arr.length, 1)) * 10) / 10;
  const means = {
    original: mean(results.map(r => r.original)),
    mutated: mean(results.map(r => r.mutated)),
  };

  return {
    verdict: reasons.length === 0 ? 'accept' : 'reject',
    threshold,
    cases: results,
    means,
    reasons,
  };
}

// ── CLI ────────────────────────────────────────────────────────

function parseArgs(args) {
  const opts = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--prompt') opts.prompt = args[++i];
    else if (a === '--prompt-file') opts.promptFile = args[++i];
    else if (a === '--hint') opts.hint = args[++i];
    else if (a === '--skill-path') opts.skillPath = args[++i];
    else if (a === '--mutated') opts.mutatedPath = args[++i];
    else if (a === '--threshold') opts.threshold = Number(args[++i]);
    else if (a === '--tests-dir') opts.testsDir = args[++i];
    else if (a === '--global-json') opts.globalJson = args[++i];
    else if (a === '--json') opts.json = true;
    else opts._.push(a);
  }
  return opts;
}

function resolveSkillPath(skillId, globalJsonPath) {
  try {
    const index = JSON.parse(fs.readFileSync(globalJsonPath || defaultGlobalJson(), 'utf-8'));
    const entry = (index.skills || []).find(s => s.id === skillId)
      || (index.stale || []).find(s => s.id === skillId);
    if (!entry || !entry.path) return null;
    // Expand leading ~ for cross-platform safety
    const p = entry.path.startsWith('~')
      ? path.join(os.homedir(), entry.path.slice(1))
      : entry.path;
    return fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

async function cmdSelfheal(args) {
  const sub = args[0];
  const opts = parseArgs(args.slice(1));

  switch (sub) {
    case 'capture': {
      const skillId = opts._[0];
      if (!skillId) throw new Error('selfheal capture: skill-id required');
      let prompt = opts.prompt;
      if (!prompt && opts.promptFile) prompt = fs.readFileSync(opts.promptFile, 'utf-8');
      if (!prompt) throw new Error('selfheal capture: --prompt or --prompt-file required');
      const tc = captureTestCase(skillId, prompt, { hint: opts.hint, source: 'manual', testsDir: opts.testsDir });
      console.log(`✓ captured test case ${tc.id} for ${skillId}`);
      console.log(`  keywords: ${tc.keywords.join(', ') || '(none)'}`);
      console.log(`  file: ${tc.file}`);
      break;
    }

    case 'test': {
      const skillId = opts._[0];
      if (!skillId) throw new Error('selfheal test: skill-id required');
      const skillPath = opts.skillPath || resolveSkillPath(skillId, opts.globalJson);
      if (!skillPath && !opts.skillPath) {
        throw new Error(`selfheal test: SKILL.md for ${skillId} not found in global.json — pass --skill-path`);
      }
      const result = runSuite(skillId, {
        skillPath: opts.skillPath || skillPath,
        testsDir: opts.testsDir,
        threshold: opts.threshold,
      });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`selfheal suite for ${skillId} (threshold ${result.threshold}): ${result.passed}/${result.total} pass`);
        for (const c of result.cases) {
          console.log(`  ${c.pass ? '✓' : '✗'} ${c.id} — ${c.score}`);
        }
        if (result.total === 0) console.log('  (no test cases captured yet)');
      }
      if (result.total > 0 && result.passed < result.total) process.exitCode = 1;
      break;
    }

    case 'validate': {
      const skillId = opts._[0];
      if (!skillId) throw new Error('selfheal validate: skill-id required');
      if (!opts.mutatedPath) throw new Error('selfheal validate: --mutated <path> required');
      const originalPath = opts.skillPath || resolveSkillPath(skillId, opts.globalJson);
      const originalContent = originalPath ? fs.readFileSync(originalPath, 'utf-8') : '';
      const mutatedContent = fs.readFileSync(opts.mutatedPath, 'utf-8');
      const result = validateMutation(skillId, {
        originalContent,
        mutatedContent,
        testsDir: opts.testsDir,
        threshold: opts.threshold,
      });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        const icon = result.verdict === 'accept' ? '✓' : '✗';
        console.log(`${icon} ${result.verdict.toUpperCase()} — ${skillId} (means: ${result.means.original} → ${result.means.mutated})`);
        for (const c of result.cases) {
          console.log(`  ${c.id}: ${c.original} → ${c.mutated} (${c.delta >= 0 ? '+' : ''}${c.delta})`);
        }
        for (const r of result.reasons) console.log(`  ⚠ ${r}`);
      }
      if (result.verdict === 'reject') process.exitCode = 1;
      break;
    }

    case 'list': {
      const skillId = opts._[0] || null;
      const cases = listTestCases(skillId, { testsDir: opts.testsDir });
      if (opts.json) {
        console.log(JSON.stringify(cases.map(({ file, ...tc }) => ({ ...tc, file })), null, 2));
      } else {
        if (cases.length === 0) {
          console.log('no test cases captured yet');
        } else {
          for (const tc of cases) {
            console.log(`${tc.id}  ${tc.skill_id}  ${tc.source}  ${tc.captured_at}`);
            if (tc.hint) console.log(`    hint: ${tc.hint}`);
          }
        }
      }
      break;
    }

    default:
      console.error('selfheal: unknown subcommand (expected: capture|test|validate|list)');
      console.error('  selfheal capture <skill-id> --prompt <text> | --prompt-file <path> [--hint <t>]');
      console.error('  selfheal test <skill-id> [--skill-path <p>] [--threshold N] [--json]');
      console.error('  selfheal validate <skill-id> --mutated <path> [--skill-path <p>] [--threshold N] [--json]');
      console.error('  selfheal list [skill-id]');
      process.exit(1);
  }
}

export {
  DEFAULT_THRESHOLD,
  defaultTestsDir,
  extractKeywords,
  hash6,
  captureTestCase,
  captureFromFailureEvent,
  scoreSkillAgainstCase,
  listTestCases,
  runSuite,
  validateMutation,
  cmdSelfheal,
};
