/**
 * Parser B — Cowork local-agent-mode-sessions.
 * Source: ~/Library/Application Support/Claude/local-agent-mode-sessions/<group>/<sub>/local_<uuid>/audit.jsonl
 * Manifest sibling: .../local_<uuid>.json
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { glob } from 'glob';
import { ParsedSession, ParsedEvent } from '../types';
import { extractUserText, flattenAssistantContent, extractToolUses, iterateJsonl, toIso } from './shared';

export const COWORK_ROOT = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'Claude',
  'local-agent-mode-sessions'
);

/**
 * Find all local_<uuid>/audit.jsonl files across all session-group dirs.
 */
export async function findCoworkSessions(rootOverride?: string): Promise<string[]> {
  const root = rootOverride || COWORK_ROOT;
  if (!fs.existsSync(root)) return [];
  const matches = await glob('*/*/local_*/audit.jsonl', { cwd: root, absolute: true, nodir: true });
  return matches.sort();
}

interface CoworkManifest {
  sessionId?: string;
  cliSessionId?: string;
  cwd?: string;
  title?: string;
  model?: string;
  scheduledTaskId?: string;
  sessionType?: string;
  createdAt?: number | string;
  lastActivityAt?: number | string;
  isArchived?: boolean;
  accountName?: string;
  systemPrompt?: string;
}

function loadManifest(auditPath: string): CoworkManifest | null {
  // audit.jsonl lives at .../local_<uuid>/audit.jsonl
  // manifest lives at .../local_<uuid>.json (sibling of the local_<uuid>/ dir)
  const localDir = path.dirname(auditPath);                   // .../local_<uuid>
  const localUuid = path.basename(localDir);                  // local_<uuid>
  const manifestPath = path.join(path.dirname(localDir), `${localUuid}.json`);
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as CoworkManifest;
  } catch {
    return null;
  }
}

/**
 * Parse one Cowork session (one local_<uuid>/audit.jsonl + its manifest).
 */
export async function parseCoworkSession(auditPath: string): Promise<ParsedSession | null> {
  const manifest = loadManifest(auditPath);
  const localDir = path.dirname(auditPath);
  const localUuid = path.basename(localDir);

  // Prefer manifest.sessionId (outer wrapper UUID matching local_<uuid>).
  const sessionId = manifest?.sessionId || localUuid;

  const events: ParsedEvent[] = [];
  let firstTimestamp: string | undefined;
  let lastTimestamp: string | undefined;
  let firstUserContent: string | undefined;

  for await (const ev of iterateJsonl(auditPath)) {
    const t = ev.type as string | undefined;
    // Cowork uses snake_case `_audit_timestamp` and ISO strings (we observed).
    const ts = toIso(ev._audit_timestamp || ev.timestamp);
    if (ts) {
      if (!firstTimestamp) firstTimestamp = ts;
      lastTimestamp = ts;
    }

    if (t === 'user' || t === 'assistant') {
      const msg = ev.message as Record<string, unknown> | undefined;
      if (!msg) continue;
      const role = msg.role === 'assistant' ? 'assistant' : 'user';

      if (role === 'user') {
        const userText = extractUserText(msg.content);
        if (!userText) continue;
        if (!firstUserContent) firstUserContent = userText;
        events.push({
          kind: 'user',
          content: userText,
          timestamp: ts || new Date().toISOString(),
          rawJson: ev,
        });
        continue;
      }

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

  // Fallback timestamps from manifest if events don't have any
  const startedAt = firstTimestamp || toIso(manifest?.createdAt) || new Date().toISOString();
  const endedAt = lastTimestamp || toIso(manifest?.lastActivityAt);

  // For Cowork, scheduledTaskId comes from the manifest (authoritative).
  // sessionType='scheduled' is also a flag but scheduledTaskId presence is the canonical filter.
  return {
    source: 'cowork',
    sessionId,
    sourcePath: localDir,
    cwd: manifest?.cwd,
    startedAt,
    endedAt,
    title: manifest?.title,
    model: manifest?.model,
    gitBranch: undefined,
    scheduledTaskId: manifest?.scheduledTaskId || undefined,
    // Cowork manifests don't carry userType — treat as 'external' if not scheduled
    userType: manifest?.scheduledTaskId ? 'scheduled' : 'external',
    rawMeta: {
      cliSessionId: manifest?.cliSessionId,
      sessionType: manifest?.sessionType,
      isArchived: manifest?.isArchived,
      firstUserPreview: (firstUserContent || '').slice(0, 200),
    },
    events,
  };
}
