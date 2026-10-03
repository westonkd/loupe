import { useEffect, useState, type ReactNode } from 'react';
import { Alert, Pending } from '@westonkd/sprint';
import type { WhyView } from '../../shared/types';
import { getJson } from '../api';
import { fmtBytes, fmtTime, shortModel } from '../format';
import { LongText } from './MessageView';
import { PairChip } from './ToolPair';

interface Props {
  sessionId: string;
  toolUseId: string;
  onOpenRecord: (recordId: number) => void;
  /** Bump to refetch (e.g. when the call gets its result). */
  version?: unknown;
}

const firstLine = (s: string) => s.trim().split('\n').find((l) => l.trim()) ?? '';

/** One step: a single summary line that opens to show the detail. */
function Step({ title, summary, defaultOpen = false, children }: { title: string; summary: ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`why-step ${open ? 'open' : ''}`}>
      <button className="why-line" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="twisty">{open ? '▾' : '▸'}</span>
        <span className="why-title">{title}</span>
        <span className="why-summary">{summary}</span>
      </button>
      {open && <div className="why-body">{children}</div>}
    </section>
  );
}

const link = (label: string, onClick: () => void) => (
  <button className="link-btn" onClick={onClick}>
    {label}
  </button>
);

/**
 * Why a tool call happened, as four one-line steps in the order the model saw
 * them. Only "Wrote" (the model's own words, the actual why) starts open.
 */
export function Why({ sessionId, toolUseId, onOpenRecord, version }: Props) {
  const [data, setData] = useState<WhyView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    getJson<WhyView>(`/api/sessions/${encodeURIComponent(sessionId)}/why/${encodeURIComponent(toolUseId)}`)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(String(e.message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [sessionId, toolUseId, version]);

  if (error) return <Alert tone="danger" label="Couldn't load the explanation">{error}</Alert>;
  if (!data || data.tool.toolUseId !== toolUseId) return <Pending loading label="Gathering context for this call" />;
  const w = data;

  const reasoning = w.modelCall?.blocks.filter((b) => b.kind !== 'tool_use') ?? [];
  const firstText = reasoning.find((b) => b.kind === 'text' && b.text?.trim())?.text;
  const firstThinking = reasoning.find((b) => b.kind === 'thinking' && b.text?.trim())?.text;
  const wroteSummary = firstText
    ? `"${firstLine(firstText)}"`
    : firstThinking
      ? `(thinking) ${firstLine(firstThinking)}`
      : w.earlierText
        ? `(earlier) "${firstLine(w.earlierText.text)}"`
        : 'no visible text';

  const received = w.before.filter((b) => !b.isPrompt);
  const receivedSummary =
    received.length === 0
      ? 'nothing new since its previous model call'
      : received
          .slice(-3)
          .reverse()
          .map((b) => `${b.toolName ? `${b.toolName} result` : (b.subtype ?? b.type)}${b.contentBytes ? ` ${fmtBytes(b.contentBytes)}` : ''}`)
          .join(' · ') + (received.length > 3 ? ` · +${received.length - 3} more` : '');

  return (
    <div className="why" key={toolUseId}>
      {w.prompt && (
        <Step
          title={w.prompt.byAgent ? 'Parent asked' : 'You asked'}
          summary={
            <>
              "{firstLine(w.prompt.text)}"{w.step && <span className="muted"> · call {w.step.index} of {w.step.of} in this turn</span>}
            </>
          }
        >
          <LongText text={w.prompt.text} className="prompt-text" lines={6} />
          <div className="why-links">
            <span className="muted">{fmtTime(w.prompt.ts)}</span>
            {link('Show in Transcript', () => onOpenRecord(w.prompt!.recordId))}
          </div>
        </Step>
      )}

      <Step title="Received" summary={receivedSummary}>
        {received.length === 0 ? (
          <div className="muted">Nothing new reached the model since its previous model call.</div>
        ) : (
          <>
            {w.beforeOmitted > 0 && <div className="muted">{w.beforeOmitted} earlier items not shown.</div>}
            {received.map((b) => (
              <div key={b.recordId} className="why-rec" onClick={() => onOpenRecord(b.recordId)} title="Show in Transcript">
                {b.toolUseId ? <PairChip toolUseId={b.toolUseId} name={b.toolName ?? undefined} /> : <span className={`tag tag-${b.type}`}>{b.subtype ?? b.type}</span>}
                {b.toolStatus && b.toolStatus !== 'ok' && <span className={`status-${b.toolStatus}`}>{b.toolStatus}</span>}
                <span className="sum">{b.summary.replace(/^\[tool_result [^\]]*\]\s*/, '')}</span>
                <span className="when">{b.contentBytes ? fmtBytes(b.contentBytes) : ''}</span>
              </div>
            ))}
          </>
        )}
      </Step>

      <Step title="Wrote" summary={wroteSummary} defaultOpen>
        {!w.modelCall ? (
          <div className="muted">The model call for this tool call isn't in the index.</div>
        ) : (
          <>
            {reasoning.map((b, i) =>
              b.kind === 'text' ? (
                <LongText key={i} text={b.text ?? ''} lines={8} />
              ) : b.text ? (
                <div key={i}>
                  <div className="section-title">Thinking</div>
                  <LongText text={b.text} className="muted" lines={8} />
                </div>
              ) : (
                <div key={i} className="muted">Thinking happened, but the transcript kept only its signature.</div>
              ),
            )}
            {!firstText && !firstThinking && w.earlierText && (
              <>
                <div className="muted">Nothing visible in this model call. The latest thing it wrote earlier in the turn:</div>
                <LongText text={w.earlierText.text} lines={8} />
                <div className="why-links">
                  <span className="muted">{fmtTime(w.earlierText.ts)}</span>
                  {link('Show in Transcript', () => onOpenRecord(w.earlierText!.recordId))}
                </div>
              </>
            )}
            {!firstText && !firstThinking && !w.earlierText && <div className="muted">The model wrote no visible text in this turn before this call.</div>}
            <div className="why-links">
              <span className="muted">
                {shortModel(w.modelCall.row.model)} · {fmtTime(w.modelCall.row.ts)}
              </span>
            </div>
          </>
        )}
      </Step>

      <Step
        title="Called"
        summary={
          <>
            {w.tool.name} <span className="muted">{w.tool.inputSummary}</span> →{' '}
            <span className={`status-${w.tool.status}`}>{w.tool.status}</span>
            {w.result && <span className="muted"> · {fmtBytes(w.result.contentBytes)}</span>}
          </>
        }
      >
        {(w.modelCall?.blocks.filter((b) => b.kind === 'tool_use') ?? []).length > 1 && (
          <div className="muted">This model call made {w.modelCall!.blocks.filter((b) => b.kind === 'tool_use').length} tool calls:</div>
        )}
        {(w.modelCall?.blocks.filter((b) => b.kind === 'tool_use') ?? []).map((b) => (
          <div key={b.toolUseId} className={`why-rec ${b.toolUseId === toolUseId ? 'target' : ''}`}>
            <PairChip toolUseId={b.toolUseId!} name={b.name} />
            <span className="sum">{b.inputSummary}</span>
          </div>
        ))}
        <div className="why-links">
          {w.tool.useRecordId !== null && link('Show call in Transcript', () => onOpenRecord(w.tool.useRecordId!))}
          {w.result && link('Show result in Transcript', () => onOpenRecord(w.result!.recordId))}
        </div>
      </Step>
    </div>
  );
}
