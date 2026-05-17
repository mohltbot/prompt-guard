/**
 * `prompt-guard label-llm [--dry-run] [--limit N] [--per-project N]`
 *
 * Reads rule-extracted clarifying pairs and runs the LLM extractor over them.
 * In --dry-run mode, prints verdicts to stdout and writes nothing to the DB.
 * In normal mode, writes verdicts as `extraction_method='llm'` rows.
 */

import chalk from 'chalk';
import { openDb, DEFAULT_DB_PATH } from '../corpus/db';
import {
  ClaudeClarificationExtractor,
  ClarificationExtractor,
  estimateCost,
  LlmVerdict,
} from '../corpus/llm-extractor';

export interface LabelLlmOptions {
  dryRun?: boolean;
  limit?: number;
  perProject?: number;     // if set, sample N per top-K projects
  topProjects?: number;    // only used with perProject
  concurrency?: number;    // parallel workers; default 1
  retryMissing?: boolean;  // skip pairs whose originating_prompt_id already has an LLM verdict
  dbPath?: string;
  extractor?: ClarificationExtractor;
}

const LABELER_VERSION = 'llm-v0';

interface PairRow {
  pair_id: number;
  originating_prompt_id: number;
  clarifying_prompt_id: number;
  session_id: string;
  project_id: string;
  project_name: string | null;
  clarification_kind: string;
  clarification_text: string;
  orig_content: string;
  clar_content: string;
  orig_turn: number;
  clar_turn: number;
}

function loadPairs(db: import('better-sqlite3').Database, opts: LabelLlmOptions): PairRow[] {
  // Strategy: per-project balanced sample (if opts.perProject), else flat random.
  if (opts.perProject) {
    const topProjects = opts.topProjects ?? 2;
    const projects = db.prepare(`
      SELECT p.project_id, p.name
      FROM clarifying_pairs cp
      JOIN prompts pr ON pr.prompt_id = cp.originating_prompt_id
      JOIN projects p ON p.project_id = pr.project_id
      WHERE cp.extraction_method = 'rule'
      GROUP BY p.project_id
      ORDER BY COUNT(*) DESC
      LIMIT ?
    `).all(topProjects) as { project_id: string; name: string | null }[];

    const out: PairRow[] = [];
    for (const proj of projects) {
      const rows = db.prepare(`
        SELECT
          cp.pair_id, cp.originating_prompt_id, cp.clarifying_prompt_id,
          cp.session_id, cp.clarification_kind, cp.clarification_text,
          orig.content AS orig_content, orig.turn_index AS orig_turn,
          clar.content AS clar_content, clar.turn_index AS clar_turn,
          pr.project_id, p.name AS project_name
        FROM clarifying_pairs cp
        JOIN prompts orig ON orig.prompt_id = cp.originating_prompt_id
        JOIN prompts clar ON clar.prompt_id = cp.clarifying_prompt_id
        JOIN prompts pr ON pr.prompt_id = cp.originating_prompt_id
        JOIN projects p ON p.project_id = pr.project_id
        WHERE cp.extraction_method = 'rule' AND pr.project_id = ?
        ORDER BY RANDOM()
        LIMIT ?
      `).all(proj.project_id, opts.perProject) as PairRow[];
      out.push(...rows);
    }
    return out;
  }

  const limit = opts.limit ?? 1_000_000;
  const retryClause = opts.retryMissing
    ? `AND NOT EXISTS (
         SELECT 1 FROM clarifying_pairs cp2
         WHERE cp2.extraction_method = 'llm'
           AND cp2.originating_prompt_id = cp.originating_prompt_id
       )`
    : '';
  return db.prepare(`
    SELECT
      cp.pair_id, cp.originating_prompt_id, cp.clarifying_prompt_id,
      cp.session_id, cp.clarification_kind, cp.clarification_text,
      orig.content AS orig_content, orig.turn_index AS orig_turn,
      clar.content AS clar_content, clar.turn_index AS clar_turn,
      pr.project_id, p.name AS project_name
    FROM clarifying_pairs cp
    JOIN prompts orig ON orig.prompt_id = cp.originating_prompt_id
    JOIN prompts clar ON clar.prompt_id = cp.clarifying_prompt_id
    JOIN prompts pr ON pr.prompt_id = cp.originating_prompt_id
    JOIN projects p ON p.project_id = pr.project_id
    WHERE cp.extraction_method = 'rule' ${retryClause}
    ORDER BY cp.pair_id
    LIMIT ?
  `).all(limit) as PairRow[];
}

function shorten(s: string, n = 180): string {
  const cleaned = s.replace(/\s+/g, ' ').trim();
  return cleaned.length <= n ? cleaned : cleaned.slice(0, n) + '…';
}

function formatVerdict(pair: PairRow, verdict: LlmVerdict, idx: number, totalIdx: number): string {
  const lines: string[] = [];
  const projLabel = pair.project_name || pair.project_id.slice(0, 10);

  lines.push(chalk.bold(`[${idx + 1}/${totalIdx}] ${projLabel.toUpperCase()} — pair_id ${pair.pair_id}, turns ${pair.orig_turn}→${pair.clar_turn}`));
  lines.push(chalk.gray(`  ORIG : "${shorten(pair.orig_content)}"`));
  lines.push(chalk.gray(`  CLAR : "${shorten(pair.clar_content)}"`));
  lines.push(chalk.gray(`  RULE : kind=${pair.clarification_kind}, extracted="${shorten(pair.clarification_text, 120)}"`));

  if (verdict.isRealClarification) {
    const sameKind = verdict.kind === pair.clarification_kind;
    const verdictLine = sameKind
      ? chalk.green('  LLM  : ✓ ACCEPT')
      : chalk.yellow('  LLM  : ✓ ACCEPT (kind refined)');
    lines.push(verdictLine);
    lines.push(`         kind:       ${verdict.kind}${sameKind ? chalk.gray(' (matches rule)') : chalk.yellow(` (refined from ${pair.clarification_kind})`)}`);
    lines.push(`         refined:    ${chalk.cyan('"' + (verdict.refinedText || '') + '"')}`);
    lines.push(`         confidence: ${verdict.confidence?.toFixed(2) ?? '-'}`);
  } else {
    lines.push(chalk.red('  LLM  : ✗ REJECT'));
  }
  lines.push(chalk.gray(`         reason:     ${verdict.reason}`));
  lines.push(chalk.gray(`         latency:    ${verdict.latencyMs}ms${verdict.cachedInputTokens ? `, ${verdict.cachedInputTokens} cached input tokens` : ''}`));

  return lines.join('\n');
}

export async function runLabelLlm(opts: LabelLlmOptions = {}): Promise<void> {
  const dbPath = opts.dbPath || DEFAULT_DB_PATH;
  const db = openDb({ dbPath, readonly: !!opts.dryRun });
  const extractor: ClarificationExtractor = opts.extractor || new ClaudeClarificationExtractor();
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  const verbose = opts.perProject !== undefined || pairs_should_be_verbose(opts);

  console.log(chalk.bold('\nPrompt Guard — LLM clarification extractor'));
  console.log(chalk.gray(`  Model:        ${extractor.name}`));
  console.log(chalk.gray(`  Mode:         ${opts.dryRun ? 'DRY-RUN (no DB writes)' : 'WRITE (extraction_method=\'llm\')'}`));
  console.log(chalk.gray(`  Concurrency:  ${concurrency}`));
  console.log(chalk.gray(`  DB:           ${dbPath}`));

  // Idempotency: wipe existing LLM rows before a full re-run.
  // Skip this when --retry-missing — we want to keep already-good verdicts.
  if (!opts.dryRun && !opts.retryMissing) {
    db.prepare(`DELETE FROM clarifying_pairs WHERE extraction_method = 'llm' AND extractor_version = ?`)
      .run(LABELER_VERSION);
  }

  const pairs = loadPairs(db, opts);
  console.log(chalk.gray(`  Pairs to process: ${pairs.length}`));
  console.log('');

  if (pairs.length === 0) {
    console.log(chalk.yellow('No rule-extracted pairs to process.'));
    db.close();
    return;
  }

  const insertLlmRow = opts.dryRun ? null : db.prepare(`
    INSERT INTO clarifying_pairs (
      originating_prompt_id, clarifying_prompt_id, session_id,
      clarification_text, clarification_kind,
      extraction_method, extractor_version, confidence,
      extracted_at, is_in_gold_subset, reason
    ) VALUES (?, ?, ?, ?, ?, 'llm', ?, ?, ?, 0, ?)
  `);

  const insertFailedRow = opts.dryRun ? null : db.prepare(`
    INSERT INTO failed_extraction_pairs (
      pair_id, extractor_version, error_class, error_status, error_message, attempted_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  const counts = { accepted: 0, rejected: 0, kindRefined: 0, apiErrors: 0 };
  const errorBreakdown = new Map<string, number>();
  let totalCost = 0;
  let totalLatency = 0;
  let completed = 0;
  const startedAt = Date.now();

  const onComplete = (pair: PairRow, verdict: LlmVerdict): void => {
    completed += 1;
    totalLatency += verdict.latencyMs;
    totalCost += estimateCost(verdict);  // estimateCost itself is now fixed in llm-extractor.ts

    const isApiErr =
      verdict.reason.startsWith('LLM API error') || verdict.reason.startsWith('LLM did not');
    if (isApiErr) {
      counts.apiErrors += 1;
      const tag = `${verdict.errorClass || 'Unknown'}${verdict.errorStatus !== undefined ? `(${verdict.errorStatus})` : ''}`;
      errorBreakdown.set(tag, (errorBreakdown.get(tag) || 0) + 1);
    }
    else if (verdict.isRealClarification) {
      counts.accepted += 1;
      if (verdict.kind && verdict.kind !== pair.clarification_kind) counts.kindRefined += 1;
    } else counts.rejected += 1;

    if (verbose) {
      console.log(formatVerdict(pair, verdict, completed - 1, pairs.length));
      console.log('');
    } else {
      const status = isApiErr ? chalk.red('✗ ERROR ')
        : verdict.isRealClarification
          ? (verdict.kind && verdict.kind !== pair.clarification_kind
              ? chalk.yellow('✓ REFINED')
              : chalk.green('✓ ACCEPT '))
          : chalk.red('✗ REJECT ');
      const kindOrErr = isApiErr
        ? `${verdict.errorClass || '?'}${verdict.errorStatus !== undefined ? `(${verdict.errorStatus})` : ''}`.padEnd(28)
        : (verdict.kind || pair.clarification_kind).padEnd(16);
      const conf = verdict.confidence !== undefined ? verdict.confidence.toFixed(2) : ' -  ';
      console.log(
        `[${String(completed).padStart(3)}/${pairs.length}] ${status} ${kindOrErr} conf=${conf} ${verdict.latencyMs}ms`
      );
    }

    // Stream error details to stderr so they survive even if stdout is summarized
    if (isApiErr && verdict.errorMessage) {
      process.stderr.write(`    [err pair_id=${pair.pair_id}] ${verdict.errorClass}${verdict.errorStatus !== undefined ? `(${verdict.errorStatus})` : ''}: ${verdict.errorMessage.slice(0, 200)}\n`);
    }

    if (insertLlmRow && verdict.isRealClarification && verdict.kind && verdict.refinedText) {
      insertLlmRow.run(
        pair.originating_prompt_id,
        pair.clarifying_prompt_id,
        pair.session_id,
        verdict.refinedText,
        verdict.kind,
        LABELER_VERSION,
        verdict.confidence ?? 0.7,
        new Date().toISOString(),
        verdict.reason
      );
    }

    // Persist failed pairs so future --retry-missing can locate them without
    // re-querying upstream tables. One row per (pair_id, attempt).
    if (insertFailedRow && isApiErr) {
      insertFailedRow.run(
        pair.pair_id,
        LABELER_VERSION,
        verdict.errorClass ?? null,
        verdict.errorStatus ?? null,
        verdict.errorMessage ?? verdict.reason,
        new Date().toISOString()
      );
    }
  };

  // Concurrency pool — N workers pull from a shared index
  let nextIdx = 0;
  async function worker(): Promise<void> {
    while (true) {
      const idx = nextIdx++;
      if (idx >= pairs.length) return;
      const pair = pairs[idx];
      const verdict = await extractor.extract({
        origContent: pair.orig_content,
        clarContent: pair.clar_content,
        ruleKind: pair.clarification_kind,
        ruleText: pair.clarification_text,
      });
      onComplete(pair, verdict);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const wallSec = (Date.now() - startedAt) / 1000;

  // Summary
  console.log('');
  console.log(chalk.bold('=== Summary ==='));
  console.log(`  Total pairs:        ${pairs.length}`);
  console.log(`  LLM accepted:       ${chalk.green(counts.accepted)}` +
              (counts.kindRefined ? `   (${chalk.yellow(counts.kindRefined)} with kind refined)` : ''));
  console.log(`  LLM rejected:       ${chalk.red(counts.rejected)}`);
  if (counts.apiErrors) {
    console.log(`  API errors:         ${chalk.red(counts.apiErrors)}`);
    // Group errors by class+status so root cause is visible at a glance
    if (errorBreakdown.size > 0) {
      console.log('  Error breakdown:');
      const entries = Array.from(errorBreakdown.entries()).sort((a, b) => b[1] - a[1]);
      for (const [tag, n] of entries) console.log(`    ${tag.padEnd(30)} ${n}`);
    }
  }
  console.log(`  Total cost:         $${totalCost.toFixed(4)}`);
  console.log(`  Avg latency:        ${(totalLatency / pairs.length).toFixed(0)}ms/call`);
  console.log(`  Wall time:          ${wallSec.toFixed(1)}s  (throughput: ${(pairs.length / wallSec).toFixed(2)} pairs/s)`);
  console.log('');

  if (opts.dryRun) {
    console.log(chalk.gray('Dry-run only — no DB writes. Re-run without --dry-run to persist verdicts.'));
  } else {
    console.log(chalk.gray('Verdicts written as extraction_method=\'llm\' rows.'));
    console.log(chalk.gray('high_confidence_clarifications view auto-joins matching rule+llm rows on kind.'));
  }

  db.close();
}

// Dry-run / per-project flow shows full verdict cards. Full unfiltered runs
// would spam the terminal with 279 multi-line outputs, so we shrink to a
// one-liner per pair.
function pairs_should_be_verbose(opts: LabelLlmOptions): boolean {
  if (opts.dryRun) return true;
  if (opts.limit !== undefined && opts.limit <= 20) return true;
  return false;
}
