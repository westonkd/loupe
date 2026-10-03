// Context view (P4) plus correlation: for every main-agent API request,
// what was appended since the previous request (and roughly how many tokens
// each piece added), and why the prompt cache may have missed.
//
// `walkSessionContext` is the single attribution pass. The Context panel
// (buildContextView, below) and the cross-session aggregate
// (src/server/insights.ts) both read its steps, so the two views cannot
// disagree about what a tool call cost.
import type { DB } from './db.js';
import type {
  CacheDiagnosis,
  CacheReasonCode,
  CompactionMarker,
  ConsumerGroup,
  ContextContributor,
  ContextPoint,
  ContextView,
  ContributorKind,
} from '../shared/types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const MAX_CONTRIBUTORS = 12;
const TTL_5M = 5 * 60_000;
const TTL_1H = 60 * 60_000;
/** Attachment types that change tool or instruction text the model sees. */
const PREFIX_KINDS = new Set(['deferred_tools_delta', 'deferred_tools_record', 'mcp_instructions_delta', 'skill_listing', 'agent_listing_delta', 'model', 'instructions', 'nested_memory']);
/** Records the harness keeps in the transcript but doesn't send as context. */
const NOT_SENT = new Set(['hook_success']);

/**
 * Whether a record's content is sent to the model as input. Assistant
 * output is counted separately; system records, hook bookkeeping and
 * session-state records (no uuid: title, mode, cost, …) never are.
 */
export function sentToModel(rec: { type: string; subtype: string | null; content_bytes: number }): boolean {
  if (rec.content_bytes <= 0) return false;
  if (rec.type === 'user') return true;
  return rec.type === 'attachment' && !NOT_SENT.has(rec.subtype ?? '');
}

function safeJson(s: string | null): any {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

function fmtMin(ms: number): string {
  return ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)} h` : `${Math.round(ms / 60_000)} min`;
}

export function promptTokens(r: { input: number; cache_read: number; cw5m: number; cw1h: number }): number {
  return r.input + r.cache_read + r.cw5m + r.cw1h;
}

export interface WalkedTool {
  toolUseId: string;
  name: string;
  inputSummary: string;
  status: string;
  agentId: string | null;
  durationMs: number | null;
}

/** One main-agent request with everything appended since the previous one. */
export interface ContextStep {
  request: any;
  prev: any | null;
  contextTokens: number;
  deltaTokens: number | null;
  gapMs: number | null;
  compaction: boolean;
  contributors: ContextContributor[];
  dominant: ContributorKind | null;
  cache: CacheDiagnosis;
}

export interface AgentChainStep {
  request: any;
  contextTokens: number;
  cache: CacheDiagnosis;
}

export interface SessionContextWalk {
  steps: ContextStep[];
  /** Main-agent records in id order. */
  records: any[];
  /** Every tool call in the session, main agent and subagents alike. */
  tools: Map<string, WalkedTool>;
}

export function walkSessionContext(db: DB, sessionId: string): SessionContextWalk {
  const requests = db
    .prepare(`SELECT * FROM requests
      WHERE session_id = ? AND agent_key = '' AND (model IS NULL OR model NOT LIKE '<%') ORDER BY first_record_id`)
    .all(sessionId) as any[];
  const records = db
    .prepare(`SELECT id, type, subtype, ts, is_prompt, is_meta, tool_use_id, summary, content_bytes, length, extra
      FROM records WHERE session_id = ? AND agent_id IS NULL ORDER BY id`)
    .all(sessionId) as any[];
  const tools = new Map<string, WalkedTool>();
  for (const t of db
    .prepare(`SELECT tool_use_id, name, input_summary, status, agent_id, start_ts, end_ts
      FROM tool_calls WHERE session_id = ?`)
    .all(sessionId) as any[]) {
    const start = t.start_ts ? Date.parse(t.start_ts) : NaN;
    const end = t.end_ts ? Date.parse(t.end_ts) : NaN;
    tools.set(t.tool_use_id, {
      toolUseId: t.tool_use_id,
      name: t.name,
      inputSummary: t.input_summary ?? '',
      status: t.status,
      agentId: t.agent_id ?? null,
      durationMs: Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null,
    });
  }

  // Binary search helper over records ordered by id.
  const firstIndexAbove = (id: number) => {
    let lo = 0;
    let hi = records.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (records[mid].id <= id) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  const classify = (rec: any): Omit<ContextContributor, 'estTokens'> | null => {
    if (rec.type === 'assistant' || rec.type === 'system') return null;
    if (rec.type === 'attachment') {
      if (NOT_SENT.has(rec.subtype)) return null;
      return { recordId: rec.id, kind: 'attachment', category: rec.subtype ?? 'attachment', label: rec.summary, bytes: rec.content_bytes, toolUseId: null };
    }
    if (rec.type === 'user') {
      if (rec.tool_use_id) {
        const t = tools.get(rec.tool_use_id);
        const name = t?.name ?? 'tool';
        const kind: ContributorKind = name === 'Agent' || name === 'Task' ? 'subagent' : 'tool_result';
        return { recordId: rec.id, kind, category: name, label: `${name}${t?.inputSummary ? ': ' + t.inputSummary : ''}`, bytes: rec.content_bytes, toolUseId: rec.tool_use_id };
      }
      if (rec.is_prompt) return { recordId: rec.id, kind: 'prompt', category: 'prompt', label: rec.summary, bytes: rec.content_bytes, toolUseId: null };
      return { recordId: rec.id, kind: 'other', category: rec.is_meta ? 'meta message' : 'user message', label: rec.summary, bytes: rec.content_bytes, toolUseId: null };
    }
    return null;
  };

  const steps: ContextStep[] = [];
  let prev: any = null;
  for (const r of requests) {
    const ctx = promptTokens(r);
    const prevCtx = prev ? promptTokens(prev) : null;
    const delta = prevCtx === null ? null : ctx - prevCtx;

    // Records appended between the previous request's last block and this request's first block.
    const lo = prev ? firstIndexAbove(prev.last_record_id) : 0;
    const hi = firstIndexAbove(r.first_record_id - 1);
    const contribs: Array<Omit<ContextContributor, 'estTokens'>> = [];
    let compaction = false;
    const prefixKinds = new Set<string>();
    for (let i = lo; i < hi; i++) {
      const rec = records[i];
      if (rec.type === 'system' && rec.subtype === 'compact_boundary') compaction = true;
      if (rec.type === 'attachment' && PREFIX_KINDS.has(rec.subtype)) prefixKinds.add(rec.subtype);
      const c = classify(rec);
      if (c && c.bytes > 0) contribs.push(c);
    }

    // The previous assistant message is sent back as input; its size is known exactly.
    const prevOut = prev ? prev.output : 0;
    const contributors: ContextContributor[] = [];
    if (prev && prevOut > 0) {
      contributors.push({ recordId: null, kind: 'response', category: 'previous assistant message', label: `Previous assistant message (${prev.tool_use_count} tool call${prev.tool_use_count === 1 ? '' : 's'} requested)`, bytes: 0, estTokens: prevOut, toolUseId: null });
    }
    const remaining = delta === null ? 0 : Math.max(0, delta - prevOut);
    const totalBytes = contribs.reduce((a, c) => a + c.bytes, 0);
    for (const c of contribs) contributors.push({ ...c, estTokens: totalBytes > 0 ? Math.round((c.bytes / totalBytes) * remaining) : 0 });
    contributors.sort((a, b) => b.estTokens - a.estTokens || b.bytes - a.bytes);

    // Kinds by tokens they contributed, to colour the jump marker.
    const kindTotals = new Map<ContributorKind, number>();
    for (const c of contributors) kindTotals.set(c.kind, (kindTotals.get(c.kind) ?? 0) + c.estTokens);
    let dominant: ContributorKind | null = null;
    let best = 0;
    for (const [k, v] of kindTotals) if (v > best) [dominant, best] = [k, v];

    // Idle gap: previous request done → this request sent (first block time minus estimated latency).
    const start = r.ts ? Date.parse(r.ts) - (r.latency_ms ?? 0) : NaN;
    const prevEnd = prev?.end_ts ? Date.parse(prev.end_ts) : NaN;
    const gapMs = Number.isFinite(start) && Number.isFinite(prevEnd) ? Math.max(0, start - prevEnd) : null;

    steps.push({
      request: r,
      prev,
      contextTokens: ctx,
      deltaTokens: delta,
      gapMs,
      compaction,
      contributors,
      dominant,
      cache: diagnoseCache(r, prev, prevCtx, gapMs, compaction, prefixKinds),
    });
    prev = r;
  }

  return { steps, records, tools };
}

export function walkAgentChains(db: DB, sessionId: string): Array<{ agentId: string; steps: AgentChainStep[] }> {
  const requests = db
    .prepare(`SELECT * FROM requests
      WHERE session_id = ? AND agent_key <> '' AND (model IS NULL OR model NOT LIKE '<%')
      ORDER BY agent_key, first_record_id`)
    .all(sessionId) as any[];
  const chains: Array<{ agentId: string; steps: AgentChainStep[] }> = [];
  let current: { agentId: string; steps: AgentChainStep[] } | null = null;
  let prev: any = null;
  const noPrefixChange = new Set<string>();
  for (const r of requests) {
    if (!current || current.agentId !== r.agent_key) {
      current = { agentId: r.agent_key, steps: [] };
      chains.push(current);
      prev = null;
    }
    const prevCtx = prev ? promptTokens(prev) : null;
    const start = r.ts ? Date.parse(r.ts) - (r.latency_ms ?? 0) : NaN;
    const prevEnd = prev?.end_ts ? Date.parse(prev.end_ts) : NaN;
    const gapMs = Number.isFinite(start) && Number.isFinite(prevEnd) ? Math.max(0, start - prevEnd) : null;
    current.steps.push({
      request: r,
      contextTokens: promptTokens(r),
      cache: diagnoseCache(r, prev, prevCtx, gapMs, false, noPrefixChange),
    });
    prev = r;
  }
  return chains;
}

export function buildContextView(db: DB, sessionId: string): ContextView {
  const { steps, records } = walkSessionContext(db, sessionId);

  const byCategory = new Map<string, ConsumerGroup>();
  const byItem = new Map<string, ConsumerGroup>();
  const addConsumer = (map: Map<string, ConsumerGroup>, key: string, kind: ContributorKind, label: string, bytes: number, est: number) => {
    const g = map.get(key) ?? { key, kind, label, count: 0, bytes: 0, estTokens: 0 };
    g.count++;
    g.bytes += bytes;
    g.estTokens += est;
    map.set(key, g);
  };

  const points: ContextPoint[] = steps.map((s) => {
    if (!s.compaction) {
      for (const c of s.contributors) {
        addConsumer(byCategory, `${c.kind}:${c.category}`, c.kind, c.category, c.bytes, c.estTokens);
        if (c.kind === 'tool_result' || c.kind === 'subagent' || c.kind === 'attachment') {
          addConsumer(byItem, `${c.kind}:${c.label}`, c.kind, c.label, c.bytes, c.estTokens);
        }
      }
    }
    const r = s.request;
    return {
      requestRowId: r.id,
      firstRecordId: r.first_record_id,
      ts: r.ts,
      contextTokens: s.contextTokens,
      cacheHitRatio: s.contextTokens > 0 ? r.cache_read / s.contextTokens : null,
      cacheReadTokens: r.cache_read,
      cacheWriteTokens: r.cw5m + r.cw1h,
      outputTokens: r.output,
      model: r.model,
      effort: r.effort,
      deltaTokens: s.deltaTokens,
      gapMs: s.gapMs,
      contributors: s.contributors.slice(0, MAX_CONTRIBUTORS),
      contributorCount: s.contributors.length,
      dominant: s.dominant,
      cache: s.cache,
    };
  });

  const compactions: CompactionMarker[] = records
    .filter((r) => r.type === 'system' && r.subtype === 'compact_boundary')
    .map((r) => {
      const c = safeJson(r.extra).compaction ?? {};
      return { recordId: r.id, ts: r.ts, trigger: c.trigger ?? null, preTokens: c.preTokens ?? null, postTokens: c.postTokens ?? null };
    });
  const turns = records.filter((r) => r.is_prompt === 1).map((r) => ({ recordId: r.id, ts: r.ts }));
  const injected = records
    .filter((r) => r.type === 'attachment' && !NOT_SENT.has(r.subtype) && r.subtype !== 'total_tokens_reminder')
    .map((r) => ({ recordId: r.id, ts: r.ts, kind: r.subtype ?? 'attachment', label: r.summary, bytes: r.content_bytes || r.length }));

  const sortGroups = (m: Map<string, ConsumerGroup>, n: number) => [...m.values()].sort((a, b) => b.estTokens - a.estTokens || b.bytes - a.bytes).slice(0, n);
  return {
    points,
    compactions,
    turns,
    injected,
    consumers: { byCategory: sortGroups(byCategory, 40), byItem: sortGroups(byItem, 40) },
  };
}

function diagnoseCache(r: any, prev: any, prevCtx: number | null, gapMs: number | null, compaction: boolean, prefixKinds: Set<string>): CacheDiagnosis {
  if (!prev || prevCtx === null || prevCtx === 0) {
    const ctx = promptTokens(r);
    const cold = ctx > 0 && r.cache_read / ctx < 0.5;
    return {
      severity: cold ? 'cold' : 'none',
      reuseRatio: null,
      reasons: cold ? ['First model call in the session: nothing cached yet'] : [],
      codes: cold ? ['cold-start'] : [],
    };
  }
  // How much of what was sent last time came back from the cache this time.
  const reuse = Math.min(1, r.cache_read / prevCtx);
  const severity: CacheDiagnosis['severity'] = reuse < 0.2 ? 'full' : reuse < 0.8 ? 'partial' : 'none';
  if (severity === 'none') return { severity, reuseRatio: reuse, reasons: [], codes: [] };
  const reasons: string[] = [];
  const codes: CacheReasonCode[] = [];
  if (compaction) {
    reasons.push('Compaction rewrote the conversation, so the old prefix no longer matches');
    codes.push('compaction');
  }
  if (prev.model && r.model && prev.model !== r.model) {
    reasons.push(`Model changed (${prev.model} → ${r.model}); caches are per model`);
    codes.push('model-change');
  }
  if (gapMs !== null) {
    const ttl = prev.cw1h > 0 ? TTL_1H : TTL_5M;
    if (gapMs > ttl) {
      reasons.push(`Idle ${fmtMin(gapMs)} since the previous model call, longer than the ${ttl === TTL_1H ? '1 h' : '5 min'} cache TTL`);
      codes.push('ttl-expired');
    }
  }
  if (prev.effort && r.effort && prev.effort !== r.effort) {
    reasons.push(`Effort changed (${prev.effort} → ${r.effort})`);
    codes.push('effort-change');
  }
  if (prefixKinds.size) {
    reasons.push(`Possibly: tool or instruction list changed (${[...prefixKinds].join(', ')})`);
    codes.push('prefix-change');
  }
  if (!reasons.length) {
    reasons.push('No obvious cause in the transcript (system prompt or tool definitions may have changed)');
    codes.push('unknown');
  }
  return { severity, reuseRatio: reuse, reasons, codes };
}
