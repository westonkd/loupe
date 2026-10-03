// Polling tailer (R6). Docker Desktop bind mounts on macOS don't reliably
// deliver inotify events, and the container can't tell what host it's on, so
// polling (stat + read from the last offset) is the only mechanism.
import type { Indexer, FileRef } from './indexer.js';
import type { IndexStatus } from '../shared/types.js';

export interface TailerEvents {
  onSessions(changed: Map<string, number>, listChanged: boolean): void;
  onStatus(status: Partial<IndexStatus>): void;
}

export class Tailer {
  private files: FileRef[] = [];
  private lastRescan = 0;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly indexer: Indexer,
    private readonly pollIntervalMs: number,
    private readonly rescanIntervalMs: number,
    private readonly events: TailerEvents,
  ) {}

  /** Initial full index, newest files first, yielding between files so the API stays responsive. */
  async initialIndex(): Promise<void> {
    const started = new Date().toISOString();
    this.files = this.indexer.discover();
    this.lastRescan = Date.now();
    this.events.onStatus({ indexing: true, filesTotal: this.files.length, filesDone: 0, startedAt: started });
    const changed = new Map<string, number>();
    let done = 0;
    let lastEmit = 0;
    for (const f of this.files) {
      try {
        this.indexer.syncFile(f, changed);
      } catch (e) {
        console.warn(`[tailer] ${f.path}: ${(e as Error).message}`);
      }
      done++;
      if (Date.now() - lastEmit > 250 || done === this.files.length) {
        lastEmit = Date.now();
        this.events.onStatus({ filesDone: done });
        this.events.onSessions(changed, true);
        changed.clear();
      }
      await new Promise((r) => setImmediate(r));
    }
    this.indexer.markMissing(this.files);
    this.events.onSessions(changed, true);
    this.events.onStatus({ indexing: false, filesDone: done, finishedAt: new Date().toISOString() });
  }

  start() {
    const tick = () => {
      if (this.running) return;
      this.running = true;
      const t0 = Date.now();
      try {
        this.poll();
      } catch (e) {
        console.warn(`[tailer] poll failed: ${(e as Error).message}`);
      } finally {
        this.running = false;
        this.events.onStatus({ lastPollMs: Date.now() - t0 });
      }
    };
    this.timer = setInterval(tick, this.pollIntervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  poll() {
    let listChanged = false;
    if (Date.now() - this.lastRescan >= this.rescanIntervalMs) {
      const before = new Set(this.files.map((f) => f.path));
      this.files = this.indexer.discover();
      this.lastRescan = Date.now();
      if (this.files.some((f) => !before.has(f.path)) || this.files.length !== before.size) listChanged = true;
      if (this.indexer.markMissing(this.files).length) listChanged = true;
    }
    const changed = new Map<string, number>();
    for (const f of this.files) {
      try {
        this.indexer.syncFile(f, changed);
      } catch (e) {
        console.warn(`[tailer] ${f.path}: ${(e as Error).message}`);
      }
    }
    if (changed.size || listChanged) this.events.onSessions(changed, listChanged || changed.size > 0);
  }
}
