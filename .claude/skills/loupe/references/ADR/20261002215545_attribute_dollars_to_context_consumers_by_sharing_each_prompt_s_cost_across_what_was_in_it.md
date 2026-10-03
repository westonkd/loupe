# Attribute dollars to context consumers by sharing each prompt's cost across what was in it

- **Status**: Accepted
- **Date**: 2026-10-02

## Context

Insights attributed context in tokens only (`estTokens`: the conversation growth a
tool, skill or attachment caused). Tokens answer "what made the conversation big"
but not "what did that cost", and the two rank differently: a small result added on
a session's first call is re-sent on every later call, while a huge one added on the
last call is paid for once.

The session-level cost already shown is per request, from `cost-state.totalCostUSD`
or the bundled price table. Nothing connected it to the contributors the walk
already identifies. Two cheaper options were available and rejected:

- **Price the growth once** (`estTokens` × cache-write price). Ignores re-sending,
  which is the dominant cost of a long session and the thing Loupe exists to show.
- **Share of the bill by share of growth** (`estTokens / attributedTokens` × total
  cost). Ranks sources identically to tokens, so it adds a dollar sign and no
  information.

## Decision

Allocate each model call's **prompt-side** cost (uncached input + cache reads +
cache writes, output excluded) across everything in that prompt, in proportion to
tokens, and sum per source over the session. `aggregateSession` keeps a running
`carried` map per dimension family; a contributor's tokens enter it at the step they
appear in and are re-divided on every step afterward, so a source accumulates a
share of every prompt it stayed in.

- The denominator is the step's whole `contextTokens`, not the attributed subset, so
  what the walk cannot explain (system prompt, user text, assistant output) goes
  unassigned rather than inflating the rows. `totals.attributedUsd ≤ totals.inputUsd`.
- A compaction step clears `carried`: nothing can be assumed to have survived it.
- Skills allocate separately and are excluded from `attributedUsd`, since they are a
  subset of the tool buckets.
- Cache waste is priced directly instead, not allocated: `cw5m`/`cw1h` on a missed
  call are known billed tokens, so `cacheWriteCost` prices them per model exactly.
- Prices come from the bundled table (`inputSideCost`), never from
  `cost-state.totalCostUSD`, so a row's share and the session total can disagree.
  Both are labelled as approximate API-rate figures.

`PAYLOAD_VERSION` 1 → 2 and `CACHE_KEY_VERSION` v2 → v3 to drop both cache levels.

## Consequences

- The consumers table gains a sortable `~API cost` column and the stat row an
  "Attributed API cost" figure, so the dashboard can answer "which MCP server is
  costing me money" rather than only "which one is wordy".
- Numbers are approximate twice over: the token split is already apportioned by
  content size, and the prices are bundled rather than billed. The UI says so in
  every tooltip; `references/PRD.md` open question about the bundled table now
  matters more, since more of the view depends on it.
- Allocation is O(steps × distinct keys) per session, inside the existing per-session
  aggregate cache, so it costs one walk per new session and nothing on a cache hit.
- A session indexed before this change keeps its stale aggregate until its record
  count moves; the version bumps force the recompute instead.
