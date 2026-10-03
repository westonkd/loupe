// Why view: for one tool call, gather what explains it. The turn's prompt,
// what the model had just received (records appended since its previous model
// call), the model call's own text and thinking, and the result. Everything is
// looked up from the index; only a handful of raw records are read.
import type { DB } from './db.js';
import { sentToModel } from './context.js';
import type { RequestRow, ToolRow, WhyBlock, WhyRecord, WhyView } from '../shared/types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const MAX_TEXT = 8000;
const MAX_BEFORE = 25;
/** How many earlier assistant records to read when looking for visible text. */
const MAX_TEXT_LOOKBACK = 40;

export interface WhyDeps {
  readRaw: (rec: any) => any;
  toTool: (row: any) => ToolRow;
  toRequest: (row: any) => RequestRow;
}

function clip(s: string): string {
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}\n… (${(s.length - MAX_TEXT).toLocaleString()} more characters)` : s;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b: any) => (typeof b === 'string' ? b : b && typeof b.text === 'string' ? b.text : b?.type === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n');
}

export function buildWhy(db: DB, sessionId: string, toolUseId: string, deps: WhyDeps): WhyView | null {
  const t = db
    .prepare(
      `SELECT t.*, s.agent_id AS subagent_id FROM tool_calls t
       LEFT JOIN subagents s ON s.session_id = t.session_id AND s.tool_use_id = t.tool_use_id
       WHERE t.session_id = ? AND t.tool_use_id = ?`,
    )
    .get(sessionId, toolUseId) as any;
  if (!t) return null;
  const agentKey: string = t.agent_id ?? '';
  const tryRaw = (rec: any) => {
    if (!rec) return null;
    try {
      return deps.readRaw(rec);
    } catch {
      return null;
    }
  };

  const r = t.request_id
    ? (db.prepare(`SELECT * FROM requests WHERE session_id = ? AND request_id = ? AND agent_key = ?`).get(sessionId, t.request_id, agentKey) as any)
    : undefined;
  // Without a model call, anchor on the tool_use record itself.
  const anchorId: number | null = r?.first_record_id ?? t.use_record_id ?? null;

  const promptRec =
    anchorId === null
      ? undefined
      : (db
          .prepare(
            `SELECT * FROM records WHERE session_id = ? AND COALESCE(agent_id, '') = ? AND is_prompt = 1 AND id < ?
             ORDER BY id DESC LIMIT 1`,
          )
          .get(sessionId, agentKey, anchorId) as any);
  const prompt = promptRec
    ? { recordId: promptRec.id, ts: promptRec.ts, text: clip(textOf(tryRaw(promptRec)?.message?.content) || promptRec.summary), byAgent: agentKey !== '' }
    : null;

  let step: WhyView['step'] = null;
  if (r && promptRec) {
    const next = db
      .prepare(`SELECT MIN(id) AS id FROM records WHERE session_id = ? AND COALESCE(agent_id, '') = ? AND is_prompt = 1 AND id > ?`)
      .get(sessionId, agentKey, promptRec.id) as any;
    const end = next?.id ?? Number.MAX_SAFE_INTEGER;
    const calls = db
      .prepare(`SELECT first_record_id FROM requests WHERE session_id = ? AND agent_key = ? AND first_record_id > ? AND first_record_id < ? ORDER BY first_record_id`)
      .all(sessionId, agentKey, promptRec.id, end) as any[];
    const index = calls.findIndex((c) => c.first_record_id === r.first_record_id);
    if (index >= 0) step = { index: index + 1, of: calls.length };
  }

  // What the model had just received: records since its previous model call.
  let before: WhyRecord[] = [];
  let beforeOmitted = 0;
  if (anchorId !== null) {
    const prev = db
      .prepare(`SELECT last_record_id FROM requests WHERE session_id = ? AND agent_key = ? AND first_record_id < ? ORDER BY first_record_id DESC LIMIT 1`)
      .get(sessionId, agentKey, anchorId) as any;
    const from = Math.max(prev?.last_record_id ?? 0, promptRec ? promptRec.id - 1 : 0);
    const rows = db
      .prepare(
        `SELECT rec.id, rec.type, rec.subtype, rec.summary, rec.content_bytes, rec.is_prompt, rec.tool_use_id,
                tc.name AS tool_name, tc.status AS tool_status
         FROM records rec
         LEFT JOIN tool_calls tc ON tc.session_id = rec.session_id AND tc.result_record_id = rec.id
         WHERE rec.session_id = ? AND COALESCE(rec.agent_id, '') = ? AND rec.id > ? AND rec.id < ?
         ORDER BY rec.id`,
      )
      .all(sessionId, agentKey, from, anchorId) as any[];
    // Only what actually reached the model; state records and hook bookkeeping are noise here.
    const sent = rows.filter(sentToModel);
    beforeOmitted = Math.max(0, sent.length - MAX_BEFORE);
    before = sent.slice(-MAX_BEFORE).map((x) => ({
      recordId: x.id,
      type: x.type,
      subtype: x.subtype,
      summary: x.summary,
      contentBytes: x.content_bytes,
      isPrompt: x.is_prompt === 1,
      toolUseId: x.tool_use_id,
      toolName: x.tool_name,
      toolStatus: x.tool_status,
    }));
  }

  let modelCall: WhyView['modelCall'] = null;
  let hasVisibleText = false;
  if (r) {
    const recs = db
      .prepare(`SELECT * FROM records WHERE session_id = ? AND request_id = ? AND type = 'assistant' AND COALESCE(agent_id, '') = ? ORDER BY id`)
      .all(sessionId, r.request_id, agentKey) as any[];
    const toolSummary = db.prepare(`SELECT input_summary FROM tool_calls WHERE session_id = ? AND tool_use_id = ?`);
    const blocks: WhyBlock[] = [];
    for (const rec of recs) {
      const content = tryRaw(rec)?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          blocks.push({ kind: 'text', text: clip(b.text) });
          hasVisibleText = true;
        } else if (b?.type === 'thinking' || b?.type === 'redacted_thinking') {
          const text = typeof b.thinking === 'string' ? b.thinking : '';
          blocks.push({ kind: 'thinking', text: clip(text) });
          if (text.trim()) hasVisibleText = true;
        } else if (b?.type === 'tool_use' && typeof b.id === 'string') {
          const s = toolSummary.get(sessionId, b.id) as any;
          blocks.push({ kind: 'tool_use', toolUseId: b.id, name: typeof b.name === 'string' ? b.name : '?', inputSummary: s?.input_summary ?? '' });
        }
      }
    }
    modelCall = { row: deps.toRequest(r), blocks };
  }

  // A tool-only model call often has its reasoning in an earlier message of the turn.
  let earlierText: WhyView['earlierText'] = null;
  if (!hasVisibleText && anchorId !== null) {
    const recs = db
      .prepare(
        `SELECT * FROM records WHERE session_id = ? AND COALESCE(agent_id, '') = ? AND type = 'assistant' AND tool_use_id IS NULL
         AND id < ? AND id > ? ORDER BY id DESC LIMIT ?`,
      )
      .all(sessionId, agentKey, anchorId, promptRec?.id ?? 0, MAX_TEXT_LOOKBACK) as any[];
    for (const rec of recs) {
      const content = tryRaw(rec)?.message?.content;
      const text = Array.isArray(content)
        ? content
            .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
            .map((b: any) => b.text)
            .join('\n')
            .trim()
        : '';
      if (text) {
        earlierText = { recordId: rec.id, ts: rec.ts, text: clip(text) };
        break;
      }
    }
  }

  const resultRec = t.result_record_id
    ? (db.prepare('SELECT id, content_bytes FROM records WHERE id = ?').get(t.result_record_id) as any)
    : undefined;

  return {
    tool: deps.toTool(t),
    prompt,
    step,
    before,
    beforeOmitted,
    modelCall,
    earlierText,
    result: resultRec ? { recordId: resultRec.id, contentBytes: resultRec.content_bytes } : null,
  };
}
