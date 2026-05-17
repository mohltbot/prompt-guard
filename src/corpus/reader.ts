/**
 * CorpusReader — BM25 retrieval over the prompts_fts index.
 *
 * Project-scoped retrieval with optional global fallback. Returns past USER
 * prompts ranked by relevance to the query, with session and project metadata
 * for downstream question generation.
 *
 * MVP-3 retrieval is BM25-only (no embeddings) per the Q2 decision. Embeddings
 * land in v1 if backtesting shows retrieval is the bottleneck.
 */

import Database from 'better-sqlite3';
import { openDb, DEFAULT_DB_PATH } from './db';
import { normalize } from './parsers/shared';

export interface RetrievedPrompt {
  promptId: number;
  sessionId: string;
  sessionTitle: string | null;
  projectId: string | null;
  projectName: string | null;
  turnIndex: number;
  content: string;
  timestamp: string;
  rank: number;             // BM25 score; lower = more relevant
  hasClarification: boolean; // true if this prompt has a manual gold clarification (high-value retrieval)
}

export interface RetrieveOptions {
  query: string;
  projectId?: string;
  limit?: number;            // default 12
  globalFallback?: boolean;  // default true — falls back to global if project has < limit/2 matches
  excludeSyntheticPrompts?: boolean;  // default true — skip prompts that look like harness output
  excludePromptIds?: number[];        // skip these prompt IDs (eval uses this to prevent leakage)
}

const SELF_REF_NAME = 'prompt-guard';

/**
 * Retrieval-time synthetic-prompt detector. Mirrors `isSyntheticPrompt` from
 * the labeler — filters session-resume preambles, harness messages, shell
 * paste-backs, and other harness-emitted content that pollutes BM25 results.
 *
 * Kept separate from the labeler version (which is private) so retrieval can
 * tune its own thresholds. The patterns themselves are the same.
 */
function isSyntheticForRetrieval(content: string): boolean {
  if (!content) return true;
  const t = content.trim();
  if (t.length < 20) return true;
  // Session-resume preambles — the dominant retrieval-noise pattern
  if (t.startsWith('This session is being continued from a previous')) return true;
  // Harness skill-load / context-init
  if (t.startsWith('Base directory for this skill:')) return true;
  if (t.startsWith('<scheduled-task')) return true;
  if (t.startsWith('Note from skill:')) return true;
  if (t.startsWith('Caveat:') && t.length < 200) return true;
  // Shell paste-backs
  if (t.startsWith('Last login:')) return true;
  if (/^main@\S+\s/.test(t)) return true;
  if (/^root@\S+:/.test(t)) return true;
  // Tool/report paste-backs ("Here's the smoke test report:", "Re-test report:")
  const firstSlice = t.slice(0, 120);
  if (/(?:smoke[\s\-]?test|audit|re[\s\-]?test|test)\s+report\b/i.test(firstSlice) &&
      /^(?:Here's|here is|attached|see|results?|the\s)/i.test(firstSlice)) return true;
  // Compiled-content paste-backs ("Here's the list of X I've been compiling...")
  if (/^Here's\s+(?:the|a|my|some)?\s*(?:list|tips?|summary|recap|notes?|update|breakdown|guide|stuff|things)\b/i.test(t)) return true;
  // Narrative session-opener context dumps (not action-shaped clarification material)
  if (/^The goal with\s/i.test(t)) return true;
  if (/^I'm thinking\b/i.test(t)) return true;
  if (/^I want to understand\b/i.test(t)) return true;
  // Low alphabetic-character density (likely log / JSON / shell output)
  const alphaRatio = (t.match(/[a-zA-Z]/g) || []).length / t.length;
  if (alphaRatio < 0.5 && t.length > 80) return true;
  return false;
}

export class CorpusReader {
  readonly db: Database.Database;

  constructor(dbPath?: string) {
    this.db = openDb({ dbPath: dbPath || DEFAULT_DB_PATH, readonly: true });
  }

  isOpen(): boolean { return !!this.db; }

  /**
   * Retrieve past user prompts most relevant to `query`.
   * Project-scoped if `projectId` provided; otherwise global.
   */
  retrieve(opts: RetrieveOptions): RetrievedPrompt[] {
    const limit = opts.limit ?? 12;
    const globalFallback = opts.globalFallback ?? true;
    const ftsQuery = this.prepareFtsQuery(opts.query);
    if (!ftsQuery) return [];

    if (opts.projectId) {
      const projectResults = this.queryFts(ftsQuery, opts.projectId, limit);
      const enoughResults = projectResults.length >= Math.ceil(limit / 2);
      if (enoughResults || !globalFallback) return projectResults;

      // Pad with global, dedupe by prompt_id
      const seen = new Set(projectResults.map(r => r.promptId));
      const remaining = limit - projectResults.length;
      const globalCandidates = this.queryFts(ftsQuery, undefined, remaining * 3);
      const globalFiltered = globalCandidates.filter(r => !seen.has(r.promptId)).slice(0, remaining);
      return [...projectResults, ...globalFiltered];
    }

    return this.queryFts(ftsQuery, undefined, limit);
  }

  private queryFts(ftsQuery: string, projectId: string | undefined, limit: number): RetrievedPrompt[] {
    // Over-retrieve, then filter out synthetic prompts in app code (session-resume
    // preambles, harness messages, paste-backs). The FTS trigger gates on role+
    // eligibility but not on synthetic-content patterns, so we filter here. v0.5
    // could push this into the trigger or add an `is_synthetic` column for cleaner
    // indexing.
    const overRetrieve = limit * 4;

    const params: (string | number)[] = projectId
      ? [ftsQuery, projectId, SELF_REF_NAME, overRetrieve]
      : [ftsQuery, SELF_REF_NAME, overRetrieve];

    const sql = `
      SELECT
        prompts_fts.prompt_id        AS promptId,
        prompts_fts.session_id       AS sessionId,
        bm25(prompts_fts)            AS rank,
        prompts.content              AS content,
        prompts.turn_index           AS turnIndex,
        prompts.timestamp            AS timestamp,
        projects.project_id          AS projectId,
        projects.name                AS projectName,
        sessions.title               AS sessionTitle,
        CASE WHEN EXISTS (
          SELECT 1 FROM clarifying_pairs cp
          WHERE cp.originating_prompt_id = prompts.prompt_id
            AND cp.extraction_method = 'manual'
        ) THEN 1 ELSE 0 END AS hasClarificationFlag
      FROM prompts_fts
      JOIN prompts ON prompts.prompt_id = prompts_fts.prompt_id
      JOIN sessions ON sessions.session_id = prompts.session_id
      LEFT JOIN projects ON projects.project_id = prompts.project_id
      WHERE prompts_fts MATCH ?
        ${projectId ? 'AND prompts_fts.project_id = ?' : ''}
        AND projects.name != ?
        AND (projects.cwd IS NULL OR projects.cwd NOT LIKE '%prompt-guard%')
      ORDER BY rank ASC
      LIMIT ?
    `;

    type RawRow = Omit<RetrievedPrompt, 'hasClarification'> & { hasClarificationFlag: number };
    const rows = this.db.prepare(sql).all(...params) as RawRow[];

    const filtered: RetrievedPrompt[] = [];
    for (const r of rows) {
      if (isSyntheticForRetrieval(r.content)) continue;
      filtered.push({
        promptId: r.promptId,
        sessionId: r.sessionId,
        sessionTitle: r.sessionTitle,
        projectId: r.projectId,
        projectName: r.projectName,
        turnIndex: r.turnIndex,
        content: r.content,
        timestamp: r.timestamp,
        rank: r.rank,
        hasClarification: r.hasClarificationFlag === 1,
      });
      if (filtered.length >= limit) break;
    }
    return filtered;
  }

  /**
   * Convert a natural-language query to an FTS5 query expression.
   * Strategy: extract content terms (3+ chars), drop stopwords, OR-combine.
   * Falls back to a simple AND if too few terms.
   */
  private prepareFtsQuery(text: string): string {
    const stop = new Set([
      'the', 'and', 'for', 'are', 'but', 'not', 'can', 'has', 'had', 'how',
      'was', 'this', 'that', 'with', 'have', 'will', 'your', 'from', 'they',
      'been', 'were', 'into', 'over', 'just', 'like', 'when', 'make', 'some',
      'than', 'them', 'what', 'their', 'about', 'should', 'could', 'would',
    ]);
    const terms = new Set<string>();
    for (const w of normalize(text).split(/[^a-z0-9]+/)) {
      if (w.length < 3 || stop.has(w)) continue;
      terms.add(w.replace(/"/g, ''));
    }
    if (terms.size === 0) return '';
    // Quote each term to handle FTS5 special chars; OR-combine for broad recall
    return Array.from(terms).map(t => `"${t}"`).join(' OR ');
  }

  /**
   * Project lookup by cwd basename — used to resolve current cwd to a project_id.
   */
  findProjectByCwdBasename(basename: string): string | undefined {
    const row = this.db.prepare(`
      SELECT project_id FROM projects
      WHERE name = ? OR cwd LIKE ?
      ORDER BY explicit DESC, last_seen_at DESC
      LIMIT 1
    `).get(basename, `%/${basename}`) as { project_id: string } | undefined;
    return row?.project_id;
  }

  close(): void {
    this.db.close();
  }
}
