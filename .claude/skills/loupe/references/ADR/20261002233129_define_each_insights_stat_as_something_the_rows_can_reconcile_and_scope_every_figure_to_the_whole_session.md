# Define each insights stat as something the rows can reconcile, and scope every figure to the whole session

- **Status**: Accepted
- **Date**: 2026-10-02
- **Supersedes**: parts of `20261002215545_attribute_dollars_to_context_consumers_by_sharing_each_prompt_s_cost_across_what_was_in_it.md` (the allocation denominator, the wasted-dollar formula and the cache-waste definition; the sharing rule itself stands)

## Context

An audit of `#/insights` against the index found that no headline on the page
could be reconciled with the table under it, and that several measured the
wrong thing:

- 261 tool calls (in the two indexed sessions that had compacted) were counted
  in "Tool calls" and in no row. `aggregateSession` skipped bucketing on a
  compaction step, but the fallback loop for calls without a result treated
  those calls as already attributed.
- A tool call whose result arrived in more than one record incremented `calls`
  once per record: 283 extra calls across the index, which also deflated
  `avg/call`.
- "Attributed context" summed every contributor kind, so 26.5M faced a table
  that could only account for 13.9M; the gap was almost exactly the output
  tokens that the `response` contributor carries.
- Cache waste counted every first call in a session as a miss: 105 of 217
  "misses", 5.2M tokens and $33, under a tooltip claiming each was "paid for
  twice". A first call has no previous prompt to re-use.
- The per-cause table charged each cause the call's whole write, so the
  columns summed to 24.6M against a 23.2M headline.
- `inputUsd`, `requests` and all attribution came from the main-agent walk,
  while `costUsd` came from `sessions.cost_est`, which includes subagent
  requests ($127 of $2510). Agent rows therefore carried none of what their
  subagents actually spent, and the "Tool calls" tile paired a
  subagent-inclusive count with main-agent-only output tokens.
- `byTool` was truncated at 60 rows, so grouping by Tool and by Category
  reported different call counts for the same data.

Underneath all of this, Claude Code deletes old transcripts, so the index is
always a window rather than a ledger. That rules out presenting any of these
figures as a complete account of usage, and it means a session whose head was
cleaned up starts mid-conversation.

## Decision

Every displayed number is either something the table adds up to, or is labelled
as a different thing on purpose.

- **Attributed context** is only what a row can be blamed for: tool results,
  subagent results and injected attachments. It equals the sum of the table's
  `estTokens` and of the chart's bands by construction. Prompts, replies and
  other conversation text move to `conversationTokens`, reported beside it as
  growth nobody is at fault for, because dropping it entirely would hide real
  context and keeping it in the headline made the headline unreconcilable.
- **Calls** counts distinct `tool_use_id`s. A compaction step now counts its
  calls (and their bytes, duration and status) while still dropping their
  tokens, since the step's delta is meaningless. Rows therefore account for
  every tool call in scope, under any grouping, and no dimension is truncated
  (`MAX_ROWS` is a safety bound at 2000, not a display limit).
- **Cache waste** is only avoidable waste: calls that had a cached prefix and
  re-used less than 80% of it. First calls of a session or a subagent are
  counted and priced separately as `coldTokens` / `coldUsd`. The denominator is
  `eligibleCalls`, the calls that had something to hit, not every model call.
  A call's write is split evenly between its likely causes, so the per-cause
  columns add up to the headline; the call counts still overlap and say so.
- **Scope is the whole session.** `walkAgentChains` walks each subagent's own
  request chain, so subagent prompt spend, output and cache misses are in the
  totals. A subagent's spend is charged to the Agent call that spawned it via
  `subagents.tool_use_id` (linked for every subagent in the index), measured
  rather than apportioned. The main walk now partitions on `requests.agent_key`
  instead of joining `records.agent_id`, so main and subagent requests are
  exactly complementary.
- **Allocation** uses one denominator per step, `max(contextTokens, carried
  tools + carried attachments)`, shared by every family. Two families sharing
  one step's spend under separate denominators could together exceed it; this
  makes `attributedUsd ≤ inputUsd` structural rather than lucky.
- **Wasted dollars** are allocated through the same residency walk as
  `estUsd`, via a parallel carried map, instead of being pro-rated from the
  token share afterwards. A result that errored early cost more than one that
  errored late, which is the whole point of allocating by residency.
- **Coverage is stated, not implied.** The cost tiles say they cover the
  sessions still on disk under `~/.claude`.

`PAYLOAD_VERSION` 2 → 3 and `CACHE_KEY_VERSION` v3 → v4.

## Consequences

- Against the live index (336 sessions), row calls equal `totals.toolCalls`
  exactly under both groupings, row tokens equal `attributedTokens` exactly,
  row dollars equal `attributedUsd` exactly, per-cause tokens and dollars equal
  the cache-waste headline exactly, and the trend buckets sum to the totals.
  No session violates `attributedUsd ≤ inputUsd` or `wastedUsd ≤ estUsd`.
- Agent rows jump: subagent prompt spend moved $109 onto an Agent row that
  previously showed almost nothing, which is now the third most expensive tool.
- Cache waste drops (23.2M → 18.4M, $235 → $204) because first calls left it,
  and misses are now 114 of 20,253 rather than 217 of 18,381.
- A session whose early transcript was cleaned up still presents its first
  indexed call as a cold start when that call's cache read is low. Nothing in
  the transcript distinguishes that from a genuine first call, so it is counted
  as unavoidable rather than as waste, which is the conservative direction.
- Walking every subagent chain costs one extra pass per session, inside the
  existing per-session aggregate cache. The version bumps force one full
  recompute (about a minute for 336 sessions).
