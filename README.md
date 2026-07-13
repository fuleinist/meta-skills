# 🧠 Meta-Skills: The Agent's Skill Index

> A lightweight, self-improving skill discovery layer for AI agents.

## The Problem

Modern AI agents (Claude Code, Cursor, OpenClaw, Hermes, Codex CLI) accumulate **dozens to hundreds of skills** across global configs and project-specific setups. Each skill has a `SKILL.md` with detailed instructions — but the agent has no quick way to **know what skills exist and when to use them** without loading every single file.

The result: agents either:
- Load all skills upfront → **context bloat, token waste**
- Miss relevant skills entirely → **underutilized capabilities**
- Duplicate effort across projects → **fragmented knowledge**

## The Solution: Meta-Skills

A **meta-skills** file is a lightweight JSON index that sits between the agent's system prompt and the full skill library. It's the **table of contents** for all available capabilities — the agent reads it in <200 tokens and instantly knows:

> *"Which skills exist? When should I use each one? Where is the full file?"*

```
┌─────────────────────────────────────────────────┐
│                 Agent Context                     │
│  ┌───────────────────────────────────────────┐   │
│  │  System Prompt + Agent Setup (CLAUDE.md)   │   │
│  │  "Always scan meta-skills first" ┬─────┐  │   │
│  ────────────────────────────────────────────┘  │
│                        │                        │
│                        ▼                        │
│  ┌───────────────────────────────────────────┐  │
│  │  meta-skills.json  (~150 tokens)          │  │
│  │  ┌─────────┐ ┌──────────┐ ┌──────────┐   │  │
│  │  │ skill-a │ │ skill-b  │ │ skill-c  │   │  │
│  │  │ when: X │ │ when: Y  │ │ when: Z  │   │  │
│  │  ──────────┘ ───────────┘ ───────────┘   │  │
│  ────────────────────────────────────────────┘  │
│                        │                        │
│                        ▼ (on demand)            │
│  ┌───────────────────────────────────────────┐  │
│  │  Full SKILL.md files (loaded only when     │  │
│  │  the skill is activated)                   │  │
│  ────────────────────────────────────────────┘  │
──────────────────────────────────────────────────┘
```

## Architecture

### Two Levels of Meta-Skills

| Level | Scope | File | Purpose |
|-------|-------|------|---------|
| **Global** | Agent-wide config (`~/.claude/`, `~/.cursor/`, OpenClaw skills) | `~/.meta-skills/global.json` | All skills available to the agent across all projects |
| **Local** | Per-project context (`README.md`, `CLAUDE.md`, Cursor rules) | `<project>/.meta-skills/project.json` | Skills and context specific to this codebase |

### The Meta-Skills JSON Format

```json
{
  "$schema": "https://meta-skills.dev/schema/v1.json",
  "version": "1.0",
  "generated": "2026-06-24T08:48:00+10:00",
  "source": "global",
  "skills": [
    {
      "id": "git-commits",
      "when": "writing commit messages, generating changelogs, or analyzing git history",
      "why": "enforces conventional commits format with scope detection",
      "path": "~/.claude/skills/git-commits/SKILL.md",
      "priority": "high",
      "usage_count": 42,
      "last_used": "2026-06-23T14:30:00+10:00"
    },
    {
      "id": "code-review",
      "when": "reviewing PRs, analyzing code quality, suggesting improvements",
      "why": "provides structured review checklist and common anti-pattern detection",
      "path": "~/.claude/skills/code-review/SKILL.md",
      "priority": "high",
      "usage_count": 28,
      "last_used": "2026-06-22T09:15:00+10:00"
    }
  ],
  "project_context": {
    "tech_stack": ["python", "fastapi", "postgresql", "react"],
    "key_files": ["README.md", "CLAUDE.md", "docker-compose.yml"],
    "patterns": ["clean architecture", "repository pattern"]
  }
}
```

Each entry is **minimal by design** — just enough for the agent to decide whether to load the full skill.

### Self-Improvement Loop

```
┌──────────────┐     ┌──────────────────┐     ┌───────────────┐
│  Agent uses  │────▶│  Agent records   │────▶│  Meta-Skills  │
│  a skill     │     │  usage + outcome │     │  updates:     │
│              │     │                  │     │  - usage_count│
│              │     │                  │     │  - last_used  │
│              │     │                  │     │  - frequency  │
───────────────┘     ───────────────────┘     ────────────────┘
                                                       │
┌──────────────┐     ┌──────────────────┐              │
│  Background  │├─────│  Periodic scan   │├──────────────┘
│  cron job    │     │  detects stale   │
│  re-indexes  │     │  or new skills   │
───────────────┘     ───────────────────┘
```

The meta-skills file:
1. **Tracks usage** — which skills are actually used, how often, when last used
2. **Promotes/demotes** — frequently used skills get higher priority; unused skills sink
3. **Discovers new skills** — periodic scans detect newly installed skills
4. **Removes stale entries** — skills unused for 30+ days get flagged for review
5. **Learns project patterns** — detects tech stack, common workflows, key files

## CLI Usage

### Installation

```bash
# Clone the repo
cd meta-skills
npm install

# Or link globally
npm link
```

### Setup (One-Time)

```bash
# Scan global agent skill directories → ~/.meta-skills/global.json
meta-skills init --global

# Scan current project → .meta-skills/project.json
cd my-project
meta-skills init --local
```

This:
1. Scans all agent config directories for skills
2. Generates `~/.meta-skills/global.json`
3. Scans project files for context
4. Generates `<project>/.meta-skills/project.json`

### Daily Use

```bash
# Record skill activation
meta-skills record git-commits
meta-skills record code-review --outcome failure

# Aggregate usage logs into global.json
meta-skills aggregate

# Run self-improvement loop (promote/demote/archive)
meta-skills improve

# Full maintenance run (scan + aggregate + improve + project context)
meta-skills maintain

# Validate against schema
meta-skills validate ~/.meta-skills/global.json

# Show index summary
meta-skills status

# Cross-agent sync (v1.1+)
meta-skills sync push             # Upload local logs to shared sync store
meta-skills sync pull             # Aggregate all agents' events into global.json
meta-skills sync                  # Combined push + pull
meta-skills sync status           # Show per-agent contribution summary

# Skill marketplace (v1.2+)
meta-skills search "react testing"  # Search awesome-agent-skills + agentskills.io
meta-skills search "stripe" --json  # Machine-readable results
meta-skills install docx            # Fetch SKILL.md from source repo
meta-skills install pdf --target ~/my-skills  # Custom install dir
meta-skills marketplace list        # List all known marketplace skills
meta-skills marketplace refresh     # Force re-fetch of marketplace caches
```

### Background Maintenance

Schedule via cron (or OpenClaw cron):

```bash
# Daily at 3 AM
0 3 * * * cd /path/to/project && meta-skills maintain
```

Or use the standalone maintenance script:

```bash
node src/maintenance.mjs
```

## Agent Setup Reference

Add this to your agent configuration files:

**CLAUDE.md:**
```markdown
## Skills

Always read `~/.meta-skills/global.json` and `.meta-skills/project.json` at startup.
These files list all available skills with when/why to use each one.
Load the full SKILL.md only when you decide to activate a skill.
```

**Cursor `.cursorrules`:**
```yaml
alwaysRead:
  - ~/.meta-skills/global.json
  - .meta-skills/project.json
```

**OpenClaw AGENTS.md:**
```markdown
Before working, scan meta-skills files for available skills.
```

## v1.6 — Skill Quality Scoring

`meta-skills quality` scores each skill on 4 heuristic dimensions (no external API calls).

### Scoring Dimensions

| Dimension | Weight | What It Checks |
|-----------|--------|----------------|
| **Readability** | 25% | Frontmatter, description, section structure, length, code examples, links |
| **Trigger Precision** | 30% | `when` field exists, length, trigger words, no generic words |
| **Instruction Clarity** | 25% | Numbered steps, code blocks, examples, anti-patterns, references |
| **Token Efficiency** | 20% | Meaningful line ratio, no commented code, no ASCII art, avg line length |

### CLI

```bash
# Score all skills
meta-skills quality

# Only show skills below threshold
meta-skills quality --threshold 50

# JSON output for scripting
meta-skills quality --json
```

### Flags

Skills below 40 in any dimension get flagged: `low-readability`, `vague-trigger`, `unclear-instructions`, `inefficient`, `critical` (< 30 overall).

### Design

- **Zero external API calls** — pure heuristic analysis
- **Zero new dependencies** — uses only Node.js stdlib
- **21 tests** covering all 4 dimensions + scoreSkill + scoreAll + edge cases

## Why JSON?

- **Parsable by any agent** — no YAML frontmatter to extract
- **~150 tokens for 20 skills** — fits in any context window
- **Machine-writable** — easy for background scripts to update usage stats
- **Schema-validatable** — catch errors before they confuse the agent
- **Diff-friendly** — git-track changes over time

## Roadmap

### ✅ Completed (v0.1–v1.0)

- [x] **v0.1** — Global scanner: detect skills from Claude Code, Cursor, OpenClaw, Hermes
- [x] **v0.2** — Project scanner: extract context from README, CLAUDE.md, tech stack detection
- [x] **v0.3** — Usage tracking: record skill activations, update meta-skills JSON
- [x] **v0.4** — Self-improvement loop: promote/demote based on usage patterns
- [x] **v0.5** — Background cron: periodic re-scan and cleanup
- [x] **v0.6** — Schema registry: publish JSON Schema for validation
- [x] **v1.0** — Stable release with CLI tool

### 🔮 Next (v1.1–v2.0)

- [x] **v1.1 — Cross-agent sync** — Share usage patterns and skill metadata across Claude Code, Cursor, OpenClaw, and Gemini CLI agents via a shared `.meta-skills/sync/` directory. Each agent writes its own events to `~/.meta-skills/sync/<agent>/events.jsonl`. `meta-skills sync push` uploads local logs to the shared store; `meta-skills sync pull` aggregates all agents' events into `global.json`, recording `last_agents` (which agents have used each skill) and `last_synced_agent` (the most recent agent). Agent identity is auto-detected from `META_SKILLS_AGENT` env var, then from agent-specific env vars (`CLAUDE_API_KEY`, `CURSOR_API_KEY`, `OPENCLAW_CONFIG_DIR`, `GEMINI_API_KEY`, etc.), then from process argv. *Inspired by: EvoSkill's transferable skill concept, multi-agent coordination patterns.*

- [x] **v1.2 — Skill marketplace integration** — Query [awesome-agent-skills](https://github.com/VoltAgent/awesome-agent-skills) (1497+ skills) and [agentskills.io](https://agentskills.io) registries directly. `meta-skills search "react testing"` filters 1000+ marketplace skills by tokenized query against name, description, owner, and section. Supports `--source` (filter by registry), `--limit`, `--refresh` (force re-fetch), `--json` (machine-readable). Results are cached for 7 days in `~/.meta-skills/marketplace/` and deduped across sources (preferring awesome-agent-skills). `meta-skills install <skill-id>` fetches the SKILL.md from the source repo and writes it to `--target` dir (default `~/.meta-skills/installed/<id>/SKILL.md`), optionally registering it in `global.json` with `source: "marketplace"`. `meta-skills marketplace list|refresh` for raw access. *Inspired by: VoltAgent's 1000+ curated skills, agentskills.io registry.*

- [x] **v1.3 — Failure-based auto-improvement** — When a skill activation records `outcome: failure`, the system automatically analyzes failure patterns and generates a proposed patch (diff) to the skill's SKILL.md. Three patch types: tighten when: field, add anti-patterns section, or suggest splitting the skill. Human reviews via propose list|apply|reject|auto-pr. Modeled on EvoSkill's Pareto-optimized failure-analysis loop. *Inspired by: EvoSkill (7.3% accuracy gain via failure analysis), BerriAI/self-improving-agent.*

- [x] **v1.4 — Web dashboard** — Local web UI showing skill usage heatmaps, stale-skill warnings, priority distribution, co-occurrence graphs, and a bundle explorer. `meta-skills dashboard --port 7777` boots a Node http server bound to 127.0.0.1 (loopback-only, security) and serves a single-page HTML+CSS+vanilla-JS app. JSON API at `/api/index`, `/api/logs`, `/api/stale`, `/api/priority`, `/api/cooccurrence`, `/api/heatmap`, `/api/bundles`. Auto-refreshes every 30s. Zero new dependencies — uses only Node.js stdlib. *Inspired by: agentskills.io visual catalog, Claude Code skill stats demand.*

- [ ] **v1.5 — Agent config injection** — Auto-inject meta-skills scan instructions into `CLAUDE.md`, `.cursorrules`, `AGENTS.md`, and Gemini CLI config. Detects existing references and merges gracefully. *Inspired by: Claude best practices docs, progressive disclosure pattern.*

- [x] **v1.6 — Skill quality scoring** — Score each skill on readability, trigger precision, instruction clarity, and token efficiency. `meta-skills quality [--threshold <n>] [--json]`. 21 tests, zero external API calls, zero new deps. *Inspired by: Anthropic skill authoring best practices (concise, degrees of freedom, 500-line rule, trigger precision).*

- [ ] **v1.7 — Token budget optimizer** — Analyze per-skill token cost vs. usage frequency. Suggest which skills to demote or archive to stay within a configurable context budget (e.g., "keep total active skill metadata under 500 tokens"). *Inspired by: progressive disclosure research (10-tool accuracy ceiling, 150-token meta-skills target).*

- [ ] **v1.8 — Skill bundles & recipes** — Group skills into named bundles ("web-dev" = react + css + api-testing) that load as a unit. Support recipe files that chain skill activations for multi-step workflows. *Inspired by: EvoSkill skill composition, co-occurrence detection from v0.4.*

- [ ] **v1.9 — Semantic search & fuzzy matching** — Replace keyword-based `when` matching with embedding-based semantic search. Skills are indexed by embedding at scan time; `meta-skills search "fix slow database queries"` returns relevant skills even when keywords don't match. *Inspired by: awesome-agent-skills search demands, agentskills.io discovery pattern.*

- [ ] **v2.0 — Autonomous skill evolution** — Full EvoSkill-inspired loop: the system runs a held-out validation task, measures skill effectiveness, proposes mutations (split/merge/rewrite SKILL.md), and keeps only Pareto-improving variants. Human-in-the-loop approval gate. *Inspired by: EvoSkill (7.3% OfficeQA gain, 12.1% SealQA gain, zero-shot transfer), Cognee self-improving skills.*

## Related Work

- [Agent Skills (agentskills.io)](https://agentskills.io) — The SKILL.md standard this builds on
- [EvoSkill (arXiv 2603.02766)](https://arxiv.org/html/2603.02766v1) — Self-evolving skill discovery via iterative failure analysis (7.3% accuracy gain)
- [awesome-agent-skills](https://github.com/VoltAgent/awesome-agent-skills) — 1497+ curated agent skills from official teams and community
- [Anthropic Skill Best Practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices) — Official guide for writing effective SKILL.md files
- [Library Meta-Skill](https://claudefa.st/blog/guide/mechanics/library-meta-skill) — Centralized skill distribution across projects
- [Skill Discovery Pattern](https://agents.kour.me/skill-discovery/) — Progressive disclosure for agent capabilities
- [EvoSkill](https://arxiv.org/html/2603.02766v1) — Self-evolving skill discovery via co-evolutionary verification

---

**License:** MIT
