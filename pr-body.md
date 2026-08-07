## v1.9 — Semantic Search & Fuzzy Matching

Replaces keyword-based `when` matching with n-gram TF-IDF similarity scoring + Levenshtein fuzzy keyword matching.

### What's new

- **`src/semantic-search.mjs`** — TF-IDF trigram vectors, cosine similarity, Jaccard n-gram overlap, Levenshtein fuzzy keyword scoring
- **Three modes**: `semantic`, `fuzzy`, `hybrid` (default)
- **CLI**: `meta-skills semantic <query> [--mode semantic|fuzzy|hybrid] [--limit N] [--json]`
- **27/27 tests pass**, zero new npm deps
- Backward compatible — new command, doesn't change existing surface

### Example

```
$ meta-skills semantic "fix slow database queries"
  semantic search results for "fix slow database queries":
  0.523  performance-profiler
  0.487  database-migration
  0.341  security-audit

$ meta-skills semantic "committ messaje"
  0.712  git-commits
```

### Design

- **Zero external API calls** — pure heuristic TF-IDF + Levenshtein, no LLM dependency
- **Zero new npm deps** — uses only Node.js stdlib
- **Deterministic** — same input always produces same output
- **Hybrid mode** blends semantic (50%) + fuzzy (30%) + exact match bonus (30%) for best results

### Roadmap context

v1.0-v1.8 all shipped. v2.0 (autonomous skill evolution with EvoSkill-inspired mutation loop) is the next major milestone after this.
