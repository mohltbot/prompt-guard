/**
 * Helpers shared between Claude Code + Cowork parsers.
 */

/**
 * Returns true if a message.content array contains any tool_result block.
 * In Claude's API conversation format, tool results are wrapped in a `role:user`
 * message — those are NOT human-typed input and must be filtered out before
 * counting "user prompts."
 */
export function hasToolResult(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  for (const block of content) {
    if (typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool_result') {
      return true;
    }
  }
  return false;
}

/**
 * Extract ONLY human-typed text from a message.content.
 * Drops tool_result, tool_use, thinking, and image blocks.
 * - string content → returned as-is
 * - array content → concatenation of `text` blocks (NOT inside tool_result)
 *
 * Returns empty string if no human-typed text present (e.g. pure tool_result envelope).
 */
export function extractUserText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text);
    }
    // tool_result, tool_use, thinking, image: skipped
  }
  return parts.join('\n').trim();
}

/**
 * Flatten content for ASSISTANT turns. Includes text blocks; drops tool_use
 * (extracted separately) and thinking (kept in raw_event_json only).
 */
export function flattenAssistantContent(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text);
    }
  }
  return parts.join('\n').trim();
}

/**
 * @deprecated Prefer extractUserText / flattenAssistantContent.
 * Retained as a thin compatibility wrapper.
 */
export function flattenContent(content: unknown): string {
  return extractUserText(content);
}

/**
 * Walk the content array and extract all tool_use blocks as separate events.
 */
export interface ExtractedToolUse {
  toolName: string;
  filePath?: string;
  operation: string;
  rawInput: Record<string, unknown>;
}

export function extractToolUses(content: unknown): ExtractedToolUse[] {
  if (!Array.isArray(content)) return [];
  const out: ExtractedToolUse[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type !== 'tool_use') continue;
    const name = typeof b.name === 'string' ? b.name : 'unknown';
    const input = (b.input && typeof b.input === 'object') ? (b.input as Record<string, unknown>) : {};
    out.push({
      toolName: name,
      filePath: typeof input.file_path === 'string' ? input.file_path :
                typeof input.path === 'string' ? input.path : undefined,
      operation: toolNameToOperation(name),
      rawInput: input,
    });
  }
  return out;
}

function toolNameToOperation(name: string): string {
  const lower = name.toLowerCase();
  if (lower === 'edit' || lower.endsWith('edit')) return 'edit';
  if (lower === 'write' || lower.endsWith('write')) return 'write';
  if (lower === 'read' || lower.endsWith('read')) return 'read';
  if (lower === 'bash') return 'bash';
  if (lower === 'grep') return 'grep';
  if (lower === 'glob') return 'glob';
  if (lower.includes('search')) return 'search';
  return 'other';
}

/**
 * Normalize prompt text for BM25/retrieval:
 * - lowercase
 * - strip code fences
 * - collapse whitespace
 * - drop very long URLs/paths
 */
export function normalize(text: string): string {
  let t = text.toLowerCase();
  t = t.replace(/```[\s\S]*?```/g, ' ');     // code blocks
  t = t.replace(/`[^`\n]+`/g, ' ');            // inline code
  t = t.replace(/https?:\/\/\S+/g, ' ');       // URLs
  t = t.replace(/\s+/g, ' ');
  return t.trim();
}

/**
 * Iterate JSONL lines from a file path. Yields parsed objects.
 * Skips blank lines and parse-error lines (logs a count).
 */
export async function* iterateJsonl(filePath: string): AsyncGenerator<Record<string, unknown>> {
  const fs = await import('fs');
  const readline = await import('readline');
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line) as Record<string, unknown>;
    } catch {
      // skip malformed lines silently in v0; could add stats later
    }
  }
}

/**
 * Convert epoch-ms or ISO string to ISO. Returns undefined for falsy.
 */
export function toIso(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'number') return new Date(value).toISOString();
  if (typeof value === 'string') {
    if (!value) return undefined;
    // already ISO?
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return value;
    // fallback parse
    const d = new Date(value);
    return isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  return undefined;
}
