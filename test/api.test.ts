import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, cleanPromptTitle } from '../src/server/api.js';
import { openMemoryDb } from '../src/server/db.js';
import { Indexer } from '../src/server/indexer.js';
import { SafeFs } from '../src/server/safe-fs.js';
import { SseHub } from '../src/server/sse.js';
import { jsonl, makeClaudeDir, PROJECT, rec, SID, transcriptPath, usage } from './helpers.js';

let server: http.Server;
let base: string;
let sse: SseHub;

function get(p: string, host?: string): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const u = new URL(base + p);
    const req = http.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: host ? { host } : {} }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let body: any = data;
        try {
          body = JSON.parse(data);
        } catch {
          /* text */
        }
        resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
      });
    });
    req.on('error', reject);
  });
}

beforeAll(async () => {
  const dir = makeClaudeDir();
  fs.writeFileSync(
    transcriptPath(dir),
    jsonl([
      rec.prompt('<command-name>/review</command-name><command-args>42</command-args>', 0),
      rec.toolUse('req_1', 'toolu_1', 'Bash', { command: 'echo hi' }, 1, usage(10, 20)),
      { ...rec.toolResult('toolu_1', 2), toolUseResult: { stdout: 'hi', stderr: '', interrupted: false, persistedOutputPath: `/Users/someone/.claude/projects/${PROJECT}/${SID}/tool-results/big.txt` } },
    ]),
  );
  fs.mkdirSync(path.join(dir, 'projects', PROJECT, SID, 'tool-results'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'projects', PROJECT, SID, 'tool-results', 'big.txt'), 'large output');
  fs.writeFileSync(path.join(dir, 'sessions', '999.json'), JSON.stringify({ pid: 999, sessionId: SID }));
  const db = openMemoryDb();
  const sfs = new SafeFs(dir);
  new Indexer(db, sfs).syncAll();
  sse = new SseHub();
  const handle = createApi({
    db,
    sfs,
    sse,
    state: {
      live: new Set([SID]),
      status: { indexing: false, filesTotal: 1, filesDone: 1, records: 3, sessions: 1, startedAt: null, finishedAt: null, lastPollMs: null, archive: false, version: 't' },
    },
    webDir: path.join(dir, 'no-web'),
    liveWindowMs: 10 * 365 * 24 * 3600_000,
    activeWindowMs: 60_000,
    allowedHosts: [],
  });
  server = http.createServer(handle);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  sse.close();
  server.close();
});

describe('API', () => {
  it('rejects requests with a non-loopback Host header (DNS rebinding)', async () => {
    expect((await get('/api/status', 'evil.example:7878')).status).toBe(403);
    expect((await get('/api/status', 'localhost:7878')).status).toBe(200);
  });

  it('lists sessions with a cleaned title and liveness', async () => {
    const { body } = await get('/api/sessions');
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ sessionId: SID, title: '/review 42', titleSource: 'first-prompt', toolCount: 1 });
    expect(['active', 'idle']).toContain(body[0].liveness);
  });

  it('returns incremental rows with a cursor', async () => {
    const all = await get(`/api/sessions/${SID}/records`);
    expect(all.body.rows).toHaveLength(3);
    const after = await get(`/api/sessions/${SID}/records?after=${all.body.cursor}`);
    expect(after.body.rows).toHaveLength(0);
    const tools = await get(`/api/sessions/${SID}/tools?after=${all.body.rows[1].id}`);
    expect(tools.body.rows).toHaveLength(1); // its result record is past the cursor
  });

  it('reads raw records and tool call details from the transcript on demand', async () => {
    const recs = (await get(`/api/sessions/${SID}/records`)).body.rows;
    const raw = await get(`/api/records/${recs[1].id}/raw`);
    expect(raw.body.message.content[0].name).toBe('Bash');
    const detail = await get(`/api/sessions/${SID}/tool-calls/toolu_1`);
    expect(detail.body.input).toEqual({ command: 'echo hi' });
    expect(detail.body.structured.stdout).toBe('hi');
    expect(detail.body.persistedOutput.path).toBe(`projects/${PROJECT}/${SID}/tool-results/big.txt`);
  });

  it('serves persisted tool output only through the allowlist', async () => {
    const ok = await get(`/api/sessions/${SID}/tool-output?path=${encodeURIComponent(`projects/${PROJECT}/${SID}/tool-results/big.txt`)}`);
    expect(ok.body).toBe('large output');
    const bad = await get(`/api/sessions/${SID}/tool-output?path=${encodeURIComponent('sessions/999.abc.key')}`);
    expect(bad.status).toBe(403);
  });

  it('returns 404 for unknown sessions', async () => {
    expect((await get('/api/sessions/nope')).status).toBe(404);
  });

  it('serves the cross-session aggregate, cached on the second call', async () => {
    const first = await get('/api/insights');
    expect(first.status).toBe(200);
    expect(first.body.cached).toBe(false);
    expect(first.body.totals.sessions).toBe(1);
    expect(first.body.byTool.map((r: any) => r.key)).toContain('Bash');
    const second = await get('/api/insights');
    expect(second.body.cached).toBe(true);
    expect(second.body.key).toBe(first.body.key);
    const scoped = await get('/api/insights?project=%2Fnowhere&days=7');
    expect(scoped.body.scope).toEqual({ project: '/nowhere', sinceDays: 7 });
    expect(scoped.body.totals.sessions).toBe(0);
  });
});

describe('cleanPromptTitle', () => {
  it('strips tags from prompts', () => {
    expect(cleanPromptTitle('<local-command-stdout>x</local-command-stdout> hello')).toBe('x hello');
  });
});
