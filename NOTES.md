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

## Synthetic-prompt filter is reactive — SCHEDULED post-MVP-4

**Status promoted from "tracked" to "scheduled refactor" (2026-05-10):**
The regex-per-pattern synthetic-prompt filter has now bitten v0 development
THREE times in distinct subsystems:

1. **Rule extractor** (MVP-1) — paste-backs, session-resumes, harness messages
   inflating false-positive clarifying-pair count
2. **Hand-labeling** (MVP-1.5) — same patterns surfacing as gold candidates;
   required re-tuning before labeling could start
3. **BM25 retrieval** (MVP-3) — same patterns dominating top-K results,
   crowding out real signal; required a third copy of the filter

Three occurrences in three subsystems crosses the threshold from "track and
defer" to "schedule and ship." Promoting this from v1 refactor target to the
**next-priority refactor after MVP-4 ships.**

**Original refactor trigger** (~3 design partners OR ~15 patterns) — superseded.

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

## Taxonomy gap: `other` kind may indicate a missing category

The 5-kind taxonomy (file-scope, success-criteria, constraint, data-shape,
ui-detail) was designed for direct code-spec clarifications. Empirically
during the MVP-1.5 LLM dry-run, three pairs landed in `other`:

All three were **Acme meeting recap** content — the developer's CLAR contained
meeting notes from the in-person session, providing domain context
(business areas to automate, client priorities, real-world constraints)
that the ORIG anticipated but couldn't itself encode. These ARE real
clarifications — they grounded the AI in business context the ORIG lacked
— but don't fit any of the 5 spec-y kinds.

**Hypothesis:** the `other` cluster represents a missing kind like
`external-context` or `domain-grounding` — clarifications that resolve
ambiguity by adding real-world facts/conversations/decisions, rather than
code-spec precision.

**Plan:** during the 100-pair hand-labeling pass, pay attention to whether
`other`-tagged pairs cluster around a coherent missing concept. If they
do, that's a v0.5 schema addition (one new value in the
`clarification_kind` check constraint, no breaking changes). Revisit
after hand-labeling.

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

### Mohammed-specific behavioral pattern: reverted-then-iterated-past

The 0-rejected outcome is itself a Mohammed-specific signal. He reverts
mid-session, keeps the salvageable parts, and continues forward. A
session-end snapshot rarely matches an exact reverted state because by
session's end he's iterated past it.

**Use this as a v1.1 per-turn analysis target.** Once we have
`file-history-snapshot` replay (v1.1 scope), for each clarifying pair:
- Find the timestamp of the next trash snapshot for that project
- If trash creation is within 30-60 minutes after the clarifying turn,
  the clarifying pair likely captures a "what failed and got reverted"
  signal — much higher value for the eval harness than generic pairs

This is "blast radius" detection at turn granularity. The most
informative clarifying pairs are those that PRECEDE a revert by < 1
hour. Higher gold weight; surface these in the hand-label TUI first
when v1.1 lands.

The trash signal is still preserved in `code_snapshots` and `code_files`.
v1.1 will use it via per-turn `file-history-snapshot` replay: for each
clarifying pair, check if the session's state shortly after the
clarifying turn matches a trash snapshot. That gives turn-granular
"what got reverted" signal even when session-final state doesn't match.

Threshold tuning: if at ≥3 design partners the corpus shows real
session-ends-in-revert patterns, lower threshold to 0.3 or use a
basename-Jaccard secondary signal. NOT now — current 0 is correct
for current corpus.

## MVP-4: kind-match floor is brittle to LLM kind-classification drift (2026-05-10)

Two regressions in run_id=4 (post-patch gold re-run) were **pure kind-drift on
boundary cases**, not content quality drops:

- Pair 406: question content essentially unchanged; kind drifted `success-criteria` → `other`. Score dropped 0.500 → 0.065.
- Pair 384: question structure preserved; kind drifted `success-criteria` → `domain-context`. Score dropped 0.500 → 0.116.

Both questions live on category boundaries (e.g. "is this a success criterion or a domain-context question?") where the LLM's classification is inherently noisy. KIND_MATCH_FLOOR (currently 0.5) acts as a binary cliff at the kind boundary — get it right, score 0.5+; get it wrong, score = pure token overlap (~0.05-0.15).

**Real signal:** the metric is part of what's being evaluated, not just the system.
A baseline change to the system prompt can move kind labels without changing
question utility. v0.5 refinement targets:

1. **Lower the floor** (try 0.3 instead of 0.5) — more graduated, less binary
2. **Semantic similarity instead of jaccard** — embedding-based overlap is less sensitive to kind boundaries
3. **Kind-set match instead of exact match** — give partial credit for adjacent kinds (e.g. success-criteria ↔ other = 0.7, success-criteria ↔ ui-detail = 0)

Don't fix now. Track as v0.5 metric refinement target after MVP-4 ships.

## MVP-4 process lesson: don't block headline gains for narrow-slice metrics (2026-05-11)

After v4 patches improved overlap@3 from 0.21 → 0.28 (+33%) but reduced verb-disam capture from 6/21 to 3/21, I (Claude) initially pushed for a tune (v3.1) to restore verb-disam capture. Mohammed correctly pushed back:

> "0.280 vs 0.235 is meaningful (19% headline metric), and the verb-disam 'regression' is measured on a 21-case slice that's noisy relative to the 38-case overall. Trading 19% of the integrated signal to recover count on one slice is a bad trade."

**Lesson logged:** don't block headline-metric improvements to preserve narrow slice metrics, especially when slice n is small. The eval harness aggregates for a reason. The kind-match-floor + jaccard scoring rewards strategic-axis reallocation (which v4 produced) over verb-disam pattern matching.

When tempted to "fix" a slice regression that came alongside a meaningful headline gain:
1. Check slice n. If n < 30, the slice is statistically noisy.
2. Check whether the slice loss is content quality or measurement artifact.
3. Compare slice loss × slice_n vs aggregate gain × case_n. If the trade is positive on weighted aggregate, ship.
4. If still unsure, log the slice as a v0.5 target and let real-world use surface whether the slice loss matters.

## MVP-4 wide-eval pool was zero after content-dedupe (2026-05-11)

When implementing `--mode wide` for confirmation eval, the query for "LLM-extracted pairs that don't have a content-equivalent manual gold label" returned **zero cases**. After in-session content-dedupe (the v0 fix for replay artifacts), every LLM-accepted pair maps 1:1 to a manual gold label.

**This is structurally informative, not a bug:**
- the developer's 90-min hand-labeling covered the full extractor-accepted space after dedupe
- LLM extractor filtering was well-calibrated to his judgment
- The "gold subset ⊂ wide pool" framing from the original design doesn't apply to this corpus

**Implication:** the 38-case gold eval IS the full eval. The 0.283 overlap@3 baseline is the population number for v0, not a sample. Wide-eval confirmation as originally scoped is moot until corpus grows beyond the hand-labeled set (real-world forward-going `prompt-guard accept` captures or design-partner data).

**v0.5 implication:** when corpus grows past hand-labeled, wide eval will become meaningful again. Re-enable then.

## v0.5 prompt-engineering targets (post-MVP-4)

1. **Verb-disam recovery without overlap@3 regression** — v3.1 attempt showed it's harder than expected. Likely needs careful study of when verb-disam should override anticipated-content vs when both should fire.
2. **Kind-match floor brittleness** — pair 406, 384 pattern shows kind classification drift on boundary cases costs 0.4 score per case. Consider: lower floor to 0.3, semantic similarity, or kind-set match.
3. **Inherent-ceiling cases** — pair 389 pattern. Document the fraction in baseline reports so expectations are right-sized.

## MVP-4 v3.1 re-run expectations (2026-05-11)

Tune scope: option (b) — verb-disambiguation and anticipated-content framed as
orthogonal axes, both fire when both signals present.

Success criteria for the re-run:
- **Verb-disam capture ≥ 6/21** (return to baseline or better). If still 3/21, the fix didn't work — pause.
- **Mean overlap@3 ≥ 0.28** (don't lose the +33% patched gain)
- **No NEW regressions** beyond the kind-drift on 406/384 (which we're accepting as metric artifact)

If all three hold → wide eval as confirmation. If any degrades → pause and re-diagnose.

## MVP-4 baseline diagnostic: inherent-ceiling cases (2026-05-10)

A subset of gold pairs have clarifications the system cannot predict from ORIG alone — gold captures STRATEGIC INTENT that wasn't in the prompt at all. **Pair 389** is the canonical example:
- ORIG: 3 URLs (`https://demosaas.com/` + 2 tweets)
- GOLD clarification: *"goal is to show up to the meeting with automations already built, backed by extensive research — not just a plan"*
- The strategic intent only exists in filtered-out session-resume preambles (id=10988)
- 3 URLs produce no usable BM25 tokens

These cases set a soft ceiling on overlap@3 around 0.30-0.40 for jaccard-based scoring. Expected rate in the developer's corpus: ~5-10% of gold pairs.

**Handling rule:**
- Tag inherent-ceiling cases at eval time so they can be excluded from headline metrics OR scored separately
- v0.5: add `inherent_ceiling` boolean to `eval_cases`; detection heuristic = (ORIG length < 100 chars OR ORIG is URL-only) AND (retrieval returns 0-2 results)
- Track over time: as corpus grows, fewer cases stay inherent-ceiling (more retrieval signal accumulates)

## Domain-context taxonomy addition has empirical ROI (2026-05-10)

The `domain-context` kind was added as a v0.5 taxonomy expansion after hand-labeling surfaced 8 pairs in `other` that clustered around external grounding (meeting notes, deployment infra, research sources, example clients).

**Empirical result on MVP-4 baseline (run_id=1, n=38 gold):**
- domain-context overlap@3: **0.375** (highest of all kinds)
- vs. file-scope: 0.147
- vs. success-criteria: 0.207
- vs. constraint: 0.107 (n=2, single-digit slice)

**This is direct evidence** that the labeling pass had ROI: the new kind discovered from hand-labeling outscored every pre-existing kind by 47-260%. Cite when presenting the methodology.

## Taxonomy expansion: domain-context kind (2026-05-10)

The 6-kind taxonomy (file-scope / success-criteria / constraint / data-shape /
ui-detail / other) leaked ~25% of LLM-accepted pairs into the catch-all "other"
bucket. the developer's 9 → 8 (post-dedupe) `other` labels in the gold subset
clustered around a coherent missing concept: **external grounding**.

**New kind: `domain-context`.** Definition: CLAR delivers external context
that grounds the AI in resources, sources, examples, infrastructure choices,
or business background ORIG referenced but did not include. Distinguishes
from `file-scope` by being EXTERNAL (research sources, deployment targets,
customer info) vs internal codebase paths.

**Migrated (broad interpretation, 2026-05-10):** all 8 `other` labels in
gold subset reclassified to `domain-context`. New distribution:
- file-scope: 14
- success-criteria: 13
- domain-context: 8  ← new slice, 21% of gold
- constraint: 2
- rejected: 1

**LLM extractor v1.1 (system prompt + tool schema):**
- Added `domain-context` to the `submit_verdict` tool's `kind` enum
- Added explicit kind definition + 5 example sub-patterns in the system prompt
- Updated disambiguation priority order: file-scope > domain-context > constraint > success-criteria > data-shape > ui-detail > other
- Result: future LLM calls can now output `domain-context` directly; should reduce `other` usage to near-zero

**Validation deferred:** A/B test against gold subset comes with MVP-3 first
question-gen pass. Same Sonnet 4.6 + system-prompt style validates both
extractor-v1.1 and question-gen prompt simultaneously.

## LLM extractor v1 system-prompt tuning (2026-05-10)

After the developer's 38-pair hand-label session, kind-override rate was 73% (27 of
37 accepts). Three dominant correction patterns drove the v1 tuning:

| Pattern (LLM → Mohammed) | Count | Root cause |
|---|---|---|
| `other` → `file-scope` | 13 | LLM downgrading to "other" when CLAR added context, even though concrete files were named |
| `success-criteria` → `other` | 8 | LLM over-detecting criteria for context-delivery CLARs (meeting notes, etc.) |
| `constraint` → `success-criteria` | 3 | LLM treating positively-phrased required behaviors as constraints |

**v1 system prompt changes (src/corpus/llm-extractor.ts):**
1. Strengthened **file-scope** definition with concrete signal list (filenames, dirs,
   module names, file-naming patterns) + explicit "don't downgrade to other just
   because CLAR also adds context."
2. Tightened **success-criteria** to require positive measurable language; explicitly
   redirected context delivery to `other`.
3. Tightened **constraint** to require negative phrasing only; positive required
   behaviors are success-criteria.
4. Added a **disambiguation priority** section listing the order to apply when
   multiple kinds could fit.

**Not yet validated:** v1 system prompt has NOT been A/B tested against v0. To
validate without losing the existing 38-pair gold subset:
1. Add a `--extractor-version` flag to `label-llm` that tags rows
2. Re-extract a sample of, say, 20 random pairs under v1
3. Compare v1 verdicts to the developer's manual labels on those pairs
4. If v1 override rate drops below ~30%, ship v1 as default

Deferred until MVP-3 begins (question-gen reuses the same model + system-prompt
style, so v1 calibration validates two things at once).

## Parser duplicates user messages on Claude Code replay events

**Bug surfaced during MVP-1.5 hand-labeling (2026-05-10):** Claude Code emits
each user message twice in JSONL when a session is resumed/replayed. Both events
share the same `uuid` but the replay version carries `isReplay: true` plus a
later `_audit_timestamp`. My parser ingests both as distinct `prompts` rows
with sequential `turn_index` values. Same artifact for assistant turns (often
appears as empty-content duplicate rows).

**Concrete example (DemoSaaS session `c8099551`):**
- turn 26 (prompt_id 9947): "do them all, fix it permanently…" at 14:42:41
- turn 27 (prompt_id 9948): "do them all, fix it permanently…" at 14:43:27
- Both have uuid `5602c01f-887c-4dc2-b784-0094f7c58b33`. turn 27 has `isReplay: true`.

**v0 mitigation (done):** Content-equality dedupe at gold-extraction time in
`label-gold.ts`. Partitions LLM-accepted pairs by `(session_id, orig.normalized_content,
clar.normalized_content)`. Catches replay-duplicates without touching prompt
rows. Manual labels are also content-deduped — a label on ANY content-equivalent
pair counts as labeling all of them.

**v0.5 fix (deferred — requires re-ingest):** Add `if (ev.isReplay === true)
continue;` to both `parsers/claude-code.ts` and `parsers/cowork.ts`. This is
the correct root-cause fix. Postponed because re-ingest invalidates existing
prompt_ids, which breaks foreign keys in manual labels and LLM verdicts. Plan
for v0.5:
1. Capture current manual labels by content hash (not prompt_id)
2. Re-ingest with isReplay filter
3. Restore manual labels via content match against new prompt_ids
4. Optionally re-run LLM extractor on cleaned corpus (~$3, ~30 min)
5. Drop content-equality dedupe in label-gold (no longer needed)

## Self-referential project exclusion

**Lesson from MVP-1.5 hand-labeling (2026-05-10):** The prompt-guard project's
own Claude Code session JSONLs (from building prompt-guard itself) appeared in
the corpus. Pairs extracted from these sessions look LIKE clarifications —
they have sequential ORIG/CLAR turns, the LLM accepts them as constraints or
decisions, the kind regexes match — but they are not "user was vague then
specified more about a product." They are meta-conversation between Mohammed
and Claude planning the very build that produced the corpus. Treating them as
gold contaminates the eval harness because the corpus-clarify check would
learn to mimic meta-planning patterns instead of product-clarification patterns.

**Fix in `label-gold.ts`:** SQL clause `EXCLUDED_PROJECT_CLAUSE` filters out
any project whose `name = 'prompt-guard'` OR `cwd LIKE '%prompt-guard%'` from
the gold-extraction pool and from progress counters. Existing manual rows on
excluded projects are preserved as orphan records (they capture the labeler's
judgment that those pairs were noise — itself a useful signal).

**Generalization for v0.5:** Make the excluded-projects list configurable
via `.prompt-guard.json` `excludedProjects: string[]`. Recursive build-context
contamination will recur on any tool building itself, so a generic mechanism
beats the current hardcoded prompt-guard match.

**Rule for future corpora:** When ingesting a developer's history into Prompt
Guard, ALWAYS exclude the prompt-guard project from gold consideration. Add
similar exclusions for any project that is the tool being built (e.g., a Cursor
plugin's own development conversation when ingested into Cursor's corpus).

## External-API operations — default to sequential

**Lesson learned during MVP-1.5 (2026-05-10):** Ran the LLM extractor at
concurrency 5 on a fresh Tier-1 Anthropic API key. Result: 154 of 279
requests hit errors (55% failure rate) under sustained rate-limit pressure.
The SDK's default `maxRetries: 2` was insufficient — retries exhausted,
errors surfaced. Mohammed correctly flagged that I'd diagnosed the cause
("probably rate limits") without evidence and that I should not retry
without first checking.

**Rule:** For any new external-API operation against an unverified
account/tier, the safe default is `--concurrency 1`. Move to higher
concurrency only AFTER verifying empirical headroom (process a small
batch sequentially, watch latency, then test concurrency 2, etc).

**Also fixed in the same pass:**
- `LlmVerdict` now persists `errorClass` and `errorStatus` so that future
  failures can be diagnosed by HTTP code rather than guessed at
- Bumped `maxRetries: 2` → `maxRetries: 8` on the Anthropic client. The
  SDK already honors `retry-after` headers and does exponential backoff
  on 408/409/429/5xx; this just gives it more attempts before giving up
- Error-breakdown table in the run summary surfaces error class+status
  counts instead of one opaque `API errors: N` total

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
