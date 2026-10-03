import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { Archive } from '../src/server/archive.js';
import { createApi } from '../src/server/api.js';
import { openMemoryDb } from '../src/server/db.js';
import { Indexer } from '../src/server/indexer.js';
import { SafeFs } from '../src/server/safe-fs.js';
import { SseHub } from '../src/server/sse.js';
import { jsonl, makeClaudeDir, rec, SID, transcriptPath } from './helpers.js';

describe('archive', () => {
  it('mirrors appended bytes and serves raw records after the transcript is deleted', async () => {
    const dir = makeClaudeDir();
    const archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtools-archive-'));
    const archive = new Archive(archiveDir);
    const db = openMemoryDb();
    const sfs = new SafeFs(dir);
    const indexer = new Indexer(db, sfs, { onAppend: (p, o, b, r) => archive.append(p, o, b, r) });
    const p = transcriptPath(dir);
    fs.writeFileSync(p, jsonl([rec.prompt('one', 1)]));
    indexer.syncAll();
    fs.appendFileSync(p, jsonl([rec.prompt('two', 2)]));
    indexer.syncAll();
    // A restart re-reading from the index offset must not duplicate bytes.
    archive.append(path.relative(dir, p), 0, fs.readFileSync(p).subarray(0, 10), false);
    const rel = path.relative(dir, p).split(path.sep).join('/');
    expect(fs.readFileSync(path.join(archiveDir, rel), 'utf8')).toBe(fs.readFileSync(p, 'utf8'));

    fs.rmSync(p);
    indexer.syncAll();
    const sse = new SseHub();
    const server = http.createServer(
      createApi({
        db,
        sfs,
        sse,
        state: { live: new Set(), status: {} as any },
        webDir: dir,
        liveWindowMs: 1,
        activeWindowMs: 1,
        allowedHosts: [],
        archiveDir,
      }),
    );
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const last = (db.prepare('SELECT MAX(id) AS id FROM records').get() as any).id;
    const res = await fetch(`http://127.0.0.1:${port}/api/records/${last}/raw`);
    expect(res.status).toBe(200);
    expect((await res.json()).message.content).toBe('two');
    const s = await (await fetch(`http://127.0.0.1:${port}/api/sessions/${SID}`)).json();
    expect(s.hasTranscript).toBe(false);
    sse.close();
    server.close();
  });
});
