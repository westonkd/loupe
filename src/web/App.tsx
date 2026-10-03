import { useCallback, useEffect, useRef, useState } from 'react';
import type { IndexStatus, SessionDetail, SessionSummary } from '../shared/types';
import { getJson, useConnected, useServerEvents, useSessionResource } from './api';
import { SessionRail, SessionsTable, useSessions, LiveBadge } from './panels/Sessions';
import { Calls } from './panels/Calls';
import { Transcript } from './panels/Transcript';
import { Context } from './panels/Context';
import { Console } from './panels/Console';
import { SessionInfo } from './panels/SessionInfo';
import { Insights } from './panels/Insights';
import { costTerm, fmtBytes, fmtCost, fmtDateTime, fmtMs, homeRelative, shortModel } from './format';
import { Split, useMediaQuery, useStoredState } from './components/Layout';
import { OverflowTips } from './components/OverflowTips';
import { Logo } from './components/Logo';
import { SidebarToggle } from './components/SidebarToggle';
import { Alert, MetaLine, Pending, Progress, SegmentedControl, Tag } from '@westonkd/sprint';

type Tab = 'calls' | 'transcript' | 'context' | 'console' | 'session';
const TABS: Array<[Tab, string]> = [
  ['calls', 'Calls'],
  ['transcript', 'Transcript'],
  ['context', 'Context'],
  ['console', 'Console'],
  ['session', 'Session'],
];
// Links saved before the panels were renamed.
const LEGACY_TABS: Record<string, Tab> = { network: 'calls', elements: 'transcript' };

// `#/insights` is a top-level view, not a session: it aggregates all of them.
const INSIGHTS = 'insights';

function parseHash(): { sid: string | null; tab: Tab; sub: string | null; insights: boolean } {
  const parts = window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const tab = (TABS.find(([t]) => t === parts[1])?.[0] ?? LEGACY_TABS[parts[1]] ?? 'calls') as Tab;
  if (parts[0] === INSIGHTS) return { sid: null, tab, sub: null, insights: true };
  return { sid: parts[0] ? decodeURIComponent(parts[0]) : null, tab, sub: parts[2] ? decodeURIComponent(parts[2]) : null, insights: false };
}

type Theme = 'system' | 'light' | 'dark';
function loadTheme(): Theme {
  try {
    const t = localStorage.getItem('theme');
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}
const DARK_QUERY = '(prefers-color-scheme: dark)';
function applyTheme(t: Theme, osDark: boolean) {
  const root = document.documentElement;
  if (t === 'system') delete root.dataset.theme;
  else root.dataset.theme = t;
  // Sprint's tokens follow this attribute; the app's own tokens derive from them.
  root.dataset.sprintTheme = t === 'system' ? (osDark ? 'dark' : 'light') : t;
  try {
    localStorage.setItem('theme', t);
  } catch {
    /* storage unavailable */
  }
}

export function App() {
  const [{ sid, tab, sub, insights }, setRoute] = useState(parseHash);
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const [status, setStatus] = useState<IndexStatus | null>(null);
  const [callSelected, setCallSelected] = useState<string | null>(null);
  const [railOpen, setRailOpen] = useStoredState('rail-open', false);
  const [agentFilter, setAgentFilter] = useState('all');
  const [focusRecord, setFocusRecord] = useState<{ id: number; n: number } | null>(null);
  const [focusTool, setFocusTool] = useState<{ id: string; n: number } | null>(null);
  const connected = useConnected();
  const { sessions, error: sessionsError, loaded } = useSessions();
  const { data: session, error: sessionError } = useSessionResource<SessionDetail>(sid, sid ? `/api/sessions/${encodeURIComponent(sid)}` : null);
  const osDark = useMediaQuery(DARK_QUERY);

  useEffect(() => applyTheme(theme, osDark), [theme, osDark]);
  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    setCallSelected(null);
    setAgentFilter('all');
    setFocusRecord(null);
    setFocusTool(null);
  }, [sid]);
  useEffect(() => {
    getJson<IndexStatus>('/api/status').then(setStatus).catch(() => {});
  }, []);
  useServerEvents((ev) => {
    if (ev.type === 'status') setStatus(ev.status);
  });

  const go = useCallback((s: string | null, t: Tab = 'calls') => {
    window.location.hash = s ? `#/${encodeURIComponent(s)}/${t}` : '#/';
  }, []);
  const openRecord = useCallback(
    (id: number) => {
      setFocusRecord((f) => ({ id, n: (f?.n ?? 0) + 1 }));
      if (sid) go(sid, 'transcript');
    },
    [sid, go],
  );
  const openTool = useCallback(
    (id: string) => {
      setFocusTool((f) => ({ id, n: (f?.n ?? 0) + 1 }));
      if (sid) go(sid, 'calls');
    },
    [sid, go],
  );

  const railOpenRef = useRef(railOpen);
  railOpenRef.current = railOpen;

  // "[" shows or hides the session rail. ("/" is each panel's SearchField shortcut.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return;
      if (e.key !== '[' || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      setRailOpen(!railOpenRef.current);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setRailOpen]);

  const summary = sid ? sessions.find((s) => s.sessionId === sid) : undefined;

  return (
    <div className="app">
      <OverflowTips />
      <div className="topbar">
        <a className="brand" href="#/" title="All sessions">
          <Logo title="Loupe" />
          <span className="wordmark">Loupe</span>
        </a>
        <nav className="topnav">
          <a className={`tab ${!sid && !insights ? 'on' : ''}`} href="#/">Sessions</a>
          <a className={`tab ${insights ? 'on' : ''}`} href={`#/${INSIGHTS}`}>Insights</a>
        </nav>
        <span className="spacer" />
        <SegmentedControl
          label="Theme"
          className="hide-label"
          value={theme}
          onChange={(v) => setTheme(v as Theme)}
          options={[
            { value: 'system', label: 'System' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
        />
      </div>

      <div className="body">
        {insights ? (
          <div className="main">
            <Insights />
          </div>
        ) : !sid ? (
          <div className="main">
            {sessionsError ? (
              <Alert tone="danger" label="Couldn't load sessions">{sessionsError}</Alert>
            ) : !loaded ? (
              <Pending loading label="Loading sessions" />
            ) : (
              <SessionsTable sessions={sessions} onOpen={(id) => go(id)} />
            )}
          </div>
        ) : (
          <Split
            storageKey="rail"
            side="left"
            defaultWidth={320}
            min={220}
            maxFraction={0.4}
            pane={railOpen ? <SessionRail sessions={sessions} current={sid} onOpen={(id) => go(id, tab)} onHide={() => setRailOpen(false)} /> : null}
          >
            <div className="main">
              {sessionError ? (
                <Alert tone="danger" label="Couldn't load this session">{sessionError}</Alert>
              ) : !session ? (
                <Pending loading label="Loading session" />
              ) : (
                <>
                  <SessionHeader session={session} summary={summary} onShowRail={railOpen ? undefined : () => setRailOpen(true)} />
                  <div className="tabs">
                    {TABS.map(([t, label]) => (
                      <button key={t} className={`tab ${tab === t ? 'on' : ''}`} onClick={() => go(sid, t)}>
                        {label}
                      </button>
                    ))}
                  </div>
                  {!session.hasTranscript && (
                    <Alert tone="warning" label="Transcript deleted">
                      Claude Code's cleanup deleted this transcript. Indexed summaries are still shown, but raw records can't be opened.
                    </Alert>
                  )}
                  {tab === 'calls' && (
                    <Calls
                      session={session}
                      selected={callSelected}
                      onSelect={setCallSelected}
                      agentFilter={agentFilter}
                      onAgentFilter={setAgentFilter}
                      onOpenRecord={openRecord}
                      focusToolUseId={focusTool}
                    />
                  )}
                  {tab === 'transcript' && <Transcript key={focusRecord?.n ?? 0} session={session} focusRecordId={focusRecord?.id ?? null} onOpenTool={openTool} />}
                  {tab === 'context' && <Context session={session} onOpenRecord={openRecord} onOpenTool={openTool} />}
                  {tab === 'console' && <Console session={session} onOpenRecord={openRecord} />}
                  {tab === 'session' && (
                    <SessionInfo session={session} summary={summary} view={sub} sessionHref={(v) => `#/${encodeURIComponent(sid)}/session/${encodeURIComponent(v)}`} />
                  )}
                </>
              )}
            </div>
          </Split>
        )}
      </div>

      <div className="statusbar">
        <span>
          <span className={`dot ${connected ? 'on' : 'off'}`} />
          {connected ? 'Live' : 'Disconnected'}
        </span>
        {status && (
          <>
            {status.indexing ? (
              <Progress label={`Indexing ${status.filesDone}/${status.filesTotal} files`} value={status.filesDone} max={Math.max(1, status.filesTotal)} className="status-progress" />
            ) : (
              <span>{`${status.sessions.toLocaleString()} sessions, ${status.records.toLocaleString()} records`}</span>
            )}
            {status.lastPollMs !== null && <span>poll {status.lastPollMs} ms</span>}
            {status.archive && <span title="Raw transcripts are copied into the data volume so they survive Claude Code's cleanup. Set ARCHIVE=0 to keep nothing.">archive {fmtBytes(status.archiveBytes ?? 0)}</span>}
            <span style={{ flex: 1 }} />
            <span>read-only · v{status.version}</span>
          </>
        )}
      </div>
    </div>
  );
}

/** Session identity and totals, one line; the stats wrap under the title on narrow windows. */
function SessionHeader({ session, summary, onShowRail }: { session: SessionDetail; summary: SessionSummary | undefined; onShowRail?: () => void }) {
  const s = summary ?? session;
  const entries = [
    { term: 'Started', detail: fmtDateTime(s.firstTs) },
    { term: 'Duration', detail: fmtMs(s.durationMs) },
    { term: 'Models', detail: s.models.map(shortModel).join(', ') },
    { term: 'Model calls', detail: s.requestCount.toLocaleString() },
    { term: 'Tool calls', detail: s.toolCount.toLocaleString() },
    { term: 'Subagents', detail: session.subagents.length ? String(session.subagents.length) : '' },
    { term: costTerm(s.costSource), detail: fmtCost(s.costUsd) },
  ].filter((e) => e.detail);
  return (
    <div className="session-head">
      <div className="who" title={`${session.sessionId}\n${session.cwd ?? ''}`}>
        {onShowRail && <SidebarToggle open={false} onToggle={onShowRail} />}
        {summary && <LiveBadge s={summary} />}
        <span className="t">{session.title}</span>
        <span className="muted">
          {homeRelative(session.cwd)}
          {session.gitBranch ? ` · ${session.gitBranch}` : ''}
        </span>
        {s.errorCount > 0 && <Tag tone="danger">{s.errorCount} errors</Tag>}
      </div>
      <MetaLine className="stats" entries={entries} wrap />
    </div>
  );
}
