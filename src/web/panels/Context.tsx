import { useMemo, useState } from 'react';
import type { ContextPoint, ContextView, ContributorKind, SessionDetail } from '../../shared/types';
import { useSessionResource } from '../api';
import { LineChart, type Marker, type PointMark } from '../components/LineChart';
import { fmtBytes, fmtInt, fmtMs, fmtTime, fmtTokens, shortModel } from '../format';
import { Split, WIDE, useMediaQuery } from '../components/Layout';
import { Why } from '../components/Why';
import { Alert, Button, EmptyState, MetaLine, Panel, Pending, SegmentedControl, Tag } from '@westonkd/sprint';

interface Props {
  session: SessionDetail;
  onOpenRecord: (recordId: number) => void;
  onOpenTool: (toolUseId: string) => void;
}

// Categorical slots in fixed order (never cycled); identity is also given by label.
const KIND_COLOR: Record<ContributorKind, string> = {
  tool_result: 'var(--series-2)',
  subagent: 'var(--series-7)',
  attachment: 'var(--series-4)',
  prompt: 'var(--series-5)',
  response: 'var(--series-6)',
  other: 'var(--text-3)',
};
const KIND_LABEL: Record<ContributorKind, string> = {
  tool_result: 'Tool output',
  subagent: 'Subagent result',
  attachment: 'Injected context',
  prompt: 'User prompt',
  response: 'Previous assistant message',
  other: 'Other',
};

/** Index of the first point at or after a record id (markers sit before the model call they precede). */
function indexAfter(points: ContextView['points'], recordId: number): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].firstRecordId < recordId) lo = mid + 1;
    else hi = mid;
  }
  return Math.min(lo, Math.max(0, points.length - 1));
}

const signed = (n: number | null) => (n === null ? '' : `${n >= 0 ? '+' : '−'}${fmtTokens(Math.abs(n))}`);

export function Context({ session, onOpenRecord, onOpenTool }: Props) {
  const sid = session.sessionId;
  const { data, error } = useSessionResource<ContextView>(sid, `/api/sessions/${encodeURIComponent(sid)}/context`);
  const [hover, setHover] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const [consumerView, setConsumerView] = useState<'category' | 'item'>('category');
  const [openKind, setOpenKind] = useState<string | null>(null);
  const wide = useMediaQuery(WIDE);

  const derived = useMemo(() => {
    if (!data) return null;
    const pts = data.points;
    const compactions: Marker[] = data.compactions.map((c) => ({
      x: indexAfter(pts, c.recordId),
      label: c.preTokens !== null ? `${fmtTokens(c.preTokens)} → ${fmtTokens(c.postTokens)}` : 'compaction',
    }));
    const turns = data.turns.map((t) => indexAfter(pts, t.recordId));
    const peak = pts.reduce((m, p) => Math.max(m, p.contextTokens), 0);
    const last = pts.length ? pts[pts.length - 1].contextTokens : 0;
    const ratios = pts.map((p) => p.cacheHitRatio).filter((r): r is number => r !== null);
    const avgHit = ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : null;

    // Jumps: the largest increases (top decile, at least 5k tokens).
    const positive = pts.map((p) => p.deltaTokens ?? 0).filter((d) => d > 0).sort((a, b) => a - b);
    const p90 = positive.length ? positive[Math.floor(positive.length * 0.9)] : 0;
    const threshold = Math.max(5000, p90);
    const jumpIdx = pts.map((p, i) => [p, i] as const).filter(([p]) => (p.deltaTokens ?? 0) >= threshold).map(([, i]) => i);
    const jumpMarks: PointMark[] = jumpIdx.map((i) => {
      const p = pts[i];
      const top = p.contributors[0];
      return {
        i,
        shape: 'dot',
        color: KIND_COLOR[p.dominant ?? 'other'],
        title: `#${i + 1} ${signed(p.deltaTokens)}: ${top ? top.label : ''}`,
      };
    });
    const missIdx = pts.map((p, i) => [p, i] as const).filter(([p]) => p.cache.severity === 'full' || p.cache.severity === 'partial').map(([, i]) => i);
    const missMarks: PointMark[] = missIdx.map((i) => ({
      i,
      shape: 'cross',
      color: pts[i].cache.severity === 'full' ? 'var(--error)' : 'var(--warn)',
      title: `#${i + 1} cache ${pts[i].cache.severity}: ${pts[i].cache.reasons[0] ?? ''}`,
    }));
    const biggest = pts
      .map((p, i) => [p, i] as const)
      .filter(([p]) => p.deltaTokens !== null && p.deltaTokens > 0)
      .sort((a, b) => b[0].deltaTokens! - a[0].deltaTokens!)
      .slice(0, 12);
    const kindsPresent = new Set(jumpIdx.map((i) => pts[i].dominant ?? 'other'));
    const missedTokens = missIdx.reduce((a, i) => a + pts[i].cacheWriteTokens, 0);

    const groups = new Map<string, { count: number; bytes: number; items: ContextView['injected'] }>();
    for (const i of data.injected) {
      const g = groups.get(i.kind) ?? { count: 0, bytes: 0, items: [] };
      g.count++;
      g.bytes += i.bytes;
      g.items.push(i);
      groups.set(i.kind, g);
    }
    const byKind = [...groups.entries()].sort((a, b) => b[1].bytes - a[1].bytes);
    return { compactions, turns, peak, last, avgHit, jumpMarks, missMarks, missIdx, biggest, kindsPresent, missedTokens, byKind, threshold };
  }, [data]);

  if (error) return <Alert tone="danger" label="Couldn't load context data">{error}</Alert>;
  if (!data || !derived) return <Pending loading label="Loading context data" />;
  const pts = data.points;
  const hp = hover !== null ? pts[hover] : null;
  const sp = selected !== null ? pts[selected] : null;
  const consumers = consumerView === 'category' ? data.consumers.byCategory : data.consumers.byItem;
  const consumerMax = consumers.reduce((m, g) => Math.max(m, g.estTokens), 1);

  // Side by side only when both have rows; otherwise each takes the full width
  // so an empty card doesn't leave half the row blank.
  const paired = derived.biggest.length > 0 && derived.missIdx.length > 0;

  const pointDetail = sp ? (
    <PointDetail key={sp.requestRowId} sessionId={sid} p={sp} index={selected!} onClose={() => setSelected(null)} onOpenRecord={onOpenRecord} onOpenTool={onOpenTool} />
  ) : null;

  const main = (
    <>
      {pts.length === 0 ? (
        <EmptyState label="No model calls in this session" description="Context size is measured per model call, and this session has none yet." />
      ) : showTable ? (
        <div style={{ padding: '8px 12px' }}>
          <table className="tbl mono">
            <thead>
              <tr>
                <th className="num">#</th><th>Time</th><th>Model</th><th className="num">Context</th><th className="num">Δ</th><th className="num">Cache hit</th><th>Cache</th><th>Largest contributor</th>
              </tr>
            </thead>
            <tbody>
              {pts.map((p, i) => [p, i] as const).reverse().map(([p, i]) => (
                <tr key={p.requestRowId} className={`click ${selected === i ? 'sel' : ''}`} onClick={() => setSelected(i)}>
                  <td className="num">{i + 1}</td>
                  <td>{fmtTime(p.ts)}</td>
                  <td>{shortModel(p.model)}</td>
                  <td className="num">{fmtInt(p.contextTokens)}</td>
                  <td className="num">{signed(p.deltaTokens)}</td>
                  <td className="num">{p.cacheHitRatio === null ? '' : `${(p.cacheHitRatio * 100).toFixed(1)}%`}</td>
                  <td className={`sev-${p.cache.severity}`}>{p.cache.severity === 'none' ? '' : p.cache.severity}</td>
                  <td className="lbl">{p.contributors[0]?.label ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="chart-wrap" style={{ position: 'relative' }}>
          <h3>Context size per model call</h3>
          <div className="sub">
            input + cache read + cache write tokens · dots mark the largest jumps (≥ {fmtTokens(derived.threshold)}), coloured by what caused them · click any point
            for a breakdown
          </div>
          <div className="legend">
            <span><span className="key" style={{ background: 'var(--series-1)' }} />Context tokens</span>
            {[...derived.kindsPresent].map((k) => (
              <span key={k}><span className="kind-key" style={{ background: KIND_COLOR[k] }} />{KIND_LABEL[k]}</span>
            ))}
            {derived.compactions.length > 0 && <span><span className="key" style={{ background: 'var(--warn)' }} />Compaction</span>}
          </div>
          <LineChart
            values={pts.map((p) => p.contextTokens)}
            height={wide ? 260 : 200}
            color="var(--series-1)"
            yFormat={fmtTokens}
            compactions={derived.compactions}
            turns={derived.turns}
            hover={hover}
            onHover={setHover}
            ariaLabel="Context tokens per model call"
            marks={derived.jumpMarks}
            selected={selected}
            onSelect={setSelected}
          />
          <h3 style={{ marginTop: 12 }}>Cache hit ratio</h3>
          <div className="sub">cache read ÷ context tokens · ✕ marks calls that re-used less than 80% of the previous prompt</div>
          <LineChart
            values={pts.map((p) => p.cacheHitRatio)}
            height={wide ? 150 : 120}
            color="var(--series-3)"
            yMax={1}
            yFormat={(v) => `${Math.round(v * 100)}%`}
            compactions={derived.compactions.map((c) => ({ x: c.x }))}
            turns={derived.turns}
            hover={hover}
            onHover={setHover}
            ariaLabel="Cache hit ratio per model call"
            marks={derived.missMarks}
            selected={selected}
            onSelect={setSelected}
          />
          {hp && (
            <div className="tooltip" style={{ top: 40, right: 24, maxWidth: 360 }}>
              <div className="muted">
                Call {hover! + 1} · {fmtTime(hp.ts)} · {shortModel(hp.model)}
              </div>
              <div>
                <span className="key" style={{ background: 'var(--series-1)' }} />
                <span className="v">{fmtInt(hp.contextTokens)}</span> context tokens{' '}
                {hp.deltaTokens !== null && <span className="muted">({signed(hp.deltaTokens)})</span>}
              </div>
              <div>
                <span className="key" style={{ background: 'var(--series-3)' }} />
                <span className="v">{hp.cacheHitRatio === null ? '–' : `${(hp.cacheHitRatio * 100).toFixed(1)}%`}</span> cache hit
                {hp.cache.severity !== 'none' && <span className={`sev-${hp.cache.severity}`}> · {hp.cache.severity} miss</span>}
              </div>
              {hp.contributors.slice(0, 3).map((c, i) => (
                <div key={i} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <span className="kind-key" style={{ background: KIND_COLOR[c.kind] }} />
                  <span className="v">{signed(c.estTokens)}</span> {c.label}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {!wide && pointDetail && <div style={{ margin: '0 12px 12px' }}>{pointDetail}</div>}

      <div className="ctx-grid">
        <Panel label="Biggest context jumps" flush emptyLabel="No increases yet" className={paired ? undefined : 'span-all'}>
          {derived.biggest.length > 0 && (
            <table className="tbl">
              <thead>
                <tr><th className="num">#</th><th>Time</th><th className="num">Δ</th><th>Main cause</th></tr>
              </thead>
              <tbody>
                {derived.biggest.map(([p, i]) => (
                  <tr key={p.requestRowId} className={`click ${selected === i ? 'sel' : ''}`} onClick={() => setSelected(i)}>
                    <td className="num">{i + 1}</td>
                    <td>{fmtTime(p.ts)}</td>
                    <td className="num">{signed(p.deltaTokens)}</td>
                    <td className="lbl" title={p.contributors[0]?.label}>
                      {p.contributors[0] && <span className="kind-key" style={{ background: KIND_COLOR[p.contributors[0].kind] }} />}
                      {p.contributors[0]?.label ?? ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
        <Panel
          label="Cache misses"
          flush
          className={paired ? undefined : 'span-all'}
          actions={derived.missIdx.length > 0 ? <Tag tone="inert">{fmtTokens(derived.missedTokens)} tokens re-written</Tag> : undefined}
        >
          {derived.missIdx.length === 0 ? (
            <div className="card-body muted">None: every call re-used at least 80% of the previous prompt.</div>
          ) : (
            <table className="tbl">
              <thead>
                <tr><th className="num">#</th><th>Time</th><th className="num">Re-used</th><th>Likely cause</th></tr>
              </thead>
              <tbody>
                {[...derived.missIdx].reverse().map((i) => {
                  const p = pts[i];
                  return (
                    <tr key={p.requestRowId} className={`click ${selected === i ? 'sel' : ''}`} onClick={() => setSelected(i)}>
                      <td className="num">{i + 1}</td>
                      <td>{fmtTime(p.ts)}</td>
                      <td className={`num sev-${p.cache.severity}`}>{p.cache.reuseRatio === null ? '' : `${Math.round(p.cache.reuseRatio * 100)}%`}</td>
                      <td className="lbl" title={p.cache.reasons.join('\n')}>{p.cache.reasons[0]}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Panel>
        <Panel
          label="Top context consumers"
          className="span-all"
          actions={
            <SegmentedControl
              label="Group consumers"
              value={consumerView}
              onChange={(v) => setConsumerView(v as 'category' | 'item')}
              options={[
                { value: 'category', label: 'By type' },
                { value: 'item', label: 'By file / command' },
              ]}
            />
          }
        >
          <div className="sub muted" style={{ marginBottom: 6 }}>
            Estimated tokens each source added over the session (excluding compactions). The previous assistant message counts because it is sent back as
            input on the next model call.
          </div>
          <table className="tbl">
            <thead>
              <tr><th>Source</th><th className="num">Times</th><th className="num">~Tokens</th><th style={{ width: '30%' }} /><th className="num">Bytes</th></tr>
            </thead>
            <tbody>
              {consumers.map((g) => (
                <tr key={g.key}>
                  <td className="lbl" title={g.label}>
                    <span className="kind-key" style={{ background: KIND_COLOR[g.kind] }} />
                    {consumerView === 'category' ? `${KIND_LABEL[g.kind]}: ${g.label}` : g.label}
                  </td>
                  <td className="num">{g.count}</td>
                  <td className="num">{fmtTokens(g.estTokens)}</td>
                  <td><div className="bar" style={{ width: `${(g.estTokens / consumerMax) * 100}%`, background: KIND_COLOR[g.kind] }} /></td>
                  <td className="num muted">{g.bytes ? fmtBytes(g.bytes) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
        <Panel label="Injected context" className="span-all" emptyLabel="None">
          {derived.byKind.length > 0 && (
            <>
              <div className="sub muted" style={{ marginBottom: 6 }}>
                Harness attachments in the main transcript (skill listings, MCP instructions, deferred tools, hook context, memory), by content size.
              </div>
              {derived.byKind.map(([kind, g]) => (
                <div key={kind}>
                  <div className="tree-row" onClick={() => setOpenKind(openKind === kind ? null : kind)} style={{ cursor: 'pointer' }}>
                    <span className="twisty">{openKind === kind ? '▾' : '▸'}</span>
                    <span className="tag tag-attachment" style={{ minWidth: 200 }}>{kind}</span>
                    <span className="sum">{g.count} records</span>
                    <span className="when">{fmtBytes(g.bytes)}</span>
                  </div>
                  {openKind === kind &&
                    [...g.items].reverse().map((i) => (
                      <div key={i.recordId} className="tree-row" style={{ paddingLeft: 30, cursor: 'pointer' }} onClick={() => onOpenRecord(i.recordId)} title="Show in Transcript">
                        <span className="sum">{i.label}</span>
                        <span className="when">{fmtBytes(i.bytes)}</span>
                        <span className="when">{fmtTime(i.ts)}</span>
                      </div>
                    ))}
                </div>
              ))}
            </>
          )}
        </Panel>
      </div>
    </>
  );

  return (
    <div className="pane" style={{ flex: 1 }}>
      <div className="toolbar">
        <MetaLine
          wrap
          entries={[
            { term: 'Peak', detail: fmtTokens(derived.peak) },
            { term: 'Latest', detail: fmtTokens(derived.last) },
            { term: 'Avg cache hit', detail: derived.avgHit === null ? '–' : `${(derived.avgHit * 100).toFixed(0)}%` },
            { term: 'Cache misses', detail: String(derived.missIdx.length) },
            { term: 'Compactions', detail: String(data.compactions.length) },
            { term: 'Turns', detail: String(data.turns.length) },
            { term: 'Main-agent model calls', detail: String(pts.length) },
          ]}
        />
        <span className="spacer" />
        <SegmentedControl
          label="Context view"
          value={showTable ? 'table' : 'chart'}
          onChange={(v) => setShowTable(v === 'table')}
          options={[
            { value: 'chart', label: 'Chart' },
            { value: 'table', label: 'Table' },
          ]}
        />
      </div>
      {wide ? (
        <Split
          storageKey="context-detail"
          side="right"
          defaultWidth={Math.round(window.innerWidth * 0.32)}
          min={360}
          pane={
            <div className="pane detail">
              <div className="detail-body">
                {pointDetail ?? <EmptyState label="No call selected" description="Click a point on the chart or a row in a table to see what was added and why the cache missed." />}
              </div>
            </div>
          }
        >
          <div className="scroll">{main}</div>
        </Split>
      ) : (
        <div className="scroll">{main}</div>
      )}
    </div>
  );
}

function PointDetail({
  sessionId,
  p,
  index,
  onClose,
  onOpenRecord,
  onOpenTool,
}: {
  sessionId: string;
  p: ContextPoint;
  index: number;
  onClose: () => void;
  onOpenRecord: (id: number) => void;
  onOpenTool: (toolUseId: string) => void;
}) {
  const max = p.contributors.reduce((m, c) => Math.max(m, c.estTokens), 1);
  // Contributors arrive largest first. Start on the biggest one that came from a
  // tool call, since that's the one with a "why" to explain.
  const [sel, setSel] = useState(() => Math.max(0, p.contributors.findIndex((c) => c.toolUseId)));
  const selected = p.contributors[sel];
  const top = p.contributors[0];
  const reuse = p.cache.reuseRatio === null ? null : `${Math.round(p.cache.reuseRatio * 100)}%`;

  return (
    <Panel
      label={`Call ${index + 1} · ${fmtTime(p.ts)} · ${shortModel(p.model)}${p.effort ? ` · effort ${p.effort}` : ''}`}
      actions={
        <Button onClick={onClose} agentName="Close call breakdown">
          Close
        </Button>
      }
    >
      {/* One line that answers "what happened here"; the rest is detail. */}
      <p className="headline">
        <b>{p.deltaTokens === null ? `${fmtTokens(p.contextTokens)} tokens` : `${signed(p.deltaTokens)} tokens`}</b>
        {top && p.deltaTokens !== null && p.deltaTokens > 0 && (
          <>
            , mostly <span className="headline-cause">{top.label}</span>
          </>
        )}
        <span className="muted">
          {' '}
          · {fmtTokens(p.contextTokens)} total
          {reuse !== null && ` · cache re-used ${reuse}`}
          {p.gapMs !== null && ` · idle ${fmtMs(p.gapMs)}`} · output {fmtTokens(p.outputTokens)}
        </span>
      </p>
      {p.cache.severity !== 'none' && (
        <Alert tone={p.cache.severity === 'full' ? 'danger' : 'warning'} label={p.cache.severity === 'cold' ? 'Cold cache' : `Cache ${p.cache.severity} miss`}>
          {p.cache.reasons.join(' · ')}
        </Alert>
      )}

      <div className="section-title">
        Added since the previous call{p.contributorCount > p.contributors.length ? ` (largest ${p.contributors.length} of ${p.contributorCount})` : ''}
      </div>
      {p.contributors.length === 0 ? (
        <div className="muted">Nothing was appended (or this is the first call).</div>
      ) : (
        <table className="tbl contrib">
          <tbody>
            {p.contributors.map((c, i) => (
              <tr key={i} className={`click ${i === sel ? 'sel' : ''}`} onClick={() => setSel(i)}>
                <td className="lbl">
                  <span className="kind-key" style={{ background: KIND_COLOR[c.kind] }} />
                  {c.label}
                </td>
                <td className="num">{fmtTokens(c.estTokens)}</td>
                <td style={{ width: '18%' }}>
                  <div className="bar" style={{ width: `${(c.estTokens / max) * 100}%`, background: KIND_COLOR[c.kind] }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {p.deltaTokens !== null && p.deltaTokens < 0 && <div className="muted" style={{ marginTop: 4 }}>Context shrank (compaction or cleared history); token shares aren't estimated.</div>}

      {selected && (
        <div className="contrib-actions">
          <span className="muted">{selected.bytes ? fmtBytes(selected.bytes) : ''}</span>
          {selected.toolUseId && (
            <button className="link-btn" onClick={() => onOpenTool(selected.toolUseId!)}>
              Open in Calls
            </button>
          )}
          {selected.recordId !== null && (
            <button className="link-btn" onClick={() => onOpenRecord(selected.recordId!)}>
              Show in Transcript
            </button>
          )}
        </div>
      )}

      {selected?.toolUseId ? (
        <>
          <div className="section-title">Why</div>
          <Why sessionId={sessionId} toolUseId={selected.toolUseId} onOpenRecord={onOpenRecord} />
        </>
      ) : selected ? (
        <div className="muted" style={{ marginTop: 8 }}>
          {selected.kind === 'response'
            ? "The previous assistant message is sent back as input on every call; it isn't a choice to explain."
            : 'Not from a tool call, so there is no Why chain. The harness or you added it.'}
        </div>
      ) : null}
    </Panel>
  );
}
