/**
 * QuestionGenerator — produces clarifying questions for a user's prompt,
 * grounded in past prompts retrieved from the corpus.
 *
 * Default impl: Claude Sonnet 4.6 via @anthropic-ai/sdk with prompt caching.
 * Adapter-pattern shape (matches ClarificationExtractor) so MVP-4+ can A/B
 * test cheaper providers (Deepseek, Moonshot) against Claude.
 */

import Anthropic from '@anthropic-ai/sdk';
import { loadHomeEnv } from './env';
import type { ClarificationKind, ClarifyingQuestion } from '../checks/types';
import type { RetrievedPrompt } from './reader';

export interface QuestionGenInput {
  prompt: string;
  retrieved: RetrievedPrompt[];
  /** Optional: known gold clarifications from retrieved pairs, for grounding examples. */
  exampleClarifications?: Array<{
    pastPrompt: string;
    pastClarification: string;
    kind: ClarificationKind;
  }>;
}

export interface QuestionGenResult {
  questions: ClarifyingQuestion[];
  skipReason?: string;
  // Diagnostics
  modelName: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  errorClass?: string;
  errorStatus?: number;
  errorMessage?: string;
}

export interface QuestionGenerator {
  name: string;
  generate(input: QuestionGenInput): Promise<QuestionGenResult>;
}

// =============================================================================
// System prompt — ≥1500 tokens for caching
// =============================================================================

const SYSTEM_PROMPT = `You are clarifying a developer's prompt BEFORE it is sent to an AI coding agent. Your job: identify the ≤3 specific disambiguations that would prevent the AI from misinterpreting the prompt.

The developer is about to ask an AI agent to do something. You've been given:
1. Their new prompt (PROMPT).
2. A small set of their past prompts from this codebase (PAST PROMPTS) retrieved via BM25 — useful context for what kinds of decisions they typically need to specify.
3. Optionally, past clarifications that fixed similar prompts (PAST CLARIFICATIONS) — concrete examples of the specifics they usually need to nail down.

Your output: 0–3 questions, each specific enough that the answer eliminates a real ambiguity.

# What makes a good clarifying question

GOOD questions are:
- **Specific disambiguations**: "Should this update the existing leads.md in mission-control, or create a new one in this project?"
- **Reference concrete past context**: "Use Globex Sports as the example client (like the Beta-Pets demo) or a different target?"
- **Answerable in <10 seconds** of human thought
- **About ONE concrete unknown** (kind: file-scope, success-criteria, constraint, data-shape, ui-detail, domain-context, other)

BAD questions are:
- "What do you want?" / "Can you be more specific?" (vacuous)
- "What does 'better' mean?" (correct topic, too vague to answer fast)
- Asking about something obvious from PROMPT itself
- Asking about something irrelevant to PROMPT
- More than 3 questions

# CRITICAL: concrete options beat abstract categories

When retrieved PAST PROMPTS name specific problems, files, features, bugs, URLs, or behaviors,
USE THOSE as answer options. Do NOT fall back to abstract categories that ask the user to do
the categorization work for you.

❌ BAD: "What specifically looks bad — layout/spacing, color scheme, or a particular page?"
   (User has to do the categorization themselves. Generic. Could apply to any UI prompt.)

✓ GOOD: "Which part — the cluttered metadata cards on /seo, the generic-looking nav from the
   'screen-share professional' build, or something else?"
   (Concrete options pulled from retrieved past prompts. User picks one in 5 seconds.)

The self-check: if you could substitute "category A, category B, or category C" into your
question and it still made sense, your question is too abstract. Re-anchor to specifics
from the corpus. Use real file names, real bug descriptions, real feature names, real URLs.

# Verb disambiguation — the #1 source of clarification debt

When the prompt's main verb is vague, **the highest-leverage clarification is what
that verb concretely means**. Vague-verb prompts are the dominant ambiguity pattern
in real developer corpora:

- **"set up X"** → could mean: write the logic, wire a scheduler, add a UI trigger, deploy it
- **"fix X"** → could mean: fix output quality, fix a runtime error, fix scope, fix something else
- **"improve X" / "make X better" / "look better"** → could mean: visual polish, performance, content quality, feature completeness
- **"handle X"** → could mean: catch errors, retry, log, alert
- **"build the new feature" / "do them all" / "do that"** → could mean: which of many possible items
- **"look at X" / "audit X"** → could mean: debug, review for quality, document, learn from

When the prompt's main action is a vague verb like the above, **prefer a verb-disambiguation
Q1** that proposes 2–3 concrete interpretations PULLED FROM CORPUS PATTERNS. The user picks
one in 5 seconds.

Example — prompt "set up the daily content generation":

✓ GOOD verb-disambiguation Q1:
"Does 'set up' mean: (a) write the daily-run logic inside dashboard.py, (b) wire a scheduler
like APScheduler/cron to call existing engines on a schedule, or (c) add a 'Daily' page with
a manual trigger?"

This is sharper than asking which file or which content type — it disambiguates the verb
FIRST, then file-scope and content-scope follow naturally from the answer. Verb-disambiguation
typically deserves the Q1 slot when the prompt is verb-vague.

# How many questions to output

Output AS FEW questions as the prompt needs. **Max 3 is a CEILING, not a target.**

- If ONE sharp question fully disambiguates → output 1.
- Add Q2 ONLY if it covers a DIFFERENT dimension from Q1 AND passes the Q2 redundancy check below.
- Add Q3 ONLY if it's independently sharper than skipping it.

Filling 3 slots with 1 sharp + 2 mediocre is WORSE than just the sharp one.

## Q2 redundancy check (strict)

Before emitting Q2, run this test:

> "If the user picks any of Q1's answer options, does that answer also resolve Q2?"

If yes → **DROP Q2**. The user only needs Q1.

Canonical bad case to avoid:
  Q1: "Which feature — Agency Analytics, the dashboard.py demo features, or something else from
       the meeting notes?"
  Q2: "Is this going into the existing dashboard.py or a new file/project?"

Q2 is redundant: if the user picks "dashboard.py demo features" in Q1, Q2's answer is "existing
dashboard.py" — already implied. If they pick "Agency Analytics" or another option, Q2 still gets
answered as a follow-up to Q1.

A valid Q2 should ask about something whose answer is NOT implied by Q1's options. Test: write
down what each of Q1's options would imply for Q2. If all paths lead to predictable Q2 answers,
Q2 is redundant — drop it.

# Anticipated content — when ORIG promises X next

When ORIG references content the user will provide NEXT — patterns like:
- "I'll send you X"
- "once you ingest Y, then Z"
- "after you read X, do Y"
- "I'll send the meeting notes / docs / message next"

The most useful clarification is about the **anticipated content (X/Y/Z)**, NOT the technical mechanism for receiving it. Don't ask how to access an iMessage app when the user already promised the meeting-notes content.

✓ GOOD anticipated-content question:
  ORIG: "ok take a look at the iMessage chat. once u ingest that, ill send u meeting notes from when i met them"
  Q1: "What's likely in the meeting notes you'll send next — agency requirements, technical specs, or relationship/business context?"

❌ BAD (focuses on receiving mechanism, ignores promised future content):
  Q1: "Do you want the AI to access iMessage directly, or are you pasting the message content?"

**Caveat (don't over-fire this rule):** if ORIG ALSO asks an immediate tactical question that needs answering NOW (e.g. "before you read that — should the existing code be preserved?"), the immediate tactical question still wins. Anticipated-content is usually higher-leverage, but not always.

# When to output ZERO questions

Skip ONLY when **ALL THREE** of the following are true:

(a) PROMPT explicitly names files, directories, or modules (specific paths, not vague references like "the file")
(b) PROMPT explicitly states constraints ("don't X", "without Y") OR measurable success criteria ("must achieve X", "should pass Y")
(c) PROMPT has a clear strategic outcome — target audience/vertical, business goal, or what success looks like at the user-visible level

**Length is NOT a substitute for completeness.** A long detailed tactical prompt that lacks any one of (a), (b), (c) is STILL clarifiable. The dominant failure mode in this corpus is the system seeing a 2000-char research/instruction prompt and concluding "self-contained" when it actually lacks strategic direction.

Examples of prompts that DO need clarification despite being detailed:
- A 2000-char research-instruction prompt that lists 13 GitHub repos to scan and 4 categories to surface — but never says WHO the research is for or WHAT decision it will drive → ask about target audience or strategic outcome (this is a real failure mode that prompted this rule)
- A 500-line refactor brief that names every file and constraint but doesn't say what the user-visible outcome should be → ask about success criterion

Examples that genuinely don't need clarification:
- "Update src/auth/login.ts to use JWT refresh tokens with 24h expiry, don't break the /api/v1/auth endpoint, add Jest tests for happy-path and 401" (file ✓, constraint ✓, implicit success criterion ✓, scope is the file)
- "Fix the off-by-one in dashboard.py:312 — should iterate through all 12 features, not 11" (file ✓, exact constraint ✓, exact criterion ✓)

Outputting 1-3 mediocre questions when prompt is genuinely clear is worse than outputting zero. But outputting zero on a long-detailed-but-strategically-vague prompt is ALSO wrong.

# Kinds (canonical)

- **file-scope**: clarifies WHICH files/dirs/modules to touch
- **success-criteria**: clarifies WHEN done / WHAT pass means / target metrics
- **constraint**: clarifies what NOT to do / must NOT change ("don't", "never", "without")
- **data-shape**: clarifies a type/schema/columns/fields
- **ui-detail**: clarifies visual or interaction specifics
- **domain-context**: clarifies external grounding — meeting notes, research sources, example clients, deployment infra
- **other**: real clarification not fitting the above (should be rare)

Pick the kind that best describes WHAT the question is asking about.

# Grounding

For each question, populate \`grounded_in\` with the prompt_ids from PAST PROMPTS that informed the question. If grounding is from general reasoning (no specific past prompt anchored the question), grounded_in can be empty.

# Worked examples

## Example 1 — clear file-scope question grounded in past file paths

PROMPT: "fix the seo content engine"

PAST PROMPTS (top 3):
[id=137] turn 1031: "You are an expert SEO analyst. Generate a complete SEO content pipeline output for keyword 'mobile pet grooming Houston' for fictional client website..."
[id=1141] turn 1141: "I need you to rewrite the file \`/sessions/demo-session/mnt/outputs/demo-project/demo_output_ad_copy_beta-pets.md\` to fix quality issues..."
[id=2181] turn 2181: "Read the entire file /sessions/demo-session/mnt/outputs/demo-project/dashboard.py (3681 lines). This is a Flask dashboard for DemoSaaS..."

PAST CLARIFICATIONS:
- (kind=file-scope) "use Globex Sports as the new target client/example"
- (kind=file-scope) "modify \`dashboard.py\` and \`engine.py\`, not the test files"

GOOD OUTPUT:
{
  "questions": [
    {
      "text": "Which file specifically — seo_content_engine.py in demo-project, or the dashboard.py /seo route?",
      "kind": "file-scope",
      "grounded_in": ["1141", "2181"],
      "confidence": 0.85
    },
    {
      "text": "What's broken — output quality (like the ad copy rewrite) or a runtime error?",
      "kind": "success-criteria",
      "grounded_in": ["1141"],
      "confidence": 0.7
    }
  ]
}

## Example 2 — no questions needed

PROMPT: "Update src/auth/login.ts to issue JWT refresh tokens with 24h expiry. Don't change the response shape of /api/v1/auth. Add Jest tests covering happy-path and 401 cases."

GOOD OUTPUT:
{
  "questions": [],
  "skip_reason": "PROMPT names the file, the exact change, the constraint (don't change response shape), and the test coverage. No ambiguity worth clarifying."
}

## Example 3 — ONE sharp question is enough (no padding to fill slot 2)

PROMPT: "fix the seo content engine"

PAST PROMPTS:
[id=1141] "I need you to rewrite the file \`/sessions/.../demo_output_ad_copy_beta-pets.md\` to fix quality issues..."
[id=2244] "You need to rewrite the demo content generators in \`dashboard.py\` (3717 lines)... embarrassingly low-quality placeholders..."

GOOD OUTPUT (one question only — adding a Q2 about file scope would be redundant since
"seo content engine" already names the target; adding a Q2 about urgency would be generic):
{
  "questions": [
    {
      "text": "Same 'embarrassingly low-quality placeholders' problem you rewrote dashboard.py for, or a different issue with seo_content_engine.py (e.g. runtime error, missing keyword scoring, wrong output format)?",
      "kind": "success-criteria",
      "grounded_in": ["2244"],
      "confidence": 0.9
    }
  ]
}

## Example 4 — domain-context question

PROMPT: "build the new feature for the acme pitch"

PAST PROMPTS:
[id=903] turn 903: "Areas of the business they wanna automate: * CMO, CTO and the Acme co-founders were there. it was one of the best most synergetic convos ive had in my life..."
[id=2535] turn 2535: "You need to add an 'Agentic Campaign Builder' page and backend to \`dashboard.py\`..."

PAST CLARIFICATIONS:
- (kind=domain-context) "meeting notes from in-person with Acme co-founders: key automation areas include reporting, SOPs, web dev, image gen"
- (kind=file-scope) "add Agentic Campaign Builder page and backend to dashboard.py"

GOOD OUTPUT:
{
  "questions": [
    {
      "text": "Which Acme-meeting area are you building — reporting agent, SOP/workflow Claude, or the Agentic Campaign Builder page on dashboard.py?",
      "kind": "domain-context",
      "grounded_in": ["903", "2535"],
      "confidence": 0.9
    },
    {
      "text": "Is this going into the existing demo-project/dashboard.py or a new project?",
      "kind": "file-scope",
      "grounded_in": ["2535"],
      "confidence": 0.75
    }
  ]
}

# Output

Use the submit_questions tool. Be honest about when questions aren't needed (empty array + skip_reason). Quality > quantity: 1 sharp question beats 3 mediocre ones.`;

const QUESTIONS_TOOL: Anthropic.Tool = {
  name: 'submit_questions',
  description: 'Submit clarifying questions (or skip with reason) for the developer\'s prompt.',
  input_schema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        maxItems: 3,
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The clarifying question, ≤200 chars.' },
            kind: {
              type: 'string',
              enum: ['file-scope', 'success-criteria', 'constraint', 'data-shape', 'ui-detail', 'domain-context', 'other'],
            },
            grounded_in: {
              type: 'array',
              items: { type: 'string' },
              description: 'prompt_ids from PAST PROMPTS that informed this question. Empty array allowed.',
            },
            confidence: { type: 'number', description: '0..1' },
          },
          required: ['text', 'kind', 'confidence'],
        },
      },
      skip_reason: {
        type: 'string',
        description: 'Required if questions array is empty. One sentence explaining why no clarification is needed.',
      },
    },
    required: ['questions'],
  },
};

// =============================================================================
// Build the user message — retrieved prompts + optional clarifications
// =============================================================================

const MAX_RETRIEVED_CHARS = 600;

function truncate(s: string): string {
  return s.length <= MAX_RETRIEVED_CHARS ? s : s.slice(0, MAX_RETRIEVED_CHARS) + '… [truncated]';
}

function buildUserMessage(input: QuestionGenInput): string {
  const parts: string[] = [];
  parts.push(`PROMPT:\n"${input.prompt}"`);
  parts.push('');

  if (input.retrieved.length > 0) {
    parts.push('PAST PROMPTS (top retrieved from your corpus):');
    for (const r of input.retrieved.slice(0, 8)) {
      parts.push(`[id=${r.promptId}] (${r.projectName || '?'}, turn ${r.turnIndex}): "${truncate(r.content)}"`);
    }
    parts.push('');
  }

  if (input.exampleClarifications && input.exampleClarifications.length > 0) {
    parts.push('PAST CLARIFICATIONS (concrete examples of how you typically nail down ambiguities):');
    for (const c of input.exampleClarifications.slice(0, 6)) {
      parts.push(`- (kind=${c.kind}) "${truncate(c.pastClarification)}"`);
    }
    parts.push('');
  }

  parts.push('Use the submit_questions tool. Be honest about skip_reason if no clarification is warranted.');
  return parts.join('\n');
}

// =============================================================================
// Claude default implementation
// =============================================================================

export class ClaudeQuestionGenerator implements QuestionGenerator {
  readonly name = 'claude-sonnet-4-6';
  private client: Anthropic;

  constructor(opts?: { maxRetries?: number }) {
    loadHomeEnv();
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is not set. Add it to ~/.env or export it in your shell.');
    }
    this.client = new Anthropic({ maxRetries: opts?.maxRetries ?? 8, timeout: 120_000 });
  }

  async generate(input: QuestionGenInput): Promise<QuestionGenResult> {
    const startedAt = Date.now();
    let response: Anthropic.Messages.Message;
    try {
      response = await this.client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 800,
        system: [
          { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
        ],
        tools: [QUESTIONS_TOOL],
        tool_choice: { type: 'tool', name: 'submit_questions' },
        messages: [{ role: 'user', content: buildUserMessage(input) }],
      });
    } catch (e) {
      const err = e as { status?: number; constructor?: { name: string }; message?: string };
      const msg = e instanceof Error ? e.message : String(e);
      return {
        questions: [],
        skipReason: `LLM API error: ${err.constructor?.name || 'Unknown'}${err.status !== undefined ? `(${err.status})` : ''}`,
        modelName: this.name,
        latencyMs: Date.now() - startedAt,
        errorClass: err.constructor?.name,
        errorStatus: err.status,
        errorMessage: msg,
      };
    }

    const latency = Date.now() - startedAt;
    const toolUse = response.content.find(b => b.type === 'tool_use');
    if (!toolUse || toolUse.type !== 'tool_use') {
      return {
        questions: [],
        skipReason: 'LLM did not use submit_questions tool',
        modelName: this.name,
        latencyMs: latency,
      };
    }

    const args = toolUse.input as {
      questions?: Array<{ text: string; kind: ClarificationKind; grounded_in?: string[]; confidence: number }>;
      skip_reason?: string;
    };

    const questions: ClarifyingQuestion[] = (args.questions || []).map(q => ({
      text: q.text,
      kind: q.kind,
      groundedIn: (q.grounded_in || []).map(id => ({
        sessionId: '',  // resolved by caller via prompt_id lookup if needed
        promptId: parseInt(id, 10),
        snippet: input.retrieved.find(r => r.promptId === parseInt(id, 10))?.content.slice(0, 100) || '',
      })),
      confidence: q.confidence,
    }));

    const usage = response.usage;
    return {
      questions,
      skipReason: args.skip_reason,
      modelName: this.name,
      latencyMs: latency,
      inputTokens: usage?.input_tokens,
      outputTokens: usage?.output_tokens,
      cachedInputTokens: (usage as { cache_read_input_tokens?: number })?.cache_read_input_tokens,
    };
  }
}
