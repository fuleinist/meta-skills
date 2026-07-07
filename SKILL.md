---
name: meta-skills
description: A lightweight, self-improving JSON index that lets agents discover all available skills in ~150 tokens. Scans global agent configs (Claude Code, Cursor, OpenClaw, Hermes) and project files to generate a fast-reference skill catalog with usage tracking, auto-promotion, background maintenance, and failure-based patch proposals.
metadata:
  author: community
  version: "1.3.0"
  schema: https://meta-skills.dev/schema/v1.json
---

# Meta-Skills: Agent Skill Index

## Intent

Meta-Skills solves the **skill discovery problem**: agents accumulate dozens of skills but have no lightweight way to know what's available without loading every `SKILL.md` upfront. This wastes tokens and causes agents to miss relevant capabilities.

The meta-skills pattern creates a **JSON index** — a table of contents for all skills — that agents read in ~150 tokens. Each entry answers two questions: *"When should I use this?"* and *"Why does it exist?"* The full `SKILL.md` is loaded **only on demand** when the agent decides to activate a skill.

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
      "when": "short trigger description — when to activate this skill",
      "why": "one-line rationale — what value this skill provides",
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

Each entry is **minimal by design** — name + when + why + path. The agent uses `when` to decide relevance, loads the full skill only when matched.

## Implementation Plan

### Phase 1: Scanner (v0.1–v0.2)

**Global Scanner** — detect skills from all agent config directories:

1. Scan `~/.claude/skills/*/SKILL.md` — extract frontmatter `name` + `description`
2. Scan `~/.cursor/skills/*/SKILL.md` — same extraction
3. Scan OpenClaw skill directories (configurable path)
4. Scan Hermes skill directories
5. Merge into `global.json` — deduplicate by `name`, flag conflicts

**Project Scanner** — extract local context:

1. Read `README.md` — detect tech stack, project purpose
2. Read `CLAUDE.md` / `.cursorrules` — extract existing skill references
3. Scan `package.json`, `pyproject.toml`, `Cargo.toml`, `Gemfile` — detect languages/frameworks
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
- `~/.meta-skills/global.json` — all globally available skills
- `.meta-skills/project.json` — project-specific skills and context

Each entry tells you WHEN and WHY to use a skill.
Load the full SKILL.md only when you decide to activate it.
```

## Key Design Decisions

1. **JSON over YAML/Markdown** — parsable by any agent, machine-writable, schema-validatable, diff-friendly
2. **~150 tokens for 20 skills** — each entry is ~7 tokens (id + when + why + path + priority)
3. **Usage-driven promotion** — skills prove their value through actual use, not static configuration
4. **Stale detection, not deletion** — archive unused skills instead of removing them (agents change, projects evolve)
5. **Two-level hierarchy** — global skills are always available; project skills provide local context
6. **Self-contained** — no external dependencies, no runtime, just a JSON file + a simple scanner script

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

- **Skill bundles** — groups of skills that work well together (e.g., "web-dev" = react-skill + css-skill + api-testing-skill)
- **Cross-agent sync** — share usage patterns across Claude Code, Cursor, and OpenClaw agents
- **Skill recommendations** — "You often use `git-commits` with `code-review` — would you like to bundle them?"
- **Meta-skills dashboard** — web UI showing skill usage, stale skills, discovery stats
- **Plugin for IDEs** — show available skills in-editor without leaving the codebase

## Phase 6: Failure-Based Auto-Improvement (v1.3)

**The problem:** Skills fail silently. A skill activated in the wrong context produces an `outcome: failure` log entry, but nothing closes the loop. Agents repeat the same mistakes across sessions.

**The fix:** When failures accumulate, generate a proposed patch to the skill's `SKILL.md` and surface it for human review. Inspired by EvoSkill's Pareto-optimized failure-analysis loop (7.3% accuracy gain) and BerriAI/self-improving-agent.

### Failure Analysis Pipeline

1. **Scan logs** — `~/.meta-skills/logs/*.jsonl`, filter `outcome=failure`, group by `skill_id`
2. **Pattern detection** — classify failures:
   - **Vague trigger** → tighten `when:` field (e.g., "Use when task involves X" instead of "general")
   - **Short content** → add `## Anti-Patterns` section with common mistake patterns
   - **Heterogeneous failures (≥5)** → suggest splitting into sub-skills (`{name}-core`, `{name}-advanced`)
   - **Generic** → append `## Improvement Notes` with review checklist
3. **Proposal file** — write `~/.meta-skills/proposals/<skill-id>-<timestamp>.patch` containing:
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

Auto-PR opens the proposal as a PR for review — agents do not auto-merge. This preserves the core meta-skills principle: **agents propose, humans decide**.

### Use Cases

- **Skill authoring**: a skill gets 3+ failures in a week → tighten its trigger before next deploy
- **Cross-session learning**: persistent log of which skills fail when
- **Cumulative improvement**: each successful proposal raises aggregate skill quality

## References

- [Agent Skills Specification](https://agentskills.io/specification.md) — The SKILL.md standard
- [Skill Discovery Pattern](https://agents.kour.me/skill-discovery/) — Progressive disclosure for agent capabilities
- [Library Meta-Skill](https://claudefa.st/blog/guide/mechanics/library-meta-skill) — Centralized skill distribution
- [EvoSkill: Automated Skill Discovery](https://arxiv.org/html/2603.02766v1) — Self-evolving skill frameworks
