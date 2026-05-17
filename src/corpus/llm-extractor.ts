/**
 * LLM-based clarification extractor.
 * Reads rule-extracted clarifying pairs and produces a verdict per pair:
 *   - is this a real clarification or a rule false-positive?
 *   - if real, what's the cleaner extracted text and the right kind?
 *
 * Model-agnostic via the ClarificationExtractor interface. Default impl
 * uses Claude Sonnet 4.6 with prompt caching on the system prompt.
 */

import Anthropic from '@anthropic-ai/sdk';
import { loadHomeEnv } from './env';

export type ClarificationKind =
  | 'file-scope'
  | 'success-criteria'
  | 'constraint'
  | 'data-shape'
  | 'ui-detail'
  | 'domain-context'
  | 'other';

export interface ExtractorInput {
  origContent: string;
  clarContent: string;
  ruleKind: string;
  ruleText: string;
}

export interface LlmVerdict {
  isRealClarification: boolean;
  kind?: ClarificationKind;
  refinedText?: string;
  confidence?: number;
  reason: string;
  // Diagnostics
  modelName: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  // Error details — populated only on failure. Captured here so callers
  // can group/log failures by actual cause rather than swallowing them.
  errorClass?: string;
  errorStatus?: number;
  errorMessage?: string;
}

export interface ClarificationExtractor {
  name: string;
  extract(input: ExtractorInput): Promise<LlmVerdict>;
}

// =============================================================================
// System prompt — designed to be ≥1024 tokens so prompt-caching applies.
// =============================================================================

// Tuned 2026-05-10 (v1) based on the developer's 73% kind-override rate analysis:
//  - LLM over-used `other` when CLAR specified concrete files (13 → file-scope)
//  - LLM over-used `success-criteria` for context-delivery CLARs (8 → other)
//  - LLM over-used `constraint` for positive-phrased criteria (3 → success-criteria)
// See NOTES.md → "LLM extractor v1 system-prompt tuning"
const SYSTEM_PROMPT = `You are a strict reviewer evaluating clarifying-prompt pairs from a developer's coding session.

A regex-based "rule extractor" has flagged a pair (ORIG, CLAR) as a possible clarification, where CLAR appears in the same session 1-3 turns after ORIG. Your job is to decide whether CLAR really clarified ORIG, and if so, refine the kind and the extracted clarification text.

# What counts as a real clarification

CLAR clarifies ORIG when ALL of these are true:
1. CLAR is human-typed reasoning or instruction, not pasted tool output, shell logs, dashboard scrapes, harness messages, or session-resume preambles.
2. CLAR adds specific information that ORIG was missing or vague about — a file name, a constraint, a success criterion, a data shape, a UI detail.
3. CLAR is topically connected to ORIG. They are about the same task, not two unrelated things that happened in sequence.

If ANY of these is false, the pair is a false positive — return is_real_clarification=false.

# Kinds (canonical) — disambiguation rules tuned to common mistakes

- **file-scope**: CLAR specifies WHICH files, dirs, modules, or paths to touch / create / modify.
  STRONG SIGNAL: any of these is enough to prefer file-scope over other or success-criteria:
  - Concrete filenames (\`dashboard.py\`, \`auth/login.ts\`, \`memory/MEMORY.md\`)
  - Directory paths (\`src/auth/\`, \`outputs/demo-project/\`)
  - Module/package names being created or modified
  - File-naming patterns (\`*.tsx\`, \`demo_output_*.md\`)
  Do NOT downgrade to "other" just because CLAR also adds context; if files are named, kind = file-scope.

- **success-criteria**: CLAR specifies an EXPLICIT pass/fail condition or measurable target.
  ONLY pick this kind when CLAR has positive ("must X", "should achieve Y", "needs to pass Z") or measurable
  ("under 200ms", "10k req/s", "90% coverage", "match the existing API shape") language.
  Do NOT use for context delivery or general guidance — that's "other".

- **constraint**: CLAR specifies an EXPLICIT prohibition.
  REQUIRES negative phrasing: "don't X", "never Y", "must NOT", "avoid", "without breaking", "do not change".
  A positively-phrased required behavior ("should be X") is success-criteria, NOT constraint.

- **data-shape**: CLAR specifies a type signature, schema, columns, fields, or enum values.
  Examples: "the response should have {id, name, created_at}", "use enum status with values active|paused".

- **ui-detail**: CLAR specifies visual/interaction specifics — color, spacing, font, alignment, layout, hover, click.

- **domain-context**: CLAR delivers external context that grounds the AI in resources, sources,
  examples, infrastructure choices, or business background ORIG referenced but did not include.
  TYPICAL "domain-context":
  - Meeting notes / in-person session recaps delivering customer requirements
  - Research-source direction ("look at HN and founder blogs, not Reddit")
  - Example-subject choice ("use Globex Sports as the target client")
  - Deployment/storage target ("publish to DigitalOcean droplet", "GDrive folder")
  - Business/domain background about a customer or vertical
  Differs from file-scope: file-scope names files IN THE CODEBASE; domain-context
  references EXTERNAL resources, places, or business facts.

- **other**: Real clarification but doesn't fit any of the categories above.
  Should be rare. If you find yourself reaching for "other": ask whether CLAR is really
  domain-context (external grounding) or file-scope (specific files) and pick one of those.

# Disambiguation priority when multiple kinds could apply

Apply in this order:
1. If CLAR names specific files/dirs/paths IN THE CODEBASE → file-scope (even if CLAR also adds context/criteria)
2. If CLAR delivers EXTERNAL context (meeting notes, research sources, example targets, deployment infra, business background) → domain-context
3. If CLAR has explicit negative phrasing ("don't X") → constraint
4. If CLAR has explicit positive measurable criterion ("must achieve X") → success-criteria
5. If CLAR specifies a type/schema → data-shape
6. If CLAR specifies UI/interaction visuals → ui-detail
7. Real clarification but none of the above → other (should be rare)

If the rule extractor's kind is wrong but the pair IS a real clarification, refine the kind. The user wants strict agreement, so an honest kind correction is better than rubber-stamping.

# refined_text

If accepting, write a clean ≤140-char one-line statement of WHAT got clarified. Active voice. Concrete. Examples:
- "use Globex Sports as the target client"
- "must not break the existing /api/v1/* endpoints"
- "the dashboard column should be a 'last_seen_at' ISO timestamp"

# Common false-positive patterns to reject

- ORIG is just an ack ("yes", "ok", "yeah do that") with no actual content to clarify
- CLAR starts with "Here's the [X] report" / "Last login:" / "Base directory for this skill:" / "main@" / "root@" — these are paste-backs of tool output or shell sessions, not human clarifications
- CLAR contains a long list of files the developer pasted as context, not as a request
- ORIG asks A; CLAR asks completely unrelated B — coincidentally sequential, not related
- The rule's extracted text is just a fragment of CLAR that matched a regex (e.g. "should know about X" extracted from a tips list paste) but is not actually a clarification of ORIG

# Worked examples

## Example 1 — accept, kind matches rule
ORIG: "ok now lets try it with an entirely different example"
CLAR: "Create a complete social media content engine output for Globex Sports, a real client of DemoSaaS digital marketing agency."
RULE: kind=file-scope, extracted="added file(s): demo_output_social_media_globex-sports.md"
VERDICT:
- is_real_clarification: true
- kind: file-scope
- refined_text: "use Globex Sports as the new target client/example"
- confidence: 0.95
- reason: "ORIG was vague ('different example'); CLAR specifies the exact target client. Rule kind is correct."

## Example 2 — reject, paste-back
ORIG: "go check the messages i just sent and make 5 like it"
CLAR: "Here's the list of Claude tips & tricks I've been compiling..."
RULE: kind=file-scope, extracted="added file(s): CLAUDE.md, MEMORY.md, AGENT.md"
VERDICT:
- is_real_clarification: false
- kind: null
- refined_text: null
- confidence: 0.95
- reason: "CLAR is a context-dump paste of unrelated tips, not a clarification of which messages to use."

## Example 3 — accept, kind refined
ORIG: "make a dashboard for this"
CLAR: "with a blue header and 16px Inter font for the cards"
RULE: kind=file-scope, extracted="added file(s): cards.tsx"
VERDICT:
- is_real_clarification: true
- kind: ui-detail
- refined_text: "blue header, cards in 16px Inter font"
- confidence: 0.9
- reason: "Real clarification of dashboard appearance. Rule mistagged as file-scope; this is ui-detail."

## Example 4 — reject, topic drift
ORIG: "can we not use the current anthropic subscription youre running on thru oauth?"
CLAR: "You are a senior social media strategist. Generate a complete social media content package for a fictional pet grooming brand."
RULE: kind=success-criteria, extracted="spectrum analysis"
VERDICT:
- is_real_clarification: false
- kind: null
- refined_text: null
- confidence: 0.9
- reason: "ORIG asks about Anthropic auth; CLAR is an unrelated content-generation task. Sequential but topically disconnected."

## Example 5 — accept, real constraint extracted
ORIG: "You tested my Flask dashboard at http://example.com earlier and found three issues..."
CLAR: "Re-test http://example.com — I patched a worker-count bug. Don't bail early, click through every form even if first one fails."
RULE: kind=constraint, extracted="Don't bail early"
VERDICT:
- is_real_clarification: true
- kind: constraint
- refined_text: "don't bail on the smoke test if the first form fails — click through every form"
- confidence: 0.92
- reason: "CLAR adds a real testing constraint after ORIG triggered the re-test."

# Output

Use the submit_verdict tool. Always include "reason". If is_real_clarification is true, include kind, refined_text, confidence.`;

const VERDICT_TOOL: Anthropic.Tool = {
  name: 'submit_verdict',
  description: 'Submit your verdict on whether the (ORIG, CLAR) pair is a real clarification.',
  input_schema: {
    type: 'object',
    properties: {
      is_real_clarification: {
        type: 'boolean',
        description: 'true if CLAR really clarified ORIG; false for paste-backs, topic drift, or rule extraction artifacts.',
      },
      kind: {
        type: 'string',
        enum: ['file-scope', 'success-criteria', 'constraint', 'data-shape', 'ui-detail', 'domain-context', 'other'],
        description: 'Required if is_real_clarification is true. Refine if the rule extractor mistagged.',
      },
      refined_text: {
        type: 'string',
        description: 'Required if is_real_clarification is true. Clean ≤140-char one-line clarification.',
      },
      confidence: {
        type: 'number',
        description: 'Required if is_real_clarification is true. 0..1.',
      },
      reason: {
        type: 'string',
        description: 'Always required. One sentence explaining your verdict.',
      },
    },
    required: ['is_real_clarification', 'reason'],
  },
};

// =============================================================================
// Default implementation: Claude Sonnet 4.6 with prompt caching
// =============================================================================

const MAX_CONTENT_CHARS = 1500;

function truncate(s: string): string {
  if (!s) return '';
  if (s.length <= MAX_CONTENT_CHARS) return s;
  return s.slice(0, MAX_CONTENT_CHARS) + '… [truncated]';
}

function buildUserMessage(input: ExtractorInput): string {
  return [
    `ORIG: "${truncate(input.origContent)}"`,
    `CLAR: "${truncate(input.clarContent)}"`,
    `RULE LABELER: kind=${input.ruleKind}, extracted="${truncate(input.ruleText).slice(0, 300)}"`,
    '',
    'Use the submit_verdict tool. Be honest about kind refinements; do not rubber-stamp.',
  ].join('\n');
}

export class ClaudeClarificationExtractor implements ClarificationExtractor {
  readonly name = 'claude-sonnet-4-6';
  private client: Anthropic;

  constructor(opts?: { maxRetries?: number; timeoutMs?: number }) {
    loadHomeEnv(); // pulls ANTHROPIC_API_KEY from ~/.env if not already set
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error(
        'ANTHROPIC_API_KEY is not set. Add it to ~/.env (e.g. ANTHROPIC_API_KEY=sk-ant-...) or export it in your shell.'
      );
    }
    // Default maxRetries: 8. SDK honors retry-after headers and does exponential
    // backoff on 408, 409, 429, 5xx. Default of 2 was insufficient when running
    // against the tier-1 rate limit — bumping gives headroom without changing
    // success-case behavior (no retries on 2xx).
    this.client = new Anthropic({
      maxRetries: opts?.maxRetries ?? 8,
      timeout: opts?.timeoutMs ?? 120_000, // 2 min per request, plenty for Sonnet 4.6
    });
  }

  async extract(input: ExtractorInput): Promise<LlmVerdict> {
    const startedAt = Date.now();
    let response: Anthropic.Messages.Message;
    try {
      response = await this.client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 400,
        system: [
          {
            type: 'text',
            text: SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral' },
          },
        ],
        tools: [VERDICT_TOOL],
        tool_choice: { type: 'tool', name: 'submit_verdict' },
        messages: [{ role: 'user', content: buildUserMessage(input) }],
      });
    } catch (e) {
      const err = e as { status?: number; constructor?: { name: string }; message?: string };
      const msg = e instanceof Error ? e.message : String(e);
      const cls = err.constructor?.name || 'UnknownError';
      const status = typeof err.status === 'number' ? err.status : undefined;
      const tag = status !== undefined ? `${cls}(${status})` : cls;
      return {
        isRealClarification: false,
        reason: `LLM API error: ${tag}: ${msg.slice(0, 300)}`,
        errorClass: cls,
        errorStatus: status,
        errorMessage: msg,
        modelName: this.name,
        latencyMs: Date.now() - startedAt,
      };
    }
    const latency = Date.now() - startedAt;

    const toolUse = response.content.find(b => b.type === 'tool_use');
    if (!toolUse || toolUse.type !== 'tool_use') {
      return {
        isRealClarification: false,
        reason: 'LLM did not use submit_verdict tool',
        modelName: this.name,
        latencyMs: latency,
      };
    }
    const args = toolUse.input as Record<string, unknown>;

    const usage = response.usage;
    return {
      isRealClarification: Boolean(args.is_real_clarification),
      kind: args.kind as ClarificationKind | undefined,
      refinedText: typeof args.refined_text === 'string' ? args.refined_text : undefined,
      confidence: typeof args.confidence === 'number' ? args.confidence : undefined,
      reason: typeof args.reason === 'string' ? args.reason : '(no reason)',
      modelName: this.name,
      latencyMs: latency,
      inputTokens: usage?.input_tokens,
      outputTokens: usage?.output_tokens,
      cachedInputTokens: (usage as { cache_read_input_tokens?: number })?.cache_read_input_tokens,
    };
  }
}

// =============================================================================
// Cost estimate (Sonnet 4.6 pricing as of build time)
// =============================================================================

const SONNET_INPUT_PER_MTOK = 3.0;
const SONNET_OUTPUT_PER_MTOK = 15.0;
const CACHED_INPUT_DISCOUNT = 0.1;       // cached reads cost 10% of normal

export function estimateCost(verdict: LlmVerdict): number {
  const cached = verdict.cachedInputTokens || 0;
  const fresh = (verdict.inputTokens || 0) - cached;
  const out = verdict.outputTokens || 0;
  return (
    (fresh / 1_000_000) * SONNET_INPUT_PER_MTOK +
    (cached / 1_000_000) * SONNET_INPUT_PER_MTOK * CACHED_INPUT_DISCOUNT +
    (out / 1_000_000) * SONNET_OUTPUT_PER_MTOK
  );
}
