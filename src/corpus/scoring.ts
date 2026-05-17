/**
 * Eval scoring — compares LLM-proposed clarifying questions against a
 * gold clarification (the developer's hand-labeled pair).
 *
 * Metrics (per case):
 *   - overlap_at_1  : best combined score for the top-1 question (by confidence)
 *   - overlap_at_3  : best combined score across the top-3 questions
 *   - kind_match_top1 : true if top-1 question's kind == gold kind
 *   - kind_match_any  : true if any top-3 question's kind == gold kind
 *
 * Combined score formula:
 *   combined = kind_match ? max(token_overlap, KIND_MATCH_FLOOR) : token_overlap
 *
 * The kind-match floor (0.5) gives credit for getting the kind right even if
 * surface tokens differ — without it, a perfectly-kinded question that uses
 * different vocabulary scores ~0 against the gold. Tunable; the value is
 * surfaced in eval_runs.notes so we can audit later.
 */

import type { ClarifyingQuestion } from '../checks/types';

export const KIND_MATCH_FLOOR = 0.5;

export interface GoldClarification {
  pairId: number;
  originatingPromptId: number;
  clarificationKind: string | null;   // null = rejection gold (NOT a real clarification)
  clarificationText: string;
}

export interface PerQuestionScore {
  index: number;                  // 0..2 within top-3
  text: string;                   // for surfacing in eval_cases
  kind: string;
  kindMatch: boolean;
  tokenOverlap: number;           // jaccard, 0..1
  combined: number;               // kind-floor applied
}

export interface CaseScore {
  goldPairId: number;
  goldKind: string | null;
  proposedCount: number;
  overlapAt1: number;
  overlapAt3: number;
  kindMatchTop1: boolean;
  kindMatchAny: boolean;
  perQuestionScores: PerQuestionScore[];
}

// ============================================================================
// Tokenization + Jaccard
// ============================================================================

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'can', 'has', 'had', 'how',
  'was', 'this', 'that', 'with', 'have', 'will', 'your', 'from', 'they',
  'been', 'were', 'into', 'over', 'just', 'like', 'when', 'make', 'some',
  'than', 'them', 'what', 'their', 'about', 'should', 'could', 'would',
  'use', 'used', 'using', 'one', 'two', 'three', 'new', 'old',
]);

export function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of (text || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 3 || STOP_WORDS.has(w)) continue;
    out.add(w);
  }
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  const sm = a.size < b.size ? a : b;
  const lg = a.size < b.size ? b : a;
  for (const x of sm) if (lg.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ============================================================================
// Per-case scoring
// ============================================================================

export function scoreCase(gold: GoldClarification, questions: ClarifyingQuestion[]): CaseScore {
  // Sort questions by confidence DESC for top-1 / top-3 selection
  const ranked = [...questions].sort((a, b) => b.confidence - a.confidence).slice(0, 3);
  const goldTokens = tokenize(gold.clarificationText);

  const perQ: PerQuestionScore[] = ranked.map((q, idx) => {
    const qTokens = tokenize(q.text);
    const overlap = jaccard(qTokens, goldTokens);
    const kindMatch = gold.clarificationKind !== null && q.kind === gold.clarificationKind;
    const combined = kindMatch ? Math.max(overlap, KIND_MATCH_FLOOR) : overlap;
    return { index: idx, text: q.text, kind: q.kind, kindMatch, tokenOverlap: overlap, combined };
  });

  return {
    goldPairId: gold.pairId,
    goldKind: gold.clarificationKind,
    proposedCount: questions.length,
    overlapAt1: perQ[0]?.combined ?? 0,
    overlapAt3: perQ.length > 0 ? Math.max(...perQ.map(s => s.combined)) : 0,
    kindMatchTop1: perQ[0]?.kindMatch ?? false,
    kindMatchAny: perQ.some(s => s.kindMatch),
    perQuestionScores: perQ,
  };
}

// ============================================================================
// Aggregation across cases (for eval_runs row)
// ============================================================================

export interface RunAggregate {
  caseCount: number;
  meanOverlapAt1: number;
  meanOverlapAt3: number;
  kindMatchTop1Rate: number;
  kindMatchAnyRate: number;
  /** Per-kind slice means (only kinds present in gold). */
  perKindOverlapAt3: Record<string, { count: number; mean: number }>;
}

export function aggregate(scores: CaseScore[]): RunAggregate {
  const n = scores.length;
  if (n === 0) {
    return {
      caseCount: 0, meanOverlapAt1: 0, meanOverlapAt3: 0,
      kindMatchTop1Rate: 0, kindMatchAnyRate: 0, perKindOverlapAt3: {},
    };
  }
  const sumOA1 = scores.reduce((s, c) => s + c.overlapAt1, 0);
  const sumOA3 = scores.reduce((s, c) => s + c.overlapAt3, 0);
  const km1 = scores.filter(c => c.kindMatchTop1).length;
  const kma = scores.filter(c => c.kindMatchAny).length;

  const byKind = new Map<string, { sum: number; count: number }>();
  for (const c of scores) {
    if (!c.goldKind) continue;
    const k = c.goldKind;
    const cur = byKind.get(k) || { sum: 0, count: 0 };
    cur.sum += c.overlapAt3;
    cur.count += 1;
    byKind.set(k, cur);
  }
  const perKindOverlapAt3: Record<string, { count: number; mean: number }> = {};
  for (const [k, v] of byKind) perKindOverlapAt3[k] = { count: v.count, mean: v.sum / v.count };

  return {
    caseCount: n,
    meanOverlapAt1: sumOA1 / n,
    meanOverlapAt3: sumOA3 / n,
    kindMatchTop1Rate: km1 / n,
    kindMatchAnyRate: kma / n,
    perKindOverlapAt3,
  };
}
