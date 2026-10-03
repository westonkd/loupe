// Per-tool output renderers for the Calls detail pane.
import { useState } from 'react';
import { fmtBytes } from '../format';
import { Button } from '@westonkd/sprint';

/* eslint-disable @typescript-eslint/no-explicit-any */

export function Terminal({ stdout, stderr }: { stdout?: string; stderr?: string }) {
  return (
    <pre className="terminal">
      {stdout || ''}
      {stderr ? <span className="err">{(stdout ? '\n' : '') + stderr}</span> : null}
      {!stdout && !stderr ? <span style={{ opacity: 0.6 }}>(no output)</span> : null}
    </pre>
  );
}

interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export function Diff({ hunks }: { hunks: Hunk[] }) {
  return (
    <div className="diff">
      {hunks.map((h, i) => {
        let o = h.oldStart;
        let n = h.newStart;
        return (
          <div key={i}>
            <div className="hunk">
              @@ -{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@
            </div>
            {h.lines.map((l, j) => {
              const c = l[0];
              const text = l.slice(1);
              if (c === '+') return <div key={j} className="line add"><span /><span>{n++}</span><span>+{text}</span></div>;
              if (c === '-') return <div key={j} className="line del"><span>{o++}</span><span /><span>-{text}</span></div>;
              if (c === '\\') return <div key={j} className="line"><span /><span /><span className="muted">{l}</span></div>;
              return <div key={j} className="line"><span>{o++}</span><span>{n++}</span><span> {text}</span></div>;
            })}
          </div>
        );
      })}
    </div>
  );
}

export function CodeView({ text, startLine = 1, maxLines = 5000 }: { text: string; startLine?: number; maxLines?: number }) {
  const lines = text.split('\n');
  const shown = lines.slice(0, maxLines);
  return (
    <div className="code">
      {shown.map((l, i) => (
        <div key={i} className="line">
          <span>{startLine + i}</span>
          <span>{l}</span>
        </div>
      ))}
      {lines.length > maxLines && <div className="muted" style={{ padding: 4 }}>… {lines.length - maxLines} more lines</div>}
    </div>
  );
}

/** Flatten tool_result content (string or blocks) into text. */
export function resultText(result: any): string {
  if (!result) return '';
  const c = result.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((b: any) => (typeof b === 'string' ? b : b?.type === 'text' ? b.text : b?.type === 'image' ? '[image]' : JSON.stringify(b)))
      .join('\n');
  }
  return '';
}

export function PersistedOutput({ sessionId, path, size }: { sessionId: string; path: string; size: number | null }) {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const load = () => {
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/tool-output?path=${encodeURIComponent(path)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        setTruncated(r.headers.get('X-Truncated') === '1');
        setText(await r.text());
      })
      .catch((e) => setErr(String(e.message ?? e)));
  };
  return (
    <div>
      <div className="notice">
        Full output was stored separately ({size !== null ? fmtBytes(size) : 'unknown size'}).{' '}
        {text === null && (
          <Button onClick={load}>Load full output</Button>
        )}
      </div>
      {err && <div className="notice error">Could not load: {err}</div>}
      {text !== null && (
        <>
          {truncated && <div className="notice">Showing the first 4 MB.</div>}
          <pre className="terminal">{text}</pre>
        </>
      )}
    </div>
  );
}
