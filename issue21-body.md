## Summary

All v1.x roadmap items (v1.1–v1.9) are merged. The next milestone is **v0.1: Autonomous skill evolution** — a full EvoSkill-inspired loop.

This issue proposes a phased breakdown and design for v0.1-v0.2.0.

## Proposed Phases

### v0.1: Autonomous skill evolution
**Full EvoSkill-inspired loop**: the system runs a held-out validation task, measures skill effectiveness, proposes mutations (split/merge/rewrite SKILL.md), and keeps only Pareto-improving variants. Human-in-the-loop approval gate.

**Phase 1: Held-out validation framework**
- Define a validation task set (golden tasks with known-good skill activations)
- Before proposing mutations, run the held-out set through current skills to establish baseline effectiveness
- Store results as baseline metrics

**Phase 2: Skill mutation engine**
- **Split**: detect when a SKILL.md covers multiple unrelated triggers → propose splitting into separate skills
- **Merge**: detect overlapping skills with co-occurrence patterns → propose merging
- **Rewrite**: detect low-scoring skills (via v1.6 quality scoring) → propose rewrites that improve quality scores
- All mutations produce a diff against the current SKILL.md

**Phase 3: Pareto filtering**
- Only keep variants that improve effectiveness on held-out validation
- Discard variants that regress or provide no improvement
- Track mutation lineage for auditability

**Phase 4: Human-in-the-loop approval**
- Proposed mutations surface in the dashboard (v1.4+) as pending reviews
- CLI: meta-skills evolve --propose generates mutations, meta-skills evolve --review shows pending
- Human approves/rejects; approved mutations are applied to the skill index

### v0.1.1: Semantic versioning for skills
Add `version` and `engines` frontmatter fields to SKILL.md files for individual skill version tracking. `meta-skills validate` checks semantic versions against runtime CLI engine compatibility.

### v0.1.2: Git-style rollback ledger
Maintain `~/.meta-skills/history.jsonl` transaction log tracking prior states of global.json before mutations. `meta-skills rollback --steps <n>` restores index to previous known-good state. Safety net for autonomous evolution.

### v0.1.3: Declarative skill dependency graphs
Add `requires` array to skill metadata schema. When activating a skill, the system auto-loads required sub-skills. Static cycle detection via DFS in `meta-skills recipe validate`.

### v0.1.4: Fine-grained empirical token telemetry
Replace heuristic token estimates (chars/4) with empirical usage tracking. `meta-skills record <skill> --tokens <n>` captures exact tokens consumed during session. Iteratively tunes value-density formula with real-world data.

### v0.1.5: Capabilities & permissions manifest
Declarative `permissions` block in skill frontmatter cataloging authorized access (`fs-read`, `fs-write`, `network`, `shell-exec`). Agent config files instruct agents to decline execution if actions exceed declared permissions.

### v0.1.6: Live skill hot-reloading
Background file watcher (`fs.watch`) detects changes to registered SKILL.md files during active sessions, automatically hot-reloading in-memory agent index. Zero manual re-indexing required.

### v0.1.7: Deprecation & successor routing
Introduce `deprecated: true, successor: "<skill-id>"` status mapping. When agent loads deprecated path, runtime logs warning and redirects to successor skill. Graceful lifecycle management.

### v0.1.8: Offline reputation metrics for marketplace
Ship weekly static index of marketplace metadata mapping skills to reputation scores (GitHub stars, forks, community success rates). Filters untrusted community skills without runtime API calls.

### v0.1.9: Skill A/B testing in live workspaces
`meta-skills pilot` maintains two skill instruction variants. Index alternates variants over 50-100 runs, compares empirical success/failure rates. Dynamically updates priority ratings based on outcomes.

### v0.2.0: Self-healing skill instructions
When skill fails and triggers v1.3 auto-improvement patch, automatically package failed conversation prompt as micro-test-case. Mutated skill runs against specific test case + wider baseline suite to guarantee zero-regression. Dynamic test cases saved to `.meta-skills/tests/` for evolutionary engine.

## Inspiration
- EvoSkill (arXiv 2603.02766): 7.3% OfficeQA gain, 12.1% SealQA gain via co-evolutionary verification
- Cognee self-improving skills
- v1.6 quality scoring (existing heuristic scores can guide rewrite targets)
- v1.7 token budget optimizer (mutation candidates must fit within budget)
- NotebookLM deep research: 21 improvement ideas brainstormed (2026-08-07)

## Scope Discussion
- Should we start with a design doc PR, or jump straight to Phase 1 implementation?
- Are there constraints on external dependencies? (current pattern: zero new npm deps)
- How should the held-out validation task set be defined — curated by us, or extracted from real usage patterns?
