import { describe, expect, it } from 'vitest';
import { parseLine, parseUsage, summarizeToolInput } from '../src/server/parser.js';
import { rec, usage } from './helpers.js';

const line = (o: object) => JSON.stringify(o);

describe('parseLine', () => {
  it('never throws on invalid JSON', () => {
    const r = parseLine('{"type": "assistant", "trunc');
    expect(r.type).toBe('invalid');
    expect(r.parseError).toBeTruthy();
  });

  it('keeps unknown record types with their envelope', () => {
    const r = parseLine(line(rec.unknown()));
    expect(r.type).toBe('brand-new-record-type');
    expect(r.sessionId).toBeTruthy();
    expect(r.parseError).toBeNull();
  });

  it('tolerates odd shapes inside known types', () => {
    const r = parseLine(line({ type: 'assistant', message: { content: 'just a string', usage: 'nope' } }));
    expect(r.type).toBe('assistant');
    expect(r.usage).toBeNull();
    expect(r.summary).toContain('just a string');
    expect(parseLine(line({ type: 'user', message: null })).type).toBe('user');
    expect(parseLine('[1,2,3]').type).toBe('invalid');
  });

  it('extracts tool_use blocks with an input summary', () => {
    const r = parseLine(line(rec.toolUse('req_1', 'toolu_1', 'Bash', { command: 'ls -la' }, 1, usage(1, 2))));
    expect(r.toolUses).toEqual([expect.objectContaining({ id: 'toolu_1', name: 'Bash', inputSummary: 'ls -la' })]);
    expect(r.requestId).toBe('req_1');
    expect(r.model).toBe('claude-opus-5-5');
  });

  it('maps tool_result status: ok, error, denied, interrupted', () => {
    expect(parseLine(line(rec.toolResult('a', 1))).toolResults[0].status).toBe('ok');
    expect(parseLine(line(rec.toolResult('a', 1, { isError: true }))).toolResults[0].status).toBe('error');
    expect(parseLine(line(rec.toolResult('a', 1, { isError: true, denial: 'user-rejected' }))).toolResults[0]).toMatchObject({
      status: 'denied',
      denialKind: 'user-rejected',
    });
    expect(parseLine(line(rec.toolResult('a', 1, { interrupted: true }))).toolResults[0].status).toBe('interrupted');
  });

  it('treats a user string as a human prompt but not tool results or meta', () => {
    expect(parseLine(line(rec.prompt('hello', 1))).humanPrompt).toBe('hello');
    expect(parseLine(line(rec.toolResult('a', 1))).humanPrompt).toBeNull();
    expect(parseLine(line({ ...rec.prompt('x', 1), isMeta: true })).humanPrompt).toBeNull();
  });

  it('parses hooks, compaction and metadata records', () => {
    expect(parseLine(line(rec.hook('PreToolUse:Bash', 1))).hook).toMatchObject({ hookName: 'PreToolUse:Bash', ok: true, durationMs: 12 });
    expect(parseLine(line(rec.hook('Stop', 1, 2))).hook?.ok).toBe(false);
    expect(parseLine(line(rec.compact(1))).compaction).toEqual({ trigger: 'auto', preTokens: 150000, postTokens: 12000 });
    expect(parseLine(line(rec.aiTitle('My title'))).meta?.aiTitle).toBe('My title');
    expect(parseLine(line(rec.costState(1.5))).meta?.costUsd).toBe(1.5);
  });
});

describe('parseUsage', () => {
  it('splits cache writes by TTL', () => {
    expect(parseUsage(usage(2, 100, 5000, 300, 700))).toMatchObject({
      inputTokens: 2,
      outputTokens: 100,
      cacheReadTokens: 5000,
      cacheWrite5mTokens: 300,
      cacheWrite1hTokens: 700,
    });
  });
  it('counts untyped cache writes as 5m', () => {
    expect(parseUsage({ input_tokens: 1, cache_creation_input_tokens: 40 })).toMatchObject({ cacheWrite5mTokens: 40, cacheWrite1hTokens: 0 });
  });
});

describe('summarizeToolInput', () => {
  it('picks the most useful field per tool', () => {
    expect(summarizeToolInput('Read', { file_path: '/a/b.ts' })).toBe('/a/b.ts');
    expect(summarizeToolInput('WebFetch', { url: 'https://x.test', prompt: 'p' })).toBe('https://x.test');
    expect(summarizeToolInput('mcp__srv__tool', { foo: 1 })).toBe('{"foo":1}');
  });
});
