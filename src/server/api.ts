import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DB } from './db.js';
import type { SafeFs } from './safe-fs.js';
import { AccessDenied } from './safe-fs.js';
import type { SseHub } from './sse.js';
import { livenessOf } from './liveness.js';
import { buildConsole } from './console.js';
import { buildContextView } from './context.js';
import { buildWhy } from './why.js';
import { buildInsights } from './insights.js';
import type {
  HookRow,
  IndexStatus,
  Paged,
  RecordRow,
  RequestDetail,
  RequestRow,
  SessionDetail,
  SessionSummary,
  SubagentInfo,
  ToolCallDetail,
  ToolRow,
  ToolStatus,
} from '../shared/types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ApiState {
  live: Set<string>;
  status: IndexStatus;
}

export interface ApiDeps {
  db: DB;
  sfs: SafeFs;
  sse: SseHub;
  state: ApiState;
  webDir: string;
  liveWindowMs: number;
  activeWindowMs: number;
  allowedHosts: string[];
  /** When ARCHIVE=1: directory mirroring transcripts at the same byte offsets. */
  archiveDir?: string | null;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const MAX_TOOL_OUTPUT = 4 * 1024 * 1024;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  // Everything is bundled; nothing may load from elsewhere (N5).
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
};

export function cleanPromptTitle(p: string): string {
  const cmd = /<command-name>\s*([^<]+?)\s*<\/command-name>/.exec(p);
  if (cmd) {
    const args = /<command-args>\s*([^<]*?)\s*<\/command-args>/.exec(p);
    return `${cmd[1]}${args && args[1] ? ' ' + args[1] : ''}`;
  }
  return p
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeProjectDir(dir: string): string {
  // Lossy (both '/' and '.' become '-'); only used when no cwd was recorded.
  return dir.replace(/-/g, '/');
}

export function createApi(deps: ApiDeps) {
  const { db, sfs, state } = deps;
  const q = {
    sessions: db.prepare(`SELECT * FROM sessions WHERE record_count > 0 ORDER BY COALESCE(last_ts, '') DESC`),
    session: db.prepare('SELECT * FROM sessions WHERE session_id = ?'),
    subagents: db.prepare(`SELECT s.agent_id, s.agent_type, s.description, s.tool_use_id,
        (SELECT COUNT(*) FROM records r WHERE r.session_id = s.session_id AND r.agent_id = s.agent_id) AS n
      FROM subagents s WHERE s.session_id = ? ORDER BY s.rowid`),
    prLinks: db.prepare(`SELECT extra FROM records WHERE session_id = ? AND type = 'pr-link'`),
    maxRecord: db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM records WHERE session_id = ?'),
    requests: db.prepare(`SELECT r.*, (SELECT agent_id FROM records WHERE id = r.first_record_id) AS agent_id
      FROM requests r WHERE session_id = ? AND last_record_id > ? ORDER BY first_record_id`),
    tools: db.prepare(`SELECT t.*, s.agent_id AS subagent_id FROM tool_calls t
      LEFT JOIN subagents s ON s.session_id = t.session_id AND s.tool_use_id = t.tool_use_id
      WHERE t.session_id = ? AND (COALESCE(t.use_record_id, 0) > ? OR COALESCE(t.result_record_id, 0) > ?)
      ORDER BY COALESCE(t.use_record_id, t.result_record_id)`),
    tool: db.prepare(`SELECT t.*, s.agent_id AS subagent_id FROM tool_calls t
      LEFT JOIN subagents s ON s.session_id = t.session_id AND s.tool_use_id = t.tool_use_id
      WHERE t.session_id = ? AND t.tool_use_id = ?`),
    hooks: db.prepare('SELECT * FROM hooks WHERE session_id = ? AND record_id > ? ORDER BY record_id'),
    records: db.prepare(`SELECT id, agent_id, uuid, parent_uuid, logical_parent_uuid, type, subtype, ts, is_sidechain,
        is_meta, request_id, tool_use_id, summary, length FROM records WHERE session_id = ? AND id > ? ORDER BY id
        LIMIT ?`),
    record: db.prepare('SELECT * FROM records WHERE id = ?'),
    requestRow: db.prepare(`SELECT r.*, (SELECT agent_id FROM records WHERE id = r.first_record_id) AS agent_id
      FROM requests r WHERE session_id = ? AND id = ?`),
    requestBlocks: db.prepare(`SELECT * FROM records WHERE session_id = ? AND request_id = ? AND type = 'assistant'
      AND COALESCE(agent_id, '') = ? ORDER BY id LIMIT 200`),
    byUuid: db.prepare(`SELECT * FROM records WHERE session_id = ? AND uuid = ? AND COALESCE(agent_id, '') = ?
      AND id < ? ORDER BY id DESC LIMIT 1`),
  };

  function liveness(row: any) {
    return livenessOf(row.session_id, row.mtime_ms, state.live, Date.now(), deps.liveWindowMs, deps.activeWindowMs);
  }

  function toSummary(row: any): SessionSummary {
    let title = '';
    let titleSource: SessionSummary['titleSource'] = 'none';
    if (row.ai_title) [title, titleSource] = [row.ai_title, 'ai-title'];
    else if (row.agent_name) [title, titleSource] = [row.agent_name, 'agent-name'];
    else if (row.first_prompt) [title, titleSource] = [cleanPromptTitle(row.first_prompt).slice(0, 160), 'first-prompt'];
    const first = row.first_ts ? Date.parse(row.first_ts) : NaN;
    const last = row.last_ts ? Date.parse(row.last_ts) : NaN;
    const costCli = typeof row.cost_cli === 'number' ? row.cost_cli : null;
    return {
      sessionId: row.session_id,
      title: title || '(untitled)',
      titleSource,
      projectDir: row.project_dir,
      cwd: row.cwd ?? (row.project_dir ? decodeProjectDir(row.project_dir) : null),
      gitBranch: row.git_branch,
      models: safeJson(row.models, []),
      version: row.version,
      firstTs: row.first_ts,
      lastTs: row.last_ts,
      durationMs: Number.isFinite(first) && Number.isFinite(last) ? last - first : null,
      // cost-state is a snapshot that can be written mid-session and go stale,
      // so it only wins when it covers at least what the requests add up to.
      costUsd: costCli !== null && costCli >= row.cost_est ? costCli : row.cost_est > 0 ? row.cost_est : costCli,
      costSource: costCli !== null && costCli >= row.cost_est ? 'cli' : row.cost_est > 0 ? 'estimate' : costCli !== null ? 'cli' : null,
      liveness: liveness(row),
      hasTranscript: row.has_transcript === 1,
      recordCount: row.record_count,
      requestCount: row.request_count,
      toolCount: row.tool_count,
      errorCount: row.error_count,
    };
  }

  function toRequest(r: any): RequestRow {
    return {
      id: r.id,
      agentId: r.agent_id ?? null,
      requestId: r.request_id,
      model: r.model,
      effort: r.effort,
      speed: r.speed,
      inputTokens: r.input,
      outputTokens: r.output,
      thinkingTokens: r.thinking,
      cacheReadTokens: r.cache_read,
      cacheWrite5mTokens: r.cw5m,
      cacheWrite1hTokens: r.cw1h,
      contextTokens: r.input + r.cache_read + r.cw5m + r.cw1h,
      stopReason: r.stop_reason,
      ts: r.ts,
      endTs: r.end_ts,
      latencyMs: r.latency_ms,
      costUsd: r.cost,
      firstRecordId: r.first_record_id,
      blockCount: r.block_count,
      toolUseCount: r.tool_use_count,
      isError: r.is_error === 1,
    };
  }

  function toTool(t: any): ToolRow {
    const start = t.start_ts ? Date.parse(t.start_ts) : NaN;
    const end = t.end_ts ? Date.parse(t.end_ts) : NaN;
    return {
      id: t.id,
      agentId: t.agent_id,
      toolUseId: t.tool_use_id,
      name: t.name,
      mcpServer: t.mcp_server,
      inputSummary: t.input_summary,
      status: t.status as ToolStatus,
      denialKind: t.denial_kind,
      startTs: t.start_ts,
      endTs: t.end_ts,
      durationMs: Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null,
      useRecordId: t.use_record_id,
      resultRecordId: t.result_record_id,
      requestId: t.request_id,
      subagentId: t.subagent_id ?? null,
    };
  }

  function toHook(h: any): HookRow {
    return {
      id: h.id,
      agentId: h.agent_id,
      recordId: h.record_id,
      ts: h.ts,
      hookName: h.hook_name,
      hookEvent: h.hook_event,
      command: h.command,
      exitCode: h.exit_code,
      durationMs: h.duration_ms,
      ok: h.ok === 1,
    };
  }

  function toRecord(r: any): RecordRow {
    return {
      id: r.id,
      agentId: r.agent_id,
      uuid: r.uuid,
      parentUuid: r.parent_uuid,
      logicalParentUuid: r.logical_parent_uuid,
      type: r.type,
      subtype: r.subtype,
      ts: r.ts,
      isSidechain: r.is_sidechain === 1,
      isMeta: r.is_meta === 1,
      requestId: r.request_id,
      toolUseId: r.tool_use_id,
      summary: r.summary,
      bytes: r.length,
    };
  }

  function requireSession(id: string): any {
    const row = q.session.get(id);
    if (!row) throw new HttpError(404, 'session not found');
    return row;
  }

  function readArchived(rec: any): Buffer | null {
    if (!deps.archiveDir) return null;
    const root = path.resolve(deps.archiveDir);
    const file = path.resolve(root, rec.file_path);
    if (!file.startsWith(root + path.sep)) return null;
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(rec.length);
        const n = fs.readSync(fd, buf, 0, rec.length, rec.offset);
        return n === rec.length ? buf : null;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return null;
    }
  }

  function readRaw(rec: any): any {
    let buf: Buffer;
    try {
      buf = sfs.readRange(rec.file_path, rec.offset, rec.offset + rec.length);
      if (buf.length !== rec.length) throw new Error('short read');
    } catch (e) {
      if (e instanceof AccessDenied) throw new HttpError(403, 'access denied');
      // Cleanup deleted the transcript: fall back to the archive copy, if any.
      const archived = readArchived(rec);
      if (!archived) throw new HttpError(410, 'transcript no longer available');
      buf = archived;
    }
    try {
      return JSON.parse(buf.toString('utf8'));
    } catch {
      throw new HttpError(410, 'transcript changed since indexing');
    }
  }

  function cursorQuery(url: URL): number {
    const a = Number(url.searchParams.get('after') ?? '0');
    return Number.isFinite(a) && a > 0 ? a : 0;
  }

  const routes: Array<[RegExp, (m: RegExpExecArray, url: URL) => unknown]> = [
    [/^\/api\/status$/, () => state.status],
    [
      /^\/api\/sessions$/,
      (_m, url) => {
        const project = url.searchParams.get('project');
        const text = (url.searchParams.get('q') ?? '').toLowerCase();
        let rows = (q.sessions.all() as any[]).map(toSummary);
        if (project) rows = rows.filter((r) => r.projectDir === project || r.cwd === project);
        if (text) rows = rows.filter((r) => r.title.toLowerCase().includes(text) || r.sessionId.startsWith(text));
        const rank = (l: string) => (l === 'active' ? 0 : l === 'idle' ? 1 : 2);
        rows.sort((a, b) => rank(a.liveness) - rank(b.liveness) || (b.lastTs ?? '').localeCompare(a.lastTs ?? ''));
        return rows;
      },
    ],
    [
      /^\/api\/sessions\/([^/]+)$/,
      (m) => {
        const row = requireSession(m[1]);
        const subagents: SubagentInfo[] = (q.subagents.all(m[1]) as any[]).map((s) => ({
          agentId: s.agent_id,
          agentType: s.agent_type,
          description: s.description,
          toolUseId: s.tool_use_id,
          recordCount: s.n,
        }));
        const prLinks = (q.prLinks.all(m[1]) as any[])
          .map((r) => safeJson(r.extra, {} as any).prLink)
          .filter(Boolean);
        const detail: SessionDetail = {
          ...toSummary(row),
          subagents,
          permissionMode: row.permission_mode,
          leafUuid: row.leaf_uuid,
          prLinks,
        };
        return detail;
      },
    ],
    [
      /^\/api\/sessions\/([^/]+)\/requests$/,
      (m, url) => {
        requireSession(m[1]);
        const cursor = (q.maxRecord.get(m[1]) as any).m;
        const rows = (q.requests.all(m[1], cursorQuery(url)) as any[]).map(toRequest);
        return { rows, cursor } satisfies Paged<RequestRow>;
      },
    ],
    [
      /^\/api\/sessions\/([^/]+)\/requests\/(\d+)$/,
      (m) => {
        const r = q.requestRow.get(m[1], Number(m[2])) as any;
        if (!r) throw new HttpError(404, 'model call not found');
        const agentKey = r.agent_id ?? '';
        const recs = q.requestBlocks.all(m[1], r.request_id, agentKey) as any[];
        const blocks = recs.map((rec) => ({ recordId: rec.id, raw: tryRaw(rec) }));
        let input: RequestDetail['input'] = null;
        const first = recs[0];
        // Walk up past attachments/system records to the prompt or tool result it answered.
        let cur = first;
        for (let hops = 0; cur?.parent_uuid && hops < 50; hops++) {
          const parent = q.byUuid.get(m[1], cur.parent_uuid, agentKey, cur.id) as any;
          if (!parent) break;
          if (parent.type === 'user') {
            input = { recordId: parent.id, raw: tryRaw(parent) };
            break;
          }
          cur = parent;
        }
        return { request: toRequest(r), blocks, input } satisfies RequestDetail;
      },
    ],
    [
      /^\/api\/sessions\/([^/]+)\/tools$/,
      (m, url) => {
        requireSession(m[1]);
        const after = cursorQuery(url);
        const cursor = (q.maxRecord.get(m[1]) as any).m;
        const rows = (q.tools.all(m[1], after, after) as any[]).map(toTool);
        return { rows, cursor } satisfies Paged<ToolRow>;
      },
    ],
    [
      /^\/api\/sessions\/([^/]+)\/hooks$/,
      (m, url) => {
        requireSession(m[1]);
        const cursor = (q.maxRecord.get(m[1]) as any).m;
        const rows = (q.hooks.all(m[1], cursorQuery(url)) as any[]).map(toHook);
        return { rows, cursor } satisfies Paged<HookRow>;
      },
    ],
    [
      /^\/api\/sessions\/([^/]+)\/records$/,
      (m, url) => {
        requireSession(m[1]);
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 50_000) || 50_000, 50_000);
        const rows = (q.records.all(m[1], cursorQuery(url), limit) as any[]).map(toRecord);
        const cursor = rows.length ? rows[rows.length - 1].id : cursorQuery(url);
        return { rows, cursor } satisfies Paged<RecordRow>;
      },
    ],
    [
      /^\/api\/insights$/,
      (_m, url) => {
        const project = url.searchParams.get('project');
        const days = Number(url.searchParams.get('days') ?? '');
        return buildInsights(db, {
          project: project || null,
          sinceDays: Number.isFinite(days) && days > 0 ? days : null,
        });
      },
    ],
    [
      /^\/api\/sessions\/([^/]+)\/context$/,
      (m) => {
        requireSession(m[1]);
        return buildContextView(db, m[1]);
      },
    ],
    [
      /^\/api\/sessions\/([^/]+)\/console$/,
      (m) => {
        requireSession(m[1]);
        return buildConsole(db, sfs, m[1], readRaw);
      },
    ],
    [
      /^\/api\/records\/(\d+)\/raw$/,
      (m) => {
        const rec = q.record.get(Number(m[1]));
        if (!rec) throw new HttpError(404, 'record not found');
        return readRaw(rec);
      },
    ],
    [
      /^\/api\/sessions\/([^/]+)\/why\/([^/]+)$/,
      (m) => {
        requireSession(m[1]);
        const view = buildWhy(db, m[1], m[2], { readRaw, toTool, toRequest });
        if (!view) throw new HttpError(404, 'tool call not found');
        return view;
      },
    ],
    [
      /^\/api\/sessions\/([^/]+)\/tool-calls\/([^/]+)$/,
      (m) => {
        const t = q.tool.get(m[1], m[2]) as any;
        if (!t) throw new HttpError(404, 'tool call not found');
        let input: unknown = null;
        let result: unknown = null;
        let structured: unknown = null;
        if (t.use_record_id) {
          const raw = tryRaw(q.record.get(t.use_record_id));
          const block = raw?.message?.content?.find?.((b: any) => b?.type === 'tool_use' && b.id === t.tool_use_id);
          input = block?.input ?? null;
        }
        if (t.result_record_id) {
          const raw = tryRaw(q.record.get(t.result_record_id));
          result =
            raw?.message?.content?.find?.((b: any) => b?.type === 'tool_result' && b.tool_use_id === t.tool_use_id) ??
            null;
          structured = raw?.toolUseResult ?? null;
        }
        const persisted = t.persisted_output ? toolResultRel(t.persisted_output) : null;
        const detail: ToolCallDetail = {
          tool: toTool(t),
          input,
          result,
          structured,
          persistedOutput: persisted
            ? { path: persisted, size: (structured as any)?.persistedOutputSize ?? sfs.stat(persisted)?.size ?? null }
            : null,
        };
        return detail;
      },
    ],
  ];

  function tryRaw(rec: any): any {
    if (!rec) return null;
    try {
      return readRaw(rec);
    } catch {
      return null;
    }
  }

  /** Map a host-absolute persistedOutputPath to an allowlisted relative path. */
  function toolResultRel(p: string): string | null {
    const i = p.replace(/\\/g, '/').lastIndexOf('/projects/');
    if (i < 0) return null;
    const rel = p.slice(i + 1);
    return /^projects\/[^/]+\/[^/]+\/tool-results\/[^/]+$/.test(rel) ? rel : null;
  }

  function hostAllowed(req: IncomingMessage): boolean {
    const host = (req.headers.host ?? '').toLowerCase();
    const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
    return ['127.0.0.1', 'localhost', '[::1]', ...deps.allowedHosts].includes(name);
  }

  function send(res: ServerResponse, status: number, body: unknown) {
    const json = JSON.stringify(body);
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(json);
  }

  function serveStatic(urlPath: string, res: ServerResponse) {
    const root = path.resolve(deps.webDir);
    let file = path.resolve(root, '.' + decodeURIComponent(urlPath));
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.writeHead(400).end();
      return;
    }
    let st: fs.Stats | null = null;
    try {
      st = fs.statSync(file);
      if (st.isDirectory()) {
        file = path.join(file, 'index.html');
        st = fs.statSync(file);
      }
    } catch {
      st = null;
    }
    if (!st) {
      // SPA fallback
      file = path.join(root, 'index.html');
      try {
        st = fs.statSync(file);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('UI not built. Run `npm run build:web`.');
        return;
      }
    }
    const ext = path.extname(file);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  }

  return function handle(req: IncomingMessage, res: ServerResponse) {
    if (!hostAllowed(req)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' }).end('forbidden host');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/api/events') {
      deps.sse.add(res);
      return;
    }
    if (url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/tool-output')) {
      return serveToolOutput(url, res);
    }
    if (url.pathname.startsWith('/api/')) {
      for (const [re, fn] of routes) {
        const m = re.exec(url.pathname);
        if (!m) continue;
        try {
          return send(res, 200, fn(m, url));
        } catch (e) {
          if (e instanceof HttpError) return send(res, e.status, { error: e.message });
          console.error('[api]', e);
          return send(res, 500, { error: 'internal error' });
        }
      }
      return send(res, 404, { error: 'not found' });
    }
    serveStatic(url.pathname, res);
  };

  /** Lazily load a large tool output stored out of line (R11). */
  function serveToolOutput(url: URL, res: ServerResponse) {
    const rel = toolResultRel(url.searchParams.get('path') ?? '') ?? (url.searchParams.get('path') ?? '');
    try {
      const st = sfs.stat(rel);
      if (!st) return send(res, 404, { error: 'tool output not found' });
      const end = Math.min(st.size, MAX_TOOL_OUTPUT);
      const buf = sfs.readRange(rel, 0, end);
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Total-Size': String(st.size),
        'X-Truncated': st.size > end ? '1' : '0',
      });
      res.end(buf);
    } catch (e) {
      if (e instanceof AccessDenied) return send(res, 403, { error: 'access denied' });
      return send(res, 500, { error: 'failed to read tool output' });
    }
  }
}

function safeJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
