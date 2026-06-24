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
│  │  "Always scan meta-skills first" ←─────┐  │   │
│  └───────────────────────────────────────────┘  │
│                        │                        │
│                        ▼                        │
│  ┌───────────────────────────────────────────┐  │
│  │  meta-skills.json  (~150 tokens)          │  │
│  │  ┌─────────┐ ┌──────────┐ ┌──────────┐   │  │
│  │  │ skill-a │ │ skill-b  │ │ skill-c  │   │  │
│  │  │ when: X │ │ when: Y  │ │ when: Z  │   │  │
│  │  └─────────┘ └──────────┘ └──────────┘   │  │
│  └───────────────────────────────────────────┘  │
│                        │                        │
│                        ▼ (on demand)            │
│  ┌───────────────────────────────────────────┐  │
│  │  Full SKILL.md files (loaded only when     │  │
│  │  the skill is activated)                   │  │
│  └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
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
└──────────────┘     └──────────────────┘     └───────┬───────┘
                                                       │
┌──────────────┐     ┌──────────────────┐              │
│  Background  │◀────│  Periodic scan   │◀─────────────┘
│  cron job    │     │  detects stale   │
│  re-indexes  │     │  or new skills   │
└──────────────┘     └──────────────────┘
```

The meta-skills file:
1. **Tracks usage** — which skills are actually used, how often, when last used
2. **Promotes/demotes** — frequently used skills get higher priority; unused skills sink
3. **Discovers new skills** — periodic scans detect newly installed skills
4. **Removes stale entries** — skills unused for 30+ days get flagged for review
5. **Learns project patterns** — detects tech stack, common workflows, key files

## Workflow

### Setup (One-Time)

```bash
# Install the meta-skills agent
meta-skills init --global

# For a specific project
cd my-project
meta-skills init --local
```

This:
1. Scans all agent config directories for skills
2. Generates `~/.meta-skills/global.json`
3. Scans project files for context
4. Generates `<project>/.meta-skills/project.json`
5. Injects a reference comment into `CLAUDE.md` / Cursor rules

### Daily Use

The agent reads the meta-skills file at startup (~150 tokens) and knows instantly what's available. When it decides to use a skill, it loads the full `SKILL.md` on demand.

### Background Maintenance

A cron job (or heartbeat) runs periodically to:
- Re-scan for new/changed skills
- Update usage statistics
- Prune stale entries
- Re-generate project context

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

- **Parsable by any agent** — no YAML frontmatter to extract
- **~150 tokens for 20 skills** — fits in any context window
- **Machine-writable** — easy for background scripts to update usage stats
- **Schema-validatable** — catch errors before they confuse the agent
- **Diff-friendly** — git-track changes over time

## Roadmap

- [ ] **v0.1** — Global scanner: detect skills from Claude Code, Cursor, OpenClaw, Hermes
- [ ] **v0.2** — Project scanner: extract context from README, CLAUDE.md, tech stack detection
- [ ] **v0.3** — Usage tracking: record skill activations, update meta-skills JSON
- [ ] **v0.4** — Self-improvement loop: promote/demote based on usage patterns
- [ ] **v0.5** — Background cron: periodic re-scan and cleanup
- [ ] **v0.6** — Schema registry: publish JSON Schema for validation
- [ ] **v1.0** — Stable release with CLI tool

## Related Work

- [Agent Skills (agentskills.io)](https://agentskills.io) — The SKILL.md standard this builds on
- [Library Meta-Skill](https://claudefa.st/blog/guide/mechanics/library-meta-skill) — Centralized skill distribution across projects
- [Skill Discovery Pattern](https://agents.kour.me/skill-discovery/) — Progressive disclosure for agent capabilities
- [EvoSkill](https://arxiv.org/html/2603.02766v1) — Self-evolving skill discovery via co-evolutionary verification

---

**License:** MIT
