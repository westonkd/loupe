# Cross-session insights with a two-level cache keyed by the latest session

- **Status**: Accepted
- **Date**: 2026-10-02

## Context

The Context panel (P4) answers "what made *this* session expensive". It cannot answer "what makes
my sessions expensive in general", which is the question that actually leads to a change in how the
operator works: a tool whose results average 30k tokens a call, an MCP server whose instructions are
re-injected every turn, a skill listing that costs more than the skills it advertises, a tool that is
denied half the time and burns the context anyway.

Answering that means attributing context tokens across every indexed session, which is the most
expensive derivation in the app: `buildContextView` loads every request and every record for a
session and walks them pairwise. Doing it for all 100+ sessions on every page load (or every app
launch) is not acceptable, and the index is deliberately disposable (R10), so the aggregate cannot be
treated as durable data either.

The per-session attribution also has to produce the *same* numbers as the Context panel, or the two
views disagree and neither can be trusted.

## Decision

**One attribution walk, two consumers.** `src/server/context.ts` exports `walkSessionContext`, which
performs the per-request attribution (contributors, cache diagnosis, gaps) and returns the steps.
`buildContextView` shapes those steps into the Context panel's DTO; `src/server/insights.ts`
aggregates the same steps into buckets. Neither re-implements attribution. `CacheDiagnosis` gained a
machine-readable `codes` array (`compaction`, `model-change`, `ttl-expired`, `effort-change`,
`prefix-change`, `cold-start`, `unknown`) next to its prose `reasons`, because aggregating English
sentences is not viable.

**Two-level cache, both in the disposable index.**

1. `session_aggregates` — one row per session, holding that session's buckets as JSON plus a
   `fingerprint`. The fingerprint is the session's `record_count`: transcripts are append-only, so a
   changed count means new data and anything else means the row still stands. Only sessions whose
   fingerprint moved are recomputed; a new session costs one session's walk, not a full rebuild.
2. `insight_cache` — the rolled-up view for one (project, window) scope, keyed by
   `v1|<project>|<sinceDays>|<n sessions>|<summed record_count>|<latest session id>@<its last_ts>`.
   The latest session's id and timestamp are in the key, as asked; the session count and summed
   record count are there too so that growth in an *older* session also invalidates it. Both are
   read with one cheap aggregate query over `sessions`, so a cache hit never touches `records`.

Cache tables carry nothing that cannot be re-derived, so the existing schema-version drop-and-rebuild
(R10) covers them; `SCHEMA_VERSION` went to 3.

**Scope: tool category, individual tool, MCP server, MCP tool, skill, attachment subtype, cache
waste.** Categories live in `src/shared/tools.ts` so the server and the UI agree on them. Token
attribution is main-agent only, because that is what the harness measures; a subagent's cost shows up
as the `Agent` tool result in its parent, and subagent-side tool calls are counted separately
(`subagentCalls`) with no tokens of their own rather than double-counted.

**Placement: a top-level `#/insights` route**, not a sixth session tab, since the view is not about
any one session.

**One grouping, two views.** The grouping control sits in the page toolbar, not in a panel header,
because it drives both the "Over time" chart's stack and the "Context consumers" table. So that a
band and a row can never disagree about what a key means, a single generator (`dimensionEntries`)
yields every `(grouping, key, label)` a session contributes to, and both the table rollup and the
trend read it. Colour follows rank by tokens rather than identity, so the chart's bands and the
table's top rows line up; `byCategory` is the exception and keeps its semantic colours, which are
stable across groupings. The chart keeps the top 8 bands and folds the tail into one `Other` band
rather than dropping it.

**The trend is free.** Bucketing is done at roll-up time from the per-session aggregates already in
`session_aggregates`, keyed on each session's last activity. A session is short relative to a day, a
week or a month, so it lands whole in one bucket and never has to be split — which means adding the
trend cost no extra per-session work and did not invalidate a single cached aggregate. Granularity
follows the span in scope (day ≤ 60 days, week ≤ 400, else month), and empty buckets are emitted so a
quiet week reads as a gap rather than as two adjacent bars.

## Consequences

- The expensive walk happens once per session, ever (until the index is rebuilt), and a cache hit on
  the rollup is a single-row `SELECT`. First load after a cold index pays for every session once.
- The Context panel and Insights cannot drift: a change to attribution changes both.
- `walkSessionContext` is now load-bearing for two callers, so its shape is a de-facto interface.
- Adding a dimension means adding a bucket to the per-session payload, which invalidates every
  `session_aggregates` row. There is a `PAYLOAD_VERSION` in `insights.ts` for exactly that, bumped
  independently of `SCHEMA_VERSION`. A change to the *rolled-up view's* shape instead bumps
  `CACHE_KEY_VERSION`, which costs a re-roll rather than a re-walk; adding the trend used this.
- Attachment weight is credited to the request that followed it, which means a per-turn system
  reminder spreads across many requests rather than appearing once. That is the honest number (it is
  re-sent each time) but it reads as surprisingly large until the UI says so.
