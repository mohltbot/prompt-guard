/**
 * Labeler — derives session_outcomes + clarifying_pairs from the ingested corpus.
 * Two passes, both re-runnable without re-parsing the JSONL.
 */

import Database from 'better-sqlite3';

export const LABELER_VERSION = 'v0';
const TRASH_OVERLAP_THRESHOLD = 0.5;

export interface LabelerStats {
  outcomesAccepted: number;
  outcomesIterated: number;
  outcomesRejected: number;
  outcomesUnknown: number;
  pairsInserted: number;
}

export function newLabelerStats(): LabelerStats {
  return {
    outcomesAccepted: 0,
    outcomesIterated: 0,
    outcomesRejected: 0,
    outcomesUnknown: 0,
    pairsInserted: 0,
  };
}

// ============================================================
// Pass A — session outcomes
// ============================================================

interface SessionRow {
  session_id: string;
  project_id: string;
  ended_at: string | null;
  started_at: string;
  is_eligible_for_corpus: number;
  has_snapshot: number;
}

interface SnapshotHashes {
  snapshot_id: number;
  session_id: string | null;
  snapshot_type: string;
  project_id: string;
  hashes: Set<string>;
}

function loadSnapshotHashes(db: Database.Database): SnapshotHashes[] {
  const rows = db.prepare(`
    SELECT cs.snapshot_id, cs.session_id, cs.snapshot_type, cs.project_id, cf.content_hash
    FROM code_snapshots cs
    JOIN code_files cf ON cf.snapshot_id = cs.snapshot_id
    ORDER BY cs.snapshot_id
  `).all() as { snapshot_id: number; session_id: string | null; snapshot_type: string; project_id: string; content_hash: string }[];

  const map = new Map<number, SnapshotHashes>();
  for (const r of rows) {
    let entry = map.get(r.snapshot_id);
    if (!entry) {
      entry = {
        snapshot_id: r.snapshot_id,
        session_id: r.session_id,
        snapshot_type: r.snapshot_type,
        project_id: r.project_id,
        hashes: new Set(),
      };
      map.set(r.snapshot_id, entry);
    }
    entry.hashes.add(r.content_hash);
  }
  return Array.from(map.values());
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  const smaller = a.size < b.size ? a : b;
  const larger = a.size < b.size ? b : a;
  for (const h of smaller) if (larger.has(h)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function runOutcomeLabeler(db: Database.Database, stats: LabelerStats): void {
  const snapshots = loadSnapshotHashes(db);
  const trashSnapshots = snapshots.filter(s => s.snapshot_type === 'trash-snapshot');
  const sessionSnapshots = new Map<string, SnapshotHashes>();
  for (const s of snapshots) {
    if (s.session_id && s.snapshot_type === 'cowork-outputs') {
      sessionSnapshots.set(s.session_id, s);
    }
  }

  // Get all sessions with their latest-per-project status
  const sessions = db.prepare(`
    SELECT s.session_id, s.project_id, s.started_at, s.ended_at,
           CASE WHEN cs.snapshot_id IS NOT NULL THEN 1 ELSE 0 END AS has_snapshot
    FROM sessions s
    LEFT JOIN code_snapshots cs ON cs.session_id = s.session_id AND cs.snapshot_type = 'cowork-outputs'
    WHERE s.is_eligible_for_corpus = 1
    ORDER BY s.project_id, s.started_at
  `).all() as SessionRow[];

  // Group by project, find latest by ended_at
  const byProject = new Map<string, SessionRow[]>();
  for (const s of sessions) {
    if (!byProject.has(s.project_id)) byProject.set(s.project_id, []);
    byProject.get(s.project_id)!.push(s);
  }

  const insertOutcome = db.prepare(`
    INSERT INTO session_outcomes (
      session_id, outcome, is_in_trash, has_successor, successor_session_id,
      turn_count, labeler_version, labeled_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      outcome = excluded.outcome,
      is_in_trash = excluded.is_in_trash,
      has_successor = excluded.has_successor,
      successor_session_id = excluded.successor_session_id,
      labeler_version = excluded.labeler_version,
      labeled_at = excluded.labeled_at
  `);

  const updateTrashProject = db.prepare(`
    UPDATE code_snapshots SET project_id = ? WHERE snapshot_id = ?
  `);

  const turnCountStmt = db.prepare(`SELECT COUNT(*) AS c FROM prompts WHERE session_id = ? AND role = 'user'`);
  const now = new Date().toISOString();

  // Track trash → project remapping (best-match wins)
  const trashRemaps = new Map<number, { projectId: string; jaccard: number }>();

  const tx = db.transaction(() => {
    for (const [, sess] of byProject) {
      // Sort by ended_at (fallback to started_at)
      const sorted = [...sess].sort((a, b) => {
        const aEnd = a.ended_at || a.started_at;
        const bEnd = b.ended_at || b.started_at;
        return aEnd.localeCompare(bEnd);
      });

      const latestId = sorted[sorted.length - 1].session_id;

      for (let i = 0; i < sorted.length; i++) {
        const s = sorted[i];
        const turnCount = (turnCountStmt.get(s.session_id) as { c: number }).c;
        let outcome: 'accepted' | 'rejected' | 'iterated' | 'unknown' = 'unknown';
        let isInTrash = 0;
        let hasSuccessor = i < sorted.length - 1 ? 1 : 0;
        const successorId = i < sorted.length - 1 ? sorted[i + 1].session_id : null;

        const sessSnap = sessionSnapshots.get(s.session_id);

        // Check trash overlap first; record best match for project remap.
        if (sessSnap) {
          for (const trash of trashSnapshots) {
            const j = jaccard(sessSnap.hashes, trash.hashes);
            if (j >= TRASH_OVERLAP_THRESHOLD) {
              outcome = 'rejected';
              isInTrash = 1;
              const prior = trashRemaps.get(trash.snapshot_id);
              if (!prior || j > prior.jaccard) {
                trashRemaps.set(trash.snapshot_id, { projectId: sessSnap.project_id, jaccard: j });
              }
              break;
            }
          }
        }

        if (outcome === 'unknown') {
          if (s.session_id === latestId && s.has_snapshot) outcome = 'accepted';
          else if (s.has_snapshot) outcome = 'iterated';
          else outcome = 'unknown';
        }

        insertOutcome.run(
          s.session_id, outcome, isInTrash, hasSuccessor, successorId,
          turnCount, LABELER_VERSION, now
        );

        if (outcome === 'accepted') stats.outcomesAccepted += 1;
        else if (outcome === 'rejected') stats.outcomesRejected += 1;
        else if (outcome === 'iterated') stats.outcomesIterated += 1;
        else stats.outcomesUnknown += 1;
      }
    }

    // Re-tag trash snapshots to the project of their best-matching session.
    for (const [snapshotId, remap] of trashRemaps) {
      updateTrashProject.run(remap.projectId, snapshotId);
    }
  });

  tx();
}

// ============================================================
// Pass B — clarifying_pairs (rule-based)
// ============================================================

const FILE_PATTERN_G = /\b\w+\.(?:js|ts|jsx|tsx|py|go|rs|java|cpp|c|h|md|json|yaml|yml|sql|sh)\b/g;
const DIR_PATTERN_G = /\b(?:src|lib|app|components|utils|tests?|api|pages|server|client)\/[\w/-]+/g;

function extractFiles(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(FILE_PATTERN_G)) out.add(m[0]);
  for (const m of text.matchAll(DIR_PATTERN_G)) out.add(m[0]);
  return out;
}

function extractCriteriaPhrase(text: string): string | null {
  const m = text.match(/\b(?:should|must|needs? to)\s+[^.;\n]{3,80}/i);
  return m ? m[0].trim() : null;
}

function extractConstraintPhrase(text: string): string | null {
  const m = text.match(/\b(?:don't|do not|never|avoid|without\s+breaking)\s+[^.;\n]{3,80}/i);
  return m ? m[0].trim() : null;
}

function extractShapePhrase(text: string): string | null {
  const m = text.match(/\b(?:type|interface|schema|columns|fields|enum)\s+[^.;\n]{3,80}/i);
  return m ? m[0].trim() : null;
}

function extractUiPhrase(text: string): string | null {
  const m = text.match(/\b(?:color|colour|spacing|font|alignment|layout|padding|margin|hover|click|button|modal|tooltip)[^.;\n]{0,80}/i);
  return m ? m[0].trim() : null;
}

function extractTestsPhrase(text: string): string | null {
  const m = text.match(/\b(?:test|spec|verify|coverage|assertion)[^.;\n]{0,80}/i);
  return m ? m[0].trim() : null;
}

/**
 * Synthetic-prompt detector — filters harness-injected text and the developer's
 * shell paste-backs that aren't real user-typed prompts in the
 * "ambiguous-and-needs-clarification" sense.
 *
 * Returns true if this prompt should NOT be used in clarifying-pair extraction.
 */
/**
 * Synthetic-prompt detector. Reactive (regex-per-pattern). See NOTES.md —
 * this is intentionally cheap for v0 and will be refactored to a single
 * classifier once we hit ~3 design partners or ~15 patterns.
 */
function isSyntheticPrompt(content: string): boolean {
  if (!content) return true;
  const trimmed = content.trim();

  // Harness-injected
  if (trimmed.startsWith('This session is being continued from a previous')) return true;
  if (trimmed.startsWith('<scheduled-task')) return true;
  if (trimmed.startsWith('Caveat:') && trimmed.length < 200) return true;
  if (trimmed.startsWith('Base directory for this skill:')) return true;
  if (trimmed.startsWith('Note from skill:')) return true;

  // Terminal session paste-backs
  if (trimmed.startsWith('Last login:')) return true;
  if (/^main@\S+\s/.test(trimmed)) return true;
  if (/^root@\S+:/.test(trimmed)) return true;
  if (/^\$\s/.test(trimmed) && /[\\/]\w+/.test(trimmed)) return true;

  // Pasted assistant/tool reports — the developer re-pastes these into chat as context.
  // Match within the first 120 chars so leading qualifiers ("full", "complete",
  // "Round 3") don't bypass the filter.
  const firstSlice = trimmed.slice(0, 120);
  if (/(?:smoke[\s\-]?test|audit|re[\s\-]?test|test)\s+report\b/i.test(firstSlice) &&
      /^(?:Here's|here is|attached|see|results?|the\s)/i.test(firstSlice)) return true;
  if (/^(?:RE-)?TEST REPORT\b/i.test(trimmed)) return true;
  if (/^(?:Round\s+\d+\s+)?Smoke[\s\-]Test\s+(?:Report|Round)/i.test(trimmed.slice(0, 80))) return true;

  // Dashboard / app scrapes — the developer pastes UI text from his own deployed sites
  if (/^[A-Z]\w+(?:\s+[A-Z]\w+){1,3}\s+(?:AI Suite|Dashboard|Console|Admin|Operations)/.test(trimmed.slice(0, 120)) && trimmed.length > 200) return true;

  // ALL-CAPS report headers (>= 2 uppercase tokens at start)
  const firstLine = trimmed.split('\n')[0];
  if (/^[A-Z][A-Z\- ]{2,}\s+[A-Z][A-Z\- ]{1,}/.test(firstLine.slice(0, 80))) return true;

  // High special-character density — log/JSON/shell-output dump
  const alphaRatio = (trimmed.match(/[a-zA-Z]/g) || []).length / trimmed.length;
  if (alphaRatio < 0.5 && trimmed.length > 80) return true;

  return false;
}

const MIN_ORIGINATING_LENGTH = 40;

interface PromptRow {
  prompt_id: number;
  session_id: string;
  turn_index: number;
  content: string;
  has_files: number;
  has_tests: number;
  has_criteria: number;
  has_constraints: number;
}

export function runClarifyingPairsLabeler(db: Database.Database, stats: LabelerStats): void {
  // Wipe existing rule-extracted pairs (idempotent re-run)
  db.prepare(`DELETE FROM clarifying_pairs WHERE extraction_method = 'rule' AND extractor_version = ?`)
    .run(LABELER_VERSION);

  // Pull all eligible user prompts in order
  const userPrompts = db.prepare(`
    SELECT p.prompt_id, p.session_id, p.turn_index, p.content,
           p.has_files, p.has_tests, p.has_criteria, p.has_constraints
    FROM prompts p
    JOIN sessions s ON s.session_id = p.session_id
    WHERE s.is_eligible_for_corpus = 1 AND p.role = 'user'
    ORDER BY p.session_id, p.turn_index
  `).all() as PromptRow[];

  // Group by session
  const bySession = new Map<string, PromptRow[]>();
  for (const p of userPrompts) {
    if (!bySession.has(p.session_id)) bySession.set(p.session_id, []);
    bySession.get(p.session_id)!.push(p);
  }

  const insertPair = db.prepare(`
    INSERT INTO clarifying_pairs (
      originating_prompt_id, clarifying_prompt_id, session_id,
      clarification_text, clarification_kind,
      extraction_method, extractor_version, confidence,
      extracted_at, is_in_gold_subset
    ) VALUES (?, ?, ?, ?, ?, 'rule', ?, ?, ?, 0)
  `);

  const now = new Date().toISOString();
  const LOOKAHEAD = 3;

  const tx = db.transaction(() => {
    for (const [, prompts] of bySession) {
      for (let i = 0; i < prompts.length; i++) {
        const p = prompts[i];
        // Filter originating: must be a real, non-synthetic, substantive prompt
        if (p.content.length < MIN_ORIGINATING_LENGTH) continue;
        if (isSyntheticPrompt(p.content)) continue;

        for (let k = 1; k <= LOOKAHEAD && i + k < prompts.length; k++) {
          const pNext = prompts[i + k];
          // Filter clarifying: must be non-synthetic (length OK to be short)
          if (isSyntheticPrompt(pNext.content)) continue;

          // file-scope: clarifier introduces files originating didn't have
          if (pNext.has_files && !p.has_files) {
            const filesP = extractFiles(p.content);
            const filesN = extractFiles(pNext.content);
            const newFiles = Array.from(filesN).filter(f => !filesP.has(f));
            if (newFiles.length > 0) {
              insertPair.run(
                p.prompt_id, pNext.prompt_id, p.session_id,
                `added file(s): ${newFiles.slice(0, 6).join(', ')}`,
                'file-scope',
                LABELER_VERSION, 0.6, now
              );
              stats.pairsInserted += 1;
            }
          }

          // success-criteria
          if (pNext.has_criteria && !p.has_criteria) {
            const phrase = extractCriteriaPhrase(pNext.content);
            if (phrase) {
              insertPair.run(
                p.prompt_id, pNext.prompt_id, p.session_id,
                phrase, 'success-criteria',
                LABELER_VERSION, 0.5, now
              );
              stats.pairsInserted += 1;
            }
          }

          // constraint
          if (pNext.has_constraints && !p.has_constraints) {
            const phrase = extractConstraintPhrase(pNext.content);
            if (phrase) {
              insertPair.run(
                p.prompt_id, pNext.prompt_id, p.session_id,
                phrase, 'constraint',
                LABELER_VERSION, 0.55, now
              );
              stats.pairsInserted += 1;
            }
          }

          // tests
          if (pNext.has_tests && !p.has_tests) {
            const phrase = extractTestsPhrase(pNext.content);
            if (phrase) {
              insertPair.run(
                p.prompt_id, pNext.prompt_id, p.session_id,
                phrase, 'success-criteria',  // test-mention is a kind of criterion
                LABELER_VERSION, 0.45, now
              );
              stats.pairsInserted += 1;
            }
          }

          // data-shape (only if originating didn't already discuss shape)
          const phaseP_shape = /\b(type|interface|schema|columns|fields|enum)\b/i.test(p.content);
          const phaseN_shape = /\b(type|interface|schema|columns|fields|enum)\b/i.test(pNext.content);
          if (phaseN_shape && !phaseP_shape) {
            const phrase = extractShapePhrase(pNext.content);
            if (phrase) {
              insertPair.run(
                p.prompt_id, pNext.prompt_id, p.session_id,
                phrase, 'data-shape',
                LABELER_VERSION, 0.5, now
              );
              stats.pairsInserted += 1;
            }
          }

          // ui-detail
          const phaseP_ui = /\b(color|spacing|font|alignment|layout|padding|margin|hover|click|button|modal|tooltip)\b/i.test(p.content);
          const phaseN_ui = /\b(color|spacing|font|alignment|layout|padding|margin|hover|click|button|modal|tooltip)\b/i.test(pNext.content);
          if (phaseN_ui && !phaseP_ui) {
            const phrase = extractUiPhrase(pNext.content);
            if (phrase) {
              insertPair.run(
                p.prompt_id, pNext.prompt_id, p.session_id,
                phrase, 'ui-detail',
                LABELER_VERSION, 0.5, now
              );
              stats.pairsInserted += 1;
            }
          }
        }
      }
    }
  });

  tx();
}

export function runLabeler(db: Database.Database): LabelerStats {
  const stats = newLabelerStats();
  runOutcomeLabeler(db, stats);
  runClarifyingPairsLabeler(db, stats);
  return stats;
}
