import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { InsightDimension, InsightRow, InsightsView } from '../../shared/types';
import { CATEGORY_LABEL, type ToolCategory } from '../../shared/tools';
import { getJson } from '../api';
import { FilterSelect } from '../components/FilterSelect';
import { TrendChart, type Band } from '../components/TrendChart';
import { COST_NOTE, COST_TERM, fmtBytes, fmtCost, fmtInt, fmtMs, fmtTokens, homeRelative } from '../format';
import { Alert, EmptyState, Panel, Pending, SegmentedControl, Tag } from '@westonkd/sprint';

type Dimension = InsightDimension;

const DIMENSIONS: Array<{ value: Dimension; label: string; blurb: string }> = [
  { value: 'byCategory', label: 'Category', blurb: 'Tools grouped by what they do.' },
  { value: 'byTool', label: 'Tool', blurb: 'Every tool by name. Sort by avg/call to find what is expensive per use rather than merely frequent.' },
  { value: 'byMcpServer', label: 'MCP server', blurb: 'What each MCP server costs. One that is expensive across few sessions is a candidate for turning off by default.' },
  { value: 'byMcpTool', label: 'MCP tool', blurb: 'Individual MCP tools, so one chatty tool can be blamed instead of its whole server.' },
  { value: 'bySkill', label: 'Skill', blurb: "Skill invocations, by the skill's name." },
  {
    value: 'byAttachment',
    label: 'Injected',
    blurb:
      'Harness attachments nobody asked for: reminders, skill and tool listings, MCP instructions, memory. Anything arriving on a session’s first model call has nothing earlier to be measured against, so it shows size but no tokens.',
  },
];

type SortKey = 'estTokens' | 'avgTokens' | 'calls' | 'wastedTokens' | 'estUsd';

const COLUMNS: Array<{ key: SortKey; title: string; render: (r: InsightRow) => string }> = [
  { key: 'calls', title: 'Calls', render: (r) => (r.subagentCalls ? `${fmtInt(r.calls)} +${fmtInt(r.subagentCalls)}` : fmtInt(r.calls)) },
  { key: 'estTokens', title: '~Tokens', render: (r) => fmtTokens(r.estTokens) },
  { key: 'avgTokens', title: 'Avg/call', render: (r) => fmtTokens(r.avgTokens) },
  { key: 'wastedTokens', title: 'Wasted', render: (r) => (r.wastedTokens ? fmtTokens(r.wastedTokens) : '') },
  { key: 'estUsd', title: `~${COST_TERM}`, render: (r) => fmtCost(r.estUsd) },
];

const ATTRIBUTED_NOTE =
  'Approximate, and bigger than the price of the tokens themselves: once something is in the prompt it is re-sent on every later model call, so each row carries its share of every prompt it stayed in. An Agent row also carries the measured prompt spend of the subagents it started. Bundled Anthropic API prices; a subscription is not billed this.';
const SCOPE_NOTE =
  'Covers the sessions still on disk under ~/.claude. Claude Code deletes old transcripts, so work from before a cleanup is not counted here.';

const CAT_COLOR: Record<ToolCategory, string> = {
  shell: 'var(--series-2)',
  file_read: 'var(--series-1)',
  file_write: 'var(--series-8)',
  search: 'var(--series-4)',
  web: 'var(--series-3)',
  agent: 'var(--series-7)',
  skill: 'var(--series-9)',
  plan: 'var(--series-11)',
  ask: 'var(--series-5)',
  mcp: 'var(--series-10)',
  other: 'var(--text-3)',
};

/**
 * Bands and rows are coloured by rank, not by identity, so the chart's stack
 * order and the table's top rows read as the same thing. Categories keep their
 * own colours because those are stable across every grouping.
 */
const RANK_COLOR = [
  'var(--series-1)',
  'var(--series-2)',
  'var(--series-3)',
  'var(--series-5)',
  'var(--series-7)',
  'var(--series-8)',
  'var(--series-9)',
  'var(--series-10)',
];
const REST_COLOR = 'var(--text-3)';

function colorFor(dimension: Dimension, key: string, category: ToolCategory | undefined, colorIndex: number): string {
  if (dimension === 'byCategory') return CAT_COLOR[(category ?? key) as ToolCategory] ?? REST_COLOR;
  return colorIndex >= 0 ? RANK_COLOR[colorIndex % RANK_COLOR.length] : REST_COLOR;
}

const REASON_LABEL: Record<string, string> = {
  'ttl-expired': 'Idle longer than the cache TTL',
  'prefix-change': 'Tool or instruction list changed',
  'model-change': 'Model changed mid-session',
  'effort-change': 'Effort changed mid-session',
  compaction: 'Compaction rewrote the conversation',
  'cold-start': "Session's first call, nothing cached yet",
  unknown: 'No cause visible in the transcript',
};

const WINDOWS = [
  { value: '7', label: '7d' },
  { value: '30', label: '30d' },
  { value: '', label: 'All' },
];

const COLLAPSED_ROWS = 14;

type Metric = 'context' | 'waste' | 'cost' | 'calls';
const METRICS: Array<{ value: Metric; label: string; fmt: (v: number) => string; note: string }> = [
  { value: 'context', label: 'Context', fmt: fmtTokens, note: 'Context tokens blamed on a tool result or attachment, stacked by the grouping below.' },
  { value: 'waste', label: 'Cache waste', fmt: fmtTokens, note: 'Tokens re-written to cache because a call missed a prefix it could have re-used. First calls are excluded.' },
  { value: 'cost', label: COST_TERM, fmt: (v) => fmtCost(v), note: 'Reported or estimated spend at Anthropic API rates; a subscription is not billed this.' },
  { value: 'calls', label: 'Calls', fmt: fmtInt, note: 'Model calls and the tool calls they made.' },
];

export function Insights() {
  const [project, setProject] = useState('');
  const [days, setDays] = useState('');
  const [dimension, setDimension] = useState<Dimension>('byCategory');
  const [sort, setSort] = useState<SortKey>('estTokens');
  const [expanded, setExpanded] = useState(false);
  const [metric, setMetric] = useState<Metric>('context');
  // Hovering a band or a row highlights the same key in both.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [data, setData] = useState<InsightsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const url = useMemo(() => {
    const p = new URLSearchParams();
    if (project) p.set('project', project);
    if (days) p.set('days', days);
    const qs = p.toString();
    return `/api/insights${qs ? `?${qs}` : ''}`;
  }, [project, days]);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    getJson<InsightsView>(url)
      .then((d) => !cancelled && (setData(d), setError(null)))
      .catch((e) => !cancelled && setError(String(e.message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [url]);
  useEffect(() => {
    setExpanded(false);
    setActiveKey(null);
  }, [dimension, url]);

  const sorted = useMemo(
    () => (data ? [...data[dimension]].sort((a, b) => b[sort] - a[sort] || b.estTokens - a.estTokens) : []),
    [data, dimension, sort],
  );

  // `trend` is guarded rather than assumed: a payload cached by an older build
  // can still be served until its key rolls over.
  const trendUnit = data?.trend?.unit ?? 'day';
  const bands = useMemo<Band[]>(() => {
    const buckets = data?.trend?.buckets ?? [];
    if (metric === 'context') {
      const stack = data?.trend?.stacks?.[dimension] ?? [];
      // Drawn bottom-up, so reverse to put the largest band on the baseline.
      return [...stack]
        .reverse()
        .map((b) => ({ key: b.key, label: b.label, color: colorFor(dimension, b.key, b.category, b.colorIndex), values: b.values }));
    }
    if (metric === 'waste') return [{ key: 'waste', label: 'Re-written to cache', color: 'var(--warn)', values: buckets.map((b) => b.rewrittenTokens) }];
    if (metric === 'cost') return [{ key: 'cost', label: COST_TERM, color: 'var(--series-1)', values: buckets.map((b) => b.costUsd) }];
    return [
      { key: 'toolCalls', label: 'Tool calls', color: 'var(--series-2)', values: buckets.map((b) => b.toolCalls) },
      { key: 'requests', label: 'Model calls', color: 'var(--series-1)', values: buckets.map((b) => b.requests) },
    ];
  }, [data, metric, dimension]);

  if (error) return <Alert tone="danger" label="Couldn't load insights">{error}</Alert>;
  if (!data) return <Pending loading label="Aggregating sessions" />;

  const dim = DIMENSIONS.find((d) => d.value === dimension)!;
  const rows = expanded ? sorted : sorted.slice(0, COLLAPSED_ROWS);
  const max = sorted.reduce((m, r) => Math.max(m, r[sort]), 1);
  const t = data.totals;
  const waste = data.cacheWaste;
  const misses = waste.full + waste.partial;
  const met = METRICS.find((m) => m.value === metric)!;
  // Legend order matches the stack top-down, which is how the eye reads it.
  const legend = [...bands].reverse();

  return (
    <div className="pane" style={{ flex: 1 }}>
      <div className="toolbar">
        <FilterSelect
          label="Project"
          allLabel="All projects"
          value={project}
          onChange={setProject}
          options={data.projects.map((p) => ({ value: p.value, label: homeRelative(p.label), count: p.sessions }))}
        />
        <SegmentedControl label="Window" value={days} onChange={setDays} options={WINDOWS} />
        {/* Drives the chart's stack and the table at once, so it sits above both. */}
        <SegmentedControl
          label="Group by"
          value={dimension}
          onChange={(v) => setDimension(v as Dimension)}
          options={DIMENSIONS.map((d) => ({ value: d.value, label: d.label }))}
        />
        <span className="spacer" />
        <Tag tone="inert" title={`Cache key ${data.key}`}>{data.cached ? 'cached' : `${fmtInt(t.sessions)} sessions`}</Tag>
      </div>

      <div className="scroll">
        <div className="stat-row">
          <Stat
            label="Attributed context"
            value={fmtTokens(t.attributedTokens)}
            note={`+ ${fmtTokens(t.conversationTokens)} in prompts and replies`}
            title={`Conversation growth the consumers table can blame on something: tool results, subagent results and injected attachments, over ${fmtInt(t.sessions)} sessions and ${fmtInt(t.requests)} model calls. It is the same number the table and the chart add up to. The rest of the measured growth, ${fmtTokens(t.conversationTokens)}, is prompts and the model's own replies, which no row can be blamed for. Not a bill: the same prefix is re-sent on every model call. ${SCOPE_NOTE}`}
          />
          <Stat
            label={`Attributed ${COST_TERM.toLowerCase()}`}
            value={fmtCost(t.attributedUsd)}
            note={`of ${fmtCost(t.inputUsd)} spent on prompts`}
            title={`Prompt-side spend the consumers table could pin on a source, of ${fmtCost(t.inputUsd)} spent re-sending prompts across every model call including subagents (output tokens excluded). ${ATTRIBUTED_NOTE}`}
          />
          <Stat
            label="Re-written to cache"
            value={fmtTokens(waste.rewrittenTokens)}
            note={`${fmtCost(waste.rewrittenUsd)} · ${fmtInt(misses)} of ${fmtInt(waste.eligibleCalls)} calls missed`}
            tone={waste.rewrittenTokens > 0 ? 'warn' : undefined}
            title={`Cache writes on calls that had a cached prefix and re-used less than 80% of it, so the same prefix was paid for twice. First calls of a session or a subagent are excluded: their ${fmtTokens(waste.coldTokens)} (${fmtCost(waste.coldUsd)}) had nothing to re-use. ${COST_NOTE}`}
          />
          <Stat
            label="Tool calls"
            value={fmtInt(t.toolCalls)}
            note={`${fmtInt(t.requests + t.subagentRequests)} model calls · ${fmtTokens(t.outputTokens)} output`}
            title={`Every tool call in scope, subagents included, and every model call that made them (${fmtInt(t.requests)} in the main agent, ${fmtInt(t.subagentRequests)} inside subagents).`}
          />
          <Stat label={COST_TERM} value={fmtCost(t.costUsd)} note={`${fmtTokens(t.cacheReadTokens)} read from cache`} title={`${COST_NOTE} ${SCOPE_NOTE}`} />
        </div>

        <div className="trend-wrap">
          <Panel
            label="Over time"
            actions={
              <SegmentedControl label="Metric" value={metric} onChange={(v) => setMetric(v as Metric)} options={METRICS.map((m) => ({ value: m.value, label: m.label }))} />
            }
          >
            <div className="sub muted" style={{ marginBottom: 2 }}>
              {met.note} By {trendUnit}, from each session's last activity.
            </div>
            <TrendChart
              labels={(data.trend?.buckets ?? []).map((b) => b.start)}
              bands={bands}
              height={168}
              unit={trendUnit}
              format={met.fmt}
              ariaLabel={`${met.label} over time`}
              activeKey={activeKey}
              onActiveKey={setActiveKey}
            />
            {legend.length > 1 && (
              <div className="legend" style={{ marginTop: 2 }}>
                {legend.map((b) => (
                  <span
                    key={b.key}
                    className={`legend-key ${activeKey && activeKey !== b.key ? 'dim' : ''}`}
                    onMouseEnter={() => setActiveKey(b.key)}
                    onMouseLeave={() => setActiveKey(null)}
                  >
                    <span className="kind-key" style={{ background: b.color }} />
                    {b.label}
                  </span>
                ))}
              </div>
            )}
          </Panel>
        </div>

        <div className="insight-grid">
          <Panel label="Context consumers">
            <div className="sub muted" style={{ marginBottom: 6 }}>{dim.blurb}</div>
            <div className="sub muted" style={{ marginBottom: 6 }} title={ATTRIBUTED_NOTE}>
              ~{COST_TERM} splits each prompt's cost across what was in it, so a source carries every call that re-sent it. Agent rows also carry what their subagents
              spent on their own prompts.
            </div>
            {sorted.length === 0 ? (
              <EmptyState label="Nothing in this group" description="No session in scope produced context attributable to this dimension." />
            ) : (
              <>
                <table className="tbl insight">
                  <thead>
                    <tr>
                      <th>Source</th>
                      {COLUMNS.map((c) => (
                        <th key={c.key} className={`num click ${sort === c.key ? 'sel' : ''}`} onClick={() => setSort(c.key)}>
                          {c.title}
                          {sort === c.key ? ' ▾' : ''}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const c = colorFor(dimension, r.key, r.category, r.colorIndex);
                      return (
                      <tr
                        key={r.key}
                        title={rowTitle(r)}
                        className={activeKey === r.key ? 'sel' : activeKey ? 'dim' : ''}
                        onMouseEnter={() => metric === 'context' && setActiveKey(r.key)}
                        onMouseLeave={() => setActiveKey(null)}
                      >
                        <td className="lbl" style={fill(c, r[sort] / max)}>
                          <span className="kind-key" style={{ background: c }} />
                          {r.label}
                        </td>
                        {COLUMNS.map((col) => (
                          <td key={col.key} className="num">{col.render(r)}</td>
                        ))}
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
                {sorted.length > COLLAPSED_ROWS && (
                  <button className="link-btn" onClick={() => setExpanded(!expanded)}>
                    {expanded ? `Show top ${COLLAPSED_ROWS}` : `Show all ${sorted.length}`}
                  </button>
                )}
              </>
            )}
          </Panel>

          <Panel label="Cache waste">
            {misses === 0 ? (
              <div className="muted">
                No avoidable misses in scope: every call that had a cached prefix re-used at least 80% of it.
                {waste.cold > 0 && ` ${fmtInt(waste.cold)} first calls wrote ${fmtTokens(waste.coldTokens)} that nothing could have saved.`}
              </div>
            ) : (
              <>
                <div className="sub muted" style={{ marginBottom: 6 }}>
                  {fmtInt(waste.full)} full and {fmtInt(waste.partial)} partial misses, of {fmtInt(waste.eligibleCalls)} calls that had a cache to hit. A call can have more
                  than one likely cause; its tokens are split between them, so the columns add up.
                </div>
                {waste.cold > 0 && (
                  <div className="sub muted" style={{ marginBottom: 6 }}>
                    Not counted here: {fmtInt(waste.cold)} first calls of a session or subagent wrote {fmtTokens(waste.coldTokens)} ({fmtCost(waste.coldUsd)}) with nothing to
                    re-use.
                  </div>
                )}
                <table className="tbl insight waste">
                  <thead>
                    <tr>
                      <th>Likely cause</th>
                      <th className="num">Calls</th>
                      <th className="num">Re-written</th>
                      <th className="num" title={COST_NOTE}>~{COST_TERM}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {waste.reasons.map((r) => (
                      <tr key={r.code}>
                        <td className="lbl" style={fill('var(--warn)', r.rewrittenTokens / Math.max(1, waste.reasons[0].rewrittenTokens))}>
                          {REASON_LABEL[r.code] ?? r.code}
                        </td>
                        <td className="num">{fmtInt(r.count)}</td>
                        <td className="num">{fmtTokens(r.rewrittenTokens)}</td>
                        <td className="num">{fmtCost(r.rewrittenUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

/** Proportional bar drawn behind the label text (see .tbl.insight td.lbl). */
const fill = (c: string, share: number) =>
  ({ '--bar': c, '--pct': `${Math.max(0, Math.min(1, share)) * 100}%` }) as CSSProperties;

/** Everything the row no longer has a column for. */
function rowTitle(r: InsightRow): string {
  const lines = [r.label, `${fmtInt(r.sessions)} session${r.sessions === 1 ? '' : 's'}`];
  if (r.subagentCalls) lines.push(`${fmtInt(r.calls)} in the main agent, ${fmtInt(r.subagentCalls)} inside subagents`);
  if (r.bytes) lines.push(`${fmtBytes(r.bytes)} of content`);
  if (r.durationMs) lines.push(`${fmtMs(r.durationMs)} spent in these calls`);
  if (r.wastedTokens) lines.push(`${fmtInt(r.errorCalls)} errored, ${fmtInt(r.deniedCalls)} denied`);
  if (r.wastedUsd) lines.push(`${fmtCost(r.wastedUsd)} of that on calls that errored, were denied or interrupted`);
  return lines.join('\n');
}

function Stat({ label, value, note, tone, title }: { label: string; value: string; note?: string; tone?: 'warn'; title?: string }) {
  return (
    <div className="stat" title={title}>
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${tone === 'warn' ? 'warn' : ''}`}>{value}</div>
      {note && <div className="stat-note">{note}</div>}
    </div>
  );
}
