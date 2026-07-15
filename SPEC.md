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