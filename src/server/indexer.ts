// Incremental transcript indexer (R7, R8, R10, N1).
//
// Each transcript file is tracked by (path, inode, size, byte offset). A sync
// reads from the stored offset to EOF, indexes complete lines only (a partial
// trailing line is retried on the next pass), and stores byte offsets so raw
// JSON can be read back from the file on demand instead of being copied.
import { parseLine, type ParsedRecord } from './parser.js';
import { SafeFs } from './safe-fs.js';
import type { DB } from './db.js';
import { estimateCost } from '../shared/pricing.js';
import { parseMcpToolName } from '../shared/mcp.js';

const CHUNK_BYTES = 16 * 1024 * 1024;
/** A trailing line without '\n' is accepted once the file has been quiet this long. */
const SETTLE_MS = 5_000;

export interface FileRef {
  path: string;
  kind: 'transcript' | 'subagent';
  sessionId: string;
  agentId: string | null;
  projectDir: string;
  mtimeMs: number;
}

interface FileRow {
  path: string;
  kind: string;
  session_id: string;
  agent_id: string | null;
  ino: number | null;
  size: number | null;
  mtime_ms: number | null;
  offset: number;
  /** Timestamp of the last `user` record, the latency baseline for the next request. */
  last_ts: string | null;
  missing: number;
}

export interface IndexerHooks {
  /** Called with raw bytes appended to a file (used by the optional archive). */
  onAppend?(path: string, offset: number, bytes: Buffer, reset: boolean): void;
}

export interface SyncResult {
  /** sessionId -> highest record id after this pass */
  changed: Map<string, number>;
  sessionsChanged: boolean;
}

const SESSION_ID_RE = /^[0-9a-zA-Z][0-9a-zA-Z_-]*$/;

export class Indexer {
  private readonly st;

  constructor(
    private readonly db: DB,
    private readonly sfs: SafeFs,
    private readonly hooks: IndexerHooks = {},
    private readonly now: () => number = Date.now,
  ) {
    const p = (sql: string) => db.prepare(sql);
    this.st = {
      getFile: p('SELECT * FROM files WHERE path = ?'),
      upsertFile: p(`INSERT INTO files (path, kind, session_id, agent_id, ino, size, mtime_ms, offset, last_ts, missing)
        VALUES (@path, @kind, @session_id, @agent_id, @ino, @size, @mtime_ms, @offset, @last_ts, 0)
        ON CONFLICT(path) DO UPDATE SET ino=@ino, size=@size, mtime_ms=@mtime_ms, offset=@offset, last_ts=@last_ts, missing=0`),
      allFiles: p('SELECT path, kind, session_id, missing FROM files'),
      markMissing: p('UPDATE files SET missing = 1 WHERE path = ?'),
      ensureSession: p(`INSERT INTO sessions (session_id, project_dir, transcript_path) VALUES (?, ?, ?)
        ON CONFLICT(session_id) DO NOTHING`),
      setTranscriptPath: p('UPDATE sessions SET transcript_path = ?, has_transcript = 1 WHERE session_id = ?'),
      setNoTranscript: p('UPDATE sessions SET has_transcript = 0 WHERE session_id = ?'),
      sessionMtime: p('UPDATE sessions SET mtime_ms = MAX(COALESCE(mtime_ms, 0), ?) WHERE session_id = ?'),
      resetSessionMeta: p(`UPDATE sessions SET cwd=NULL, git_branch=NULL, version=NULL, ai_title=NULL, agent_name=NULL,
        first_prompt=NULL, last_prompt=NULL, leaf_uuid=NULL, permission_mode=NULL, first_ts=NULL, last_ts=NULL, cost_cli=NULL
        WHERE session_id = ?`),
      deleteRecords: p('DELETE FROM records WHERE file_path = ?'),
      deleteRequests: p('DELETE FROM requests WHERE file_path = ?'),
      deleteTools: p('DELETE FROM tool_calls WHERE file_path = ?'),
      deleteHooks: p('DELETE FROM hooks WHERE file_path = ?'),
      insertRecord: p(`INSERT INTO records (session_id, agent_id, file_path, offset, length, uuid, parent_uuid,
        logical_parent_uuid, type, subtype, ts, is_sidechain, is_meta, is_prompt, request_id, tool_use_id, summary,
        content_bytes, extra)
        VALUES (@session_id, @agent_id, @file_path, @offset, @length, @uuid, @parent_uuid, @logical_parent_uuid, @type,
        @subtype, @ts, @is_sidechain, @is_meta, @is_prompt, @request_id, @tool_use_id, @summary, @content_bytes, @extra)`),
      getRequest: p('SELECT * FROM requests WHERE session_id = ? AND agent_key = ? AND request_id = ?'),
      insertRequest: p(`INSERT INTO requests (session_id, agent_key, request_id, file_path, model, effort, speed, input,
        output, thinking, cache_read, cw5m, cw1h, stop_reason, ts, end_ts, latency_ms, cost, first_record_id, last_record_id, block_count,
        tool_use_count, is_error)
        VALUES (@session_id, @agent_key, @request_id, @file_path, @model, @effort, @speed, @input, @output, @thinking,
        @cache_read, @cw5m, @cw1h, @stop_reason, @ts, @end_ts, @latency_ms, @cost, @first_record_id, @first_record_id, 1, @tool_use_count,
        @is_error)`),
      updateRequest: p(`UPDATE requests SET model=@model, effort=@effort, speed=@speed, input=@input, output=@output,
        thinking=@thinking, cache_read=@cache_read, cw5m=@cw5m, cw1h=@cw1h, stop_reason=@stop_reason, end_ts=@end_ts,
        cost=@cost, last_record_id=@last_record_id, block_count=block_count+1, tool_use_count=tool_use_count+@tool_use_count, is_error=@is_error
        WHERE id=@id`),
      upsertToolUse: p(`INSERT INTO tool_calls (session_id, tool_use_id, agent_id, file_path, name, mcp_server,
        input_summary, start_ts, use_record_id, request_id)
        VALUES (@session_id, @tool_use_id, @agent_id, @file_path, @name, @mcp_server, @input_summary, @start_ts,
        @use_record_id, @request_id)
        ON CONFLICT(session_id, tool_use_id) DO UPDATE SET name=@name, mcp_server=@mcp_server,
        input_summary=@input_summary, start_ts=@start_ts, use_record_id=@use_record_id, request_id=@request_id,
        agent_id=@agent_id, file_path=@file_path`),
      upsertToolResult: p(`INSERT INTO tool_calls (session_id, tool_use_id, agent_id, file_path, name, status,
        denial_kind, end_ts, result_record_id, persisted_output)
        VALUES (@session_id, @tool_use_id, @agent_id, @file_path, '?', @status, @denial_kind, @end_ts,
        @result_record_id, @persisted_output)
        ON CONFLICT(session_id, tool_use_id) DO UPDATE SET status=@status, denial_kind=@denial_kind, end_ts=@end_ts,
        result_record_id=@result_record_id, persisted_output=@persisted_output`),
      insertHook: p(`INSERT INTO hooks (session_id, agent_id, file_path, record_id, ts, hook_name, hook_event, command,
        exit_code, duration_ms, ok) VALUES (@session_id, @agent_id, @file_path, @record_id, @ts, @hook_name,
        @hook_event, @command, @exit_code, @duration_ms, @ok)`),
      envelope: p(`UPDATE sessions SET
        cwd = COALESCE(@cwd, cwd), git_branch = COALESCE(@git_branch, git_branch), version = COALESCE(@version, version),
        first_ts = CASE WHEN @ts IS NOT NULL AND (first_ts IS NULL OR @ts < first_ts) THEN @ts ELSE first_ts END,
        last_ts = CASE WHEN @ts IS NOT NULL AND (last_ts IS NULL OR @ts > last_ts) THEN @ts ELSE last_ts END
        WHERE session_id = @session_id`),
      firstPrompt: p('UPDATE sessions SET first_prompt = ? WHERE session_id = ? AND first_prompt IS NULL'),
      metaAiTitle: p('UPDATE sessions SET ai_title = ? WHERE session_id = ?'),
      metaAgentName: p('UPDATE sessions SET agent_name = ? WHERE session_id = ?'),
      metaLastPrompt: p('UPDATE sessions SET last_prompt = COALESCE(?, last_prompt), leaf_uuid = COALESCE(?, leaf_uuid) WHERE session_id = ?'),
      metaPermission: p('UPDATE sessions SET permission_mode = ? WHERE session_id = ?'),
      metaCost: p('UPDATE sessions SET cost_cli = ? WHERE session_id = ?'),
      upsertSubagent: p(`INSERT INTO subagents (session_id, agent_id, agent_type, description, tool_use_id, file_path)
        VALUES (@session_id, @agent_id, @agent_type, @description, @tool_use_id, @file_path)
        ON CONFLICT(session_id, agent_id) DO UPDATE SET
          agent_type = COALESCE(@agent_type, agent_type), description = COALESCE(@description, description),
          tool_use_id = COALESCE(@tool_use_id, tool_use_id), file_path = COALESCE(@file_path, file_path)`),
      aggregates: p(`UPDATE sessions SET
        record_count = (SELECT COUNT(*) FROM records WHERE session_id = @s),
        request_count = (SELECT COUNT(*) FROM requests WHERE session_id = @s),
        tool_count = (SELECT COUNT(*) FROM tool_calls WHERE session_id = @s),
        error_count = (SELECT COUNT(*) FROM tool_calls WHERE session_id = @s AND status IN ('error','interrupted','denied'))
                    + (SELECT COUNT(*) FROM requests WHERE session_id = @s AND is_error = 1),
        cost_est = (SELECT COALESCE(SUM(cost), 0) FROM requests WHERE session_id = @s),
        models = (SELECT COALESCE(json_group_array(model), '[]') FROM
                   (SELECT model FROM requests WHERE session_id = @s AND model IS NOT NULL AND model NOT LIKE '<%'
                    GROUP BY model ORDER BY MIN(id)))
        WHERE session_id = @s`),
      maxRecord: p('SELECT COALESCE(MAX(id), 0) AS m FROM records WHERE session_id = ?'),
    };
  }

  /** Find every transcript and subagent transcript under projects/. */
  discover(): FileRef[] {
    const out: FileRef[] = [];
    for (const proj of this.sfs.readdir('projects')) {
      if (!proj.isDirectory()) continue;
      const projectDir = proj.name;
      for (const ent of this.sfs.readdir(`projects/${projectDir}`)) {
        if (ent.isFile() && ent.name.endsWith('.jsonl')) {
          const sessionId = ent.name.slice(0, -'.jsonl'.length);
          if (!SESSION_ID_RE.test(sessionId)) continue;
          const path = `projects/${projectDir}/${ent.name}`;
          const st = this.sfs.stat(path);
          if (st) out.push({ path, kind: 'transcript', sessionId, agentId: null, projectDir, mtimeMs: st.mtimeMs });
        } else if (ent.isDirectory() && SESSION_ID_RE.test(ent.name)) {
          const sessionId = ent.name;
          for (const sub of this.sfs.readdir(`projects/${projectDir}/${sessionId}/subagents`)) {
            const m = /^agent-(.+)\.jsonl$/.exec(sub.name);
            if (!sub.isFile() || !m) continue;
            const path = `projects/${projectDir}/${sessionId}/subagents/${sub.name}`;
            const st = this.sfs.stat(path);
            if (st) out.push({ path, kind: 'subagent', sessionId, agentId: m[1], projectDir, mtimeMs: st.mtimeMs });
          }
        }
      }
    }
    // Newest first, so recent sessions are usable before a full index finishes (N1).
    out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return out;
  }

  /** Mark tracked files that no longer exist (deleted by Claude Code's cleanup). */
  markMissing(present: FileRef[]): string[] {
    const seen = new Set(present.map((f) => f.path));
    const gone: string[] = [];
    const rows = this.st.allFiles.all() as Array<{ path: string; kind: string; session_id: string; missing: number }>;
    for (const row of rows) {
      if (seen.has(row.path) || row.missing) continue;
      this.st.markMissing.run(row.path);
      if (row.kind === 'transcript') this.st.setNoTranscript.run(row.session_id);
      gone.push(row.session_id);
    }
    return gone;
  }

  /** Index any new bytes in one file. Returns true if records were added or reset. */
  syncFile(ref: FileRef, changed: Map<string, number>): boolean {
    const st = this.sfs.stat(ref.path);
    if (!st) return false;
    const row = this.st.getFile.get(ref.path) as FileRow | undefined;
    let offset = row?.offset ?? 0;
    let lastTs = row?.last_ts ?? null;
    let reset = false;

    if (row && (row.ino !== st.ino || st.size < row.offset)) {
      // Replaced or truncated: drop everything derived from this file and start over.
      reset = true;
      offset = 0;
      lastTs = null;
      this.db.transaction(() => {
        this.st.deleteRecords.run(ref.path);
        this.st.deleteRequests.run(ref.path);
        this.st.deleteTools.run(ref.path);
        this.st.deleteHooks.run(ref.path);
        if (ref.kind === 'transcript') this.st.resetSessionMeta.run(ref.sessionId);
      })();
    }

    const unchanged = row && !reset && row.size === st.size && row.offset === st.size && row.mtime_ms === st.mtimeMs;
    if (unchanged && !row.missing) return false;

    this.st.ensureSession.run(ref.sessionId, ref.projectDir, ref.kind === 'transcript' ? ref.path : '');
    if (ref.kind === 'transcript') this.st.setTranscriptPath.run(ref.path, ref.sessionId);
    if (ref.kind === 'subagent' && ref.agentId) this.loadSubagentMeta(ref);
    this.st.sessionMtime.run(Math.floor(st.mtimeMs), ref.sessionId);

    let added = false;
    while (offset < st.size) {
      const end = Math.min(st.size, offset + CHUNK_BYTES);
      const buf = this.sfs.readRange(ref.path, offset, end);
      if (buf.length === 0) break;
      let lastNl = buf.lastIndexOf(0x0a);
      let consumeTo: number;
      if (lastNl >= 0) {
        consumeTo = lastNl + 1;
      } else if (end === st.size && this.now() - st.mtimeMs > SETTLE_MS && looksLikeJson(buf)) {
        // A final line that never got its newline; accept it once the file is quiet.
        consumeTo = buf.length;
        lastNl = buf.length;
      } else if (end < st.size) {
        // A single line longer than one chunk: grow the read until we find its end.
        const big = this.sfs.readRange(ref.path, offset, st.size);
        const nl = big.indexOf(0x0a);
        if (nl < 0) break;
        this.processChunk(ref, big.subarray(0, nl + 1), offset, (ts) => (lastTs = ts ?? lastTs), lastTs);
        if (this.hooks.onAppend) this.hooks.onAppend(ref.path, offset, big.subarray(0, nl + 1), reset && offset === 0);
        offset += nl + 1;
        added = true;
        continue;
      } else {
        break; // partial trailing line; retry next pass (R7)
      }
      const chunk = buf.subarray(0, consumeTo);
      this.processChunk(ref, chunk, offset, (ts) => (lastTs = ts ?? lastTs), lastTs);
      if (this.hooks.onAppend) this.hooks.onAppend(ref.path, offset, chunk, reset && offset === 0);
      offset += consumeTo;
      added = true;
    }

    this.st.upsertFile.run({
      path: ref.path,
      kind: ref.kind,
      session_id: ref.sessionId,
      agent_id: ref.agentId,
      ino: st.ino,
      size: st.size,
      mtime_ms: st.mtimeMs,
      offset,
      last_ts: lastTs,
    });

    if (added || reset) {
      this.st.aggregates.run({ s: ref.sessionId });
      changed.set(ref.sessionId, (this.st.maxRecord.get(ref.sessionId) as { m: number }).m);
    }
    return added || reset;
  }

  /** Discover, sync every file, and mark deletions. */
  syncAll(onProgress?: (done: number, total: number) => void): SyncResult {
    const files = this.discover();
    const changed = new Map<string, number>();
    let sessionsChanged = false;
    let done = 0;
    for (const f of files) {
      try {
        if (this.syncFile(f, changed)) sessionsChanged = true;
      } catch (e) {
        console.warn(`[indexer] failed on ${f.path}: ${(e as Error).message}`);
      }
      onProgress?.(++done, files.length);
    }
    const gone = this.markMissing(files);
    if (gone.length) sessionsChanged = true;
    return { changed, sessionsChanged };
  }

  private loadSubagentMeta(ref: FileRef) {
    const metaPath = ref.path.replace(/\.jsonl$/, '.meta.json');
    let meta: Record<string, unknown> = {};
    try {
      if (this.sfs.stat(metaPath)) meta = JSON.parse(this.sfs.readText(metaPath, 1024 * 1024));
    } catch {
      meta = {};
    }
    const s = (v: unknown) => (typeof v === 'string' ? v : null);
    this.st.upsertSubagent.run({
      session_id: ref.sessionId,
      agent_id: ref.agentId,
      agent_type: s(meta.agentType),
      description: s(meta.description),
      tool_use_id: s(meta.toolUseId),
      file_path: ref.path,
    });
  }

  private processChunk(
    ref: FileRef,
    chunk: Buffer,
    baseOffset: number,
    setLastTs: (ts: string | null) => void,
    initialLastTs: string | null,
  ) {
    let prevTs = initialLastTs;
    this.db.transaction(() => {
      let start = 0;
      while (start < chunk.length) {
        let nl = chunk.indexOf(0x0a, start);
        if (nl < 0) nl = chunk.length;
        const lineBuf = chunk.subarray(start, nl);
        const lineStart = baseOffset + start;
        start = nl + 1;
        // Trim a trailing '\r' and skip blank lines.
        let len = lineBuf.length;
        if (len > 0 && lineBuf[len - 1] === 0x0d) len--;
        if (len === 0) continue;
        const parsed = parseLine(lineBuf.toString('utf8', 0, len));
        this.indexRecord(ref, parsed, lineStart, len, prevTs);
        // Latency baseline: the last user record (prompt or tool result) the next request answers.
        if (parsed.ts && parsed.type === 'user') prevTs = parsed.ts;
      }
    })();
    setLastTs(prevTs);
  }

  private indexRecord(ref: FileRef, r: ParsedRecord, offset: number, length: number, prevTs: string | null) {
    const sessionId = ref.sessionId;
    const agentId = ref.agentId ?? (r.isSidechain ? r.agentId : null);
    const extra: Record<string, unknown> = {};
    if (r.compaction) extra.compaction = r.compaction;
    if (r.meta?.prLink) extra.prLink = r.meta.prLink;
    if (r.parseError) extra.parseError = r.parseError;
    if (r.turnDurationMs !== null) extra.turnDurationMs = r.turnDurationMs;

    const recordId = Number(
      this.st.insertRecord.run({
        session_id: sessionId,
        agent_id: agentId,
        file_path: ref.path,
        offset,
        length,
        uuid: r.uuid,
        parent_uuid: r.parentUuid,
        logical_parent_uuid: r.logicalParentUuid,
        type: r.type,
        subtype: r.subtype,
        ts: r.ts,
        is_sidechain: r.isSidechain ? 1 : 0,
        is_meta: r.isMeta ? 1 : 0,
        is_prompt: r.humanPrompt !== null ? 1 : 0,
        request_id: r.requestId,
        tool_use_id: r.toolUses[0]?.id ?? r.toolResults[0]?.toolUseId ?? null,
        summary: r.summary,
        content_bytes: r.contentBytes,
        extra: Object.keys(extra).length ? JSON.stringify(extra) : null,
      }).lastInsertRowid,
    );

    if (r.ts || r.cwd || r.gitBranch || r.version) {
      this.st.envelope.run({
        session_id: sessionId,
        cwd: ref.kind === 'transcript' ? r.cwd : null,
        git_branch: ref.kind === 'transcript' ? r.gitBranch : null,
        version: r.version,
        ts: r.ts,
      });
    }

    if (r.type === 'assistant' && r.requestId) this.indexRequest(ref, r, agentId, recordId, prevTs);

    for (const tu of r.toolUses) {
      this.st.upsertToolUse.run({
        session_id: sessionId,
        tool_use_id: tu.id,
        agent_id: agentId,
        file_path: ref.path,
        name: tu.name,
        mcp_server: parseMcpToolName(tu.name)?.server ?? null,
        input_summary: tu.inputSummary,
        start_ts: r.ts,
        use_record_id: recordId,
        request_id: r.requestId,
      });
    }
    for (const tr of r.toolResults) {
      this.st.upsertToolResult.run({
        session_id: sessionId,
        tool_use_id: tr.toolUseId,
        agent_id: agentId,
        file_path: ref.path,
        status: tr.status,
        denial_kind: tr.denialKind,
        end_ts: r.ts,
        result_record_id: recordId,
        persisted_output: tr.persistedOutputPath,
      });
    }

    if (r.hook) {
      this.st.insertHook.run({
        session_id: sessionId,
        agent_id: agentId,
        file_path: ref.path,
        record_id: recordId,
        ts: r.ts,
        hook_name: r.hook.hookName,
        hook_event: r.hook.hookEvent,
        command: r.hook.command,
        exit_code: r.hook.exitCode,
        duration_ms: r.hook.durationMs,
        ok: r.hook.ok ? 1 : 0,
      });
    }

    if (ref.kind === 'transcript') {
      if (r.humanPrompt && r.humanPrompt.trim()) this.st.firstPrompt.run(r.humanPrompt.slice(0, 500), sessionId);
      const m = r.meta;
      if (m) {
        if (m.aiTitle) this.st.metaAiTitle.run(m.aiTitle, sessionId);
        if (m.agentName) this.st.metaAgentName.run(m.agentName, sessionId);
        if (m.lastPrompt || m.leafUuid) this.st.metaLastPrompt.run(m.lastPrompt ?? null, m.leafUuid ?? null, sessionId);
        if (m.permissionMode) this.st.metaPermission.run(m.permissionMode, sessionId);
        if (m.costUsd !== undefined) this.st.metaCost.run(m.costUsd, sessionId);
      }
    }
  }

  private indexRequest(ref: FileRef, r: ParsedRecord, agentId: string | null, recordId: number, prevTs: string | null) {
    const agentKey = agentId ?? '';
    const existing = this.st.getRequest.get(ref.sessionId, agentKey, r.requestId) as Record<string, any> | undefined;
    const u = r.usage;
    const cost = (model: string | null) =>
      u
        ? estimateCost(model, {
            inputTokens: u.inputTokens,
            outputTokens: u.outputTokens,
            cacheReadTokens: u.cacheReadTokens,
            cacheWrite5mTokens: u.cacheWrite5mTokens,
            cacheWrite1hTokens: u.cacheWrite1hTokens,
            speed: u.speed,
          })
        : null;
    if (!existing) {
      const latency = r.ts && prevTs ? Date.parse(r.ts) - Date.parse(prevTs) : null;
      this.st.insertRequest.run({
        session_id: ref.sessionId,
        agent_key: agentKey,
        request_id: r.requestId,
        file_path: ref.path,
        model: r.model,
        effort: r.effort,
        speed: u?.speed ?? null,
        input: u?.inputTokens ?? 0,
        output: u?.outputTokens ?? 0,
        thinking: u?.thinkingTokens ?? 0,
        cache_read: u?.cacheReadTokens ?? 0,
        cw5m: u?.cacheWrite5mTokens ?? 0,
        cw1h: u?.cacheWrite1hTokens ?? 0,
        stop_reason: r.stopReason,
        ts: r.ts,
        end_ts: r.ts,
        latency_ms: latency !== null && Number.isFinite(latency) && latency >= 0 ? latency : null,
        cost: cost(r.model),
        first_record_id: recordId,
        tool_use_count: r.toolUses.length,
        is_error: r.isApiError ? 1 : 0,
      });
      return;
    }
    // Usage is repeated on every block line of a request; the last line wins (never sum).
    const model = r.model ?? existing.model;
    this.st.updateRequest.run({
      id: existing.id,
      last_record_id: recordId,
      model,
      effort: r.effort ?? existing.effort,
      speed: u?.speed ?? existing.speed,
      input: u?.inputTokens ?? existing.input,
      output: u?.outputTokens ?? existing.output,
      thinking: u?.thinkingTokens ?? existing.thinking,
      cache_read: u?.cacheReadTokens ?? existing.cache_read,
      cw5m: u?.cacheWrite5mTokens ?? existing.cw5m,
      cw1h: u?.cacheWrite1hTokens ?? existing.cw1h,
      stop_reason: r.stopReason ?? existing.stop_reason,
      end_ts: r.ts ?? existing.end_ts,
      cost: u ? cost(model) : existing.cost,
      tool_use_count: r.toolUses.length,
      is_error: r.isApiError || existing.is_error ? 1 : 0,
    });
  }
}

function looksLikeJson(buf: Buffer): boolean {
  try {
    JSON.parse(buf.toString('utf8'));
    return true;
  } catch {
    return false;
  }
}
