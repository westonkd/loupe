# What Loupe touches

Loupe is read-only. It never writes under the Claude directory, makes no outbound network calls, and binds `127.0.0.1`.

- Every read under the Claude directory goes through an allowlist of the exact file shapes the app needs, with a denylist backstop for credential-ish names and a realpath check so symlinks cannot escape the root.
- The SQLite index stores byte offsets, not transcript content. Nothing in it cannot be re-derived, so you can delete it and get the same views back.
- Large tool outputs are never inlined. They are read on demand from their offsets.
- Indexing is incremental and newest-first, so the UI is usable against a partial index.
- Responses carry a `'self'`-only CSP. The container drops all capabilities, runs read-only and has no outbound network.

## Treat the index like the transcripts

Transcripts hold whatever you and the agent said, including anything you pasted into a prompt and anything a tool printed. Loupe renders all of it. Keep it on loopback, and treat the index and the archive under `DATA_DIR` as being as sensitive as the sessions themselves.

## Two things to know about the numbers

Cost estimates come from a bundled price table, dated on screen. On a subscription you are not billed those numbers; they are what the same traffic would cost at API rates.

Loupe reads Claude Code's on-disk format, which is undocumented and changes. Parsing is deliberately tolerant: an unrecognized record still shows up, with its raw JSON as the fallback. If something looks wrong after a Claude Code update, that is the first place to look.
