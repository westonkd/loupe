import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export interface Config {
  claudeDir: string;
  dataDir: string;
  webDir: string;
  host: string;
  port: number;
  pollIntervalMs: number;
  rescanIntervalMs: number;
  liveWindowMs: number;
  activeWindowMs: number;
  archive: boolean;
}

export function loadConfig(env = process.env): Config {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return {
    claudeDir: path.resolve(env.CLAUDE_DIR || path.join(os.homedir(), '.claude')),
    dataDir: path.resolve(env.DATA_DIR || 'data'),
    // Compiled layout: dist/server/server/config.js -> dist/web
    webDir: path.resolve(env.WEB_DIR || path.join(here, '../../web')),
    host: env.HOST || '127.0.0.1',
    port: envInt('PORT', 7878),
    pollIntervalMs: envInt('POLL_INTERVAL_MS', 1000),
    rescanIntervalMs: envInt('RESCAN_INTERVAL_MS', 5000),
    liveWindowMs: envInt('LIVE_WINDOW_MS', 10 * 60_000),
    activeWindowMs: envInt('ACTIVE_WINDOW_MS', 60_000),
    archive: env.ARCHIVE === '1' || env.ARCHIVE === 'true',
  };
}
