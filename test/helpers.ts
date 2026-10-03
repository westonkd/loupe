// Synthetic transcript builders. Never copy real transcript lines into tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SID = '11111111-2222-3333-4444-555555555555';
export const PROJECT = '-tmp-example-project';

let seq = 0;
const ts = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();

function envelope(extra: Record<string, unknown>) {
  seq++;
  return {
    uuid: `u-${seq}`,
    sessionId: SID,
    cwd: '/tmp/example/project',
    gitBranch: 'main',
    version: '2.1.288',
    isSidechain: false,
    userType: 'external',
    entrypoint: 'cli',
    ...extra,
  };
}

export const rec = {
  prompt: (text: string, s: number, parentUuid: string | null = null) =>
    envelope({ type: 'user', parentUuid, timestamp: ts(s), message: { role: 'user', content: text } }),
  assistantText: (
    requestId: string,
    text: string,
    s: number,
    usage: object,
    parentUuid: string | null = null,
    model = 'claude-opus-5-5',
  ) =>
    envelope({
      type: 'assistant',
      parentUuid,
      timestamp: ts(s),
      requestId,
      effort: 'high',
      message: { model, role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage },
    }),
  toolUse: (requestId: string, id: string, name: string, input: object, s: number, usage: object) =>
    envelope({
      type: 'assistant',
      parentUuid: null,
      timestamp: ts(s),
      requestId,
      message: {
        model: 'claude-opus-5-5',
        role: 'assistant',
        content: [{ type: 'tool_use', id, name, input }],
        stop_reason: 'tool_use',
        usage,
      },
    }),
  toolResult: (id: string, s: number, opts: { isError?: boolean; denial?: string; interrupted?: boolean; text?: string } = {}) =>
    envelope({
      type: 'user',
      parentUuid: null,
      timestamp: ts(s),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: opts.isError, content: opts.text ?? 'ok' }] },
      ...(opts.denial ? { toolDenialKind: opts.denial } : {}),
      toolUseResult: { stdout: 'ok', stderr: '', interrupted: opts.interrupted ?? false },
    }),
  hook: (name: string, s: number, exitCode = 0) =>
    envelope({
      type: 'attachment',
      parentUuid: null,
      timestamp: ts(s),
      attachment: { type: 'hook_success', hookName: name, hookEvent: name.split(':')[0], command: 'echo hi', exitCode, durationMs: 12 },
    }),
  compact: (s: number) =>
    envelope({
      type: 'system',
      subtype: 'compact_boundary',
      parentUuid: null,
      timestamp: ts(s),
      compactMetadata: { trigger: 'auto', preTokens: 150000, postTokens: 12000 },
    }),
  aiTitle: (title: string) => ({ type: 'ai-title', sessionId: SID, aiTitle: title }),
  costState: (usd: number) => ({ type: 'cost-state', sessionId: SID, totalCostUSD: usd }),
  unknown: () => ({ type: 'brand-new-record-type', sessionId: SID, whatever: { nested: [1, 2] } }),
};

export const usage = (input: number, output: number, cacheRead = 0, w5 = 0, w1 = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: w5 + w1,
  cache_creation: { ephemeral_5m_input_tokens: w5, ephemeral_1h_input_tokens: w1 },
});

export function jsonl(records: object[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

export function makeClaudeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtools-test-'));
  fs.mkdirSync(path.join(dir, 'projects', PROJECT), { recursive: true });
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  return dir;
}

export function transcriptPath(dir: string, sid = SID) {
  return path.join(dir, 'projects', PROJECT, `${sid}.jsonl`);
}

export function writeSubagent(
  dir: string,
  agentId: string,
  toolUseId: string,
  records: object[],
  sid = SID,
): void {
  const base = path.join(dir, 'projects', PROJECT, sid, 'subagents');
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, `agent-${agentId}.jsonl`), jsonl(records.map((r) => ({ ...(r as any), sessionId: sid, isSidechain: true }))));
  fs.writeFileSync(
    path.join(base, `agent-${agentId}.meta.json`),
    JSON.stringify({ agentId, agentType: 'Explore', description: 'look around', toolUseId }),
  );
}
