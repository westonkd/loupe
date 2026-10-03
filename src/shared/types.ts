// DTOs shared by the HTTP API (src/server/api.ts) and the web UI.
import type { ToolCategory } from './tools.js';

export type Liveness = 'active' | 'idle' | 'ended';

export interface SessionSummary {
  sessionId: string;
  title: string;
  titleSource: 'ai-title' | 'agent-name' | 'first-prompt' | 'none';
  projectDir: string;
  cwd: string | null;
  gitBranch: string | null;
  models: string[];
  version: string | null;
  firstTs: string | null;
  lastTs: string | null;
  durationMs: number | null;
  costUsd: number | null;
  costSource: 'cli' | 'estimate' | null;
  liveness: Liveness;
  hasTranscript: boolean;
  recordCount: number;
  requestCount: number;
  toolCount: number;
  errorCount: number;
}

export interface SubagentInfo {
  agentId: string;
  agentType: string | null;
  description: string | null;
  toolUseId: string | null;
  recordCount: number;
}

export interface SessionDetail extends SessionSummary {
  subagents: SubagentInfo[];
  permissionMode: string | null;
  leafUuid: string | null;
  prLinks: Array<{ prNumber: number | null; prUrl: string }>;
}

export interface RequestRow {
  id: number;
  agentId: string | null;
  requestId: string;
  model: string | null;
  effort: string | null;
  speed: string | null;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  contextTokens: number;
  stopReason: string | null;
  ts: string | null;
  endTs: string | null;
  latencyMs: number | null;
  costUsd: number | null;
  firstRecordId: number;
  blockCount: number;
  toolUseCount: number;
  isError: boolean;
}

export type ToolStatus = 'ok' | 'error' | 'interrupted' | 'denied' | 'pending';

export interface ToolRow {
  id: number;
  agentId: string | null;
  toolUseId: string;
  name: string;
  mcpServer: string | null;
  inputSummary: string;
  status: ToolStatus;
  denialKind: string | null;
  startTs: string | null;
  endTs: string | null;
  durationMs: number | null;
  useRecordId: number | null;
  resultRecordId: number | null;
  requestId: string | null;
  /** For Agent calls: the subagent spawned by this call. */
  subagentId: string | null;
}

export interface HookRow {
  id: number;
  agentId: string | null;
  recordId: number;
  ts: string | null;
  hookName: string;
  hookEvent: string | null;
  command: string | null;
  exitCode: number | null;
  durationMs: number | null;
  ok: boolean;
}

export interface RecordRow {
  id: number;
  agentId: string | null;
  uuid: string | null;
  parentUuid: string | null;
  logicalParentUuid: string | null;
  type: string;
  subtype: string | null;
  ts: string | null;
  isSidechain: boolean;
  isMeta: boolean;
  requestId: string | null;
  toolUseId: string | null;
  summary: string;
  bytes: number;
}

export interface CompactionMarker {
  recordId: number;
  ts: string | null;
  trigger: string | null;
  preTokens: number | null;
  postTokens: number | null;
}

export interface InjectedContext {
  recordId: number;
  ts: string | null;
  kind: string;
  label: string;
  bytes: number;
}

export type ContributorKind = 'tool_result' | 'subagent' | 'attachment' | 'prompt' | 'response' | 'other';

/** Something appended to the conversation between two API requests. */
export interface ContextContributor {
  recordId: number | null;
  kind: ContributorKind;
  /** Grouping key: tool name, attachment type, 'prompt', 'response'. */
  category: string;
  label: string;
  bytes: number;
  /** Share of the measured token delta, apportioned by content size (exact for 'response'). */
  estTokens: number;
  toolUseId: string | null;
}

export type CacheReasonCode =
  | 'compaction'
  | 'model-change'
  | 'ttl-expired'
  | 'effort-change'
  | 'prefix-change'
  | 'cold-start'
  | 'unknown';

export interface CacheDiagnosis {
  /** none: most of the previous prompt was read from cache. */
  severity: 'none' | 'partial' | 'full' | 'cold';
  /** cache read ÷ previous request's context; null for the first request. */
  reuseRatio: number | null;
  reasons: string[];
  /** Machine-readable form of `reasons`, for aggregation across sessions. */
  codes: CacheReasonCode[];
}

export interface ContextPoint {
  requestRowId: number;
  /** Record id of the request's first block, for ordering against markers. */
  firstRecordId: number;
  ts: string | null;
  contextTokens: number;
  cacheHitRatio: number | null;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  model: string | null;
  effort: string | null;
  /** Context change since the previous main-agent request. */
  deltaTokens: number | null;
  /** Idle time between the previous request finishing and this one starting. */
  gapMs: number | null;
  contributors: ContextContributor[];
  /** Number of contributors before truncating to the largest. */
  contributorCount: number;
  dominant: ContributorKind | null;
  cache: CacheDiagnosis;
}

export interface ConsumerGroup {
  key: string;
  kind: ContributorKind;
  label: string;
  count: number;
  bytes: number;
  estTokens: number;
}

export interface ContextView {
  points: ContextPoint[];
  compactions: CompactionMarker[];
  turns: Array<{ recordId: number; ts: string | null }>;
  injected: InjectedContext[];
  /** What added the most context over the session, grouped by tool / attachment type / file. */
  consumers: { byCategory: ConsumerGroup[]; byItem: ConsumerGroup[] };
}

export interface Paged<T> {
  rows: T[];
  /** Highest row id returned; pass back as `after` for incremental fetches. */
  cursor: number;
}

export interface ToolCallDetail {
  tool: ToolRow;
  input: unknown;
  /** The `tool_result` content block, if a result arrived. */
  result: unknown;
  /** `toolUseResult` from the user record (structured per-tool result). */
  structured: unknown;
  persistedOutput: { path: string; size: number | null } | null;
}

export interface RequestDetail {
  request: RequestRow;
  /** Raw assistant records (one per content block) belonging to this request. */
  blocks: Array<{ recordId: number; raw: unknown }>;
  /** The record the request answered: the parent of its first block (a prompt or tool result). */
  input: { recordId: number; raw: unknown } | null;
}

export interface IndexStatus {
  indexing: boolean;
  filesTotal: number;
  filesDone: number;
  records: number;
  sessions: number;
  startedAt: string | null;
  finishedAt: string | null;
  lastPollMs: number | null;
  archive: boolean;
  /** Bytes of transcript kept in the archive, when it is on. */
  archiveBytes: number;
  version: string;
}

export type ConsoleLevel = 'debug' | 'info' | 'warn' | 'error' | 'log';

export interface ConsoleEntry {
  id: string;
  ts: string | null;
  level: ConsoleLevel;
  source: 'debug' | 'hook' | 'system' | 'api';
  category: string | null;
  text: string;
  recordId: number | null;
}

export interface ConsoleView {
  entries: ConsoleEntry[];
  /** Whether a --debug log exists for this session. */
  hasDebugLog: boolean;
  truncated: boolean;
}

export type ServerEvent =
  | { type: 'session'; sessionId: string; cursor: number }
  | { type: 'sessions' }
  | { type: 'status'; status: IndexStatus };

/** One content block of the model call that made a tool call (Why view). */
export interface WhyBlock {
  kind: 'text' | 'thinking' | 'tool_use';
  /** Text or thinking text. Empty thinking means the transcript kept only a signature. */
  text?: string;
  toolUseId?: string;
  name?: string;
  inputSummary?: string;
}

/** A record the model had just received before deciding (Why view). */
export interface WhyRecord {
  recordId: number;
  type: string;
  subtype: string | null;
  summary: string;
  /** Size of the content that reaches the model. */
  contentBytes: number;
  isPrompt: boolean;
  toolUseId: string | null;
  toolName: string | null;
  toolStatus: ToolStatus | null;
}

/**
 * Why a tool call happened: the turn's prompt, what the model had just seen,
 * the model call's own text and thinking, and the result.
 */
export interface WhyView {
  tool: ToolRow;
  prompt: { recordId: number; ts: string | null; text: string; byAgent: boolean } | null;
  /** This model call's position among the model calls of its turn (1-based). */
  step: { index: number; of: number } | null;
  /** Records appended since the previous model call (newest last), capped. */
  before: WhyRecord[];
  beforeOmitted: number;
  modelCall: { row: RequestRow; blocks: WhyBlock[] } | null;
  /** When the model call has no visible text: the latest assistant text earlier in the turn. */
  earlierText: { recordId: number; ts: string | null; text: string } | null;
  result: { recordId: number; contentBytes: number } | null;
}

/* ---------- Cross-session insights (#/insights) ---------- */

/** One row of an insights table: a tool, MCP server, skill or attachment kind. */
export interface InsightRow {
  key: string;
  label: string;
  /** Set on tool and MCP rows; absent for skills and attachments. */
  category?: ToolCategory;
  /** Rank among the top rows by tokens, or -1. Drives the shared colour. */
  colorIndex: number;
  /** Number of sessions this row appeared in. */
  sessions: number;
  /** Distinct main-agent tool calls, counted once each however many result records they produced. */
  calls: number;
  /** Calls made inside a subagent; counted, but their tokens land on the parent's Agent row. */
  subagentCalls: number;
  errorCalls: number;
  deniedCalls: number;
  /** Estimated context tokens this row added, summed over every session. */
  estTokens: number;
  /** Estimated tokens added by calls that errored, were denied, or were interrupted. */
  wastedTokens: number;
  /**
   * Approximate share of prompt-side spend these tokens caused, counting every
   * later model call that re-sent them. Bundled API prices; see InsightTotals.
   * An Agent row also carries the exact prompt spend of the subagents it
   * spawned, which is measured rather than apportioned.
   */
  estUsd: number;
  /** The part of `estUsd` spent on calls that errored, were denied or interrupted. */
  wastedUsd: number;
  /** estTokens ÷ calls: the "is one use of this expensive" number. */
  avgTokens: number;
  bytes: number;
  /** Total wall-clock time spent in these calls, where both timestamps were recorded. */
  durationMs: number;
}

export interface InsightCacheReason {
  code: CacheReasonCode;
  count: number;
  /** Cache-write tokens on the calls blamed on this reason. */
  rewrittenTokens: number;
  /** What those cache writes cost at bundled API prices. */
  rewrittenUsd: number;
}

export interface InsightTotals {
  sessions: number;
  requests: number;
  subagentRequests: number;
  /** Sum of every main-agent call's context (input + cache read + cache write). */
  contextTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  toolCalls: number;
  /** Context tokens the consumers table can blame on a tool result or attachment. */
  attributedTokens: number;
  conversationTokens: number;
  /**
   * Prompt-side spend (uncached input, cache reads, cache writes) of every
   * model call in scope, subagents included, at bundled API prices. Output
   * tokens are excluded: this is the part the conversation's size causes.
   */
  inputUsd: number;
  /** The part of `inputUsd` that lands on a row of the consumers table. */
  attributedUsd: number;
}

export type TrendUnit = 'day' | 'week' | 'month';

/** The groupings the consumers table and the trend chart share. */
export type InsightDimension = 'byCategory' | 'byTool' | 'byMcpServer' | 'byMcpTool' | 'bySkill' | 'byAttachment';

/** One time bucket of the aggregate, for the trend chart. */
export interface TrendBucket {
  /** ISO date of the bucket's first day. */
  start: string;
  sessions: number;
  requests: number;
  attributedTokens: number;
  attributedUsd: number;
  rewrittenTokens: number;
  costUsd: number;
  toolCalls: number;
}

/** One stacked band of the trend chart; `key` matches an InsightRow's key. */
export interface TrendSeries {
  key: string;
  label: string;
  category?: ToolCategory;
  /** Shared with the table so a band and its row carry the same colour. */
  colorIndex: number;
  /** One value per bucket, same order as `trend.buckets`. */
  values: number[];
  /** The same bands priced, so the chart can be read in either unit. */
  usdValues: number[];
}

export type InsightAdviceKind = 'rarely-used' | 'expensive-per-call' | 'error-prone' | 'dominant';

export interface InsightAdvice {
  kind: InsightAdviceKind;
  dimension: InsightDimension;
  key: string;
  label: string;
  sessions: number;
  calls: number;
  estTokens: number;
  estUsd: number;
  wastedTokens: number;
  wastedUsd: number;
  /** This row's share of everything the consumers table could attribute. */
  shareOfAttributed: number;
}

/** One grouping's rows in the window before the one in scope, for deltas. */
export interface InsightPreviousRow {
  key: string;
  calls: number;
  estTokens: number;
  estUsd: number;
}

export interface InsightsView {
  /** Cache key the payload was stored under; changes when new data lands. */
  key: string;
  computedAt: string;
  cached: boolean;
  /** How many session aggregates had to be (re)computed to answer this request. */
  recomputed: number;
  scope: { project: string | null; sinceDays: number | null };
  /** The newest session included, whose identity is part of the cache key. */
  latest: { sessionId: string; lastTs: string | null } | null;
  totals: InsightTotals;
  byCategory: InsightRow[];
  byTool: InsightRow[];
  byMcpServer: InsightRow[];
  byMcpTool: InsightRow[];
  bySkill: InsightRow[];
  byAttachment: InsightRow[];
  cacheWaste: {
    calls: number;
    full: number;
    partial: number;
    eligibleCalls: number;
    cold: number;
    rewrittenTokens: number;
    /** What those cache writes cost at bundled API prices. */
    rewrittenUsd: number;
    coldTokens: number;
    coldUsd: number;
    reasons: InsightCacheReason[];
  };
  /**
   * The same totals bucketed over time; granularity follows the span in scope.
   * `stacks` holds one set of bands per grouping, so changing the grouping
   * redraws the chart and the table from the same keys.
   */
  trend: { unit: TrendUnit; buckets: TrendBucket[]; stacks: Record<InsightDimension, TrendSeries[]> };
  /** What compaction cost: rewriting the prompt, and the history it dropped. */
  compaction: {
    count: number;
    sessions: number;
    discardedTokens: number;
    rewrittenTokens: number;
    rewrittenUsd: number;
  };
  /** Rows worth a second look, with the numbers behind the verdict. */
  advice: InsightAdvice[];
  /**
   * The equivalent window immediately before this one, for change over time.
   * Null when the scope has no bound to step back from.
   */
  previous: {
    sinceDays: number;
    totals: InsightTotals;
    cacheWaste: Omit<InsightsView['cacheWaste'], 'reasons'>;
    rows: Record<InsightDimension, InsightPreviousRow[]>;
  } | null;
  /** Date the bundled price table was last refreshed by hand. */
  priceTableDate: string;
  /** Projects present in the index, for the scope picker. */
  projects: Array<{ value: string; label: string; sessions: number }>;
}
