/**
 * Common types shared across parsers, writer, and labeler.
 */

export type Source = 'claude-code' | 'cowork' | 'manual';

export interface ParsedSession {
  source: Source;
  sessionId: string;
  sourcePath: string;        // absolute path to file or directory
  cwd?: string;
  startedAt: string;         // ISO 8601
  endedAt?: string;
  title?: string;
  model?: string;
  gitBranch?: string;
  scheduledTaskId?: string;
  userType?: string;         // 'external' | other
  rawMeta: Record<string, unknown>;
  events: ParsedEvent[];
}

export type EventKind =
  | 'user'
  | 'assistant'
  | 'tool_use'
  | 'queue-operation'
  | 'system';

export interface ParsedEvent {
  kind: EventKind;
  // For user/assistant events
  content?: string;          // flattened plaintext; empty string if pure tool_use turn
  // For tool_use events
  toolName?: string;
  toolFilePath?: string;
  toolOperation?: string;    // 'edit'|'write'|'read'|'bash'|...
  toolSuccess?: boolean;
  // Optional pairing with the assistant turn this tool_use came from
  parentTurnIndex?: number;
  timestamp: string;         // ISO 8601
  rawJson: Record<string, unknown>;
}
