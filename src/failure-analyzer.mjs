#!/usr/bin/env node

/**
 * meta-skills v1.3 — Failure-based auto-improvement
 *
 * When a skill activation records outcome=failure, scan the logs,
 * read the relevant SKILL.md, and generate a proposed patch (diff)
 * to improve the skill. Human reviews via PR.
 *
 * Commands:
 *   propose [--since <days>] [--dry-run]
 *     Scan failure logs and generate proposals for each skill.
 *   propose list [--proposals-dir <path>]
 *     List pending proposals.
 *   propose apply <id> [--proposals-dir <path>]
 *     Apply a proposal (opens file for review, or creates PR).
 *   propose reject <id> [--proposals-dir <path>]
 *     Delete a proposal.
 *   propose auto-pr <id> [--proposals-dir <path>]
 *     File a PR via gh CLI with the proposed patch.
 *
 * Inspired by:
 *   - EvoSkill (7.3% accuracy gain via failure analysis)
 *   - BerriAI/self-improving-agent (human-in-the-loop skill improvement)
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Default paths ──────────────────────────────────────────────

function defaultLogDir() {
  return path.join(os.homedir(), '.meta-skills', 'logs');
}

function defaultGlobalJson() {
  return path.join(os.homedir(), '.meta-skills', 'global.json');
}

function defaultProposalsDir() {
  return path.join(os.homedir(), '.meta-skills', 'proposals');
}

// ── Failure grouping ───────────────────────────────────────────

/**
 * Scan log files for outcome=failure events, grouped by skill.
 * @param {string} logDir - Path to ~/.meta-skills/logs/
 * @param {number} [sinceDays=7] - Only look at logs within this many days
 * @returns {Map<string, Array<{timestamp, outcome, skill}>>}
 */
function groupFailuresBySkill(logDir, sinceDays = 7) {
  const failures = new Map(); // skillId -> events[]
  const cutoff = Date.now() - sinceDays * 24 * 60 * 60 * 1000;

  let logFiles;
  try {
    logFiles = fs.readdirSync(logDir).filter(f => f.endsWith('.jsonl'));
  } catch {
    return failures;
  }

  for (const logFile of logFiles) {
    // Parse date from filename: YYYY-MM-DD.jsonl
    const dateStr = logFile.replace('.jsonl', '');
    const fileDate = new Date(dateStr + 'T00:00:00Z').getTime();
    if (isNaN(fileDate) || fileDate < cutoff) continue;

    const content = fs.readFileSync(path.join(logDir, logFile), 'utf-8');
    for (const line of content.trim().split('\n').filter(Boolean)) {
      try {
        const event = JSON.parse(line);
        if (event.outcome === 'failure') {
          if (!failures.has(event.skill)) {
            failures.set(event.skill, []);
          }
          failures.get(event.skill).push(event);
        }
      } catch {
        // skip malformed lines
      }
    }
  }

  return failures;
}

// ── SKILL.md reader ────────────────────────────────────────────

/**
 * Read the SKILL.md content for a given skill from global.json.
 * @param {string} skillId
 * @param {string} [globalJsonPath]
 * @returns {{ content: string|null, entry: object|null }}
 */
function readSkillMd(skillId, globalJsonPath) {
  const gjPath = globalJsonPath || defaultGlobalJson();
  let index;
  try {
    index = JSON.parse(fs.readFileSync(gjPath, 'utf-8'));
  } catch {
    return { content: null, entry: null };
  }

  const entry = index.skills.find(s => s.id === skillId)
    || (index.stale || []).find(s => s.id === skillId);
  if (!entry || !entry.path) return { content: null, entry: null };

  let content;
  try {
    content = fs.readFileSync(entry.path, 'utf-8');
  } catch {
    return { content: null, entry };
  }

  return { content, entry };
}

// ── Patch generation ───────────────────────────────────────────

/**
 * Analyze failures and generate a proposed patch for the skill.
 *
 * Three patch types:
 * 1. Tighten `when:` — failures suggest wrong-context activation
 * 2. Add anti-pattern section — common mistake pattern
 * 3. Split suggestion — heterogeneous failures
 *
 * @param {string} skillId
 * @param {Array} failures - Failure events for this skill
 * @param {string} skillContent - Current SKILL.md content
 * @param {object} entry - Skill entry from global.json
 * @returns {{ patch: string|null, type: string, summary: string }}
 */
function generatePatch(skillId, failures, skillContent, entry) {
  if (!skillContent) {
    return { patch: null, type: 'no-content', summary: 'SKILL.md not found on disk' };
  }

  const failureCount = failures.length;
  const failureReasons = analyzeFailurePatterns(failures, skillContent);

  // Determine patch type based on failure patterns
  if (failureReasons.suggestsWrongTrigger) {
    return generateWhenTightenPatch(skillId, skillContent, entry, failureReasons);
  }

  if (failureReasons.suggestsAntiPattern) {
    return generateAntiPatternPatch(skillId, skillContent, entry, failureReasons);
  }

  if (failureReasons.suggestsSplit) {
    return generateSplitSuggestion(skillId, skillContent, entry, failureReasons);
  }

  // Fallback: generic improvement suggestion
  return generateGenericPatch(skillId, skillContent, entry, failureReasons);
}

/**
 * Analyze failure events for patterns.
 * Returns structured analysis of what went wrong.
 */
function analyzeFailurePatterns(failures, skillContent) {
  const result = {
    suggestsWrongTrigger: false,
    suggestsAntiPattern: false,
    suggestsSplit: false,
    reasons: [],
    failureCount: failures.length,
  };

  // Count unique timestamps — if all failures happened on different days
  // and the skill was used in diverse contexts, it might be a trigger issue
  const days = new Set(failures.map(f => (f.timestamp || '').slice(0, 10)));
  const dayRatio = days.size / Math.max(failures.length, 1);

  // Check if the skill's `when` field is vague (heuristic)
  const whenMatch = skillContent.match(/when\s*:\s*(.+)/i);
  const whenText = whenMatch ? whenMatch[1] : '';
  const isWhenVague = whenText.length < 20 || /general|various|any/i.test(whenText);

  // Check if the skill content is very short (may lack guidance)
  const isContentShort = skillContent.trim().split('\n').length < 10;

  if (isWhenVague && failures.length >= 2) {
    result.suggestsWrongTrigger = true;
    result.reasons.push('The `when` field is vague or missing — failures suggest the skill activates in wrong contexts');
  }

  if (dayRatio > 0.5 && failures.length >= 3) {
    result.suggestsWrongTrigger = true;
    result.reasons.push(`Failures span ${days.size} different days — consistent failure pattern suggests wrong activation trigger`);
  }

  if (isContentShort && failures.length >= 2) {
    result.suggestsAntiPattern = true;
    result.reasons.push('Skill content is short — adding explicit anti-patterns may prevent repeated failures');
  }

  if (failures.length >= 5) {
    result.suggestsSplit = true;
    result.reasons.push(`High failure count (${failures.length}) — consider splitting into sub-skills for specific scenarios`);
  }

  return result;
}

/**
 * Generate a patch that tightens the `when:` field.
 */
function generateWhenTightenPatch(skillId, content, entry, reasons) {
  const lines = content.split('\n');
  const whenIdx = lines.findIndex(l => /^when\s*:/i.test(l));

  if (whenIdx < 0) {
    // No `when:` field — add one after the frontmatter
    const fmEnd = content.indexOf('---', content.indexOf('---') + 3);
    if (fmEnd < 0) return { patch: null, type: 'no-frontmatter', summary: 'No frontmatter found' };

    const insertAt = fmEnd + 4; // after ---\n
    const newWhen = `when: ${reasons.reasons[0] || 'Use only when the specific task matches this skill\'s domain'}`;
    const patch = createUnifiedDiff(skillId, content,
      content.slice(0, insertAt) + `when: ${newWhen}\n` + content.slice(insertAt)
    );
    return {
      patch,
      type: 'add-when',
      summary: `Add missing \`when:\` field — ${reasons.reasons[0] || 'prevent wrong-context activation'}`,
    };
  }

  // Tighten existing when field
  const currentWhen = lines[whenIdx];
  const tightened = currentWhen.replace(/:\s*.+/, `: ${reasons.reasons[0] || 'Use only when the task explicitly matches this skill\'s documented purpose'}`);
  const patch = createUnifiedDiff(skillId, content,
    lines.map((l, i) => i === whenIdx ? tightened : l).join('\n')
  );
  return {
    patch,
    type: 'tighten-when',
    summary: `Tighten \`when:\` field — ${reasons.reasons[0] || 'failures suggest wrong-context activation'}`,
  };
}

/**
 * Generate a patch that adds an anti-patterns section.
 */
function generateAntiPatternPatch(skillId, content, entry, reasons) {
  const antiPatternSection = `

## Anti-Patterns

When using this skill, avoid:

- **Over-generalization**: This skill is designed for specific scenarios. Do not use it as a catch-all solution.
- **Incorrect context**: Verify the task matches this skill's domain before activating.

*This section was auto-generated based on failure analysis. Review and update with specific patterns relevant to this skill.*
`;

  const patch = createUnifiedDiff(skillId, content, content + antiPatternSection);
  return {
    patch,
    type: 'add-anti-patterns',
    summary: `Add anti-patterns section — ${reasons.reasons[0] || 'repeated failures suggest missing guidance'}`,
  };
}

/**
 * Generate a suggestion to split the skill.
 */
function generateSplitSuggestion(skillId, content, entry, reasons) {
  const note = `

## ⚠️ Suggested Split

This skill has ${reasons.failureCount} recorded failures. Consider splitting it into more focused sub-skills:

1. **${skillId}-core**: The essential functionality that works reliably
2. **${skillId}-advanced**: Advanced use cases that may need more guidance

*This suggestion was auto-generated. Review failure logs at \`~/.meta-skills/logs/\` for details.*
`;

  const patch = createUnifiedDiff(skillId, content, content + note);
  return {
    patch,
    type: 'suggest-split',
    summary: `Suggest splitting ${skillId} — ${reasons.failureCount} failures indicate heterogeneous use cases`,
  };
}

/**
 * Fallback: generic improvement patch.
 */
function generateGenericPatch(skillId, content, entry, reasons) {
  const note = `

## Improvement Notes

This skill has ${reasons.failureCount} recorded failure(s). Review the failure logs and consider:

1. Adding more specific usage examples
2. Clarifying when NOT to use this skill
3. Adding error recovery guidance

*This note was auto-generated by meta-skills v1.3 failure analysis.*
`;

  const patch = createUnifiedDiff(skillId, content, content + note);
  return {
    patch,
    type: 'generic-improvement',
    summary: `Add improvement notes — ${reasons.failureCount} failure(s) recorded for ${skillId}`,
  };
}

/**
 * Create a unified-diff-format patch string.
 */
function createUnifiedDiff(skillId, oldContent, newContent) {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  let diff = `--- a/skills/${skillId}/SKILL.md\n+++ b/skills/${skillId}/SKILL.md\n`;

  // Simple line-by-line diff (not full unified diff, but sufficient for review)
  const maxLen = Math.max(oldLines.length, newLines.length);
  let hunkStart = -1;
  let hunkOld = [];
  let hunkNew = [];

  function flushHunk() {
    if (hunkOld.length === 0 && hunkNew.length === 0) return;
    diff += `@@ -${hunkStart + 1},${hunkOld.length} +${hunkStart + 1},${hunkNew.length} @@\n`;
    for (const l of hunkOld) diff += `-${l}\n`;
    for (const l of hunkNew) diff += `+${l}\n`;
    hunkOld = [];
    hunkNew = [];
  }

  for (let i = 0; i < maxLen; i++) {
    const oldLine = i < oldLines.length ? oldLines[i] : undefined;
    const newLine = i < newLines.length ? newLines[i] : undefined;

    if (oldLine === newLine) {
      flushHunk();
      hunkStart = i + 1;
    } else {
      if (hunkStart < 0) hunkStart = i;
      if (oldLine !== undefined) hunkOld.push(oldLine);
      if (newLine !== undefined) hunkNew.push(newLine);
    }
  }
  flushHunk();

  return diff;
}

// ── Proposal file management ───────────────────────────────────

function proposalFilename(skillId) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${skillId}-${ts}.patch`;
}

function writeProposal(skillId, patch, type, summary, proposalsDir) {
  const dir = proposalsDir || defaultProposalsDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const filename = proposalFilename(skillId);
  const filePath = path.join(dir, filename);

  const proposal = {
    meta: {
      skill: skillId,
      generated: new Date().toISOString(),
      type,
      summary,
      version: '1.3.0',
    },
    diff: patch,
  };

  fs.writeFileSync(filePath, JSON.stringify(proposal, null, 2) + '\n', 'utf-8');
  return filePath;
}

function listProposals(proposalsDir) {
  const dir = proposalsDir || defaultProposalsDir();
  let files;
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.patch'));
  } catch {
    return [];
  }

  return files.map(f => {
    const filePath = path.join(dir, f);
    try {
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      return {
        file: f,
        filePath,
        ...content.meta,
      };
    } catch {
      return { file: f, filePath, skill: 'unknown', generated: null, type: 'unknown', summary: '(unparseable)' };
    }
  }).sort((a, b) => {
    if (!a.generated) return 1;
    if (!b.generated) return -1;
    return b.generated.localeCompare(a.generated);
  });
}

function readProposal(id, proposalsDir) {
  const dir = proposalsDir || defaultProposalsDir();
  const filePath = path.join(dir, id.endsWith('.patch') ? id : `${id}.patch`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function deleteProposal(id, proposalsDir) {
  const dir = proposalsDir || defaultProposalsDir();
  const filePath = path.join(dir, id.endsWith('.patch') ? id : `${id}.patch`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`proposal not found: ${id}`);
  }
  fs.unlinkSync(filePath);
  return filePath;
}

// ── Auto-PR via gh CLI ─────────────────────────────────────────

function autoPr(proposal, proposalsDir) {
  const { meta, diff } = proposal;

  // Create a temp branch and file
  const branchName = `fix/${meta.skill}-failure-analysis-${Date.now()}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-skills-pr-'));
  const skillFile = path.join(tempDir, 'SKILL.md');

  try {
    // Write the patched SKILL.md
    fs.writeFileSync(skillFile, applyPatchToContent(diff), 'utf-8');

    // Use gh CLI to create PR
    const repo = detectRepo();
    if (!repo) {
      throw new Error('Cannot detect git repo. Set META_SKILLS_REPO env var or run from a git repo.');
    }

    const prBody = [
      `## Auto-generated: ${meta.summary}`,
      '',
      `This PR was auto-generated by meta-skills v1.3 failure analysis.`,
      '',
      `**Skill:** \`${meta.skill}\``,
      `**Type:** ${meta.type}`,
      `**Generated:** ${meta.generated}`,
      '',
      '### Changes',
      '',
      '```diff',
      diff,
      '```',
      '',
      '### Context',
      '',
      `${meta.failureCount || 'Multiple'} failure(s) recorded for this skill.`,
      'Review the proposed changes and adjust as needed before merging.',
      '',
      '---',
      '*This PR was auto-generated. Human review required before merge.*',
    ].join('\n');

    const result = execSync(
      `gh pr create --repo "${repo}" --base main --head "${branchName}" --title "fix(${meta.skill}): ${meta.summary}" --body "${prBody}"`,
      { encoding: 'utf-8', stdio: 'pipe', timeout: 30000 }
    );

    return result.trim();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function detectRepo() {
  if (process.env.META_SKILLS_REPO) return process.env.META_SKILLS_REPO;
  try {
    const remote = execSync('git remote get-url origin', { encoding: 'utf-8', stdio: 'pipe', timeout: 5000 }).trim();
    // Convert SSH to HTTPS if needed
    const match = remote.match(/github\.com[:\/](.+?)(?:\.git)?$/);
    if (match) return match[1];
    return remote;
  } catch {
    return null;
  }
}

function applyPatchToContent(diff) {
  // Simple patch application: extract + lines
  const plusLines = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
  return plusLines.map(l => l.slice(1)).join('\n');
}

// ── Main analysis entry point ──────────────────────────────────

/**
 * Analyze failures and generate proposals.
 * @param {object} options
 * @param {string} [options.logDir]
 * @param {string} [options.globalJson]
 * @param {string} [options.proposalsDir]
 * @param {number} [options.sinceDays=7]
 * @param {boolean} [options.dryRun=false]
 * @returns {Array<{skillId, type, summary, filePath}>}
 */
function analyzeFailures(options = {}) {
  const logDir = options.logDir || defaultLogDir();
  const globalJsonPath = options.globalJson || defaultGlobalJson();
  const proposalsDir = options.proposalsDir || defaultProposalsDir();
  const sinceDays = options.sinceDays || 7;
  const dryRun = options.dryRun || false;

  console.log(`🔍 Failure analysis (last ${sinceDays} days)`);

  // Step 1: Group failures by skill
  const failuresBySkill = groupFailuresBySkill(logDir, sinceDays);
  if (failuresBySkill.size === 0) {
    console.log('  No failures found in logs.');
    return [];
  }
  console.log(`  Found failures in ${failuresBySkill.size} skill(s):`);
  for (const [skillId, events] of failuresBySkill) {
    console.log(`    ${skillId}: ${events.length} failure(s)`);
  }

  // Step 2: For each skill with >= 1 failure, generate a proposal
  const proposals = [];
  for (const [skillId, failures] of failuresBySkill) {
    console.log(`\n  Analyzing ${skillId}...`);

    const { content, entry } = readSkillMd(skillId, globalJsonPath);
    if (!content) {
      console.log(`    SKIP: SKILL.md not found for ${skillId}`);
      continue;
    }

    const result = generatePatch(skillId, failures, content, entry);
    if (!result.patch) {
      console.log(`    SKIP: ${result.summary}`);
      continue;
    }

    console.log(`    → ${result.summary}`);

    if (dryRun) {
      console.log(`    (dry-run, patch not written)`);
      console.log(result.patch);
    } else {
      const filePath = writeProposal(skillId, result.patch, result.type, result.summary, proposalsDir);
      console.log(`    ✓ Proposal written: ${filePath}`);
      proposals.push({ skillId, type: result.type, summary: result.summary, filePath });
    }
  }

  if (proposals.length === 0 && !dryRun) {
    console.log('\n  No proposals generated.');
  } else if (proposals.length > 0) {
    console.log(`\n  ${proposals.length} proposal(s) generated.`);
    console.log('  Run `meta-skills propose list` to see them.');
    console.log('  Run `meta-skills propose apply <id>` to apply one.');
  }

  return proposals;
}

// ── CLI wrappers ───────────────────────────────────────────────

async function cmdPropose(args) {
  const options = parseProposeArgs(args);

  const subcommand = args[0];

  switch (subcommand) {
    case 'list': {
      const proposals = listProposals(options.proposalsDir);
      if (proposals.length === 0) {
        console.log('  No pending proposals.');
        return;
      }
      console.log(`  ${proposals.length} proposal(s):\n`);
      for (const p of proposals) {
        const ts = p.generated ? p.generated.slice(0, 16).replace('T', ' ') : '(unknown)';
        console.log(`  ${p.file}`);
        console.log(`    Skill: ${p.skill}  |  Type: ${p.type}  |  Generated: ${ts}`);
        console.log(`    ${p.summary}`);
      }
      break;
    }

    case 'apply': {
      const id = args[1];
      if (!id) throw new Error('Usage: meta-skills propose apply <id>');

      const proposal = readProposal(id, options.proposalsDir);
      if (!proposal) throw new Error(`Proposal not found: ${id}`);

      console.log(`  Applying proposal for ${proposal.meta.skill}...`);
      console.log(`  Type: ${proposal.meta.type}`);
      console.log(`  Summary: ${proposal.meta.summary}`);
      console.log('');
      console.log('  Proposed diff:');
      console.log(proposal.diff);
      console.log('');
      console.log('  To apply manually, update the SKILL.md with the changes above.');
      console.log('  To file a PR, run: meta-skills propose auto-pr <id>');
      break;
    }

    case 'reject': {
      const id = args[1];
      if (!id) throw new Error('Usage: meta-skills propose reject <id>');

      const filePath = deleteProposal(id, options.proposalsDir);
      console.log(`  ✗ Proposal deleted: ${filePath}`);
      break;
    }

    case 'auto-pr': {
      const id = args[1];
      if (!id) throw new Error('Usage: meta-skills propose auto-pr <id>');

      const proposal = readProposal(id, options.proposalsDir);
      if (!proposal) throw new Error(`Proposal not found: ${id}`);

      console.log(`  Creating PR for ${proposal.meta.skill}...`);
      const url = autoPr(proposal, options.proposalsDir);
      console.log(`  ✓ PR created: ${url}`);
      break;
    }

    default:
      // No subcommand = run analysis
      analyzeFailures(options);
  }
}

function parseProposeArgs(argv) {
  const options = {
    sinceDays: 7,
    dryRun: false,
    proposalsDir: null,
    logDir: null,
    globalJson: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--since' && i + 1 < argv.length) options.sinceDays = parseInt(argv[++i], 10);
    else if (a === '--dry-run') options.dryRun = true;
    else if (a === '--proposals-dir' && i + 1 < argv.length) options.proposalsDir = path.resolve(argv[++i]);
    else if (a === '--log-dir' && i + 1 < argv.length) options.logDir = path.resolve(argv[++i]);
    else if (a === '--global-json' && i + 1 < argv.length) options.globalJson = path.resolve(argv[++i]);
  }

  return options;
}

// ── Standalone entry ───────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(`Usage:
  meta-skills propose [--since <days>] [--dry-run]
  meta-skills propose list
  meta-skills propose apply <id>
  meta-skills propose reject <id>
  meta-skills propose auto-pr <id>`);
    process.exit(0);
  }

  try {
    await cmdPropose(args);
  } catch (e) {
    console.error(`  ! ${e.message}`);
    process.exit(1);
  }
}

const isMain = process.argv[1] && (
  process.argv[1] === fileURLToPath(import.meta.url)
  || process.argv[1].endsWith('failure-analyzer.mjs')
);
if (isMain) main();

export {
  groupFailuresBySkill,
  readSkillMd,
  generatePatch,
  analyzeFailurePatterns,
  analyzeFailures,
  writeProposal,
  listProposals,
  readProposal,
  deleteProposal,
  cmdPropose,
  defaultProposalsDir,
};
