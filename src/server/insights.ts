// Cross-session aggregate (#/insights): what costs context across every
// indexed session, grouped by tool category, tool, MCP server, MCP tool,
// skill and injected-attachment kind.
//
// Attribution is not repeated here; `walkSessionContext` does it once per
// session and this module buckets its steps. The walk is the expensive part,
// so it is cached twice over (see the ADR):
//
//   1. session_aggregates — one row per session, invalidated by the session's
//      record_count. A new session costs one walk, not a rebuild.
//   2. insight_cache — the rollup for one (project, window) scope, keyed by
//      the newest session plus a fingerprint of every session that fed it.
import type { DB } from './db.js';
import { walkAgentChains, walkSessionContext } from './context.js';
import { inputSideCost, cacheWriteCost, PRICE_TABLE_DATE } from '../shared/pricing.js';
import { parseMcpToolName } from '../shared/mcp.js';
import { CATEGORY_LABEL, toolCategory, type ToolCategory } from '../shared/tools.js';
import type {
  CacheDiagnosis,
  CacheReasonCode,
  InsightAdvice,
  InsightAdviceKind,
  InsightPreviousRow,
  InsightCacheReason,
  InsightRow,
  InsightTotals,
  InsightDimension,
  InsightsView,
  TrendBucket,
  TrendSeries,
  TrendUnit,
} from '../shared/types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Bump when the per-session payload shape changes; invalidates every row. */
const PAYLOAD_VERSION = 4;
/**
 * Bump when the rolled-up view's shape changes. Separate from PAYLOAD_VERSION
 * so a change to the view costs a re-roll, not a re-walk of every session.
 */
const CACHE_KEY_VERSION = 'v5';
const MAX_ROWS = 2000;
const DAY_MS = 86_400_000;

const WASTED = new Set(['error', 'denied', 'interrupted']);

interface Bucket {
  calls: number;
  subagentCalls: number;
  errorCalls: number;
  deniedCalls: number;
  estTokens: number;
  wastedTokens: number;
  /**
   * Share of the prompt-side spend these tokens are responsible for, counting
   * every later request that re-sent them. See `allocate`.
   */
  estUsd: number;
  wastedUsd: number;
  bytes: number;
  durationMs: number;
}

interface SessionAggregate {
  sessionId: string;
  requests: number;
  subagentRequests: number;
  contextTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  toolCalls: number;
  attributedTokens: number;
  conversationTokens: number;
  /** Prompt-side spend of every request in the session, subagents included. */
  inputUsd: number;
  /** The part of `inputUsd` the walk could pin on a contributor. */
  attributedUsd: number;
  /** Keyed by tool name (MCP tools keep their full `mcp__server__tool` name). */
  tools: Record<string, Bucket>;
  /** Keyed by the Skill call's argument. */
  skills: Record<string, Bucket>;
  /** Keyed by attachment subtype. */
  attachments: Record<string, Bucket>;
  cache: {
    calls: number;
    full: number;
    partial: number;
    eligibleCalls: number;
    cold: number;
    rewrittenTokens: number;
    rewrittenUsd: number;
    coldTokens: number;
    coldUsd: number;
    reasons: Record<string, { count: number; rewrittenTokens: number; rewrittenUsd: number }>;
  };
  compaction: { count: number; discardedTokens: number; rewrittenTokens: number; rewrittenUsd: number };
}

function safeJson(v: string | null): any {
  if (!v) return {};
  try {
    return JSON.parse(v);
  } catch {
    return {};
  }
}

function emptyBucket(): Bucket {
  return { calls: 0, subagentCalls: 0, errorCalls: 0, deniedCalls: 0, estTokens: 0, wastedTokens: 0, estUsd: 0, wastedUsd: 0, bytes: 0, durationMs: 0 };
}

function bucketOf(map: Record<string, Bucket>, key: string): Bucket {
  const b = map[key] ?? emptyBucket();
  map[key] = b;
  return b;
}

/**
 * Split one request's prompt-side spend across everything still in its prompt,
 * by each key's share of the prompt. `carried` holds tokens attributed in this
 * request or any earlier one, because a token added once is re-sent (and
 * re-charged, as a cache read or a re-write) on every request after it.
 * `denom` is the whole prompt, shared by every family allocated at this step,
 * so what the walk could not attribute simply goes unassigned.
 */
function allocate(
  carried: Map<string, number>,
  map: Record<string, Bucket>,
  field: 'estUsd' | 'wastedUsd',
  stepUsd: number,
  denom: number,
): number {
  if (stepUsd <= 0 || denom <= 0 || carried.size === 0) return 0;
  let assigned = 0;
  for (const [k, v] of carried) {
    const usd = (stepUsd * v) / denom;
    bucketOf(map, k)[field] += usd;
    assigned += usd;
  }
  return assigned;
}

function carry(m: Map<string, number>, key: string, tokens: number) {
  if (tokens > 0) m.set(key, (m.get(key) ?? 0) + tokens);
}

function sum(m: Map<string, number>): number {
  let t = 0;
  for (const v of m.values()) t += v;
  return t;
}

/** Walk one session and bucket everything the walk attributed. */
export function aggregateSession(db: DB, sessionId: string): SessionAggregate {
  const { steps, tools, records } = walkSessionContext(db, sessionId);
  const agg: SessionAggregate = {
    sessionId,
    requests: steps.length,
    subagentRequests: 0,
    contextTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    toolCalls: tools.size,
    attributedTokens: 0,
    conversationTokens: 0,
    tools: {},
    skills: {},
    attachments: {},
    cache: { calls: 0, full: 0, partial: 0, eligibleCalls: 0, cold: 0, rewrittenTokens: 0, rewrittenUsd: 0, coldTokens: 0, coldUsd: 0, reasons: {} },
    compaction: { count: 0, discardedTokens: 0, rewrittenTokens: 0, rewrittenUsd: 0 },
    inputUsd: 0,
    attributedUsd: 0,
  };
  const carriedTools = new Map<string, number>();
  const carriedSkills = new Map<string, number>();
  const carriedAttachments = new Map<string, number>();
  const carriedWasted = new Map<string, number>();
  const counted = new Set<string>();

  const accountCache = (cache: CacheDiagnosis, r: any) => {
    const written = r.cw5m + r.cw1h;
    const writeUsd = cacheWriteCost(r.model, r.cw5m, r.cw1h, r.speed) ?? 0;
    if (cache.reuseRatio === null) {
      if (cache.severity !== 'cold') {
        agg.cache.eligibleCalls++;
        return;
      }
      agg.cache.cold++;
      agg.cache.coldTokens += written;
      agg.cache.coldUsd += writeUsd;
      return;
    }
    agg.cache.eligibleCalls++;
    if (cache.severity !== 'full' && cache.severity !== 'partial') return;
    agg.cache.calls++;
    if (cache.severity === 'full') agg.cache.full++;
    else agg.cache.partial++;
    agg.cache.rewrittenTokens += written;
    agg.cache.rewrittenUsd += writeUsd;
    const codes = cache.codes.filter((c) => c !== 'cold-start');
    const share = codes.length > 0 ? 1 / codes.length : 0;
    for (const code of codes) {
      const e = agg.cache.reasons[code] ?? { count: 0, rewrittenTokens: 0, rewrittenUsd: 0 };
      e.count++;
      e.rewrittenTokens += written * share;
      e.rewrittenUsd += writeUsd * share;
      agg.cache.reasons[code] = e;
    }
  };

  for (const step of steps) {
    const r = step.request;
    agg.contextTokens += step.contextTokens;
    agg.outputTokens += r.output;
    agg.cacheReadTokens += r.cache_read;
    agg.cacheWriteTokens += r.cw5m + r.cw1h;
    const stepUsd =
      inputSideCost(r.model, {
        inputTokens: r.input,
        cacheReadTokens: r.cache_read,
        cacheWrite5mTokens: r.cw5m,
        cacheWrite1hTokens: r.cw1h,
        speed: r.speed,
      }) ?? 0;
    agg.inputUsd += stepUsd;
    accountCache(step.cache, r);

    // A compaction step's delta is negative and its shares aren't estimated,
    // so it would poison the per-tool averages (same reason the Context panel
    // leaves it out of "top consumers").
    if (step.compaction) {
      agg.compaction.rewrittenTokens += r.cw5m + r.cw1h;
      agg.compaction.rewrittenUsd += cacheWriteCost(r.model, r.cw5m, r.cw1h, r.speed) ?? 0;
      // The prompt was rewritten, so nothing can be assumed to have survived it.
      carriedTools.clear();
      carriedSkills.clear();
      carriedAttachments.clear();
      carriedWasted.clear();
    }

    for (const c of step.contributors) {
      if (c.kind === 'attachment') {
        const b = bucketOf(agg.attachments, c.category);
        b.calls++;
        b.bytes += c.bytes;
        if (step.compaction) continue;
        b.estTokens += c.estTokens;
        agg.attributedTokens += c.estTokens;
        carry(carriedAttachments, c.category, c.estTokens);
        continue;
      }
      if (c.kind !== 'tool_result' && c.kind !== 'subagent') {
        if (!step.compaction) agg.conversationTokens += c.estTokens;
        continue;
      }
      const tool = c.toolUseId ? tools.get(c.toolUseId) : undefined;
      const name = tool?.name ?? c.category;
      const firstRecord = !c.toolUseId || !counted.has(c.toolUseId);
      if (c.toolUseId) counted.add(c.toolUseId);
      const wasted = !!tool && WASTED.has(tool.status);
      const b = bucketOf(agg.tools, name);
      const skillKey = name === 'Skill' && tool?.inputSummary ? tool.inputSummary : null;
      const skill = skillKey ? bucketOf(agg.skills, skillKey) : null;
      b.bytes += c.bytes;
      if (skill) skill.bytes += c.bytes;
      if (firstRecord) {
        b.calls++;
        b.durationMs += tool?.durationMs ?? 0;
        if (tool?.status === 'denied') b.deniedCalls++;
        else if (tool?.status === 'error') b.errorCalls++;
        if (skill) {
          skill.calls++;
          skill.durationMs += tool?.durationMs ?? 0;
        }
      }
      if (step.compaction) continue;
      b.estTokens += c.estTokens;
      agg.attributedTokens += c.estTokens;
      carry(carriedTools, name, c.estTokens);
      if (wasted) {
        b.wastedTokens += c.estTokens;
        carry(carriedWasted, name, c.estTokens);
      }
      if (skill && skillKey) {
        skill.estTokens += c.estTokens;
        carry(carriedSkills, skillKey, c.estTokens);
      }
    }

    if (step.compaction) continue;
    const denom = Math.max(step.contextTokens, sum(carriedTools) + sum(carriedAttachments));
    // Skills are a subset of the tool buckets, so only tools and attachments
    // count toward the session's attributed total.
    agg.attributedUsd += allocate(carriedTools, agg.tools, 'estUsd', stepUsd, denom);
    agg.attributedUsd += allocate(carriedAttachments, agg.attachments, 'estUsd', stepUsd, denom);
    allocate(carriedSkills, agg.skills, 'estUsd', stepUsd, denom);
    allocate(carriedWasted, agg.tools, 'wastedUsd', stepUsd, denom);
  }

  for (const rec of records) {
    if (rec.type !== 'system' || rec.subtype !== 'compact_boundary') continue;
    agg.compaction.count++;
    const c = safeJson(rec.extra).compaction ?? {};
    const pre = Number(c.preTokens);
    const post = Number(c.postTokens);
    if (Number.isFinite(pre) && Number.isFinite(post)) agg.compaction.discardedTokens += Math.max(0, pre - post);
  }

  // Calls that never produced an appended result (pending, or made inside a
  // subagent) contribute no tokens but are still worth counting.
  for (const t of tools.values()) {
    if (counted.has(t.toolUseId)) continue;
    const b = bucketOf(agg.tools, t.name);
    if (t.agentId) b.subagentCalls++;
    else b.calls++;
    b.durationMs += t.durationMs ?? 0;
    if (t.status === 'denied') b.deniedCalls++;
    else if (t.status === 'error') b.errorCalls++;
    if (t.name === 'Skill' && t.inputSummary) {
      const s = bucketOf(agg.skills, t.inputSummary);
      if (t.agentId) s.subagentCalls++;
      else s.calls++;
    }
  }

  const parentOf = new Map<string, string>();
  for (const row of db.prepare('SELECT agent_id, tool_use_id FROM subagents WHERE session_id = ?').all(sessionId) as any[]) {
    if (row.tool_use_id) parentOf.set(row.agent_id, row.tool_use_id);
  }
  for (const chain of walkAgentChains(db, sessionId)) {
    const parentId = parentOf.get(chain.agentId);
    const parent = parentId ? tools.get(parentId) : undefined;
    let chainUsd = 0;
    for (const step of chain.steps) {
      const r = step.request;
      agg.subagentRequests++;
      agg.outputTokens += r.output;
      agg.cacheReadTokens += r.cache_read;
      agg.cacheWriteTokens += r.cw5m + r.cw1h;
      chainUsd +=
        inputSideCost(r.model, {
          inputTokens: r.input,
          cacheReadTokens: r.cache_read,
          cacheWrite5mTokens: r.cw5m,
          cacheWrite1hTokens: r.cw1h,
          speed: r.speed,
        }) ?? 0;
      accountCache(step.cache, r);
    }
    agg.inputUsd += chainUsd;
    if (parent && chainUsd > 0) {
      bucketOf(agg.tools, parent.name).estUsd += chainUsd;
      agg.attributedUsd += chainUsd;
    }
  }

  return agg;
}

interface ScopeRow {
  session_id: string;
  project_dir: string;
  cwd: string | null;
  last_ts: string | null;
  record_count: number;
  cost: number;
}

export interface InsightsOptions {
  project?: string | null;
  sinceDays?: number | null;
}

interface Span {
  from: number | null;
  to: number | null;
}

/** The window in scope, and the one of the same length just before it. */
function spans(sinceDays: number | null | undefined): { current: Span; previous: Span | null } {
  if (!sinceDays) return { current: { from: null, to: null }, previous: null };
  const now = Date.now();
  const len = sinceDays * DAY_MS;
  return { current: { from: now - len, to: null }, previous: { from: now - 2 * len, to: now - len } };
}

/** Sessions in scope, newest last, with the numbers the cache key is built from. */
function scopeSessions(db: DB, opts: InsightsOptions, span: Span): ScopeRow[] {
  const rows = db
    .prepare(`SELECT session_id, project_dir, cwd, last_ts, record_count,
        CASE WHEN cost_cli IS NOT NULL AND cost_cli >= cost_est THEN cost_cli ELSE cost_est END AS cost
      FROM sessions WHERE record_count > 0 ORDER BY COALESCE(last_ts, '')`)
    .all() as ScopeRow[];
  const project = opts.project ?? null;
  return rows.filter((r) => {
    if (project && r.cwd !== project && r.project_dir !== project) return false;
    if (span.from === null && span.to === null) return true;
    const t = r.last_ts ? Date.parse(r.last_ts) : NaN;
    if (!Number.isFinite(t)) return false;
    if (span.from !== null && t < span.from) return false;
    if (span.to !== null && t >= span.to) return false;
    return true;
  });
}

function fingerprint(rows: ScopeRow[]): string {
  const latest = rows[rows.length - 1];
  const records = rows.reduce((a, r) => a + r.record_count, 0);
  return `${rows.length}:${records}:${latest ? `${latest.session_id}@${latest.last_ts ?? ''}` : '-'}`;
}

function cacheKey(rows: ScopeRow[], prevRows: ScopeRow[], opts: InsightsOptions): string {
  return [
    CACHE_KEY_VERSION,
    PAYLOAD_VERSION,
    opts.project ?? '*',
    opts.sinceDays ?? '*',
    fingerprint(rows),
    fingerprint(prevRows),
  ].join('|');
}

/**
 * Per-session aggregate, from the cache when the session's record_count is
 * unchanged. Returns how many had to be recomputed so the UI can say whether
 * it paid for a cold index.
 */
function loadAggregates(db: DB, rows: ScopeRow[]): { aggregates: SessionAggregate[]; recomputed: number } {
  const get = db.prepare('SELECT payload FROM session_aggregates WHERE session_id = ? AND payload_version = ? AND fingerprint = ?');
  const put = db.prepare(`INSERT INTO session_aggregates (session_id, payload_version, fingerprint, computed_at, payload)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET payload_version = excluded.payload_version,
      fingerprint = excluded.fingerprint, computed_at = excluded.computed_at, payload = excluded.payload`);
  const aggregates: SessionAggregate[] = [];
  let recomputed = 0;
  for (const row of rows) {
    const hit = get.get(row.session_id, PAYLOAD_VERSION, row.record_count) as { payload: string } | undefined;
    if (hit) {
      try {
        aggregates.push(JSON.parse(hit.payload) as SessionAggregate);
        continue;
      } catch {
        // Unreadable cache row: fall through and recompute it.
      }
    }
    const agg = aggregateSession(db, row.session_id);
    put.run(row.session_id, PAYLOAD_VERSION, row.record_count, new Date().toISOString(), JSON.stringify(agg));
    recomputed++;
    aggregates.push(agg);
  }
  return { aggregates, recomputed };
}

/** How many bands a stacked chart can carry before it stops being readable. */
const MAX_BANDS = 8;

interface DimEntry {
  dim: InsightDimension;
  key: string;
  label: string;
  category?: ToolCategory;
  bucket: Bucket;
}

/**
 * Every (grouping, key) a session contributes to. The table and the trend
 * chart both read this, so a row and its band can never disagree about what
 * "MCP server: jira" means.
 */
function* dimensionEntries(agg: SessionAggregate): Generator<DimEntry> {
  for (const [name, bucket] of Object.entries(agg.tools)) {
    const category = toolCategory(name);
    yield { dim: 'byTool', key: name, label: name, category, bucket };
    yield { dim: 'byCategory', key: category, label: CATEGORY_LABEL[category], category, bucket };
    const mcp = parseMcpToolName(name);
    if (mcp) {
      yield { dim: 'byMcpServer', key: mcp.server, label: mcp.server, category: 'mcp', bucket };
      yield { dim: 'byMcpTool', key: name, label: `${mcp.server} \u00b7 ${mcp.tool}`, category: 'mcp', bucket };
    }
  }
  for (const [key, bucket] of Object.entries(agg.skills)) yield { dim: 'bySkill', key, label: key, bucket };
  for (const [key, bucket] of Object.entries(agg.attachments)) yield { dim: 'byAttachment', key, label: key, bucket };
}

const DIMENSIONS: InsightDimension[] = ['byCategory', 'byTool', 'byMcpServer', 'byMcpTool', 'bySkill', 'byAttachment'];

class RowSet {
  private rows = new Map<string, InsightRow & { sessionIds: Set<string> }>();

  add(key: string, label: string, category: ToolCategory | undefined, b: Bucket, sessionId: string) {
    let r = this.rows.get(key);
    if (!r) {
      r = { key, label, category, colorIndex: -1, sessions: 0, calls: 0, subagentCalls: 0, errorCalls: 0, deniedCalls: 0, estTokens: 0, wastedTokens: 0, estUsd: 0, wastedUsd: 0, avgTokens: 0, bytes: 0, durationMs: 0, sessionIds: new Set() };
      this.rows.set(key, r);
    }
    r.calls += b.calls;
    r.subagentCalls += b.subagentCalls;
    r.errorCalls += b.errorCalls;
    r.deniedCalls += b.deniedCalls;
    r.estTokens += b.estTokens;
    r.wastedTokens += b.wastedTokens;
    r.estUsd += b.estUsd;
    r.wastedUsd += b.wastedUsd;
    r.bytes += b.bytes;
    r.durationMs += b.durationMs;
    r.sessionIds.add(sessionId);
  }

  finish(limit = MAX_ROWS): InsightRow[] {
    return [...this.rows.values()]
      .map(({ sessionIds, ...r }) => ({ ...r, sessions: sessionIds.size, avgTokens: r.calls > 0 ? Math.round(r.estTokens / r.calls) : 0 }))
      .sort((a, b) => b.estTokens - a.estTokens || b.calls - a.calls)
      .slice(0, limit)
      // Colour follows rank by tokens, which is also how the chart picks its
      // bands, so the top rows and the bands line up.
      .map((r, i) => ({ ...r, colorIndex: i < MAX_BANDS ? i : -1 }));
  }
}

/** Start of the bucket a timestamp falls in, as an ISO date (UTC). */
function bucketStart(ms: number, unit: TrendUnit): string {
  const d = new Date(ms);
  if (unit === 'month') return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // Week buckets start on Monday.
  if (unit === 'week') day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}

function nextBucket(startIso: string, unit: TrendUnit): string {
  const d = new Date(startIso + 'T00:00:00.000Z');
  if (unit === 'month') d.setUTCMonth(d.getUTCMonth() + 1);
  else d.setUTCDate(d.getUTCDate() + (unit === 'week' ? 7 : 1));
  return d.toISOString().slice(0, 10);
}

/**
 * Bucket the per-session aggregates by when the session ended. A session is
 * short relative to any of these units, so it lands whole in one bucket rather
 * than being split. Empty buckets are filled in so a gap in the work reads as
 * a gap rather than as two adjacent bars.
 */
function buildTrend(rows: ScopeRow[], bySession: Map<string, SessionAggregate>, costBySession: Map<string, number>): InsightsView['trend'] {
  const noBands = Object.fromEntries(DIMENSIONS.map((d) => [d, [] as TrendSeries[]])) as Record<InsightDimension, TrendSeries[]>;
  const empty: InsightsView['trend'] = { unit: 'day', buckets: [], stacks: noBands };
  const dated = rows
    .map((r) => ({ r, ms: r.last_ts ? Date.parse(r.last_ts) : NaN }))
    .filter((x) => Number.isFinite(x.ms))
    .sort((a, b) => a.ms - b.ms);
  if (!dated.length) return empty;

  const spanDays = (dated[dated.length - 1].ms - dated[0].ms) / DAY_MS;
  const unit: TrendUnit = spanDays <= 60 ? 'day' : spanDays <= 400 ? 'week' : 'month';

  // Lay out every bucket in the span first, gaps included, so a quiet week
  // reads as a gap rather than as two adjacent bars.
  const starts: string[] = [];
  const last = bucketStart(dated[dated.length - 1].ms, unit);
  for (let cur = bucketStart(dated[0].ms, unit); ; cur = nextBucket(cur, unit)) {
    starts.push(cur);
    if (cur === last || starts.length > 1000) break;
  }
  const indexOf = new Map(starts.map((d, i) => [d, i]));
  const buckets: TrendBucket[] = starts.map((start) => ({
    start,
    sessions: 0,
    requests: 0,
    attributedTokens: 0,
    attributedUsd: 0,
    rewrittenTokens: 0,
    costUsd: 0,
    toolCalls: 0,
  }));

  type Band = { key: string; label: string; category?: ToolCategory; values: number[]; usdValues: number[]; total: number };
  const bands = new Map<InsightDimension, Map<string, Band>>(DIMENSIONS.map((d) => [d, new Map()]));

  for (const { r, ms } of dated) {
    const i = indexOf.get(bucketStart(ms, unit));
    if (i === undefined) continue;
    const b = buckets[i];
    b.sessions++;
    b.costUsd += costBySession.get(r.session_id) ?? 0;
    const agg = bySession.get(r.session_id);
    if (!agg) continue;
    b.requests += agg.requests;
    b.attributedTokens += agg.attributedTokens;
    b.attributedUsd += agg.attributedUsd;
    b.rewrittenTokens += agg.cache.rewrittenTokens;
    b.toolCalls += agg.toolCalls;
    for (const e of dimensionEntries(agg)) {
      if (e.bucket.estTokens <= 0 && e.bucket.estUsd <= 0) continue;
      const m = bands.get(e.dim)!;
      let band = m.get(e.key);
      if (!band) {
        band = {
          key: e.key,
          label: e.label,
          category: e.category,
          values: new Array(starts.length).fill(0),
          usdValues: new Array(starts.length).fill(0),
          total: 0,
        };
        m.set(e.key, band);
      }
      band.values[i] += e.bucket.estTokens;
      band.usdValues[i] += e.bucket.estUsd;
      band.total += e.bucket.estTokens;
    }
  }

  // Keep the largest bands and fold the tail into one, so the stack stays
  // readable without hiding tokens.
  const stacks = Object.fromEntries(
    DIMENSIONS.map((dim) => {
      const all = [...bands.get(dim)!.values()].sort((a, b) => b.total - a.total);
      const top = all.slice(0, MAX_BANDS);
      const rest = all.slice(MAX_BANDS);
      const series: TrendSeries[] = top.map((b, i) => ({
        key: b.key,
        label: b.label,
        category: b.category,
        colorIndex: i,
        values: b.values,
        usdValues: b.usdValues,
      }));
      if (rest.length) {
        series.push({
          key: '\u0000rest',
          label: `Other (${rest.length})`,
          colorIndex: -1,
          values: starts.map((_, i) => rest.reduce((a, b) => a + b.values[i], 0)),
          usdValues: starts.map((_, i) => rest.reduce((a, b) => a + b.usdValues[i], 0)),
        });
      }
      return [dim, series];
    }),
  ) as Record<InsightDimension, TrendSeries[]>;

  return { unit, buckets, stacks };
}

interface Summary {
  totals: InsightTotals;
  dims: Record<InsightDimension, InsightRow[]>;
  waste: {
    calls: number;
    full: number;
    partial: number;
    eligibleCalls: number;
    cold: number;
    rewrittenTokens: number;
    rewrittenUsd: number;
    coldTokens: number;
    coldUsd: number;
  };
  reasons: InsightCacheReason[];
  compaction: InsightsView['compaction'];
}

function summarize(rows: ScopeRow[], aggregates: SessionAggregate[]): Summary {
  const sets: Record<InsightDimension, RowSet> = {
    byCategory: new RowSet(),
    byTool: new RowSet(),
    byMcpServer: new RowSet(),
    byMcpTool: new RowSet(),
    bySkill: new RowSet(),
    byAttachment: new RowSet(),
  };
  const costBySession = new Map(rows.map((r) => [r.session_id, r.cost ?? 0]));

  const totals: InsightTotals = {
    sessions: aggregates.length,
    requests: 0,
    subagentRequests: 0,
    contextTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    toolCalls: 0,
    attributedTokens: 0,
    conversationTokens: 0,
    inputUsd: 0,
    attributedUsd: 0,
  };
  const waste = { calls: 0, full: 0, partial: 0, eligibleCalls: 0, cold: 0, rewrittenTokens: 0, rewrittenUsd: 0, coldTokens: 0, coldUsd: 0 };
  const compaction = { count: 0, sessions: 0, discardedTokens: 0, rewrittenTokens: 0, rewrittenUsd: 0 };
  const reasons = new Map<CacheReasonCode, InsightCacheReason>();

  for (const agg of aggregates) {
    const sid = agg.sessionId;
    totals.requests += agg.requests;
    totals.subagentRequests += agg.subagentRequests;
    totals.contextTokens += agg.contextTokens;
    totals.outputTokens += agg.outputTokens;
    totals.cacheReadTokens += agg.cacheReadTokens;
    totals.cacheWriteTokens += agg.cacheWriteTokens;
    totals.toolCalls += agg.toolCalls;
    totals.attributedTokens += agg.attributedTokens;
    totals.conversationTokens += agg.conversationTokens;
    totals.inputUsd += agg.inputUsd;
    totals.attributedUsd += agg.attributedUsd;
    totals.costUsd += costBySession.get(sid) ?? 0;

    waste.calls += agg.cache.calls;
    waste.full += agg.cache.full;
    waste.partial += agg.cache.partial;
    waste.eligibleCalls += agg.cache.eligibleCalls;
    waste.cold += agg.cache.cold;
    waste.rewrittenTokens += agg.cache.rewrittenTokens;
    waste.rewrittenUsd += agg.cache.rewrittenUsd;
    waste.coldTokens += agg.cache.coldTokens;
    waste.coldUsd += agg.cache.coldUsd;

    if (agg.compaction.count > 0) compaction.sessions++;
    compaction.count += agg.compaction.count;
    compaction.discardedTokens += agg.compaction.discardedTokens;
    compaction.rewrittenTokens += agg.compaction.rewrittenTokens;
    compaction.rewrittenUsd += agg.compaction.rewrittenUsd;

    for (const [code, e] of Object.entries(agg.cache.reasons)) {
      const c = code as CacheReasonCode;
      const cur = reasons.get(c) ?? { code: c, count: 0, rewrittenTokens: 0, rewrittenUsd: 0 };
      cur.count += e.count;
      cur.rewrittenTokens += e.rewrittenTokens;
      cur.rewrittenUsd += e.rewrittenUsd ?? 0;
      reasons.set(c, cur);
    }

    for (const e of dimensionEntries(agg)) sets[e.dim].add(e.key, e.label, e.category, e.bucket, sid);
  }

  const dims = Object.fromEntries(DIMENSIONS.map((d) => [d, sets[d].finish()])) as Record<InsightDimension, InsightRow[]>;
  return {
    totals,
    dims,
    waste,
    reasons: [...reasons.values()].sort((a, b) => b.rewrittenTokens - a.rewrittenTokens),
    compaction,
  };
}

const ADVICE_DIMENSIONS: InsightDimension[] = ['byMcpServer', 'bySkill', 'byTool'];

function adviseFrom(summary: Summary): InsightAdvice[] {
  const attributed = summary.totals.attributedUsd;
  const share = (usd: number) => (attributed > 0 ? usd / attributed : 0);
  const found = new Map<string, InsightAdvice>();
  const flaggedServers = new Set<string>();

  const consider = (dim: InsightDimension, row: InsightRow, kind: InsightAdviceKind) => {
    const id = `${dim}:${row.key}`;
    if (found.has(id)) return;
    found.set(id, {
      kind,
      dimension: dim,
      key: row.key,
      label: row.label,
      sessions: row.sessions,
      calls: row.calls + row.subagentCalls,
      estTokens: row.estTokens,
      estUsd: row.estUsd,
      wastedTokens: row.wastedTokens,
      wastedUsd: row.wastedUsd,
      shareOfAttributed: share(row.estUsd),
    });
    if (dim === 'byMcpServer') flaggedServers.add(row.key);
  };

  for (const dim of ADVICE_DIMENSIONS) {
    for (const row of summary.dims[dim]) {
      const mcp = parseMcpToolName(row.key);
      if (dim === 'byTool' && mcp && flaggedServers.has(mcp.server)) continue;
      const calls = row.calls + row.subagentCalls;
      if (calls === 0) continue;
      const perCall = row.estUsd / calls;
      if (share(row.estUsd) >= 0.25) consider(dim, row, 'dominant');
      else if (calls <= 5 && row.sessions <= 2 && row.estUsd >= 0.5 && perCall >= 0.1) consider(dim, row, 'rarely-used');
      else if (calls >= 3 && perCall >= 0.25 && share(row.estUsd) >= 0.03) consider(dim, row, 'expensive-per-call');
      else if (row.wastedUsd >= 1 && row.wastedUsd >= row.estUsd * 0.25) consider(dim, row, 'error-prone');
    }
  }
  return [...found.values()].sort((a, b) => b.estUsd - a.estUsd).slice(0, 5);
}

function projectList(db: DB) {
  return (
    db
      .prepare(`SELECT COALESCE(cwd, project_dir) AS value, COUNT(*) AS n FROM sessions
        WHERE record_count > 0 GROUP BY value ORDER BY n DESC`)
      .all() as Array<{ value: string; n: number }>
  ).map((p) => ({ value: p.value, label: p.value, sessions: p.n }));
}

function previousOf(rows: ScopeRow[], aggregates: SessionAggregate[], sinceDays: number): InsightsView['previous'] {
  const summary = summarize(rows, aggregates);
  const rowsByDim = Object.fromEntries(
    DIMENSIONS.map((d) => [d, summary.dims[d].map((r) => ({ key: r.key, calls: r.calls, estTokens: r.estTokens, estUsd: r.estUsd }))]),
  ) as Record<InsightDimension, InsightPreviousRow[]>;
  return { sinceDays, totals: summary.totals, cacheWaste: summary.waste, rows: rowsByDim };
}

function rollup(
  db: DB,
  rows: ScopeRow[],
  aggregates: SessionAggregate[],
  opts: InsightsOptions,
  key: string,
  recomputed: number,
  previous: InsightsView['previous'],
): InsightsView {
  const summary = summarize(rows, aggregates);
  const latest = rows[rows.length - 1];
  return {
    key,
    computedAt: new Date().toISOString(),
    cached: false,
    recomputed,
    scope: { project: opts.project ?? null, sinceDays: opts.sinceDays ?? null },
    latest: latest ? { sessionId: latest.session_id, lastTs: latest.last_ts } : null,
    totals: summary.totals,
    byCategory: summary.dims.byCategory,
    byTool: summary.dims.byTool,
    byMcpServer: summary.dims.byMcpServer,
    byMcpTool: summary.dims.byMcpTool,
    bySkill: summary.dims.bySkill,
    byAttachment: summary.dims.byAttachment,
    cacheWaste: { ...summary.waste, reasons: summary.reasons },
    compaction: summary.compaction,
    advice: adviseFrom(summary),
    previous,
    priceTableDate: PRICE_TABLE_DATE,
    trend: buildTrend(rows, new Map(aggregates.map((a) => [a.sessionId, a])), new Map(rows.map((r) => [r.session_id, r.cost ?? 0]))),
    projects: projectList(db),
  };
}

export function buildInsights(db: DB, opts: InsightsOptions = {}): InsightsView {
  const span = spans(opts.sinceDays);
  const rows = scopeSessions(db, opts, span.current);
  const prevRows = span.previous ? scopeSessions(db, opts, span.previous) : [];
  const key = cacheKey(rows, prevRows, opts);
  const hit = db.prepare('SELECT computed_at, payload FROM insight_cache WHERE key = ?').get(key) as
    | { computed_at: string; payload: string }
    | undefined;
  if (hit) {
    try {
      return { ...(JSON.parse(hit.payload) as InsightsView), key, computedAt: hit.computed_at, cached: true, recomputed: 0 };
    } catch {
      // Unreadable cache row: recompute over it.
    }
  }
  const { aggregates, recomputed } = loadAggregates(db, rows);
  const prev = span.previous
    ? previousOf(prevRows, loadAggregates(db, prevRows).aggregates, opts.sinceDays as number)
    : null;
  const view = rollup(db, rows, aggregates, opts, key, recomputed, prev);
  db.prepare(`INSERT INTO insight_cache (key, computed_at, payload) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET computed_at = excluded.computed_at, payload = excluded.payload`).run(
    key,
    view.computedAt,
    JSON.stringify(view),
  );
  // Keys embed a growing fingerprint, so stale rows accumulate one per change.
  db.prepare('DELETE FROM insight_cache WHERE key <> ? AND computed_at < ?').run(key, new Date(Date.now() - 86_400_000).toISOString());
  return view;
}
