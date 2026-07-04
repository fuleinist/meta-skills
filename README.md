# ðŸ§  Meta-Skills: The Agent's Skill Index

> A lightweight, self-improving skill discovery layer for AI agents.

## The Problem

Modern AI agents (Claude Code, Cursor, OpenClaw, Hermes, Codex CLI) accumulate **dozens to hundreds of skills** across global configs and project-specific setups. Each skill has a `SKILL.md` with detailed instructions â€” but the agent has no quick way to **know what skills exist and when to use them** without loading every single file.

The result: agents either:
- Load all skills upfront â†’ **context bloat, token waste**
- Miss relevant skills entirely â†’ **underutilized capabilities**
- Duplicate effort across projects â†’ **fragmented knowledge**

## The Solution: Meta-Skills

A **meta-skills** file is a lightweight JSON index that sits between the agent's system prompt and the full skill library. It's the **table of contents** for all available capabilities â€” the agent reads it in <200 tokens and instantly knows:

> *"Which skills exist? When should I use each one? Where is the full file?"*

```
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚                 Agent Context                     â”‚
â”‚  â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”   â”‚
â”‚  â”‚  System Prompt + Agent Setup (CLAUDE.md)   â”‚   â”‚
â”‚  â”‚  "Always scan meta-skills first" â†â”€â”€â”€â”€â”€â”  â”‚   â”‚
â”‚  â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜  â”‚
â”‚                        â”‚                        â”‚
â”‚                        â–¼                        â”‚
â”‚  â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”  â”‚
â”‚  â”‚  meta-skills.json  (~150 tokens)          â”‚  â”‚
â”‚  â”‚  â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â” â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â” â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”   â”‚  â”‚
â”‚  â”‚  â”‚ skill-a â”‚ â”‚ skill-b  â”‚ â”‚ skill-c  â”‚   â”‚  â”‚
â”‚  â”‚  â”‚ when: X â”‚ â”‚ when: Y  â”‚ â”‚ when: Z  â”‚   â”‚  â”‚
â”‚  â”‚  â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜ â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜ â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜   â”‚  â”‚
â”‚  â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜  â”‚
â”‚                        â”‚                        â”‚
â”‚                        â–¼ (on demand)            â”‚
â”‚  â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”  â”‚
â”‚  â”‚  Full SKILL.md files (loaded only when     â”‚  â”‚
â”‚  â”‚  the skill is activated)                   â”‚  â”‚
â”‚  â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜  â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
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

Each entry is **minimal by design** â€” just enough for the agent to decide whether to load the full skill.

### Self-Improvement Loop

```
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”     â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”     â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚  Agent uses  â”‚â”€â”€â”€â”€â–¶â”‚  Agent records   â”‚â”€â”€â”€â”€â–¶â”‚  Meta-Skills  â”‚
â”‚  a skill     â”‚     â”‚  usage + outcome â”‚     â”‚  updates:     â”‚
â”‚              â”‚     â”‚                  â”‚     â”‚  - usage_countâ”‚
â”‚              â”‚     â”‚                  â”‚     â”‚  - last_used  â”‚
â”‚              â”‚     â”‚                  â”‚     â”‚  - frequency  â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜     â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜     â””â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”˜
                                                       â”‚
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”     â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”              â”‚
â”‚  Background  â”‚â—€â”€â”€â”€â”€â”‚  Periodic scan   â”‚â—€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
â”‚  cron job    â”‚     â”‚  detects stale   â”‚
â”‚  re-indexes  â”‚     â”‚  or new skills   â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜     â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
```

The meta-skills file:
1. **Tracks usage** â€” which skills are actually used, how often, when last used
2. **Promotes/demotes** â€” frequently used skills get higher priority; unused skills sink
3. **Discovers new skills** â€” periodic scans detect newly installed skills
4. **Removes stale entries** â€” skills unused for 30+ days get flagged for review
5. **Learns project patterns** â€” detects tech stack, common workflows, key files

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
# Scan global agent skill directories â†’ ~/.meta-skills/global.json
meta-skills init --global

# Scan current project â†’ .meta-skills/project.json
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

## Why JSON?

- **Parsable by any agent** â€” no YAML frontmatter to extract
- **~150 tokens for 20 skills** â€” fits in any context window
- **Machine-writable** â€” easy for background scripts to update usage stats
- **Schema-validatable** â€” catch errors before they confuse the agent
- **Diff-friendly** â€” git-track changes over time

## Roadmap

### âœ… Completed (v0.1â€“v1.0)

- [x] **v0.1** â€” Global scanner: detect skills from Claude Code, Cursor, OpenClaw, Hermes
- [x] **v0.2** â€” Project scanner: extract context from README, CLAUDE.md, tech stack detection
- [x] **v0.3** â€” Usage tracking: record skill activations, update meta-skills JSON
- [x] **v0.4** â€” Self-improvement loop: promote/demote based on usage patterns
- [x] **v0.5** â€” Background cron: periodic re-scan and cleanup
- [x] **v0.6** â€” Schema registry: publish JSON Schema for validation
- [x] **v1.0** â€” Stable release with CLI tool

### ðŸ”® Next (v1.1â€“v2.0)

- [x] **v1.1 â€” Cross-agent sync** â€” Share usage patterns and skill metadata across Claude Code, Cursor, OpenClaw, and Gemini CLI agents via a shared `.meta-skills/sync/` directory. Each agent writes its own events to `~/.meta-skills/sync/<agent>/events.jsonl`. `meta-skills sync push` uploads local logs to the shared store; `meta-skills sync pull` aggregates all agents' events into `global.json`, recording `last_agents` (which agents have used each skill) and `last_synced_agent` (the most recent agent). Agent identity is auto-detected from `META_SKILLS_AGENT` env var, then from agent-specific env vars (`CLAUDE_API_KEY`, `CURSOR_API_KEY`, `OPENCLAW_CONFIG_DIR`, `GEMINI_API_KEY`, etc.), then from process argv. *Inspired by: EvoSkill's transferable skill concept, multi-agent coordination patterns.*

- [ ] **v1.2 â€” Skill marketplace integration** â€” Query [awesome-agent-skills](https://github.com/VoltAgent/awesome-agent-skills) (1497+ skills) and [agentskills.io](https://agentskills.io) registries directly. `meta-skills search "react testing"` â†’ discover + install skills from community repos. *Inspired by: VoltAgent's 1000+ curated skills, agentskills.io registry.*

- [ ] **v1.3 â€” Failure-based auto-improvement** â€” When a skill activation records `outcome: failure`, the system automatically proposes a diff to the skill's SKILL.md. Human reviews via PR. Modeled on EvoSkill's Pareto-optimized failure-analysis loop. *Inspired by: EvoSkill (7.3% accuracy gain via failure analysis), BerriAI/self-improving-agent.*

- [ ] **v1.4 â€” Web dashboard** â€” A local web UI showing skill usage heatmaps, stale-skill warnings, priority distribution, co-occurrence graphs, and a "bundle explorer". Serves on `localhost` via the existing Node.js runtime. *Inspired by: agentskills.io visual catalog, Claude Code skill stats demand.*

- [ ] **v1.5 â€” Agent config injection** â€” Auto-inject meta-skills scan instructions into `CLAUDE.md`, `.cursorrules`, `AGENTS.md`, and Gemini CLI config. Detects existing references and merges gracefully. *Inspired by: Claude best practices docs, progressive disclosure pattern.*

- [ ] **v1.6 â€” Skill quality scoring** â€” Score each skill on readability, trigger precision, instruction clarity, and token efficiency. Low-scoring skills get flagged for revision. Uses Claude API to evaluate SKILL.md quality against [Anthropic's best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices). *Inspired by: Anthropic skill authoring best practices (concise, degrees of freedom, 500-line rule).*

- [ ] **v1.7 â€” Token budget optimizer** â€” Analyze per-skill token cost vs. usage frequency. Suggest which skills to demote or archive to stay within a configurable context budget (e.g., "keep total active skill metadata under 500 tokens"). *Inspired by: progressive disclosure research (10-tool accuracy ceiling, 150-token meta-skills target).*

- [ ] **v1.8 â€” Skill bundles & recipes** â€” Group skills into named bundles ("web-dev" = react + css + api-testing) that load as a unit. Support recipe files that chain skill activations for multi-step workflows. *Inspired by: EvoSkill skill composition, co-occurrence detection from v0.4.*

- [ ] **v1.9 â€” Semantic search & fuzzy matching** â€” Replace keyword-based `when` matching with embedding-based semantic search. Skills are indexed by embedding at scan time; `meta-skills search "fix slow database queries"` returns relevant skills even when keywords don't match. *Inspired by: awesome-agent-skills search demands, agentskills.io discovery pattern.*

- [ ] **v2.0 â€” Autonomous skill evolution** â€” Full EvoSkill-inspired loop: the system runs a held-out validation task, measures skill effectiveness, proposes mutations (split/merge/rewrite SKILL.md), and keeps only Pareto-improving variants. Human-in-the-loop approval gate. *Inspired by: EvoSkill (7.3% OfficeQA gain, 12.1% SealQA gain, zero-shot transfer), Cognee self-improving skills.*

## Related Work

- [Agent Skills (agentskills.io)](https://agentskills.io) â€” The SKILL.md standard this builds on
- [EvoSkill (arXiv 2603.02766)](https://arxiv.org/html/2603.02766v1) â€” Self-evolving skill discovery via iterative failure analysis (7.3% accuracy gain)
- [awesome-agent-skills](https://github.com/VoltAgent/awesome-agent-skills) â€” 1497+ curated agent skills from official teams and community
- [Anthropic Skill Best Practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices) â€” Official guide for writing effective SKILL.md files
- [Library Meta-Skill](https://claudefa.st/blog/guide/mechanics/library-meta-skill) â€” Centralized skill distribution across projects
- [Skill Discovery Pattern](https://agents.kour.me/skill-discovery/) â€” Progressive disclosure for agent capabilities
- [EvoSkill](https://arxiv.org/html/2603.02766v1) â€” Self-evolving skill discovery via co-evolutionary verification

---

**License:** MIT
