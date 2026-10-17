#!/usr/bin/env node

/**
 * meta-skills v0.1 — Autonomous Skill Evolution Engine
 *
 * Full EvoSkill-inspired loop:
 *   1. Baseline: measure quality scores for all skills
 *   2. Analyze: detect split / merge / rewrite opportunities
 *   3. Propose: generate mutation proposals with before/after scores
 *   4. Pareto-filter: keep only variants that improve effectiveness
 *   5. Human-in-the-loop: review, approve, or reject proposals
 *   6. Generality gate (issue #41): audit proposal content for localized
 *      signals; --strict refuses localized content for global-scope skills
 *
 * Inspiration: EvoSkill (arXiv 2603.02766) — 7.3% OfficeQA gain, 12.1% SealQA gain
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { scoreAll } from './quality-scorer.mjs';
import { takeSnapshot } from './rollback-ledger.mjs';
import { auditGenerality, formatGeneralityReport } from './generality-audit.mjs';
import { ensurePurpose, appendHistory } from './provenance.mjs';
import { checkGateForSkill, defaultValidationDir } from './validation-harness.mjs';
import { impactLogPath, impactKey, appendImpact, readImpact } from './skill-impact.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Default paths ───────────────────────────────────────────────────────────

function defaultEvolveDir() {
  return path.join(os.homedir(), '.meta-skills', 'evolve');
}

function defaultBaselinePath() {
  return path.join(defaultEvolveDir(), 'baseline.json');
}

function defaultProposalsPath() {
  return path.join(defaultEvolveDir(), 'proposals.jsonl');
}

function defaultGlobalJson() {
  return path.join(os.homedir(), '.meta-skills', 'global.json');
}

// ── Placeholder content guard (issue #43 item 6) ────────────────────────────

const PLACEHOLDER_MARKERS = [
  'Example usage here',
  'TODO',
  'FIXME',
  'placeholder',
  '<insert',
];

/**
 * Which PLACEHOLDER_MARKERS appear in a piece of content (case-insensitive).
 * @param {string} content
 * @returns {string[]} matched markers
 */
function findPlaceholderMarkers(content) {
  const text = String(content || '').toLowerCase();
  return PLACEHOLDER_MARKERS.filter(m => text.includes(m.toLowerCase()));
}

/**
 * True when content still contains authoring placeholders (or is empty).
 * Every apply path must run this before writing a SKILL.md.
 */
function containsPlaceholder(content) {
  const text = String(content || '');
  if (!text.trim()) return true;
  return findPlaceholderMarkers(text).length > 0;
}

// ── File helpers (issue #43 item 1) ─────────────────────────────────────────

/** Short sha-256 hash used for proposal IDs and batch dedupe keys. */
function shortHash(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 8);
}

/** Read a skill file; returns null when it cannot be resolved. */
function readSkillContent(entryPath) {
  if (!entryPath) return null;
  try {
    return fs.readFileSync(entryPath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Resolve the skills root from an index entry path.
 * Entry paths look like `<skillsRoot>/<skill-id>/SKILL.md`, so the root is
 * dirname(dirname(path)).
 */
function skillsRootFromEntry(entryPath) {
  if (!entryPath) return null;
  return path.dirname(path.dirname(path.resolve(entryPath)));
}

/**
 * Write `<root>/<id>/SKILL.md` atomically (temp + rename).
 * Refuses any target that escapes the resolved skills root.
 * @returns {string|null} written path, or null when refused
 */
function writeSkillFile(root, id, content) {
  const rootAbs = path.resolve(root);
  const target = path.resolve(rootAbs, id, 'SKILL.md');
  const rel = path.relative(rootAbs, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmpPath = target + '.tmp';
  fs.writeFileSync(tmpPath, content, 'utf-8');
  fs.renameSync(tmpPath, target);
  return target;
}

/** Strip YAML frontmatter from a SKILL.md body. */
function stripFrontmatter(content) {
  const text = String(content || '');
  const m = text.match(/^---\n[\s\S]*?\n---\n?/);
  return m ? text.slice(m[0].length) : text;
}

// ── Baseline ────────────────────────────────────────────────────────────────

/**
 * Measure quality scores for all skills in global.json and store as baseline.
 * @param {string} [globalJsonPath]
 * @param {string} [baselinePath]
 * @returns {{ totalScored, averageScore, skills: Array<{id, score, flags}> }}
 */
function runBaseline(globalJsonPath = defaultGlobalJson(), baselinePath = defaultBaselinePath()) {
  const evolveDir = path.dirname(baselinePath);
  if (!fs.existsSync(evolveDir)) {
    fs.mkdirSync(evolveDir, { recursive: true });
  }

  const result = scoreAll(globalJsonPath, { threshold: 0 });
  if (result.summary.error) {
    throw new Error(result.summary.error);
  }

  // Build per-skill detail
  const skills = result.results.map(r => ({
    id: r.id,
    score: r.score,
    dimensions: r.dimensions,
    flags: r.flags,
    version: r.version,
  }));

  const baseline = {
    ts: new Date().toISOString(),
    globalJson: globalJsonPath,
    totalScored: result.summary.total,
    averageScore: result.summary.averageScore,
    medianScore: result.summary.medianScore,
    minScore: result.summary.minScore,
    maxScore: result.summary.maxScore,
    skills,
    flags: result.summary.flags,
  };

  fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n', 'utf-8');

  console.log(`Baseline recorded: ${baseline.totalScored} skills, avg ${baseline.averageScore}/100`);
  return baseline;
}

// ── Mutation analysis ───────────────────────────────────────────────────────

/**
 * Detect mutation opportunities in the skill index.
 * Three types:
 *   - split: vague-trigger skills with low clarity scores
 *   - merge: co-occurring skills with overlapping triggers
 *   - rewrite: low-score skills (< 50 overall)
 *
 * @param {object} index — meta-skills global.json parsed
 * @param {object} [baseline] — baseline from runBaseline (for comparison)
 * @returns {Array<{type, id, reason, suggestedAction, confidence}>}
 */
function analyzeMutations(index, baseline = null) {
  const opportunities = [];
  const skills = index.skills || [];
  const scores = baseline ? new Map(baseline.skills.map(s => [s.id, s])) : null;

  for (const skill of skills) {
    const scoreEntry = scores ? scores.get(skill.id) : null;
    const score = scoreEntry ? scoreEntry.score : 0;

    // --- Split detection: vague trigger + low clarity ---
    if (scoreEntry && scoreEntry.dimensions) {
      const triggerPrec = scoreEntry.dimensions.triggerPrecision || 0;
      const instrClarity = scoreEntry.dimensions.instructionClarity || 0;

      if (triggerPrec < 40 && instrClarity < 50 && (skill.when || '').length > 60) {
        opportunities.push({
          type: 'split',
          id: skill.id,
          reason: `Vague trigger (${triggerPrec}/100) + low clarity (${instrClarity}/100) — consider splitting into focused sub-skills`,
          suggestedAction: `Split "${skill.id}" into: ${skill.id}-core, ${skill.id}-advanced, ${skill.id}-edge-cases`,
          confidence: Math.min(0.9, 0.5 + (40 - triggerPrec) / 100 + (50 - instrClarity) / 200),
        });
      }
    }

    // --- Rewrite detection: low overall score ---
    if (scoreEntry && score < 50 && scoreEntry.flags.includes('vague-trigger')) {
      opportunities.push({
        type: 'rewrite',
        id: skill.id,
        reason: `Low quality score (${score}/100) with vague trigger — rewrite needed`,
        suggestedAction: `Rewrite "${skill.id}" SKILL.md: tighten \`when:\` field, add concrete examples`,
        confidence: Math.min(0.95, score / 100 + 0.3),
      });
    }

    // --- Rewrite detection: critical skills ---
    if (scoreEntry && scoreEntry.flags.includes('critical')) {
      opportunities.push({
        type: 'rewrite',
        id: skill.id,
        reason: `Critical quality score (${score}/100) — immediate rewrite recommended`,
        suggestedAction: `Rewrite "${skill.id}" SKILL.md from scratch following v1.6 quality guidelines`,
        confidence: 0.95,
      });
    }
  }

  // --- Merge detection: co-occurring skills with similar triggers ---
  for (let i = 0; i < skills.length; i++) {
    for (let j = i + 1; j < skills.length; j++) {
      const a = skills[i];
      const b = skills[j];
      if (!a.when || !b.when) continue;

      // Simple overlap heuristic: count shared words in when fields
      const wordsA = new Set((a.when || '').toLowerCase().split(/\s+/).filter(w => w.length > 3));
      const wordsB = new Set((b.when || '').toLowerCase().split(/\s+/).filter(w => w.length > 3));
      let overlap = 0;
      for (const w of wordsA) {
        if (wordsB.has(w)) overlap++;
      }
      const maxWords = Math.max(wordsA.size, wordsB.size, 1);
      const overlapRatio = overlap / maxWords;

      if (overlapRatio > 0.4 && (a.usage_count || 0) > 0 && (b.usage_count || 0) > 0) {
        opportunities.push({
          type: 'merge',
          id: `${a.id}+${b.id}`,
          reason: `Triggers overlap ${Math.round(overlapRatio * 100)}% — consider merging "${a.id}" and "${b.id}"`,
          suggestedAction: `Merge "${a.id}" + "${b.id}" → "${a.id}-${b.id}"`,
          confidence: overlapRatio * 0.8,
        });
      }
    }
  }

  return opportunities;
}

// ── Proposal generation ─────────────────────────────────────────────────────

/**
 * Generate concrete mutation proposals from analysis results.
 * Each proposal includes: type, target skill(s), before scores, suggested diff content.
 *
 * @param {object} index — current global.json
 * @param {object} baseline — baseline from runBaseline
 * @param {Array} opportunities — from analyzeMutations
 * @returns {Array<{id, type, skillIds, beforeScores, afterScores, diff, reason, confidence}>}
 */
function generateProposals(index, baseline, opportunities) {
  const proposals = [];
  const skillMap = new Map((index.skills || []).map(s => [s.id, s]));
  let seq = 0;

  for (const opp of opportunities) {
    const proposal = {
      // Issue #43 item 2: `type-oppId-Date.now()` collided when two proposals
      // targeted the same skill in one run. Per-batch sequence + diff hash.
      id: '',
      type: opp.type,
      skillIds: [opp.id],
      reason: opp.reason,
      confidence: opp.confidence,
      generated: new Date().toISOString(),
      status: 'pending',
    };

    if (opp.type === 'split') {
      const skill = skillMap.get(opp.id);
      const beforeScores = baseline ? (baseline.skills.find(s => s.id === opp.id) || {}) : {};
      proposal.beforeScores = {
        overall: beforeScores.score || 0,
        triggerPrecision: beforeScores.dimensions?.triggerPrecision || 0,
        instructionClarity: beforeScores.dimensions?.instructionClarity || 0,
      };

      // Generate a suggested diff that tightens the when field and adds structure
      const newWhen = `Use ONLY when explicitly writing commit messages or changelogs (not for general code review)`;
      const skillContent = skill?.path && fs.existsSync(skill.path)
        ? fs.readFileSync(skill.path, 'utf-8')
        : '';

      proposal.diff = generateSplitDiff(skill?.id || opp.id, skillContent, newWhen);
      proposal.content = deriveSplitContent(`${opp.id}-core`, opp.id, skillContent, newWhen);
      proposal.afterScores = estimateAfterScores(proposal.beforeScores, 'split');

    } else if (opp.type === 'merge') {
      const [idA, idB] = opp.id.split('+');
      const skillA = skillMap.get(idA);
      const skillB = skillMap.get(idB);
      const beforeA = baseline ? (baseline.skills.find(s => s.id === idA) || {}) : {};
      const beforeB = baseline ? (baseline.skills.find(s => s.id === idB) || {}) : {};
      proposal.skillIds = [idA, idB];

      proposal.beforeScores = {
        overall: Math.round((beforeA.score || 0) * 0.5 + (beforeB.score || 0) * 0.5),
        triggerPrecision: Math.round((beforeA.dimensions?.triggerPrecision || 0) * 0.5 + (beforeB.dimensions?.triggerPrecision || 0) * 0.5),
        instructionClarity: Math.round((beforeA.dimensions?.instructionClarity || 0) * 0.5 + (beforeB.dimensions?.instructionClarity || 0) * 0.5),
      };

      proposal.diff = generateMergeDiff(idA, idB, skillA?.path, skillB?.path);
      proposal.content = deriveMergeContent(
        `${idA}-${idB}`,
        idA,
        idB,
        readSkillContent(skillA?.path),
        readSkillContent(skillB?.path),
      );
      proposal.afterScores = estimateAfterScores(proposal.beforeScores, 'merge');

    } else if (opp.type === 'rewrite') {
      const skill = skillMap.get(opp.id);
      const beforeScores = baseline ? (baseline.skills.find(s => s.id === opp.id) || {}) : {};
      proposal.skillIds = [opp.id];

      proposal.beforeScores = {
        overall: beforeScores.score || 0,
        triggerPrecision: beforeScores.dimensions?.triggerPrecision || 0,
        instructionClarity: beforeScores.dimensions?.instructionClarity || 0,
        readability: beforeScores.dimensions?.readability || 0,
        tokenEfficiency: beforeScores.dimensions?.tokenEfficiency || 0,
      };

      const skillContent = skill?.path && fs.existsSync(skill.path)
        ? fs.readFileSync(skill.path, 'utf-8')
        : '';

      const newWhen = tightenWhen(skill?.when || '');
      proposal.diff = generateRewriteDiff(opp.id, skillContent, newWhen);
      proposal.content = deriveRewriteContent(opp.id, skillContent, newWhen);
      proposal.afterScores = estimateAfterScores(proposal.beforeScores, 'rewrite');
    }

    proposal.id = `${opp.type}-${opp.id}-${seq}-${shortHash(proposal.diff || '')}`;
    seq++;
    proposals.push(proposal);
  }

  return proposals;
}

// ── Diff generation helpers ─────────────────────────────────────────────────

/**
 * Generate a split-diff: propose extracting core logic into a separate skill file.
 */
function generateSplitDiff(skillId, content, newWhen) {
  const lines = content.split('\n');
  const frontmatterEnd = content.indexOf('---', content.indexOf('---') + 3);
  if (frontmatterEnd < 0) {
    return `---\nname: ${skillId}-core\ndescription: Core functionality of ${skillId}\n---\n\n# ${skillId}-core\n\n${newForcedLines(content).join('\n')}`;
  }

  const header = content.slice(0, frontmatterEnd + 4);
  const body = content.slice(frontmatterEnd + 4);

  // Extract first substantive section as "core"
  const sectionMatch = body.match(/^##\s+\w+.+?\n(?:(?!^##\s).)*$/m);
  const coreSection = sectionMatch ? sectionMatch[0].trim() : body.split('\n').slice(0, 10).join('\n');

  const newContent = `${header}\nwhen: ${newWhen}\n\n# ${skillId}-core\n\n${coreSection}`;

  // Simple diff
  const oldLines = content.split('\n');
  const newLines = newContent.split('\n');
  let diff = `--- a/skills/${skillId}/SKILL.md\n+++ b/skills/${skillId}-core/SKILL.md\n`;

  let hunkStart = 0;
  let hunkOld = [];
  let hunkNew = [];
  function flush() {
    if (hunkOld.length === 0 && hunkNew.length === 0) return;
    diff += `@@ -${hunkStart},${hunkOld.length} +${hunkStart},${hunkNew.length} @@\n`;
    for (const l of hunkOld) diff += `-${l}\n`;
    for (const l of hunkNew) diff += `+${l}\n`;
    hunkOld = [];
    hunkNew = [];
  }

  const maxLen = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < maxLen; i++) {
    if (oldLines[i] === newLines[i]) { flush(); hunkStart = i + 1; }
    else {
      if (hunkStart === 0) hunkStart = i;
      if (oldLines[i] !== undefined) hunkOld.push(oldLines[i]);
      if (newLines[i] !== undefined) hunkNew.push(newLines[i]);
    }
  }
  flush();

  return diff;
}

/**
 * Generate a merge-diff: propose combining two skill files.
 */
function generateMergeDiff(idA, idB, pathA, pathB) {
  const existingA = pathA && fs.existsSync(pathA) ? fs.readFileSync(pathA, 'utf-8') : '';
  const existingB = pathB && fs.existsSync(pathB) ? fs.readFileSync(pathB, 'utf-8') : '';

  const combined = `# ${idA}-${idB}\n\n## From ${idA}\n${existingA}\n\n## From ${idB}\n${existingB}`;

  return `--- a/skills/${idA}/SKILL.md\n--- a/skills/${idB}/SKILL.md\n+++ b/skills/${idA}-${idB}/SKILL.md\n@@ -0,0 +1,${combined.split('\n').length} @@\n${combined.split('\n').map(l => `+${l}`).join('\n')}`;
}

/**
 * Tighten a `when:` trigger (shared by proposal generation and apply).
 */
function tightenWhen(when) {
  const trimmed = String(when || '').trim();
  if (!trimmed) return '';
  const tightened = trimmed.replace(/\bgeneral|various|any|multiple|different\b/i, 'specific');
  return /ONLY/i.test(tightened) ? tightened : `Use ONLY when ${tightened.toLowerCase()}`;
}

/**
 * Generate a rewrite-diff: full rewrite with structured improvements.
 * Content is derived from the real source file, not a placeholder template.
 */
function generateRewriteDiff(skillId, existingContent, newWhen = '') {
  const template = deriveRewriteContent(skillId, existingContent, newWhen || tightenWhen(''));
  if (!template) {
    return `--- a/skills/${skillId}/SKILL.md\n+++ b/skills/${skillId}/SKILL.md\n@@ -1,1 +1,1 @@\n+Rewrite needs authoring: no source content available to derive from.`;
  }

  const oldLines = existingContent.split('\n').slice(0, 5);
  const newLines = template.split('\n');

  return `--- a/skills/${skillId}/SKILL.md\n+++ b/skills/${skillId}/SKILL.md\n@@ -1,${Math.max(oldLines.length, 1)} +1,${newLines.length} @@\n${oldLines.map(l => `-${l}`).join('\n')}\n${newLines.map(l => `+${l}`).join('\n')}`;
}

/**
 * Extract meaningful first lines from content (for split diff).
 */
function newForcedLines(content) {
  return content.split('\n')
    .filter(l => l.trim() && !l.startsWith('---') && !l.startsWith('#'))
    .slice(0, 8);
}

// ── Content derivation (issue #43 item 1) ───────────────────────────────────

/**
 * Real content for a split sub-skill, derived from the source skill's body.
 * Returns null when nothing real can be derived.
 */
function deriveSplitContent(newId, sourceId, sourceContent, newWhen) {
  const body = stripFrontmatter(sourceContent).trim();
  if (!body) return null;

  const lines = body.split('\n');
  const startIdx = lines.findIndex(l => /^##\s/.test(l));
  let coreSection = '';
  if (startIdx >= 0) {
    const section = [lines[startIdx]];
    for (let i = startIdx + 1; i < lines.length; i++) {
      if (/^##\s/.test(lines[i])) break;
      section.push(lines[i]);
    }
    coreSection = section.join('\n').trim();
  }
  if (!coreSection) coreSection = body;

  return [
    `---\nname: ${newId}\ndescription: Core functionality split from ${sourceId}\nwhen: ${newWhen}\n---`,
    '',
    `# ${newId}`,
    '',
    `Split from \`${sourceId}\`; this sub-skill covers the core path only.`,
    '',
    coreSection,
    '',
    '## Scope boundary',
    '',
    `Handle the core case here. Advanced and edge-case work belongs to \`${sourceId}\`, which keeps the broader trigger.`,
    '',
  ].join('\n');
}

/**
 * Real content for a merged skill: both sources under clear sections.
 */
function deriveMergeContent(mergedId, idA, idB, contentA, contentB) {
  const parts = [];
  if (contentA && stripFrontmatter(contentA).trim()) {
    parts.push(`## From ${idA}\n\n${stripFrontmatter(contentA).trim()}`);
  }
  if (contentB && stripFrontmatter(contentB).trim()) {
    parts.push(`## From ${idB}\n\n${stripFrontmatter(contentB).trim()}`);
  }
  if (parts.length === 0) return null;

  return [
    `# ${mergedId}`,
    '',
    `Merged skill combining \`${idA}\` and \`${idB}\`.`,
    '',
    ...parts,
    '',
  ].join('\n');
}

/**
 * Real content for a rewritten skill, derived from the source body.
 * Returns null when nothing real can be derived.
 */
function deriveRewriteContent(skillId, existingContent, newWhen) {
  const body = stripFrontmatter(existingContent);
  const bodyLines = body.split('\n').map(l => l.trim()).filter(Boolean);
  if (bodyLines.length === 0) return null;

  const fence = body.match(/```[a-zA-Z]*\n([\s\S]*?)```/);
  const exampleBlock = fence ? fence[1].trim() : bodyLines[0];
  const steps = bodyLines.filter(l => /^\d+\./.test(l)).slice(0, 6);

  const out = [
    `---\nname: ${skillId}\ndescription: Rewritten with a tighter trigger and explicit steps\nwhen: ${newWhen}\n---`,
    '',
    `# ${skillId}`,
    '',
    '## When to Use',
    '',
    newWhen,
    '',
    '## How to Use',
    '',
  ];

  if (steps.length > 0) out.push(...steps);
  else out.push('1. Confirm the task matches the trigger above', '2. Apply the documented steps in order', '3. Validate the output before returning');

  out.push(
    '',
    '## Source guidance (carried over)',
    '',
    bodyLines.slice(0, 12).join('\n'),
    '',
    '## Examples',
    '',
    '```bash',
    exampleBlock,
    '```',
    '',
  );

  return out.join('\n');
}

/**
 * Estimate what scores would look like after a mutation.
 * Heuristic: mutations improve scores based on type and current deficiencies.
 */
function estimateAfterScores(before, type) {
  const tp = before.triggerPrecision || 0;
  const ic = before.instructionClarity || 0;
  const rd = before.readability || 0;
  const te = before.tokenEfficiency || 0;

  let newTp = tp, newIc = ic, newRd = rd, newTe = te;

  if (type === 'split') {
    newTp = Math.min(100, tp + 25);
    newIc = Math.min(100, ic + 15);
  } else if (type === 'merge') {
    newIc = Math.min(100, ic + 10);
    newTp = Math.min(100, tp + 10);
  } else if (type === 'rewrite') {
    newTp = Math.min(100, tp + 30);
    newIc = Math.min(100, ic + 25);
    newRd = Math.min(100, rd + 20);
    newTe = Math.min(100, te + 15);
  }

  const weighted = newTp * 0.30 + newIc * 0.25 + newRd * 0.25 + newTe * 0.20;
  return {
    overall: Math.round(weighted),
    triggerPrecision: newTp,
    instructionClarity: newIc,
    readability: newRd,
    tokenEfficiency: newTe,
  };
}

// ── Pareto filtering ────────────────────────────────────────────────────────

/**
 * Keep only proposals where at least one score improves AND no score regresses.
 * A proposal is Pareto-improving if:
 *   - overall score increases, OR
 *   - at least one dimension improves with no dimension worsening
 *
 * @param {Array} proposals
 * @param {object} baseline
 * @returns {{ kept: Array, discarded: Array }}
 */
function paretoFilter(proposals, baseline) {
  const skillMap = new Map((baseline?.skills || []).map(s => [s.id, s]));
  const kept = [];
  const discarded = [];

  for (const prop of proposals) {
    const before = skillMap.get(prop.skillIds[0]);
    if (!before) {
      discarded.push({ ...prop, reason: 'no baseline match' });
      continue;
    }

    const beforeO = before.score || prop.beforeScores?.overall || 0;
    const afterO = prop.afterScores?.overall || 0;
    const beforeTp = before.dimensions?.triggerPrecision || prop.beforeScores?.triggerPrecision || 0;
    const afterTp = prop.afterScores?.triggerPrecision || 0;
    const beforeIc = before.dimensions?.instructionClarity || prop.beforeScores?.instructionClarity || 0;
    const afterIc = prop.afterScores?.instructionClarity || 0;

    const overallImproved = afterO > beforeO;
    const triggerImproved = afterTp > beforeTp;
    const clarityImproved = afterIc > beforeIc;
    const anyRegressed = (afterTp < beforeTp) || (afterIc < beforeIc) || (afterO < beforeO);

    if (anyRegressed) {
      discarded.push({ ...prop, reason: 'regression detected' });
    } else if (overallImproved || triggerImproved || clarityImproved) {
      kept.push({
        ...prop,
        scoreDelta: {
          overall: afterO - beforeO,
          triggerPrecision: afterTp - beforeTp,
          instructionClarity: afterIc - beforeIc,
        },
        beforeScore: beforeO,
        afterScore: afterO,
      });
    } else {
      discarded.push({ ...prop, reason: 'no improvement' });
    }
  }

  return { kept, discarded };
}

// ── Proposal storage ────────────────────────────────────────────────────────

/**
 * Batch dedupe key: (type, target, diff-hash). Two proposals that would write
 * the same content to the same skill are the same proposal.
 */
function dedupeKey(proposal) {
  const target = (proposal.skillIds || []).slice().sort().join('+');
  return `${proposal.type}|${target}|${shortHash(proposal.diff || proposal.content || '')}`;
}

/**
 * Write proposals to the proposals JSONL file.
 * Dedupes by id, and within the batch by (type, target, diff-hash).
 */
function writeProposals(proposals, proposalsPath = defaultProposalsPath()) {
  const dir = path.dirname(proposalsPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const existing = readProposals(proposalsPath);
  const existingIds = new Set(existing.map(p => p.id));
  const seenKeys = new Set(existing.map(p => dedupeKey(p)));

  // Append new proposals (skip duplicates by id, and by type/target/diff-hash)
  const toWrite = [];
  for (const p of proposals) {
    if (existingIds.has(p.id)) continue;
    const key = dedupeKey(p);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    toWrite.push(p);
  }

  const fd = fs.openSync(proposalsPath, 'a');
  for (const p of toWrite) {
    fs.writeSync(fd, JSON.stringify(p) + '\n', 'utf-8');
  }
  fs.closeSync(fd);

  return toWrite.length;
}

/**
 * Read all proposals from the JSONL file.
 */
function readProposals(proposalsPath = defaultProposalsPath()) {
  try {
    const lines = fs.readFileSync(proposalsPath, 'utf-8').trim().split('\n').filter(Boolean);
    return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Rejected keys from both memory sources (issue #34):
 *   (a) proposals stored with status === 'rejected'
 *   (b) impact-log entries with outcome === 'rejected'
 * Key = `${type}|${target}` — skill id, or `a+b` for a merge.
 * @param {string} [proposalsPath]
 * @returns {Set<string>}
 */
function buildRejectedKeys(proposalsPath = defaultProposalsPath()) {
  const keys = new Set();

  for (const p of readProposals(proposalsPath)) {
    if (p.status === 'rejected') keys.add(impactKey(p.type, p.skillIds));
  }
  for (const e of readImpact(impactLogPath(proposalsPath))) {
    if (e.outcome === 'rejected') keys.add(impactKey(e.type, e.skills));
  }

  return keys;
}

/**
 * Drop opportunities whose type+target was rejected before.
 * Opportunity key = `${opp.type}|${opp.id}`.
 * @param {Array} opportunities — from analyzeMutations
 * @param {Set<string>} rejectedKeys — from buildRejectedKeys
 * @returns {{ kept: Array, suppressed: Array }}
 */
function suppressRejected(opportunities, rejectedKeys) {
  const kept = [];
  const suppressed = [];

  for (const opp of opportunities || []) {
    if (rejectedKeys.has(impactKey(opp.type, opp.id))) suppressed.push(opp);
    else kept.push(opp);
  }

  return { kept, suppressed };
}

/**
 * List pending proposals with human-readable output.
 * Pending proposals that match a prior rejection are marked
 * `[previously rejected]`; rejected proposals stay visible as tombstones so
 * the audit trail is readable.
 */
function listProposals(proposalsPath = defaultProposalsPath()) {
  const proposals = readProposals(proposalsPath);
  const rejectedKeys = buildRejectedKeys(proposalsPath);
  const pending = proposals.filter(p => p.status === 'pending');
  const rejected = proposals.filter(p => p.status === 'rejected');

  if (pending.length === 0 && rejected.length === 0) {
    console.log('No pending proposals.');
    return [];
  }

  console.log(`Pending proposals (${pending.length}):\n`);
  for (const p of pending) {
    const delta = p.scoreDelta;
    const deltaStr = delta
      ? `  Score: ${p.beforeScore} → ${p.afterScore} (+${delta.overall})`
      : '';
    const marker = rejectedKeys.has(impactKey(p.type, p.skillIds)) ? ' [previously rejected]' : '';
    console.log(`  ${p.id}${marker}`);
    console.log(`    Type: ${p.type}  |  Skill(s): ${(p.skillIds || []).join(', ')}`);
    console.log(`    ${p.reason}`);
    console.log(deltaStr);
    console.log(`    Confidence: ${Math.round(p.confidence * 100)}%`);
    // issue #41 — one generality line per pending proposal
    console.log(`    ${formatGeneralityReport(auditGenerality(String(p.diff || '')))}`);
    console.log();
  }

  if (rejected.length > 0) {
    console.log(`Rejected proposals (${rejected.length}) — retained as tombstones:\n`);
    for (const p of rejected) {
      const date = String(p.rejectedAt || p.generated || '').slice(0, 16).replace('T', ' ') || '(unknown)';
      console.log(`  ${p.id}`);
      console.log(`    Type: ${p.type}  |  Skill(s): ${(p.skillIds || []).join(', ')}  |  Rejected: ${date}`);
      console.log(`    ${p.rejectReason || p.reason || '(no reason recorded)'}`);
      console.log();
    }
  }

  return pending;
}

/**
 * Issue #40 — best-effort provenance for an approved mutation.
 * Ensures PURPOSE.md exists for each affected skill and appends one history
 * entry. Never throws: an approval must not fail because of provenance.
 */
function recordProvenance(mutated, proposal) {
  try {
    const skillMap = new Map((mutated.skills || []).map(s => [s.id, s]));
    const date = new Date().toISOString().slice(0, 10);

    for (const id of proposal.skillIds || []) {
      const skill = skillMap.get(id);
      if (!skill?.path) continue;
      if (!fs.existsSync(skill.path)) continue;

      const dir = path.dirname(skill.path);
      try {
        ensurePurpose(dir, {
          name: id,
          description: skill.when || skill.why || '',
          origin: `Created by evolution approval ${proposal.id}`,
          evidence: [],
          history: [],
        });
        appendHistory(dir, { date, version: skill.version, summary: proposal.reason });
      } catch { /* unresolvable skill dir — skip silently */ }
    }
  } catch { /* provenance is best-effort */ }
}

/**
 * Approve a proposal: snapshot, materialize skill files, then apply the index
 * mutation (issue #43 item 1).
 * Returns the mutated index or null on failure.
 *
 * Issue #35: when a validation suite AND a baseline exist for the target skill
 * under the default validation dir, the strict gate runs first — equal or
 * worse than baseline is refused. `opts.force` overrides. No suite/baseline
 * ⇒ silent no-op (behaves exactly as before).
 *
 * issue #41: with `opts.strict`, a `localized` proposal is refused when the target
 * index entry's `scope` is `global` (the default when the field is absent).
 * `scope: "project"` is the escape hatch — a genuinely project-local skill may
 * keep its localized content.
 */
function approveProposal(id, globalJsonPath = defaultGlobalJson(), proposalsPath = defaultProposalsPath(), opts = {}) {
  const proposals = readProposals(proposalsPath);
  const proposal = proposals.find(p => p.id === id);
  if (!proposal) throw new Error(`Proposal not found: ${id}`);

  // Load current index
  let index;
  try {
    index = JSON.parse(fs.readFileSync(globalJsonPath, 'utf-8'));
  } catch {
    throw new Error(`Cannot read ${globalJsonPath}`);
  }

  // ── issue #41 — generality gate (approve only; review stays informational) ──
  if (opts.strict) {
    const report = auditGenerality(String(proposal.diff || ''));
    const entry = (index.skills || []).find(s => s.id === (proposal.skillIds || [])[0]);
    const scope = entry?.scope || 'global';

    if (report.label === 'localized' && scope === 'global') {
      console.error(`✗ Refused (issue #41): ${id}`);
      console.error(`  ${formatGeneralityReport(report)} — scope: global`);
      console.error('  Localized content cannot be approved into a global skill.');
      console.error('  Generalize the diff, or set "scope": "project" on the entry to skip this gate.');
      return null;
    }
    console.log(`  ${formatGeneralityReport(report)} — scope: ${scope}`);
  }

  // ── Strict validation gate (issue #35) ──
  const targetId = (proposal.skillIds || [])[0];
  const target = (index.skills || []).find(s => s.id === targetId);
  if (target && target.path) {
    const check = checkGateForSkill(targetId, target.path, { validationDir: opts.validationDir || defaultValidationDir() });
    if (check) {
      if (!check.gate.accept && !opts.force) {
        throw new Error(`validation gate refused ${id}: ${check.gate.reason}`);
      }
      console.log(`  validation gate: ${check.gate.accept ? 'accept' : 'reject'} — ${check.gate.reason}${opts.force ? ' (forced)' : ''}`);
    }
  }

  // Snapshot before anything is written (best-effort — never blocks approval)
  try {
    takeSnapshot({ globalJsonPath, historyPath: opts.historyPath, comment: `evolve-approve:${id}` });
  } catch { /* best-effort */ }

  // Apply mutation (materializes SKILL.md files inside the resolved skills root)
  const mutated = applyMutation(proposal, index, { materialize: opts.materialize !== false });
  if (!mutated) throw new Error(`Failed to apply mutation for ${id}`);

  // Write mutated index
  const tmpPath = globalJsonPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(mutated, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmpPath, globalJsonPath);

  // Mark proposal as approved
  proposal.status = 'approved';
  proposal.approvedAt = new Date().toISOString();
  fs.writeFileSync(proposalsPath, proposals.map(p => JSON.stringify(p)).join('\n') + '\n', 'utf-8');

  // Issue #40 — append-only provenance for the affected skills (best-effort)
  recordProvenance(mutated, proposal);

  // Outcome read-back: record the decision in the audit trail (issue #34).
  try {
    appendImpact(
      { proposalId: id, type: proposal.type, skills: proposal.skillIds || [], outcome: 'accepted' },
      impactLogPath(proposalsPath),
    );
  } catch { /* audit trail is best-effort */ }

  console.log(`✓ Approved and applied: ${id}`);
  console.log(`  Mutated index written to ${globalJsonPath}`);
  const mat = proposal.materialization || {};
  if (mat.written?.length) {
    for (const f of mat.written) console.log(`  wrote: ${f}`);
  }
  for (const s of mat.skipped || []) {
    console.log(`  skipped file for ${s.id}: ${s.reason}`);
  }
  if (proposal.needsAuthoring) {
    console.log(`  ! needsAuthoring: ${proposal.message}`);
  }
  return mutated;
}

/**
 * Reject a proposal: mark it as rejected (retained as a tombstone) and
 * record the outcome in the audit trail. The proposal is never deleted —
 * rejection is memory, not amnesia (issue #34).
 */
function rejectProposal(id, proposalsPath = defaultProposalsPath(), reason = null) {
  const proposals = readProposals(proposalsPath);
  const proposal = proposals.find(p => p.id === id);
  if (!proposal) throw new Error(`Proposal not found: ${id}`);

  proposal.status = 'rejected';
  proposal.rejectedAt = new Date().toISOString();
  if (reason) proposal.rejectReason = reason;
  fs.writeFileSync(proposalsPath, proposals.map(p => JSON.stringify(p)).join('\n') + '\n', 'utf-8');

  appendImpact(
    { proposalId: id, type: proposal.type, skills: proposal.skillIds || [], outcome: 'rejected', reason },
    impactLogPath(proposalsPath),
  );

  console.log(`✗ Rejected: ${id}`);
  if (reason) console.log(`  reason: ${reason}`);
}

// ── Mutation application ────────────────────────────────────────────────────

/**
 * Apply a mutation to a clone of the index.
 *
 * Issue #43 item 1: approval materializes real SKILL.md files for split/merge
 * (and for rewrite when the content passes the placeholder guard). Index-only
 * behavior is kept as the fallback when a file cannot be written.
 *
 * Issue #43 item 6: every apply path runs the placeholder guard first.
 *
 * @param {object} proposal
 * @param {object} index
 * @param {object} [options] — { materialize: boolean }
 * @returns {object|null} mutated clone
 */
function applyMutation(proposal, index, options = {}) {
  const mutated = JSON.parse(JSON.stringify(index));
  const skills = mutated.skills || [];
  const skillMap = new Map(skills.map(s => [s.id, s]));
  const materialize = options.materialize !== false;
  const record = { written: [], skipped: [], needsAuthoring: false, message: null };

  const noteSkip = (entryId, reason) => record.skipped.push({ id: entryId, reason });

  const materializeEntry = (entryId, content, sourcePath) => {
    if (!materialize) return null;

    if (containsPlaceholder(content)) {
      const markers = findPlaceholderMarkers(content);
      record.needsAuthoring = true;
      record.message = `refused to write ${entryId}: content contains placeholder marker(s): `
        + (markers.length ? markers.join(', ') : 'empty content')
        + '. Authoring required before file materialization.';
      return null;
    }

    const root = skillsRootFromEntry(sourcePath);
    if (!root) {
      noteSkip(entryId, `cannot resolve skills root from source path: ${sourcePath || '(no path)'}`);
      return null;
    }

    try {
      const target = writeSkillFile(root, entryId, content);
      if (!target) {
        noteSkip(entryId, `refused to write outside the resolved skills root (${root})`);
        return null;
      }
      record.written.push(target);
      return target;
    } catch (e) {
      noteSkip(entryId, `write failed: ${e.message}`);
      return null;
    }
  };

  if (proposal.type === 'split') {
    const skill = skillMap.get(proposal.skillIds[0]);
    if (!skill) return null;

    // Create a new core sub-skill
    const coreId = `${proposal.skillIds[0]}-core`;
    const coreWhen = `Use ONLY for core ${proposal.skillIds[0]} functionality (not advanced or edge cases)`;
    const newEntry = {
      ...skill,
      id: coreId,
      when: `${skill.when} (core functionality only)`,
      priority: skill.priority === 'high' ? 'high' : 'medium',
      version: skill.version ? incrementVersion(skill.version) : '0.1.0',
    };

    const sourceContent = readSkillContent(skill.path);
    if (sourceContent === null) {
      noteSkip(coreId, `source skill file not readable: ${skill.path || '(no path)'}`);
    } else {
      const content = proposal.content || deriveSplitContent(coreId, skill.id, sourceContent, coreWhen);
      const target = materializeEntry(coreId, content, skill.path);
      if (target) newEntry.path = target;
    }

    skills.push(newEntry);

    // Tighten the original skill's when field
    skill.when = skill.when.replace(/Use\s+ONLY\s+when.+$/, 'Use ONLY for core functionality');
    if (!/Use\s+ONLY/i.test(skill.when)) {
      skill.when = `Use ONLY for core ${proposal.skillIds[0]} functionality (not advanced or edge cases)`;
    }
    skill.version = incrementVersion(skill.version);
    skill.splitFrom = proposal.skillIds[0];

  } else if (proposal.type === 'merge') {
    const [idA, idB] = proposal.skillIds;
    const skillA = skillMap.get(idA);
    const skillB = skillMap.get(idB);
    if (!skillA || !skillB) return null;

    const mergedId = `${idA}-${idB}`;
    const mergedEntry = {
      id: mergedId,
      when: `When using ${idA} or ${idB} workflows, or combining their capabilities`,
      why: `Merged from ${idA} and ${idB} via evolution engine v0.1`,
      path: skillA.path, // fallback: prefer A's path when nothing can be written
      priority: skillA.priority === 'high' || skillB.priority === 'high' ? 'high' : 'medium',
      version: '0.1.0',
      mergedFrom: [idA, idB],
      usage_count: (skillA.usage_count || 0) + (skillB.usage_count || 0),
      last_used: [skillA.last_used, skillB.last_used].filter(Boolean).sort().pop(),
    };

    const contentA = readSkillContent(skillA.path);
    const contentB = readSkillContent(skillB.path);
    if (contentA === null && contentB === null) {
      noteSkip(mergedId, `neither source skill file is readable (${skillA.path}, ${skillB.path})`);
    } else {
      const content = proposal.content || deriveMergeContent(mergedId, idA, idB, contentA, contentB);
      const target = materializeEntry(mergedId, content, skillA.path || skillB.path);
      if (target) mergedEntry.path = target;
    }

    skills.push(mergedEntry);

    // Archive the originals
    for (const id of [idA, idB]) {
      const s = skillMap.get(id);
      if (s) {
        s.priority = 'archived';
        s.archived = new Date().toISOString();
        s.mergedInto = mergedId;
      }
    }

  } else if (proposal.type === 'rewrite') {
    const skill = skillMap.get(proposal.skillIds[0]);
    if (!skill) return null;

    // Placeholder guard first (issue #43 item 6)
    const sourceContent = readSkillContent(skill.path);
    const newWhen = tightenWhen(skill.when);
    const content = proposal.content || deriveRewriteContent(skill.id, sourceContent || '', newWhen);

    if (sourceContent === null) {
      noteSkip(skill.id, `source skill file not readable: ${skill.path || '(no path)'}`);
    } else {
      const target = materializeEntry(skill.id, content, skill.path);
      if (target) skill.path = target;
    }

    // Index-only behavior always applies (and is the only effect when blocked)
    skill.when = skill.when.replace(/\bgeneral|various|any|multiple|different\b/i, 'specific');
    if (!skill.when.includes('ONLY')) {
      skill.when = `Use ONLY when ${skill.when.trim().toLowerCase()}`;
    }
    skill.version = incrementVersion(skill.version);
    skill.rewrittenBy = 'evolution-engine';
    skill.rewrittenAt = new Date().toISOString();
  }

  if (record.needsAuthoring) {
    proposal.needsAuthoring = true;
    proposal.message = record.message;
  }
  proposal.materialization = record;

  return mutated;
}

/**
 * Increment a semver version string.
 */
function incrementVersion(version) {
  if (!version) return '0.1.0';
  const parts = version.split('.').map(Number);
  if (parts.length < 3) return version;
  parts[2]++;
  return parts.join('.');
}

// ── Full evolution pipeline ─────────────────────────────────────────────────

/**
 * Run the full evolution pipeline: baseline → analyze → read-back → propose → filter → review.
 *
 * @param {object} options
 * @param {string} [options.globalJson]
 * @param {boolean} [options.dryRun]
 * @param {boolean} [options.noBaseline] — skip baseline, use existing
 * @param {string} [options.proposalsPath] — proposal store; its audit trail sits beside it
 * @returns {{ baseline, opportunities, candidates, suppressed, proposals, kept, discarded }}
 */
async function evolve(options = {}) {
  const globalJsonPath = options.globalJson || defaultGlobalJson();
  const dryRun = options.dryRun || false;
  const noBaseline = options.noBaseline || false;
  const proposalsPath = options.proposalsPath || defaultProposalsPath();
  const baselinePath = options.baselinePath || defaultBaselinePath();

  console.log('═══ Autonomous Skill Evolution (v0.1) ═══\n');

  // Step 1: Baseline
  let baseline;
  if (noBaseline || fs.existsSync(baselinePath)) {
    console.log('── Step 1: Loading baseline ──');
    baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
    console.log(`  Loaded: ${baseline.totalScored} skills, avg ${baseline.averageScore}/100 (${baseline.ts})`);
  } else {
    console.log('── Step 1: Running baseline ──');
    baseline = runBaseline(globalJsonPath, baselinePath);
  }

  // Step 2: Analyze
  console.log('\n── Step 2: Analyzing mutations ──');
  let index;
  try {
    index = JSON.parse(fs.readFileSync(globalJsonPath, 'utf-8'));
  } catch {
    throw new Error(`Cannot read ${globalJsonPath}`);
  }

  const opportunities = analyzeMutations(index, baseline);
  console.log(`  Found ${opportunities.length} mutation opportunity(ies)`);
  for (const opp of opportunities.slice(0, 5)) {
    console.log(`    ${opp.type}: ${opp.id} — ${opp.reason.slice(0, 80)}`);
  }

  // Step 2b: Read-back — never re-propose a target+direction already rejected
  const rejectedKeys = buildRejectedKeys(proposalsPath);
  const { kept: candidates, suppressed } = suppressRejected(opportunities, rejectedKeys);
  if (suppressed.length > 0) {
    console.log(`  suppressed ${suppressed.length} previously-rejected candidate(s)`);
    for (const s of suppressed.slice(0, 5)) {
      console.log(`    ⊘ ${s.type}: ${s.id} — already rejected, skipped`);
    }
  }

  // Step 3: Generate proposals
  console.log('\n── Step 3: Generating proposals ──');
  const proposals = generateProposals(index, baseline, candidates);
  console.log(`  Generated ${proposals.length} proposal(s)`);

  // Step 4: Pareto filter
  console.log('\n── Step 4: Pareto filtering ──');
  const { kept, discarded } = paretoFilter(proposals, baseline);
  console.log(`  Kept: ${kept.length}  Discarded: ${discarded.length}`);
  for (const d of discarded) {
    console.log(`    ✗ ${d.id}: ${d.reason}`);
  }

  // Step 5: Write proposals
  if (!dryRun && kept.length > 0) {
    writeProposals(kept, proposalsPath);
    console.log(`\n  ✓ ${kept.length} proposal(s) written for review.`);
  }

  // Step 6: Review
  console.log('\n── Step 5: Review ──');
  const pending = listProposals(proposalsPath);

  return {
    baseline,
    opportunities,
    candidates,
    suppressed,
    proposals,
    kept,
    discarded,
    dryRun,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(`meta-skills evolve — Autonomous skill evolution (v0.1)

Usage:
  meta-skills evolve baseline              Run baseline quality measurement
  meta-skills evolve propose [--dry-run]   Generate mutation proposals
  meta-skills evolve review                List pending proposals + prior rejections
  meta-skills evolve approve <id> [--strict]  Apply an approved proposal (writes SKILL.md files)
  meta-skills evolve reject <id> [--reason "text"]
                                          Reject a proposal — retained as a tombstone
  meta-skills evolve --all                 Full pipeline: baseline → propose → review
  meta-skills evolve loop run|status       K-iteration loop with per-iteration records (issue #36)

Options:
  --global-json <path>     Custom global.json path
  --proposals-path <path>  Custom proposals.jsonl (audit trail sits beside it)
  --reason <text>          Why the proposal was rejected (recorded in the audit trail)
  --dry-run                Preview changes without writing
  --all                    Run the full evolution pipeline
  --strict               Approve only if the proposal is not localized (issue #41)`);
    process.exit(0);
  }

  const cmd = args[0];

  const opts = {
    globalJson: args.includes('--global-json')
      ? args[args.indexOf('--global-json') + 1]
      : defaultGlobalJson(),
    proposalsPath: args.includes('--proposals-path')
      ? args[args.indexOf('--proposals-path') + 1]
      : defaultProposalsPath(),
    reason: args.includes('--reason') ? args[args.indexOf('--reason') + 1] : null,
    dryRun: args.includes('--dry-run'),
    strict: args.includes('--strict'),
    force: args.includes('--force'),
  };

  switch (cmd) {
    case 'baseline':
      runBaseline(opts.globalJson);
      break;
    case 'propose':
      evolve({ ...opts, noBaseline: true });
      break;
    case 'review':
      listProposals(opts.proposalsPath);
      break;
    case 'approve': {
      const id = args[1];
      if (!id) { console.error('Usage: meta-skills evolve approve <id>'); process.exit(1); }
      const mutated = approveProposal(id, opts.globalJson, opts.proposalsPath, { strict: opts.strict, force: opts.force });
      if (!mutated) process.exit(1);
      break;
    }
    case 'reject': {
      const id = args[1];
      if (!id) { console.error('Usage: meta-skills evolve reject <id> [--reason "text"]'); process.exit(1); }
      rejectProposal(id, opts.proposalsPath, opts.reason);
      break;
    }
    case '--all':
    case 'all':
      evolve(opts);
      break;
    case 'loop': {
      // Delegated to src/evolution-loop.mjs (issue #36). Dynamic import keeps
      // the two modules acyclic at load time.
      const loop = await import('./evolution-loop.mjs');
      await loop.cmdLoop(args.slice(1));
      break;
    }
    default:
      console.error(`Unknown evolve subcommand: ${cmd}`);
      process.exit(1);
  }
}

const isMain = process.argv[1] && (
  process.argv[1] === fileURLToPath(import.meta.url)
  || process.argv[1].endsWith('evolution.mjs')
);
if (isMain) main().catch((e) => { console.error(`✗ ${e.message}`); process.exit(1); });

export {
  runBaseline,
  analyzeMutations,
  generateProposals,
  paretoFilter,
  buildRejectedKeys,
  suppressRejected,
  approveProposal,
  rejectProposal,
  readProposals,
  listProposals,
  applyMutation,
  evolve,
  recordProvenance,
  defaultEvolveDir,
  defaultBaselinePath,
  defaultProposalsPath,
  PLACEHOLDER_MARKERS,
  containsPlaceholder,
  findPlaceholderMarkers,
  shortHash,
  dedupeKey,
  skillsRootFromEntry,
  writeSkillFile,
  deriveSplitContent,
  deriveMergeContent,
  deriveRewriteContent,
};

// Also export writeProposals for internal use
export { writeProposals };
