/**
 * Parser A — Claude Code projects JSONL.
 * Source: ~/.claude/projects/<cwd-encoded>/<session-uuid>.jsonl
 */

import * as path from 'path';
import * as os from 'os';
import { glob } from 'glob';
import { ParsedSession, ParsedEvent } from '../types';
import { extractUserText, flattenAssistantContent, hasToolResult, extractToolUses, iterateJsonl, toIso } from './shared';

export const CLAUDE_PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');

/**
 * Find all JSONL files under ~/.claude/projects/.
 */
export async function findClaudeCodeFiles(rootOverride?: string): Promise<string[]> {
  const root = rootOverride || CLAUDE_PROJECTS_ROOT;
  const matches = await glob('**/*.jsonl', { cwd: root, absolute: true, nodir: true });
  return matches.sort();
}

/**
 * Parse a single Claude Code projects JSONL file into a ParsedSession.
 */
export async function parseClaudeCodeFile(filePath: string): Promise<ParsedSession | null> {
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let startedAt: string | undefined;
  let endedAt: string | undefined;
  let model: string | undefined;
  let gitBranch: string | undefined;
  let userType: string | undefined;
  let firstUserContent: string | undefined;
  const events: ParsedEvent[] = [];
  let firstQueueOp: string | undefined;

  for await (const ev of iterateJsonl(filePath)) {
    const t = ev.type as string | undefined;
    const ts = toIso(ev.timestamp);
    if (ts) {
      if (!startedAt) startedAt = ts;
      endedAt = ts;
    }
    if (typeof ev.sessionId === 'string') sessionId = ev.sessionId;
    if (typeof ev.cwd === 'string') cwd = ev.cwd;
    if (typeof ev.gitBranch === 'string') gitBranch = ev.gitBranch;
    if (typeof ev.userType === 'string') userType = ev.userType;
    if (typeof ev.version === 'string' && !model) model = `claude-code-${ev.version}`;

    if (t === 'queue-operation' && ev.operation === 'enqueue') {
      const c = ev.content;
      if (typeof c === 'string' && !firstQueueOp) firstQueueOp = c;
      events.push({
        kind: 'queue-operation',
        content: typeof c === 'string' ? c : undefined,
        timestamp: ts || new Date().toISOString(),
        rawJson: ev,
      });
      continue;
    }

    if (t === 'user' || t === 'assistant') {
      const msg = ev.message as Record<string, unknown> | undefined;
      if (!msg) continue;
      const role = msg.role === 'assistant' ? 'assistant' : 'user';

      if (role === 'user') {
        // Filter out tool_result envelopes — they're not human input.
        // Keep only the human-typed text portion (which may be empty).
        const userText = extractUserText(msg.content);
        if (!userText) continue;             // pure tool_result wrapper, skip
        if (!firstUserContent) firstUserContent = userText;
        events.push({
          kind: 'user',
          content: userText,
          timestamp: ts || new Date().toISOString(),
          rawJson: ev,
        });
        continue;
      }

      // assistant turn — keep text + extract tool_use blocks
      const asstText = flattenAssistantContent(msg.content);
      events.push({
        kind: 'assistant',
        content: asstText,
        timestamp: ts || new Date().toISOString(),
        rawJson: ev,
      });
      const toolUses = extractToolUses(msg.content);
      for (const tu of toolUses) {
        events.push({
          kind: 'tool_use',
          toolName: tu.toolName,
          toolFilePath: tu.filePath,
          toolOperation: tu.operation,
          parentTurnIndex: events.length - 1,
          timestamp: ts || new Date().toISOString(),
          rawJson: { name: tu.toolName, input: tu.rawInput },
        });
      }
      continue;
    }

    if (t === 'system') {
      events.push({
        kind: 'system',
        content: typeof ev.subtype === 'string' ? `[system:${ev.subtype}]` : '[system]',
        timestamp: ts || new Date().toISOString(),
        rawJson: ev,
      });
    }
  }

  if (!sessionId) {
    // Fallback: derive from filename (basename without .jsonl)
    sessionId = path.basename(filePath, '.jsonl');
  }
  if (!startedAt) {
    return null; // truly empty file — skip
  }

  // Detect scheduled-task wrapping in first user content (Claude Code can
  // host scheduled-task runs whose first user message is a wrapped template).
  let scheduledTaskId: string | undefined;
  const firstUser = firstUserContent || firstQueueOp || '';
  const m = firstUser.match(/^<scheduled-task\s+name="([^"]+)"/);
  if (m) scheduledTaskId = m[1];

  return {
    source: 'claude-code',
    sessionId,
    sourcePath: filePath,
    cwd,
    startedAt,
    endedAt,
    title: undefined,            // Claude Code doesn't have titles in these files
    model,
    gitBranch,
    scheduledTaskId,
    userType,
    rawMeta: { firstUserPreview: firstUser.slice(0, 200) },
    events,
  };
}
