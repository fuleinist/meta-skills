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
 *
 * Inspiration: EvoSkill (arXiv 2603.02766) — 7.3% OfficeQA gain, 12.1% SealQA gain
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { scoreAll } from './quality-scorer.mjs';
import { takeSnapshot } from './rollback-ledger.mjs';

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

  for (const opp of opportunities) {
    const proposal = {
      id: `${opp.type}-${opp.id}-${Date.now()}`,
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

      proposal.diff = generateRewriteDiff(opp.id, skillContent);
      proposal.afterScores = estimateAfterScores(proposal.beforeScores, 'rewrite');
    }

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
 * Generate a rewrite-diff: full rewrite with structured improvements.
 */
function generateRewriteDiff(skillId, existingContent) {
  const template = `---\nname: ${skillId}\ndescription: Auto-improved version with tighter trigger and structured guidance\n---\n\n# ${skillId}\n\n## When to Use\n\nUse this skill ONLY when the task explicitly matches the documented trigger criteria.\n\n## How to Use\n\n1. Verify the task matches this skill's domain\n2. Follow the steps below in order\n3. Validate output before returning\n\n## Steps\n\n1. **Context check**: Confirm this skill applies\n2. **Execute**: Apply the skill's methodology\n3. **Validate**: Check output quality\n\n## Anti-Patterns\n\n- Do NOT use for tasks outside this skill's domain\n- Do NOT skip validation steps\n\n## Examples\n\n\`\`\`bash\n# Example usage here\n\`\`\`\n\n*Auto-generated by meta-skills v0.1 evolution engine.*`;

  return `--- a/skills/${skillId}/SKILL.md\n+++ b/skills/${skillId}/SKILL.md\n@@ -1,${Math.max(existingContent.split('\n').length, 1)} +1,30 @@\n-${existingContent.split('\n').slice(0, 5).join('\n-')}\n+${template.split('\n').join('\n+')}`;
}

/**
 * Extract meaningful first lines from content (for split diff).
 */
function newForcedLines(content) {
  return content.split('\n')
    .filter(l => l.trim() && !l.startsWith('---') && !l.startsWith('#'))
    .slice(0, 8);
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
 * Write proposals to the proposals JSONL file.
 */
function writeProposals(proposals, proposalsPath = defaultProposalsPath()) {
  const dir = path.dirname(proposalsPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const existing = readProposals(proposalsPath);
  const existingIds = new Set(existing.map(p => p.id));

  // Append new proposals (skip duplicates by id)
  const toWrite = proposals.filter(p => !existingIds.has(p.id));
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
 * List pending proposals with human-readable output.
 */
function listProposals(proposalsPath = defaultProposalsPath()) {
  const proposals = readProposals(proposalsPath);
  const pending = proposals.filter(p => p.status === 'pending');

  if (pending.length === 0) {
    console.log('No pending proposals.');
    return [];
  }

  console.log(`Pending proposals (${pending.length}):\n`);
  for (const p of pending) {
    const delta = p.scoreDelta;
    const deltaStr = delta
      ? `  Score: ${p.beforeScore} → ${p.afterScore} (+${delta.overall})`
      : '';
    console.log(`  ${p.id}`);
    console.log(`    Type: ${p.type}  |  Skill(s): ${p.skillIds.join(', ')}`);
    console.log(`    ${p.reason}`);
    console.log(deltaStr);
    console.log(`    Confidence: ${Math.round(p.confidence * 100)}%`);
    console.log();
  }

  return pending;
}

/**
 * Approve a proposal: apply its diff to a working copy of global.json.
 * Returns the mutated index or null on failure.
 */
function approveProposal(id, globalJsonPath = defaultGlobalJson(), proposalsPath = defaultProposalsPath()) {
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

  // Snapshot before mutation
  try { takeSnapshot({ globalJsonPath, comment: `evolve-approve:${id}` }); } catch { /* best-effort */ }

  // Apply mutation
  const mutated = applyMutation(proposal, index);
  if (!mutated) throw new Error(`Failed to apply mutation for ${id}`);

  // Write mutated index
  const tmpPath = globalJsonPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(mutated, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmpPath, globalJsonPath);

  // Mark proposal as approved
  proposal.status = 'approved';
  proposal.approvedAt = new Date().toISOString();
  fs.writeFileSync(proposalsPath, proposals.map(p => JSON.stringify(p)).join('\n') + '\n', 'utf-8');

  console.log(`✓ Approved and applied: ${id}`);
  console.log(`  Mutated index written to ${globalJsonPath}`);
  return mutated;
}

/**
 * Reject a proposal: mark it as rejected.
 */
function rejectProposal(id, proposalsPath = defaultProposalsPath()) {
  const proposals = readProposals(proposalsPath);
  const proposal = proposals.find(p => p.id === id);
  if (!proposal) throw new Error(`Proposal not found: ${id}`);

  proposal.status = 'rejected';
  proposal.rejectedAt = new Date().toISOString();
  fs.writeFileSync(proposalsPath, proposals.map(p => JSON.stringify(p)).join('\n') + '\n', 'utf-8');

  console.log(`✗ Rejected: ${id}`);
}

// ── Mutation application ────────────────────────────────────────────────────

/**
 * Apply a mutation to a clone of the index.
 * Returns the mutated clone, or null if mutation cannot be applied.
 */
function applyMutation(proposal, index) {
  const mutated = JSON.parse(JSON.stringify(index));
  const skills = mutated.skills || [];
  const skillMap = new Map(skills.map(s => [s.id, s]));

  if (proposal.type === 'split') {
    const skill = skillMap.get(proposal.skillIds[0]);
    if (!skill) return null;

    // Create a new core sub-skill
    const coreId = `${proposal.skillIds[0]}-core`;
    skills.push({
      ...skill,
      id: coreId,
      when: `${skill.when} (core functionality only)`,
      priority: skill.priority === 'high' ? 'high' : 'medium',
      version: skill.version ? incrementVersion(skill.version) : '0.1.0',
    });

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
    skills.push({
      id: mergedId,
      when: `When using ${idA} or ${idB} workflows, or combining their capabilities`,
      why: `Merged from ${idA} and ${idB} via evolution engine v0.1`,
      path: skillA.path, // prefer A's path
      priority: skillA.priority === 'high' || skillB.priority === 'high' ? 'high' : 'medium',
      version: '0.1.0',
      mergedFrom: [idA, idB],
      usage_count: (skillA.usage_count || 0) + (skillB.usage_count || 0),
      last_used: [skillA.last_used, skillB.last_used].filter(Boolean).sort().pop(),
    });

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

    // Rewrite the when field and add structure hints
    skill.when = skill.when.replace(/\bgeneral|various|any|multiple|different\b/i, 'specific');
    if (!skill.when.includes('ONLY')) {
      skill.when = `Use ONLY when ${skill.when.trim().toLowerCase()}`;
    }
    skill.version = incrementVersion(skill.version);
    skill.rewrittenBy = 'evolution-engine';
    skill.rewrittenAt = new Date().toISOString();
  }

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
 * Run the full evolution pipeline: baseline → analyze → propose → filter → review.
 *
 * @param {object} options
 * @param {string} [options.globalJson]
 * @param {boolean} [options.dryRun]
 * @param {boolean} [options.noBaseline] — skip baseline, use existing
 * @returns {{ baseline, opportunities, proposals, kept, discarded }}
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

  // Step 3: Generate proposals
  console.log('\n── Step 3: Generating proposals ──');
  const proposals = generateProposals(index, baseline, opportunities);
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
    proposals,
    kept,
    discarded,
    dryRun,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(`meta-skills evolve — Autonomous skill evolution (v0.1)

Usage:
  meta-skills evolve baseline              Run baseline quality measurement
  meta-skills evolve propose [--dry-run]   Generate mutation proposals
  meta-skills evolve review                List pending proposals
  meta-skills evolve approve <id>          Apply an approved proposal
  meta-skills evolve reject <id>           Discard a proposal
  meta-skills evolve --all                 Full pipeline: baseline → propose → review

Options:
  --global-json <path>   Custom global.json path
  --dry-run              Preview changes without writing
  --all                  Run the full evolution pipeline`);
    process.exit(0);
  }

  const cmd = args[0];

  const opts = {
    globalJson: args.includes('--global-json')
      ? args[args.indexOf('--global-json') + 1]
      : defaultGlobalJson(),
    dryRun: args.includes('--dry-run'),
  };

  switch (cmd) {
    case 'baseline':
      runBaseline(opts.globalJson);
      break;
    case 'propose':
      evolve({ ...opts, noBaseline: true });
      break;
    case 'review':
      listProposals();
      break;
    case 'approve': {
      const id = args[1];
      if (!id) { console.error('Usage: meta-skills evolve approve <id>'); process.exit(1); }
      approveProposal(id, opts.globalJson);
      break;
    }
    case 'reject': {
      const id = args[1];
      if (!id) { console.error('Usage: meta-skills evolve reject <id>'); process.exit(1); }
      rejectProposal(id, opts.globalJson);
      break;
    }
    case '--all':
    case 'all':
      evolve(opts);
      break;
    default:
      console.error(`Unknown evolve subcommand: ${cmd}`);
      process.exit(1);
  }
}

const isMain = process.argv[1] && (
  process.argv[1] === fileURLToPath(import.meta.url)
  || process.argv[1].endsWith('evolution.mjs')
);
if (isMain) main();

export {
  runBaseline,
  analyzeMutations,
  generateProposals,
  paretoFilter,
  approveProposal,
  rejectProposal,
  readProposals,
  listProposals,
  applyMutation,
  evolve,
  defaultEvolveDir,
  defaultBaselinePath,
  defaultProposalsPath,
};

// Also export writeProposals for internal use
export { writeProposals };
