import { useState } from 'react';
import { JsonView } from './JsonView';
import { PairChip } from './ToolPair';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Long text clamped to a few lines, with a toggle. */
export function LongText({ text, className = '', lines = 12 }: { text: string; className?: string; lines?: number }) {
  const [open, setOpen] = useState(false);
  const long = text.split('\n').length > lines || text.length > lines * 120;
  return (
    <div className="long-text">
      <pre className={`block ${className} ${long && !open ? 'clamped' : ''}`} style={long && !open ? { maxHeight: `${lines * 1.45}em` } : undefined}>
        {text}
      </pre>
      {long && (
        <button className="link-btn" onClick={() => setOpen(!open)}>
          {open ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  );
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b: any) => (typeof b?.text === 'string' ? b.text : b?.type === 'image' ? '[image]' : '')).join('\n');
}

/**
 * One transcript record rendered as what it says rather than as JSON: prompt
 * text, assistant text / thinking / tool calls, tool results, attachment and
 * system content. Anything unrecognised falls back to the JSON tree.
 */
export function MessageView({ raw }: { raw: any }) {
  const type = raw?.type;
  const content = raw?.message?.content;

  if ((type === 'assistant' || type === 'user') && (typeof content === 'string' || Array.isArray(content))) {
    if (typeof content === 'string') return <LongText text={content} className={type === 'user' ? 'prompt-text' : ''} />;
    return (
      <>
        {content.map((b: any, i: number) => {
          if (b?.type === 'text') return <LongText key={i} text={b.text ?? ''} className={type === 'user' ? 'prompt-text' : ''} />;
          if (b?.type === 'thinking' || b?.type === 'redacted_thinking')
            return (
              <div key={i}>
                <div className="section-title">Thinking</div>
                {b.thinking ? <LongText text={b.thinking} className="muted" /> : <div className="muted">Not kept in the transcript (signature only).</div>}
              </div>
            );
          if (b?.type === 'tool_use')
            return (
              <div key={i}>
                <div className="section-title pair-box-head">
                  <span className="type-tool">tool call</span>
                  {typeof b.id === 'string' ? <PairChip toolUseId={b.id} name={b.name} /> : b.name}
                </div>
                <JsonView value={b.input} defaultOpen={2} />
              </div>
            );
          if (b?.type === 'tool_result')
            return (
              <div key={i}>
                <div className="section-title pair-box-head">
                  <span className="type-tool">result</span>
                  {typeof b.tool_use_id === 'string' && <PairChip toolUseId={b.tool_use_id} />}
                  {b.is_error && <span className="status-error">error</span>}
                </div>
                <LongText text={resultText(b.content)} />
              </div>
            );
          if (b?.type === 'image') return <div key={i} className="muted">[image]</div>;
          return <JsonView key={i} value={b} defaultOpen={1} />;
        })}
      </>
    );
  }

  if (type === 'attachment' && raw.attachment) {
    const a = raw.attachment;
    const text = typeof a.content === 'string' ? a.content : typeof a.stdout === 'string' ? a.stdout : null;
    return (
      <>
        <div className="section-title">Attachment: {a.type ?? 'unknown'}</div>
        {text !== null ? <LongText text={text} /> : <JsonView value={a} defaultOpen={2} />}
      </>
    );
  }

  if (type === 'system') {
    const text = typeof raw.content === 'string' ? raw.content : null;
    return (
      <>
        <div className="section-title">System: {raw.subtype ?? 'message'}</div>
        {text ? <LongText text={text} /> : <JsonView value={raw} defaultOpen={2} />}
      </>
    );
  }

  return <JsonView value={raw} defaultOpen={3} />;
}
