# Ã°Å¸Â§Â  Meta-Skills: The Agent's Skill Index

> A lightweight, self-improving skill discovery layer for AI agents.

## The Problem

Modern AI agents (Claude Code, Cursor, OpenClaw, Hermes, Codex CLI) accumulate **dozens to hundreds of skills** across global configs and project-specific setups. Each skill has a `SKILL.md` with detailed instructions Ã¢â‚¬â€ but the agent has no quick way to **know what skills exist and when to use them** without loading every single file.

The result: agents either:
- Load all skills upfront Ã¢â€ â€™ **context bloat, token waste**
- Miss relevant skills entirely Ã¢â€ â€™ **underutilized capabilities**
- Duplicate effort across projects Ã¢â€ â€™ **fragmented knowledge**

## The Solution: Meta-Skills

A **meta-skills** file is a lightweight JSON index that sits between the agent's system prompt and the full skill library. It's the **table of contents** for all available capabilities Ã¢â‚¬â€ the agent reads it in <200 tokens and instantly knows:

> *"Which skills exist? When should I use each one? Where is the full file?"*

```
Ã¢â€Å’Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€Â
Ã¢â€â€š                 Agent Context                     Ã¢â€â€š
Ã¢â€â€š  Ã¢â€Å’Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€Â   Ã¢â€â€š
Ã¢â€â€š  Ã¢â€â€š  System Prompt + Agent Setup (CLAUDE.md)   Ã¢â€â€š   Ã¢â€â€š
Ã¢â€â€š  Ã¢â€â€š  "Always scan meta-skills first" Ã¢â€ ÂÃ¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€Â  Ã¢â€â€š   Ã¢â€â€š
Ã¢â€â€š  Ã¢â€â€Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€Ëœ  Ã¢â€â€š
Ã¢â€â€š                        Ã¢â€â€š                        Ã¢â€â€š
Ã¢â€â€š                        Ã¢â€“Â¼                        Ã¢â€â€š
Ã¢â€â€š  Ã¢â€Å’Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€Â  Ã¢â€â€š
Ã¢â€â€š  Ã¢â€â€š  meta-skills.json  (~150 tokens)          Ã¢â€â€š  Ã¢â€â€š
Ã¢â€â€š  Ã¢â€â€š  Ã¢â€Å’Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€Â Ã¢â€Å’Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€Â Ã¢â€Å’Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€Â   Ã¢â€â€š  Ã¢â€â€š
Ã¢â€â€š  Ã¢â€â€š  Ã¢â€â€š skill-a Ã¢â€â€š Ã¢â€â€š skill-b  Ã¢â€â€š Ã¢â€â€š skill-c  Ã¢â€â€š   Ã¢â€â€š  Ã¢â€â€š
Ã¢â€â€š  Ã¢â€â€š  Ã¢â€â€š when: X Ã¢â€â€š Ã¢â€â€š when: Y  Ã¢â€â€š Ã¢â€â€š when: Z  Ã¢â€â€š   Ã¢â€â€š  Ã¢â€â€š
Ã¢â€â€š  Ã¢â€â€š  Ã¢â€â€Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€Ëœ Ã¢â€â€Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€Ëœ Ã¢â€â€Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€Ëœ   Ã¢â€â€š  Ã¢â€â€š
Ã¢â€â€š  Ã¢â€â€Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€Ëœ  Ã¢â€â€š
Ã¢â€â€š                        Ã¢â€â€š                        Ã¢â€â€š
Ã¢â€â€š                        Ã¢â€“Â¼ (on demand)            Ã¢â€â€š
Ã¢â€â€š  Ã¢â€Å’Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€Â  Ã¢â€â€š
Ã¢â€â€š  Ã¢â€â€š  Full SKILL.md files (loaded only when     Ã¢â€â€š  Ã¢â€â€š
Ã¢â€â€š  Ã¢â€â€š  the skill is activated)                   Ã¢â€â€š  Ã¢â€â€š
Ã¢â€â€š  Ã¢â€â€Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€Ëœ  Ã¢â€â€š
Ã¢â€â€Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€Ëœ
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

Each entry is **minimal by design** Ã¢â‚¬â€ just enough for the agent to decide whether to load the full skill.

### Self-Improvement Loop

```
Ã¢â€Å’Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€Â     Ã¢â€Å’Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€Â     Ã¢â€Å’Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€Â
Ã¢â€â€š  Agent uses  Ã¢â€â€šÃ¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€“Â¶Ã¢â€â€š  Agent records   Ã¢â€â€šÃ¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€“Â¶Ã¢â€â€š  Meta-Skills  Ã¢â€â€š
Ã¢â€â€š  a skill     Ã¢â€â€š     Ã¢â€â€š  usage + outcome Ã¢â€â€š     Ã¢â€â€š  updates:     Ã¢â€â€š
Ã¢â€â€š              Ã¢â€â€š     Ã¢â€â€š                  Ã¢â€â€š     Ã¢â€â€š  - usage_countÃ¢â€â€š
Ã¢â€â€š              Ã¢â€â€š     Ã¢â€â€š                  Ã¢â€â€š     Ã¢â€â€š  - last_used  Ã¢â€â€š
Ã¢â€â€š              Ã¢â€â€š     Ã¢â€â€š                  Ã¢â€â€š     Ã¢â€â€š  - frequency  Ã¢â€â€š
Ã¢â€â€Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€Ëœ     Ã¢â€â€Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€Ëœ     Ã¢â€â€Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€Â¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€Ëœ
                                                       Ã¢â€â€š
Ã¢â€Å’Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€Â     Ã¢â€Å’Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€Â              Ã¢â€â€š
Ã¢â€â€š  Background  Ã¢â€â€šÃ¢â€”â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â€š  Periodic scan   Ã¢â€â€šÃ¢â€”â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€Ëœ
Ã¢â€â€š  cron job    Ã¢â€â€š     Ã¢â€â€š  detects stale   Ã¢â€â€š
Ã¢â€â€š  re-indexes  Ã¢â€â€š     Ã¢â€â€š  or new skills   Ã¢â€â€š
Ã¢â€â€Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€Ëœ     Ã¢â€â€Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€Ëœ
```

The meta-skills file:
1. **Tracks usage** Ã¢â‚¬â€ which skills are actually used, how often, when last used
2. **Promotes/demotes** Ã¢â‚¬â€ frequently used skills get higher priority; unused skills sink
3. **Discovers new skills** Ã¢â‚¬â€ periodic scans detect newly installed skills
4. **Removes stale entries** Ã¢â‚¬â€ skills unused for 30+ days get flagged for review
5. **Learns project patterns** Ã¢â‚¬â€ detects tech stack, common workflows, key files

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
# Scan global agent skill directories Ã¢â€ â€™ ~/.meta-skills/global.json
meta-skills init --global

# Scan current project Ã¢â€ â€™ .meta-skills/project.json
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

## Why JSON?

- **Parsable by any agent** Ã¢â‚¬â€ no YAML frontmatter to extract
- **~150 tokens for 20 skills** Ã¢â‚¬â€ fits in any context window
- **Machine-writable** Ã¢â‚¬â€ easy for background scripts to update usage stats
- **Schema-validatable** Ã¢â‚¬â€ catch errors before they confuse the agent
- **Diff-friendly** Ã¢â‚¬â€ git-track changes over time

## Roadmap

### Ã¢Å“â€¦ Completed (v0.1Ã¢â‚¬â€œv1.0)

- [x] **v0.1** Ã¢â‚¬â€ Global scanner: detect skills from Claude Code, Cursor, OpenClaw, Hermes
- [x] **v0.2** Ã¢â‚¬â€ Project scanner: extract context from README, CLAUDE.md, tech stack detection
- [x] **v0.3** Ã¢â‚¬â€ Usage tracking: record skill activations, update meta-skills JSON
- [x] **v0.4** Ã¢â‚¬â€ Self-improvement loop: promote/demote based on usage patterns
- [x] **v0.5** Ã¢â‚¬â€ Background cron: periodic re-scan and cleanup
- [x] **v0.6** Ã¢â‚¬â€ Schema registry: publish JSON Schema for validation
- [x] **v1.0** Ã¢â‚¬â€ Stable release with CLI tool

### Ã°Å¸â€Â® Next (v1.1Ã¢â‚¬â€œv2.0)

- [x] **v1.1 Ã¢â‚¬â€ Cross-agent sync** Ã¢â‚¬â€ Share usage patterns and skill metadata across Claude Code, Cursor, OpenClaw, and Gemini CLI agents via a shared `.meta-skills/sync/` directory. Each agent writes its own events to `~/.meta-skills/sync/<agent>/events.jsonl`. `meta-skills sync push` uploads local logs to the shared store; `meta-skills sync pull` aggregates all agents' events into `global.json`, recording `last_agents` (which agents have used each skill) and `last_synced_agent` (the most recent agent). Agent identity is auto-detected from `META_SKILLS_AGENT` env var, then from agent-specific env vars (`CLAUDE_API_KEY`, `CURSOR_API_KEY`, `OPENCLAW_CONFIG_DIR`, `GEMINI_API_KEY`, etc.), then from process argv. *Inspired by: EvoSkill's transferable skill concept, multi-agent coordination patterns.*

- [x] **v1.2 Ã¢â‚¬â€ Skill marketplace integration** Ã¢â‚¬â€ Query [awesome-agent-skills](https://github.com/VoltAgent/awesome-agent-skills) (1497+ skills) and [agentskills.io](https://agentskills.io) registries directly. `meta-skills search "react testing"` filters 1000+ marketplace skills by tokenized query against name, description, owner, and section. Supports `--source` (filter by registry), `--limit`, `--refresh` (force re-fetch), `--json` (machine-readable). Results are cached for 7 days in `~/.meta-skills/marketplace/` and deduped across sources (preferring awesome-agent-skills). `meta-skills install <skill-id>` fetches the SKILL.md from the source repo and writes it to `--target` dir (default `~/.meta-skills/installed/<id>/SKILL.md`), optionally registering it in `global.json` with `source: "marketplace"`. `meta-skills marketplace list|refresh` for raw access. *Inspired by: VoltAgent's 1000+ curated skills, agentskills.io registry.*

- [x] **v1.3 Ã¢â‚¬â€ Failure-based auto-improvement** Ã¢â‚¬â€ When a skill activation records `outcome: failure`, the system automatically analyzes failure patterns and generates a proposed patch (diff) to the skill's SKILL.md. Three patch types: tighten when: field, add anti-patterns section, or suggest splitting the skill. Human reviews via propose list|apply|reject|auto-pr. Modeled on EvoSkill's Pareto-optimized failure-analysis loop. *Inspired by: EvoSkill (7.3% accuracy gain via failure analysis), BerriAI/self-improving-agent.*

- [ ] **v1.4 Ã¢â‚¬â€ Web dashboard** Ã¢â‚¬â€ A local web UI showing skill usage heatmaps, stale-skill warnings, priority distribution, co-occurrence graphs, and a "bundle explorer". Serves on `localhost` via the existing Node.js runtime. *Inspired by: agentskills.io visual catalog, Claude Code skill stats demand.*

- [ ] **v1.5 Ã¢â‚¬â€ Agent config injection** Ã¢â‚¬â€ Auto-inject meta-skills scan instructions into `CLAUDE.md`, `.cursorrules`, `AGENTS.md`, and Gemini CLI config. Detects existing references and merges gracefully. *Inspired by: Claude best practices docs, progressive disclosure pattern.*

- [ ] **v1.6 Ã¢â‚¬â€ Skill quality scoring** Ã¢â‚¬â€ Score each skill on readability, trigger precision, instruction clarity, and token efficiency. Low-scoring skills get flagged for revision. Uses Claude API to evaluate SKILL.md quality against [Anthropic's best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices). *Inspired by: Anthropic skill authoring best practices (concise, degrees of freedom, 500-line rule).*

- [ ] **v1.7 Ã¢â‚¬â€ Token budget optimizer** Ã¢â‚¬â€ Analyze per-skill token cost vs. usage frequency. Suggest which skills to demote or archive to stay within a configurable context budget (e.g., "keep total active skill metadata under 500 tokens"). *Inspired by: progressive disclosure research (10-tool accuracy ceiling, 150-token meta-skills target).*

- [ ] **v1.8 Ã¢â‚¬â€ Skill bundles & recipes** Ã¢â‚¬â€ Group skills into named bundles ("web-dev" = react + css + api-testing) that load as a unit. Support recipe files that chain skill activations for multi-step workflows. *Inspired by: EvoSkill skill composition, co-occurrence detection from v0.4.*

- [ ] **v1.9 Ã¢â‚¬â€ Semantic search & fuzzy matching** Ã¢â‚¬â€ Replace keyword-based `when` matching with embedding-based semantic search. Skills are indexed by embedding at scan time; `meta-skills search "fix slow database queries"` returns relevant skills even when keywords don't match. *Inspired by: awesome-agent-skills search demands, agentskills.io discovery pattern.*

- [ ] **v2.0 Ã¢â‚¬â€ Autonomous skill evolution** Ã¢â‚¬â€ Full EvoSkill-inspired loop: the system runs a held-out validation task, measures skill effectiveness, proposes mutations (split/merge/rewrite SKILL.md), and keeps only Pareto-improving variants. Human-in-the-loop approval gate. *Inspired by: EvoSkill (7.3% OfficeQA gain, 12.1% SealQA gain, zero-shot transfer), Cognee self-improving skills.*

## Related Work

- [Agent Skills (agentskills.io)](https://agentskills.io) Ã¢â‚¬â€ The SKILL.md standard this builds on
- [EvoSkill (arXiv 2603.02766)](https://arxiv.org/html/2603.02766v1) Ã¢â‚¬â€ Self-evolving skill discovery via iterative failure analysis (7.3% accuracy gain)
- [awesome-agent-skills](https://github.com/VoltAgent/awesome-agent-skills) Ã¢â‚¬â€ 1497+ curated agent skills from official teams and community
- [Anthropic Skill Best Practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices) Ã¢â‚¬â€ Official guide for writing effective SKILL.md files
- [Library Meta-Skill](https://claudefa.st/blog/guide/mechanics/library-meta-skill) Ã¢â‚¬â€ Centralized skill distribution across projects
- [Skill Discovery Pattern](https://agents.kour.me/skill-discovery/) Ã¢â‚¬â€ Progressive disclosure for agent capabilities
- [EvoSkill](https://arxiv.org/html/2603.02766v1) Ã¢â‚¬â€ Self-evolving skill discovery via co-evolutionary verification

---

**License:** MIT
