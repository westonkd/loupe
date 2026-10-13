# Running Loupe

## Docker

```sh
docker compose up -d --build
```

Open <http://127.0.0.1:7878>. Your `~/.claude` is mounted read-only and the index lives in a Docker volume.

| Variable | Default | Meaning |
| --- | --- | --- |
| `DEVTOOLS_PORT` | `7878` | Host port, bound to `127.0.0.1`. |
| `CLAUDE_HOME` | `~/.claude` | Which Claude directory to index. |
| `ARCHIVE` | `1` | Copy transcripts into the data volume so history survives Claude Code's cleanup. `0` keeps nothing. |
| `NPM_CA_FILE` | none | CA bundle for `npm ci`, if you build behind a TLS-intercepting proxy. |

The Compose project, image and container are still named `claude-devtools`. Renaming them would point Compose at new volume names and orphan an existing index and archive.

## Without Docker

Node 22 or newer:

```sh
npm ci
npm run build
npm start
```

Same address. It reads `~/.claude` (override with `CLAUDE_DIR`) and writes its index to `./data` (override with `DATA_DIR`). Other variables: `HOST`, `PORT`, `POLL_INTERVAL_MS`, `ARCHIVE`.

## Developing

```sh
docker compose watch dev    # live reload on http://127.0.0.1:5174
npm test                    # vitest
npm run typecheck
```

In watch mode the API stays on the container's loopback and Vite proxies `/api/` to it, so only port 5174 is published.

Design notes live in `.claude/skills/loupe/references/`: `PRD.md` for what this is and why, one file per decision under `ADR/`. A new decision gets a new ADR (`.claude/skills/loupe/scripts/new_adr.sh "Title"`) rather than an edit to an old one.
