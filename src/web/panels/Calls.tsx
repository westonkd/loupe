import { useCallback, useEffect, useMemo, useState } from 'react';
import type { HookRow, RequestRow, SessionDetail, ToolRow } from '../../shared/types';
import { useIncremental } from '../api';
import { VirtualGrid, type Column } from '../components/VirtualGrid';
import { CallDetail } from './CallDetail';
import { SortToggle, loadDesc, saveDesc } from '../components/SortToggle';
import { DetailEmpty, Split, WIDE, useMediaQuery } from '../components/Layout';
import { FilterSelect } from '../components/FilterSelect';
import { Alert, EmptyState, Pending, SearchField, SegmentedControl, Switch, Tag } from '@westonkd/sprint';
import { COST_NOTE_EST, COST_TERM, fmtCost, fmtMs, fmtTime, fmtTokens, pairColor, shortModel } from '../format';

/** One row in the Calls panel: a model call (one API request/assistant message), a tool call, or a hook run. */
export type CallRow =
  | { key: string; kind: 'model'; order: number; agentId: string | null; isError: boolean; ts: string | null; ref: RequestRow }
  | { key: string; kind: 'tool'; order: number; agentId: string | null; isError: boolean; ts: string | null; ref: ToolRow }
  | { key: string; kind: 'hook'; order: number; agentId: string | null; isError: boolean; ts: string | null; ref: HookRow };

type Kind = 'all' | 'model' | 'tool' | 'hook';
const KINDS: Kind[] = ['all', 'model', 'tool', 'hook'];

const KIND_LABEL: Record<Kind, string> = { all: 'All', model: 'Model', tool: 'Tools', hook: 'Hooks' };

function name(r: CallRow): string {
  if (r.kind === 'model') return shortModel(r.ref.model) || 'model call';
  if (r.kind === 'tool') return r.ref.mcpServer ? r.ref.name.slice(`mcp__${r.ref.mcpServer}__`.length) : r.ref.name;
  return r.ref.hookName;
}

function status(r: CallRow): { text: string; cls: string } {
  if (r.kind === 'model') return { text: r.ref.isError ? 'API error' : (r.ref.stopReason ?? ''), cls: r.ref.isError ? 'status-error' : '' };
  if (r.kind === 'tool') {
    const t = r.ref.status === 'denied' && r.ref.denialKind ? `denied (${r.ref.denialKind})` : r.ref.status;
    return { text: t, cls: `status-${r.ref.status}` };
  }
  return { text: r.ref.exitCode === null ? (r.ref.ok ? 'ok' : 'failed') : `exit ${r.ref.exitCode}`, cls: r.ref.ok ? '' : 'status-error' };
}

function details(r: CallRow): string {
  if (r.kind === 'model') {
    const parts = [r.ref.effort ? `effort ${r.ref.effort}` : '', r.ref.speed === 'fast' ? 'fast' : '', r.ref.toolUseCount ? `requested ${r.ref.toolUseCount} tool call${r.ref.toolUseCount > 1 ? 's' : ''}` : ''];
    return parts.filter(Boolean).join(' · ');
  }
  if (r.kind === 'tool') return r.ref.inputSummary;
  return r.ref.command ?? '';
}

function duration(r: CallRow): number | null {
  if (r.kind === 'model') return r.ref.latencyMs;
  return r.ref.durationMs;
}

const columns: Column<CallRow>[] = [
  {
    key: 'name',
    title: 'Name',
    width: 'minmax(120px, 1.2fr)',
    render: (r) => (
      <>
        {r.kind === 'tool' ? (
          <span className="pair-swatch" style={{ background: pairColor(r.ref.toolUseId), marginRight: 6 }} />
        ) : (
          <span className={`type-${r.kind}`}>{r.kind === 'model' ? '◆ ' : '⚑ '}</span>
        )}
        {name(r)}
        {r.agentId && <Tag tone="inert" className="row-tag">subagent</Tag>}
      </>
    ),
    title2: (r) => (r.kind === 'tool' ? r.ref.name : r.kind === 'model' ? (r.ref.model ?? '') : r.ref.hookName),
  },
  { key: 'type', title: 'Kind', width: '70px', render: (r) => <span className={`type-${r.kind}`}>{r.kind === 'tool' && r.ref.mcpServer ? `mcp:${r.ref.mcpServer}` : r.kind}</span> },
  { key: 'status', title: 'Status', width: '110px', render: (r) => { const s = status(r); return <span className={s.cls}>{s.text}</span>; } },
  { key: 'details', title: 'Details', width: 'minmax(160px, 3fr)', render: (r) => <span className="muted">{details(r)}</span>, title2: details },
  { key: 'ctx', title: 'Context', width: '64px', className: 'num', render: (r) => (r.kind === 'model' ? fmtTokens(r.ref.contextTokens) : '') },
  { key: 'out', title: 'Output', width: '56px', className: 'num', render: (r) => (r.kind === 'model' ? fmtTokens(r.ref.outputTokens) : '') },
  { key: 'cr', title: 'Cache R', width: '64px', className: 'num', render: (r) => (r.kind === 'model' ? fmtTokens(r.ref.cacheReadTokens) : '') },
  {
    key: 'cw',
    title: 'Cache W',
    width: '64px',
    className: 'num',
    render: (r) => (r.kind === 'model' ? fmtTokens(r.ref.cacheWrite5mTokens + r.ref.cacheWrite1hTokens) : ''),
    title2: (r) => (r.kind === 'model' ? `5m: ${r.ref.cacheWrite5mTokens}, 1h: ${r.ref.cacheWrite1hTokens}` : undefined),
  },
  { key: 'time', title: 'Duration', width: '70px', className: 'num', render: (r) => fmtMs(duration(r)), title2: (r) => (r.kind === 'model' ? 'Estimated: time from the preceding transcript record to the first output block' : undefined) },
  { key: 'cost', title: COST_TERM, width: '64px', className: 'num', render: (r) => (r.kind === 'model' ? fmtCost(r.ref.costUsd) : ''), title2: () => COST_NOTE_EST },
  { key: 'start', title: 'Started', width: '70px', className: 'num', render: (r) => <span className="muted">{fmtTime(r.ts)}</span> },
];

interface Props {
  session: SessionDetail;
  selected: string | null;
  onSelect: (key: string | null) => void;
  agentFilter: string;
  onAgentFilter: (a: string) => void;
  onOpenRecord: (recordId: number) => void;
  /** Select this tool call once it has loaded (from links in other panels). */
  focusToolUseId?: { id: string; n: number } | null;
}

export function Calls({ session, selected, onSelect, agentFilter, onAgentFilter, onOpenRecord, focusToolUseId }: Props) {
  const sid = session.sessionId;
  const requests = useIncremental<RequestRow>(sid, 'requests');
  const tools = useIncremental<ToolRow>(sid, 'tools');
  const hooks = useIncremental<HookRow>(sid, 'hooks');
  const [kind, setKind] = useState<Kind>('all');
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [toolName, setToolName] = useState('');
  const [mcp, setMcp] = useState('');
  const [text, setText] = useState('');
  const [desc, setDesc] = useState(() => loadDesc('network'));
  const wide = useMediaQuery(WIDE);

  const all = useMemo<CallRow[]>(() => {
    const out: CallRow[] = [];
    for (const r of requests.rows) out.push({ key: `m${r.id}`, kind: 'model', order: r.firstRecordId, agentId: r.agentId, isError: r.isError, ts: r.ts, ref: r });
    for (const t of tools.rows)
      out.push({
        key: `t${t.id}`,
        kind: 'tool',
        order: t.useRecordId ?? t.resultRecordId ?? 0,
        agentId: t.agentId,
        isError: t.status === 'error' || t.status === 'denied' || t.status === 'interrupted',
        ts: t.startTs ?? t.endTs,
        ref: t,
      });
    for (const h of hooks.rows) out.push({ key: `h${h.id}`, kind: 'hook', order: h.recordId, agentId: h.agentId, isError: !h.ok, ts: h.ts, ref: h });
    out.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
    return out;
  }, [requests.rows, tools.rows, hooks.rows]);

  const counts = useMemo(() => {
    const c: Record<Kind, number> = { all: all.length, model: 0, tool: 0, hook: 0 };
    for (const r of all) c[r.kind]++;
    return c;
  }, [all]);

  const toolNames = useMemo(() => [...new Set(tools.rows.map((t) => t.name))].sort(), [tools.rows]);
  const mcpServers = useMemo(() => [...new Set(tools.rows.map((t) => t.mcpServer).filter(Boolean) as string[])].sort(), [tools.rows]);

  const rows = useMemo(() => {
    const q = text.trim().toLowerCase();
    const out = all.filter((r) => {
      if (kind !== 'all' && r.kind !== kind) return false;
      if (errorsOnly && !r.isError) return false;
      if (agentFilter === 'main' && r.agentId) return false;
      if (agentFilter !== 'all' && agentFilter !== 'main' && r.agentId !== agentFilter) return false;
      if (toolName && !(r.kind === 'tool' && r.ref.name === toolName)) return false;
      if (mcp && !(r.kind === 'tool' && r.ref.mcpServer === mcp)) return false;
      if (q) {
        const hay = `${name(r)} ${details(r)} ${status(r).text} ${r.kind === 'tool' ? r.ref.name : ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    return desc ? out.reverse() : out;
  }, [all, kind, errorsOnly, agentFilter, toolName, mcp, text, desc]);

  useEffect(() => {
    if (!focusToolUseId) return;
    const t = tools.rows.find((x) => x.toolUseId === focusToolUseId.id);
    if (t) onSelect(`t${t.id}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusToolUseId, tools.rows.length > 0]);

  const selectedRow = useMemo(() => all.find((r) => r.key === selected) ?? null, [all, selected]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selected) onSelect(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, onSelect]);

  const totals = useMemo(() => {
    let cost = 0;
    let out = 0;
    for (const r of rows) if (r.kind === 'model') {
      cost += r.ref.costUsd ?? 0;
      out += r.ref.outputTokens;
    }
    return { cost, out };
  }, [rows]);

  // Rows from the same model response as the selection: the model call and
  // every tool call it requested.
  const selectedRequest = selectedRow && selectedRow.kind !== 'hook' ? { id: selectedRow.ref.requestId, agent: selectedRow.agentId } : null;
  const rowClass = useCallback(
    (r: CallRow) => {
      const cls = r.isError ? 'err' : '';
      if (!selectedRequest?.id || r.kind === 'hook' || r.key === selected) return cls;
      return r.ref.requestId === selectedRequest.id && r.agentId === selectedRequest.agent ? `${cls} related` : cls;
    },
    [selectedRequest?.id, selectedRequest?.agent, selected],
  );
  const showTool = useCallback(
    (toolUseId: string) => {
      const t = tools.rows.find((x) => x.toolUseId === toolUseId);
      if (!t) return;
      if (kind !== 'all' && kind !== 'tool') setKind('all');
      onSelect(`t${t.id}`);
    },
    [tools.rows, onSelect, kind],
  );
  const showModelCall = useCallback(
    (requestId: string, agentId: string | null) => {
      const m = requests.rows.find((x) => x.requestId === requestId && x.agentId === agentId);
      if (!m) return;
      if (kind !== 'all' && kind !== 'model') setKind('all');
      onSelect(`m${m.id}`);
    },
    [requests.rows, onSelect, kind],
  );
  const rowKey = useCallback((r: CallRow) => r.key, []);
  const error = requests.error ?? tools.error ?? hooks.error;

  return (
    <div className="pane" style={{ flex: 1 }}>
      <div className="toolbar">
        <SearchField label="Calls" hideLabel placeholder="Filter calls" shortcut="/" value={text} onChange={setText} />
        <SegmentedControl label="Kind" value={kind} onChange={(v) => setKind(v as Kind)} options={KINDS.map((k) => ({ value: k, label: KIND_LABEL[k], count: counts[k] }))} />
        <Switch label="Errors only" on={errorsOnly} onChange={setErrorsOnly} />
        <FilterSelect label="Tool" allLabel="All tools" value={toolName} onChange={setToolName} options={toolNames.map((t) => ({ value: t, label: t }))} />
        {mcpServers.length > 0 && <FilterSelect label="MCP server" allLabel="All MCP servers" value={mcp} onChange={setMcp} options={mcpServers.map((s) => ({ value: s, label: s }))} />}
        {session.subagents.length > 0 && (
          <FilterSelect
            label="Agent"
            allLabel="All agents"
            value={agentFilter === 'all' ? '' : agentFilter}
            onChange={(v) => onAgentFilter(v || 'all')}
            options={[
              { value: 'main', label: 'Main agent only' },
              ...session.subagents.map((s) => ({ value: s.agentId, label: `${s.agentType ?? 'subagent'}: ${s.description ?? s.agentId}` })),
            ]}
          />
        )}
        <span className="spacer" />
        <SortToggle desc={desc} onChange={(d) => (setDesc(d), saveDesc('network', d))} />
      </div>
      {error && <Alert tone="danger" label="Couldn't load calls">{error}</Alert>}
      <Split
        storageKey="calls-detail"
        side="right"
        defaultWidth={Math.round(window.innerWidth * 0.42)}
        min={360}
        pane={
          selectedRow ? (
            <CallDetail
              key={selectedRow.key}
              sessionId={sid}
              row={selectedRow}
              onClose={() => onSelect(null)}
              onShowSubagent={(agentId) => onAgentFilter(agentId)}
              onShowTool={showTool}
              onShowModelCall={showModelCall}
              onOpenRecord={onOpenRecord}
            />
          ) : wide ? (
            <DetailEmpty label="No call selected">Select a row to see its input and output. Use j / k to move.</DetailEmpty>
          ) : null
        }
      >
        <VirtualGrid
          rows={rows}
          columns={columns}
          rowKey={rowKey}
          selected={selected}
          onSelect={onSelect}
          rowClass={rowClass}
          follow={desc ? 'top' : 'bottom'}
          empty={requests.loading ? <Pending loading label="Loading calls" /> : <EmptyState reason={all.length ? 'filtered' : 'empty'} label={all.length ? 'No calls match these filters' : 'No calls in this session'} />}
        />
        <div className="statusbar" style={{ borderTop: '1px solid var(--border)' }}>
          <span>{rows.length.toLocaleString()} / {all.length.toLocaleString()} calls</span>
          <span>{fmtTokens(totals.out)} output tokens</span>
          <span title={COST_NOTE_EST}>{fmtCost(totals.cost)} estimated API cost</span>
        </div>
      </Split>
    </div>
  );
}
