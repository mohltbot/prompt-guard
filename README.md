# Prompt Guard

> Context-aware prompt enhancement and corpus-grounded clarifying questions for AI coding agents.

Prompt Guard helps you write prompts that AI coding agents can act on first-shot — by reading your project context files (`PROJECT.md`, `CONTEXT.md`, etc.) AND by learning from your own past prompts to surface the specific clarifications that previously consumed iteration cycles.

## Two ways to use it

### 1. Static context injection (the original tool)

Reads `.md` files in your project and injects them into prompts before they go to the AI.

```bash
prompt-guard init                                # creates PROJECT.md + CONTEXT.md templates
prompt-guard check "refactor the auth system"    # flags missing files/tests/criteria
prompt-guard enhance "refactor the auth system"  # outputs an enriched prompt
```

### 2. Corpus-grounded clarification (new in v0.2)

Ingests your past conversations from Claude Code and Cowork, builds a local SQLite corpus, and uses Claude Sonnet 4.6 to propose clarifying questions grounded in *your* past prompts when you're about to send a new vague one.

```bash
prompt-guard ingest --source all                 # parses ~/.claude/projects + ~/Library/.../local-agent-mode-sessions
prompt-guard corpus stats                        # sanity-check the ingested data
prompt-guard learn "build the new feature for the acme pitch"
```

Example output:

```
PROMPT: "build the new feature for the acme pitch"

2 clarifying questions grounded in your corpus

Q1 [domain-context, conf=0.92]
  Which Acme-meeting automation area are you building — Agency Analytics Reporting,
  the SOP/workflow automation, or a new feature for the existing dashboard.py demo
  (like the ones rewritten for Globex Sports)?
  Grounded in:
    • id=5321: "Areas of the business they wanna automate: * CMO, CTO and the Acme..."
    • id=12244: "You need to rewrite the demo content generators in dashboard.py..."

Q2 [file-scope, conf=0.82]
  Is this going into the existing demo-project dashboard.py, or a new file/project?
```

## How it works

The corpus-grounded path is a six-stage pipeline:

1. **Ingest** — parses Claude Code JSONL and Cowork audit logs into `~/.prompt-guard/corpus.db`, applies hygiene filters (scheduled-task auto-runs excluded, tool-result envelopes filtered out, replay duplicates consolidated).
2. **Tag** — heuristic regex tags (files, tests, criteria, constraints, local-env, shape, ui) on every user prompt for retrieval and labeling.
3. **Extract** — rule-based extractor finds prompt pairs where the second user message clarified the first; LLM extractor (Sonnet 4.6) reviews and refines.
4. **Hand-label** — interactive TUI for marking a gold subset. The hand-labeled set is the eval-harness ground truth.
5. **Retrieve** — BM25 over SQLite FTS5, project-scoped with global fallback, synthetic-prompt filter at retrieval time.
6. **Generate** — Sonnet 4.6 with a tuned system prompt (v4: verb-disambiguation, anticipated-content, concrete-options-beat-abstract-categories, tightened skip rule) proposes up to 3 specific clarifying questions per prompt.

The eval harness scores generated questions against hand-labeled gold using jaccard-over-tokens + a kind-match floor.

## Baseline metrics (v0.2, May 2026)

On a 38-case hand-labeled gold subset from one developer's (Mohammed Wasif's) corpus:

| Metric | Value |
|---|---|
| Mean overlap@3 | **0.283** |
| Kind-match (any of top-3) | **50.0%** |
| Per-kind: domain-context | 0.397 (highest — taxonomy addition from hand-labeling discoveries) |
| Per-kind: success-criteria | 0.308 |
| Per-kind: file-scope | 0.241 |
| Per-kind: constraint | 0.097 (n=2, single-digit slice) |
| Total project cost | ~$5.30 of $15 cap |

See [SHIP.md](./SHIP.md) for the full results write-up, methodology, and limitations.

## Honest limitations

- **Corpus is small and skewed.** 38 hand-labeled pairs from one developer's work, 95% from one project (DemoSaaS). The system performs best on DemoSaaS-like prompts; cross-project retrieval works via fallback but is untested at scale.
- **Jaccard scoring has a soft ceiling.** ~5-10% of gold pairs are "inherent ceiling" cases where the clarification is strategic intent not inferable from the prompt alone. Maximum measurable overlap@3 is ~0.30-0.40 for jaccard.
- **Kind-match floor is brittle on boundary cases.** Questions that live on category boundaries (e.g. success-criteria vs other) can drift kind labels run-to-run, costing 0.4 score per case. Tracked as v0.5 refinement target.
- **Verb-disambiguation capture is 4-7/21.** When a prompt has a vague verb (set up / fix / improve / handle / build), the system fires a verb-disambiguation question ~20-30% of the time. Improvable.
- **Synthetic-prompt filter is reactive.** Regex-per-pattern. Will need refactor to a unified classifier at ~3 design partners.

## Architecture

```
prompt-guard/
├── src/
│   ├── index.ts                     # main PromptGuard class (static-context path)
│   ├── checks/                      # check registry pattern
│   │   ├── registry.ts
│   │   ├── types.ts
│   │   ├── files.ts                 # one file per check
│   │   ├── tests.ts
│   │   ├── criteria.ts
│   │   ├── constraints.ts
│   │   ├── local-env.ts
│   │   ├── context-window.ts
│   │   └── corpus-clarify.ts        # MVP-3 corpus-grounded check
│   ├── corpus/
│   │   ├── schema.ts                # SQLite schema + FTS5
│   │   ├── db.ts                    # opener + migrations
│   │   ├── reader.ts                # BM25 retrieval (CorpusReader)
│   │   ├── question-gen.ts          # Sonnet 4.6 adapter (v4 system prompt)
│   │   ├── llm-extractor.ts         # MVP-1.5 LLM extractor
│   │   ├── labeler.ts               # rule + outcome labelers
│   │   ├── snapshots.ts             # content-addressed code snapshot ingestion
│   │   ├── scoring.ts               # eval scoring (jaccard + kind-match floor)
│   │   ├── parsers/                 # Claude Code + Cowork JSONL parsers
│   │   └── heuristics.ts            # shared regex taggers
│   ├── eval/
│   │   ├── patterns.json            # vague-verb regex, live-vs-local detectors (config-driven)
│   │   ├── detect.ts                # instrumentation functions
│   │   └── shape-coverage-prompts.json
│   └── commands/                    # CLI commands
│       ├── ingest.ts
│       ├── stats.ts
│       ├── label-llm.ts
│       ├── label-gold.ts            # hand-label TUI
│       ├── backfill-reasons.ts
│       ├── dedupe-prompts.ts
│       ├── learn.ts
│       └── eval.ts
├── tests/                           # 15 jest tests
├── NOTES.md                         # design decisions + deferred items
├── CRITICAL_PATH.md                 # MVP roadmap with cost/wall estimates
├── ANNOTATION_GUIDELINES.md         # hand-labeling decision rules
└── SHIP.md                          # MVP-4 baseline results writeup
```

## Commands reference

```
prompt-guard <command> [options]

Static-context path:
  init                                          # scaffold PROJECT.md + CONTEXT.md
  check <prompt>                                # warn about missing context
  enhance <prompt>                              # output prompt enriched with .md context
  config                                        # show config
  stats                                         # show token budget + check status

Corpus path:
  ingest [--source claude-code|cowork|all]      # parse JSONL → SQLite
  corpus stats                                  # sanity-check the ingested corpus
  dedupe-prompts [--dry-run]                    # consolidate replay-duplicate rows
  label-llm [--retry-missing]                   # run LLM extractor on rule pairs
  backfill-reasons                              # fill missing reasons on existing LLM rows
  label-gold [--preview --limit N]              # hand-label TUI for gold subset
  learn "<prompt>"                              # generate clarifying questions
  eval --mode gold|shape-coverage|wide          # run baseline eval

Options:
  --db-path <path>                              # override ~/.prompt-guard/corpus.db
  --budget <usd>                                # cap LLM spend per eval run
  --verbose                                     # per-file progress
```

## Installation

Requires Node 18+, SQLite (included via `better-sqlite3`), and an Anthropic API key for the corpus-grounded path.

```bash
git clone https://github.com/prompt-guard/prompt-guard.git
cd prompt-guard
npm install
npm run build
echo "ANTHROPIC_API_KEY=sk-ant-..." >> ~/.env
```

## Privacy

- The corpus stays local in `~/.prompt-guard/corpus.db`. Nothing is uploaded without explicit opt-in.
- Static-context path is fully offline.
- Corpus-grounded path makes Anthropic API calls only when you run `learn` or `eval`. Past prompts retrieved by BM25 are sent to the API as context.

## License

MIT
