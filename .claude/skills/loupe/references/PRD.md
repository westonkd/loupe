# PRD: loupe

> **Status (2026-10-02):** Reconstructed from the working code at v0.1.0; no prior written PRD existed. The shipped shape is settled: read-only indexer over `~/.claude`, SQLite index holding byte offsets rather than transcript content, polling tailer, SSE push, and a five-panel React UI (Calls / Transcript / Context / Console / Session). Requirement numbers below are the ones the source already cites in comments (R3, R6, R7, R8, R9, R10, R11, N1, N4, N5); the remaining numbers are reconstructed and should be treated as descriptive, not as the original wording. No ADRs recorded yet, so the rationale for the load-bearing choices (offsets over content, polling over inotify, allowlisted filesystem access) still lives only in code comments and should be migrated into `references/ADR/`.

## Summary

Loupe (package name `claude-devtools`) is a local, read-only web app that makes a Claude Code session inspectable the way browser devtools make a page inspectable. It indexes the JSONL transcripts under `~/.claude`, derives per-session metadata, API requests, tool calls, and hook events, then serves them over a small HTTP API to a React UI with panels for model calls, the raw transcript, context growth, console/debug output, and session metadata. It runs as a container with the Claude directory bind-mounted read-only and no outbound network.

## Problem

A Claude Code session leaves behind append-only JSONL transcripts plus side files for subagents, tool results, and debug logs. Answering ordinary questions about a session, what did this tool call cost, why did the cache miss, what did the model actually see before it acted, which hook fired, means hand-reading large JSONL files and correlating records across them. Claude Code also periodically cleans up old transcripts, so the history is lost before it can be studied. There is no view that treats a session as a structured, navigable object.

## Goals

- Open any session from `~/.claude` and see its model calls, tool calls, records, and hooks within seconds, including sessions still in progress.
- Correlate a single tool call back to the prompt, the model turn that issued it, what had been appended since the previous model call, and the result (the "why" view).
- Show token and cost accounting per request, preferring the CLI's own `cost-state.totalCostUSD` and falling back to a bundled price table for estimates.
- Show context growth per request and surface likely prompt-cache misses.
- Stay safe to point at a real home directory: read-only, allowlisted file access, no outbound calls.
- Survive Claude Code's cleanup when the operator opts in (`ARCHIVE=1`).

## Non-goals

- **N1** — No blocking full index before the UI is usable. Files are indexed newest-first and the UI works against a partial index.
- **N2** — No writes under the Claude directory, ever. The only transcript bytes written anywhere are the optional archive under `DATA_DIR`.
- **N3** — No host PID access or process inspection for liveness; `sessions/<pid>.json` plus transcript mtime is the signal.
- **N4** — No mouse-only navigation; keyboard movement (`j`/`k`) is expected in the virtualized grids.
- **N5** — No runtime fetching of anything, prices or assets. The price table is bundled and hand-updated, and the CSP allows `'self'` only.
- Not a session editor, replayer, or agent runner. Not multi-user, not authenticated, not meant to be exposed beyond loopback.

## Users

A single operator inspecting their own machine's sessions: the person debugging their agent's behavior, auditing cost, or working out why a prompt cache missed. Published on `127.0.0.1` only, so there is no second class of user and no tenancy model.

## Vocabulary

- **Record** — one parsed line of a transcript JSONL file.
- **Request** — one model API call, derived by grouping records that share a `request_id`.
- **Tool call** — a `tool_use` block plus its matching result, possibly produced by a subagent.
- **Subagent** — a sidechain session under `projects/<dir>/<session>/subagents/agent-*.jsonl`, with its own records and an `agent_id`.
- **Liveness** — `active` / `idle` / `ended`, from whether a `sessions/<pid>.json` names the session and how recently its transcript was touched.
- **Panel** — a UI tab: Calls (P-network), Transcript (P-elements), Context (P4), Console (P7), Session. `#/insights` is a top-level view rather than a panel, because it is not about one session.
- **Attributed tokens** — conversation growth the walk could pin on a contributor: the measured token delta between two consecutive model calls, apportioned among what was appended by content size. Not a bill; the same prefix is re-sent on every call.
- **Out-of-line output** — a large tool result stored under `tool-results/` and loaded lazily (R11).

## Requirements

Storage and access
- **R3** — All reads under `CLAUDE_DIR` go through `SafeFs`: an allowlist of the exact file shapes the app needs, a denylist backstop for credential-ish names, and a realpath check so symlinks cannot escape the root.
- **R10** — The SQLite index stores no data that cannot be re-derived from transcripts; a schema or derived-logic bump rebuilds it from scratch.
- **R11** — Large tool outputs are not inlined into the index or the list responses; they are fetched on demand from their byte offsets.

Indexing
- **R7** — Parsing is tolerant and never throws. Unknown record types still yield a record with whatever envelope fields exist, and the UI falls back to raw JSON. A partial trailing line is retried on the next pass.
- **R8** — Indexing is incremental: each file is tracked by (path, inode, size, offset) and re-read only from the stored offset to EOF. Truncation or inode change resets the file.
- **R6** — Change detection is polling (`stat` plus read from last offset), because Docker Desktop bind mounts do not reliably deliver inotify events and the container cannot tell what host it is on.

Session model
- **R9** — Liveness is derived without host PID access, with stale `sessions/<pid>.json` files tolerated by also requiring a recent transcript mtime.
- **R1** — A session gets a human title from, in order, an AI title, an agent name, or its first prompt, with slash-command prompts cleaned up to `command args`.
- **R2** — Cost comes from the CLI's own total when it is at least as large as the sum of per-request estimates; otherwise it is an estimate from the bundled price table, and the source is reported.

Serving and UI
- **R4** — The API is a small set of cursor-paged JSON endpoints under `/api/` (`status`, `sessions`, `sessions/:id/{requests,requests/:n,tools,hooks,records,context,console,why/:toolUseId}`, `records/:id/raw`, `sessions/:id/tool-output`, `insights`) plus an SSE stream at `/api/events`, so panels can append rows as the index grows.
- **R5** — Responses carry strict security headers and a `'self'`-only CSP; the server binds `127.0.0.1` by default and is published on host loopback only.
- Panels: Calls, Transcript, Context, Console, Session, with legacy URL aliases (`network` → `calls`, `elements` → `transcript`) kept working.
- **R12** — Cross-session insights (`#/insights`) aggregate every indexed session into context cost by tool category, tool, MCP server, MCP tool, skill and injected-attachment kind, plus cache waste by cause. Each grouping is reported in tokens and in approximate dollars, by sharing every model call's prompt-side cost across what that prompt contained (see `references/ADR/20261002215545_*`). Every headline figure reconciles with the rows beneath it, and the scope is the whole session, subagents included; the definitions and the invariants they hold to are in `references/ADR/20261002233129_*`. The aggregate is cached in two levels — per session, invalidated by the session's record count, and per (project, window) scope, keyed by the newest session that fed it — so a page load never re-derives work the index already paid for. See `references/ADR/20261002205740_*`.
- **R13** — The same aggregate is shown over time as stacked buckets (day, week or month, chosen from the span in scope). One grouping control drives both the chart's stack and the table, both read the same key derivation, and hovering a band or a row highlights that key in both — so a single source can be followed across the whole span.

## Platform assessment / spikes

- inotify under Docker Desktop bind mounts: rejected as unreliable; polling kept (see R6 in `src/server/tailer.ts`).
- Copying transcript content into SQLite: rejected in favor of byte offsets plus on-demand reads, which keeps the index disposable (R10, R11).
- Host PID inspection for liveness: not available to the container; replaced by the `sessions/` + mtime heuristic (R9).

## Open questions

- Should the archive (`ARCHIVE=1`) be the default, given Claude Code's cleanup deletes the data the app exists to show?
- Is the bundled price table (cached 2026-09-25) worth keeping as the UI grows, or should estimated costs be marked more loudly and the table trimmed?
- The `._*` AppleDouble files committed next to several sources are noise; remove them or ignore them?
- Nothing is recorded in `references/ADR/` yet for the three decisions above; they are still the first ones worth writing down. (The insights cache decision is recorded.)
- Attribution is main-agent only, so a subagent's internal tool calls are counted but carry no tokens of their own. Should the walk descend into subagent transcripts, or is "the Agent result is what the parent paid" the right model?

## Success criteria

- A session that is still being written streams new rows into the UI without a reload.
- Deleting the index and restarting reproduces the same views from the transcripts alone.
- Pointing the container at a real `~/.claude` opens no file outside the `SafeFs` allowlist, as `test/safe-fs.test.ts` asserts.
- `npm run typecheck` and `vitest run` pass; the panel behaviors have tests (`api`, `indexer`, `parser`, `context`, `console`, `why`, `archive`).

## Phasing

1. Shipped (v0.1.0): indexer, SafeFs, tailer, SSE, API, five panels, Docker production and watch-mode dev services, optional archive.
2. Next: migrate the implicit rationale into ADRs, and resolve the archive-default and price-table questions above.
3. Later: whatever the panels need as the session format changes under them, with the parser's tolerance (R7) as the shock absorber.
