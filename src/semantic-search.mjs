// v1.9 — Semantic search & fuzzy matching
// Replaces keyword-based `when` matching with n-gram similarity scoring.
// Zero new dependencies — pure Node.js stdlib.

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── N-gram tokenizer ──────────────────────────────────────────────

function ngrams(text, n = 3) {
  if (!text || typeof text !== 'string') return new Set();
  const normalized = text.toLowerCase().replace(/[^a-z0-9\s_-]/g, '');
  const result = new Set();
  for (let i = 0; i <= normalized.length - n; i++) {
    result.add(normalized.slice(i, i + n));
  }
  return result;
}

// ── Jaccard similarity between two sets ───────────────────────────

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ── TF-IDF style scoring ──────────────────────────────────────────

function buildCorpus(skills) {
  // Collect all trigrams across all skill documents
  const docFreq = new Map(); // trigram -> number of skills containing it
  const skillDocs = skills.map(skill => {
    const text = [
      skill.id || '',
      skill.when || '',
      skill.why || '',
      skill.description || '',
      skill.name || '',
    ].join(' ');
    const grams = ngrams(text, 3);
    for (const g of grams) {
      docFreq.set(g, (docFreq.get(g) || 0) + 1);
    }
    return { skill, grams };
  });

  const N = skills.length;

  // Precompute TF-IDF vectors for each skill
  const vectors = skillDocs.map(({ skill, grams }) => {
    const tf = new Map();
    for (const g of grams) {
      tf.set(g, (tf.get(g) || 0) + 1);
    }
    const maxTf = Math.max(...tf.values(), 1);
    const vector = {};
    for (const [gram, count] of tf) {
      const tfidf = (count / maxTf) * Math.log((N + 1) / (docFreq.get(gram) + 1) + 1);
      vector[gram] = tfidf;
    }
    return { skill, vector, magnitude: magnitude(vector) };
  });

  return vectors;
}

function magnitude(vec) {
  let sum = 0;
  for (const v of Object.values(vec)) sum += v * v;
  return Math.sqrt(sum);
}

function cosineSimilarity(queryVec, docVec) {
  let dot = 0;
  for (const [gram, val] of Object.entries(queryVec)) {
    if (docVec[gram]) dot += val * docVec[gram];
  }
  const qMag = magnitude(queryVec);
  const dMag = magnitude(docVec);
  if (qMag === 0 || dMag === 0) return 0;
  return dot / (qMag * dMag);
}

// ── Tokenize query into TF-IDF vector ─────────────────────────────

function queryVector(query, corpus) {
  const grams = ngrams(query, 3);
  const N = corpus.length;
  const docFreq = new Map();
  for (const doc of corpus) {
    for (const gram of Object.keys(doc.vector)) {
      docFreq.set(gram, (docFreq.get(gram) || 0) + 1);
    }
  }
  const tf = new Map();
  for (const g of grams) {
    tf.set(g, (tf.get(g) || 0) + 1);
  }
  const maxTf = Math.max(...tf.values(), 1);
  const vec = {};
  for (const [gram, count] of tf) {
    const df = docFreq.get(gram) || 1;
    vec[gram] = (count / maxTf) * Math.log((N + 1) / (df + 1) + 1);
  }
  return vec;
}

// ── Levenshtein distance for fuzzy keyword matching ───────────────

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function fuzzyKeywordScore(query, text) {
  if (!text) return 0;
  const qWords = query.toLowerCase().split(/\s+/).filter(Boolean);
  const tWords = text.toLowerCase().split(/\s+/).filter(Boolean);
  let score = 0;
  for (const qw of qWords) {
    let best = 0;
    for (const tw of tWords) {
      const dist = levenshtein(qw, tw);
      const maxLen = Math.max(qw.length, tw.length);
      const sim = maxLen === 0 ? 1 : 1 - dist / maxLen;
      if (sim > best) best = sim;
    }
    score += best;
  }
  return score / qWords.length;
}

// ── Main search function ──────────────────────────────────────────

export function search(skills, query, options = {}) {
  const {
    limit = 10,
    minScore = 0.1,
    mode = 'hybrid', // 'semantic', 'fuzzy', 'hybrid'
  } = options;

  if (!query || !skills || skills.length === 0) return [];

  const corpus = buildCorpus(skills);
  const qVec = queryVector(query, corpus);

  const results = skills.map((skill, i) => {
    const doc = corpus[i];
    const semanticScore = cosineSimilarity(qVec, doc.vector);

    const searchableText = [
      skill.id || '',
      skill.when || '',
      skill.why || '',
      skill.description || '',
      skill.name || '',
    ].join(' ');
    const fuzzyScore = fuzzyKeywordScore(query, searchableText);

    // Exact match bonus
    const exactBonus = searchableText.toLowerCase().includes(query.toLowerCase()) ? 0.3 : 0;

    // ID match bonus
    const idBonus = (skill.id || '').toLowerCase().includes(query.toLowerCase()) ? 0.2 : 0;

    let combined;
    switch (mode) {
      case 'semantic':
        combined = semanticScore + exactBonus;
        break;
      case 'fuzzy':
        combined = fuzzyScore + exactBonus;
        break;
      case 'hybrid':
      default:
        combined = semanticScore * 0.5 + fuzzyScore * 0.3 + exactBonus + idBonus;
        break;
    }

    return {
      skill,
      score: Math.round(combined * 1000) / 1000,
      breakdown: {
        semantic: Math.round(semanticScore * 1000) / 1000,
        fuzzy: Math.round(fuzzyScore * 1000) / 1000,
        exactBonus: Math.round(exactBonus * 1000) / 1000,
        idBonus: Math.round(idBonus * 1000) / 1000,
      },
    };
  });

  return results
    .filter(r => r.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ── Load index from file ──────────────────────────────────────────

export function loadIndex(indexPath) {
  if (!existsSync(indexPath)) return null;
  const raw = readFileSync(indexPath, 'utf-8');
  return JSON.parse(raw);
}

// ── Format results for CLI output ──────────────────────────────────

export function formatResults(results, query) {
  if (results.length === 0) return `No results found for "${query}".`;

  const lines = [`🔍 Semantic search results for "${query}":\n`];
  for (const r of results) {
    const skill = r.skill;
    const when = skill.when ? `when: ${skill.when}` : '';
    const why = skill.why ? `why: ${skill.why}` : '';
    lines.push(`  ${r.score.toFixed(3)}  ${skill.id || skill.name}`);
    if (when) lines.push(`      ${when}`);
    if (why) lines.push(`      ${why}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function formatResultsJSON(results, query) {
  return JSON.stringify({ query, results, count: results.length }, null, 2);
}
