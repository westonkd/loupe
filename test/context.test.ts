import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildContextView } from '../src/server/context.js';
import { openMemoryDb } from '../src/server/db.js';
import { Indexer } from '../src/server/indexer.js';
import { SafeFs } from '../src/server/safe-fs.js';
import { jsonl, makeClaudeDir, rec, SID, transcriptPath, usage } from './helpers.js';

const at = (o: any, iso: string) => ({ ...o, timestamp: iso });

function view(records: object[]) {
  const dir = makeClaudeDir();
  fs.writeFileSync(transcriptPath(dir), jsonl(records));
  const db = openMemoryDb();
  new Indexer(db, new SafeFs(dir)).syncAll();
  return buildContextView(db, SID);
}

describe('context correlation', () => {
  it('attributes a jump to the tool output appended before the request', () => {
    const big = 'x'.repeat(40_000);
    const v = view([
      at(rec.prompt('read the file', 0), '2026-01-01T00:00:00.000Z'),
      at(rec.toolUse('req_1', 'toolu_r', 'Read', { file_path: '/repo/big.ts' }, 0, usage(10, 100, 0, 5000)), '2026-01-01T00:00:02.000Z'),
      at(rec.toolResult('toolu_r', 0, { text: big }), '2026-01-01T00:00:03.000Z'),
      at(rec.assistantText('req_2', 'done', 0, usage(10, 50, 5000, 10_100)), '2026-01-01T00:00:06.000Z'),
    ]);
    expect(v.points).toHaveLength(2);
    const p = v.points[1];
    expect(p.deltaTokens).toBe(10_100);
    expect(p.dominant).toBe('tool_result');
    expect(p.contributors[0]).toMatchObject({ kind: 'tool_result', category: 'Read', label: 'Read: /repo/big.ts', toolUseId: 'toolu_r' });
    // The previous response (100 output tokens) is counted exactly, the rest goes to the tool output.
    expect(p.contributors.find((c) => c.kind === 'response')?.estTokens).toBe(100);
    expect(p.contributors[0].estTokens).toBe(10_000);
    expect(p.cache.severity).toBe('none');
    expect(v.consumers.byItem[0].label).toBe('Read: /repo/big.ts');
  });

  it('explains a cache miss after an idle gap longer than the TTL', () => {
    const v = view([
      at(rec.prompt('first', 0), '2026-01-01T00:00:00.000Z'),
      at(rec.assistantText('req_1', 'a', 0, usage(10, 20, 0, 50_000)), '2026-01-01T00:00:05.000Z'),
      at(rec.prompt('back after lunch', 0), '2026-01-01T00:20:00.000Z'),
      at(rec.assistantText('req_2', 'b', 0, usage(10, 20, 0, 50_100)), '2026-01-01T00:20:04.000Z'),
    ]);
    const c = v.points[1].cache;
    expect(c.severity).toBe('full');
    expect(c.reasons.join(' ')).toMatch(/Idle .* longer than the 5 min cache TTL/);
  });

  it('flags model changes as a cache-miss cause', () => {
    const other = (o: any) => ({ ...o, message: { ...o.message, model: 'claude-sonnet-5-5' } });
    const v = view([
      at(rec.assistantText('req_1', 'a', 0, usage(10, 20, 0, 30_000)), '2026-01-01T00:00:05.000Z'),
      at(other(rec.assistantText('req_2', 'b', 0, usage(10, 20, 0, 30_050))), '2026-01-01T00:00:09.000Z'),
    ]);
    expect(v.points[1].cache.reasons[0]).toMatch(/Model changed/);
  });
});
