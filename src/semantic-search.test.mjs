// v1.9 — Semantic search & fuzzy matching tests

import { search, loadIndex, formatResults, formatResultsJSON } from './semantic-search.mjs';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const SAMPLE_SKILLS = [
  {
    id: 'git-commits',
    when: 'writing commit messages, generating changelogs, or analyzing git history',
    why: 'enforces conventional commits format with scope detection',
    priority: 'high',
  },
  {
    id: 'code-review',
    when: 'reviewing PRs, analyzing code quality, suggesting improvements',
    why: 'provides structured review checklist and common anti-pattern detection',
    priority: 'high',
  },
  {
    id: 'docker-deploy',
    when: 'building Docker images, writing Dockerfiles, deploying containers',
    why: 'ensures Docker best practices and secure container configurations',
    priority: 'medium',
  },
  {
    id: 'database-migration',
    when: 'writing SQL migrations, schema changes, data backfills',
    why: 'prevents common migration pitfalls and ensures rollback plans',
    priority: 'medium',
  },
  {
    id: 'api-testing',
    when: 'writing API tests, integration tests, or contract tests',
    why: 'provides test patterns for REST and GraphQL endpoints',
    priority: 'high',
  },
  {
    id: 'react-component',
    when: 'building React components, hooks, or optimizing renders',
    why: 'enforces React best practices and accessibility standards',
    priority: 'medium',
  },
  {
    id: 'security-audit',
    when: 'auditing dependencies, reviewing auth flows, checking OWASP top 10',
    why: 'catches common security vulnerabilities before they ship',
    priority: 'low',
  },
  {
    id: 'docs-generator',
    when: 'writing README, API docs, or inline code documentation',
    why: 'generates consistent documentation following project conventions',
    priority: 'low',
  },
  {
    id: 'ci-pipeline',
    when: 'setting up CI/CD, writing workflow files, debugging build failures',
    why: 'provides CI/CD patterns for GitHub Actions, GitLab CI, and Jenkins',
    priority: 'medium',
  },
  {
    id: 'performance-profiler',
    when: 'debugging slow queries, profiling memory usage, optimizing bottlenecks',
    why: 'identifies performance issues using profiling tools and metrics',
    priority: 'low',
  },
];

let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}`);
  }
}

function assertApprox(actual, expected, tolerance, name) {
  const ok = Math.abs(actual - expected) <= tolerance;
  if (ok) {
    passed++;
    console.log(`  ✓ ${name} (${actual})`);
  } else {
    failed++;
    console.log(`  ✗ ${name}: expected ~${expected}, got ${actual}`);
  }
}

// ── Basic search functionality ──

console.log('\n--- Basic search ---');

const results = search(SAMPLE_SKILLS, 'commit message');
assert(results.length > 0, 'returns results for "commit message"');
assert(results[0].skill.id === 'git-commits', 'top result is git-commits');
assert(results[0].score > 0, 'score > 0');
assert(results[0].breakdown !== undefined, 'has breakdown object');

// ── Semantic matching ──

console.log('\n--- Semantic matching ---');

const semanticResults = search(SAMPLE_SKILLS, 'fix slow database queries');
assert(semanticResults.length > 0, 'returns results for "fix slow database queries"');
const topSemantic = semanticResults[0].skill.id;
assert(
  ['database-migration', 'performance-profiler', 'security-audit'].includes(topSemantic),
  `top result (${topSemantic}) is relevant to database/performance`
);

// ── Fuzzy matching ──

console.log('\n--- Fuzzy matching ---');

const fuzzyResults = search(SAMPLE_SKILLS, 'commits', { mode: 'fuzzy' });
assert(fuzzyResults.length > 0, 'fuzzy mode returns results');
assert(fuzzyResults[0].skill.id === 'git-commits', 'fuzzy finds git-commits for "commits"');

const typoResults = search(SAMPLE_SKILLS, 'committ messaje');
assert(typoResults.length > 0, 'handles typos ("committ messaje")');
assert(typoResults[0].skill.id === 'git-commits', 'typo still finds git-commits');

// ── Semantic mode ──

console.log('\n--- Semantic mode ---');

const semOnly = search(SAMPLE_SKILLS, 'containers', { mode: 'semantic' });
assert(semOnly.length > 0, 'semantic mode returns results');
const topSem = semOnly[0].skill.id;
assert(
  ['docker-deploy', 'ci-pipeline'].includes(topSem),
  `semantic mode top result (${topSem}) is container-related`
);

// ── Limits and thresholds ──

console.log('\n--- Limits and thresholds ---');

const limited = search(SAMPLE_SKILLS, 'test', { limit: 3 });
assert(limited.length <= 3, 'limit=3 returns ≤3 results');

const threshold = search(SAMPLE_SKILLS, 'xyzzy_nonexistent', { minScore: 0.5 });
assert(threshold.length === 0, 'no-results query returns empty array');

// ── Empty / edge cases ──

console.log('\n--- Edge cases ---');

assert(search([], 'test').length === 0, 'empty skills returns []');
assert(search(SAMPLE_SKILLS, '').length === 0, 'empty query returns []');
assert(search(SAMPLE_SKILLS, '   ').length === 0, 'whitespace query returns []');

// ── loadIndex ──

console.log('\n--- loadIndex ---');

const tmpDir = join(tmpdir(), 'meta-skills-semantic-test-' + Date.now());
mkdirSync(tmpDir, { recursive: true });

const validIndex = join(tmpDir, 'global.json');
writeFileSync(validIndex, JSON.stringify({ skills: SAMPLE_SKILLS }));
const loaded = loadIndex(validIndex);
assert(loaded !== null, 'loadIndex parses valid JSON');
assert(loaded.skills.length === 10, 'loadIndex returns correct skill count');

const missingFile = join(tmpDir, 'nonexistent.json');
assert(loadIndex(missingFile) === null, 'loadIndex returns null for missing file');

// ── formatResults ──

console.log('\n--- formatResults ---');

const formatted = formatResults(results, 'commit message');
assert(formatted.includes('commit message'), 'formatResults includes query');
assert(formatted.includes('git-commits'), 'formatResults includes skill id');
assert(formatted.includes(results[0].score.toFixed(3)), 'formatResults includes score');

const emptyFormatted = formatResults([], 'nothing');
assert(emptyFormatted.includes('No results'), 'formatResults handles empty results');

// ── formatResultsJSON ──

console.log('\n--- formatResultsJSON ---');

const jsonOutput = formatResultsJSON(results, 'commit message');
const parsed = JSON.parse(jsonOutput);
assert(parsed.query === 'commit message', 'JSON output has query');
assert(parsed.count > 0, 'JSON output has count');
assert(parsed.results.length > 0, 'JSON output has results array');

// ── Cleanup ──

rmSync(tmpDir, { recursive: true, force: true });

// ── Summary ──

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
