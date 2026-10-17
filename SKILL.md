---
name: meta-skills
description: A lightweight, self-improving JSON index that lets agents discover all available skills in ~150 tokens. Scans global agent configs (Claude Code, Cursor, OpenClaw, Hermes) and project files to generate a fast-reference skill catalog with usage tracking, auto-promotion, background maintenance, failure-based patch proposals, a local web dashboard, agent config injection, skill quality scoring, and a token budget optimizer.
metadata:
  author: community
  version: "1.9.0"
  schema: https://meta-skills.dev/schema/v1.json
---

# Meta-Skills: Agent Skill Index

## Intent

Meta-Skills solves the **skill discovery problem**: agents accumulate dozens of skills but have no lightweight way to know what's available without loading every `SKILL.md` upfront. This wastes tokens and causes agents to miss relevant capabilities.

The meta-skills pattern creates a **JSON index** - a table of contents for all skills - that agents read in ~150 tokens. Each entry answers two questions: *"When should I use this?"* and *"Why does it exist?"* The full `SKILL.md` is loaded **only on demand** when the agent decides to activate a skill.

## Architecture

### Two Levels

| Level | Scope | File | Generated From |
|-------|-------|------|----------------|
| **Global** | Agent-wide | `~/.meta-skills/global.json` | `~/.claude/skills/`, `~/.cursor/skills/`, OpenClaw skills dir, Hermes skills dir |
| **Local** | Per-project | `<project>/.meta-skills/project.json` | `README.md`, `CLAUDE.md`, `.cursorrules`, `package.json`, `pyproject.toml`, etc. |

### JSON Schema (v1)

```json
{
  "$schema": "https://meta-skills.dev/schema/v1.json",
  "version": "1.0",
  "generated": "<ISO-8601 timestamp>",
  "source": "global | project",
  "skills": [
    {
      "id": "skill-name",
      "when": "short trigger description - when to activate this skill",
      "why": "one-line rationale - what value this skill provides",
      "path": "relative or absolute path to SKILL.md",
      "priority": "high | medium | low",
      "usage_count": 0,
      "last_used": null
    }
  ],
  "project_context": {
    "tech_stack": ["python", "fastapi"],
    "key_files": ["README.md"],
    "patterns": ["clean architecture"]
  }
}
```

Each entry is **minimal by design** - name + when + why + path. The agent uses `when` to decide relevance, loads the full skill only when matched.

## Implementation Plan

### Phase 1: Scanner (v0.1-v0.2)

**Global Scanner** - detect skills from all agent config directories:

1. Scan `~/.claude/skills/*/SKILL.md` - extract frontmatter `name` + `description`
2. Scan `~/.cursor/skills/*/SKILL.md` - same extraction
3. Scan OpenClaw skill directories (configurable path)
4. Scan Hermes skill directories
5. Merge into `global.json` - deduplicate by `name`, flag conflicts

**Project Scanner** - extract local context:

1. Read `README.md` - detect tech stack, project purpose
2. Read `CLAUDE.md` / `.cursorrules` - extract existing skill references
3. Scan `package.json`, `pyproject.toml`, `Cargo.toml`, `Gemfile` - detect languages/frameworks
4. Scan `.meta-skills/` directory for existing local skills
5. Generate `project.json` with context + any project-specific skills

### Phase 2: Usage Tracking (v0.3)

**Recording mechanism:**

1. Agent records skill activation → appends to a usage log:
   ```json
   { "skill": "git-commits", "timestamp": "2026-06-24T09:00:00+10:00", "outcome": "success" }
   ```
2. Background process aggregates logs → updates `usage_count` + `last_used` in meta-skills JSON
3. Usage log rotates (keep last 90 days)

### Phase 3: Self-Improvement Loop (v0.4)

**Promotion/Demotion rules:**

| Condition | Action |
|-----------|--------|
| `usage_count > 20` in 30 days | `priority` → `high` |
| `usage_count < 3` in 30 days | `priority` → `low` |
| `last_used` > 60 days ago | Flag for review, move to `stale` |
| `last_used` > 90 days ago | Remove from index (keep in archive) |
| New skill detected | `priority` → `medium`, add to index |

**Project pattern learning:**

- Track which skills are used together → suggest skill bundles
- Detect tech stack changes → update `project_context`
- Identify frequently loaded skills → pre-warm them in context

### Phase 4: Background Maintenance (v0.5)

**Cron-based maintenance (runs daily):**

1. Re-scan all skill directories for additions/removals
2. Process usage logs → update statistics
3. Apply promotion/demotion rules
4. Prune stale entries (archive, don't delete)
5. Re-generate project context from key files
6. Git-commit changes if meta-skills dir is version-controlled

### Phase 5: Agent Setup Injection (v0.6)

**Auto-inject reference comments into agent configs:**

- `CLAUDE.md` → append or update a `## Skills` section
- `.cursorrules` → add `alwaysRead` entries
- OpenClaw `AGENTS.md` → add meta-skills scan instruction
- Hermes agent config → add reference

**Reference comment template:**

```markdown
## Meta-Skills

This agent uses meta-skills for fast skill discovery.
Always read these files at startup:
- `~/.meta-skills/global.json` - all globally available skills
- `.meta-skills/project.json` - project-specific skills and context

Each entry tells you WHEN and WHY to use a skill.
Load the full SKILL.md only when you decide to activate it.
```

## Key Design Decisions

1. **JSON over YAML/Markdown** - parsable by any agent, machine-writable, schema-validatable, diff-friendly
2. **~150 tokens for 20 skills** - each entry is ~7 tokens (id + when + why + path + priority)
3. **Usage-driven promotion** - skills prove their value through actual use, not static configuration
4. **Stale detection, not deletion** - archive unused skills instead of removing them (agents change, projects evolve)
5. **Two-level hierarchy** - global skills are always available; project skills provide local context
6. **Self-contained** - no external dependencies, no runtime, just a JSON file + a simple scanner script

## Edge Cases

| Situation | Handling |
|-----------|----------|
| Duplicate skill names across agents | Prefer the one with higher `usage_count`, flag conflict in metadata |
| Skill directory deleted | Remove from index on next scan, archive entry |
| Project has no meta-skills dir | Create on `init`, skip if user declines |
| Agent doesn't support file reading | Fall back to embedding meta-skills in system prompt |
| 100+ skills | Use `priority` field for tiered loading (high always shown, medium/low on demand) |
| Conflicting `when` descriptions | Use LLM to merge descriptions on scan |

## Future Ideas

- **Skill bundles** - groups of skills that work well together (e.g., "web-dev" = react-skill + css-skill + api-testing-skill)
- **Cross-agent sync** - share usage patterns across Claude Code, Cursor, and OpenClaw agents
- **Skill recommendations** - "You often use `git-commits` with `code-review` - would you like to bundle them?"
- **Meta-skills dashboard** - web UI showing skill usage, stale skills, discovery stats
- **Plugin for IDEs** - show available skills in-editor without leaving the codebase

## Phase 6: Failure-Based Auto-Improvement (v1.3)

**The problem:** Skills fail silently. A skill activated in the wrong context produces an `outcome: failure` log entry, but nothing closes the loop. Agents repeat the same mistakes across sessions.

**The fix:** When failures accumulate, generate a proposed patch to the skill's `SKILL.md` and surface it for human review. Inspired by EvoSkill's Pareto-optimized failure-analysis loop (7.3% accuracy gain) and BerriAI/self-improving-agent.

### Failure Analysis Pipeline

1. **Scan logs** - `~/.meta-skills/logs/*.jsonl`, filter `outcome=failure`, group by `skill_id`
2. **Pattern detection** - classify failures:
   - **Vague trigger** → tighten `when:` field (e.g., "Use when task involves X" instead of "general")
   - **Short content** → add `## Anti-Patterns` section with common mistake patterns
   - **Heterogeneous failures (≥5)** → suggest splitting into sub-skills (`{name}-core`, `{name}-advanced`)
   - **Generic** → append `## Improvement Notes` with review checklist
3. **Proposal file** - write `~/.meta-skills/proposals/<skill-id>-<timestamp>.patch` containing:
   - `meta`: skill id, generation timestamp, patch type, summary, version
   - `diff`: unified diff against the current `SKILL.md`

### CLI

```bash
# Run analysis on last 7 days of failures
meta-skills propose [--since 7] [--dry-run]

# List, view, reject, or auto-PR proposals
meta-skills propose list
meta-skills propose apply <id>       # show diff + suggested action
meta-skills propose reject <id>      # delete proposal
meta-skills propose auto-pr <id>     # file a PR via gh CLI

# Roll into the existing cron maintenance run
meta-skills maintain --from-failures [--dry-run]
```

### Human-in-the-Loop Design

Auto-PR opens the proposal as a PR for review - agents do not auto-merge. This preserves the core meta-skills principle: **agents propose, humans decide**.

### Use Cases

- **Skill authoring**: a skill gets 3+ failures in a week → tighten its trigger before next deploy
- **Cross-session learning**: persistent log of which skills fail when
- **Cumulative improvement**: each successful proposal raises aggregate skill quality

## Phase 7: Local Web Dashboard (v1.4)

**The problem:** The meta-skills index is a JSON file optimized for ~150-token agent reads, but humans have no way to *see* the index. There is no visualization of which skills are hot, which are stale, or which cluster together.

**The fix:** A read-only local web dashboard that boots a Node http server bound to `127.0.0.1` (loopback only) and serves a single-page HTML+CSS+vanilla-JS app with five panels:

1. **Summary** - total skills, stale count, total activations, suggested bundles
2. **Usage Heatmap** - skills x days matrix for the last N days (default 7), color-coded by activation count
3. **Stale Skills** - skills not used in 30+ days (configurable via `?days=`)
4. **Priority Distribution** - counts of high/medium/low/unset priorities with a proportional bar
5. **Co-occurrence** - skill pairs that activated within a 5-minute window (configurable via `?window=`) over the last 30 days
6. **Suggested Bundles** - list view of `suggested_bundles` from `global.json`

### Design constraints

- **Zero new dependencies** - uses only Node.js stdlib (`node:http`, `node:fs`, `node:path`, `node:os`)
- **Read-only** - the dashboard never writes to `global.json`, only reads
- **Local-only binding** - refuses to bind to non-loopback addresses (security: dashboard data is private)
- **Auto-shutdown on SIGINT/SIGTERM** - `ctrl-c` cleanly closes the server
- **Auto-refresh every 30s** - clients poll `/api/*` JSON endpoints

### CLI

```bash
# Start dashboard on default port 7777
meta-skills dashboard

# Custom port
meta-skills dashboard --port 8888

# Custom global.json / log-dir (matches the other commands)
meta-skills dashboard --global-json /path/to/global.json --log-dir /path/to/logs
```

### JSON API

| Endpoint | Description |
|----------|-------------|
| `GET /` | HTML page |
| `GET /api/health` | `{ ok, version, generated }` |
| `GET /api/index` | full meta-skills index |
| `GET /api/logs?since=7` | log events from last N days |
| `GET /api/stale?days=30` | skills unused for N+ days |
| `GET /api/priority` | priority distribution counts |
| `GET /api/cooccurrence?since=30&window=5` | skill pairs within N-min window |
| `GET /api/heatmap?days=7` | skills x days matrix |
| `GET /api/bundles` | suggested bundles |

### Use Cases

- **Skill curation** - see which skills are dead weight and candidates for archival
- **Pattern discovery** - co-occurrence reveals which skills work well together (bundling candidates)
- **Activity monitoring** - heatmap shows daily engagement without leaving the terminal
- **Onboarding** - new users can `meta-skills dashboard` and see their full skill landscape in 30 seconds

## Phase 8: Agent Config Injection (v1.5)

Detect and inject meta-skills scan instructions into agent configuration files:
`CLAUDE.md`, `.cursorrules`, `AGENTS.md`, and Gemini CLI config (`config.yaml` / `config.json`).

### Detection

- Scans the target directory (default: `process.cwd()`) for 5 canonical config file specs
- Project-level: `CLAUDE.md`, `.cursorrules`, `AGENTS.md`
- Global-only: `~/.config/gemini-cli/config.yaml`, `~/.config/gemini-cli/config.json`
- Parses each file for existing `<!-- meta-skills:start --> ... <!-- meta-skills:end -->` blocks (markdown)
  or `# meta-skills:start ... # meta-skills:end` blocks (text/YAML) or `_meta_skills` key (JSON)
- Reports `has block`, `no block`, or `error` per file

### Write-back

- **Created** - file doesn't exist → creates it with the block
- **Updated** - block exists → replaces in-place, preserving surrounding content
- **Appended** - file exists without block → appends at end
- **Skipped** - parse error (e.g. unterminated block) → refuses to overwrite unless `--force`
- **Removed** - `meta-skills agent-config remove` strips the block
- All operations support `--dry-run` for preview

## Phase 9: Skill Quality Scoring (v1.6)

Heuristic scoring of SKILL.md files across 4 dimensions - no external API calls.

## Phase 10: Token Budget Optimizer (v1.7)

Greedy demote/archive of lowest value-density skills to fit a configurable
token cap. The active set is the high+medium priority skills the agent
loads every turn; if it bloats past the cap, this command picks the
lowest-priority victims to demote or archive.

### Value density

`density = (priority_weight × (1 + ln(1 + usage_count)) × quality_multiplier) / estimated_tokens`

- `priority_weight`: high=3.0, medium=2.0, low=1.0
- `usage_count` uses log-curve: 0→1, 10→3.4, 100→5.6 (diminishing returns)
- `quality_multiplier`: 1.0 default; if `--use-quality` is set, scales by
  v1.6 overall score / 100, clamped to [0.1, 1.5] (Anthropic: don't zero
  out a skill, the agent still has the option to load it manually)
- `estimated_tokens`: chars/4 of the JSON-serialized index entry
  (id, when, why, path, priority). Strips usage_count + last_used as
  internal telemetry. Optionally adds SKILL.md file content cost
  (`--include-skill-md`).

### CLI

```bash
# Show suggestions (default --dry-run, default cap 500)
meta-skills budget

# Custom cap
meta-skills budget --max-tokens 200

# Apply demotions (priority → low). --write is required for non-dry-run.
meta-skills budget --max-tokens 200 --write

# Or apply ARCHIVE (move to archived_skills list, recoverable)
meta-skills budget --max-tokens 200 --archive

# JSON output for scripting
meta-skills budget --max-tokens 200 --json

# Weight by v1.6 quality scores (high-quality skills protected)
meta-skills budget --use-quality

# Include full SKILL.md file cost in token estimate
meta-skills budget --include-skill-md
```

### JSON output

```json
{
  "max": 200,
  "current": 612,
  "projected": 187,
  "over": 412,
  "utilization": 3.06,
  "unfixable": false,
  "action": "demote",
  "dryRun": true,
  "skillMdIncluded": false,
  "qualityWeighted": false,
  "suggestions": [
    {
      "id": "old-skill",
      "action": "demote",
      "currentPriority": "low",
      "newPriority": "low",
      "currentTokens": 12,
      "valueDensity": 0.04,
      "reason": "demote: priority=low, used 0x, density=0.04 is lowest"
    }
  ]
}
```

### Design

- **Heuristic token estimation** - chars/4 (OpenAI standard). No
  tokenizer dep, deterministic, fast.
- **Greedy sort** - O(n log n). Same input always produces same output
  (no LLM in the loop, no randomness).
- **High-priority protected** - even at 0 usage, a high-priority skill
  is never a demote candidate. The agent's intent is preserved.
- **Apply is opt-in** - `--dry-run` is the default. You must pass
  `--write` (for demote) or `--archive` (for archive) to mutate
  global.json. Atomic write via temp+rename.
- **Archived skills are recoverable** - moves to top-level
  `archived_skills: []` array with `priority: "archived"`. Use
  `meta-skills maintain` to inspect/restore.
- **Read-only dashboard endpoint** - `/api/budget` returns the same
  shape as `--json`; the dashboard panel renders it without writing
  anything back.

### Dashboard

`GET /api/budget?max=500` returns the JSON above. The dashboard HTML
adds a "Token Budget (v1.7)" panel showing current vs cap, top-3
over-budget candidates, and a `meta-skills budget --write` reminder.

### Inspired by

- Progressive disclosure research (10-tool accuracy ceiling)
- Anthropic 150-token meta-skills target
- EvoSkill value-density evaluation
- v1.6 quality scoring (`--use-quality` integration)
- v0.4 self-improve demotion rules

## Phase 11: Skill Bundles & Recipes (v1.8)

**The problem:** Meta-skills has `suggested_bundles` (auto-detected from
co-occurrence, written by v0.4 self-improve) but no way to create
user-defined bundles, activate bundles as a unit, or chain skills into
multi-step recipes.

**The fix:** Two first-class concepts.

### Bundles

A **bundle** is a named group of skill IDs that work well together.

Two flavors coexist (kept separate so user bundles survive auto-resets):

| Flavor | Location | Source | Mutable? |
|--------|----------|--------|----------|
| User bundle | `index.bundles[]` | `meta-skills bundle create` | yes (CRUD) |
| Auto bundle | `index.suggested_bundles[]` | `meta-skills improve` (co-occurrence) | no (read-only) |

Schema (user bundle):

```json
{
  "name": "web-dev",
  "description": "frontend stack",
  "skills": ["react-skill", "css-skill", "api-testing-skill"],
  "tags": ["frontend", "spa"],
  "createdAt": "2026-07-15T10:00:00.000Z",
  "updatedAt": "2026-07-15T10:00:00.000Z"
}
```

Name must match `^[a-z0-9][a-z0-9-]{0,63}$` (slug-shaped).

### CLI

```bash
# Create a user bundle
meta-skills bundle create web-dev \
  --skill react-skill \
  --skill css-skill \
  --desc "frontend stack" \
  --tag frontend

# List (text or JSON)
meta-skills bundle list
meta-skills bundle list --include user --json
meta-skills bundle list --tag frontend

# Show with metrics (tokens + avg quality from v1.6)
meta-skills bundle show web-dev

# Delete a user bundle (auto bundles are immutable)
meta-skills bundle delete web-dev

# Activate: write activation records for all skills (dry-run by default)
meta-skills bundle activate web-dev
meta-skills bundle activate web-dev --write
meta-skills bundle activate web-dev --json

# Suggest: re-run co-occurrence detection
meta-skills bundle suggest --min-days 3
```

### Recipes

A **recipe** is a multi-step workflow that chains skill activations.
Two file formats (auto-detected by extension):

**`.recipe`** — simple YAML-style (zero new deps):

```yaml
# name: release-flow
# description: cut a release from validated code

step validate: run tests, lint, type-check
step changelog: generate changelog
step commit: commit with conventional message
```

**`.json`** — native JSON for tooling:

```json
{
  "name": "release-flow",
  "description": "cut a release from validated code",
  "steps": [
    { "skill": "validate", "description": "run tests", "on_failure": "stop" },
    { "skill": "changelog", "on_failure": "continue" },
    { "skill": "commit", "on_failure": "stop" }
  ]
}
```

Each step writes a usage log entry `{skill, timestamp, outcome, source:
'recipe', recipe: <name>, step: <n>}` to the standard logs directory.

### CLI

```bash
# Scaffold a starter recipe
meta-skills recipe init release-flow

# Validate (checks skill IDs exist in index)
meta-skills recipe validate release-flow.recipe

# Run (dry-run by default)
meta-skills recipe run release-flow.recipe
meta-skills recipe run release-flow.recipe --write
meta-skills recipe run release-flow.json --continue-on-failure
```

### Dashboard integration

- `/api/bundles?include=user|auto|all` — list with source filter
- `/api/bundles/:name` — detail with metrics (tokens + avg quality)
- `/api/recipes` — list recipes from `~/.meta-skills/recipes/`
- Bundle panel visually distinguishes user bundles (`*`) from auto (`~`)

### Cross-module integration

- **Quality** (v1.6): `bundle show` includes avg quality from skill.quality_score
- **Budget** (v1.7): `bundle show` includes total tokens via estimateIndexTokens
- **Self-improve** (v0.4): only touches `index.suggested_bundles`; user
  bundles in `index.bundles` are preserved untouched

### Inspired by

- EvoSkill skill composition — Pareto-optimized skill combinations
- Make / Taskfile / npm scripts — multi-step workflow patterns
- LangChain prompt-template chains — multi-step AI workflows
- v0.4 co-occurrence — "when I do X I usually also do Y"
- v1.6 quality + v1.7 budget — bundles inherit and aggregate per-skill signals

### Constraints

- Zero new npm deps (matches v1.5/v1.6/v1.7)
- Pure regex YAML parser — no `yaml` package
- Atomic write-back (temp + rename) for all index mutations
- User bundles persist separately from auto-bundles (no clobber)
- Bundle activate is idempotent — running twice produces two distinct
  timestamped entries per skill

## References

### Scoring Dimensions

| Dimension | Weight | What It Checks |
|-----------|--------|----------------|
| **Readability** | 25% | Frontmatter, description, section structure, length (50-500 lines), code examples, links |
| **Trigger Precision** | 30% | `when` field exists, length > 20 chars, trigger words present, no generic words, > 2 meaningful words |
| **Instruction Clarity** | 25% | Numbered steps, code blocks, examples, anti-patterns/cautions, output descriptions, references |
| **Token Efficiency** | 20% | Meaningful line ratio, no commented-out code, no ASCII art, avg line length < 100, no duplicate sections |

Each dimension scores 0-100. Overall = weighted average (0-100).

### Flags

Skills below 40 in any dimension get flagged:
- `low-readability` - frontmatter missing or file too short/long
- `vague-trigger` - `when` field missing, too short, or uses generic words
- `unclear-instructions` - no numbered steps, no code blocks, no examples
- `inefficient` - commented code, ASCII art, poor line ratio
- `critical` - overall score < 30

### CLI

```bash
# Score all skills in global.json
meta-skills quality

# Only show skills below threshold
meta-skills quality --threshold 50

# JSON output
meta-skills quality --json

# Custom global.json path
meta-skills quality --global-json /path/to/global.json

# Detect which config files exist and whether they have a meta-skills block
meta-skills agent-config

# Inject/update blocks in all detected configs
meta-skills agent-config inject

# Preview injection without writing
meta-skills agent-config inject --dry-run

# Force overwrite even on parse errors
meta-skills agent-config inject --force

# Remove blocks
meta-skills agent-config remove
```

### Design

- **Zero external API calls** - pure heuristic analysis of local files
- **No new dependencies** - uses only Node.js stdlib
- **21 tests** covering all 4 dimensions + scoreSkill + scoreAll + edge cases
- **Inspired by:** Anthropic skill authoring best practices (concise, degrees of freedom, 500-line rule, trigger precision)

- **Read-only detection** - `parseForBlock()` never writes; returns `{ exists, hasBlock, blockRange, blockText, content, error }`
- **Atomic write** - `writeBlock()` reads, splices, writes; never partial
- **Single source of truth** - `blockContent()` returns the canonical instruction string; used by both detection and write-back
- **Zero new dependencies** - uses only Node.js stdlib (`node:fs`, `node:os`, `node:path`)
- **30 tests** - 17 detection + 13 write-back (create, update, append, remove, dry-run, force, injectAll)

## Phase 12: Semantic Versioning for Skills (v0.1.1)

Adds per-skill semantic versioning and runtime engine compatibility checking.

### What's new

- **Schema**: `SkillEntry` gains optional `version` (semver `\d+.\d+.\d+`) and `engines` (with `node` constraint) fields
- **Scanner**: `parseFrontmatter` now extracts nested `metadata.version` and `metadata.engines` from SKILL.md frontmatter
- **Validator**: `meta-skills validate --check-engines` warns when skill `engines.node` is incompatible with current `process.version`
- **Semver ranges**: supports `>=`, `^`, `~`, `*` (any)

### CLI

```bash
# Validate with engine check
meta-skills validate ~/.meta-skills/global.json --check-engines

# Engine warning example (on Node < 18)
⚠ git-commits: requires node >=18.0.0, current is v16.20.2
```

### SKILL.md frontmatter

```yaml
---
name: my-skill
description: Does something useful
metadata:
  author: me
  version: "1.2.3"
  engines:
    node: ">=18.0.0"
---
```

### Design

- **Backward compatible** — `version` and `engines` are optional; existing skills work unchanged
- **Non-fatal warnings** — `--check-engines` exits 0 unless schema errors exist
- **Zero new npm deps** — pure Node.js stdlib (`semverGte`, `checkEngineRange`)
- **21 validate tests, 22 scanner tests** (was 10/20)

### Inspired by

- Semantic versioning 2.0.0 spec (semver.org)
- Node.js engine constraints in package.json
- EvoSkill version tagging for mutation lineage tracking (future v0.1.2 dependency)

## Phase 13: Validation Harness (issue #35)

Held-out task suites that gate skill changes under a **strict acceptance rule**.
Where v0.2.0 `selfheal` is a Pareto non-regression gate (equal scores pass), the
harness refuses anything that is not a strict improvement — no neutral accept.

### Suite format

`~/.meta-skills/validation/suites/<skill-id>.json`:

```json
{
  "skill": "deploy-app",
  "cases": [
    { "id": "c1", "prompt": "Deploy rollback to production",
      "keywords": ["deploy", "production"],
      "mustNotContain": ["freeze window"],
      "minScore": 50, "weight": 1 }
  ]
}
```

Shape is validated on load; malformed input throws naming the offending field.

### Scoring model

Per case 0–100, deterministic — 60 pts keyword coverage + 20 pts structural
guidance (numbered steps / checklist) + 20 pts caution guidance, reusing
`selfheal`'s `scoreSkillAgainstCase` (imported, not modified). Any
`mustNotContain` hit zeroes the case. Aggregate = weighted mean; a case passes
when `score >= (minScore ?? 50)`.

### Strict gate

`gate(candidate, baseline)` accepts **only** when candidate > baseline:

- equal ⇒ reject — "no improvement"
- lower ⇒ reject — "regression"
- no baseline ⇒ reject
- `force` is the only escape hatch

Baselines live in `~/.meta-skills/validation/baselines/<skill-id>.json` as
`{ skill, aggregate, cases, ts }`, written atomically (temp + rename).

### CLI

```bash
# Compare + gate (exits non-zero when the gate rejects)
node src/validation-harness.mjs run <suitePath> --skill <SKILL.md> [--json]

# Show or record the baseline (writes only with --update)
node src/validation-harness.mjs baseline <suitePath> --skill <SKILL.md> --update
```

`evolve approve` consults the gate before applying a mutation when a suite and
a baseline both exist for the target skill; otherwise it is a silent no-op.

### Guarantees

- Offline and deterministic — no network, no LLM calls, no command execution
- Stdlib only — zero new npm deps
- Tests run in temp dirs (`fs.mkdtempSync`), never the real home (20 tests)

## Multi-iteration evolution loop (issue #36)

`evolve --all` is one-shot. `evolve loop` turns it into a bounded K-iteration loop (WikiSkill
Algorithm 1 shape): measure → propose → gate → optionally apply, with one JSONL record per
iteration and a closing summary per run.

```bash
# Dry-run (default): estimate only, no index mutation
meta-skills evolve loop run --iterations 5

# Custom run, write mode (snapshot → apply → re-measure → rollback on regression)
meta-skills evolve loop run --iterations 8 --ceiling 90 --no-progress-stop 3 --write --json

# Read the recorded history
meta-skills evolve loop status
meta-skills evolve loop status --json
```

Defaults: `--iterations 5`, `--ceiling 100`, `--no-progress-stop 2`, `--write` off, paths under
`~/.meta-skills/` (`global.json`, `evolve/proposals.jsonl`, `evolve/iterations.jsonl`).

Records (`~/.meta-skills/evolve/iterations.jsonl`, one JSON object per line):

```json
{ "ts": "...", "type": "iteration", "runId": "ev-...", "iteration": 1, "mode": "dry-run",
  "proposalsAttempted": 3, "proposalsKept": 2, "applied": 0, "accepted": 2,
  "scoreBefore": 50, "scoreAfter": null, "estimatedDelta": 4, "skillIds": ["a"],
  "stage": "early", "termination": null }
```

Stage buckets: early = 1-2, mid = 3-5, late = 6+. A `type: "summary"` record closes each run with
`iterationsRun`, `acceptanceRate`, `applied`, `termination`, `avgDelta`, `stageStats` and
`perSkill` counts. Corrupt/half lines are skipped on read.

Termination reasons, checked in order: `ceiling` → `no-progress` → `max-iterations`; `manual` is
written by the SIGINT path (`finalizeManual()`, exit 130).

Integration notes: the default `measure` dep is the average quality score (scalar 0-100) and the
issue #35 validation harness replaces it later; `src/wiki.mjs` can feed `analyze` when it lands.
Read-only views: MCP tool `iteration_summary` and dashboard `GET /api/iterations`.

## Raw evidence capture (issue #37)

Usage events are shallow; root-cause analysis needs the actual evidence.
`src/traces.mjs` is the raw layer behind `record --evidence`.

```bash
node src/usage-tracker.mjs record my-skill --outcome failure --evidence trace.md
node src/usage-tracker.mjs record my-skill --outcome failure --evidence - --traces-dir /tmp/traces
```

- Traces live in `~/.meta-skills/traces/<id>.md` with
  `<id>` = `<yyyymmdd-hhmmss>-<hash6>` (deterministic: time + content hash).
- **Write-once**: a second store of the same id throws — traces are immutable,
  and there is no delete/prune API.
- **Bounded**: each trace is capped at 15,000 chars; the stored file keeps the
  head and ends with `[truncated: kept 15000 of N chars]`.
- **Sampled**: an analysis cycle takes at most 8 traces
  (`MAX_FAIL_TRACES = 5` failing + `MAX_PASS_TRACES = 3` passing), applied by
  `sampleTraces(items)` in deterministic input order.
- **Linked**: the usage event gains `traceId` (plus `traceTruncated` when the
  cap was hit); events recorded without `--evidence` are unchanged.

**Privacy** — traces are user-provided and may contain sensitive data (prompts,
reasoning excerpts, tool calls, file contents). They are local-only: never
uploaded, never included in `sync` payloads, which stays metadata/usage-only.

## Consolidation step (issue #38)

`src/consolidate.mjs` converts raw evidence (usage-log events, execution traces)
into structured knowledge: wiki pattern pages with root-cause analysis, plus
index + log upkeep.

### Evidence model

One JSONL line per item: `{"skill", "outcome": "failure"|"success", "timestamp",
"excerpt", "traceId"}`. `loadEvidence()` reads a `.jsonl` file or a directory of
them (cap 500 entries, corrupt lines skipped).

### Grouping and thresholds

- Group by outcome + skill + signature; signature = top ≤6 keywords from the
  excerpt, frequency-sorted with alphabetical tie-break (deterministic).
- Group size must reach `--min-evidence` (default 2); smaller groups are counted
  as `skippedBelowThreshold` and never become patterns.
- Failure groups → `failure-<skill>-<signature-slug>`, success groups →
  `success-<skill>-<signature-slug>`.

### Pattern template

Enforced sections: `# <name>`, `## Description`, `## Root Cause`, `## Evidence`,
`## Fix`, `## Last Updated` (ISO date). Evidence bullets are
`- <ts> <skill> [trace <id>] — <excerpt first 60 chars>`.

### Update, don't duplicate

An existing `<name>.md` is edited in place — new bullets go right after the
`## Evidence` header and `## Last Updated` is refreshed. Pages are never
rewritten wholesale, never duplicated, and every write is atomic (temp + rename,
no `.tmp` leftovers).

### Index and log upkeep

- `index.md`: one sorted line per pattern — `- [<name>](patterns/<name>.md): <description first sentence>`
- `logs.md`: one timestamped summary line per run (created/updated counts)

### Dry-run default

Nothing is written unless `--write` is passed; the summary always reports
`dryRun`, `created`, `updated`, `evidenceCount`, `skippedBelowThreshold`.

```bash
# Dry-run (default) — compute only
node src/consolidate.mjs --input ~/.meta-skills/logs --dir ~/.meta-skills/wiki

# Apply
node src/consolidate.mjs --input ~/.meta-skills/logs --min-evidence 2 --write --json
```

### Integration points

- Raw trace capture (issue #37, `src/traces.mjs`) supplies `traceId` values.
- Wiki layer (issue #33, `src/wiki.mjs`) owns page rendering elsewhere; consolidate stays standalone.
- `meta-skills consolidate` dispatch in `src/cli.mjs` is a follow-up.

## Success-strategy mining (issue #39)

Failure analysis (v1.3) learns from `outcome=failure`; this closes the other
half of the loop by learning from successes, so working behavior is not
accidentally regressed. Passing traces are kept for the same reason WikiSkill
samples them — to identify effective strategies.

### Event / note shapes

```
# daily log event (usage-tracker)
{"skill":"deploy-app","timestamp":"2026-08-26T10:00:00Z","outcome":"success","excerpt":"deploy rollback verified health endpoint"}

# cluster (analyzeSuccesses, minCount >= 2)
{ skill, count, firstAt, lastAt, keywords: [<=6], excerpts: [<=3] }

# reinforce note (clustersToNotes → ~/.meta-skills/evolve/reinforce-notes.jsonl)
{ skill, kind: 'reinforce', generated, reason, suggestedGuidance: [1-2 bullets] }
```

### CLI

```
# Cluster summary
meta-skills success analyze --log-dir ~/.meta-skills/logs --min-count 2 --json

# Reinforce notes — dry-run by default; --write appends JSONL
meta-skills success notes
meta-skills success notes --write
```

### Integration

`meta-skills propose --with-success` runs success mining inside failure
analysis (`withSuccess` at the function level): clusters → notes, written on a
real run, printed on `--dry-run`. Without the flag, `propose` is unchanged.

- Keywords use selfheal's extractor, so failure and success analysis agree.
- Notes are append-only JSONL (crash-safe ledger); `readNotes` skips corrupt
  lines and returns `[]` for a missing file.
- Zero new npm deps; 31 assertions in `src/success-miner.test.mjs`.

## Outcome read-back & retention (v0.2.5)

**The problem:** proposals are generated from current quality scores only. Nothing reads history
back, so a target a human rejected last week is proposed again — and `propose reject` deleted the
proposal file outright, so one pipeline's memory was erased while the other kept it as `rejected`.

**The fix:** every outcome is written to an append-only audit trail, and proposal generation
consults that trail before it suggests anything. Rejection becomes a tombstone, not a deletion.

### Audit trail

`~/.meta-skills/evolve/skill-impact.jsonl` — one JSON object per line:

```json
{ "ts": "2026-01-02T09:11:04.000Z", "proposalId": "rewrite-vague-1", "type": "rewrite",
  "skills": ["vague-skill"], "outcome": "rejected", "reason": "too broad" }
```

The log sits beside the proposal store it audits (`path.dirname` when the store is a file), so each
store carries its own memory and tests run in temp dirs.

### Read-back

- **Never re-propose a rejected target+direction.** Key = `type|target` — skill id, or `a+b` for a
  merge — built from rejected rows in the store plus rejected entries in the trail.
- `suppressRejected(opportunities, rejectedKeys)` returns `{ kept, suppressed }`; only `kept` reaches
  `generateProposals()`, and `evolve` prints `suppressed N previously-rejected candidate(s)`.
- `evolve review` marks a pending proposal `[previously rejected]` when its key matches a prior
  rejection, and lists rejected entries (id, date, reason) so the trail is readable.

### CLI

```bash
# Reject = retained tombstone (patch kept + <id>.rejected.json sidecar)
meta-skills propose reject <id> [--reason "text"]

# Permanent delete — explicit and gated
meta-skills propose reject <id> --purge --yes

# Rejected tombstones are hidden by default; --all shows them marked [rejected <date>]
meta-skills propose list --all

# Read the audit trail
meta-skills skill-impact list [--store <dir-or-file>] [--json]
```

### Design

- **Rejection is memory, not amnesia** — purging files does not rewrite the trail
- **`--purge` refuses without `--yes`** — destructive paths need an explicit confirmation
- **Corrupt lines are skipped** — the trail must stay readable even if one write is damaged
- **Zero new npm deps** — Node stdlib only (`src/skill-impact.mjs`)

## References

- [Agent Skills Specification](https://agentskills.io/specification.md) - The SKILL.md standard
- [Skill Discovery Pattern](https://agents.kour.me/skill-discovery/) - Progressive disclosure for agent capabilities
- [Library Meta-Skill](https://claudefa.st/blog/guide/mechanics/library-meta-skill) - Centralized skill distribution
- [EvoSkill: Automated Skill Discovery](https://arxiv.org/html/2603.02766v1) - Self-evolving skill frameworks

## Wiki Layer (issue #33)

A persistent knowledge layer under `~/.meta-skills/wiki/`. Events say what
happened; the wiki says what was learned. It compounds across sessions and is
kept separate from raw usage events and the skill index.

### Structure

```
~/.meta-skills/wiki/
  index.md         # one entry per pattern: PROBLEM + ROOT CAUSE + FIX
  logs.md          # append-only timestamped activity log
  skill-impact.md  # machine-written lines: which skill changed, and why
  patterns/        # one page per pattern, ~10-30 lines
```

### Rules

- Index entries are 1-2 sentences: **PROBLEM + ROOT CAUSE + FIX**.
- Pattern pages are ~10-30 lines: root cause, the exact observed sequence, the
  concrete fix. No filler, no restating the obvious.
- Capture **success** patterns as well as failures — a fix that held is a
  pattern, not just the absence of a bug.
- Update an existing pattern instead of duplicating it. `createPattern` throws
  on an existing slug; `updatePattern` throws on a missing one.
- The wiki is **never rolled back** — skills are. The rollback ledger restores
  `global.json`; knowledge is append/update-only.
- Pattern names are slugs: lowercase `[a-z0-9-]`, `.md` optional and normalized.

### CLI

```bash
# Create the structure (safe to call repeatedly)
node src/wiki.mjs init

# Inspect it
node src/wiki.mjs status
node src/wiki.mjs status --json

# Custom location (used by tests and by non-default installs)
node src/wiki.mjs init --wiki-dir /tmp/wiki
```

### Design

- **Zero new dependencies** — `node:fs`, `node:path`, `node:os` only
- **Atomic writes** — temp + rename for every file, so a crash never leaves a
  half-written pattern
- **Idempotent setup** — `ensureWiki()` creates what is missing and never
  clobbers existing content
- **Greppable impact log** — `- <ISO ts> | skill=<id> | change=<text> | pattern=<slug>`
- **22 tests** in `src/wiki.test.mjs`, all inside a temp directory
