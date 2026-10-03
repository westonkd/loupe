import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildInsights } from '../src/server/insights.js';
import { openMemoryDb } from '../src/server/db.js';
import { Indexer } from '../src/server/indexer.js';
import { SafeFs } from '../src/server/safe-fs.js';
import { jsonl, makeClaudeDir, rec, SID, transcriptPath, usage, writeSubagent } from './helpers.js';

const at = (o: any, iso: string) => ({ ...o, timestamp: iso });
const SID2 = '99999999-8888-7777-6666-555555555555';

function indexed(byFile: Record<string, object[]>, extra?: (dir: string) => void) {
  const dir = makeClaudeDir();
  for (const [sid, records] of Object.entries(byFile)) {
    fs.writeFileSync(
      transcriptPath(dir, sid),
      jsonl(records.map((r) => ({ ...(r as any), sessionId: sid }))),
    );
  }
  extra?.(dir);
  const db = openMemoryDb();
  new Indexer(db, new SafeFs(dir)).syncAll();
  return db;
}

/** One session: a Read whose result is big, then a Bash whose result is small. */
function twoToolSession() {
  return [
    at(rec.prompt('look at things', 0), '2026-01-01T00:00:00.000Z'),
    at(rec.toolUse('req_1', 'toolu_a', 'Read', { file_path: '/repo/big.ts' }, 0, usage(10, 100, 0, 5000)), '2026-01-01T00:00:02.000Z'),
    at(rec.toolResult('toolu_a', 0, { text: 'x'.repeat(40_000) }), '2026-01-01T00:00:03.000Z'),
    at(rec.toolUse('req_2', 'toolu_b', 'Bash', { command: 'ls' }, 0, usage(10, 60, 5000, 10_100)), '2026-01-01T00:00:06.000Z'),
    at(rec.toolResult('toolu_b', 0, { text: 'y'.repeat(100) }), '2026-01-01T00:00:07.000Z'),
    at(rec.assistantText('req_3', 'done', 0, usage(10, 20, 15_100, 200)), '2026-01-01T00:00:09.000Z'),
  ];
}

describe('cross-session insights', () => {
  it('attributes tokens to the tool and its category, across sessions', () => {
    const db = indexed({ [SID]: twoToolSession(), [SID2]: twoToolSession() });
    const v = buildInsights(db);

    expect(v.totals.sessions).toBe(2);
    const read = v.byTool.find((r) => r.key === 'Read')!;
    expect(read.sessions).toBe(2);
    expect(read.calls).toBe(2);
    // 10k tokens apportioned to the Read output in each session (see context.test.ts).
    expect(read.estTokens).toBe(20_000);
    expect(read.avgTokens).toBe(10_000);
    expect(read.category).toBe('file_read');

    const bash = v.byTool.find((r) => r.key === 'Bash')!;
    expect(bash.estTokens).toBeLessThan(read.estTokens);
    expect(v.byCategory.map((c) => c.key)).toContain('shell');
    expect(v.byCategory.find((c) => c.key === 'file_read')!.estTokens).toBe(20_000);
  });

  it('splits MCP tools into server and tool rows', () => {
    const db = indexed({
      [SID]: [
        at(rec.prompt('ask the server', 0), '2026-01-01T00:00:00.000Z'),
        at(rec.toolUse('req_1', 'toolu_m', 'mcp__jira__getJiraIssue', { issue: 'ABC-1' }, 0, usage(10, 100, 0, 5000)), '2026-01-01T00:00:02.000Z'),
        at(rec.toolResult('toolu_m', 0, { text: 'z'.repeat(8000) }), '2026-01-01T00:00:03.000Z'),
        at(rec.assistantText('req_2', 'ok', 0, usage(10, 20, 5000, 2100)), '2026-01-01T00:00:06.000Z'),
      ],
    });
    const v = buildInsights(db);
    expect(v.byMcpServer.map((r) => r.key)).toEqual(['jira']);
    expect(v.byMcpTool[0].label).toBe('jira · getJiraIssue');
    expect(v.byMcpServer[0].estTokens).toBe(v.byMcpTool[0].estTokens);
    expect(v.byTool.find((r) => r.key === 'mcp__jira__getJiraIssue')!.category).toBe('mcp');
    expect(v.byCategory.find((c) => c.key === 'mcp')!.estTokens).toBe(v.byMcpServer[0].estTokens);
  });

  it('keys skills by the skill argument and counts injected attachments', () => {
    const db = indexed({
      [SID]: [
        at(rec.prompt('use the skill', 0), '2026-01-01T00:00:00.000Z'),
        at(rec.toolUse('req_1', 'toolu_s', 'Skill', { skill: 'dataviz' }, 0, usage(10, 100, 0, 5000)), '2026-01-01T00:00:02.000Z'),
        at(rec.toolResult('toolu_s', 0, { text: 's'.repeat(4000) }), '2026-01-01T00:00:03.000Z'),
        at(rec.hook('PostToolUse:Skill', 0), '2026-01-01T00:00:04.000Z'),
        at(rec.assistantText('req_2', 'ok', 0, usage(10, 20, 5000, 1100)), '2026-01-01T00:00:06.000Z'),
      ],
    });
    const v = buildInsights(db);
    expect(v.bySkill.map((r) => r.key)).toEqual(['dataviz']);
    expect(v.bySkill[0].estTokens).toBeGreaterThan(0);
    expect(v.byCategory.find((c) => c.key === 'skill')!.estTokens).toBe(v.bySkill[0].estTokens);
    // hook_success is kept in the transcript but never sent, so it costs nothing.
    expect(v.byAttachment.find((a) => a.key === 'hook_success')).toBeUndefined();
  });

  it('counts tokens spent on a denied tool call as wasted', () => {
    const db = indexed({
      [SID]: [
        at(rec.prompt('delete it', 0), '2026-01-01T00:00:00.000Z'),
        at(rec.toolUse('req_1', 'toolu_d', 'Bash', { command: 'rm -rf /' }, 0, usage(10, 100, 0, 5000)), '2026-01-01T00:00:02.000Z'),
        at(rec.toolResult('toolu_d', 0, { denial: 'rule', text: 'n'.repeat(2000) }), '2026-01-01T00:00:03.000Z'),
        at(rec.assistantText('req_2', 'ok', 0, usage(10, 20, 5000, 1100)), '2026-01-01T00:00:06.000Z'),
      ],
    });
    const bash = buildInsights(db).byTool.find((r) => r.key === 'Bash')!;
    expect(bash.deniedCalls).toBe(1);
    expect(bash.wastedTokens).toBe(bash.estTokens);
    expect(bash.wastedTokens).toBeGreaterThan(0);
  });

  it('prices a consumer by every prompt that re-sent it, not just the one it entered', () => {
    const tail = [
      at(rec.assistantText('req_4', 'more', 0, usage(10, 20, 15_300, 200)), '2026-01-01T00:00:12.000Z'),
      at(rec.assistantText('req_5', 'more', 0, usage(10, 20, 15_500, 200)), '2026-01-01T00:00:15.000Z'),
    ];
    const short = buildInsights(indexed({ [SID]: twoToolSession() }));
    const long = buildInsights(indexed({ [SID]: [...twoToolSession(), ...tail] }));
    const readShort = short.byTool.find((r) => r.key === 'Read')!;
    const readLong = long.byTool.find((r) => r.key === 'Read')!;

    expect(readLong.estTokens).toBe(readShort.estTokens);
    expect(readLong.estUsd).toBeGreaterThan(readShort.estUsd);
    expect(readShort.estUsd).toBeGreaterThan(short.byTool.find((r) => r.key === 'Bash')!.estUsd);
  });

  it('keeps attributed spend within the prompt-side spend it came from', () => {
    const v = buildInsights(indexed({ [SID]: twoToolSession(), [SID2]: twoToolSession() }));
    expect(v.totals.attributedUsd).toBeGreaterThan(0);
    expect(v.totals.attributedUsd).toBeLessThanOrEqual(v.totals.inputUsd + 1e-9);
    const rows = v.byTool.reduce((a, r) => a + r.estUsd, 0);
    expect(rows).toBeLessThanOrEqual(v.totals.attributedUsd + 1e-9);
  });

  it('prices an avoidable cache miss and keeps a first call out of it', () => {
    const db = indexed({
      [SID]: [
        at(rec.prompt('first', 0), '2026-01-01T00:00:00.000Z'),
        at(rec.assistantText('req_1', 'a', 0, usage(10, 20, 0, 50_000)), '2026-01-01T00:00:05.000Z'),
        at(rec.prompt('back after lunch', 0), '2026-01-01T00:20:00.000Z'),
        at(rec.assistantText('req_2', 'b', 0, usage(10, 20, 0, 50_100)), '2026-01-01T00:20:04.000Z'),
      ],
    });
    const w = buildInsights(db).cacheWaste;

    expect(w.cold).toBe(1);
    expect(w.coldTokens).toBe(50_000);
    expect(w.coldUsd).toBeCloseTo((50_000 * 4 * 1.25) / 1_000_000, 10);
    expect(w.eligibleCalls).toBe(1);
    expect(w.calls).toBe(1);
    expect(w.full).toBe(1);
    expect(w.rewrittenTokens).toBe(50_100);
    // One model, so the blended figure is exactly the bundled 5m cache-write price.
    expect(w.rewrittenUsd).toBeCloseTo((50_100 * 4 * 1.25) / 1_000_000, 10);
    expect(w.reasons.some((r) => r.code === 'cold-start')).toBe(false);
  });

  it('splits a miss between its causes so the columns add up', () => {
    const db = indexed({
      [SID]: [
        at(rec.prompt('first', 0), '2026-01-01T00:00:00.000Z'),
        at(rec.assistantText('req_1', 'a', 0, usage(10, 20, 0, 50_000)), '2026-01-01T00:00:05.000Z'),
        at(rec.prompt('back after lunch, on another model', 0), '2026-01-01T00:20:00.000Z'),
        at(rec.assistantText('req_2', 'b', 0, usage(10, 20, 0, 50_100), null, 'claude-sonnet-5-5'), '2026-01-01T00:20:04.000Z'),
      ],
    });
    const w = buildInsights(db).cacheWaste;
    expect(w.reasons.map((r) => r.code).sort()).toEqual(['model-change', 'ttl-expired']);
    expect(w.reasons.every((r) => r.count === 1)).toBe(true);
    expect(w.reasons.reduce((a, r) => a + r.rewrittenTokens, 0)).toBeCloseTo(w.rewrittenTokens, 6);
    expect(w.reasons.reduce((a, r) => a + r.rewrittenUsd, 0)).toBeCloseTo(w.rewrittenUsd, 10);
  });

  it('prices wasted spend by how long the result stayed in the prompt', () => {
    const db = indexed({
      [SID]: [
        at(rec.prompt('delete it', 0), '2026-01-01T00:00:00.000Z'),
        at(rec.toolUse('req_1', 'toolu_d', 'Bash', { command: 'rm -rf /' }, 0, usage(10, 100, 0, 5000)), '2026-01-01T00:00:02.000Z'),
        at(rec.toolResult('toolu_d', 0, { denial: 'rule', text: 'n'.repeat(2000) }), '2026-01-01T00:00:03.000Z'),
        at(rec.assistantText('req_2', 'ok', 0, usage(10, 20, 5000, 1100)), '2026-01-01T00:00:06.000Z'),
      ],
    });
    const bash = buildInsights(db).byTool.find((r) => r.key === 'Bash')!;
    expect(bash.wastedUsd).toBeCloseTo(bash.estUsd, 10);
    expect(bash.estUsd).toBeGreaterThan(0);
  });

  it('aggregates cache-miss causes by code', () => {
    const db = indexed({
      [SID]: [
        at(rec.prompt('first', 0), '2026-01-01T00:00:00.000Z'),
        at(rec.assistantText('req_1', 'a', 0, usage(10, 20, 0, 50_000)), '2026-01-01T00:00:05.000Z'),
        at(rec.prompt('back after lunch', 0), '2026-01-01T00:20:00.000Z'),
        at(rec.assistantText('req_2', 'b', 0, usage(10, 20, 0, 50_100)), '2026-01-01T00:20:04.000Z'),
      ],
    });
    const v = buildInsights(db);
    expect(v.cacheWaste.full).toBe(1);
    expect(v.cacheWaste.reasons.map((r) => r.code)).toContain('ttl-expired');
    expect(v.cacheWaste.rewrittenTokens).toBeGreaterThan(0);
  });

  it('serves the rollup from cache until a session grows', () => {
    const dir = makeClaudeDir();
    const file = transcriptPath(dir);
    fs.writeFileSync(file, jsonl(twoToolSession()));
    const db = openMemoryDb();
    const indexer = new Indexer(db, new SafeFs(dir));
    indexer.syncAll();

    const first = buildInsights(db);
    expect(first.cached).toBe(false);
    expect(first.recomputed).toBe(1);
    expect(first.latest?.sessionId).toBe(SID);

    const again = buildInsights(db);
    expect(again.cached).toBe(true);
    expect(again.key).toBe(first.key);
    expect(again.byTool).toEqual(first.byTool);

    // New records in the same session change the key and force a recompute.
    fs.appendFileSync(
      file,
      jsonl([
        at(rec.toolUse('req_4', 'toolu_c', 'Read', { file_path: '/repo/more.ts' }, 0, usage(10, 100, 15_100, 300)), '2026-01-01T00:00:12.000Z'),
        at(rec.toolResult('toolu_c', 0, { text: 'q'.repeat(20_000) }), '2026-01-01T00:00:13.000Z'),
        at(rec.assistantText('req_5', 'done', 0, usage(10, 20, 15_400, 5000)), '2026-01-01T00:00:16.000Z'),
      ]).replace(/"sessionId":"[^"]*"/g, `"sessionId":"${SID}"`),
    );
    indexer.syncAll();

    const third = buildInsights(db);
    expect(third.cached).toBe(false);
    expect(third.recomputed).toBe(1);
    expect(third.key).not.toBe(first.key);
    expect(third.byTool.find((r) => r.key === 'Read')!.calls).toBe(2);
  });

  it('scopes to one project and reports the projects available', () => {
    const db = indexed({ [SID]: twoToolSession() });
    const v = buildInsights(db, { project: '/tmp/example/project' });
    expect(v.totals.sessions).toBe(1);
    expect(v.scope.project).toBe('/tmp/example/project');
    expect(v.projects.map((p) => p.value)).toEqual(['/tmp/example/project']);

    const none = buildInsights(db, { project: '/nowhere' });
    expect(none.totals.sessions).toBe(0);
    expect(none.byTool).toEqual([]);
    expect(none.latest).toBeNull();
    // Still lists every project, so the picker can get back out of an empty scope.
    expect(none.projects).toHaveLength(1);
  });

  it('buckets the aggregate over time and fills quiet buckets', () => {
    const shift = (recs: object[], day: number) =>
      recs.map((r: any) => (r.timestamp ? { ...r, timestamp: r.timestamp.replace('2026-01-01', `2026-01-0${day}`) } : r));
    const db = indexed({ [SID]: shift(twoToolSession(), 1), [SID2]: shift(twoToolSession(), 5) });
    const v = buildInsights(db);

    expect(v.trend.unit).toBe('day');
    // Jan 1 and Jan 5 have work; the three days between are emitted empty so a
    // gap reads as a gap.
    expect(v.trend.buckets.map((b) => b.start)).toEqual(['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05']);
    expect(v.trend.buckets.map((b) => b.sessions)).toEqual([1, 0, 0, 0, 1]);
    expect(v.trend.buckets[1].attributedTokens).toBe(0);

    // Every bucket's tokens add up to the total the table reports.
    const summed = v.trend.buckets.reduce((a, b) => a + b.attributedTokens, 0);
    expect(summed).toBe(v.totals.attributedTokens);
  });

  it('stacks the trend by the same keys the table groups by', () => {
    const db = indexed({ [SID]: twoToolSession() });
    const v = buildInsights(db);

    for (const dim of ['byCategory', 'byTool', 'byMcpServer', 'byMcpTool', 'bySkill', 'byAttachment'] as const) {
      const bandKeys = v.trend.stacks[dim].filter((b) => !b.key.startsWith('\u0000')).map((b) => b.key);
      const rowKeys = new Set(v[dim].map((r) => r.key));
      for (const k of bandKeys) expect(rowKeys.has(k)).toBe(true);
    }

    const read = v.byTool.find((r) => r.key === 'Read')!;
    const band = v.trend.stacks.byTool.find((b) => b.key === 'Read')!;
    // A band's values and its row's total are the same number, split by bucket.
    expect(band.values.reduce((a, b) => a + b, 0)).toBe(read.estTokens);
    // Colour is rank-based and shared, so band and row agree.
    expect(band.colorIndex).toBe(read.colorIndex);
    expect(band.colorIndex).toBe(0);
  });

  it('still counts a tool call whose result was compacted away', () => {
    const db = indexed({
      [SID]: [
        at(rec.prompt('look at things', 0), '2026-01-01T00:00:00.000Z'),
        at(rec.toolUse('req_1', 'toolu_a', 'Read', { file_path: '/repo/big.ts' }, 0, usage(10, 100, 0, 5000)), '2026-01-01T00:00:02.000Z'),
        at(rec.toolResult('toolu_a', 0, { text: 'x'.repeat(40_000) }), '2026-01-01T00:00:03.000Z'),
        at(rec.compact(0), '2026-01-01T00:00:04.000Z'),
        at(rec.assistantText('req_2', 'done', 0, usage(10, 20, 0, 9000)), '2026-01-01T00:00:06.000Z'),
      ],
    });
    const v = buildInsights(db);
    const read = v.byTool.find((r) => r.key === 'Read')!;
    expect(read.calls).toBe(1);
    expect(read.estTokens).toBe(0);
    const counted = v.byCategory.reduce((a, r) => a + r.calls + r.subagentCalls, 0);
    expect(counted).toBe(v.totals.toolCalls);
    expect(v.byTool.reduce((a, r) => a + r.calls + r.subagentCalls, 0)).toBe(counted);
  });

  it('counts one tool call once when its result arrives in several records', () => {
    const db = indexed({
      [SID]: [
        at(rec.prompt('read it', 0), '2026-01-01T00:00:00.000Z'),
        at(rec.toolUse('req_1', 'toolu_a', 'Read', { file_path: '/repo/big.ts' }, 0, usage(10, 100, 0, 5000)), '2026-01-01T00:00:02.000Z'),
        at(rec.toolResult('toolu_a', 0, { text: 'x'.repeat(20_000) }), '2026-01-01T00:00:03.000Z'),
        at(rec.toolResult('toolu_a', 0, { text: 'y'.repeat(20_000) }), '2026-01-01T00:00:04.000Z'),
        at(rec.assistantText('req_2', 'done', 0, usage(10, 20, 5000, 10_100)), '2026-01-01T00:00:06.000Z'),
      ],
    });
    const v = buildInsights(db);
    const read = v.byTool.find((r) => r.key === 'Read')!;
    expect(read.calls).toBe(1);
    expect(read.estTokens).toBeGreaterThan(0);
    expect(read.avgTokens).toBe(read.estTokens);
    expect(v.byCategory.reduce((a, r) => a + r.calls + r.subagentCalls, 0)).toBe(v.totals.toolCalls);
  });

  it('reports attributed context as exactly what the rows can blame', () => {
    const v = buildInsights(indexed({ [SID]: twoToolSession(), [SID2]: twoToolSession() }));
    const rowTokens =
      v.byTool.reduce((a, r) => a + r.estTokens, 0) + v.byAttachment.reduce((a, r) => a + r.estTokens, 0);
    expect(v.totals.attributedTokens).toBe(rowTokens);
    expect(v.totals.conversationTokens).toBeGreaterThan(0);
  });

  it("charges a subagent's own prompt spend to the Agent call that started it", () => {
    const db = indexed(
      {
        [SID]: [
          at(rec.prompt('go explore', 0), '2026-01-01T00:00:00.000Z'),
          at(rec.toolUse('req_1', 'toolu_ag', 'Agent', { prompt: 'look around' }, 0, usage(10, 100, 0, 5000)), '2026-01-01T00:00:02.000Z'),
          at(rec.toolResult('toolu_ag', 0, { text: 'found it' }), '2026-01-01T00:00:20.000Z'),
          at(rec.assistantText('req_2', 'thanks', 0, usage(10, 20, 5000, 200)), '2026-01-01T00:00:22.000Z'),
        ],
      },
      (dir) =>
        writeSubagent(dir, 'aaaa1111', 'toolu_ag', [
          at(rec.prompt('look around', 0), '2026-01-01T00:00:03.000Z'),
          at(rec.assistantText('sub_1', 'reading', 0, usage(100, 50, 0, 20_000)), '2026-01-01T00:00:08.000Z'),
          at(rec.assistantText('sub_2', 'found it', 0, usage(10, 50, 20_000, 300)), '2026-01-01T00:00:15.000Z'),
        ]),
    );
    const v = buildInsights(db);
    expect(v.totals.subagentRequests).toBe(2);

    const subUsd = (100 * 4 + 20_000 * 4 * 1.25 + (10 * 4 + 20_000 * 0.2 + 300 * 4 * 1.25)) / 1_000_000;
    const agent = v.byTool.find((r) => r.key === 'Agent')!;
    expect(agent.estUsd).toBeGreaterThan(subUsd);
    expect(v.totals.inputUsd).toBeGreaterThan(subUsd);
    expect(v.totals.attributedUsd).toBeLessThanOrEqual(v.totals.inputUsd + 1e-9);
    expect(v.cacheWaste.cold).toBeGreaterThanOrEqual(2);
    expect(v.cacheWaste.coldTokens).toBeGreaterThanOrEqual(20_000);
  });

  it('prices what compaction rewrote and the history it dropped', () => {
    const db = indexed({
      [SID]: [
        at(rec.prompt('look at things', 0), '2026-01-01T00:00:00.000Z'),
        at(rec.toolUse('req_1', 'toolu_a', 'Read', { file_path: '/repo/big.ts' }, 0, usage(10, 100, 0, 5000)), '2026-01-01T00:00:02.000Z'),
        at(rec.toolResult('toolu_a', 0, { text: 'x'.repeat(40_000) }), '2026-01-01T00:00:03.000Z'),
        at(rec.compact(0), '2026-01-01T00:00:04.000Z'),
        at(rec.assistantText('req_2', 'done', 0, usage(10, 20, 0, 9000)), '2026-01-01T00:00:06.000Z'),
      ],
    });
    const c = buildInsights(db).compaction;
    expect(c.count).toBe(1);
    expect(c.sessions).toBe(1);
    expect(c.discardedTokens).toBe(150_000 - 12_000);
    expect(c.rewrittenTokens).toBe(9000);
    expect(c.rewrittenUsd).toBeCloseTo((9000 * 4 * 1.25) / 1_000_000, 10);
  });

  it('flags a source that dominates spend and one that is barely used', () => {
    const db = indexed({
      [SID]: [
        at(rec.prompt('work', 0), '2026-01-01T00:00:00.000Z'),
        at(rec.toolUse('req_1', 'toolu_b', 'Bash', { command: 'ls' }, 0, usage(10, 100, 0, 50_000)), '2026-01-01T00:00:02.000Z'),
        at(rec.toolResult('toolu_b', 0, { text: 'b'.repeat(400_000) }), '2026-01-01T00:00:03.000Z'),
        at(rec.toolUse('req_2', 'toolu_m', 'mcp__jira__getJiraIssue', { issue: 'A-1' }, 0, usage(10, 100, 50_000, 1_000_000)), '2026-01-01T00:00:06.000Z'),
        at(rec.toolResult('toolu_m', 0, { text: 'z'.repeat(40_000) }), '2026-01-01T00:00:07.000Z'),
        at(rec.assistantText('req_3', 'done', 0, usage(10, 100, 1_050_000, 500_000)), '2026-01-01T00:00:09.000Z'),
        at(rec.assistantText('req_4', 'more', 0, usage(10, 20, 1_550_000, 2_000)), '2026-01-01T00:00:12.000Z'),
      ],
    });
    const advice = buildInsights(db).advice;
    const bash = advice.find((a) => a.key === 'Bash')!;
    expect(bash.kind).toBe('dominant');
    expect(bash.shareOfAttributed).toBeGreaterThan(0.25);

    const jira = advice.find((a) => a.dimension === 'byMcpServer')!;
    expect(jira.key).toBe('jira');
    expect(jira.kind).toBe('rarely-used');
    expect(jira.calls).toBe(1);
    expect(advice.filter((a) => a.key.startsWith('mcp__jira__'))).toHaveLength(0);
  });

  it('compares a bounded window against the one before it', () => {
    const daysAgo = (n: number, s = 0) => new Date(Date.now() - n * 86_400_000 + s * 1000).toISOString();
    const session = (d: number) => [
      at(rec.prompt('work', 0), daysAgo(d)),
      at(rec.toolUse('req_1', 'toolu_a', 'Read', { file_path: '/repo/a.ts' }, 0, usage(10, 100, 0, 5000)), daysAgo(d, 2)),
      at(rec.toolResult('toolu_a', 0, { text: 'x'.repeat(40_000) }), daysAgo(d, 3)),
      at(rec.assistantText('req_2', 'done', 0, usage(10, 20, 5000, 10_100)), daysAgo(d, 6)),
    ];
    const db = indexed({ [SID]: session(1), [SID2]: session(9) });

    const windowed = buildInsights(db, { sinceDays: 7 });
    expect(windowed.totals.sessions).toBe(1);
    expect(windowed.previous?.sinceDays).toBe(7);
    expect(windowed.previous?.totals.sessions).toBe(1);
    expect(windowed.previous?.rows.byTool.find((r) => r.key === 'Read')?.estTokens).toBe(
      windowed.byTool.find((r) => r.key === 'Read')!.estTokens,
    );
    expect(windowed.previous?.cacheWaste.rewrittenTokens).toBeGreaterThanOrEqual(0);

    const all = buildInsights(db);
    expect(all.totals.sessions).toBe(2);
    expect(all.previous).toBeNull();
  });

  it('carries the trend in both units and names the price table it used', () => {
    const v = buildInsights(indexed({ [SID]: twoToolSession() }));
    expect(v.priceTableDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const read = v.byTool.find((r) => r.key === 'Read')!;
    const band = v.trend.stacks.byTool.find((b) => b.key === 'Read')!;
    expect(band.values.reduce((a, b) => a + b, 0)).toBe(read.estTokens);
    expect(band.usdValues.reduce((a, b) => a + b, 0)).toBeCloseTo(read.estUsd, 10);
  });

  it('keeps the index free of transcript content (R10)', () => {
    const db = indexed({ [SID]: twoToolSession() });
    buildInsights(db);
    const rows = db.prepare('SELECT payload FROM session_aggregates').all() as Array<{ payload: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).not.toContain('x'.repeat(100));
  });
});
