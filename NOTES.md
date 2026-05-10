# Prompt Guard — long-term notes

Tracking decisions and known limitations that are intentionally deferred.
Items here are NOT bugs to fix immediately — they're flagged so they don't
get lost when we revisit.

---

## Corpus diversity

v0 is **DemoSaaS-flavored.** ~95% of hand labels (and ~80% of clarifying
pairs) come from the DemoSaaS Automation Cowork session. That's expected
and fine for testing the system end-to-end.

When we onboard design partners (~3+ different users), their corpora should
naturally diversify the question-generation patterns. Do **NOT** artificially
diversify by including scheduled-task auto-runs or low-quality interactions
just to broaden the project list — that adds noise, not signal.

Re-evaluate the question-generation prompt's in-context examples once we
have ≥2 design partners' data; the DemoSaaS examples may not generalize.

## Synthetic-prompt filter is reactive

The `isSyntheticPrompt` function in `src/corpus/labeler.ts` is intentionally
a regex-per-pattern detector. Each new corpus will need its own round of
paste-back / harness / shell pattern filters. v0 fine.

**Refactor trigger:** ~3 design partners OR ~15 patterns total in
`isSyntheticPrompt`, whichever comes first.

**Refactor approach when we hit it:**
- Use the cleaned hand-labeled gold subset as training data (positive
  examples = real Mohammed prompts; negative examples = harness / paste-backs)
- Light-weight classifier first: gradient-boosted on text features
  (length, alpha-ratio, first-line shape, structural tokens) — likely
  good enough and zero per-call cost
- Fallback to a small Sonnet structured-output call if the classifier
  precision plateaus. Avoid the per-prompt API cost in the labeler — use
  it only for borderline cases the classifier is uncertain about

## Title-based project linkage failure modes

Documented in chat (commit message references "title collision walkthrough").
Summary:
- **Over-segmentation** (most common in current corpus) — different titles
  for the same project. Falls through to global retrieval. Acceptable.
- **Under-segmentation** (rare in current corpus) — generic titles like
  "Untitled session" merge unrelated projects. Currently zero incidents.
- **Title shifts mid-iteration** — Cowork rename loses history.

Detection (NOT building yet): `prompt-guard corpus stats` could surface
"suspicious clusters" of projects with shared rare bigrams or content
overlap. Manual mitigation: `prompt-guard project merge <id1> <id2>`
(also not built yet).

## Per-turn snapshots (deferred to v1.1)

v0 does per-session granularity (one outputs/ snapshot per Cowork session).
Per-turn snapshots via `file-history-snapshot` events are v1.1 once we
verify those events exist in Cowork audit.jsonl.

Current limitation: a Cowork session with 300 user prompts yields ONE
snapshot. We can compute file-tree diff between sequential snapshots
(across sessions in same project), not within a session.

## Trash basename ↔ project linkage

v0 ingests all `.Trash` directories with code, then matches to projects
via content_hash Jaccard overlap (>= 0.5) inside the outcome labeler.

**Empirical result on the developer's corpus (v0):** trash data ingests cleanly
(5 snapshots, 73 files) but `rejected` count is 0. Reason: hash-Jaccard
between DemoSaaS's session snapshot and the closest trash snapshot is
0.42 (below 0.5 threshold). This is **accurate, not a bug** — the
DemoSaaS session ITERATED PAST the reverts (kept ~8 files unchanged
from trash but added 40+ more), ending at a new accepted state.

The trash signal is still preserved in `code_snapshots` and `code_files`.
v1.1 will use it via per-turn `file-history-snapshot` replay: for each
clarifying pair, check if the session's state shortly after the
clarifying turn matches a trash snapshot. That gives turn-granular
"what got reverted" signal even when session-final state doesn't match.

Threshold tuning: if at ≥3 design partners the corpus shows real
session-ends-in-revert patterns, lower threshold to 0.3 or use a
basename-Jaccard secondary signal. NOT now — current 0 is correct
for current corpus.

## Re-ingest reliability (FK constraint failure on largest sessions)

Observed: re-running `prompt-guard ingest` on an existing DB fails
with `FOREIGN KEY constraint failed` on the 2 biggest sessions
(DemoSaaS + Eval AI marketing). Fresh ingest (after `rm corpus.db`)
works cleanly.

Suspected cause: transaction-internal interaction between the prompts_fts
trigger and the delete-then-reinsert path for large sessions. Not yet
reproduced in isolation.

Workaround: nuke + fresh ingest. Acceptable since ingest takes 1.4 sec.

Fix priority: low. Ingest is rarely re-run during normal workflow
(only when the parser changes, which is dev-time).

## Embeddings retrieval (deferred — keep BM25 until backtest demands)

Q2 decision: BM25 for v0, embeddings only if backtesting shows retrieval
is the bottleneck. The schema already accommodates a sibling `prompts_vec`
table; no migration needed when we add it. Likely candidates:
- `sqlite-vec` extension (single-file, in-process) — recommended
- `chromadb` / `faiss` — if we need ANN at >100k vectors

## Forward-going capture (`prompt-guard accept`) — MVP-5 scope

Captures user-confirmed prompt → output pairs. Schema supports this via
`source='manual'`, `snapshot_type='forward-accept'`. Build during MVP-5,
not before.
