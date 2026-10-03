import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionSummary } from '../../shared/types';
import { getJson, useServerEvents } from '../api';
import { VirtualGrid, type Column } from '../components/VirtualGrid';
import { FilterSelect } from '../components/FilterSelect';
import { SidebarToggle } from '../components/SidebarToggle';
import { EmptyState, SearchField, Tag } from '@westonkd/sprint';
import { COST_TERM, costNote, fmtCost, fmtDateTime, fmtMs, homeRelative, shortModel } from '../format';

export function useSessions() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const timer = useRef<number | null>(null);
  const load = useCallback(() => {
    getJson<SessionSummary[]>('/api/sessions')
      .then((s) => {
        setSessions(s);
        setError(null);
      })
      .catch((e) => setError(String(e.message ?? e)))
      .finally(() => setLoaded(true));
  }, []);
  useEffect(() => {
    load();
    const id = window.setInterval(load, 30_000);
    return () => window.clearInterval(id);
  }, [load]);
  useServerEvents((ev) => {
    if (ev.type === 'status') return;
    if (timer.current !== null) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      load();
    }, ev.type === 'sessions' ? 300 : 2000);
  });
  return { sessions, error, loaded };
}

export function LiveBadge({ s }: { s: SessionSummary }) {
  if (!s.hasTranscript)
    return (
      <Tag tone="danger" title="Transcript deleted by Claude Code cleanup; metadata only">
        deleted
      </Tag>
    );
  if (s.liveness === 'active') return <Tag tone="action" filled>active</Tag>;
  if (s.liveness === 'idle') return <Tag tone="warning">idle</Tag>;
  return null;
}

function useFiltered(sessions: SessionSummary[], project: string, q: string) {
  return useMemo(() => {
    const t = q.trim().toLowerCase();
    return sessions.filter(
      (s) => (!project || s.cwd === project) && (!t || s.title.toLowerCase().includes(t) || s.sessionId.startsWith(t) || (s.gitBranch ?? '').toLowerCase().includes(t)),
    );
  }, [sessions, project, q]);
}

function Filters({
  sessions,
  project,
  setProject,
  q,
  setQ,
  shortcut,
  trailing,
}: {
  sessions: SessionSummary[];
  project: string;
  setProject: (p: string) => void;
  q: string;
  setQ: (q: string) => void;
  /** Only one field per page may own the "/" shortcut. */
  shortcut?: string;
  /** Extra control on the search row (the rail's hide toggle). */
  trailing?: React.ReactNode;
}) {
  const projects = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of sessions) if (s.cwd) m.set(s.cwd, (m.get(s.cwd) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [sessions]);
  return (
    <div className={`toolbar ${trailing ? 'rail-filters' : ''}`}>
      <SearchField label="Sessions" hideLabel placeholder="Title, branch or id" shortcut={shortcut ?? false} value={q} onChange={setQ} className="grow" />
      {trailing}
      <FilterSelect label="Project" allLabel="All projects" value={project} onChange={setProject} options={projects.map(([p, n]) => ({ value: p, label: homeRelative(p), count: n }))} />
    </div>
  );
}

const columns: Column<SessionSummary>[] = [
  { key: 'live', title: '', width: '76px', render: (s) => <LiveBadge s={s} /> },
  { key: 'title', title: 'Title', width: 'minmax(200px, 3fr)', render: (s) => <span className={s.titleSource === 'first-prompt' ? 'muted' : ''}>{s.title}</span>, title2: (s) => s.title },
  { key: 'project', title: 'Project', width: 'minmax(120px, 1.5fr)', render: (s) => homeRelative(s.cwd), title2: (s) => s.cwd ?? '' },
  { key: 'branch', title: 'Branch', width: 'minmax(70px, 0.8fr)', render: (s) => s.gitBranch ?? '' },
  { key: 'models', title: 'Models', width: 'minmax(90px, 1fr)', render: (s) => s.models.map(shortModel).join(', ') },
  { key: 'start', title: 'Started', width: '110px', render: (s) => fmtDateTime(s.firstTs) },
  { key: 'dur', title: 'Duration', width: '76px', className: 'num', render: (s) => fmtMs(s.durationMs) },
  { key: 'req', title: 'Model calls', width: '84px', className: 'num', render: (s) => s.requestCount || '' },
  { key: 'tools', title: 'Tool calls', width: '72px', className: 'num', render: (s) => s.toolCount || '' },
  { key: 'err', title: 'Errors', width: '54px', className: 'num', render: (s) => (s.errorCount ? <span className="status-error">{s.errorCount}</span> : '') },
  {
    key: 'cost',
    title: COST_TERM,
    width: '70px',
    className: 'num',
    render: (s) => fmtCost(s.costUsd),
    title2: (s) => (s.costSource ? costNote(s.costSource) : undefined),
  },
];

/** Landing page: full sessions table. */
export function SessionsTable({ sessions, onOpen }: { sessions: SessionSummary[]; onOpen: (id: string) => void }) {
  const [project, setProject] = useState('');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const rows = useFiltered(sessions, project, q);
  const rowKey = useCallback((s: SessionSummary) => s.sessionId, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === 'Enter' && sel && t.tagName !== 'INPUT') onOpen(sel);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sel, onOpen]);
  return (
    <div className="pane" style={{ flex: 1 }}>
      <Filters sessions={sessions} project={project} setProject={setProject} q={q} setQ={setQ} shortcut="/" />
      <p className="lede">
        Click a session to open it, then dig in with the Calls, Transcript, Context and Console panels.
        <span className="keys">j / k to move · Enter to open · / to search</span>
      </p>
      <div className="pane" style={{ flex: 1 }}>
        <VirtualGrid
          rows={rows}
          columns={columns}
          rowKey={rowKey}
          selected={sel}
          onSelect={setSel}
          onActivate={onOpen}
          empty={<EmptyState reason={q || project ? 'filtered' : 'empty'} label="No sessions found" />}
        />
      </div>
      <div className="statusbar">
        {rows.length} of {sessions.length} sessions · click a row to open it
      </div>
    </div>
  );
}

/** Left rail while a session is open. */
export function SessionRail({ sessions, current, onOpen, onHide }: { sessions: SessionSummary[]; current: string; onOpen: (id: string) => void; onHide: () => void }) {
  const [project, setProject] = useState('');
  const [q, setQ] = useState('');
  const rows = useFiltered(sessions, project, q);
  const live = rows.filter((s) => s.liveness !== 'ended');
  const history = rows.filter((s) => s.liveness === 'ended');
  const item = (s: SessionSummary) => (
    <div key={s.sessionId} className={`session-item ${s.sessionId === current ? 'sel' : ''}`} onClick={() => onOpen(s.sessionId)} title={s.title}>
      <div className="t">{s.title}</div>
      <div className="m">
        <LiveBadge s={s} />
        <span>{fmtDateTime(s.lastTs ?? s.firstTs)}</span>
        <span title={costNote(s.costSource)}>{fmtCost(s.costUsd)}</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{homeRelative(s.cwd)}</span>
      </div>
    </div>
  );
  return (
    <div className="rail">
      <Filters sessions={sessions} project={project} setProject={setProject} q={q} setQ={setQ} trailing={<SidebarToggle open onToggle={onHide} />} />
      <div className="session-list">
        {live.length > 0 && <div className="section-label">Live</div>}
        {live.map(item)}
        <div className="section-label">History</div>
        {history.map(item)}
      </div>
    </div>
  );
}
