/**
 * Writes a ParsedSession to the corpus DB.
 * Idempotent: re-writing the same session_id replaces its prompts/tool_calls.
 */

import * as crypto from 'crypto';
import Database from 'better-sqlite3';
import { ParsedSession, ParsedEvent } from './types';
import { tagPrompt } from './heuristics';
import { normalize } from './parsers/shared';

export interface WriteStats {
  sessionsInserted: number;
  sessionsUpdated: number;
  sessionsExcluded: number;
  promptsInserted: number;
  toolCallsInserted: number;
}

export function newWriteStats(): WriteStats {
  return {
    sessionsInserted: 0,
    sessionsUpdated: 0,
    sessionsExcluded: 0,
    promptsInserted: 0,
    toolCallsInserted: 0,
  };
}

/** Lowercase + strip date/run prefixes for fuzzy title matching. */
function normalizeTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/^(test:|update:|run:|apr|may|jun|jul|aug|sep|oct|nov|dec|jan|feb|mar)[\s\-—:]+/i, '')
    .replace(/[—–]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Derive project_id from session metadata.
 * For Cowork: manifest title is the only reliable host-side identifier
 * (cwd is VM-internal). We bucket by normalized title.
 * For Claude Code: cwd is the host path → bucket by cwd-basename.
 * For manual: explicit project_id passed by caller.
 */
function deriveProjectId(ps: ParsedSession): string {
  if (ps.source === 'cowork') {
    if (ps.title) return 'cowork:' + crypto.createHash('sha1').update(normalizeTitle(ps.title)).digest('hex').slice(0, 16);
    if (ps.scheduledTaskId) return 'cowork-sched:' + ps.scheduledTaskId;
    return 'cowork:' + ps.sessionId;
  }
  if (ps.cwd) {
    const parts = ps.cwd.split('/').filter(Boolean);
    const basename = parts[parts.length - 1] || 'root';
    return 'cwd:' + basename + ':' + crypto.createHash('sha1').update(ps.cwd).digest('hex').slice(0, 8);
  }
  return 'unknown:' + ps.sessionId;
}

function deriveProjectName(ps: ParsedSession): string {
  if (ps.title) return ps.title;
  if (ps.cwd) {
    const parts = ps.cwd.split('/').filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  return ps.scheduledTaskId || 'unknown';
}

function isEligible(ps: ParsedSession): boolean {
  if (ps.scheduledTaskId) return false;
  if (ps.userType && ps.userType !== 'external') return false;
  // Also catch scheduled-task wrapping detected by parser (Claude Code case)
  return true;
}

/**
 * Write a parsed session to the DB. Wraps in a transaction.
 */
export function writeSession(db: Database.Database, ps: ParsedSession, stats: WriteStats): void {
  const projectId = deriveProjectId(ps);
  const projectName = deriveProjectName(ps);
  const eligible = isEligible(ps);
  if (!eligible) stats.sessionsExcluded += 1;

  const tx = db.transaction(() => {
    // Upsert project
    db.prepare(`
      INSERT INTO projects (project_id, cwd, name, explicit, created_at, last_seen_at)
      VALUES (?, ?, ?, 0, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        last_seen_at = excluded.last_seen_at,
        name = COALESCE(projects.name, excluded.name),
        cwd  = COALESCE(projects.cwd, excluded.cwd)
    `).run(projectId, ps.cwd || null, projectName, ps.startedAt, ps.endedAt || ps.startedAt);

    // Was this session already ingested?
    const existing = db.prepare('SELECT session_id FROM sessions WHERE session_id = ?').get(ps.sessionId);
    if (existing) {
      // delete dependent rows so re-ingest is clean
      db.prepare('DELETE FROM tool_calls WHERE session_id = ?').run(ps.sessionId);
      db.prepare('DELETE FROM prompts WHERE session_id = ?').run(ps.sessionId);
      stats.sessionsUpdated += 1;
    } else {
      stats.sessionsInserted += 1;
    }

    // Upsert session
    db.prepare(`
      INSERT INTO sessions (
        session_id, project_id, source, source_path, cwd,
        started_at, ended_at, title, model, git_branch,
        scheduled_task_id, user_type, is_eligible_for_corpus,
        turn_count, raw_meta_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        ended_at = excluded.ended_at,
        title = excluded.title,
        is_eligible_for_corpus = excluded.is_eligible_for_corpus,
        scheduled_task_id = excluded.scheduled_task_id,
        user_type = excluded.user_type,
        turn_count = excluded.turn_count,
        raw_meta_json = excluded.raw_meta_json
    `).run(
      ps.sessionId,
      projectId,
      ps.source,
      ps.sourcePath,
      ps.cwd || null,
      ps.startedAt,
      ps.endedAt || null,
      ps.title || null,
      ps.model || null,
      ps.gitBranch || null,
      ps.scheduledTaskId || null,
      ps.userType || null,
      eligible ? 1 : 0,
      ps.events.filter(e => e.kind === 'user').length,
      JSON.stringify(ps.rawMeta || {})
    );

    // Insert prompts (user/assistant turns) — assign turn indices in order
    const insertPrompt = db.prepare(`
      INSERT INTO prompts (
        session_id, project_id, turn_index, role,
        content, normalized_content, raw_event_json, timestamp,
        has_files, has_tests, has_criteria, has_constraints, has_local_env
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertTool = db.prepare(`
      INSERT INTO tool_calls (
        prompt_id, session_id, tool_name, file_path, operation, success, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    let turnIndex = 0;
    let lastPromptRowId: number | undefined;

    for (const ev of ps.events) {
      if (ev.kind === 'user' || ev.kind === 'assistant') {
        const text = ev.content || '';
        const tags = tagPrompt(text);
        const info = insertPrompt.run(
          ps.sessionId,
          projectId,
          turnIndex,
          ev.kind,
          text,
          normalize(text),
          JSON.stringify(ev.rawJson),
          ev.timestamp,
          tags.has_files ? 1 : 0,
          tags.has_tests ? 1 : 0,
          tags.has_criteria ? 1 : 0,
          tags.has_constraints ? 1 : 0,
          tags.has_local_env ? 1 : 0
        );
        lastPromptRowId = info.lastInsertRowid as number;
        stats.promptsInserted += 1;
        turnIndex += 1;
      } else if (ev.kind === 'tool_use') {
        if (lastPromptRowId === undefined) continue;
        insertTool.run(
          lastPromptRowId,
          ps.sessionId,
          ev.toolName || 'unknown',
          ev.toolFilePath || null,
          ev.toolOperation || null,
          ev.toolSuccess === undefined ? null : (ev.toolSuccess ? 1 : 0),
          ev.timestamp
        );
        stats.toolCallsInserted += 1;
      }
      // queue-operation, system: not stored as prompts
    }
  });

  tx();
}
