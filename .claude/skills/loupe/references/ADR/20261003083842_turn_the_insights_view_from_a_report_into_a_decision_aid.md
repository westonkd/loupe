# Turn the insights view from a report into a decision aid

- **Status**: Accepted
- **Date**: 2026-10-03

## Context

A survey of what else exists found the two layers Loupe shares with other tools
are crowded and the layer it is alone in is the one that answers a question.
Transcript viewers are everywhere (simonw/claude-code-transcripts, Claude Code
Trace, several browser drop-in viewers) and `/context` now covers the live
window. Cost dashboards are dominated by ccusage, which slices spend by model,
session, project and billing window. Nothing in either layer answers "what made
it expensive"; the nearest attempt, agent-top's ContextLedger, derives the same
growth-minus-previous-output attribution Loupe does, but single-session and
without cache, subagent or skill handling.

That left the page reporting correct numbers and leaving every conclusion to
the reader, while presenting dollars as the headline to an audience mostly on
subscriptions, from a hand-maintained price table, over a window whose history
Claude Code deletes.

## Decision

Six changes, chosen so the page argues for a decision and says how far to trust
it. Adding six panels would have buried the one that matters, so each lands in
an existing structure wherever it can.

- **"Worth a look"** ranks rows whose numbers argue for a decision: dominant
  (≥25% of attributed spend), rarely used (≤5 calls in ≤2 sessions, ≥$0.50 and
  ≥$0.10 a call), costly per call (≥3 calls, ≥$0.25 each, ≥3% of spend) and
  often wasted (≥$1 wasted and ≥25% of its own spend). Capped at five, each
  carrying the figures behind the verdict, each a button that re-groups the
  table and highlights the row. An MCP server that is flagged suppresses its own
  tools, so one finding is never two rows. Thresholds are blunt on purpose: the
  panel points, it does not decide. Verdicts always speak dollars because every
  rule is a dollar rule.
- **A unit toggle** (tokens by default, remembered per browser) drives the
  headline tiles, the chart's context metric, the table's default sort and the
  delta basis. Tokens lead because a subscription is not billed the API rates,
  and a figure the reader can dispute is worth less than one they cannot.
- **Change against the previous window.** A bounded scope also rolls up the
  equal-length window before it, from the same per-session aggregates, and the
  tiles and a sortable Δ column show the move. Growth past 300% renders as `×14`
  rather than `+1,280%`, and the tooltip names the baseline and its session
  count, because a small baseline is the usual reason for a huge multiple.
- **Compaction economics** sit in the cache-waste panel: how many compactions,
  what the rewrite was billed, and how much history they dropped. Compaction is
  already a diagnosed miss cause, so it did not deserve a panel of its own.
- **Archiving is on by default** (`ARCHIVE=0` opts out). The index's value
  compounds with history, and every comparable tool reads live files only, so
  Claude Code's cleanup takes their history and not ours. Because that spends
  the user's disk silently, the status bar now reports the archive's size.
- **Provenance is on screen**: a toolbar tag with the share of prompt spend the
  table explains and the price table's date, and a footnote stating that the
  dollars are estimates and that the scope is whatever is still on disk.

`PAYLOAD_VERSION` 3 → 4 (per-session compaction totals) and `CACHE_KEY_VERSION`
v4 → v5 (the view carries advice, previous window, priced bands).

## Consequences

- The cache key now fingerprints both windows, so a scope recomputes when
  either moves. The previous window costs one extra rollup over aggregates that
  are already cached, not a second walk.
- Thresholds are the part most likely to be wrong. They are stated here and
  tested against synthetic sessions, but they have only been seen against one
  real index; expect to retune them, and expect "dominant" to state the obvious
  on an index where one tool always wins.
- Archiving by default grows `DATA_DIR` roughly in step with `~/.claude`
  (466 MB over 398 sessions on the index this was built against) and nothing
  prunes it. The size readout makes that visible; a retention policy is still
  unwritten.
- The deltas are honest and can still look alarming: a window with few sessions
  before it produces multiples in the hundreds. The `×N` form and the baseline
  in the tooltip are mitigation, not a fix.
- Distribution remains the gap this does not close. The rollup is a pure
  function over the index and the advice is computed server-side specifically so
  a CLI can print it, but until one exists the audience is people willing to run
  Docker.
