// Session liveness without host PID access (R9): a session is live when a
// `sessions/<pid>.json` file names it. Stale files can survive a crash, so
// callers also require a recent transcript mtime.
import type { SafeFs } from './safe-fs.js';
import type { Liveness } from '../shared/types.js';

export function readLiveSessionIds(sfs: SafeFs): Set<string> {
  const ids = new Set<string>();
  for (const ent of sfs.readdir('sessions')) {
    if (!ent.isFile() || !/^\d+\.json$/.test(ent.name)) continue;
    try {
      const o = JSON.parse(sfs.readText(`sessions/${ent.name}`, 64 * 1024));
      if (o && typeof o.sessionId === 'string') ids.add(o.sessionId);
    } catch {
      // Being rewritten, or not JSON; skip this pass.
    }
  }
  return ids;
}

export function livenessOf(
  sessionId: string,
  mtimeMs: number | null,
  live: Set<string>,
  now: number,
  liveWindowMs: number,
  activeWindowMs: number,
): Liveness {
  if (!live.has(sessionId) || mtimeMs === null) return 'ended';
  const age = now - mtimeMs;
  if (age > liveWindowMs) return 'ended';
  return age <= activeWindowMs ? 'active' : 'idle';
}
