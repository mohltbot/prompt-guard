/**
 * Shared types for the check pipeline.
 *
 * Each check is a `Check` object with an `id`, a `run(ctx)` function, and
 * optional `requires` flag indicating dependencies (e.g. corpus DB). The
 * `enabledChecks: string[]` config field controls which checks run by ID —
 * this is enforced via `buildPipeline()` in registry.ts.
 *
 * Previously these checks were hardcoded methods on PromptGuard and the
 * `enabledChecks` config field was silently ignored. Fixed in MVP-2.
 */

import type { Config } from '../config-types';

export interface ContextFile {
  name: string;
  content: string;
  relevance: number;
}

export type ClarificationKind =
  | 'file-scope'
  | 'success-criteria'
  | 'constraint'
  | 'data-shape'
  | 'ui-detail'
  | 'domain-context'
  | 'other';

export interface ClarifyingQuestion {
  text: string;
  kind: ClarificationKind;
  groundedIn: Array<{
    sessionId: string;
    promptId: number;
    snippet: string;
  }>;
  confidence: number;
}

export interface CheckResult {
  type: 'warning' | 'error' | 'info';
  message: string;
  suggestion?: string;
  /** Populated by corpus-clarify; undefined elsewhere. */
  questions?: ClarifyingQuestion[];
  /** Diagnostics, hidden in normal output. */
  diagnostics?: Record<string, unknown>;
}

/**
 * Forward-declaration for CorpusReader. Real impl arrives with MVP-3.
 * For MVP-2 the corpus check stub takes no real corpus.
 */
export interface CorpusReader {
  // Placeholder — real shape lands in MVP-3
  isOpen(): boolean;
}

export interface CheckContext {
  prompt: string;
  promptTokens: number;
  contextFiles: ContextFile[];
  contextTokens: number;
  config: Config;
  /** Defined when the corpus DB exists; undefined otherwise. */
  corpus?: CorpusReader;
  /** Resolved by orchestrator from cwd hash or .prompt-guard.json. */
  projectId?: string;
}

export interface Check {
  id: string;
  description: string;
  /** Optional requirement gate. Checks with unmet requirements are skipped silently. */
  requires?: 'corpus' | 'context-files' | 'none';
  run(ctx: CheckContext): Promise<CheckResult[]>;
}
