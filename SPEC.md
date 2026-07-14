# v1.7 — Token Budget Optimizer

## Problem

As skill counts grow, the meta-skills index itself bloats. Anthropic's 150-token target is for the *full* index read, but the **active set** (high + medium priority) often exceeds 500 tokens and starts crowding the agent's context window. v1.6 quality scoring helps decide *which skills to improve*; v1.7 helps decide *which to keep at all* when budget is tight.

Past ~10 tools/skills, agents start losing accuracy (progressive disclosure research, Anthropic best practices). v1.7 is the budget lever.

## Solution

`src/budget-optimizer.mjs` + `meta-skills budget` CLI: estimate per-skill token cost, compute a **value density** (priority × usage × quality ÷ tokens), and greedily demote or archive the lowest-density skills until the active set fits under a configurable cap.

## Acceptance Criteria

### AC1 — Token Estimation (heuristic, deterministic)

For a skill entry `{id, when, why, path, priority}`, the index entry's token cost is computed as:

```text
estimateIndexTokens(entry) = ceil((id.length + when.length + why.length + path.length + priority.length + 8_separators) / 4)
```

- `+8` accounts for JSON syntax: `{"id":"","when":"","why":"","path":"","priority":""}` (8 quote pairs + 4 colons + 1 comma)
- `chars/4` is the standard OpenAI token-per-character heuristic for English
- Round up so any non-empty string costs ≥1 token

If `includeSkillMd: true` is passed and `path` points to a readable file, the file is read and its `length/4` is added. Default is **index-only** (matches what the agent actually loads every turn).

### AC2 — Value Density

Each non-archived skill has a `value_density`:

```text
value_density = (priority_weight × (1 + ln(1 + usage_count)) × quality_multiplier) / estimated_tokens
```

Where:

- `priority_weight`: `high=3.0`, `medium=2.0`, `low=1.0`, missing=1.0
- `usage_count`: from entry, default 0
- `quality_multiplier`: default `1.0`. If `useQuality: true` and a quality score exists, `score/100` (clamped to `[0.1, 1.5]` to prevent zeroing out a skill or doubling its value)
- `estimated_tokens`: result of `estimateIndexTokens` (or full `+ skillMd` if `includeSkillMd`)

### AC3 — Greedy Optimizer

Given `max_tokens` cap and a list of skills, produce a list of `Suggestion` actions:

```text
total = sum(estimateIndexTokens(s) for s in active)
while total > max_tokens:
  find candidate = skill with lowest value_density that is not "high" priority
  if no candidate: break (cap unattainable, all remaining are "high")
  suggest demote (priority → low) or archive
  total -= tokens(candidate)
  remove from active
```

Output: `[{ id, action, currentPriority, newPriority, currentTokens, valueDensity, reason }]` sorted by `valueDensity` ascending.

**Defaults:**

- `--action demote` (priority → low): keeps skill in index, lowers agent's match weight
- `--action archive` (move to `archived_skills` list): removes from index entirely but recoverable

### AC4 — CLI

```text
meta-skills budget [--max-tokens 500] [--dry-run] [--json] [--archive]
                   [--use-quality] [--include-skill-md] [--global-json <path>]
```

- `--max-tokens` (default 500): the cap. If omitted and `meta-skills.json:budget.maxTokens` is set, that wins.
- `--dry-run` (default true): show plan, do not write. Must pass an explicit `--write` (or `--archive` as the apply action) to mutate.
- `--json`: emit JSON instead of a table
- `--archive`: apply action is archive (not demote)
- `--use-quality`: pull quality scores from `src/quality-scorer.mjs` and apply multiplier
- `--include-skill-md`: estimate full cost (index + file contents), not just index
- Exit code: 0 if under budget or apply succeeded, 1 if over budget unfixable (all remaining are "high")

**Table output (default):**

```
skill              priority  tokens  density  action   reason
old-skill-1        low       12      0.42     archive  used 0x in 90d, lowest density
unused-skill-2     low       8       0.51     demote   used 1x in 30d, below 0.6 density threshold
...
Current: 612 tokens / 500 cap  (suggested: 487 tokens, -125)
```

### AC5 — Apply Path

When `apply` is invoked (via `--archive` or `--write`), mutate `global.json`:

- For `demote`: set `priority = "low"` in place
- For `archive`: move entry to new top-level `archived_skills: []` array (preserves path, when, why, usage_count for restoration)
- Bump `generated` timestamp
- Atomic write: read full JSON → mutate → write to `global.json.tmp` → rename
- Write fails if `global.json` doesn't exist; reports clear error

### AC6 — Quality Integration

If `--use-quality` is passed, calls `scoreAll(globalJsonPath)` from v1.6, builds a `skillId → overall score` map, and applies the multiplier per AC2. Skills not scored (file missing, parse error) get multiplier `1.0`.

### AC7 — Dashboard Extension

New endpoint `GET /api/budget?max=500`:

```json
{
  "max": 500,
  "current": 612,
  "over": 112,
  "utilization": 1.22,
  "suggestions": [
    { "id": "old-skill-1", "action": "archive", "tokens": 12, "density": 0.42, "reason": "..." }
  ],
  "skillMdIncluded": false,
  "qualityWeighted": false
}
```

Dashboard HTML gets a new panel `#budget` between `#priority` and `#bundles`, auto-refreshed every 30s like the others.

### AC8 — Test Coverage

20+ unit tests in `src/budget-optimizer.test.mjs` (Node built-in test runner, matching v1.6 style):

- Token estimator: 5 tests (empty, minimal, full entry, with skillMd, edge cases)
- Value density: 4 tests (high/medium/low priority, no usage, with quality, quality clamp)
- Greedy optimizer: 6 tests (under budget, over budget, ties, all-high-no-solution, demote vs archive action, sort order)
- Apply: 3 tests (demote mutates, archive moves to list, atomic write)
- CLI integration: 2 tests (--json output, --dry-run default)
- Edge cases: 3 tests (empty skills, missing path, corrupt global.json)

Plus a manual end-to-end smoke test against `examples/global.json`.

### AC9 — SKILL.md Phase 10 + README v1.7

- Add `## Phase 10: Token Budget Optimizer (v1.7)` section to `SKILL.md` with command spec, design rationale, JSON API endpoint
- Add `meta-skills budget` to the "Daily Use" command table in `README.md`
- Add the v1.7 entry to the Roadmap checklist (uncheck until shipped)
- Bump `package.json` version to `1.7.0`
- Bump `SKILL.md` frontmatter version to `1.7.0`

## Non-Goals

- No LLM-based token estimation (chars/4 is the heuristic)
- No new dependencies (zero-dep matches meta-skills convention)
- No per-agent budget overrides (single global cap for now)
- No automatic apply via cron (must be explicit; opt-in)

## Inspired By

- Progressive disclosure research (10-tool accuracy ceiling)
- Anthropic 150-token meta-skills target
- EvoSkill value-density evaluation
- v1.6 quality scoring (`scoreAll` integration)
- v0.4 self-improve demotion logic

## Out of Scope for v1.7

These are roadmap items, NOT v1.7:

- v1.8 Skill bundles & recipes
- v1.9 Semantic search & fuzzy matching
- v2.0 Autonomous skill evolution
