## Summary

Adds per-skill semantic versioning and runtime engine compatibility checking (v0.1.1 from issue #21 roadmap).

### Changes

**schema/v1.json**
- Added optional `version` field to SkillEntry (semver pattern `^\d+\.\d+\.\d+`)
- Added optional `engines` field with `node` constraint sub-property

**src/global-scanner.mjs**
- Improved `parseFrontmatter` to handle nested `metadata:` blocks with sub-keys
- Extracts `metadata.version` -> skill `version` field
- Extracts `metadata.engines` -> skill `engines` field (e.g. `{node: ">=18.0.0"}`)

**src/validate.mjs**
- Added `--check-engines` flag for runtime engine compatibility warnings
- Added `parseSemverRange()` - parses `>=`, `^`, `~`, `*` Node version constraints
- Added `checkEngines(index)` - warns when skill's `engines.node` is incompatible with current `process.version`
- Warnings are non-fatal (exit code 0 unless schema errors exist)

**src/cli.mjs**
- Wired `--check-engines` through to validate command
- Updated help text

### Tests
- global-scanner.test.mjs: 20 -> 22 (+2 for version/engines extraction)
- validate.test.mjs: 10 -> 21 (+11 for version schema validation + semver parsing + engine checks)
- All existing tests pass (pre-existing dashboard 2 failures unchanged)

### Zero new npm dependencies
