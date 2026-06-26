# BetterCode — Key Design Decisions

These answer the ten decisions called out in the brief. Each is a recommendation
with rationale and the tradeoff we accepted. Code references these by number
(e.g. `DECISIONS.md #5`).

## #1 — Respond to every question-like message, only app mentions, or both?

**Both, gated by channel mode.** App mentions (`@BetterCode …`) are *always*
answered in a configured channel. Free-floating question-like messages are
answered **only** when the channel is `mode: auto`, and only after passing a
cheap local heuristic (`looksLikeQuestion`) plus — at the worker — the model's
own intent judgment.

*Why:* mentions are an unambiguous "answer me" signal with near-zero false
positives. Auto-answering every question is high value in a dedicated support
channel but high risk (noise, cost) in a general channel, so it's opt-in per
channel. Two-stage gating (cheap heuristic at ingress → LLM intent at worker)
keeps us from spending tokens on "thanks!" and "lgtm".

*Tradeoff:* auto mode can still mis-fire on rhetorical questions; mitigated by
rate limits and the model declining off-topic asks.

## #2 — Repo refresh per question, scheduled, or webhook?

**Per-question `git fetch + reset --hard` on a plain clone.** Every job syncs
the clone in `/tmp/bettercode/<project>` before answering, then reads the HEAD
SHA into every citation and GitHub permalink.

*Why:* correctness must not depend on a background job having run. Resolving a
concrete SHA per question gives reproducible, citable answers that link to the
exact code the model read.

*Tradeoff:* the clone directory is shared across concurrent invocations (no
per-SHA isolation). Acceptable at ~100 req/day; a warm Lambda container reuses
the existing clone, so the per-job cost is just a `git fetch`.

## #3 — ripgrep only, or maintain an index?

**ripgrep-only for v0.** No build step, always consistent with the pinned SHA,
trivially correct. Indexing (symbols via tree-sitter, embeddings for semantic
search) is added later as **additional tools**, never as a hard dependency.

*Why:* an index is a cache-invalidation and freshness liability, especially with
per-commit snapshots. ripgrep on a local worktree is fast enough for repos that
fit the worker, and it can never go stale.

*Tradeoff:* no semantic search in v0 (the `search` tool accepts `mode:
semantic` but falls back to literal and says so). Large monorepos may need the
index/Fargate path (#4).

## #4 — Single Lambda or split ingress + worker?

**Single Lambda that processes inline.** The handler verifies the Slack
signature, decides whether to answer, runs the orchestrator, and posts the reply
before returning.

*Why:* at ~100 questions/day a single Lambda is far simpler — no queue, no
second function, no partial-batch error handling, no SQS visibility timeouts.

*Tradeoff:* Slack expects a 200 within 3 seconds; LLM calls take 30–90 s. API
Gateway returns a 504 to Slack while Lambda continues running. The in-memory
dedupe cache ensures Slack retries are no-ops. For a fully clean setup (no
504s), deploy with a Lambda Function URL instead of API Gateway.

## #5 — Prevent Slack retries from duplicating answers?

**In-memory event cache.** `claimEvent(eventId)` checks a module-level
`Map<eventId, expiresAt>`. The first call for an event returns `true` and
records it; subsequent calls within 2 hours return `false` and are dropped.

*Why:* Slack retries aggressively (3×, ~3 s apart). A warm Lambda container
reuses the same map, so retries hit the cache. A cold start yields a fresh map,
but a cold start means no recent invocation processed the event — so the fresh
request is correct, not a duplicate.

*Tradeoff:* no cross-Lambda-instance coordination (no DynamoDB). Two concurrent
cold starts for the same event could both claim it and produce two answers.
With ~100 req/day and reserved concurrency = 1 this is effectively impossible.
Raise concurrency? Add a DynamoDB conditional-Put back for the dedupe key only.

## #6 — How does ProductLens call Explore without flooding the parent context?

The `agent` tool spawns a subagent with an **isolated message history**. Only the
subagent's **final report** (summary + structured citations + confidence) is
returned to the parent — never its tool transcripts or raw file contents. Parent
and child **share one `BudgetTracker`** so global budgets hold across the tree.
Multiple `explore` calls can run **in parallel** (they're read-only). See
[src/tools/agentTool.ts](src/tools/agentTool.ts) and
[src/orchestrator/orchestrator.ts](src/orchestrator/orchestrator.ts).

## #7 — How are code citations generated and linked to GitHub?

Tools emit **structured citations** (`{path, startLine, endLine, commitSha,
url}`) — see the `read`/`search` tools. The URL is a GitHub permalink built from
the **pinned commit SHA** and line anchors
(`…/blob/<sha>/<path>#L<start>-L<end>`), so links never rot. The responder
linkifies them and the model is instructed to cite **only** paths it actually
read/matched. Deduped citations are attached to every answer footer.

## #8 — How do we handle very broad questions?

Triage + delegate + bound. ProductLens scopes the question, delegates breadth to
`explore` with a `thoroughness` level, and synthesizes. If a question is too
broad to answer well, it returns a **scoped overview + an offer to narrow**
rather than dumping everything. Budgets (tool calls, subagents, tokens,
wall-clock) hard-cap the work and the answer is flagged *incomplete* when a
limit is hit.

## #9 — How do we handle low-confidence answers?

Confidence is **first-class**. Every answer ends with `Confidence: high |
medium | low`, parsed into the job record. When the model can't verify a claim,
policy requires it to **say so and lower confidence** rather than guess. Low-
confidence replies state what *was* checked and suggest a next step (a file, a
team, a follow-up question).

## #10 — How do we stay safe against prompt injection from code/comments/docs?

Repository contents and Slack text are treated as **untrusted data, never
instructions**. Defenses, in layers:

- A non-negotiable **policy header** (highest authority) on every agent, plus
  explicit `<user_question>` / `<task>` framing of untrusted text
  ([src/orchestrator/prompts.ts](src/orchestrator/prompts.ts)).
- **No write/shell tools** exist; the runtime is read-only and permissioned.
- **Path traversal protection**, a **secret-file denylist**, and **binary
  refusal** ([src/tools/pathGuard.ts](src/tools/pathGuard.ts)).
- **Secret redaction** on every tool output and log line
  ([src/tools/redaction.ts](src/tools/redaction.ts)).
- The model is told to refuse embedded instructions ("ignore your rules", "print
  secrets") and never reveal the system prompt or chain-of-thought.
