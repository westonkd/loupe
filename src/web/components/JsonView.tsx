import { useState } from 'react';

const MAX_STRING = 4000;

function Str({ v }: { v: string }) {
  const [full, setFull] = useState(false);
  const long = v.length > MAX_STRING;
  return (
    <span className="s">
      "{full || !long ? v : v.slice(0, MAX_STRING)}"
      {long && !full && (
        <button className="btn" style={{ marginLeft: 6 }} onClick={() => setFull(true)}>
          show all {v.length.toLocaleString()} chars
        </button>
      )}
    </span>
  );
}

function Node({ k, v, depth, defaultOpen }: { k?: string; v: unknown; depth: number; defaultOpen: number }) {
  const [open, setOpen] = useState(depth < defaultOpen);
  const key = k !== undefined ? <span className="k">{k}</span> : null;
  const sep = k !== undefined ? ': ' : '';
  if (v === null) return <div>{key}{sep}<span className="b">null</span></div>;
  if (typeof v === 'string') return <div>{key}{sep}<Str v={v} /></div>;
  if (typeof v === 'number') return <div>{key}{sep}<span className="n">{v}</span></div>;
  if (typeof v === 'boolean') return <div>{key}{sep}<span className="b">{String(v)}</span></div>;
  if (typeof v !== 'object') return <div>{key}{sep}{String(v)}</div>;
  const isArr = Array.isArray(v);
  const entries = isArr ? (v as unknown[]).map((x, i) => [String(i), x] as const) : Object.entries(v as object);
  const brace = isArr ? ['[', ']'] : ['{', '}'];
  if (entries.length === 0) return <div>{key}{sep}{brace[0]}{brace[1]}</div>;
  return (
    <div>
      <span className="toggle" onClick={() => setOpen(!open)}>{open ? '▾' : '▸'}</span>
      {key}{sep}
      {open ? (
        <>
          {brace[0]}
          <div className="indent">
            {entries.map(([ck, cv]) => (
              <Node key={ck} k={isArr ? undefined : ck} v={cv} depth={depth + 1} defaultOpen={defaultOpen} />
            ))}
          </div>
          {brace[1]}
        </>
      ) : (
        <span className="muted" style={{ cursor: 'pointer' }} onClick={() => setOpen(true)}>
          {brace[0]}…{brace[1]} {entries.length} {isArr ? 'items' : 'keys'}
        </span>
      )}
    </div>
  );
}

export function JsonView({ value, defaultOpen = 2 }: { value: unknown; defaultOpen?: number }) {
  return (
    <div className="json">
      <Node v={value} depth={0} defaultOpen={defaultOpen} />
    </div>
  );
}
