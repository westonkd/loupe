import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ConsoleEntry, ConsoleLevel, ConsoleView, SessionDetail } from '../../shared/types';
import { useSessionResource } from '../api';
import { VirtualGrid, type Column } from '../components/VirtualGrid';
import { fmtTime } from '../format';
import { SortToggle, loadDesc, saveDesc } from '../components/SortToggle';
import { DetailEmpty, Split, WIDE, useMediaQuery } from '../components/Layout';
import { FilterSelect } from '../components/FilterSelect';
import { Alert, Button, DescriptionList, EmptyState, Pending, SearchField } from '@westonkd/sprint';

const LEVELS: ConsoleLevel[] = ['error', 'warn', 'info', 'log', 'debug'];
const SOURCES: Array<ConsoleEntry['source']> = ['debug', 'hook', 'system', 'api'];

const columns: Column<ConsoleEntry>[] = [
  { key: 'ts', title: 'Time', width: '74px', render: (e) => <span className="muted">{fmtTime(e.ts)}</span> },
  { key: 'level', title: 'Level', width: '56px', render: (e) => <span className={`lvl-${e.level}`}>{e.level}</span> },
  { key: 'src', title: 'Source', width: '170px', render: (e) => <span className="muted">{e.source}{e.category ? ` · ${e.category}` : ''}</span>, title2: (e) => e.category ?? '' },
  { key: 'text', title: 'Message', width: 'minmax(200px, 1fr)', render: (e) => e.text.split('\n')[0], title2: (e) => e.text.slice(0, 500) },
];

export function Console({ session, onOpenRecord }: { session: SessionDetail; onOpenRecord: (id: number) => void }) {
  const sid = session.sessionId;
  const { data, error } = useSessionResource<ConsoleView>(sid, `/api/sessions/${encodeURIComponent(sid)}/console`);
  const [levels, setLevels] = useState<Set<ConsoleLevel>>(new Set(['error', 'warn', 'info', 'log']));
  const [sources, setSources] = useState<Set<string>>(new Set(SOURCES));
  const [category, setCategory] = useState('');
  const [text, setText] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [desc, setDesc] = useState(() => loadDesc('console'));
  const wide = useMediaQuery(WIDE);

  const entries = data?.entries ?? [];
  const categories = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of entries) if (e.category) m.set(e.category, (m.get(e.category) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [entries]);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const e of entries) c[e.level] = (c[e.level] ?? 0) + 1;
    return c;
  }, [entries]);
  const rows = useMemo(() => {
    const q = text.trim().toLowerCase();
    const out = entries.filter(
      (e) => levels.has(e.level) && sources.has(e.source) && (!category || e.category === category) && (!q || e.text.toLowerCase().includes(q) || (e.category ?? '').toLowerCase().includes(q)),
    );
    return desc ? out.reverse() : out;
  }, [entries, levels, sources, category, text, desc]);
  const sel = useMemo(() => entries.find((e) => e.id === selected) ?? null, [entries, selected]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSelected(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const toggle = <T,>(set: Set<T>, v: T, apply: (s: Set<T>) => void) => {
    const n = new Set(set);
    if (n.has(v)) n.delete(v);
    else n.add(v);
    apply(n);
  };
  const rowKey = useCallback((e: ConsoleEntry) => e.id, []);
  const rowClass = useCallback((e: ConsoleEntry) => (e.level === 'error' ? 'row-error' : e.level === 'warn' ? 'row-warn' : ''), []);

  if (error) return <Alert tone="danger" label="Couldn't load the console">{error}</Alert>;
  return (
    <div className="pane" style={{ flex: 1 }}>
      <div className="toolbar">
        <SearchField label="Console" hideLabel placeholder="Filter messages" shortcut="/" value={text} onChange={setText} />
        {/* Multi-select toggles: Sprint has no multi-select chip, so these stay local. */}
        {LEVELS.map((l) => (
          <button key={l} className={`chip ${levels.has(l) ? 'on' : ''}`} onClick={() => toggle(levels, l, setLevels)}>
            {l} <span className="muted">{counts[l] ?? 0}</span>
          </button>
        ))}
        <div className="sep" />
        {SOURCES.map((s) => (
          <button key={s} className={`chip ${sources.has(s) ? 'on' : ''}`} onClick={() => toggle(sources, s, setSources)}>
            {s}
          </button>
        ))}
        <FilterSelect label="Category" allLabel="All categories" value={category} onChange={setCategory} options={categories.map(([c, n]) => ({ value: c, label: c, count: n }))} />
        <span className="spacer" />
        <SortToggle desc={desc} onChange={(d) => (setDesc(d), saveDesc('console', d))} />
      </div>
      {data && !data.hasDebugLog && (
        <Alert tone="info" label="No debug log">Showing hooks, system messages and API errors only. Run Claude Code with --debug to capture more.</Alert>
      )}
      {data?.truncated && <Alert tone="neutral" label="Truncated">Showing the most recent entries only.</Alert>}
      <Split
        storageKey="console-detail"
        side="right"
        defaultWidth={Math.round(window.innerWidth * 0.36)}
        min={320}
        pane={
          sel ? (
            <div className="pane detail">
              <div className="detail-head">
                <button className="close" onClick={() => setSelected(null)} title="Close (Esc)">×</button>
                <span className="tab on">Message</span>
              </div>
              <div className="detail-body">
                <DescriptionList
                  label="Console entry"
                  className="kv"
                  items={[
                    { term: 'Time', description: sel.ts ?? '' },
                    { term: 'Level', description: <span className={`lvl-${sel.level}`}>{sel.level}</span> },
                    { term: 'Source', description: sel.source },
                    ...(sel.category ? [{ term: 'Category', description: sel.category }] : []),
                  ]}
                />
                <pre className="block">{sel.text}</pre>
                {sel.recordId !== null && (
                  <Button style={{ marginTop: 8 }} onClick={() => onOpenRecord(sel.recordId!)}>
                    Show in Transcript
                  </Button>
                )}
              </div>
            </div>
          ) : wide ? (
            <DetailEmpty label="No entry selected">Select an entry to see the full message.</DetailEmpty>
          ) : null
        }
      >
        <VirtualGrid rows={rows} columns={columns} rowKey={rowKey} selected={selected} onSelect={setSelected} rowClass={rowClass} follow={desc ? 'top' : 'bottom'} empty={data ? <EmptyState reason={entries.length ? 'filtered' : 'empty'} label={entries.length ? 'No entries match these filters' : 'No console entries'} /> : <Pending loading label="Loading console" />} />
      </Split>
    </div>
  );
}
