// Tolerant transcript line parser (R7). Never throws: unknown record types
// still produce a ParsedRecord with whatever envelope fields exist, and the
// UI falls back to a raw-JSON view for them.
import type { ToolStatus } from '../shared/types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  speed: string | null;
}

export interface ToolUse {
  id: string;
  name: string;
  input: Json;
  inputSummary: string;
}

export interface ToolResult {
  toolUseId: string;
  status: ToolStatus;
  denialKind: string | null;
  persistedOutputPath: string | null;
}

export interface HookInfo {
  hookName: string;
  hookEvent: string | null;
  command: string | null;
  exitCode: number | null;
  durationMs: number | null;
  ok: boolean;
}

export interface MetaInfo {
  aiTitle?: string;
  agentName?: string;
  lastPrompt?: string;
  leafUuid?: string;
  permissionMode?: string;
  costUsd?: number;
  prLink?: { prNumber: number | null; prUrl: string };
}

export interface ParsedRecord {
  /** null when the line was not valid JSON. */
  raw: Json | null;
  parseError: string | null;
  type: string;
  subtype: string | null;
  uuid: string | null;
  parentUuid: string | null;
  logicalParentUuid: string | null;
  sessionId: string | null;
  agentId: string | null;
  ts: string | null;
  cwd: string | null;
  gitBranch: string | null;
  version: string | null;
  isSidechain: boolean;
  isMeta: boolean;
  requestId: string | null;
  summary: string;
  model: string | null;
  effort: string | null;
  stopReason: string | null;
  usage: Usage | null;
  isApiError: boolean;
  toolUses: ToolUse[];
  toolResults: ToolResult[];
  /** Text of a human-typed prompt (user record that is not a tool result or meta). */
  humanPrompt: string | null;
  hook: HookInfo | null;
  meta: MetaInfo | null;
  compaction: { trigger: string | null; preTokens: number | null; postTokens: number | null } | null;
  attachmentKind: string | null;
  turnDurationMs: number | null;
  /** Bytes of the part that reaches the model (message content / attachment), for context attribution. */
  contentBytes: number;
}

const SUMMARY_MAX = 240;

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function n0(v: unknown): number {
  return num(v) ?? 0;
}

export function truncate(s: string, max = SUMMARY_MAX): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content) {
    if (b && typeof b === 'object') {
      if (typeof b.text === 'string') parts.push(b.text);
      else if (b.type === 'image') parts.push('[image]');
      else if (b.type === 'tool_result') parts.push(textOfContent(b.content));
    } else if (typeof b === 'string') parts.push(b);
  }
  return parts.join(' ');
}

export function parseUsage(u: Json): Usage | null {
  if (!u || typeof u !== 'object') return null;
  const cc = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : null;
  const write5m = cc ? n0(cc.ephemeral_5m_input_tokens) : 0;
  const write1h = cc ? n0(cc.ephemeral_1h_input_tokens) : 0;
  const totalWrite = n0(u.cache_creation_input_tokens);
  return {
    inputTokens: n0(u.input_tokens),
    outputTokens: n0(u.output_tokens),
    thinkingTokens: n0(u.output_tokens_details?.thinking_tokens),
    cacheReadTokens: n0(u.cache_read_input_tokens),
    // Older records lack the TTL breakdown; count the total as 5m writes.
    cacheWrite5mTokens: cc ? write5m : totalWrite,
    cacheWrite1hTokens: write1h,
    speed: str(u.speed),
  };
}

/** One-line description of a tool call's input for list views. */
export function summarizeToolInput(name: string, input: Json): string {
  if (!input || typeof input !== 'object') return typeof input === 'string' ? truncate(input) : '';
  const pick = (...keys: string[]) => {
    for (const k of keys) if (typeof input[k] === 'string' && input[k]) return input[k] as string;
    return null;
  };
  const byTool: Record<string, string[]> = {
    Bash: ['command'],
    Read: ['file_path'],
    Write: ['file_path'],
    Edit: ['file_path'],
    MultiEdit: ['file_path'],
    NotebookEdit: ['notebook_path'],
    Grep: ['pattern'],
    Glob: ['pattern'],
    WebFetch: ['url'],
    WebSearch: ['query'],
    Agent: ['description', 'prompt'],
    Task: ['description', 'prompt'],
    Skill: ['skill'],
    ToolSearch: ['query'],
    Monitor: ['description', 'command'],
  };
  const v = pick(...(byTool[name] ?? []), 'description', 'command', 'query', 'path', 'file_path', 'url', 'name');
  if (v) return truncate(v);
  try {
    return truncate(JSON.stringify(input));
  } catch {
    return '';
  }
}

function toolResultStatus(block: Json, rec: Json): ToolStatus {
  if (str(rec.toolDenialKind)) return 'denied';
  const tur = rec.toolUseResult;
  if (tur && typeof tur === 'object' && tur.interrupted === true) return 'interrupted';
  const text = textOfContent(block.content);
  if (text.startsWith('[Request interrupted by user')) return 'interrupted';
  if (block.is_error === true) return 'error';
  return 'ok';
}

function emptyRecord(raw: Json | null, parseError: string | null): ParsedRecord {
  return {
    raw,
    parseError,
    type: 'unknown',
    subtype: null,
    uuid: null,
    parentUuid: null,
    logicalParentUuid: null,
    sessionId: null,
    agentId: null,
    ts: null,
    cwd: null,
    gitBranch: null,
    version: null,
    isSidechain: false,
    isMeta: false,
    requestId: null,
    summary: '',
    model: null,
    effort: null,
    stopReason: null,
    usage: null,
    isApiError: false,
    toolUses: [],
    toolResults: [],
    humanPrompt: null,
    hook: null,
    meta: null,
    compaction: null,
    attachmentKind: null,
    turnDurationMs: null,
    contentBytes: 0,
  };
}

export function parseLine(line: string): ParsedRecord {
  let o: Json;
  try {
    o = JSON.parse(line);
  } catch (e) {
    const r = emptyRecord(null, (e as Error).message);
    r.type = 'invalid';
    r.summary = truncate(line, 120);
    return r;
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) {
    const r = emptyRecord(o, 'not an object');
    r.type = 'invalid';
    return r;
  }
  try {
    return parseObject(o);
  } catch (e) {
    // A shape we didn't anticipate: keep the envelope, flag it, move on.
    const r = emptyRecord(o, `parser: ${(e as Error).message}`);
    r.type = str(o.type) ?? 'unknown';
    r.uuid = str(o.uuid);
    r.sessionId = str(o.sessionId);
    r.ts = str(o.timestamp);
    return r;
  }
}

function parseObject(o: Json): ParsedRecord {
  const r = emptyRecord(o, null);
  r.type = str(o.type) ?? 'unknown';
  r.subtype = str(o.subtype);
  r.uuid = str(o.uuid);
  r.parentUuid = str(o.parentUuid);
  r.logicalParentUuid = str(o.logicalParentUuid);
  r.sessionId = str(o.sessionId) ?? str(o.session_id);
  r.agentId = str(o.agentId);
  r.ts = str(o.timestamp);
  r.cwd = str(o.cwd);
  r.gitBranch = str(o.gitBranch);
  r.version = str(o.version);
  r.isSidechain = o.isSidechain === true;
  r.isMeta = o.isMeta === true;
  r.requestId = str(o.requestId);

  r.contentBytes = contentBytes(o);

  switch (r.type) {
    case 'assistant':
      parseAssistant(o, r);
      break;
    case 'user':
      parseUser(o, r);
      break;
    case 'attachment':
      parseAttachment(o, r);
      break;
    case 'system':
      parseSystem(o, r);
      break;
    default:
      parseMetadata(o, r);
  }
  return r;
}

function parseAssistant(o: Json, r: ParsedRecord) {
  const m = o.message && typeof o.message === 'object' ? o.message : {};
  r.model = str(m.model);
  r.effort = str(o.effort);
  r.stopReason = str(m.stop_reason);
  r.usage = parseUsage(m.usage);
  r.isApiError = o.isApiErrorMessage === true || o.error !== undefined;
  const content = Array.isArray(m.content) ? m.content : typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : [];
  const labels: string[] = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'tool_use' && typeof b.id === 'string') {
      const name = str(b.name) ?? '?';
      const inputSummary = summarizeToolInput(name, b.input);
      r.toolUses.push({ id: b.id, name, input: b.input, inputSummary });
      labels.push(`${name}(${inputSummary})`);
    } else if (b.type === 'text') {
      labels.push(str(b.text) ?? '');
    } else if (b.type === 'thinking' || b.type === 'redacted_thinking') {
      const t = str(b.thinking);
      labels.push(t ? `[thinking] ${t}` : '[thinking]');
    } else {
      labels.push(`[${str(b.type) ?? 'block'}]`);
    }
  }
  r.summary = truncate(labels.join(' '));
}

function parseUser(o: Json, r: ParsedRecord) {
  const m = o.message && typeof o.message === 'object' ? o.message : {};
  const content = m.content;
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b && typeof b === 'object' && b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        const tur = o.toolUseResult;
        r.toolResults.push({
          toolUseId: b.tool_use_id,
          status: toolResultStatus(b, o),
          denialKind: str(o.toolDenialKind),
          persistedOutputPath: tur && typeof tur === 'object' ? str(tur.persistedOutputPath) : null,
        });
      }
    }
  }
  const text = textOfContent(content);
  if (r.toolResults.length === 0 && !r.isMeta && o.isCompactSummary !== true) {
    r.humanPrompt = text;
  }
  if (r.toolResults.length > 0) {
    const st = r.toolResults.map((t) => t.status).join(',');
    r.summary = truncate(`[tool_result ${st}] ${text}`);
  } else {
    r.summary = truncate(text);
  }
}

function parseAttachment(o: Json, r: ParsedRecord) {
  const a = o.attachment && typeof o.attachment === 'object' ? o.attachment : {};
  const kind = str(a.type) ?? 'unknown';
  r.attachmentKind = kind;
  r.subtype = kind;
  if (kind.startsWith('hook_') && str(a.hookName)) {
    const exitCode = num(a.exitCode);
    r.hook = {
      hookName: str(a.hookName)!,
      hookEvent: str(a.hookEvent),
      command: str(a.command),
      exitCode,
      durationMs: num(a.durationMs),
      ok: kind === 'hook_success' || kind === 'hook_additional_context' ? exitCode === null || exitCode === 0 : false,
    };
    r.summary = truncate(`${kind} ${a.hookName}${exitCode !== null ? ` exit=${exitCode}` : ''}`);
    return;
  }
  const label = str(a.content) ?? str(a.text) ?? str(a.filename) ?? str(a.path) ?? '';
  r.summary = truncate(`${kind}${label ? ' ' + label : ''}`);
}

function parseSystem(o: Json, r: ParsedRecord) {
  const sub = r.subtype ?? '';
  if (sub === 'compact_boundary') {
    const cm = o.compactMetadata && typeof o.compactMetadata === 'object' ? o.compactMetadata : {};
    r.compaction = { trigger: str(cm.trigger), preTokens: num(cm.preTokens), postTokens: num(cm.postTokens) };
    r.summary = truncate(`compaction (${cm.trigger ?? '?'}) ${cm.preTokens ?? '?'} → ${cm.postTokens ?? '?'} tokens`);
    return;
  }
  if (sub === 'turn_duration') {
    r.turnDurationMs = num(o.durationMs);
    r.summary = `turn ${o.durationMs ?? '?'}ms, ${o.messageCount ?? '?'} messages`;
    return;
  }
  if (sub === 'stop_hook_summary') {
    r.summary = truncate(`stop hooks: ${o.hookCount ?? '?'}${Array.isArray(o.hookErrors) && o.hookErrors.length ? `, ${o.hookErrors.length} errors` : ''}`);
    return;
  }
  const c = str(o.content) ?? '';
  r.summary = truncate(`${sub}${c ? ' ' + c : ''}`);
}

function parseMetadata(o: Json, r: ParsedRecord) {
  const meta: MetaInfo = {};
  switch (r.type) {
    case 'ai-title':
      if (str(o.aiTitle)) meta.aiTitle = o.aiTitle;
      r.summary = truncate(o.aiTitle ?? '');
      break;
    case 'agent-name':
      if (str(o.agentName)) meta.agentName = o.agentName;
      r.summary = truncate(o.agentName ?? '');
      break;
    case 'last-prompt':
      if (str(o.lastPrompt)) meta.lastPrompt = o.lastPrompt;
      if (str(o.leafUuid)) meta.leafUuid = o.leafUuid;
      r.summary = truncate(o.lastPrompt ?? '');
      break;
    case 'permission-mode':
      if (str(o.permissionMode)) meta.permissionMode = o.permissionMode;
      r.summary = o.permissionMode ?? '';
      break;
    case 'cost-state':
      if (num(o.totalCostUSD) !== null) meta.costUsd = o.totalCostUSD;
      r.summary = num(o.totalCostUSD) !== null ? `$${o.totalCostUSD.toFixed(4)}` : '';
      break;
    case 'pr-link':
      if (str(o.prUrl)) meta.prLink = { prNumber: num(o.prNumber), prUrl: o.prUrl };
      r.summary = o.prUrl ?? '';
      break;
    default:
      r.summary = truncate(str(o.mode) ?? str(o.operation) ?? '');
  }
  r.meta = meta;
}

/**
 * Size of what this record contributes to the prompt. For tool results this is
 * the `message.content` block (not the duplicated `toolUseResult`), for
 * attachments the attachment body.
 */
function contentBytes(o: Json): number {
  const part = o.message?.content ?? o.attachment ?? (typeof o.content === 'string' ? o.content : null);
  if (part === null || part === undefined) return 0;
  try {
    return Buffer.byteLength(typeof part === 'string' ? part : JSON.stringify(part));
  } catch {
    return 0;
  }
}
