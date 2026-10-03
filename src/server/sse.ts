import type { ServerResponse } from 'node:http';
import type { ServerEvent } from '../shared/types.js';

export class SseHub {
  private clients = new Set<ServerResponse>();
  private heartbeat: NodeJS.Timeout;

  constructor() {
    this.heartbeat = setInterval(() => {
      for (const c of this.clients) c.write(': ping\n\n');
    }, 15_000);
    this.heartbeat.unref();
  }

  add(res: ServerResponse) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    this.clients.add(res);
    res.on('close', () => this.clients.delete(res));
  }

  broadcast(ev: ServerEvent) {
    const data = `data: ${JSON.stringify(ev)}\n\n`;
    for (const c of this.clients) c.write(data);
  }

  get size() {
    return this.clients.size;
  }

  close() {
    clearInterval(this.heartbeat);
    for (const c of this.clients) c.end();
    this.clients.clear();
  }
}
