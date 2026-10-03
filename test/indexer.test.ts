import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openMemoryDb, type DB } from '../src/server/db.js';
import { Indexer } from '../src/server/indexer.js';
import { SafeFs } from '../src/server/safe-fs.js';
import { jsonl, makeClaudeDir, PROJECT, rec, SID, transcriptPath, usage } from './helpers.js';

let dir: string;
let db: DB;
let indexer: Indexer;
let now = Date.now();

const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;

beforeEach(() => {
  dir = makeClaudeDir();
  db = openMemoryDb();
  now = Date.now();
  indexer = new Indexer(db, new SafeFs(dir), {}, () => now);
});

describe('Indexer', () => {
  it('indexes a transcript and derives requests, tools, hooks and session metadata', () => {
    fs.writeFileSync(
      transcriptPath(dir),
      jsonl([
        rec.aiTitle('Synthetic session'),
        rec.prompt('please list files', 0),
        rec.hook('UserPromptSubmit', 1),
        rec.toolUse('req_a', 'toolu_1', 'Bash', { command: 'ls' }, 3, usage(10, 20, 1000, 50)),
        rec.toolResult('toolu_1', 5),
        rec.assistantText('req_b', 'done', 8, usage(5, 7, 1100)),
        rec.compact(9),
        rec.unknown(),
      ]),
    );
    const res = indexer.syncAll();
    expect(res.changed.get(SID)).toBeGreaterThan(0);
    const s = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(SID) as any;
    expect(s).toMatchObject({ ai_title: 'Synthetic session', first_prompt: 'please list files', cwd: '/tmp/example/project', record_count: 8, request_count: 2, tool_count: 1 });
    expect(JSON.parse(s.models)).toEqual(['claude-opus-5-5']);
    expect(s.cost_est).toBeGreaterThan(0);

    const t = db.prepare('SELECT * FROM tool_calls').get() as any;
    expect(t).toMatchObject({ name: 'Bash', status: 'ok', input_summary: 'ls' });
    expect(t.result_record_id).toBeGreaterThan(t.use_record_id);

    const r = db.prepare("SELECT * FROM requests WHERE request_id = 'req_b'").get() as any;
    // Latency baseline is the tool result at :05; the request's first block is at :08.
    expect(r.latency_ms).toBe(3000);
    expect(count('SELECT COUNT(*) n FROM hooks')).toBe(1);
    expect(count("SELECT COUNT(*) n FROM records WHERE type = 'brand-new-record-type'")).toBe(1);
  });

  it('takes usage from the last block line of a request instead of summing', () => {
    fs.writeFileSync(
      transcriptPath(dir),
      jsonl([
        rec.assistantText('req_x', 'thinking…', 1, usage(3, 10, 500)),
        rec.toolUse('req_x', 'toolu_9', 'Read', { file_path: '/a' }, 2, usage(3, 42, 500)),
      ]),
    );
    indexer.syncAll();
    const r = db.prepare('SELECT * FROM requests').get() as any;
    expect(r).toMatchObject({ input: 3, output: 42, cache_read: 500, block_count: 2, tool_use_count: 1 });
  });

  it('retries a partial trailing line instead of dropping it', () => {
    const p = transcriptPath(dir);
    const full = JSON.stringify(rec.prompt('second', 2));
    fs.writeFileSync(p, jsonl([rec.prompt('first', 1)]) + full.slice(0, 20));
    indexer.syncAll();
    expect(count('SELECT COUNT(*) n FROM records')).toBe(1);
    fs.appendFileSync(p, full.slice(20) + '\n');
    indexer.syncAll();
    expect(count('SELECT COUNT(*) n FROM records')).toBe(2);
    expect(count("SELECT COUNT(*) n FROM records WHERE type = 'invalid'")).toBe(0);
  });

  it('accepts a final line without newline once the file has settled', () => {
    const p = transcriptPath(dir);
    fs.writeFileSync(p, JSON.stringify(rec.prompt('only', 1)));
    indexer.syncAll();
    expect(count('SELECT COUNT(*) n FROM records')).toBe(0);
    now += 60_000;
    indexer.syncAll();
    expect(count('SELECT COUNT(*) n FROM records')).toBe(1);
  });

  it('reindexes a truncated or replaced file', () => {
    const p = transcriptPath(dir);
    fs.writeFileSync(p, jsonl([rec.prompt('a', 1), rec.prompt('b', 2), rec.prompt('c', 3)]));
    indexer.syncAll();
    expect(count('SELECT COUNT(*) n FROM records')).toBe(3);
    fs.writeFileSync(p, jsonl([rec.prompt('z', 1)]));
    indexer.syncAll();
    expect(count('SELECT COUNT(*) n FROM records')).toBe(1);
    expect((db.prepare('SELECT first_prompt FROM sessions').get() as any).first_prompt).toBe('z');
  });

  it('keeps a stub when cleanup deletes the transcript', () => {
    const p = transcriptPath(dir);
    fs.writeFileSync(p, jsonl([rec.aiTitle('Gone soon'), rec.prompt('hi', 1)]));
    indexer.syncAll();
    fs.rmSync(p);
    const res = indexer.syncAll();
    expect(res.sessionsChanged).toBe(true);
    const s = db.prepare('SELECT * FROM sessions').get() as any;
    expect(s).toMatchObject({ has_transcript: 0, ai_title: 'Gone soon' });
  });

  it('links subagent transcripts to the spawning tool_use via meta.json', () => {
    const p = transcriptPath(dir);
    fs.writeFileSync(p, jsonl([rec.toolUse('req_1', 'toolu_agent', 'Agent', { description: 'Explore' }, 1, usage(1, 1))]));
    const subDir = path.join(dir, 'projects', PROJECT, SID, 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Look around', toolUseId: 'toolu_agent' }));
    fs.writeFileSync(path.join(subDir, 'agent-a1.jsonl'), jsonl([{ ...rec.prompt('sub task', 2), isSidechain: true, agentId: 'a1' }]));
    indexer.syncAll();
    expect(db.prepare('SELECT * FROM subagents').get()).toMatchObject({ agent_id: 'a1', agent_type: 'Explore', tool_use_id: 'toolu_agent' });
    expect(count("SELECT COUNT(*) n FROM records WHERE agent_id = 'a1'")).toBe(1);
    // Subagent prompts don't become the session's first prompt.
    expect((db.prepare('SELECT first_prompt FROM sessions').get() as any).first_prompt).toBeNull();
  });

  it('records denied and pending tool calls', () => {
    fs.writeFileSync(
      transcriptPath(dir),
      jsonl([
        rec.toolUse('req_1', 'toolu_d', 'Bash', { command: 'rm -rf /' }, 1, usage(1, 1)),
        rec.toolResult('toolu_d', 2, { isError: true, denial: 'permission-rule' }),
        rec.toolUse('req_2', 'toolu_p', 'mcp__jira__search', { query: 'x' }, 3, usage(1, 1)),
      ]),
    );
    indexer.syncAll();
    const rows = db.prepare('SELECT tool_use_id, status, denial_kind, mcp_server FROM tool_calls ORDER BY id').all();
    expect(rows).toEqual([
      { tool_use_id: 'toolu_d', status: 'denied', denial_kind: 'permission-rule', mcp_server: null },
      { tool_use_id: 'toolu_p', status: 'pending', denial_kind: null, mcp_server: 'jira' },
    ]);
  });

  it('only reads new bytes on later passes', () => {
    const p = transcriptPath(dir);
    fs.writeFileSync(p, jsonl([rec.prompt('a', 1)]));
    indexer.syncAll();
    const res1 = indexer.syncAll();
    expect(res1.changed.size).toBe(0);
    fs.appendFileSync(p, jsonl([rec.prompt('b', 2)]));
    const res2 = indexer.syncAll();
    expect(res2.changed.size).toBe(1);
    expect(count('SELECT COUNT(*) n FROM records')).toBe(2);
  });
});
