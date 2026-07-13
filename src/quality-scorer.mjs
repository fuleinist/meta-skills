#!/usr/bin/env node

/**
 * meta-skills v1.6 — Skill Quality Scorer
 *
 * Heuristic scoring of SKILL.md files across 4 dimensions:
 *   readability, trigger precision, instruction clarity, token efficiency.
 *
 * Each dimension scores 0–100. Overall = weighted average.
 * Low-scoring skills get flagged for revision.
 *
 * Zero external API calls — pure heuristic analysis of local files.
 * Inspired by: Anthropic skill authoring best practices
 *   (concise, degrees of freedom, 500-line rule, trigger precision).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---- Scoring dimensions ----------------------------------------------------

const WEIGHTS = {
  readability: 0.25,
  triggerPrecision: 0.30,
  instructionClarity: 0.25,
  tokenEfficiency: 0.20,
};

/**
 * Score readability of a SKILL.md file.
 * Checks: frontmatter, description, section structure, length, code examples.
 */
export function scoreReadability(content) {
  let score = 0;
  const lines = content.split('\n');

  // Has frontmatter (--- delimited YAML)
  if (content.startsWith('---')) {
    const endIdx = content.indexOf('---', 3);
    if (endIdx > 3) score += 20;
  }

  // Has description field in frontmatter
  if (/^description:/m.test(content)) score += 15;

  // Has section headers (## or ###)
  const sections = content.match(/^#{2,3}\s+/gm);
  if (sections) score += Math.min(sections.length * 5, 15);

  // Length check: 50–500 lines is ideal
  if (lines.length >= 50 && lines.length <= 500) {
    score += 25;
  } else if (lines.length > 20 && lines.length < 800) {
    score += 10;
  }

  // Has code examples (``` blocks)
  const codeBlocks = content.match(/```/g);
  if (codeBlocks && codeBlocks.length >= 2) score += 15;

  // Has links
  if (/\[.+\]\(https?:\/\/.+\)/.test(content)) score += 10;

  return Math.min(score, 100);
}

/**
 * Score trigger precision of a skill's `when` field.
 * Checks: exists, length, specificity, anti-generic.
 */
export function scoreTriggerPrecision(entry) {
  let score = 0;
  const when = (entry.when || '').trim();

  // Has when field
  if (when) {
    score += 30;
  } else {
    return 0; // no when = 0
  }

  // when length > 20 chars = enough to be specific
  if (when.length > 20) score += 20;
  else if (when.length > 10) score += 10;

  // Contains trigger-indicating words
  const triggerWords = /\b(when|if|for|during|after|before|while|to|whenever)\b/i;
  if (triggerWords.test(when)) score += 15;

  // Penalize overly generic words
  const genericWords = /\b(general|use|various|stuff|things|anything|something|everything|multiple|different)\b/i;
  const genericMatches = (when.match(genericWords) || []).length;
  score -= genericMatches * 15;
  // Penalize short when (< 40 chars = likely too vague)
  if (when.length < 40) score -= 10;
  if (when.length < 25) score -= 15;

  // Has > 2 meaningful words (excluding stopwords)
  const stopwords = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for', 'is', 'it', 'be']);
  const words = when.toLowerCase().split(/\s+/).filter(w => w.length > 2 && !stopwords.has(w));
  if (words.length > 2) score += 20;
  else if (words.length > 0) score += 10;

  return Math.min(score, 100);
}

/**
 * Score instruction clarity of a SKILL.md file.
 * Checks: numbered steps, code blocks, examples, anti-patterns, references.
 */
export function scoreInstructionClarity(content) {
  let score = 0;

  // Has numbered steps (1. 2. 3. or 1) 2) 3))
  if (/\n\s*\d+[\.\)]\s+\w/.test(content)) score += 20;

  // Has code blocks
  const codeBlocks = content.match(/```/g);
  if (codeBlocks && codeBlocks.length >= 2) score += 20;
  else if (codeBlocks && codeBlocks.length >= 1) score += 10;

  // Has examples section
  if (/\bexample/i.test(content)) score += 15;

  // Has anti-patterns / caution / warning / note section
  if (/\b(anti.pattern|caution|warning|note|avoid|don'?t|not recommended)\b/i.test(content)) score += 15;

  // Has output/result description
  if (/\b(output|result|returns|yields|produces|shows)\b/i.test(content)) score += 15;

  // Has references / see also / related
  if (/\b(reference|see also|related|further reading)\b/i.test(content)) score += 15;

  return Math.min(score, 100);
}

/**
 * Score token efficiency of a SKILL.md file.
 * Checks: meaningful content ratio, no commented code, no ASCII art, line length.
 */
export function scoreTokenEfficiency(content) {
  let score = 0;
  const lines = content.split('\n');

  // Content must exist and be substantial
  const meaningfulLines = lines.filter(l => l.trim().length > 0).length;
  if (meaningfulLines < 3) return 0; // empty or near-empty

  const ratio = meaningfulLines / Math.max(lines.length, 1);
  if (ratio > 0.7) score += 30;
  else if (ratio > 0.5) score += 15;

  // Penalize commented-out code
  const commentCodeLines = lines.filter(l => /^\s*(\/\/|#)\s*[a-z_]+\s*[=(]/.test(l)).length;
  score -= commentCodeLines * 5;

  // Penalize ASCII art (lines with only special chars, > 3 consecutive)
  let asciiArtRuns = 0;
  let currentRun = 0;
  for (const line of lines) {
    const stripped = line.replace(/\s/g, '');
    if (stripped.length > 10 && /^[^a-zA-Z0-9]+$/.test(stripped)) {
      currentRun++;
    } else {
      if (currentRun > 3) asciiArtRuns++;
      currentRun = 0;
    }
  }
  if (currentRun > 3) asciiArtRuns++;
  score -= asciiArtRuns * 15;

  // Average line length < 100 chars
  const avgLineLen = lines.reduce((sum, l) => sum + l.length, 0) / Math.max(lines.length, 1);
  if (avgLineLen < 100) score += 15;
  else if (avgLineLen < 150) score += 8;

  // No duplicate sections (same header text appearing twice)
  const headers = lines.filter(l => /^#{2,3}\s/.test(l)).map(l => l.trim().toLowerCase());
  const uniqueHeaders = new Set(headers);
  if (headers.length === uniqueHeaders.size) score += 15;
  else if (headers.length - uniqueHeaders.size <= 1) score += 8;

  return Math.min(score, 100);
}

/**
 * Score a single skill entry by reading its SKILL.md file.
 *
 * @param {object} entry — skill entry from global.json (must have `path` and `when`)
 * @returns {{ id, score: number, dimensions: object, flags: string[] }}
 */
export function scoreSkill(entry) {
  const flags = [];

  // Read SKILL.md
  let content = '';
  if (entry.path && fs.existsSync(entry.path)) {
    try {
      content = fs.readFileSync(entry.path, 'utf-8');
    } catch {
      flags.push('unreadable');
    }
  } else {
    flags.push('missing-file');
  }

  const dimensions = {
    readability: content ? scoreReadability(content) : 0,
    triggerPrecision: scoreTriggerPrecision(entry),
    instructionClarity: content ? scoreInstructionClarity(content) : 0,
    tokenEfficiency: content ? scoreTokenEfficiency(content) : 0,
  };

  const overall = Math.round(
    dimensions.readability * WEIGHTS.readability +
    dimensions.triggerPrecision * WEIGHTS.triggerPrecision +
    dimensions.instructionClarity * WEIGHTS.instructionClarity +
    dimensions.tokenEfficiency * WEIGHTS.tokenEfficiency
  );

  // Generate flags
  if (dimensions.readability < 40) flags.push('low-readability');
  if (dimensions.triggerPrecision < 40) flags.push('vague-trigger');
  if (dimensions.instructionClarity < 40) flags.push('unclear-instructions');
  if (dimensions.tokenEfficiency < 40) flags.push('inefficient');
  if (overall < 30) flags.push('critical');
  if (!content) flags.push('no-content');

  return {
    id: entry.id || entry.name || 'unknown',
    score: overall,
    dimensions,
    flags,
  };
}

/**
 * Score all skills in a global.json index.
 *
 * @param {string} globalJsonPath — path to global.json
 * @param {number} threshold — only return skills below this score (default 0 = all)
 * @returns {{ results: Array, summary: object }}
 */
export function scoreAll(globalJsonPath, { threshold = 0 } = {}) {
  if (!fs.existsSync(globalJsonPath)) {
    return {
      results: [],
      summary: { error: `global.json not found: ${globalJsonPath}` },
    };
  }

  const index = JSON.parse(fs.readFileSync(globalJsonPath, 'utf-8'));
  const skills = index.skills || [];
  const results = skills
    .map(entry => scoreSkill(entry))
    .filter(r => threshold === 0 || r.score < threshold)
    .sort((a, b) => a.score - b.score);

  const scores = results.map(r => r.score);
  const avg = scores.length > 0
    ? Math.round(scores.reduce((s, v) => s + v, 0) / scores.length)
    : 0;

  const flags = {};
  for (const r of results) {
    for (const f of r.flags) {
      flags[f] = (flags[f] || 0) + 1;
    }
  }

  return {
    results,
    summary: {
      total: skills.length,
      scored: results.length,
      averageScore: avg,
      medianScore: scores.length > 0 ? scores.sort((a, b) => a - b)[Math.floor(scores.length / 2)] : 0,
      minScore: scores.length > 0 ? scores[0] : 0,
      maxScore: scores.length > 0 ? scores[scores.length - 1] : 0,
      flags,
    },
  };
}

// ---- CLI -------------------------------------------------------------------

const isMain = process.argv[1] && (
  process.argv[1] === (new URL(import.meta.url)).pathname ||
  process.argv[1].endsWith('quality-scorer.mjs')
);

if (isMain) {
  const args = process.argv.slice(2);
  const globalJsonPath = path.resolve(
    args[args.indexOf('--global-json') + 1] ||
    path.join(os.homedir(), '.meta-skills', 'global.json')
  );
  const thresholdIdx = args.indexOf('--threshold');
  const threshold = thresholdIdx >= 0 ? parseInt(args[thresholdIdx + 1], 10) : 0;
  const asJson = args.includes('--json');

  const { results, summary } = scoreAll(globalJsonPath, { threshold });

  if (summary.error) {
    console.error(summary.error);
    process.exit(1);
  }

  if (asJson) {
    console.log(JSON.stringify({ results, summary }, null, 2));
    process.exit(0);
  }

  console.log(`Skill Quality Report`);
  console.log(`====================`);
  console.log(`Total skills: ${summary.total}`);
  console.log(`Scored: ${summary.scored}`);
  console.log(`Average: ${summary.averageScore}/100`);
  console.log(`Median:  ${summary.medianScore}/100`);
  console.log(`Range:   ${summary.minScore}–${summary.maxScore}`);
  console.log('');

  if (results.length === 0) {
    console.log('No skills scored below threshold.');
  } else {
    console.log(`Skills (sorted by score, lowest first):`);
    console.log('');
    for (const r of results) {
      const flagStr = r.flags.length > 0 ? ` [${r.flags.join(', ')}]` : '';
      console.log(`  ${r.score}/100  ${r.id}${flagStr}`);
      console.log(`           readability: ${r.dimensions.readability}  trigger: ${r.dimensions.triggerPrecision}  clarity: ${r.dimensions.instructionClarity}  efficiency: ${r.dimensions.tokenEfficiency}`);
    }
  }

  if (Object.keys(summary.flags).length > 0) {
    console.log('');
    console.log('Flag summary:');
    for (const [flag, count] of Object.entries(summary.flags)) {
      console.log(`  ${flag}: ${count} skill(s)`);
    }
  }
}
