# v1.8 — Skill Bundles & Recipes

## Problem

Meta-skills has `suggested_bundles` (auto-detected from co-occurrence, written by `self-improve.mjs` v0.4), but no way to:

1. **Create user-defined bundles** that persist across sessions
2. **Load a bundle as a unit** — activate all member skills in one command
3. **Chain multiple skill activations into multi-step recipes** for reproducible workflows

The v1.4 dashboard shows auto-bundles read-only; v1.6 quality and v1.7 budget operate on individual skills. Bundles need their own first-class operator.

v1.0 = "we have a JSON index". v1.4 = "we can see it". v1.5 = "we can inject it". V1.6 = "we can score it". v1.7 = "we can fit it in budget". **v1.8 = "we can compose it".**

## Solution

Two new first-class concepts:

### Bundles (user-defined, persistent)

A **bundle** is a named group of skill IDs that work well together. Examples:
- `web-dev` = `react-skill` + `css-skill` + `api-testing-skill`
- `release-flow` = `validate` + `changelog` + `commit` + `tag`

Two flavors coexist:
- **`index.bundles[]`** — user-defined, persistent, take precedence. Created via `meta-skills bundle create`.
- **`index.suggested_bundles[]`** — auto-detected from co-occurrence, read-only from user's perspective. Already shipped in v0.4 self-improve.

### Recipes (multi-step workflows)

A **recipe** is a sequential list of skill activations, optionally with failure behavior. Examples:
- `release-flow.recipe` — validate → changelog → commit → tag
- `pr-review.recipe` — code-review → test-runner → security-scan

Format: simple YAML-like or JSON. Parsed by `src/recipe-runner.mjs` (cycle 2).

## Files

- **NEW** `src/bundle-manager.mjs` (~280 lines): bundle CRUD + activate + suggest + atomic write
- **NEW** `src/bundle-manager.test.mjs` (~25 tests)
- **NEW** `src/recipe-runner.mjs` (~200 lines, cycle 2): YAML/JSON recipe parse + validate + run
- **NEW** `src/recipe-runner.test.mjs` (~15 tests, cycle 2)
- **EDIT** `src/cli.mjs` (~80 lines, cycle 2): `cmdBundle` + `cmdRecipe` wiring
- **EDIT** `src/dashboard.mjs` (~50 lines, cycle 3): `/api/bundles` extended, `/api/bundles/:name`, `/api/recipes`
- **EDIT** `src/dashboard.test.mjs` (~10 tests, cycle 3)
- **EDIT** `src/self-improve.mjs` (~10 lines, cycle 3): separate user bundles from suggested
- **EDIT** `package.json`: `test` script adds bundle-manager + recipe-runner, version 1.8.0
- **EDIT** `README.md` (cycle 3): v1.8 entry + bundle + recipe CLI examples
- **EDIT** `SKILL.md` (cycle 3): Phase 11 section + roadmap checklist

## Acceptance Criteria

### Cycle 1 (this commit) — bundle-manager core + tests

#### AC1 — Schema: user bundles live in `index.bundles[]`, separate from `index.suggested_bundles[]`

- `index.bundles` is an array of `{ name, description, skills, tags, createdAt, updatedAt }`.
- `index.suggested_bundles` (auto, written by v0.4 self-improve) is preserved untouched.
- `listBundles(index, { include: 'user' })` returns only user bundles.
- `listBundles(index, { include: 'auto' })` returns only auto bundles.
- `listBundles(index, { include: 'all' })` returns both with `source: 'user' | 'auto'` field per entry.

#### AC2 — `createBundle(index, opts)` validates and persists

- `opts` = `{ name, skills, description, tags }`.
- `name` must be slug-shaped: `^[a-z0-9][a-z0-9-]{0,63}$`. Throws `BundleValidationError` otherwise.
- `name` must be unique among user bundles. Throws `BundleExistsError` if duplicate.
- `skills` must be a non-empty array of strings. Each ID must exist in `index.skills`. Throws `UnknownSkillError` otherwise.
- On success: appends to `index.bundles` with `createdAt`/`updatedAt` = current ISO timestamp.
- Returns the new bundle object.

#### AC3 — `getBundle(index, name)` returns user bundle or auto bundle

- Looks up by name in `index.bundles` first, then `index.suggested_bundles`.
- Returns `null` if not found.

#### AC4 — `deleteBundle(index, name)` removes user bundle (auto bundles are immutable)

- Removes from `index.bundles` only. Throws `BundleNotFoundError` if not in user bundles.
- Throws `CannotDeleteAutoBundleError` if name matches an entry in `index.suggested_bundles`.

#### AC5 — `activateBundle(index, name, opts)` writes activation records

- Looks up bundle by name (user first, then auto).
- For each skill ID in `bundle.skills`, writes an activation event `{ skill, timestamp, outcome: 'success', source: 'bundle', bundle: <name> }` to the log directory (`~/.meta-skills/logs/<date>.jsonl`, where `<date>` is YYYY-MM-DD in local time).
- `opts.dryRun` (default true) returns the events without writing.
- `opts.bundleDir` overrides default log directory.
- Idempotent: running twice in the same day produces two distinct timestamped entries per skill.
- Returns `{ bundle: <bundle>, events: [...] }`.

#### AC6 — `suggestBundles(index, opts)` runs co-occurrence detection and converts to user-bundle-ready format

- Reads logs from `opts.logDir` (default `~/.meta-skills/logs`).
- Returns `[{ skills: [a, b], cooccurrenceDays, suggested: true }, ...]` for pairs that co-occur ≥ `opts.minDays` (default 3) days.
- Sorted by co-occurrence count descending.
- Does NOT mutate the index.

#### AC7 — `atomicWriteJson(path, data)` writes JSON atomically

- Writes to `<path>.tmp`, then renames to `<path>`.
- JSON serialized with 2-space indent + trailing newline.
- Matches v1.7 budget-optimizer pattern.

#### AC8 — `computeBundleMetrics(index, name)` aggregates v1.6 + v1.7 data

- Returns `{ name, skills, totalTokens, avgQuality, scoreRange }`.
- `totalTokens` uses `estimateIndexTokens` from budget-optimizer.mjs (lazy import).
- `avgQuality` uses `scoreAll` from quality-scorer.mjs (lazy import).
- Returns `null` if bundle not found.
- Designed for `meta-skills bundle show` and dashboard `/api/bundles/:name`.

#### AC9 — Tests cover all ACs with ~25 cases

- AC1: listBundles filters by include param (3 tests)
- AC2: createBundle validates name (4 tests: valid, empty, bad chars, dup)
- AC2: createBundle validates skills (3 tests: empty, missing, valid)
- AC3: getBundle finds user (1) and auto (1) and missing (1)
- AC4: deleteBundle removes user (1) and refuses auto (1)
- AC5: activateBundle dry-run + write (3 tests)
- AC6: suggestBundles from fixtures (2 tests)
- AC7: atomicWriteJson writes via tmp+rename (1 test)
- AC8: computeBundleMetrics basic (2 tests)
- Plus 3 fixture/helper tests.

### Cycle 2 — recipe-runner + CLI integration + cmdBudget integration

#### AC10 — `src/recipe-runner.mjs` parses YAML-style + JSON recipes

- `parseRecipe(text, format)` returns `{ name, description, steps: [{ skill, params, on_failure }] }`.
- YAML format: `# name: <name>` and `# description: <desc>` headers, then `step <skill>: <description>` lines (description optional).
- JSON format: native `JSON.parse`.
- Throws `RecipeParseError` on malformed input.
- Steps are stored as-is for execute-time interpretation.

#### AC11 — `validateRecipe(recipe, index)` checks skill IDs + structural integrity

- Every step's `skill` must exist in `index.skills`.
- No duplicate step numbers (when explicit numbering used).
- `on_failure` (if specified) must be `stop` or `continue`.
- Returns `{ valid: true, warnings: [...] }` or throws `RecipeValidationError`.

#### AC12 — `runRecipe(recipe, index, opts)` executes steps sequentially

- For each step, calls `activateBundle` semantics (writes log entry with `recipe: <name>, step: <n>`).
- `opts.dryRun` (default true) shows what would run without writing.
- `opts.stopOnFailure` (default true) halts on first failure.
- Returns `{ executed: n, failed: n, results: [...] }`.

#### AC13 — CLI: `meta-skills bundle create <name> --skill a --skill b --desc '...' [--tag X]`

- Parses args, calls `createBundle`, atomic-writes global.json.
- Prints confirmation: `✓ bundle <name> created with N skills`.
- Returns 0 on success, 1 on validation error.

#### AC14 — CLI: `meta-skills bundle list [--json] [--tag X]`

- Lists user bundles by default. `--include auto` adds suggested bundles.
- Tabular output: name | skills count | tags | created.
- `--json` returns JSON array.
- `--tag X` filters by tag.

#### AC15 — CLI: `meta-skills bundle show <name>`

- Prints bundle details including `computeBundleMetrics` output.
- JSON mode via `--json`.

#### AC16 — CLI: `meta-skills bundle delete <name>`

- Calls `deleteBundle`, atomic-writes.
- Refuses to delete auto bundles (suggests `--force` ... no, actually just refuses — auto bundles are read-only).

#### AC17 — CLI: `meta-skills bundle activate <name> [--dry-run|--write]`

- `meta-skills bundle activate <name>` is dry-run by default (matches v1.7 budget pattern).
- `--write` actually writes activation records.
- `--json` for machine-readable output.

#### AC18 — CLI: `meta-skills bundle suggest [--min-days 3]`

- Runs `suggestBundles`, prints detected pairs.
- `--apply` converts to user bundles (asks for name via prompt? Or generates `auto-<hash>` name).
- Default: just print, don't mutate.

#### AC19 — CLI: `meta-skills recipe run <file> [--dry-run|--write] [--stop-on-failure|--continue-on-failure]`

- Reads file, detects format (.json vs .recipe), parses, validates, runs.
- Prints step-by-step results.

#### AC20 — CLI: `meta-skills recipe validate <file>`

- Reads + parses + validates. Prints `✓ recipe valid: N steps` or errors.

#### AC21 — CLI: `meta-skills recipe init <name>`

- Writes a starter `.recipe` file to cwd.

#### AC22 — cmdBudget bundle integration

- `meta-skills budget --bundle <name>` estimates cost for activating a bundle.

### Cycle 3 — dashboard + SKILL.md + README + PR

#### AC23 — Dashboard `/api/bundles?include=user|auto|all`

- Default include=`all`. User bundles returned with `source: 'user'`, auto with `source: 'auto'`.

#### AC24 — Dashboard `/api/bundles/:name`

- Returns bundle details + metrics. 404 if not found.

#### AC25 — Dashboard `/api/recipes` lists `~/.meta-skills/recipes/*.recipe|*.json`

- Returns `{ recipes: [{ name, path, steps: N }] }`.

#### AC26 — Dashboard bundle panel: show user bundles prominently + auto badge

- Update existing bundle panel to include both flavors, visually distinguished.

#### AC27 — Integration tests for new endpoints

- /api/bundles?include=user filter (1)
- /api/bundles/:name success + 404 (2)
- /api/recipes from fixture dir (1)

#### AC28 — SKILL.md Phase 11 + README v1.8 + CHANGELOG 1.8.0

- Add `## Phase 11: Skill Bundles & Recipes (v1.8)` section to SKILL.md with bundle/recipe schemas, CLI examples, design rationale.
- Add v1.8 entry to README roadmap checklist (mark `[x]`).
- Update package.json → 1.8.0.
- Update CLI usage section with bundle/recipe commands.

#### AC29 — Open PR #19

- Branch: `feat/v1.8-skill-bundles-recipes` from `master`.
- Title: `feat(v1.8): skill bundles & recipes — user-defined bundles, recipe runner, dashboard extensions`.
- Body: links to SPEC.md, lists ACs met, mentions zero new deps, mentions total test count.

## Out of Scope

These are NOT v1.8:

- v1.9 (whatever comes next, e.g., cross-bundle dependencies, recipe variables, conditionals beyond on_failure)
- Bundle versioning / migration
- Recipe variable interpolation (templating)
- Auto-generated recipes from usage patterns (could be v1.9)
- Dashboard recipe runner UI (cycle 3 adds list endpoint, full UI is post-v1.8)
- Bundle import/export to YAML files (CLI-only for v1.8)

## Inspiration

- **EvoSkill skill composition** — Pareto-optimized skill combinations
- **Make / Taskfile / npm scripts** — multi-step workflow patterns
- **LangChain prompt-template chains** — multi-step AI workflows
- **v0.4 co-occurrence** — "when I do X I usually also do Y"
- **v1.6 quality + v1.7 budget** — bundles inherit and aggregate per-skill signals

## Constraints

- **ZERO new npm deps** (matches v1.5/v1.6/v1.7 pattern)
- **Pure regex YAML parser** — no `yaml` package
- **JSON recipes via native JSON.parse**
- **User bundles persist separately** from auto-bundles (no clobber)
- **Atomic write-back** (temp + rename) for all index mutations
- **Backward compatible** — new commands only; no changes to existing CLI surface except `--version`

## Validation Harness (issue #35)

### Problem

Quality is estimated heuristically (v1.6 `quality-scorer`) and micro-tests exist
per failed prompt (v0.2.0 `selfheal`), but there is no runner that evaluates a
SKILL.md against a curated suite of held-out cases, and no rule that forbids a
neutral change. `selfheal validate` is a Pareto non-regression gate — equal
scores are accepted, so churn slips through.

### Solution

`src/validation-harness.mjs` — small, deterministic, offline, stdlib-only:

- loads a validation suite (curated held-out cases per skill)
- scores a given SKILL.md against the suite (reuses `selfheal` scoring via import)
- persists baselines and compares candidate vs baseline
- exposes a STRICT gate: accept only when the candidate aggregate **strictly
  exceeds** the baseline. Equal ⇒ reject ("no improvement"); lower ⇒ reject
  ("regression"). `force` is the only escape hatch.

### Files

- `~/.meta-skills/validation/suites/<skill-id>.json` — the held-out suite
- `~/.meta-skills/validation/baselines/<skill-id>.json` — `{ skill, aggregate, cases, ts }`, atomic write (temp + rename)

### Suite format

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

Shape is validated on load; malformed input throws with the offending path
(`cases[0].minScore must be a number in 0-100`).

### Scoring model

Per case, 0–100, deterministic: 60 pts keyword coverage + 20 pts structural
guidance (numbered steps / checklist) + 20 pts caution guidance, inherited from
`scoreSkillAgainstCase`. Any `mustNotContain` hit zeroes the case outright.
Aggregate = weighted mean of case scores; per-case pass = `score >= (minScore ?? 50)`.

### CLI

```bash
# Compare a SKILL.md against the suite + baseline (exits 1 when the gate rejects)
node src/validation-harness.mjs run ~/.meta-skills/validation/suites/deploy-app.json \
  --skill skills/deploy-app/SKILL.md [--json]

# Show the baseline, or record it (--update required to write)
node src/validation-harness.mjs baseline <suitePath> --skill <SKILL.md> --update
```

`evolve approve` consults the gate before applying a mutation, but only when a
suite **and** a baseline both exist for the target skill — otherwise it is a
silent no-op and behaves exactly as before. `--force` overrides the refusal.

### Guarantees

- **Offline** — no network, no LLM calls, no arbitrary command execution; file reads only
- **Deterministic** — same suite + same SKILL.md ⇒ same scores, same verdict
- **Zero new npm deps** — Node stdlib only
- **Atomic writes** — temp + rename for every baseline file
- **Tests use temp dirs only** (`fs.mkdtempSync`) — never touch the real home

## Multi-iteration evolution loop (issue #36)

### Problem

`evolve --all` is one-shot: baseline → analyze → propose → Pareto filter → write. There is no
iteration state, no run history, no acceptance statistics, and no early termination. WikiSkill
Algorithm 1 treats evolution as a bounded loop with per-iteration bookkeeping; meta-skills should
mirror that shape.

### Solution

`src/evolution-loop.mjs` — a dependency-injected loop controller. Each iteration runs
measure → propose → gate → (optionally) apply, then records itself.

```
meta-skills evolve loop run [--iterations 5] [--ceiling 100] [--no-progress-stop 2] [--write] [--json]
meta-skills evolve loop status [--json]
```

Options and defaults: `iterations = 5`, `ceiling = 100`, `stopAtCeiling = true`,
`noProgressStop = 2`, `write = false` (DRY-RUN is the default — the index is never mutated),
`globalJson` / `proposalsPath` / `iterationsPath` default under `~/.meta-skills/`.

### Records file shape

`~/.meta-skills/evolve/iterations.jsonl`, one JSON object per line:

```json
{ "ts": "...", "type": "iteration", "runId": "ev-...", "iteration": 1, "mode": "dry-run",
  "proposalsAttempted": 3, "proposalsKept": 2, "applied": 0, "accepted": 2,
  "scoreBefore": 50, "scoreAfter": null, "estimatedDelta": 4, "skillIds": ["a"],
  "stage": "early", "termination": null }
```

Stage buckets: early = iterations 1-2, mid = 3-5, late = 6+. A closing `type: "summary"` record
carries `iterationsRun`, `acceptanceRate`, `applied`, `termination`, `avgDelta`,
`stageStats: { early, mid, late }` and `perSkill: { <id>: { attempted, accepted } }`.
Corrupt or half-written lines are skipped on read.

### Termination

Checked in order per iteration: `ceiling` (metric ≥ ceiling) → `no-progress` (N consecutive
iterations without improvement) → `max-iterations` (k === K). `manual` is written by the SIGINT
path (`finalizeManual()`, exit 130). Improvement means a measured gain in write mode, otherwise a
positive estimate in dry-run.

### Write mode

`--write` snapshots the index (`rollback-ledger.mjs`), applies the gate-surviving mutations with
the existing evolution machinery, re-measures, and restores the snapshot when the post-apply score
drops below the pre-apply score — that iteration is recorded as rejected with reason `regression`.

### Integration notes

The default `measure` dep is the average quality score (scalar 0-100). The issue #35 validation
harness plugs in later by replacing that dep — keep the scalar contract. `src/wiki.mjs` (in-flight)
can feed `analyze` with wiki-derived proposals; the loop only requires `analyze(index, baseline)`.
Read-only views: MCP tool `iteration_summary` and dashboard `GET /api/iterations` both return
`summarizeIterations()` output.

## Raw evidence capture (issue #37)

### `src/traces.mjs` — the raw layer

- One file per trace: `~/.meta-skills/traces/<id>.md`, where `<id>` is
  `<yyyymmdd-hhmmss>-<hash6>` (timestamp + sha256 of content, deterministic)
  or an explicit `opts.id`.
- **Write-once / immutable**: storing an id that already exists throws a clear
  error — traces are never overwritten. Writes go through temp file + rename.
- **Size cap**: content longer than `MAX_TRACE_CHARS` keeps the first 15,000
  chars and appends `[truncated: kept 15000 of N chars]`; `storeTrace` reports
  `truncated: true` and `originalChars`.
- **No delete/prune API** — the raw layer is append-only by design.
- API: `defaultTracesDir()`, `storeTrace()`, `readTrace()`, `listTraces()`
  (sorted by id), `traceStats()`, `sampleTraces()`.

### Shared constants (imported by sampling/consolidation work)

- `MAX_TRACES_PER_CYCLE = 8` — traces analyzed per analysis cycle.
- `MAX_FAIL_TRACES = 5` — failing traces per cycle.
- `MAX_PASS_TRACES = 3` — passing traces per cycle (5 + 3 = 8).
- `MAX_TRACE_CHARS = 15000` — per-trace character cap.
- `sampleTraces(items)` classifies by `outcome` (`failure`/`fail` vs
  `success`/`pass`) and returns `{ failing, passing, sampled, total }`,
  deterministic in input order; `opts.maxFail` / `opts.maxPass` override.

### Event linkage

`record --evidence <file|->` stores the trace and links it on the usage event
as `traceId` (plus `traceTruncated` when the cap was hit). Without
`--evidence` the event shape is exactly as before — additive-only, so existing
consumers (aggregate, dashboard, failure-analyzer) keep working.

### Privacy

Traces are user-provided and may contain sensitive data (prompts, reasoning
excerpts, tool calls, file contents). They stay local: written under the user's
own `~/.meta-skills/traces`, never uploaded, never serialized into sync
payloads — `sync` remains metadata/usage-only. `src/traces.mjs` makes no
network calls.

## Consolidation step (issue #38)

`src/consolidate.mjs` turns raw evidence into structured knowledge: wiki pattern
pages with root-cause analysis, plus index + log upkeep.

### Evidence model

One JSONL line per evidence item:

```json
{"skill": "auth", "outcome": "failure", "timestamp": "2026-01-01T00:00:00Z",
 "excerpt": "token timeout refresh loop", "traceId": "tr-1"}
```

`loadEvidence()` accepts a `.jsonl` file or a directory of them (cap 500 entries,
corrupt lines skipped).

### Grouping and thresholds

- Group by outcome + skill + signature; signature = top ≤6 keywords from the
  excerpt, frequency-sorted with alphabetical tie-break (deterministic).
- A group becomes a pattern only when its size ≥ `--min-evidence` (default 2);
  smaller groups are reported as `skippedBelowThreshold`.
- Failure groups → `failure-<skill>-<signature-slug>`; success groups →
  `success-<skill>-<signature-slug>`.

### Pattern template

Enforced sections, in order: `# <name>`, `## Description`, `## Root Cause`,
`## Evidence`, `## Fix`, `## Last Updated` (ISO date). Evidence bullets are
`- <ts> <skill> [trace <id>] — <excerpt first 60 chars>`.

### Update, don't duplicate

When `<name>.md` already exists, `upsertPattern()` edits it in place: new bullets
are inserted right after the `## Evidence` header (exact-substring insertion) and
`## Last Updated` is refreshed. Pages are never rewritten wholesale and never
duplicated. Every write is atomic (temp + rename, no `.tmp` leftovers).

### Index and log upkeep

- `index.md` — one sorted line per pattern: `- [<name>](patterns/<name>.md): <description first sentence>`.
- `logs.md` — one timestamped summary line per run (created/updated counts).

### Dry-run default

`consolidate()` computes everything and writes nothing unless `opts.write === true`
(CLI `--write`), and reports `dryRun: true` in its summary.

```bash
node src/consolidate.mjs --input ~/.meta-skills/logs --dir ~/.meta-skills/wiki \
  --min-evidence 2 --write --json
```

### Integration points

- Raw trace capture (issue #37, `src/traces.mjs`) supplies `traceId` values; not imported here.
- Wiki layer (issue #33, `src/wiki.mjs`) owns page rendering elsewhere; consolidate writes plain markdown so it stays standalone.
- `src/cli.mjs` dispatch for `meta-skills consolidate` is a follow-up — the module runs standalone today.

## Outcome read-back & retention (issue #34)

**The problem:** the pipeline writes proposals but never reads them back. `analyzeMutations()` /
`generateProposals()` score the present only, so a target a human already rejected comes back on
the next run. Worse, `propose reject` unlinked the proposal file while `evolve reject` kept it as
`rejected` — two pipelines, two memories.

**The fix:** every outcome is recorded, and proposal generation consults that record before it
suggests anything.

### Audit trail

- **Location** — `<proposals dir>/skill-impact.jsonl`, derived with `path.dirname` when the store
  is a file. The log lives next to the store it audits, so tests stay hermetic.
- **Schema** — one JSON object per line:
  `{ ts, proposalId, type, skills: [..], outcome: 'accepted'|'rejected', reason? }`
  `ts` is filled in when missing; corrupt lines are skipped; a missing file reads as `[]`.
- **Read-back key** — `type|target`, where target is a skill id or `a+b` for a merge — the same
  shape the proposal constructor uses, so both pipelines agree.

### Read-back rule

- **Never re-propose a rejected target+direction.** `buildRejectedKeys()` merges rejected rows from
  the proposals store with rejected entries from the trail; `suppressRejected(opportunities, keys)`
  returns `{ kept, suppressed }` and only `kept` reaches `generateProposals()`.
- **Counter line** — `evolve` prints `suppressed N previously-rejected candidate(s)` so the skip is
  visible in the run output, not silent.
- **Review output** — a pending proposal whose key matches a prior rejection is marked
  `[previously rejected]`, and rejected entries stay listed (id, date, reason) as tombstones.

### Retention semantics

- **reject = tombstone.** The `.patch` file is retained; a `<id>.rejected.json` sidecar records
  `{ rejectedAt, reason }`. Rejected proposals are hidden from `propose list` by default and shown
  with `--all`, each marked `[rejected <date>]`.
- **`--purge --yes` = delete.** Permanent removal is explicit and refuses without `--yes`
  (`refusing to purge without --yes`). Purging does not rewrite the audit trail — the outcome stays.
- **Explicit paths everywhere** — `impactLogPath(storeDirOrFile)`, `appendImpact(entry, logPath)`,
  `readImpact(logPath)` all take the path, so nothing defaults to `~/.meta-skills` in tests.

## Wiki Layer (issue #33)

### Problem

Usage events record what happened (`logs/*.jsonl`) and the index records what
skills exist (`global.json`). Neither records what was learned: the root cause
behind a failure and the fix that held. Without that layer the same problem is
rediscovered every session.

### Solution

`src/wiki.mjs` — a persistent, compounding knowledge layer under the
meta-skills home directory, kept separate from raw usage events and the index:

```
~/.meta-skills/wiki/
  index.md         # one entry per pattern: PROBLEM + ROOT CAUSE + FIX
  logs.md          # append-only timestamped activity log
  skill-impact.md  # machine-written lines: which skill changed, and why
  patterns/        # one page per pattern, ~10-30 lines
```

Skill updates build on this layer: a mutation is justified by a pattern page,
and the mutation itself is written back to `skill-impact.md`.

### Rules

- Index entries are 1-2 sentences in PROBLEM + ROOT CAUSE + FIX form.
- Pattern pages are ~10-30 lines: root cause, the exact observed sequence, and
  the concrete fix.
- Capture success patterns as well as failure patterns — knowing what works is
  as valuable as knowing what broke.
- Update an existing pattern instead of duplicating it; `createPattern` throws
  when the slug already exists.
- The wiki is never rolled back — skills are. `rollback-ledger.mjs` restores
  `global.json` only; the wiki is append/update-only.
- Pattern names are slugs: lowercase `[a-z0-9-]`, `.md` optional and normalized.

### API

- `defaultWikiDir()`, `ensureWiki(dir)` — idempotent structure creation
- `readWikiIndex(dir)`, `readWiki(dir)`, `updateIndex(dir, content)`
- `appendLog(dir, text)`, `recordSkillImpact(dir, entry)`
- `createPattern(dir, name, content)`, `readPattern(dir, name)`,
  `updatePattern(dir, name, content)`, `listPatterns(dir)`
- CLI: `node src/wiki.mjs init|status [--wiki-dir <path>] [--json]`

### Constraints

- Zero new npm deps (`node:fs`, `node:path`, `node:os`)
- Atomic writes via temp + rename; no `.tmp` files left behind
- 22 tests in `src/wiki.test.mjs`, every one inside
  `fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-'))` — the real home directory
  is never touched
- No network, no external API calls
