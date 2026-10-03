import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { RecordRow, SessionDetail, SubagentInfo, ToolRow } from '../../shared/types';
import { getJson, useIncremental } from '../api';
import { JsonView } from '../components/JsonView';
import { fmtBytes, fmtMs, fmtTime, pairColor } from '../format';
import { PairChip } from '../components/ToolPair';
import { MessageView } from '../components/MessageView';
import { Why } from '../components/Why';
import { SortToggle, loadDesc, saveDesc } from '../components/SortToggle';
import { DetailEmpty, Split, WIDE, useMediaQuery, useStoredState } from '../components/Layout';
import { Alert, Button, DescriptionList, EmptyState, Pending, SearchField, Switch, Tag } from '@westonkd/sprint';

type Row =
  | { kind: 'record'; key: string; depth: number; rec: RecordRow; inactive: boolean; nested?: boolean }
  | { kind: 'branch'; key: string; depth: number; count: number; open: boolean; prompt: string }
  | { kind: 'subagent'; key: string; depth: number; agent: SubagentInfo; open: boolean };

/**
 * One agent's records. The uuid/parentUuid graph is not a clean tree: hooks,
 * parallel tool calls and reminders hang off the same parent as the main line.
 * So records are shown in file order, the "current" path is traced back from
 * the newest message, and an off-path group only counts as an abandoned branch
 * (a rewind) when it contains a human prompt.
 */
interface Scope {
  ordered: RecordRow[];
  meta: RecordRow[];
  /** off-path record id -> id of the group's first record, for abandoned branches only */
  abandonedGroup: Map<number, number>;
  groups: Map<number, RecordRow[]>;
}

type JumpKind = 'prompt' | 'text' | 'error' | 'large' | 'compaction';

/** Jump bar targets, each with an up key and a down key. */
const JUMP_KINDS: { kind: JumpKind; up: string; down: string; label: string; noun: () => string }[] = [
  { kind: 'prompt', up: 'p', down: 'n', label: 'Prompt', noun: () => 'prompt' },
  { kind: 'text', up: 'T', down: 't', label: 'Assistant text', noun: () => 'assistant message with text' },
  { kind: 'error', up: 'E', down: 'e', label: 'Error', noun: () => 'failed, denied or interrupted tool result' },
  { kind: 'large', up: 'L', down: 'l', label: 'Large record', noun: () => `record of ${fmtBytes(LARGE_RECORD_BYTES)} or more` },
  { kind: 'compaction', up: 'C', down: 'c', label: 'Compaction', noun: () => 'compaction' },
];

/**
 * Jumps move up or down the list as shown (like k / j), so their direction in
 * time depends on the sort order: newest-first puts later records above.
 */
const JUMPS = JUMP_KINDS.flatMap((k) =>
  ([true, false] as const).map((up) => ({
    kind: k.kind,
    key: up ? k.up : k.down,
    up,
    label: k.label,
    dir: (desc: boolean): 1 | -1 => (up === desc ? 1 : -1),
    title: (dir: 1 | -1) => `${dir === 1 ? 'Next' : 'Previous'} ${k.noun()}`,
  })),
);
type PaneTab = 'message' | 'why' | 'raw';
interface FocusTurn {
  agentKey: string;
  /** Id of the turn's prompt record. */
  start: number;
  /** Id of the next prompt (exclusive), or Infinity. */
  end: number;
  prompt: string;
}
/** Raw line size at which a record counts as large (roughly 5k tokens). */
const LARGE_RECORD_BYTES = 20_000;

const ROW_H = 20;
/** Human prompts get a taller row so turns stand out when scanning. */
const PROMPT_ROW_H = 30;

const isHumanPrompt = (r: RecordRow) => r.type === 'user' && !r.toolUseId && !r.isMeta;

function buildScope(records: RecordRow[]): Scope {
  const byUuid = new Map<string, RecordRow>();
  const ordered: RecordRow[] = [];
  const meta: RecordRow[] = [];
  for (const r of records) {
    if (!r.uuid) meta.push(r);
    else if (!byUuid.has(r.uuid)) {
      byUuid.set(r.uuid, r);
      ordered.push(r);
    }
  }
  const parentOf = (r: RecordRow) => {
    const p = r.parentUuid ?? r.logicalParentUuid;
    return p ? byUuid.get(p) : undefined;
  };
  // Current path: ancestors of the newest user/assistant message.
  const onPath = new Set<string>();
  let leaf: RecordRow | undefined;
  for (let i = ordered.length - 1; i >= 0 && !leaf; i--) if (ordered[i].type === 'user' || ordered[i].type === 'assistant') leaf = ordered[i];
  for (let cur = leaf; cur && !onPath.has(cur.uuid!); cur = parentOf(cur)) onPath.add(cur.uuid!);

  // Group off-path records by their divergence point (first off-path ancestor).
  const top = new Map<string, RecordRow>();
  const divergence = (r: RecordRow): RecordRow => {
    const chain: RecordRow[] = [];
    let cur: RecordRow = r;
    let found: RecordRow | undefined;
    for (;;) {
      const cached = top.get(cur.uuid!);
      if (cached) {
        found = cached;
        break;
      }
      chain.push(cur);
      const p = parentOf(cur);
      if (!p || onPath.has(p.uuid!)) {
        found = cur;
        break;
      }
      cur = p;
    }
    for (const c of chain) top.set(c.uuid!, found);
    return found;
  };
  const byGroup = new Map<number, RecordRow[]>();
  for (const r of ordered) {
    if (onPath.has(r.uuid!) || onPath.size === 0) continue;
    const d = divergence(r);
    const arr = byGroup.get(d.id) ?? [];
    arr.push(r);
    byGroup.set(d.id, arr);
  }
  const abandonedGroup = new Map<number, number>();
  const groups = new Map<number, RecordRow[]>();
  for (const [, rs] of byGroup) {
    if (!rs.some(isHumanPrompt)) continue; // side records (hooks, parallel results): show inline
    rs.sort((a, b) => a.id - b.id);
    groups.set(rs[0].id, rs);
    for (const r of rs) abandonedGroup.set(r.id, rs[0].id);
  }
  return { ordered, meta, abandonedGroup, groups };
}

function tagOf(r: RecordRow): { label: string; cls: string } {
  if (r.type === 'assistant' && r.toolUseId) return { label: 'tool call', cls: 'tag-tool' };
  if (r.type === 'user' && r.toolUseId) return { label: '↳ result', cls: 'tag-tool' };
  if (r.type === 'attachment') return { label: r.subtype ?? 'attachment', cls: 'tag-attachment' };
  if (r.type === 'system') return { label: r.subtype ?? 'system', cls: 'tag-system' };
  return { label: r.type, cls: `tag-${r.type}` };
}

/** The parser prefixes result summaries with "[tool_result <status>]"; the row shows status separately. */
const stripResultPrefix = (s: string) => s.replace(/^\[tool_result [^\]]*\]\s*/, '');

interface Props {
  session: SessionDetail;
  focusRecordId: number | null;
  onOpenTool: (toolUseId: string) => void;
}

export function Transcript({ session, focusRecordId, onOpenTool }: Props) {
  const { rows: records, loading, error } = useIncremental<RecordRow>(session.sessionId, 'records');
  const { rows: tools } = useIncremental<ToolRow>(session.sessionId, 'tools');
  const [nest, setNest] = useStoredState('transcript-nest-results', true);
  const [focusTurn, setFocusTurn] = useState<FocusTurn | null>(null);
  const [paneTab, setPaneTab] = useStoredState<PaneTab>('transcript-pane-tab', 'message');
  // Explicit open/closed choices; anything absent uses its default.
  const [openMap, setOpenMap] = useState<Map<string, boolean>>(new Map());
  const [selected, setSelected] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [hideAttachments, setHideAttachments] = useState(false);
  const [desc, setDesc] = useState(() => loadDesc('elements'));
  const wide = useMediaQuery(WIDE);

  const scopes = useMemo(() => {
    const groups = new Map<string, RecordRow[]>();
    for (const r of records) {
      const k = r.agentId ?? '';
      const arr = groups.get(k) ?? [];
      arr.push(r);
      groups.set(k, arr);
    }
    const out = new Map<string, Scope>();
    for (const [k, rs] of groups) out.set(k, buildScope(rs));
    return out;
  }, [records]);

  // Tool calls by the records that hold their tool_use and tool_result blocks.
  const toolsByRecord = useMemo(() => {
    const m = new Map<number, ToolRow[]>();
    const add = (id: number | null, t: ToolRow) => {
      if (id === null) return;
      const arr = m.get(id) ?? [];
      arr.push(t);
      m.set(id, arr);
    };
    for (const t of tools) {
      add(t.useRecordId, t);
      if (t.resultRecordId !== t.useRecordId) add(t.resultRecordId, t);
    }
    return m;
  }, [tools]);

  // Result record id -> the one call record it answers. A record answering
  // several calls (parallel results in one message) stays where it is.
  const resultParent = useMemo(() => {
    const m = new Map<number, number>();
    for (const [recId, ts] of toolsByRecord) {
      const parents = new Set(ts.filter((t) => t.resultRecordId === recId && t.useRecordId !== null && t.useRecordId < recId).map((t) => t.useRecordId!));
      if (parents.size === 1) m.set(recId, [...parents][0]);
    }
    return m;
  }, [toolsByRecord]);

  const subagentByToolUse = useMemo(() => {
    const m = new Map<string, SubagentInfo>();
    for (const s of session.subagents) if (s.toolUseId) m.set(s.toolUseId, s);
    return m;
  }, [session.subagents]);

  const recordById = useMemo(() => new Map(records.map((r) => [r.id, r] as const)), [records]);

  /** Select a record and open whatever contains it (subagent, branch, metadata). */
  const reveal = useCallback(
    (id: number) => {
      const rec = recordById.get(id);
      setSelected(id);
      if (!rec) return;
      setOpenMap((m) => {
        const next = new Map(m);
        if (rec.agentId) next.set(`a:${rec.agentId}`, true);
        const g = scopes.get(rec.agentId ?? '')?.abandonedGroup.get(rec.id);
        if (g !== undefined) next.set(`b:${g}`, true);
        return next;
      });
    },
    [recordById, scopes],
  );

  /** The turn containing a record: from its prompt up to the next prompt, within one agent. */
  const turnOf = useCallback(
    (rec: RecordRow): FocusTurn | null => {
      const ordered = scopes.get(rec.agentId ?? '')?.ordered ?? [];
      let start: RecordRow | undefined;
      let end = Number.POSITIVE_INFINITY;
      for (const r of ordered) {
        if (!isHumanPrompt(r)) continue;
        if (r.id <= rec.id) start = r;
        else {
          end = r.id;
          break;
        }
      }
      return start ? { agentKey: rec.agentId ?? '', start: start.id, end, prompt: start.summary } : null;
    },
    [scopes],
  );

  // Arriving from another panel ("Show in Transcript"): open the record and
  // focus its turn, dimming the rest.
  useEffect(() => {
    if (!focusRecordId) return;
    const rec = recordById.get(focusRecordId);
    if (!rec) return;
    reveal(rec.id);
    setFocusTurn(turnOf(rec));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRecordId, records.length > 0]);

  const outsideFocus = (r: RecordRow) =>
    focusTurn !== null && (r.agentId ?? '') === focusTurn.agentKey && (r.id < focusTurn.start || r.id >= focusTurn.end);

  // Jumps between significant events, in time order within the selected record's agent.
  const jump = useCallback(
    (kind: JumpKind, dir: 1 | -1) => {
      const cur = selected === null ? undefined : recordById.get(selected);
      const ordered = scopes.get(cur?.agentId ?? '')?.ordered ?? [];
      const from = cur?.id ?? (dir === 1 ? 0 : Number.POSITIVE_INFINITY);
      const isError = (r: RecordRow) =>
        r.type === 'user' && (toolsByRecord.get(r.id) ?? []).some((t) => t.status === 'error' || t.status === 'denied' || t.status === 'interrupted');
      const match: Record<JumpKind, (r: RecordRow) => boolean> = {
        prompt: isHumanPrompt,
        text: (r) => r.type === 'assistant' && !r.toolUseId && !r.summary.startsWith('[thinking') && r.summary.trim() !== '',
        error: isError,
        large: (r) => r.bytes >= LARGE_RECORD_BYTES,
        compaction: (r) => r.type === 'system' && r.subtype === 'compact_boundary',
      };
      const list = dir === 1 ? ordered : [...ordered].reverse();
      const hit = list.find((r) => (dir === 1 ? r.id > from : r.id < from) && match[kind](r));
      if (hit) reveal(hit.id);
    },
    [selected, recordById, scopes, toolsByRecord, reveal],
  );

  const flat = useMemo(() => {
    const q = text.trim().toLowerCase();
    const visible = (r: RecordRow) =>
      (!hideAttachments || r.type !== 'attachment') && (!q || r.summary.toLowerCase().includes(q) || r.type.includes(q) || (r.subtype ?? '').includes(q));

    // A chunk is a record plus anything nested under it (a subagent), or a
    // whole abandoned branch. Newest-first reverses chunks, not their insides.
    const recordChunk = (r: RecordRow, depth: number, inactive: boolean, nestedResults: RecordRow[] = []): Row[] => {
      const out: Row[] = [];
      if (visible(r)) out.push({ kind: 'record', key: `r${r.id}`, depth, rec: r, inactive });
      for (const x of nestedResults) if (visible(x)) out.push({ kind: 'record', key: `r${x.id}`, depth: depth + 1, rec: x, inactive, nested: true });
      const sub = r.toolUseId && r.type === 'assistant' ? subagentByToolUse.get(r.toolUseId) : undefined;
      if (sub) {
        const key = `a:${sub.agentId}`;
        const open = openMap.get(key) ?? false;
        out.push({ kind: 'subagent', key, depth: depth + 1, agent: sub, open });
        if (open) out.push(...walkScope(sub.agentId, depth + 2));
      }
      return out;
    };

    const walkScope = (agentKey: string, depth: number): Row[] => {
      const scope = scopes.get(agentKey);
      if (!scope) return [];
      // Records without a uuid are session state (title, mode, cost, …); they
      // live in the Session panel, not in the conversation tree.
      const head: Row[] = [];
      // With nesting on, a result moves under its call when both sit in the
      // same group (main line, or the same abandoned branch).
      const nestedUnder = new Map<number, RecordRow[]>();
      const moved = new Set<number>();
      if (nest) {
        const byId = new Map(scope.ordered.map((r) => [r.id, r] as const));
        for (const r of scope.ordered) {
          const p = resultParent.get(r.id);
          if (p === undefined || !byId.has(p) || scope.abandonedGroup.get(p) !== scope.abandonedGroup.get(r.id)) continue;
          const arr = nestedUnder.get(p) ?? [];
          arr.push(r);
          nestedUnder.set(p, arr);
          moved.add(r.id);
        }
      }
      const chunks: Row[][] = [];
      for (const r of scope.ordered) {
        if (moved.has(r.id)) continue;
        const g = scope.abandonedGroup.get(r.id);
        if (g === undefined) {
          chunks.push(recordChunk(r, depth, false, nestedUnder.get(r.id)));
          continue;
        }
        if (g !== r.id) continue; // rendered with its group
        const rs = scope.groups.get(g)!;
        const key = `b:${g}`;
        const open = openMap.get(key) ?? false;
        const prompt = rs.find(isHumanPrompt)?.summary ?? '';
        const chunk: Row[] = [{ kind: 'branch', key, depth, count: rs.length, open, prompt }];
        if (open) {
          const inner = rs.filter((x) => !moved.has(x.id)).map((x) => recordChunk(x, depth + 1, true, nestedUnder.get(x.id)));
          if (desc) inner.reverse();
          for (const c of inner) chunk.push(...c);
        }
        chunks.push(chunk);
      }
      if (desc) chunks.reverse();
      return [...head, ...chunks.flat()];
    };

    return walkScope('', 0);
  }, [scopes, openMap, text, hideAttachments, subagentByToolUse, desc, nest, resultParent]);

  // The selected record's partners: its call's result, or its result's call.
  const related = useMemo(() => {
    const out = new Set<number>();
    if (selected === null) return out;
    for (const t of toolsByRecord.get(selected) ?? []) {
      if (t.useRecordId !== null && t.useRecordId !== selected) out.add(t.useRecordId);
      if (t.resultRecordId !== null && t.resultRecordId !== selected) out.add(t.resultRecordId);
    }
    return out;
  }, [selected, toolsByRecord]);

  const toggle = (key: string, currentlyOpen: boolean) =>
    setOpenMap((m) => new Map(m).set(key, !currentlyOpen));

  const scrollRef = useRef<HTMLDivElement>(null);
  const rowHeight = useCallback(
    (i: number) => {
      const r = flat[i];
      return r?.kind === 'record' && isHumanPrompt(r.rec) ? PROMPT_ROW_H : ROW_H;
    },
    [flat],
  );
  // Row heights vary, and the virtualizer only recomputes positions when its
  // key function changes, so key by row and rebuild it with the list.
  const rowKeyAt = useCallback((i: number) => flat[i]?.key ?? i, [flat]);
  const v = useVirtualizer({ count: flat.length, getScrollElement: () => scrollRef.current, estimateSize: rowHeight, getItemKey: rowKeyAt, overscan: 30 });
  const prevLen = useRef(0);
  const atTop = useRef(true);
  useLayoutEffect(() => {
    const added = flat.length - prevLen.current;
    const el = scrollRef.current;
    if (desc && added > 0 && el && prevLen.current > 0 && !atTop.current) {
      let h = 0;
      for (let i = 0; i < added; i++) h += rowHeight(i);
      el.scrollTop += h;
    }
    prevLen.current = flat.length;
  }, [flat.length, desc]);
  const selIndex = selected === null ? -1 : flat.findIndex((r) => r.kind === 'record' && r.rec.id === selected);
  useEffect(() => {
    if (selIndex >= 0) v.scrollToIndex(selIndex, { align: 'center' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selIndex >= 0 ? flat[selIndex].key : null]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT')) return;
      if (e.key === 'Escape') return setSelected(null);
      const hit = !e.metaKey && !e.ctrlKey && !e.altKey && JUMPS.find((j) => j.key === e.key);
      if (hit) {
        e.preventDefault();
        return jump(hit.kind, hit.dir(desc));
      }
      if (e.key !== 'j' && e.key !== 'k' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const down = e.key === 'j' || e.key === 'ArrowDown';
      const recRows = flat.map((r, i) => [r, i] as const).filter(([r]) => r.kind === 'record');
      if (!recRows.length) return;
      const pos = recRows.findIndex(([, i]) => i === selIndex);
      const next = pos < 0 ? (down ? 0 : recRows.length - 1) : Math.max(0, Math.min(recRows.length - 1, pos + (down ? 1 : -1)));
      const row = recRows[next][0];
      if (row.kind === 'record') setSelected(row.rec.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flat, selIndex, jump, desc]);

  return (
    <div className="pane" style={{ flex: 1 }}>
      <div className="toolbar">
        <SearchField label="Transcript records" hideLabel placeholder="Filter records" shortcut="/" value={text} onChange={setText} />
        <Switch label="Hide attachments" on={hideAttachments} onChange={setHideAttachments} />
        <Switch label="Nest results under calls" on={nest} onChange={setNest} />
        <span className="muted">
          {records.length.toLocaleString()} records{session.subagents.length ? `, ${session.subagents.length} subagents` : ''}
        </span>
        <span className="spacer" />
        <SortToggle desc={desc} onChange={(d) => (setDesc(d), saveDesc('elements', d))} />
      </div>
      {error && <Alert tone="danger" label="Couldn't load the transcript">{error}</Alert>}
      {(selected !== null || focusTurn) && (
        <div className="toolbar jumpbar">
          <span className="muted">Jump</span>
          {JUMPS.map((j) => {
            const dir = j.dir(desc);
            return (
              <Button key={j.key} agentTool={false} onClick={() => jump(j.kind, dir)} title={j.title(dir)}>
                {j.up ? '↑' : '↓'} {j.label} <kbd className="key">{j.key === j.key.toLowerCase() ? j.key : `⇧${j.key.toLowerCase()}`}</kbd>
              </Button>
            );
          })}
          <span className="spacer" />
          {focusTurn && (
            <span className="focus-chip" title={focusTurn.prompt}>
              <span className="muted">Focused on turn:</span> <span className="focus-prompt">{focusTurn.prompt}</span>
              <Button agentTool={false} onClick={() => setFocusTurn(null)}>
                Show all turns
              </Button>
            </span>
          )}
        </div>
      )}
      <Split
        storageKey="transcript-detail"
        side="right"
        defaultWidth={Math.round(window.innerWidth * 0.42)}
        min={360}
        pane={
          selected !== null ? (
            <RecordPane
              sessionId={session.sessionId}
              recordId={selected}
              tab={paneTab}
              onTab={setPaneTab}
              tools={toolsByRecord.get(selected) ?? []}
              onClose={() => setSelected(null)}
              onJump={reveal}
              onOpenTool={onOpenTool}
            />
          ) : wide ? (
            <DetailEmpty label="No record selected">Select a record to read it and see why it happened. j / k move, n / p jump between prompts.</DetailEmpty>
          ) : null
        }
      >
        <div className="grid" ref={scrollRef} tabIndex={0} onScroll={(e) => (atTop.current = e.currentTarget.scrollTop < 40)}>
          {flat.length === 0 &&
            (loading ? <Pending loading label="Loading transcript" /> : <EmptyState reason={text || hideAttachments ? 'filtered' : 'empty'} label="No matching records" />)}
          <div style={{ height: v.getTotalSize(), position: 'relative' }}>
            {v.getVirtualItems().map((vi) => {
              const row = flat[vi.index];
              const style = { position: 'absolute' as const, top: 0, left: 0, right: 0, transform: `translateY(${vi.start}px)`, paddingLeft: 6 + row.depth * 14 };
              if (row.kind === 'branch')
                return (
                  <div key={row.key} className="tree-row branch" style={style} onClick={() => toggle(row.key, row.open)}>
                    <span className="twisty">{row.open ? '▾' : '▸'}</span>
                    <span className="sum">
                      Abandoned branch (rewind) · {row.count} records · {row.prompt}
                    </span>
                  </div>
                );
              if (row.kind === 'subagent')
                return (
                  <div key={row.key} className="tree-row" style={style} onClick={() => toggle(row.key, row.open)}>
                    <span className="twisty">{row.open ? '▾' : '▸'}</span>
                    <Tag tone="inert">{row.agent.agentType ?? 'subagent'}</Tag>
                    <span className="sum">
                      {row.agent.description ?? row.agent.agentId} ({row.agent.recordCount} records)
                    </span>
                  </div>
                );
              const r = row.rec;
              const tag = tagOf(r);
              const isCompact = r.type === 'system' && r.subtype === 'compact_boundary';
              // In a subagent's transcript the first "user" message is the
              // prompt the parent agent wrote, not a person.
              const prompt = isHumanPrompt(r) ? (r.agentId ? 'agent' : 'human') : null;
              const pairs = toolsByRecord.get(r.id) ?? [];
              const isResult = r.type === 'user' && pairs.length > 0;
              // A result row shows its call's status; a call row shows it too, so a failed call is visible without expanding.
              const status = pairs.length === 1 ? pairs[0].status : null;
              return (
                <div
                  key={row.key}
                  className={`tree-row ${isCompact ? 'divider' : ''} ${prompt ? `prompt prompt-${prompt}` : ''} ${r.id === selected ? 'sel' : ''} ${related.has(r.id) ? 'related' : ''} ${row.inactive ? 'inactive' : ''} ${outsideFocus(r) ? 'dim' : ''}`}
                  style={{ ...style, ...(pairs.length === 1 ? { '--pair': pairColor(pairs[0].toolUseId) } : {}) } as React.CSSProperties}
                  onClick={() => setSelected(r.id)}
                >
                  <span className="twisty" />
                  {prompt ? (
                    <Tag tone={prompt === 'human' ? 'info' : 'inert'} filled={prompt === 'human'} className="prompt-tag">
                      {prompt === 'human' ? 'You' : 'Agent prompt'}
                    </Tag>
                  ) : (
                    <span className={`tag ${tag.cls}`}>{isCompact ? '── compaction' : tag.label}</span>
                  )}
                  {pairs.map((t) => (
                    <PairChip key={t.toolUseId} toolUseId={t.toolUseId} name={isResult && row.nested ? undefined : t.name} />
                  ))}
                  {status && status !== 'ok' && <span className={`status-${status}`}>{status}</span>}
                  <span className="sum">{isResult ? stripResultPrefix(r.summary) : r.summary}</span>
                  <span className="when">{fmtBytes(r.bytes)}</span>
                  <span className="when">{fmtTime(r.ts)}</span>
                </div>
              );
            })}
          </div>
        </div>
      </Split>
    </div>
  );
}

function RecordPane({
  sessionId,
  recordId,
  tab,
  onTab,
  tools,
  onClose,
  onJump,
  onOpenTool,
}: {
  sessionId: string;
  recordId: number;
  tab: PaneTab;
  onTab: (t: PaneTab) => void;
  tools: ToolRow[];
  onClose: () => void;
  onJump: (recordId: number) => void;
  onOpenTool: (toolUseId: string) => void;
}) {
  const [data, setData] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [whyIndex, setWhyIndex] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    setWhyIndex(0);
    getJson(`/api/records/${recordId}/raw`)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(String(e.message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [recordId]);
  // Why only applies to tool calls and results; elsewhere fall back to the message.
  const tabs: PaneTab[] = tools.length ? ['message', 'why', 'raw'] : ['message', 'raw'];
  const shown: PaneTab = tabs.includes(tab) ? tab : 'message';
  const whyTool = tools[Math.min(whyIndex, tools.length - 1)];

  let body: React.ReactNode;
  if (shown === 'why' && whyTool) {
    body = (
      <>
        {tools.length > 1 && (
          <div className="pair-box-head">
            {tools.map((t, i) => (
              <button key={t.toolUseId} className={`chip ${i === whyIndex ? 'on' : ''}`} onClick={() => setWhyIndex(i)}>
                <PairChip toolUseId={t.toolUseId} name={t.name} />
              </button>
            ))}
          </div>
        )}
        <Why sessionId={sessionId} toolUseId={whyTool.toolUseId} onOpenRecord={onJump} version={whyTool.status} />
      </>
    );
  } else if (error) body = <Alert tone="danger" label="Couldn't load this record">{error}</Alert>;
  else if (data === null) body = <Pending loading label="Loading record" />;
  else if (shown === 'raw') body = <JsonView value={data} defaultOpen={3} />;
  else
    body = (
      <>
        {tools.map((t) => {
          const isCall = t.useRecordId === recordId;
          const partner = isCall ? t.resultRecordId : t.useRecordId;
          return (
            <div key={t.toolUseId} className="pair-box" style={{ '--pair': pairColor(t.toolUseId) } as React.CSSProperties}>
              <div className="pair-box-head">
                <PairChip toolUseId={t.toolUseId} name={t.name} />
                <span className={`status-${t.status}`}>{t.status}{t.denialKind ? ` (${t.denialKind})` : ''}</span>
                {t.durationMs !== null && <span className="muted">{fmtMs(t.durationMs)}</span>}
                <span className="spacer" />
                {partner !== null ? (
                  <Button agentTool={false} onClick={() => onJump(partner)}>
                    {isCall ? 'Go to result' : 'Go to call'}
                  </Button>
                ) : (
                  <span className="muted">{isCall ? 'No result recorded' : 'Call not in this transcript'}</span>
                )}
                <Button agentTool={false} onClick={() => onTab('why')}>
                  Why?
                </Button>
                <Button agentTool={false} onClick={() => onOpenTool(t.toolUseId)}>
                  Open in Calls
                </Button>
              </div>
            </div>
          );
        })}
        <MessageView raw={data} />
      </>
    );

  return (
    <div className="pane detail">
      <div className="detail-head">
        <button className="close" onClick={onClose} title="Close (Esc)">×</button>
        {tabs.map((t) => (
          <button key={t} className={`tab ${shown === t ? 'on' : ''}`} onClick={() => onTab(t)}>
            {t === 'message' ? 'Message' : t === 'why' ? 'Why' : 'Raw'}
          </button>
        ))}
      </div>
      <div className="detail-body">{body}</div>
    </div>
  );
}
