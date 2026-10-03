import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, DescriptionList, EmptyState, Link, Pending, Tag } from '@westonkd/sprint';
import type { RecordRow, SessionDetail, SessionSummary } from '../../shared/types';
import { getJson, useIncremental } from '../api';
import { VirtualGrid, type Column } from '../components/VirtualGrid';
import { DetailEmpty, Split, WIDE, useMediaQuery } from '../components/Layout';
import { JsonView } from '../components/JsonView';
import { costNote, fmtBytes, fmtCost, fmtFullDateTime, fmtMs, fmtTime, shortModel } from '../format';

/** Friendly names for the state records Claude Code appends (records without a uuid). */
const TYPE_LABEL: Record<string, string> = {
  'ai-title': 'Title (AI)',
  'custom-title': 'Title (custom)',
  'agent-name': 'Agent name',
  'last-prompt': 'Last prompt',
  mode: 'Mode',
  'permission-mode': 'Permission mode',
  'cost-state': 'Cost snapshot',
  'pr-link': 'PR links',
  'file-history-snapshot': 'File history snapshots',
  'file-history-delta': 'File history changes',
  'queue-operation': 'Queued input',
};
const label = (t: string) => TYPE_LABEL[t] ?? t;

const TITLE_SOURCE: Record<string, string> = {
  'ai-title': 'AI-generated title',
  'agent-name': 'Agent name',
  'first-prompt': 'First prompt',
  none: 'None',
};

interface Props {
  session: SessionDetail;
  summary: SessionSummary | undefined;
  /** Sub-view from the URL: 'overview', 'subagents', or a record type. */
  view: string | null;
  sessionHref: (sub: string) => string;
}

/**
 * Session panel, modelled on DevTools' Application panel: a sidebar of
 * categories and a table per category. Holds what describes the session
 * rather than what happened in it: overview facts, the state records Claude
 * Code appends (title, mode, permission mode, cost, file history, …) with
 * their history, and subagents.
 */
export function SessionInfo({ session, summary, view, sessionHref }: Props) {
  const { rows: records, loading, error } = useIncremental<RecordRow>(session.sessionId, 'records');
  const wide = useMediaQuery(WIDE);
  const [selected, setSelected] = useState<string | null>(null);
  const current = view ?? 'overview';
  useEffect(() => setSelected(null), [current]);

  // Main-transcript records without a uuid are session state, grouped by type.
  const byType = useMemo(() => {
    const m = new Map<string, RecordRow[]>();
    for (const r of records) {
      if (r.uuid || r.agentId) continue;
      const arr = m.get(r.type) ?? [];
      arr.push(r);
      m.set(r.type, arr);
    }
    return [...m.entries()].sort((a, b) => label(a[0]).localeCompare(label(b[0])));
  }, [records]);

  const s = summary ?? session;
  const known = byType.filter(([t]) => TYPE_LABEL[t]);
  const other = byType.filter(([t]) => !TYPE_LABEL[t]);
  // A dense DevTools-style list rather than Sprint's Nav, whose display
  // typography (uppercase, wide tracking) wraps and hides counts here.
  const item = (key: string, text: string, count?: number, mono = false) => (
    <a key={key} href={sessionHref(key)} className={`side-item ${current === key ? 'sel' : ''}`} aria-current={current === key ? 'page' : undefined}>
      <span className={`side-label ${mono ? 'mono' : ''}`}>{text}</span>
      {count !== undefined && <span className="side-count">{count.toLocaleString()}</span>}
    </a>
  );
  const sidebar = (
    <nav className="app-side" aria-label="Session">
      <div className="section-label">Session</div>
      {item('overview', 'Overview')}
      {item('subagents', 'Subagents', session.subagents.length)}
      <div className="section-label">State records</div>
      {loading && byType.length === 0 && <div className="side-note muted">Loading…</div>}
      {known.map(([t, rs]) => item(t, label(t), rs.length))}
      {other.length > 0 && (
        <>
          <div className="section-label" title="Record types this app doesn't recognise yet">Other</div>
          {other.map(([t, rs]) => item(t, t, rs.length, true))}
        </>
      )}
    </nav>
  );

  let main: React.ReactNode;
  if (error) main = <Alert tone="danger" label="Couldn't load session records">{error}</Alert>;
  else if (current === 'overview')
    main = (
      <div className="detail-body flush">
        <DescriptionList
          label="Session overview"
          className="kv overview-kv"
          items={[
            { term: 'Title', description: session.title },
            { term: 'Title from', description: TITLE_SOURCE[session.titleSource] ?? session.titleSource },
            { term: 'Session id', description: session.sessionId },
            { term: 'Project', description: session.cwd ?? '' },
            { term: 'Branch', description: session.gitBranch ?? '' },
            { term: 'Claude Code version', description: session.version ?? '' },
            { term: 'Models', description: s.models.map(shortModel).join(', ') },
            { term: 'Permission mode', description: session.permissionMode ?? '' },
            { term: 'Started', description: fmtFullDateTime(s.firstTs) },
            { term: 'Last activity', description: fmtFullDateTime(s.lastTs) },
            { term: 'Duration', description: fmtMs(s.durationMs) },
            { term: 'Model calls', description: s.requestCount.toLocaleString() },
            { term: 'Tool calls', description: s.toolCount.toLocaleString() },
            { term: 'Errors', description: s.errorCount.toLocaleString() },
            { term: 'Subagents', description: String(session.subagents.length) },
            { term: 'Records', description: s.recordCount.toLocaleString() },
            {
              term: s.costSource === 'cli' ? 'API cost (reported by Claude Code)' : 'API cost (estimated)',
              description: s.costUsd === null ? '' : <span title={costNote(s.costSource)}>{fmtCost(s.costUsd)} <span className="muted">at API rates, not billed on a subscription</span></span>,
            },
            { term: 'Transcript', description: session.hasTranscript ? 'present' : 'deleted by Claude Code cleanup' },
          ].filter((i) => i.description)}
        />
        {session.prLinks.length > 0 && (
          <>
            <div className="section-title">Pull requests</div>
            {session.prLinks.map((p) => (
              <div key={p.prUrl}>
                <Link href={p.prUrl} external>
                  {p.prNumber ? `#${p.prNumber}` : p.prUrl}
                </Link>
              </div>
            ))}
          </>
        )}
      </div>
    );
  else if (current === 'subagents')
    main =
      session.subagents.length === 0 ? (
        <EmptyState label="No subagents" description="This session didn't spawn any subagents." />
      ) : (
        <div className="detail-body">
          <table className="tbl">
            <thead>
              <tr><th>Type</th><th>Description</th><th className="num">Records</th><th>Agent id</th></tr>
            </thead>
            <tbody>
              {session.subagents.map((a) => (
                <tr key={a.agentId}>
                  <td><Tag tone="inert">{a.agentType ?? 'subagent'}</Tag></td>
                  <td className="lbl">{a.description ?? ''}</td>
                  <td className="num">{a.recordCount.toLocaleString()}</td>
                  <td className="mono muted">{a.agentId}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  else main = <StateRecords rows={byType.find(([t]) => t === current)?.[1] ?? []} type={current} selected={selected} onSelect={setSelected} wide={wide} />;

  // State record views draw their own header (with counts and the latest value).
  const head =
    current === 'overview' ? (
      <SectionHead title="Overview" sub="What this session is and what it did" />
    ) : current === 'subagents' ? (
      <SectionHead title="Subagents" sub={`${session.subagents.length} spawned by this session`} />
    ) : null;

  return (
    <div className="pane" style={{ flex: 1 }}>
      <Split storageKey="session-side" side="left" defaultWidth={240} min={180} maxFraction={0.35} pane={sidebar}>
        {head}
        {main}
      </Split>
    </div>
  );
}

const columns: Column<RecordRow & { n: number }>[] = [
  { key: 'n', title: '#', width: '56px', className: 'num', render: (r) => r.n },
  { key: 'ts', title: 'Time', width: '80px', render: (r) => <span className="muted">{r.ts ? fmtTime(r.ts) : '–'}</span> },
  { key: 'value', title: 'Value', width: 'minmax(200px, 1fr)', render: (r) => r.summary || <span className="muted">(no summary)</span> },
  { key: 'size', title: 'Size', width: '70px', className: 'num', render: (r) => <span className="muted">{fmtBytes(r.bytes)}</span> },
];

/** Header bar naming the section selected in the sidebar. */
function SectionHead({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="toolbar section-head">
      <b>{title}</b>
      <span className="muted">{sub}</span>
    </div>
  );
}

/** History of one state record type, newest first, with the raw record beside it. */
function StateRecords({ rows, type, selected, onSelect, wide }: { rows: RecordRow[]; type: string; selected: string | null; onSelect: (k: string | null) => void; wide: boolean }) {
  const numbered = useMemo(() => rows.map((r, i) => ({ ...r, n: i + 1 })).reverse(), [rows]);
  const rowKey = useCallback((r: RecordRow) => String(r.id), []);
  const latest = numbered[0];
  const sel = numbered.find((r) => String(r.id) === selected) ?? null;
  if (!rows.length) return <EmptyState label={`No ${label(type)} records`} />;
  return (
    <div className="pane" style={{ flex: 1 }}>
      <SectionHead title={label(type)} sub={`${rows.length.toLocaleString()} records · latest: ${latest.summary || '(no summary)'}`} />
      <Split
        storageKey="session-detail"
        side="right"
        defaultWidth={Math.round(window.innerWidth * 0.36)}
        min={320}
        pane={sel ? <RawRecord id={sel.id} onClose={() => onSelect(null)} /> : wide ? <DetailEmpty label="No record selected">Select a row to see the full record.</DetailEmpty> : null}
      >
        <VirtualGrid rows={numbered} columns={columns} rowKey={rowKey} selected={selected} onSelect={onSelect} />
      </Split>
    </div>
  );
}

function RawRecord({ id, onClose }: { id: number; onClose: () => void }) {
  const [data, setData] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    getJson(`/api/records/${id}/raw`)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(String(e.message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [id]);
  return (
    <div className="pane detail">
      <div className="detail-head">
        <button className="close" onClick={onClose} title="Close (Esc)">×</button>
        <span className="tab on">Record</span>
      </div>
      <div className="detail-body">
        {error ? <Alert tone="danger" label="Couldn't load this record">{error}</Alert> : data === null ? <Pending loading label="Loading record" /> : <JsonView value={data} defaultOpen={3} />}
      </div>
    </div>
  );
}
