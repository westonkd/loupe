import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi } from '../src/server/api.js';
import { openMemoryDb } from '../src/server/db.js';
import { Indexer } from '../src/server/indexer.js';
import { SafeFs } from '../src/server/safe-fs.js';
import { SseHub } from '../src/server/sse.js';
import type { WhyView } from '../src/shared/types.js';
import { jsonl, makeClaudeDir, rec, SID, transcriptPath, usage } from './helpers.js';

let server: http.Server;
let base: string;
let sse: SseHub;

function get(p: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    http
      .get(base + p, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null }));
      })
      .on('error', reject);
  });
}

beforeAll(async () => {
  const dir = makeClaudeDir();
  fs.writeFileSync(
    transcriptPath(dir),
    jsonl([
      rec.prompt('Old turn', 0),
      rec.assistantText('req_0', 'Done.', 1, usage(10, 5)),
      rec.prompt('Find the config loader', 2),
      // Model call 1: explains, then reads a file.
      rec.assistantText('req_a', 'I will look at config.ts first.', 3, usage(10, 20)),
      rec.toolUse('req_a', 'toolu_read', 'Read', { file_path: '/tmp/example/config.ts' }, 4, usage(10, 20)),
      rec.toolResult('toolu_read', 5, { text: 'export const config = {}' }),
      // Noise the model never sees: a session-state record and hook bookkeeping.
      { type: 'mode', sessionId: SID, mode: 'normal' },
      rec.hook('PostToolUse:Read', 5),
      // Model call 2: tool only, no text of its own.
      rec.toolUse('req_b', 'toolu_grep', 'Bash', { command: 'grep -rn loadConfig .' }, 6, usage(10, 30)),
      rec.toolResult('toolu_grep', 7, { text: 'src/main.ts:3: loadConfig()' }),
    ]),
  );
  const db = openMemoryDb();
  const sfs = new SafeFs(dir);
  new Indexer(db, sfs).syncAll();
  sse = new SseHub();
  const handle = createApi({
    db,
    sfs,
    sse,
    state: {
      live: new Set(),
      status: { indexing: false, filesTotal: 1, filesDone: 1, records: 8, sessions: 1, startedAt: null, finishedAt: null, lastPollMs: null, archive: false, version: 't' },
    },
    webDir: path.join(dir, 'no-web'),
    liveWindowMs: 60_000,
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

describe('Why view', () => {
  it("gathers the turn's prompt, the model call's text, and the result", async () => {
    const { status, body } = await get(`/api/sessions/${SID}/why/toolu_read`);
    const w = body as WhyView;
    expect(status).toBe(200);
    expect(w.tool.name).toBe('Read');
    expect(w.prompt?.text).toBe('Find the config loader');
    expect(w.step).toEqual({ index: 1, of: 2 });
    expect(w.modelCall?.blocks.map((b) => b.kind)).toEqual(['text', 'tool_use']);
    expect(w.modelCall?.blocks[0].text).toBe('I will look at config.ts first.');
    expect(w.earlierText).toBeNull();
    expect(w.result).not.toBeNull();
    // Only the new turn's prompt precedes the first model call, not the old turn.
    expect(w.before.map((b) => b.isPrompt)).toEqual([true]);
  });

  it('shows only what reached the model, and finds earlier reasoning for a tool-only call', async () => {
    const w = (await get(`/api/sessions/${SID}/why/toolu_grep`)).body as WhyView;
    expect(w.step).toEqual({ index: 2, of: 2 });
    expect(w.before).toHaveLength(1);
    expect(w.before[0]).toMatchObject({ toolUseId: 'toolu_read', toolName: 'Read', toolStatus: 'ok' });
    expect(w.modelCall?.blocks.map((b) => b.kind)).toEqual(['tool_use']);
    expect(w.earlierText?.text).toBe('I will look at config.ts first.');
  });

  it('404s for an unknown tool call', async () => {
    expect((await get(`/api/sessions/${SID}/why/toolu_nope`)).status).toBe(404);
  });
});
