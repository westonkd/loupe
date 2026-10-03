// Minimal SVG line chart: one series, shared x (request index) so several
// charts can be stacked with a common crosshair instead of a dual axis.
import { useEffect, useRef, useState } from 'react';

export interface Marker {
  x: number;
  label?: string;
}

/** A glyph drawn on the line at one point (e.g. a context jump or cache miss). */
export interface PointMark {
  i: number;
  color: string;
  shape: 'dot' | 'cross';
  title?: string;
}

interface Props {
  values: Array<number | null>;
  height: number;
  color: string;
  yMax?: number;
  yFormat: (v: number) => string;
  compactions: Marker[];
  turns: number[];
  hover: number | null;
  onHover: (i: number | null) => void;
  ariaLabel: string;
  marks?: PointMark[];
  selected?: number | null;
  onSelect?: (i: number) => void;
}

const PAD = { left: 52, right: 12, top: 10, bottom: 18 };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

export function LineChart({ values, height, color, yMax, yFormat, compactions, turns, hover, onHover, ariaLabel, marks = [], selected = null, onSelect }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(200, el.clientWidth)));
    ro.observe(el);
    setWidth(Math.max(200, el.clientWidth));
    return () => ro.disconnect();
  }, []);

  const n = values.length;
  const max = yMax ?? niceMax(Math.max(0, ...values.map((v) => v ?? 0)) * 1.05);
  const innerW = width - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH;

  // Break the line at missing values.
  let d = '';
  let pen = false;
  values.forEach((v, i) => {
    if (v === null) {
      pen = false;
      return;
    }
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  });

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const xTickEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(innerW / 70))));

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (n === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const i = n <= 1 ? 0 : Math.round(((px - PAD.left) / innerW) * (n - 1));
    onHover(Math.max(0, Math.min(n - 1, i)));
  };

  return (
    <div className="chart" ref={ref}>
      <svg
        height={height}
        role="img"
        aria-label={ariaLabel}
        onPointerMove={onMove}
        onPointerLeave={() => onHover(null)}
        onClick={() => hover !== null && onSelect?.(hover)}
        style={{ cursor: onSelect ? 'pointer' : undefined }}
      >
        <g className="grid">
          {ticks.map((t) => (
            <line key={t} x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
          ))}
        </g>
        <g className="axis">
          {ticks.map((t) => (
            <text key={t} x={PAD.left - 6} y={y(t) + 3} textAnchor="end">
              {yFormat(t)}
            </text>
          ))}
          {values.map((_, i) =>
            i % xTickEvery === 0 ? (
              <text key={i} x={x(i)} y={height - 4} textAnchor="middle">
                {i + 1}
              </text>
            ) : null,
          )}
        </g>
        <g className="turn">
          {turns.map((t, i) => (
            <line key={i} x1={x(t)} x2={x(t)} y1={PAD.top + innerH} y2={PAD.top + innerH + 5} />
          ))}
        </g>
        <g className="compaction">
          {compactions.map((c, i) => (
            <g key={i}>
              <line x1={x(c.x)} x2={x(c.x)} y1={PAD.top} y2={PAD.top + innerH} />
              {c.label && (
                <text x={x(c.x) + 4} y={PAD.top + 10}>
                  {c.label}
                </text>
              )}
            </g>
          ))}
        </g>
        <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {selected !== null && selected < n && (
          <line x1={x(selected)} x2={x(selected)} y1={PAD.top} y2={PAD.top + innerH} stroke="var(--accent)" strokeWidth={1.5} />
        )}
        <g className="mark">
          {marks.map((m) => {
            const v = values[m.i];
            if (v === null || v === undefined) return null;
            const cx = x(m.i);
            const cy = y(v);
            return m.shape === 'dot' ? (
              <circle key={m.i} cx={cx} cy={cy} r={4.5} fill={m.color} stroke="var(--bg)" strokeWidth={2}>
                {m.title && <title>{m.title}</title>}
              </circle>
            ) : (
              <g key={m.i} stroke={m.color} strokeWidth={2.5} strokeLinecap="round">
                <line x1={cx - 4} y1={cy - 4} x2={cx + 4} y2={cy + 4} />
                <line x1={cx - 4} y1={cy + 4} x2={cx + 4} y2={cy - 4} />
                {m.title && <title>{m.title}</title>}
              </g>
            );
          })}
        </g>
        {hover !== null && hover < n && (
          <g>
            <line className="cross" x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + innerH} />
            {values[hover] !== null && (
              <circle cx={x(hover)} cy={y(values[hover]!)} r={4} fill={color} stroke="var(--bg)" strokeWidth={2} />
            )}
          </g>
        )}
        {/* Bigger-than-the-mark hit area */}
        <rect x={PAD.left} y={PAD.top} width={innerW} height={innerH} fill="transparent" />
      </svg>
    </div>
  );
}
