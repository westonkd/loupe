import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import type { InsightAdvice, InsightDimension, InsightRow, InsightsView } from '../../shared/types';
import { CATEGORY_LABEL, type ToolCategory } from '../../shared/tools';
import { getJson } from '../api';
import { FilterSelect } from '../components/FilterSelect';
import { TrendChart, type Band } from '../components/TrendChart';
import { COST_NOTE, COST_TERM, fmtBytes, fmtCost, fmtInt, fmtMs, fmtTokens, homeRelative } from '../format';
import { Alert, EmptyState, Panel, Pending, SegmentedControl, Tag } from '@westonkd/sprint';

type Dimension = InsightDimension;
type Unit = 'tokens' | 'usd';

const UNITS: Array<{ value: Unit; label: string }> = [
  { value: 'tokens', label: 'Tokens' },
  { value: 'usd', label: COST_TERM },
];
const UNIT_STORAGE_KEY = 'loupe.insights.unit';

function storedUnit(): Unit {
  try {
    return localStorage.getItem(UNIT_STORAGE_KEY) === 'usd' ? 'usd' : 'tokens';
  } catch {
    return 'tokens';
  }
}

function rememberUnit(unit: Unit) {
  try {
    localStorage.setItem(UNIT_STORAGE_KEY, unit);
  } catch {
    return;
  }
}

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

type SortKey = 'estTokens' | 'avgTokens' | 'calls' | 'wastedTokens' | 'estUsd' | 'delta';

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
  'ttl-expired': 'Idle past the cache TTL',
  'prefix-change': 'Tool or instruction list changed',
  'model-change': 'Model changed mid-session',
  'effort-change': 'Effort changed mid-session',
  compaction: 'Compaction rewrote the prompt',
  'cold-start': 'First call, nothing cached yet',
  unknown: 'No visible cause',
};

const REASON_HELP: Record<string, string> = {
  'ttl-expired': 'The gap since the previous model call was longer than the cache lifetime, so the prefix had expired.',
  'prefix-change': 'A tool, skill or instruction listing changed, which rewrites the start of the prompt and invalidates everything after it.',
  'model-change': 'Caches are per model, so switching models mid-session starts from nothing.',
  'effort-change': 'Changing effort changes the request, which can move the cached prefix.',
  compaction: 'Compaction rewrites the conversation, so the old prefix no longer matches.',
  'cold-start': 'Nothing had been cached yet.',
  unknown: 'Nothing in the transcript explains the miss. The system prompt or tool definitions may have changed outside it.',
};

const ADVICE_VERDICT: Record<InsightAdvice['kind'], { label: string; tone: 'warning' | 'info' | 'inert' }> = {
  dominant: { label: 'Biggest share', tone: 'info' },
  'rarely-used': { label: 'Rarely used', tone: 'warning' },
  'expensive-per-call': { label: 'Costly per call', tone: 'warning' },
  'error-prone': { label: 'Often wasted', tone: 'warning' },
};

const WINDOWS = [
  { value: '7', label: '7d' },
  { value: '30', label: '30d' },
  { value: '', label: 'All' },
];

const COLLAPSED_ROWS = 14;

type Metric = 'context' | 'waste' | 'cost' | 'calls';
const METRICS: Array<{ value: Metric; label: string; note: string }> = [
  { value: 'context', label: 'Context', note: '' },
  { value: 'waste', label: 'Cache waste', note: 'Tokens re-written to cache because a call missed a prefix it could have re-used. First calls are excluded.' },
  { value: 'cost', label: COST_TERM, note: 'Reported or estimated spend at Anthropic API rates; a subscription is not billed this.' },
  { value: 'calls', label: 'Calls', note: 'Model calls and the tool calls they made.' },
];

export function Insights() {
  const [project, setProject] = useState('');
  const [days, setDays] = useState('');
  const [unit, setUnit] = useState<Unit>(storedUnit);
  const [dimension, setDimension] = useState<Dimension>('byCategory');
  const [sort, setSort] = useState<SortKey | null>(null);
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

  const amountOf = (r: { estTokens: number; estUsd: number }) => (unit === 'usd' ? r.estUsd : r.estTokens);
  const sortKey: SortKey = sort ?? (unit === 'usd' ? 'estUsd' : 'estTokens');

  const previousOf = useMemo(() => {
    const rows = data?.previous?.rows?.[dimension] ?? [];
    return new Map(rows.map((r) => [r.key, r]));
  }, [data, dimension]);

  const deltaOf = (r: InsightRow): number | null => {
    if (!data?.previous) return null;
    const prev = previousOf.get(r.key);
    if (!prev) return null;
    const before = amountOf(prev);
    if (before <= 0) return null;
    return (amountOf(r) - before) / before;
  };

  const sorted = useMemo(() => {
    const rows = data ? [...data[dimension]] : [];
    if (sortKey === 'delta') {
      return rows.sort((a, b) => (deltaOf(b) ?? -Infinity) - (deltaOf(a) ?? -Infinity) || amountOf(b) - amountOf(a));
    }
    return rows.sort((a, b) => b[sortKey] - a[sortKey] || b.estTokens - a.estTokens);
  }, [data, dimension, sortKey, unit, previousOf]);

  // `trend` is guarded rather than assumed: a payload cached by an older build
  // can still be served until its key rolls over.
  const trendUnit = data?.trend?.unit ?? 'day';
  const bands = useMemo<Band[]>(() => {
    const buckets = data?.trend?.buckets ?? [];
    if (metric === 'context') {
      const stack = data?.trend?.stacks?.[dimension] ?? [];
      // Drawn bottom-up, so reverse to put the largest band on the baseline.
      return [...stack].reverse().map((b) => ({
        key: b.key,
        label: b.label,
        color: colorFor(dimension, b.key, b.category, b.colorIndex),
        values: unit === 'usd' ? (b.usdValues ?? b.values.map(() => 0)) : b.values,
      }));
    }
    if (metric === 'waste') return [{ key: 'waste', label: 'Re-written to cache', color: 'var(--warn)', values: buckets.map((b) => b.rewrittenTokens) }];
    if (metric === 'cost') return [{ key: 'cost', label: COST_TERM, color: 'var(--series-1)', values: buckets.map((b) => b.costUsd) }];
    return [
      { key: 'toolCalls', label: 'Tool calls', color: 'var(--series-2)', values: buckets.map((b) => b.toolCalls) },
      { key: 'requests', label: 'Model calls', color: 'var(--series-1)', values: buckets.map((b) => b.requests) },
    ];
  }, [data, metric, dimension, unit]);

  if (error) return <Alert tone="danger" label="Couldn't load insights">{error}</Alert>;
  if (!data) return <Pending loading label="Aggregating sessions" />;

  const dim = DIMENSIONS.find((d) => d.value === dimension)!;
  const rows = expanded ? sorted : sorted.slice(0, COLLAPSED_ROWS);
  const max = sorted.reduce((m, r) => Math.max(m, sortKey === 'delta' ? amountOf(r) : r[sortKey]), 1);
  const t = data.totals;
  const waste = data.cacheWaste;
  const compaction = data.compaction;
  const prev = data.previous;
  const misses = waste.full + waste.partial;
  const met = METRICS.find((m) => m.value === metric)!;
  const metricFormat = metric === 'calls' ? fmtInt : metric === 'cost' || (metric === 'context' && unit === 'usd') ? fmtCost : fmtTokens;
  // Legend order matches the stack top-down, which is how the eye reads it.
  const legend = [...bands].reverse();
  const coverage = t.inputUsd > 0 ? t.attributedUsd / t.inputUsd : 0;
  const windowLabel = prev ? `the ${prev.sinceDays} days before this window (${fmtInt(prev.totals.sessions)} sessions)` : '';

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
        <SegmentedControl
          label="Unit"
          value={unit}
          onChange={(v) => {
            setUnit(v as Unit);
            rememberUnit(v as Unit);
          }}
          options={UNITS}
        />
        <span className="spacer" />
        <Tag
          tone="inert"
          title={`Dollars are estimates at bundled Anthropic API rates, last updated by hand on ${data.priceTableDate}; a subscription is not billed this. ${fmtCost(t.attributedUsd)} of ${fmtCost(t.inputUsd)} prompt spend lands on a row below. The rest is the system prompt, your own messages and the model's replies. ${SCOPE_NOTE}`}
        >
          {Math.round(coverage * 100)}% explained · prices {data.priceTableDate}
        </Tag>
        <Tag tone="inert" title={`Cache key ${data.key}`}>{data.cached ? 'cached' : `${fmtInt(t.sessions)} sessions`}</Tag>
      </div>

      <div className="scroll">
        <div className="stat-row">
          <Stat
            label={unit === 'usd' ? `Attributed ${COST_TERM.toLowerCase()}` : 'Attributed context'}
            value={unit === 'usd' ? fmtCost(t.attributedUsd) : fmtTokens(t.attributedTokens)}
            note={unit === 'usd' ? `${fmtTokens(t.attributedTokens)} of context explained` : `${fmtCost(t.attributedUsd)} of ${fmtCost(t.inputUsd)} spent on prompts`}
            delta={prev && pct(unit === 'usd' ? t.attributedUsd : t.attributedTokens, unit === 'usd' ? prev.totals.attributedUsd : prev.totals.attributedTokens)}
            deltaTitle={windowLabel}
            title={`Growth the consumers table can blame on something: tool results, subagent results and injected attachments, over ${fmtInt(t.sessions)} sessions and ${fmtInt(t.requests)} model calls. It is the same number the table and the chart add up to. The rest of the measured growth, ${fmtTokens(t.conversationTokens)}, is prompts and the model's own replies, which no row can be blamed for. ${ATTRIBUTED_NOTE}`}
          />
          <Stat
            label="Re-written to cache"
            value={unit === 'usd' ? fmtCost(waste.rewrittenUsd) : fmtTokens(waste.rewrittenTokens)}
            note={`${fmtInt(misses)} of ${fmtInt(waste.eligibleCalls)} calls missed`}
            tone={waste.rewrittenTokens > 0 ? 'warn' : undefined}
            delta={
              prev &&
              pct(
                unit === 'usd' ? waste.rewrittenUsd : waste.rewrittenTokens,
                unit === 'usd' ? prev.cacheWaste.rewrittenUsd : prev.cacheWaste.rewrittenTokens,
              )
            }
            deltaTitle={windowLabel}
            title={`Cache writes on calls that had a cached prefix and re-used less than 80% of it, so the same prefix was paid for twice. First calls of a session or a subagent are excluded: their ${fmtTokens(waste.coldTokens)} (${fmtCost(waste.coldUsd)}) had nothing to re-use. ${COST_NOTE}`}
          />
          <Stat
            label="Tool calls"
            value={fmtInt(t.toolCalls)}
            note={`${fmtInt(t.requests + t.subagentRequests)} model calls · ${fmtTokens(t.outputTokens)} output`}
            delta={prev && pct(t.toolCalls, prev.totals.toolCalls)}
            deltaTitle={windowLabel}
            title={`Every tool call in scope, subagents included, and every model call that made them (${fmtInt(t.requests)} in the main agent, ${fmtInt(t.subagentRequests)} inside subagents).`}
          />
          <Stat
            label={`Session ${COST_TERM.toLowerCase()}`}
            value={fmtCost(t.costUsd)}
            note={`${fmtInt(t.sessions)} sessions · ${fmtTokens(t.cacheReadTokens)} read from cache`}
            delta={prev && pct(t.costUsd, prev.totals.costUsd)}
            deltaTitle={windowLabel}
            title={`What these sessions cost in full, output tokens included, reported by the CLI where it recorded a total and estimated otherwise. ${COST_NOTE} ${SCOPE_NOTE}`}
          />
        </div>

        <div className="trend-wrap">
          <Panel
            label="Over time"
            actions={
              <SegmentedControl label="Metric" value={metric} onChange={(v) => setMetric(v as Metric)} options={METRICS.map((m) => ({ value: m.value, label: m.label }))} />
            }
          >
            <div className="sub muted" style={{ marginBottom: 2 }}>
              {metric === 'context'
                ? `${unit === 'usd' ? 'Prompt spend' : 'Context tokens'} blamed on a tool result or attachment, stacked by the grouping below.`
                : met.note}{' '}
              By {trendUnit}, from each session's last activity.
            </div>
            <TrendChart
              labels={(data.trend?.buckets ?? []).map((b) => b.start)}
              bands={bands}
              height={168}
              unit={trendUnit}
              format={metricFormat}
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
          <Panel
            label="Context consumers"
            actions={
              <SegmentedControl
                label="Group by"
                value={dimension}
                onChange={(v) => setDimension(v as Dimension)}
                options={DIMENSIONS.map((d) => ({ value: d.value, label: d.label }))}
              />
            }
          >
            <div className="sub muted" style={{ marginBottom: 6 }}>{dim.blurb}</div>
            {sorted.length === 0 ? (
              <EmptyState label="Nothing in this group" description="No session in scope produced context attributable to this dimension." />
            ) : (
              <>
                <table className="tbl insight">
                  <thead>
                    <tr>
                      <th>Source</th>
                      {COLUMNS.map((c) => (
                        <th
                          key={c.key}
                          className={`num click ${sortKey === c.key ? 'sel' : ''}`}
                          title={c.key === 'estUsd' ? ATTRIBUTED_NOTE : undefined}
                          onClick={() => setSort(c.key)}
                        >
                          {c.title}
                          {sortKey === c.key ? ' ▾' : ''}
                        </th>
                      ))}
                      {prev && (
                        <th
                          className={`num click ${sortKey === 'delta' ? 'sel' : ''}`}
                          title={`Change against ${windowLabel}, in the unit selected above. Blank where the source is new or had nothing to compare against.`}
                          onClick={() => setSort('delta')}
                        >
                          Δ{sortKey === 'delta' ? ' ▾' : ''}
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const c = colorFor(dimension, r.key, r.category, r.colorIndex);
                      const share = (sortKey === 'delta' ? amountOf(r) : r[sortKey]) / max;
                      return (
                        <tr
                          key={r.key}
                          title={rowTitle(r)}
                          className={activeKey === r.key ? 'sel' : activeKey ? 'dim' : ''}
                          onMouseEnter={() => metric === 'context' && setActiveKey(r.key)}
                          onMouseLeave={() => setActiveKey(null)}
                        >
                          <td className="lbl" style={fill(c, share)}>
                            <span className="kind-key" style={{ background: c }} />
                            {r.label}
                          </td>
                          {COLUMNS.map((col) => (
                            <td key={col.key} className="num">{col.render(r)}</td>
                          ))}
                          {prev && (
                            <td className="num">
                              <DeltaText value={deltaOf(r)} />
                            </td>
                          )}
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

          <div className="insight-side">
            <Panel label="Worth a look">
              {data.advice.length === 0 ? (
                <div className="muted sub">Nothing stands out in this window: no source is dominating, barely used, or unusually expensive per call.</div>
              ) : (
                <ul className="advice">
                  {data.advice.map((a) => {
                    const verdict = ADVICE_VERDICT[a.kind];
                    return (
                      <li key={`${a.dimension}:${a.key}`}>
                        <button
                          className="advice-row"
                          title={`Show this in the table, grouped by ${DIMENSIONS.find((d) => d.value === a.dimension)?.label.toLowerCase()}.`}
                          onClick={() => {
                            setDimension(a.dimension);
                            setActiveKey(a.key);
                          }}
                        >
                          <span className="advice-head">
                            <Tag tone={verdict.tone}>{verdict.label}</Tag>
                            <span className="advice-label">{a.label}</span>
                            <span className="advice-amount">{fmtCost(a.estUsd)}</span>
                          </span>
                          <span className="advice-detail">{adviceDetail(a)}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Panel>

            <Panel label="Cache waste">
              {misses === 0 ? (
                <div className="muted sub">
                  No avoidable misses in scope: every call that had a cached prefix re-used at least 80% of it.
                  {waste.cold > 0 && ` ${fmtInt(waste.cold)} first calls wrote ${fmtTokens(waste.coldTokens)} that nothing could have saved.`}
                </div>
              ) : (
                <>
                  <div className="sub muted" style={{ marginBottom: 6 }}>
                    {fmtInt(waste.full)} full and {fmtInt(waste.partial)} partial misses, of {fmtInt(waste.eligibleCalls)} calls that had a cache to hit. A call can have
                    more than one likely cause; its tokens are split between them, so the columns add up.
                  </div>
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
                        <tr key={r.code} title={REASON_HELP[r.code]}>
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
              <div className="sub muted" style={{ marginTop: 8 }}>
                {waste.cold > 0 && (
                  <div>
                    {fmtInt(waste.cold)} first calls wrote {fmtTokens(waste.coldTokens)} ({fmtCost(waste.coldUsd)}) with nothing to re-use, which is the price of
                    starting rather than waste.
                  </div>
                )}
                {compaction?.count > 0 && (
                  <div title="Compaction rewrites the conversation into a summary. The rewrite is billed as a fresh cache write, and the history it drops was paid for on every call that carried it.">
                    {fmtInt(compaction.count)} compactions in {fmtInt(compaction.sessions)} sessions rewrote {fmtTokens(compaction.rewrittenTokens)} (
                    {fmtCost(compaction.rewrittenUsd)}) and dropped {fmtTokens(compaction.discardedTokens)} of history.
                  </div>
                )}
              </div>
            </Panel>
          </div>
        </div>

        <div className="insight-footnote">
          Dollars are estimates at bundled Anthropic API rates (table updated {data.priceTableDate}); a subscription is not billed this. {SCOPE_NOTE}
        </div>
      </div>
    </div>
  );
}

function pct(now: number, before: number): number | null {
  if (!Number.isFinite(before) || before <= 0) return null;
  return (now - before) / before;
}

function DeltaText({ value, title }: { value: number | null; title?: string }) {
  if (value === null) return <span className="delta none">·</span>;
  const grew = 1 + value;
  const text = value > 3 ? `\u00d7${grew >= 10 ? Math.round(grew) : grew.toFixed(1)}` : `${value > 0 ? '+' : ''}${Math.round(value * 100)}%`;
  const tone = Math.abs(value) < 0.05 ? 'flat' : value > 0 ? 'up' : 'down';
  return (
    <span className={`delta ${tone}`} title={title}>
      {text}
    </span>
  );
}

function adviceDetail(a: InsightAdvice): string {
  const sessions = `${fmtInt(a.sessions)} session${a.sessions === 1 ? '' : 's'}`;
  const perCall = a.calls > 0 ? fmtCost(a.estUsd / a.calls) : '';
  if (a.kind === 'dominant') return `${Math.round(a.shareOfAttributed * 100)}% of attributed spend · ${fmtInt(a.calls)} calls across ${sessions}`;
  if (a.kind === 'rarely-used') return `${fmtInt(a.calls)} calls in ${sessions} · ${perCall} each`;
  if (a.kind === 'expensive-per-call') return `${perCall} per call · ${fmtInt(a.calls)} calls across ${sessions}`;
  return `${fmtCost(a.wastedUsd)} of ${fmtCost(a.estUsd)} on calls that errored or were denied`;
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
  if (r.calls > 0) lines.push(`${fmtCost(r.estUsd / r.calls)} per call`);
  return lines.join('\n');
}

function Stat({
  label,
  value,
  note,
  tone,
  title,
  delta,
  deltaTitle,
}: {
  label: string;
  value: string;
  note?: ReactNode;
  tone?: 'warn';
  title?: string;
  delta?: number | null;
  deltaTitle?: string;
}) {
  return (
    <div className="stat" title={title}>
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${tone === 'warn' ? 'warn' : ''}`}>
        {value}
        {delta !== undefined && delta !== null && <DeltaText value={delta} title={deltaTitle ? `vs ${deltaTitle}` : undefined} />}
      </div>
      {note && <div className="stat-note">{note}</div>}
    </div>
  );
}
