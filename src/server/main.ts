import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { SafeFs } from './safe-fs.js';
import { Indexer } from './indexer.js';
import { Tailer } from './tailer.js';
import { SseHub } from './sse.js';
import { Archive } from './archive.js';
import { readLiveSessionIds } from './liveness.js';
import { createApi, type ApiState } from './api.js';

const VERSION = '0.1.0';

function main() {
  const cfg = loadConfig();
  if (!fs.existsSync(cfg.claudeDir)) {
    console.error(`[devtools] Claude directory not found: ${cfg.claudeDir}`);
    process.exit(1);
  }
  const db = openDb(cfg.dataDir);
  const sfs = new SafeFs(cfg.claudeDir);
  const archive = cfg.archive ? new Archive(path.join(cfg.dataDir, 'archive')) : null;
  const indexer = new Indexer(db, sfs, {
    onAppend: archive ? (p, off, bytes, reset) => archive.append(p, off, bytes, reset) : undefined,
  });
  const sse = new SseHub();

  const state: ApiState = {
    live: readLiveSessionIds(sfs),
    status: {
      indexing: true,
      filesTotal: 0,
      filesDone: 0,
      records: 0,
      sessions: 0,
      startedAt: null,
      finishedAt: null,
      lastPollMs: null,
      archive: cfg.archive,
      version: VERSION,
    },
  };
  const counts = db.prepare('SELECT (SELECT COUNT(*) FROM records) AS r, (SELECT COUNT(*) FROM sessions) AS s');
  const refreshCounts = () => {
    const c = counts.get() as { r: number; s: number };
    state.status.records = c.r;
    state.status.sessions = c.s;
  };

  let lastLiveKey = [...state.live].sort().join(',');
  let lastLiveCheck = 0;
  const tailer = new Tailer(indexer, cfg.pollIntervalMs, cfg.rescanIntervalMs, {
    onSessions(changed, listChanged) {
      for (const [sessionId, cursor] of changed) sse.broadcast({ type: 'session', sessionId, cursor });
      if (listChanged) sse.broadcast({ type: 'sessions' });
    },
    onStatus(s) {
      const wasIndexing = state.status.indexing;
      Object.assign(state.status, s);
      // Liveness can change without any transcript changing; check every few seconds.
      if (Date.now() - lastLiveCheck > 3000) {
        lastLiveCheck = Date.now();
        state.live = readLiveSessionIds(sfs);
        const key = [...state.live].sort().join(',');
        if (key !== lastLiveKey) {
          lastLiveKey = key;
          sse.broadcast({ type: 'sessions' });
        }
      }
      if (s.filesDone !== undefined || wasIndexing !== state.status.indexing) {
        refreshCounts();
        sse.broadcast({ type: 'status', status: state.status });
      }
    },
  });

  const handle = createApi({
    db,
    sfs,
    sse,
    state,
    webDir: cfg.webDir,
    liveWindowMs: cfg.liveWindowMs,
    activeWindowMs: cfg.activeWindowMs,
    archiveDir: archive ? path.join(cfg.dataDir, 'archive') : null,
    allowedHosts: (process.env.ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
  });
  const server = http.createServer(handle);
  server.listen(cfg.port, cfg.host, () => {
    console.log(`[devtools] listening on http://${cfg.host}:${cfg.port} (claude dir ${cfg.claudeDir}, data ${cfg.dataDir})`);
    if (cfg.host !== '127.0.0.1' && cfg.host !== 'localhost' && cfg.host !== '::1') {
      console.log('[devtools] non-loopback bind: make sure the port is only published on 127.0.0.1 (see docker-compose.yml)');
    }
  });

  const t0 = Date.now();
  tailer
    .initialIndex()
    .then(() => {
      refreshCounts();
      console.log(
        `[devtools] indexed ${state.status.filesTotal} files, ${state.status.records} records in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );
      tailer.start();
    })
    .catch((e) => {
      console.error('[devtools] initial index failed', e);
      tailer.start();
    });

  const shutdown = () => {
    tailer.stop();
    sse.close();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
