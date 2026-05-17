/**
 * `prompt-guard eval --mode gold|shape-coverage [--budget N]`
 *
 * Runs the corpus-clarify check against a set of test prompts, scores each
 * against gold (when available), and writes results to eval_runs + eval_cases.
 *
 * Modes:
 *  - gold: every manual gold pair's originating prompt → run check → score vs gold
 *  - shape-coverage: 20 hand-curated prompts spanning skip/cross-project/adversarial/DemoSaaS variants
 *  - wide: future, runs over rule+LLM tier (deferred to pause point c)
 *
 * Instrumentation captured per case: vague_verb, has_verb_disambiguation_q,
 * has_live_vs_local_q2, correct_skip (for rejection golds).
 */

import chalk from 'chalk';
import { openDb, DEFAULT_DB_PATH } from '../corpus/db';
import { CorpusReader } from '../corpus/reader';
import { ClaudeQuestionGenerator } from '../corpus/question-gen';
import { scoreCase, aggregate, GoldClarification, KIND_MATCH_FLOOR, CaseScore } from '../corpus/scoring';
import { detectVagueVerb, detectVerbDisambiguationQuestion, detectLiveVsLocalQ2 } from '../eval/detect';
import shapeCoveragePrompts from '../eval/shape-coverage-prompts.json';
import type { ClarifyingQuestion, ClarificationKind } from '../checks/types';

export interface EvalOptions {
  mode: 'gold' | 'shape-coverage';
  dbPath?: string;
  budgetUsd?: number;       // hard cap on spend
  notesSuffix?: string;
}

const CHECK_VERSION = 'corpus-clarify-v3';
const MODEL = 'claude-sonnet-4-6';

interface GoldRow {
  pair_id: number;
  originating_prompt_id: number;
  clarification_kind: string | null;
  clarification_text: string;
  orig_content: string;
  orig_project_id: string;
}

interface RunCase {
  goldPairId: number | null;
  originatingPromptId: number | null;
  prompt: string;
  shape: string | null;
  gold: GoldClarification | null;   // null for shape-coverage prompts (no gold)
  questions: ClarifyingQuestion[];
  retrievedIds: number[];
  latencyMs: number;
  costUsd: number;
  score: CaseScore | null;
  vagueVerb: boolean;
  hasVerbDisamQ: boolean;
  hasLiveVsLocalQ2: boolean;
  correctSkip: boolean | null;
  errorClass?: string;
  errorStatus?: number;
}

function loadGoldCases(db: import('better-sqlite3').Database): GoldRow[] {
  return db.prepare(`
    SELECT cp.pair_id, cp.originating_prompt_id, cp.clarification_kind, cp.clarification_text,
           orig.content AS orig_content, orig.project_id AS orig_project_id
    FROM clarifying_pairs cp
    JOIN prompts orig ON orig.prompt_id = cp.originating_prompt_id
    JOIN projects p ON p.project_id = orig.project_id
    WHERE cp.extraction_method = 'manual'
      AND p.name != 'prompt-guard'
      AND (p.cwd IS NULL OR p.cwd NOT LIKE '%prompt-guard%')
    ORDER BY cp.pair_id
  `).all() as GoldRow[];
}

function fetchGoldClarifications(corpus: CorpusReader, retrievedIds: number[]) {
  if (retrievedIds.length === 0) return [];
  const ids = retrievedIds.join(',');
  return corpus.db.prepare(`
    SELECT cp.clarification_kind AS kind,
           cp.clarification_text AS text,
           orig.content AS past_prompt
    FROM clarifying_pairs cp
    JOIN prompts orig ON orig.prompt_id = cp.originating_prompt_id
    WHERE cp.extraction_method = 'manual'
      AND cp.clarification_kind IS NOT NULL
      AND cp.originating_prompt_id IN (${ids})
    LIMIT 6
  `).all().map((r: any) => ({
    pastPrompt: r.past_prompt,
    pastClarification: r.text,
    kind: r.kind as ClarificationKind,
  }));
}

function estimateCost(inputTokens?: number, cachedInputTokens?: number, outputTokens?: number): number {
  // Per Anthropic API: input_tokens is the FRESH count (already excludes cached).
  // cache_read_input_tokens is the SEPARATE cached count, billed at 10% of input rate.
  const fresh = inputTokens || 0;
  const cached = cachedInputTokens || 0;
  const out = outputTokens || 0;
  return (fresh / 1e6) * 3.0 + (cached / 1e6) * 0.3 + (out / 1e6) * 15.0;
}

async function runOneCase(
  prompt: string,
  gold: GoldClarification | null,
  projectId: string | undefined,
  corpus: CorpusReader,
  gen: ClaudeQuestionGenerator,
  shape: string | null,
  excludePromptId?: number
): Promise<Omit<RunCase, 'goldPairId'>> {
  // Retrieve; exclude originating prompt itself to prevent leakage on gold cases
  const retrievedAll = corpus.retrieve({
    query: prompt,
    projectId,
    limit: 10,
    globalFallback: true,
  });
  const retrieved = excludePromptId
    ? retrievedAll.filter(r => r.promptId !== excludePromptId).slice(0, 8)
    : retrievedAll.slice(0, 8);

  const exampleClarifications = fetchGoldClarifications(corpus, retrieved.map(r => r.promptId));
  const result = await gen.generate({ prompt, retrieved, exampleClarifications });

  const cost = estimateCost(result.inputTokens, result.cachedInputTokens, result.outputTokens);
  const vagueVerb = detectVagueVerb(prompt);
  const hasVerbDisamQ = result.questions.some(q => detectVerbDisambiguationQuestion(q.text));
  const hasLiveVsLocalQ2 = detectLiveVsLocalQ2(result.questions);

  // correct_skip: when gold is a rejection (kind=null), did the system propose 0 questions?
  // For non-rejection golds, this is null (not applicable).
  let correctSkip: boolean | null = null;
  if (gold && gold.clarificationKind === null) {
    correctSkip = result.questions.length === 0;
  }

  const score = gold ? scoreCase(gold, result.questions) : null;

  return {
    originatingPromptId: gold?.originatingPromptId ?? null,
    prompt,
    shape,
    gold,
    questions: result.questions,
    retrievedIds: retrieved.map(r => r.promptId),
    latencyMs: result.latencyMs,
    costUsd: cost,
    score,
    vagueVerb,
    hasVerbDisamQ,
    hasLiveVsLocalQ2,
    correctSkip,
    errorClass: result.errorClass,
    errorStatus: result.errorStatus,
  };
}

export async function runEval(opts: EvalOptions): Promise<void> {
  const dbPath = opts.dbPath || DEFAULT_DB_PATH;
  const db = openDb({ dbPath });
  const corpus = new CorpusReader(dbPath);
  const gen = new ClaudeQuestionGenerator();
  const budgetUsd = opts.budgetUsd ?? 2.0;

  console.log(chalk.bold(`\nEval run — mode=${opts.mode}`));
  console.log(chalk.gray(`  Budget cap:   $${budgetUsd.toFixed(2)}`));
  console.log(chalk.gray(`  Check ver:    ${CHECK_VERSION}`));
  console.log(chalk.gray(`  Model:        ${MODEL}`));
  console.log(chalk.gray(`  KIND_MATCH_FLOOR: ${KIND_MATCH_FLOOR}`));
  console.log('');

  // Insert eval_runs row (will UPDATE at end with finished_at and aggregates)
  const startedAt = new Date().toISOString();
  const notes = `KIND_MATCH_FLOOR=${KIND_MATCH_FLOOR} | retrieval=BM25(FTS5) | adapter=ClaudeQuestionGenerator | ${opts.notesSuffix || ''}`;
  const runInsert = db.prepare(`
    INSERT INTO eval_runs (started_at, check_version, question_gen_model, retrieval_method, retrieval_k, mode, notes)
    VALUES (?, ?, ?, 'bm25', 8, ?, ?)
  `).run(startedAt, CHECK_VERSION, MODEL, opts.mode, notes);
  const runId = runInsert.lastInsertRowid as number;

  // Build the case list
  const cases: RunCase[] = [];
  let totalCost = 0;

  if (opts.mode === 'gold') {
    const golds = loadGoldCases(db);
    console.log(`Processing ${golds.length} gold pairs...`);
    for (let i = 0; i < golds.length; i++) {
      const g = golds[i];
      const gold: GoldClarification = {
        pairId: g.pair_id,
        originatingPromptId: g.originating_prompt_id,
        clarificationKind: g.clarification_kind,
        clarificationText: g.clarification_text,
      };
      try {
        const c = await runOneCase(g.orig_content, gold, g.orig_project_id, corpus, gen, null, g.originating_prompt_id);
        const fullCase: RunCase = { goldPairId: g.pair_id, ...c };
        cases.push(fullCase);
        totalCost += c.costUsd;
        process.stdout.write(`\r  [${i + 1}/${golds.length}] $${totalCost.toFixed(3)} spent · last latency ${c.latencyMs}ms     `);
        if (totalCost > budgetUsd) {
          console.log(`\n  ${chalk.red('Budget exceeded — stopping')}`);
          break;
        }
      } catch (e) {
        console.log(`\n  ${chalk.red('ERROR on pair_id=' + g.pair_id + ': ' + (e instanceof Error ? e.message : e))}`);
      }
    }
    process.stdout.write('\n');
  } else if (opts.mode === 'shape-coverage') {
    const promptList = (shapeCoveragePrompts as { prompts: Array<{ shape: string; text: string }> }).prompts;
    console.log(`Processing ${promptList.length} shape-coverage prompts...`);
    for (let i = 0; i < promptList.length; i++) {
      const p = promptList[i];
      try {
        const c = await runOneCase(p.text, null, undefined, corpus, gen, p.shape);
        const fullCase: RunCase = { goldPairId: null, ...c };
        cases.push(fullCase);
        totalCost += c.costUsd;
        process.stdout.write(`\r  [${i + 1}/${promptList.length}] $${totalCost.toFixed(3)} spent     `);
        if (totalCost > budgetUsd) {
          console.log(`\n  ${chalk.red('Budget exceeded — stopping')}`);
          break;
        }
      } catch (e) {
        console.log(`\n  ${chalk.red('ERROR: ' + (e instanceof Error ? e.message : e))}`);
      }
    }
    process.stdout.write('\n');
  }

  // Write eval_cases rows
  const insertCase = db.prepare(`
    INSERT INTO eval_cases (
      run_id, originating_prompt_id, gold_pair_id, shape, synthetic_prompt,
      proposed_questions_json, gold_clarifications_json,
      overlap_at_1, overlap_at_3, matched_kinds,
      retrieved_session_ids, latency_ms, cost_usd,
      is_in_gold_subset,
      vague_verb, has_verb_disambiguation_q, has_live_vs_local_q2, correct_skip
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const c of cases) {
    insertCase.run(
      runId,
      c.originatingPromptId,
      c.goldPairId,
      c.shape,
      c.originatingPromptId === null ? c.prompt : null,  // store synthetic prompt text when not from corpus
      JSON.stringify(c.questions),
      c.gold ? JSON.stringify(c.gold) : '[]',
      c.score?.overlapAt1 ?? null,
      c.score?.overlapAt3 ?? null,
      c.score ? JSON.stringify(c.score.perQuestionScores.map(s => s.kind)) : null,
      JSON.stringify(c.retrievedIds),
      c.latencyMs,
      c.costUsd,
      c.gold ? 1 : 0,
      c.vagueVerb ? 1 : 0,
      c.hasVerbDisamQ ? 1 : 0,
      c.hasLiveVsLocalQ2 ? 1 : 0,
      c.correctSkip === null ? null : (c.correctSkip ? 1 : 0)
    );
  }

  // Aggregate scored cases
  const scoredCases = cases.filter(c => c.score !== null).map(c => c.score!);
  const agg = aggregate(scoredCases);

  // Update eval_runs row with aggregates
  db.prepare(`
    UPDATE eval_runs SET
      finished_at = ?,
      case_count = ?,
      overlap_at_1 = ?,
      overlap_at_3 = ?,
      kind_match_rate = ?,
      total_cost_usd = ?
    WHERE run_id = ?
  `).run(
    new Date().toISOString(),
    cases.length,
    agg.meanOverlapAt1,
    agg.meanOverlapAt3,
    agg.kindMatchAnyRate,
    totalCost,
    runId
  );

  // Print summary
  console.log('');
  console.log(chalk.bold('=== Run summary ==='));
  console.log(`  run_id:           ${runId}`);
  console.log(`  cases run:        ${cases.length}`);
  console.log(`  scored (acc):     ${scoredCases.length}`);
  console.log(`  rejection golds:  ${cases.filter(c => c.gold && c.gold.clarificationKind === null).length}`);
  console.log(`  mean overlap@1:   ${agg.meanOverlapAt1.toFixed(4)}`);
  console.log(`  mean overlap@3:   ${agg.meanOverlapAt3.toFixed(4)}`);
  console.log(`  kind-match@1:     ${(scoredCases.filter(c => c.kindMatchTop1).length / Math.max(1, scoredCases.length) * 100).toFixed(1)}%`);
  console.log(`  kind-match@any:   ${(agg.kindMatchAnyRate * 100).toFixed(1)}%`);
  console.log(`  total cost:       $${totalCost.toFixed(4)}`);

  // Per-kind slice
  console.log('');
  console.log(chalk.bold('  Per-kind overlap@3 (gold cases):'));
  for (const [k, v] of Object.entries(agg.perKindOverlapAt3)) {
    console.log(`    ${k.padEnd(20)} n=${v.count}  mean=${v.mean.toFixed(4)}`);
  }

  // Instrumentation rollups
  console.log('');
  console.log(chalk.bold('  Instrumentation:'));
  const vvTotal = cases.filter(c => c.vagueVerb).length;
  const vvWithDisam = cases.filter(c => c.vagueVerb && c.hasVerbDisamQ).length;
  console.log(`    vague-verb prompts: ${vvTotal}  (with verb-disam Q: ${vvWithDisam}/${vvTotal})`);
  const liveLocalQ2 = cases.filter(c => c.hasLiveVsLocalQ2).length;
  console.log(`    live-vs-local Q2 fired in: ${liveLocalQ2}/${cases.length} cases`);
  const rejectionGolds = cases.filter(c => c.gold && c.gold.clarificationKind === null);
  if (rejectionGolds.length > 0) {
    const correctSkips = rejectionGolds.filter(c => c.correctSkip).length;
    console.log(`    correct_skip:       ${correctSkips}/${rejectionGolds.length} rejection golds`);
  }

  // 3 worst-scoring cases (where the signal lives)
  if (scoredCases.length > 0) {
    console.log('');
    console.log(chalk.bold('=== 3 worst-scoring cases (gold only) ==='));
    const worst = cases
      .filter(c => c.score !== null && c.gold && c.gold.clarificationKind !== null)
      .sort((a, b) => (a.score!.overlapAt3) - (b.score!.overlapAt3))
      .slice(0, 3);
    for (let i = 0; i < worst.length; i++) {
      const c = worst[i];
      console.log('');
      console.log(chalk.bold.red(`#${i+1} — pair_id=${c.goldPairId} · overlap@3=${c.score!.overlapAt3.toFixed(4)}`));
      console.log(chalk.gray('  GOLD kind: ' + c.gold!.clarificationKind));
      console.log(chalk.gray('  GOLD text: "' + c.gold!.clarificationText.replace(/\s+/g,' ').slice(0, 200) + '"'));
      console.log(chalk.gray('  ORIG prompt: "' + c.prompt.replace(/\s+/g,' ').slice(0, 200) + '"'));
      console.log('  Questions emitted (' + c.questions.length + '):');
      c.questions.forEach((q, j) => {
        console.log(`    Q${j+1} [${q.kind}, conf=${q.confidence.toFixed(2)}]`);
        console.log(`      "${q.text.slice(0, 250)}${q.text.length > 250 ? '…' : ''}"`);
      });
      console.log(chalk.gray('  Per-question scores: ' + JSON.stringify(c.score!.perQuestionScores.map(s => ({i:s.index, k:s.kindMatch, t:s.tokenOverlap.toFixed(2), c:s.combined.toFixed(2)})))));
    }
  }

  corpus.close();
  db.close();
}
