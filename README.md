# Loupe

Devtools for Claude Code sessions.

A session leaves behind append-only JSONL transcripts, subagent sidechains, out-of-line tool results and a debug log. Loupe indexes all of it and gives you the view the terminal never had: every model call, every tool call, what the model saw before it acted, what the context is filling with, and what it costs.

Read-only. It never writes to `~/.claude`, makes no outbound calls, and binds loopback.

```sh
docker compose up -d --build   # then open http://127.0.0.1:7878
```

More ways to run it, environment variables and the dev loop: [docs/running.md](docs/running.md).

## Why you might want it

**See why the agent did that.** Pick any tool call and Loupe rebuilds the chain behind it: the prompt that started the turn, everything appended since the previous model call, the model's own text and thinking, then the result.

**Find out what is eating the context window.** Context size charted per model call, the biggest jumps named, and the growth between two calls attributed to what caused it. Prompt-cache misses are flagged with why they missed.

**Spend less.** `#/insights` aggregates every indexed session and ranks context cost by tool category, tool, MCP server, MCP tool, skill and injected attachment. Rows flagged "rarely used", "costly per call" or "often wasted" come with the figures behind the verdict, and a bounded window is compared against the equal-length window before it. That chatty MCP server now has a number attached to it.

**Watch a live session.** Sessions still being written stream new rows over SSE, no reload.

**Keep your history.** Claude Code prunes old transcripts. Loupe archives them by default, so the index gets more useful over time rather than less.

**Move without a mouse.** `j`/`k` through the grids, `n`/`p` between prompts, `/` filters, `[` toggles the session rail.

## Panels

| Panel | What it gives you |
| --- | --- |
| **Transcript** | Records in file order, the live path traced back from the newest message, abandoned branches marked, results nestable under their calls, and a "why" view on any record. |
| **Context** | Context size per model call, biggest jumps, top consumers, cache misses with causes, and what got injected into each turn. |
| **Calls** | Model calls, tool calls and hook runs in one list, filtered by kind, tool, MCP server, subagent or errors only. Each row opens its input and output. |
| **Console** | The `--debug` log merged with hook output, system messages and API errors, in time order. |
| **Session** | What the session is, what it did, its subagents, and the raw state records Claude Code appends. |

## Also worth reading

[docs/safety.md](docs/safety.md) covers what Loupe reads, why the index is disposable, and why you should treat it as being as sensitive as the transcripts.

## License

MIT. See [LICENSE](LICENSE).
