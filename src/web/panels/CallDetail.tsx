import { useEffect, useState, type ReactNode } from 'react';
import type { RequestDetail, ToolCallDetail } from '../../shared/types';
import { getJson } from '../api';
import { Alert, Button, DescriptionList, Pending } from '@westonkd/sprint';
import { PairChip } from '../components/ToolPair';
import { Why } from '../components/Why';
import { JsonView } from '../components/JsonView';
import { CodeView, Diff, PersistedOutput, Terminal, resultText } from '../components/Renderers';
import { fmtCost, fmtDateTime, fmtInt, fmtMs } from '../format';
import type { CallRow } from './Calls';

/* eslint-disable @typescript-eslint/no-explicit-any */

// Input/Output rather than Request/Response: only model calls are HTTP requests,
// and even for those the transcript holds the output, not the request body.
type Tab = 'input' | 'output' | 'why' | 'raw';

const TAB_LABEL: Record<Tab, string> = { input: 'Input', output: 'Output', why: 'Why', raw: 'Raw' };

interface Props {
  sessionId: string;
  row: CallRow;
  onClose: () => void;
  onShowSubagent: (agentId: string) => void;
  onOpenRecord: (recordId: number) => void;
  /** Select a tool call row by its tool_use id. */
  onShowTool: (toolUseId: string) => void;
  /** Select the model call row that requested a tool call. */
  onShowModelCall: (requestId: string, agentId: string | null) => void;
}

function useFetch<T>(url: string | null, dep: unknown) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    setError(null);
    getJson<T>(url)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(String(e.message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [url, dep]);
  return { data, error };
}

export function CallDetail({ sessionId, row, onClose, onShowSubagent, onOpenRecord, onShowTool, onShowModelCall }: Props) {
  const [tab, setTab] = useState<Tab>(row.kind === 'hook' ? 'raw' : 'output');
  const sid = encodeURIComponent(sessionId);
  // Refetch when a pending tool call gets its result.
  const version = row.kind === 'tool' ? `${row.ref.status}:${row.ref.resultRecordId}` : row.kind === 'model' ? row.ref.blockCount : 0;
  const url =
    row.kind === 'tool'
      ? `/api/sessions/${sid}/tool-calls/${encodeURIComponent(row.ref.toolUseId)}`
      : row.kind === 'model'
        ? `/api/sessions/${sid}/requests/${row.ref.id}`
        : `/api/records/${row.ref.recordId}/raw`;
  const { data, error } = useFetch<any>(url, version);

  let body: ReactNode = null;
  if (error) body = <Alert tone="danger" label="Couldn't load this call">{error}</Alert>;
  else if (!data) body = <Pending loading label="Loading call" />;
  else if (row.kind === 'tool' && tab === 'why')
    body = <Why sessionId={sessionId} toolUseId={row.ref.toolUseId} onOpenRecord={onOpenRecord} version={version} />;
  else if (row.kind === 'tool') body = <ToolDetail tab={tab} d={data as ToolCallDetail} sessionId={sessionId} onShowSubagent={onShowSubagent} onOpenRecord={onOpenRecord} onShowModelCall={onShowModelCall} />;
  else if (row.kind === 'model') body = <ModelDetail tab={tab} d={data as RequestDetail} onOpenRecord={onOpenRecord} onShowTool={onShowTool} />;
  else body = <HookDetail tab={tab} raw={data} row={row} />;

  return (
    <div className="pane detail">
      <div className="detail-head">
        <button className="close" onClick={onClose} title="Close (Esc)">
          ×
        </button>
        {((row.kind === 'tool' ? ['input', 'output', 'why', 'raw'] : ['input', 'output', 'raw']) as Tab[]).map((t) => (
          <button key={t} className={`tab ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>
      <div className="detail-body">{body}</div>
    </div>
  );
}

function KV({ label, items }: { label: string; items: Array<[string, ReactNode]> }) {
  return (
    <DescriptionList
      label={label}
      className="kv"
      items={items.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([term, description]) => ({ term, description }))}
    />
  );
}

function ToolDetail({
  tab,
  d,
  sessionId,
  onShowSubagent,
  onOpenRecord,
  onShowModelCall,
}: {
  tab: Tab;
  d: ToolCallDetail;
  sessionId: string;
  onShowSubagent: (a: string) => void;
  onOpenRecord: (id: number) => void;
  onShowModelCall: (requestId: string, agentId: string | null) => void;
}) {
  const t = d.tool;
  const input = d.input as any;
  const s = d.structured as any;
  const header = (
    <>
      <div className="pair-box-head">
        <PairChip toolUseId={t.toolUseId} name={t.name} />
        <span className="muted">same colour and id mark this call and its result in Transcript</span>
      </div>
      <div className="row-actions" style={{ justifyContent: 'flex-start', marginBottom: 8, flexWrap: 'wrap' }}>
        {t.requestId && <Button onClick={() => onShowModelCall(t.requestId!, t.agentId)}>Show requesting model call</Button>}
        {t.useRecordId && <Button onClick={() => onOpenRecord(t.useRecordId!)}>Show call in Transcript</Button>}
        {t.resultRecordId && <Button onClick={() => onOpenRecord(t.resultRecordId!)}>Show result in Transcript</Button>}
      </div>
    <KV label="Tool call"
      items={[
        ['Tool', t.name],
        ['MCP server', t.mcpServer],
        ['Status', <span className={`status-${t.status}`}>{t.status}{t.denialKind ? ` (${t.denialKind})` : ''}</span>],
        ['Duration', fmtMs(t.durationMs)],
        ['Started', fmtDateTime(t.startTs)],
        ['Tool use id', t.toolUseId],
        ['Subagent', t.agentId],
      ]}
    />
    </>
  );

  if (tab === 'raw') {
    return (
      <>
        {header}
        <div className="section-title">tool_use input</div>
        <JsonView value={d.input} defaultOpen={3} />
        <div className="section-title">tool_result</div>
        <JsonView value={d.result} defaultOpen={2} />
        <div className="section-title">toolUseResult</div>
        <JsonView value={d.structured} defaultOpen={2} />
      </>
    );
  }

  if (tab === 'input') {
    let main: ReactNode = <JsonView value={d.input} defaultOpen={3} />;
    if (t.name === 'Bash' && input?.command) {
      main = (
        <>
          {input.description && <div className="muted" style={{ marginBottom: 4 }}>{input.description}</div>}
          <pre className="terminal">$ {input.command}</pre>
          <div className="section-title">Input</div>
          <JsonView value={d.input} defaultOpen={1} />
        </>
      );
    } else if ((t.name === 'Agent' || t.name === 'Task') && input?.prompt) {
      main = (
        <>
          <KV label="Subagent input" items={[['Type', input.subagent_type], ['Description', input.description], ['Model', input.model]]} />
          <div className="section-title">Prompt</div>
          <pre className="block">{input.prompt}</pre>
        </>
      );
    }
    return (
      <>
        {header}
        {main}
      </>
    );
  }

  // Output
  const text = resultText(d.result);
  let main: ReactNode;
  if (!d.result && t.status === 'pending') main = <div className="muted">No result yet. The call may still be running, or the session ended before it returned.</div>;
  else if (t.name === 'Bash' && s && (typeof s.stdout === 'string' || typeof s.stderr === 'string')) {
    main = (
      <>
        {s.interrupted && <Alert tone="danger" label="Interrupted">The command was interrupted before it finished.</Alert>}
        {s.returnCodeInterpretation && <Alert tone="warning" label="Exit code">{s.returnCodeInterpretation}</Alert>}
        {s.stdout || s.stderr ? <Terminal stdout={s.stdout} stderr={s.stderr} /> : <Terminal stdout={text} />}
      </>
    );
  } else if ((t.name === 'Edit' || t.name === 'MultiEdit' || t.name === 'Write') && s && Array.isArray(s.structuredPatch) && s.structuredPatch.length) {
    main = (
      <>
        <div className="mono" style={{ marginBottom: 4 }}>{s.filePath}</div>
        <Diff hunks={s.structuredPatch} />
      </>
    );
  } else if (t.name === 'Write' && s && typeof s.content === 'string') {
    main = (
      <>
        <div className="mono" style={{ marginBottom: 4 }}>{s.filePath} <span className="muted">({s.type ?? 'write'})</span></div>
        <Diff hunks={[{ oldStart: 0, oldLines: 0, newStart: 1, newLines: s.content.split('\n').length, lines: s.content.split('\n').map((l: string) => '+' + l) }]} />
      </>
    );
  } else if (t.name === 'Read' && s?.file && typeof s.file.content === 'string') {
    main = (
      <>
        <div className="mono" style={{ marginBottom: 4 }}>
          {s.file.filePath}{' '}
          <span className="muted">
            {s.file.numLines !== undefined ? `lines ${s.file.startLine ?? 1}–${(s.file.startLine ?? 1) + s.file.numLines - 1}` : ''}
            {s.file.totalLines ? ` of ${s.file.totalLines}` : ''}
          </span>
        </div>
        <CodeView text={s.file.content} startLine={s.file.startLine ?? 1} />
      </>
    );
  } else if ((t.name === 'Agent' || t.name === 'Task') && (s || text)) {
    main = (
      <>
        <KV label="Subagent result" items={[['Status', s?.status], ['Model', s?.resolvedModel], ['Agent id', s?.agentId], ['Async', s?.isAsync === undefined ? null : String(s.isAsync)]]} />
        {t.subagentId && (
          <Button onClick={() => onShowSubagent(t.subagentId!)} style={{ marginBottom: 8 }}>
            Show this subagent's calls
          </Button>
        )}
        <pre className="block">{text}</pre>
      </>
    );
  } else {
    main = text ? <pre className="block">{text}</pre> : <JsonView value={d.structured ?? d.result} defaultOpen={2} />;
  }
  return (
    <>
      {header}
      {d.result && (d.result as any).is_error && t.status === 'error' && <Alert tone="danger" label="Tool error">The tool returned an error result.</Alert>}
      {main}
      {d.persistedOutput && <PersistedOutput sessionId={sessionId} path={d.persistedOutput.path} size={d.persistedOutput.size} />}
    </>
  );
}

function ModelDetail({ tab, d, onOpenRecord, onShowTool }: { tab: Tab; d: RequestDetail; onOpenRecord: (id: number) => void; onShowTool: (toolUseId: string) => void }) {
  const r = d.request;
  if (tab === 'raw') {
    return (
      <>
        {d.blocks.map((b) => (
          <div key={b.recordId} style={{ marginBottom: 8 }}>
            <JsonView value={b.raw} defaultOpen={2} />
          </div>
        ))}
      </>
    );
  }
  if (tab === 'input') {
    const hit = r.contextTokens > 0 ? r.cacheReadTokens / r.contextTokens : null;
    const inputRaw = d.input?.raw as any;
    const inputContent = inputRaw?.message?.content;
    return (
      <>
        <KV label="Model call"
          items={[
            ['Model', r.model],
            ['Effort', r.effort],
            ['Speed', r.speed],
            ['API request id', r.requestId],
            ['Agent', r.agentId ? `subagent ${r.agentId}` : 'main'],
            ['Started', fmtDateTime(r.ts)],
            ['Duration (est.)', fmtMs(r.latencyMs)],
            ['Stop reason', r.stopReason],
          ]}
        />
        <div className="section-title">Tokens</div>
        <KV label="Token usage"
          items={[
            ['Input (uncached)', fmtInt(r.inputTokens)],
            ['Cache read', fmtInt(r.cacheReadTokens)],
            ['Cache write 5m', fmtInt(r.cacheWrite5mTokens)],
            ['Cache write 1h', fmtInt(r.cacheWrite1hTokens)],
            ['Context total', fmtInt(r.contextTokens)],
            ['Cache hit ratio', hit === null ? '' : `${(hit * 100).toFixed(1)}%`],
            ['Output', fmtInt(r.outputTokens)],
            ['Thinking (of output)', fmtInt(r.thinkingTokens)],
            ['Estimated API cost', fmtCost(r.costUsd)],
          ]}
        />
        <div className="section-title">
          Last input record{' '}
          {d.input && (
            <Button onClick={() => onOpenRecord(d.input!.recordId)}>Show in Transcript</Button>
          )}
        </div>
        <div className="muted" style={{ marginBottom: 4 }}>The transcript doesn't store the full prompt; this is the newest record it included.</div>
        {!d.input ? (
          <div className="muted">No parent record found.</div>
        ) : typeof inputContent === 'string' ? (
          <pre className="block">{inputContent}</pre>
        ) : (
          <JsonView value={inputContent ?? inputRaw} defaultOpen={2} />
        )}
      </>
    );
  }
  // Output: the assistant message's content blocks, in order.
  const blocks = d.blocks.flatMap((b) => ((b.raw as any)?.message?.content ?? []) as any[]);
  return (
    <>
      {blocks.length === 0 && <div className="muted">No content blocks.</div>}
      {blocks.map((b, i) => {
        if (b?.type === 'text') return <pre key={i} className="block" style={{ marginBottom: 6 }}>{b.text}</pre>;
        if (b?.type === 'thinking' || b?.type === 'redacted_thinking')
          return (
            <div key={i} style={{ marginBottom: 6 }}>
              <div className="section-title">Thinking</div>
              {b.thinking ? <pre className="block muted">{b.thinking}</pre> : <div className="muted">(not returned by the API)</div>}
            </div>
          );
        if (b?.type === 'tool_use')
          return (
            <div key={i} style={{ marginBottom: 6 }}>
              <div className="section-title pair-box-head">
                <span className="type-tool">tool_use</span>
                {typeof b.id === 'string' ? <PairChip toolUseId={b.id} name={b.name} /> : b.name}
                {typeof b.id === 'string' && (
                  <Button agentTool={false} onClick={() => onShowTool(b.id)}>
                    Show call and result
                  </Button>
                )}
              </div>
              <JsonView value={b.input} defaultOpen={2} />
            </div>
          );
        return <JsonView key={i} value={b} />;
      })}
    </>
  );
}

function HookDetail({ tab, raw, row }: { tab: Tab; raw: any; row: CallRow }) {
  if (row.kind !== 'hook') return null;
  const h = row.ref;
  const a = raw?.attachment ?? {};
  const head = (
    <KV label="Hook run"
      items={[
        ['Hook', h.hookName],
        ['Event', h.hookEvent],
        ['Command', h.command],
        ['Exit code', h.exitCode === null ? '' : String(h.exitCode)],
        ['Duration', fmtMs(h.durationMs)],
        ['When', fmtDateTime(h.ts)],
      ]}
    />
  );
  if (tab === 'raw') return <>{head}<JsonView value={raw} defaultOpen={3} /></>;
  if (tab === 'input') return <>{head}<pre className="terminal">$ {h.command ?? ''}</pre></>;
  const stdout = typeof a.stdout === 'string' ? a.stdout : typeof a.content === 'string' ? a.content : '';
  return (
    <>
      {head}
      <Terminal stdout={stdout} stderr={typeof a.stderr === 'string' ? a.stderr : ''} />
    </>
  );
}
