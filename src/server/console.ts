// Console view (P7): the session's --debug log merged with hook output,
// system messages and API errors, ordered by time.
import type { DB } from './db.js';
import type { SafeFs } from './safe-fs.js';
import type { ConsoleEntry, ConsoleLevel, ConsoleView } from '../shared/types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const MAX_ENTRIES = 20_000;
const MAX_DEBUG_BYTES = 32 * 1024 * 1024;
const LINE_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) \[([A-Z]+)\](?: \[([^\]]+)\])? ?(.*)$/;

function level(l: string): ConsoleLevel {
  const x = l.toLowerCase();
  if (x === 'error' || x === 'fatal') return 'error';
  if (x === 'warn' || x === 'warning') return 'warn';
  if (x === 'info') return 'info';
  if (x === 'debug' || x === 'trace' || x === 'verbose') return 'debug';
  return 'log';
}

/** Parse `<ISO ts> [LEVEL] [category] message`; lines without a timestamp continue the previous entry. */
export function parseDebugLog(text: string): ConsoleEntry[] {
  const out: ConsoleEntry[] = [];
  let n = 0;
  for (const line of text.split('\n')) {
    const m = LINE_RE.exec(line);
    if (m) {
      out.push({ id: `d${n++}`, ts: m[1], level: level(m[2]), source: 'debug', category: m[3] ?? null, text: m[4], recordId: null });
    } else if (out.length && line.length) {
      out[out.length - 1].text += '\n' + line;
    }
  }
  return out;
}

export function buildConsole(db: DB, sfs: SafeFs, sessionId: string, readRaw: (rec: any) => any): ConsoleView {
  const entries: ConsoleEntry[] = [];
  let truncated = false;

  const debugPath = `debug/${sessionId}.txt`;
  let hasDebugLog = false;
  try {
    const st = sfs.stat(debugPath);
    if (st) {
      hasDebugLog = true;
      const start = Math.max(0, st.size - MAX_DEBUG_BYTES);
      if (start > 0) truncated = true;
      const text = sfs.readRange(debugPath, start, st.size).toString('utf8');
      entries.push(...parseDebugLog(text));
    }
  } catch {
    hasDebugLog = false;
  }

  const hooks = db
    .prepare(`SELECT h.*, r.file_path, r.offset, r.length FROM hooks h JOIN records r ON r.id = h.record_id
      WHERE h.session_id = ? ORDER BY h.record_id`)
    .all(sessionId) as any[];
  for (const h of hooks) {
    let stdout = '';
    let stderr = '';
    try {
      const raw = readRaw(h);
      const a = raw?.attachment ?? {};
      stdout = typeof a.stdout === 'string' ? a.stdout : typeof a.content === 'string' ? a.content : '';
      stderr = typeof a.stderr === 'string' ? a.stderr : '';
    } catch {
      /* transcript gone; keep the summary */
    }
    const body = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
    entries.push({
      id: `h${h.id}`,
      ts: h.ts,
      level: !h.ok ? 'error' : stderr.trim() ? 'warn' : 'log',
      source: 'hook',
      category: h.hook_name,
      text: `${h.command ?? h.hook_name}${h.exit_code !== null ? ` → exit ${h.exit_code}` : ''}${h.duration_ms !== null ? ` (${h.duration_ms} ms)` : ''}${body ? '\n' + body : ''}`,
      recordId: h.record_id,
    });
  }

  const sys = db
    .prepare(`SELECT * FROM records WHERE session_id = ? AND (type = 'system' OR (type = 'assistant' AND request_id IS NULL)) ORDER BY id`)
    .all(sessionId) as any[];
  for (const r of sys) {
    let raw: any = null;
    try {
      raw = readRaw(r);
    } catch {
      raw = null;
    }
    if (r.type === 'assistant') {
      // Synthetic assistant records without a request id are API errors the CLI surfaced.
      const content = raw?.message?.content;
      const text = Array.isArray(content) ? content.map((b: any) => b?.text ?? '').join(' ') : r.summary;
      entries.push({ id: `r${r.id}`, ts: r.ts, level: 'error', source: 'api', category: 'api', text: text || r.summary, recordId: r.id });
      continue;
    }
    const sub = r.subtype ?? 'system';
    let lvl: ConsoleLevel = 'info';
    let text = typeof raw?.content === 'string' ? raw.content : r.summary;
    if (sub === 'turn_duration') lvl = 'debug';
    else if (sub === 'stop_hook_summary') {
      const errs = Array.isArray(raw?.hookErrors) ? raw.hookErrors : [];
      lvl = errs.length ? 'warn' : 'debug';
      const infos = Array.isArray(raw?.hookInfos) ? raw.hookInfos : [];
      text = `${infos.length} stop hook${infos.length === 1 ? '' : 's'}${infos.map((i: any) => `\n  ${i.command} (${i.durationMs ?? '?'} ms)`).join('')}${errs.length ? `\nerrors:\n  ${errs.map((e: unknown) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n  ')}` : ''}`;
    } else if (typeof raw?.level === 'string') lvl = level(raw.level);
    entries.push({ id: `r${r.id}`, ts: r.ts, level: lvl, source: 'system', category: sub, text, recordId: r.id });
  }

  entries.sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? ''));
  if (entries.length > MAX_ENTRIES) {
    truncated = true;
    entries.splice(0, entries.length - MAX_ENTRIES);
  }
  return { entries, hasDebugLog, truncated };
}
