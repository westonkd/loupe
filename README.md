# Loupe

Devtools for Claude Code sessions.

A Claude Code session leaves behind append-only JSONL transcripts, subagent sidechains, out-of-line tool results and a debug log. Loupe indexes all of it and gives you the view the terminal never had: every model call, every tool call, what the model actually saw before it acted, what the context is filling up with, and what it costs.

It is read-only. It never writes to `~/.claude`, makes no outbound network calls, and is published on loopback only.

## Why you'd want it

**See why the agent did that.** Pick any tool call and Loupe reconstructs the chain behind it: the prompt that started the turn, everything appended since the previous model call, the model's own text and thinking, then the result. No more scrolling a 40MB JSONL by hand.

**Find out what is eating the context window.** The Context panel charts context size per model call, names the biggest jumps, and attributes the growth between two calls to the things that caused it. It also calls out prompt-cache misses and says why each one missed.

**Spend less.** The Insights view aggregates every indexed session and ranks context cost by tool category, tool, MCP server, MCP tool, skill and injected attachment. It argues for a decision instead of just reporting: rows flagged "rarely used", "costly per call" or "often wasted" come with the figures behind the verdict, and a bounded window is compared against the equal-length window before it. That chatty MCP server you keep enabled by default has a number attached to it now.

**Watch a live session.** Sessions still being written stream new rows in over SSE, with no reload. Live sessions are badged in the rail.

**Keep your history.** Claude Code prunes old transcripts. Loupe archives them by default, so the index gets more useful over time rather than less.

**Move without a mouse.** `j`/`k` through the virtualized grids, `n`/`p` between prompts, `/` focuses the filter, `[` toggles the session rail.

## Panels

| Panel | What it gives you |
| --- | --- |
| **Transcript** | Records in file order with the live path traced from the newest message, abandoned branches (rewinds) marked, results nestable under their calls, and a "why" view on every record. |
| **Context** | Context size per model call, biggest jumps, top consumers, cache misses with causes, and what got injected into each turn. |
| **Calls** | Model calls, tool calls and hook runs in one filterable list: by kind, tool, MCP server, subagent, errors only. Each row opens its input and output. |
| **Console** | The `--debug` log merged with hook output, system messages and API errors, in time order, filterable by level and category. |
| **Session** | What the session is, what it did, its subagents, and the raw state records Claude Code appends. |

Plus `#/insights`, a cross-session view rather than a panel, because it is not about one session.

## Run it

```sh
docker compose up -d --build
```

Then open <http://127.0.0.1:7878>. Your `~/.claude` is mounted read-only; the index lives in a Docker volume.

Useful variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `DEVTOOLS_PORT` | `7878` | Host port, bound to `127.0.0.1`. |
| `CLAUDE_HOME` | `~/.claude` | Which Claude directory to index. |
| `ARCHIVE` | `1` | Copy transcripts into the data volume so history survives cleanup. `0` keeps nothing. |
| `NPM_CA_FILE` | none | CA bundle for `npm ci`, if you build behind a TLS-intercepting proxy. |

### Without Docker

Node 22 or newer, then:

```sh
npm ci
npm run build
npm start
```

Same address. It reads `~/.claude` (override with `CLAUDE_DIR`) and writes its index to `./data` (override with `DATA_DIR`).

### Developing

```sh
docker compose watch dev    # live reload on http://127.0.0.1:5174
npm test                    # vitest
npm run typecheck
```

Design notes live in `.claude/skills/loupe/references/`: `PRD.md` for what this is and why, and one file per decision under `ADR/`. New decisions get a new ADR (`.claude/skills/loupe/scripts/new_adr.sh "Title"`) rather than an edit to the old one.

## How it stays out of your way

- Every read under the Claude directory goes through an allowlist of the exact file shapes the app needs, with a denylist backstop for credential-ish names and a realpath check so symlinks cannot escape the root.
- The SQLite index stores byte offsets, not transcript content. Nothing in it that cannot be re-derived, so you can delete it and get the same views back.
- Large tool outputs are never inlined; they are read on demand from their offsets.
- Indexing is incremental and newest-first, so the UI is usable against a partial index.
- Responses carry a `'self'`-only CSP. The container drops all capabilities, runs read-only, and has no outbound network.

Prices for cost estimates come from a bundled table, dated on screen. On a subscription you are not billed these numbers; they are what the same traffic would cost at API rates.

## A word of caution

Transcripts contain whatever you and the agent said, including anything you pasted into a prompt and anything a tool printed. Loupe renders all of it. Keep it on loopback, which is where it binds by default, and treat the index and the archive under `DATA_DIR` as being as sensitive as the sessions themselves.

Loupe reads Claude Code's on-disk format, which is undocumented and changes. Parsing is deliberately tolerant: an unrecognized record still shows up, with its raw JSON as the fallback. If something looks wrong after a Claude Code update, that is the first place to look.

## License

MIT. See [LICENSE](LICENSE).
