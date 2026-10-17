#!/usr/bin/env node

/**
 * meta-skills v0.1 — Evolution engine tests
 *
 * Covers baseline, mutation analysis, proposal generation, Pareto filtering,
 * and approval/rejection workflows.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  runBaseline,
  analyzeMutations,
  generateProposals,
  paretoFilter,
  approveProposal,
  rejectProposal,
  readProposals,
  listProposals,
  writeProposals,
  applyMutation,
  containsPlaceholder,
  findPlaceholderMarkers,
  evolve,
  defaultEvolveDir,
  defaultBaselinePath,
  defaultProposalsPath,
} from './evolution.mjs';
import { takeSnapshot } from './rollback-ledger.mjs';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'meta-skills-ev-'));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf-8');
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeIndex(opts = {}) {
  const { skills = [], stale = [] } = opts;
  return {
    $schema: 'https://meta-skills.dev/schema/v1.json',
    version: '1.0',
    generated: new Date().toISOString(),
    source: 'global',
    skills,
    stale,
  };
}

function makeSkill(id, overrides = {}) {
  return {
    id,
    when: 'when doing something related to this skill',
    why: 'provides value for that task',
    path: '',
    priority: 'medium',
    usage_count: 5,
    last_used: new Date().toISOString(),
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

try {
  // ── runBaseline ───────────────────────────────────────────────────────────
  console.log('runBaseline:');
  {
    const dir = tmpDir();
    try {
      const gjPath = path.join(dir, 'global.json');
      const blPath = path.join(dir, 'baseline.json');

      const index = makeIndex({
        skills: [
          makeSkill('good-skill', {
            when: 'writing commit messages and generating changelogs for git repos',
            path: path.join(dir, 'good.md'),
          }),
          makeSkill('vague-skill', {
            when: 'general use various stuff',
            path: path.join(dir, 'vague.md'),
            priority: 'low',
          }),
        ],
      });

      // Create SKILL.md files
      writeFile(path.join(dir, 'good.md'), `---\ndescription: Good skill\n---\n\n# Good Skill\n\n1. Do this\n2. Do that\n\n\`\`\`bash\ngit commit -m "fix: something"\n\`\`\`\n`);
      writeFile(path.join(dir, 'vague.md'), `when: general use various stuff\n\n# Vague\n\nJust a short vague skill.\n`);

      index.skills[0].path = path.join(dir, 'good.md');
      index.skills[1].path = path.join(dir, 'vague.md');
      writeFile(gjPath, JSON.stringify(index, null, 2));

      const baseline = runBaseline(gjPath, blPath);
      assert.ok(baseline.totalScored >= 2, `expected >= 2 scored, got ${baseline.totalScored}`);
      assert.ok(baseline.averageScore > 0, `expected positive avg score, got ${baseline.averageScore}`);
      assert.ok(baseline.skills.length >= 2, `expected >= 2 skills in baseline, got ${baseline.skills.length}`);
      assert.ok(fs.existsSync(blPath), 'baseline file created');
      console.log('  ✓ baseline recorded with scores');
    } finally {
      cleanup(dir);
    }
  }

  // ── analyzeMutations ──────────────────────────────────────────────────────
  console.log('\nanalyzeMutations:');
  {
    const dir = tmpDir();
    try {
      const gjPath = path.join(dir, 'global.json');
      const blPath = path.join(dir, 'baseline.json');

      const vagueContent = `when: general use various stuff\n\n# Vague Skill\n\nNo structure here.\n`;
      writeFile(path.join(dir, 'vague.md'), vagueContent);

      const index = makeIndex({
        skills: [
          makeSkill('vague-skill', {
            when: 'general use various stuff',
            path: path.join(dir, 'vague.md'),
            priority: 'low',
          }),
          makeSkill('good-skill', {
            when: 'reviewing pull requests and analyzing code quality for improvements',
            path: path.join(dir, 'good.md'),
            priority: 'high',
          }),
        ],
      });

      writeFile(path.join(dir, 'good.md'), `---\ndescription: Good skill\n---\n\n# Good\n\n1. Step one\n2. Step two\n`);

      writeFile(gjPath, JSON.stringify(index, null, 2));
      const baseline = runBaseline(gjPath, blPath);

      const opportunities = analyzeMutations(index, baseline);
      const vagueOpp = opportunities.find(o => o.id === 'vague-skill');
      assert.ok(vagueOpp, 'vague-skill should have mutation opportunities');
      assert.ok(vagueOpp.type === 'rewrite' || vagueOpp.type === 'split', `vague-skill should be rewrite/split, got ${vagueOpp?.type}`);
      console.log('  ✓ vague-skill flagged for rewrite/split');

      // No opportunities for good skill
      const goodOpp = opportunities.find(o => o.id === 'good-skill');
      assert.ok(!goodOpp, 'good-skill should not be flagged');
      console.log('  ✓ good-skill not flagged');
    } finally {
      cleanup(dir);
    }
  }

  // ── Merge detection ───────────────────────────────────────────────────────
  console.log('\nanalyzeMutations (merge):');
  {
    const dir = tmpDir();
    try {
      writeFile(path.join(dir, 'a.md'), '# A');
      writeFile(path.join(dir, 'b.md'), '# B');

      const index = makeIndex({
        skills: [
          makeSkill('skill-a', {
            when: 'reviewing PRs and analyzing code for quality improvements',
            path: path.join(dir, 'a.md'),
            usage_count: 10,
          }),
          makeSkill('skill-b', {
            when: 'analyzing code quality and reviewing pull request changes',
            path: path.join(dir, 'b.md'),
            usage_count: 8,
          }),
        ],
      });

      const opportunities = analyzeMutations(index);
      const mergeOpp = opportunities.find(o => o.type === 'merge');
      assert.ok(mergeOpp, 'should detect merge opportunity for overlapping skills');
      assert.ok(mergeOpp.id.includes('skill-a') && mergeOpp.id.includes('skill-b'), 'merge should reference both skills');
      console.log('  ✓ merge opportunity detected for overlapping triggers');
    } finally {
      cleanup(dir);
    }
  }

  // ── generateProposals ─────────────────────────────────────────────────────
  console.log('\ngenerateProposals:');
  {
    const dir = tmpDir();
    try {
      const gjPath = path.join(dir, 'global.json');
      const blPath = path.join(dir, 'baseline.json');

      writeFile(path.join(dir, 'vague.md'), 'when: general use various stuff\n\n# Vague\n\nNothing here.\n');
      writeFile(path.join(dir, 'a.md'), '# A');
      writeFile(path.join(dir, 'b.md'), '# B');

      const index = makeIndex({
        skills: [
          makeSkill('vague-skill', {
            when: 'general use various stuff',
            path: path.join(dir, 'vague.md'),
          }),
          makeSkill('skill-a', {
            when: 'reviewing PRs and analyzing code quality',
            path: path.join(dir, 'a.md'),
            usage_count: 10,
          }),
          makeSkill('skill-b', {
            when: 'analyzing code quality and reviewing PRs',
            path: path.join(dir, 'b.md'),
            usage_count: 8,
          }),
        ],
      });
      writeFile(gjPath, JSON.stringify(index, null, 2));
      const baseline = runBaseline(gjPath, blPath);
      const opportunities = analyzeMutations(index, baseline);

      const proposals = generateProposals(index, baseline, opportunities);
      assert.ok(proposals.length > 0, 'should generate at least one proposal');
      for (const p of proposals) {
        assert.ok(p.id, 'proposal has id');
        assert.ok(p.type, 'proposal has type');
        assert.ok(p.skillIds?.length > 0, 'proposal has skillIds');
        assert.ok(p.beforeScores, 'proposal has beforeScores');
        assert.ok(p.afterScores, 'proposal has afterScores');
        assert.ok(p.diff, 'proposal has diff');
      }
      console.log(`  ✓ generated ${proposals.length} proposal(s) with valid shape`);
    } finally {
      cleanup(dir);
    }
  }

  // ── paretoFilter ──────────────────────────────────────────────────────────
  console.log('\nparetoFilter:');
  {
    const dir = tmpDir();
    try {
      const gjPath = path.join(dir, 'global.json');
      const blPath = path.join(dir, 'baseline.json');

      writeFile(path.join(dir, 'vague.md'), 'when: vague\n\n# Vague\n');

      const index = makeIndex({
        skills: [
          makeSkill('vague-skill', {
            when: 'vague trigger',
            path: path.join(dir, 'vague.md'),
            priority: 'low',
          }),
        ],
      });
      writeFile(gjPath, JSON.stringify(index, null, 2));
      const baseline = runBaseline(gjPath, blPath);
      const opportunities = analyzeMutations(index, baseline);
      const proposals = generateProposals(index, baseline, opportunities);

      const { kept, discarded } = paretoFilter(proposals, baseline);
      assert.ok(Array.isArray(kept), 'kept is array');
      assert.ok(Array.isArray(discarded), 'discarded is array');
      assert.equal(kept.length + discarded.length, proposals.length, 'kept + discarded = total');

      // Each kept proposal should have scoreDelta
      for (const k of kept) {
        assert.ok(k.scoreDelta, 'kept proposal has scoreDelta');
        assert.ok(k.beforeScore != null, 'kept has beforeScore');
        assert.ok(k.afterScore != null, 'kept has afterScore');
      }
      console.log(`  ✓ kept=${kept.length}, discarded=${discarded.length}`);
    } finally {
      cleanup(dir);
    }
  }

  // ── applyMutation — split ─────────────────────────────────────────────────
  console.log('\napplyMutation (split):');
  {
    const dir = tmpDir();
    try {
      const gjPath = path.join(dir, 'global.json');
      const sourcePath = path.join(dir, 'skills', 'my-skill', 'SKILL.md');
      writeFile(sourcePath, '# My Skill\n\n## Core behavior\n\n1. Run the check\n2. Write the result\n\n```bash\nmeta-skills status\n```\n');

      const index = makeIndex({
        skills: [
          makeSkill('my-skill', {
            when: 'general purpose thing for various tasks',
            path: sourcePath,
          }),
        ],
      });
      writeFile(gjPath, JSON.stringify(index, null, 2));

      const proposal = {
        id: 'split-my-skill-0',
        type: 'split',
        skillIds: ['my-skill'],
        beforeScores: { overall: 30, triggerPrecision: 20, instructionClarity: 25 },
        afterScores: { overall: 55, triggerPrecision: 45, instructionClarity: 40 },
      };

      const mutated = applyMutation(proposal, index);
      assert.ok(mutated, 'mutated index returned');
      assert.ok(mutated.skills.length > index.skills.length, 'split adds new skill');
      const coreSkill = mutated.skills.find(s => s.id === 'my-skill-core');
      assert.ok(coreSkill, 'core sub-skill created');
      assert.ok(coreSkill.version, 'core skill has version');

      // Issue #43 item 1: the new entry points at a real written file
      const expected = path.join(dir, 'skills', 'my-skill-core', 'SKILL.md');
      assert.equal(coreSkill.path, expected, `core path points at written file, got ${coreSkill.path}`);
      assert.ok(fs.existsSync(expected), 'split wrote SKILL.md');
      const written = fs.readFileSync(expected, 'utf-8');
      assert.ok(written.trim().length > 0, 'written content is non-empty');
      assert.ok(!containsPlaceholder(written), 'written content is not placeholder content');
      assert.ok(written.includes('my-skill-core'), 'written content names the new skill');
      assert.ok(written.includes('meta-skills status'), 'written content is derived from the source skill');
      console.log('  ✓ split mutation creates core sub-skill and materializes its SKILL.md');
    } finally {
      cleanup(dir);
    }
  }

  // ── applyMutation — merge ─────────────────────────────────────────────────
  console.log('\napplyMutation (merge):');
  {
    const dir = tmpDir();
    try {
      const pathA = path.join(dir, 'skills', 'skill-a', 'SKILL.md');
      const pathB = path.join(dir, 'skills', 'skill-b', 'SKILL.md');
      writeFile(pathA, '# A\n\nUse A for the review step.\n');
      writeFile(pathB, '# B\n\nUse B for the quality check.\n');

      const index = makeIndex({
        skills: [
          makeSkill('skill-a', { path: pathA, usage_count: 10 }),
          makeSkill('skill-b', { path: pathB, usage_count: 8 }),
        ],
      });
      const gjPath = path.join(dir, 'global.json');
      writeFile(gjPath, JSON.stringify(index, null, 2));

      const proposal = {
        id: 'merge-skill-a+skill-b-0',
        type: 'merge',
        skillIds: ['skill-a', 'skill-b'],
      };

      const mutated = applyMutation(proposal, index);
      assert.ok(mutated, 'mutated index returned');
      const merged = mutated.skills.find(s => s.id === 'skill-a-skill-b');
      assert.ok(merged, 'merged skill created');
      assert.ok(merged.mergedFrom, 'merged skill has mergedFrom');

      // Issue #43 item 1: merged entry points at a real combined file
      const expected = path.join(dir, 'skills', 'skill-a-skill-b', 'SKILL.md');
      assert.equal(merged.path, expected, `merged path points at written file, got ${merged.path}`);
      assert.ok(fs.existsSync(expected), 'merge wrote SKILL.md');
      const written = fs.readFileSync(expected, 'utf-8');
      assert.ok(!containsPlaceholder(written), 'written content is not placeholder content');
      assert.ok(written.includes('## From skill-a'), 'combined content has section for A');
      assert.ok(written.includes('## From skill-b'), 'combined content has section for B');
      assert.ok(written.includes('review step') && written.includes('quality check'), 'combined content uses real source content');

      // originals should be archived
      const origA = mutated.skills.find(s => s.id === 'skill-a');
      assert.ok(origA.priority === 'archived', 'original A archived');
      console.log('  ✓ merge mutation creates combined skill, writes real content, archives originals');
    } finally {
      cleanup(dir);
    }
  }

  // ── applyMutation — rewrite ───────────────────────────────────────────────
  console.log('\napplyMutation (rewrite):');
  {
    const dir = tmpDir();
    try {
      const gjPath = path.join(dir, 'global.json');
      const sourcePath = path.join(dir, 'skills', 'poor-skill', 'SKILL.md');
      writeFile(sourcePath, '# Poor Skill\n\n1. Check the input\n2. Apply the rule\n\n```bash\nmeta-skills score poor-skill\n```\n');

      const index = makeIndex({
        skills: [
          makeSkill('poor-skill', {
            when: 'general use various stuff things',
            path: sourcePath,
            priority: 'low',
          }),
        ],
      });
      writeFile(gjPath, JSON.stringify(index, null, 2));

      const proposal = {
        id: 'rewrite-poor-skill-0',
        type: 'rewrite',
        skillIds: ['poor-skill'],
      };

      const mutated = applyMutation(proposal, index);
      assert.ok(mutated, 'mutated index returned');
      const rewritten = mutated.skills.find(s => s.id === 'poor-skill');
      assert.ok(rewritten.version, 'rewritten skill has version');
      assert.ok(rewritten.rewrittenBy === 'evolution-engine', 'rewrittenBy set');
      // when field should have "ONLY"
      assert.ok(/ONLY/i.test(rewritten.when), 'rewritten when field includes ONLY');

      // Issue #43 item 1 + 6: clean content passes the guard and is written
      const expected = path.join(dir, 'skills', 'poor-skill', 'SKILL.md');
      const written = fs.readFileSync(expected, 'utf-8');
      assert.ok(!containsPlaceholder(written), 'rewrite content passes the placeholder guard');
      assert.ok(written.includes('meta-skills score poor-skill'), 'rewrite content is derived from the source');
      assert.ok(rewritten.path === expected, 'rewrite entry path points at the written file');
      console.log('  ✓ rewrite mutation tightens when field, adds metadata, writes real content');
    } finally {
      cleanup(dir);
    }
  }

  // ── Placeholder guard (issue #43 item 6) ──────────────────────────────────
  console.log('\nplaceholder guard:');
  {
    const dir = tmpDir();
    try {
      const gjPath = path.join(dir, 'global.json');
      const sourcePath = path.join(dir, 'skills', 'stub-skill', 'SKILL.md');
      writeFile(sourcePath, '# Stub Skill\n\nTODO: write the actual steps here.\n');

      const index = makeIndex({
        skills: [makeSkill('stub-skill', { path: sourcePath, priority: 'low' })],
      });
      writeFile(gjPath, JSON.stringify(index, null, 2));

      const proposal = { id: 'rewrite-stub-skill-0', type: 'rewrite', skillIds: ['stub-skill'] };
      const mutated = applyMutation(proposal, index);

      assert.ok(mutated, 'mutated index returned (index-only behavior kept)');
      assert.ok(proposal.needsAuthoring === true, 'needsAuthoring set when guard blocks');
      assert.ok(/placeholder marker/.test(proposal.message || ''), `clear message, got: ${proposal.message}`);
      assert.ok(proposal.materialization.written.length === 0, 'no file written when guard blocks');
      assert.ok(containsPlaceholder(fs.readFileSync(sourcePath, 'utf-8')), 'source content still contains a marker');
      assert.ok(!fs.existsSync(path.join(dir, 'skills', 'stub-skill', 'SKILL.md.tmp')), 'no temp file left behind');
      console.log('  ✓ guard blocks placeholder content and flags needsAuthoring');

      // Pass case: clean content is written
      const cleanPath = path.join(dir, 'skills', 'clean-skill', 'SKILL.md');
      writeFile(cleanPath, '# Clean Skill\n\n1. Verify the trigger matches\n2. Run the documented steps\n\n```bash\nmeta-skills status\n```\n');
      const cleanIndex = makeIndex({ skills: [makeSkill('clean-skill', { path: cleanPath })] });

      const cleanProposal = { id: 'rewrite-clean-skill-0', type: 'rewrite', skillIds: ['clean-skill'] };
      const cleanMutated = applyMutation(cleanProposal, cleanIndex);
      assert.ok(!cleanProposal.needsAuthoring, 'clean content is not flagged');
      assert.ok(cleanProposal.materialization.written.length === 1, 'clean content is written');
      assert.ok(!containsPlaceholder(fs.readFileSync(cleanPath, 'utf-8')), 'written content passes the guard');
      console.log('  ✓ clean content passes the guard and is written');

      assert.ok(containsPlaceholder('Example usage here'), 'marker: Example usage here');
      assert.ok(containsPlaceholder('FIXME something'), 'marker: FIXME');
      assert.ok(containsPlaceholder('an <insert> block'), 'marker: <insert');
      assert.ok(containsPlaceholder('placeholder text'), 'marker: placeholder');
      assert.ok(!containsPlaceholder('# Real skill\n\n1. Do the thing\n'), 'clean content passes');
      assert.deepEqual(findPlaceholderMarkers('TODO and FIXME here'), ['TODO', 'FIXME'], 'markers reported');
      console.log('  ✓ PLACEHOLDER_MARKERS cover block and pass cases');
    } finally {
      cleanup(dir);
    }
  }

  // ── Duplicate proposal IDs (issue #43 item 2) ─────────────────────────────
  console.log('\nduplicate proposal IDs:');
  {
    const dir = tmpDir();
    try {
      const gjPath = path.join(dir, 'global.json');
      const sourcePath = path.join(dir, 'skills', 'dupe-skill', 'SKILL.md');
      writeFile(sourcePath, '# Dupe Skill\n\n1. Step one\n2. Step two\n\n```bash\nmeta-skills status\n```\n');

      const index = makeIndex({ skills: [makeSkill('dupe-skill', { path: sourcePath, priority: 'low' })] });
      writeFile(gjPath, JSON.stringify(index, null, 2));
      const baseline = runBaseline(gjPath, path.join(dir, 'baseline.json'));

      // Two opportunities for the same skill in one run (same type, same target)
      const opportunities = [
        { type: 'rewrite', id: 'dupe-skill', reason: 'low score', confidence: 0.5 },
        { type: 'rewrite', id: 'dupe-skill', reason: 'critical flag', confidence: 0.95 },
      ];

      const proposals = generateProposals(index, baseline, opportunities);
      assert.equal(proposals.length, 2, 'two proposals generated in one run');
      const ids = new Set(proposals.map(p => p.id));
      assert.equal(ids.size, 2, `proposal IDs unique within a batch, got ${[...ids].join(', ')}`);

      // Batch dedupe by (type, target, diff-hash): identical content collapses
      const pp = path.join(dir, 'proposals.jsonl');
      const written = writeProposals(proposals, pp);
      assert.equal(written, 1, `identical proposals deduped in the write batch, wrote ${written}`);
      assert.equal(readProposals(pp).length, 1, 'one proposal stored after dedupe');

      // A genuinely different second proposal for the same skill still writes
      const other = { ...proposals[0], id: `${proposals[0].id}-x`, diff: 'different diff', content: 'different content' };
      const wrote2 = writeProposals([other], pp);
      assert.equal(wrote2, 1, 'distinct proposal still written');
      assert.equal(readProposals(pp).length, 2, 'two proposals stored');
      console.log('  ✓ IDs unique per batch; identical proposals deduped by (type, target, diff-hash)');
    } finally {
      cleanup(dir);
    }
  }

  // ── Unresolvable source path: skip materialization, do not crash ──────────
  console.log('\nunresolvable source path:');
  {
    const dir = tmpDir();
    try {
      const gjPath = path.join(dir, 'global.json');
      const missing = path.join(dir, 'skills', 'ghost-skill', 'SKILL.md');
      const index = makeIndex({ skills: [makeSkill('ghost-skill', { path: missing })] });
      writeFile(gjPath, JSON.stringify(index, null, 2));

      const proposal = { id: 'split-ghost-skill-0', type: 'split', skillIds: ['ghost-skill'] };
      const mutated = applyMutation(proposal, index);
      assert.ok(mutated, 'mutation still applied (index-only)');
      const core = mutated.skills.find(s => s.id === 'ghost-skill-core');
      assert.ok(core, 'core entry created');
      assert.equal(core.path, missing, 'path left at the source entry path');
      assert.ok(proposal.materialization.skipped.length === 1, 'skip noted');
      assert.ok(/not readable/.test(proposal.materialization.skipped[0].reason), 'skip reason noted');
      assert.ok(!fs.existsSync(path.join(dir, 'skills', 'ghost-skill-core')), 'no directory created for unreadable source');
      console.log('  ✓ missing source file is skipped and noted, no crash');
    } finally {
      cleanup(dir);
    }
  }

  // ── Proposal storage (write/read) ─────────────────────────────────────────
  console.log('\nproposal storage:');
  {
    const dir = tmpDir();
    try {
      const pp = path.join(dir, 'proposals.jsonl');
      const proposals = [
        { id: 'p-1', type: 'split', skillIds: ['a'], status: 'pending' },
        { id: 'p-2', type: 'merge', skillIds: ['b', 'c'], status: 'pending' },
      ];
      const fd = fs.openSync(pp, 'w');
      for (const p of proposals) fs.writeSync(fd, JSON.stringify(p) + '\n', 'utf-8');
      fs.closeSync(fd);

      const read = readProposals(pp);
      assert.equal(read.length, 2, 'read back 2 proposals');
      assert.equal(read[0].id, 'p-1');
      assert.equal(read[1].type, 'merge');
      console.log('  ✓ readProposals works');

      const pending = listProposals(pp);
      assert.equal(pending.length, 2, 'list shows 2 pending');
      console.log('  ✓ listProposals shows pending');
    } finally {
      cleanup(dir);
    }
  }

  // ── approveProposal ───────────────────────────────────────────────────────
  console.log('\napproveProposal:');
  {
    const dir = tmpDir();
    try {
      const gjPath = path.join(dir, 'global.json');
      const pp = path.join(dir, 'proposals.jsonl');
      const historyPath = path.join(dir, 'history.jsonl');

      const sourcePath = path.join(dir, 'skills', 'test-skill', 'SKILL.md');
      writeFile(sourcePath, '# Test\n\n1. Verify the trigger\n2. Run the steps\n\n```bash\nmeta-skills status\n```\n');

      const index = makeIndex({
        skills: [
          makeSkill('test-skill', { path: sourcePath }),
        ],
      });
      writeFile(gjPath, JSON.stringify(index, null, 2));

      // Write a proposal
      const proposal = {
        id: 'test-approve-0',
        type: 'rewrite',
        skillIds: ['test-skill'],
        status: 'pending',
        beforeScores: { overall: 30 },
        afterScores: { overall: 55 },
      };
      fs.writeFileSync(pp, JSON.stringify(proposal) + '\n', 'utf-8');

      const result = approveProposal('test-approve-0', gjPath, pp, { historyPath });
      assert.ok(result, 'returned mutated index');

      // Verify proposal marked approved
      const updated = readProposals(pp);
      const approved = updated.find(p => p.id === 'test-approve-0');
      assert.ok(approved.status === 'approved', 'proposal marked approved');
      assert.ok(approved.approvedAt, 'has approvedAt timestamp');

      // Issue #43 item 1: snapshot attempted before writing, file materialized
      assert.ok(fs.existsSync(historyPath), 'snapshot attempted (history file created)');
      assert.ok(approved.materialization?.written?.length === 1, 'approval materialized a SKILL.md file');
      const writtenFile = approved.materialization.written[0];
      assert.ok(fs.existsSync(writtenFile), 'materialized file exists on disk');
      assert.ok(!containsPlaceholder(fs.readFileSync(writtenFile, 'utf-8')), 'materialized content is real, not placeholder');

      const storedIndex = JSON.parse(fs.readFileSync(gjPath, 'utf-8'));
      assert.equal(storedIndex.skills[0].path, writtenFile, 'index entry path points at the written file');
      console.log('  ✓ proposal approved: snapshot + real SKILL.md written, index path updated');
    } finally {
      cleanup(dir);
    }
  }

  // ── rejectProposal ────────────────────────────────────────────────────────
  console.log('\nrejectProposal:');
  {
    const dir = tmpDir();
    try {
      const pp = path.join(dir, 'proposals.jsonl');
      const proposal = { id: 'test-reject-0', type: 'split', skillIds: ['x'], status: 'pending' };
      fs.writeFileSync(pp, JSON.stringify(proposal) + '\n', 'utf-8');

      rejectProposal('test-reject-0', pp);

      const updated = readProposals(pp);
      const rejected = updated.find(p => p.id === 'test-reject-0');
      assert.ok(rejected.status === 'rejected', 'proposal marked rejected');
      assert.ok(rejected.rejectedAt, 'has rejectedAt timestamp');
      console.log('  ✓ proposal rejected');
    } finally {
      cleanup(dir);
    }
  }

  // ── evolve() full pipeline ────────────────────────────────────────────────
  console.log('\nevolve (full pipeline):');
  {
    const dir = tmpDir();
    try {
      const gjPath = path.join(dir, 'global.json');
      const blPath = path.join(dir, 'baseline.json');
      const pp = path.join(dir, 'proposals.jsonl');

      writeFile(path.join(dir, 'vague.md'), 'when: general use various stuff\n\n# Vague\n\nNo examples.\n');

      const index = makeIndex({
        skills: [
          makeSkill('vague-skill', {
            when: 'general use various stuff',
            path: path.join(dir, 'vague.md'),
            priority: 'low',
          }),
          makeSkill('good-skill', {
            when: 'reviewing PRs and analyzing code quality',
            path: path.join(dir, 'good.md'),
            priority: 'high',
            usage_count: 15,
          }),
        ],
      });
      writeFile(path.join(dir, 'good.md'), `---\ndescription: Good skill\n---\n\n# Good\n\n1. Step one\n2. Step two\n`);
      writeFile(gjPath, JSON.stringify(index, null, 2));

      const result = await evolve({
        globalJson: gjPath,
        dryRun: true,
        baselinePath: blPath,
        proposalsPath: pp,
      });

      assert.ok(result.baseline, 'has baseline');
      assert.ok(result.proposals, 'has proposals');
      assert.ok(result.kept, 'has kept');
      assert.ok(result.discarded, 'has discarded');
      console.log(`  ✓ pipeline complete: baseline=${result.baseline.totalScored} skills, proposals=${result.proposals.length}, kept=${result.kept.length}`);
    } finally {
      cleanup(dir);
    }
  }

  // ── evolve() with actual write ────────────────────────────────────────────
  console.log('\nevolve (with write):');
  {
    const dir = tmpDir();
    try {
      const gjPath = path.join(dir, 'global.json');
      const blPath = path.join(dir, 'baseline.json');
      const pp = path.join(dir, 'proposals.jsonl');

      writeFile(path.join(dir, 'vague.md'), 'when: general use various stuff\n\n# Vague\n\nNothing here.\n');

      const index = makeIndex({
        skills: [
          makeSkill('vague-skill', {
            when: 'general use various stuff',
            path: path.join(dir, 'vague.md'),
            priority: 'low',
          }),
        ],
      });
      writeFile(gjPath, JSON.stringify(index, null, 2));

      const result = await evolve({
        globalJson: gjPath,
        dryRun: false,
        baselinePath: blPath,
        proposalsPath: pp,
      });

      assert.ok(fs.existsSync(pp), 'proposals file created');
      const stored = readProposals(pp);
      assert.ok(stored.length > 0, 'at least one proposal stored');
      console.log(`  ✓ wrote ${stored.length} proposal(s) to disk`);
    } finally {
      cleanup(dir);
    }
  }

  // ── Error: unknown proposal ───────────────────────────────────────────────
  console.log('\nerror cases:');
  {
    const dir = tmpDir();
    try {
      const pp = path.join(dir, 'proposals.jsonl');
      assert.throws(() => rejectProposal('nonexistent', pp), /not found/);
      assert.throws(() => approveProposal('nonexistent', '/nope', pp), /not found/);
      console.log('  ✓ errors thrown for unknown proposals');
    } finally {
      cleanup(dir);
    }
  }

  // ── Increment version ─────────────────────────────────────────────────────
  console.log('\nversion increment:');
  {
    // Access via applyMutation side-effect
    const dir = tmpDir();
    try {
      const gjPath = path.join(dir, 'global.json');
      const index = makeIndex({
        skills: [makeSkill('v', { version: '1.2.3' })],
      });
      writeFile(gjPath, JSON.stringify(index, null, 2));

      const proposal = { id: 'rw', type: 'rewrite', skillIds: ['v'] };
      const mutated = applyMutation(proposal, index);
      const skill = mutated.skills.find(s => s.id === 'v');
      assert.equal(skill.version, '1.2.4', `version incremented: ${skill.version}`);
      console.log('  ✓ version increments correctly');
    } finally {
      cleanup(dir);
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n═══ All evolution tests passed ═══');
} catch (e) {
  console.error('\n✗ Test failed:', e.message);
  console.error(e.stack);
  process.exit(1);
}
