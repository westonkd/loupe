// Stacked bars over time. The Context panel's LineChart is indexed by request
// and carries one series; this one is indexed by date and stacks several, so
// a trend can be read as "what grew" rather than only "it grew".
import { useEffect, useRef, useState } from 'react';

export interface Band {
  key: string;
  label: string;
  color: string;
  values: number[];
}

interface Props {
  /** Bucket start dates, ISO, ascending. */
  labels: string[];
  /** Stacked bands, drawn bottom-up in the order given. */
  bands: Band[];
  height: number;
  unit: 'day' | 'week' | 'month';
  format: (v: number) => string;
  ariaLabel: string;
  /** Lifted so the table can highlight the same key (null = nothing hovered). */
  activeKey: string | null;
  onActiveKey: (key: string | null) => void;
}

const PAD = { left: 56, right: 10, top: 10, bottom: 20 };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function tickLabel(iso: string, unit: Props['unit']): string {
  const d = new Date(iso + 'T00:00:00.000Z');
  if (Number.isNaN(d.getTime())) return '';
  const opts: Intl.DateTimeFormatOptions =
    unit === 'month' ? { month: 'short', year: '2-digit' } : { month: 'short', day: 'numeric' };
  return d.toLocaleDateString('en-US', { ...opts, timeZone: 'UTC' });
}

export function TrendChart({ labels, bands, height, unit, format, ariaLabel, activeKey, onActiveKey }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(240, el.clientWidth)));
    ro.observe(el);
    setWidth(Math.max(240, el.clientWidth));
    return () => ro.disconnect();
  }, []);

  const n = labels.length;
  const totals = labels.map((_, i) => bands.reduce((a, b) => a + (b.values[i] ?? 0), 0));
  const max = niceMax(Math.max(0, ...totals) * 1.05);
  const innerW = width - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;
  const slot = n > 0 ? innerW / n : innerW;
  // Fill the slot rather than a fixed cap: a 10-bucket chart otherwise draws
  // thin bars marooned in whitespace.
  const barW = Math.max(1, Math.min(slot * 0.72, 56));
  const xOf = (i: number) => PAD.left + slot * i + (slot - barW) / 2;
  const hOf = (v: number) => (max > 0 ? (v / max) * innerH : 0);

  // At most ~8 date ticks, always including the last bucket.
  const step = Math.max(1, Math.ceil(n / 8));
  const ticks = labels.map((_, i) => i).filter((i) => i % step === 0 || i === n - 1);

  if (n === 0) return <div className="muted" style={{ padding: 8 }}>No dated sessions in scope.</div>;

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={ariaLabel}
        onMouseLeave={() => {
          setHover(null);
          onActiveKey(null);
        }}
      >
        {[0, 0.5, 1].map((f) => {
          const y = PAD.top + innerH - f * innerH;
          return (
            <g key={f}>
              <line x1={PAD.left} x2={width - PAD.right} y1={y} y2={y} stroke="var(--chart-grid)" />
              <text x={PAD.left - 6} y={y + 3} textAnchor="end" fontSize="9.5" fill="var(--text-3)">
                {format(max * f)}
              </text>
            </g>
          );
        })}
        {labels.map((_, i) => {
          let acc = 0;
          return (
            <g key={i}>
              {/* Behind the segments: keeps empty buckets and the gaps hoverable. */}
              <rect
                x={PAD.left + slot * i}
                y={PAD.top}
                width={slot}
                height={innerH}
                fill={hover === i ? 'var(--text)' : 'transparent'}
                opacity={hover === i ? 0.07 : 1}
                onMouseEnter={() => {
                  setHover(i);
                  onActiveKey(null);
                }}
              />
              {bands.map((b) => {
                const v = b.values[i] ?? 0;
                if (v <= 0) return null;
                const h = hOf(v);
                const y = PAD.top + innerH - hOf(acc) - h;
                acc += v;
                return (
                  <rect
                    key={b.key}
                    x={xOf(i)}
                    y={y}
                    width={barW}
                    height={Math.max(0.5, h)}
                    fill={b.color}
                    // Hovering one segment dims the other bands in every bar,
                    // so a single band can be followed across the whole span.
                    opacity={activeKey && activeKey !== b.key ? 0.18 : 1}
                    onMouseEnter={() => {
                      setHover(i);
                      onActiveKey(b.key);
                    }}
                  >
                    <title>{`${b.label}: ${format(v)}`}</title>
                  </rect>
                );
              })}
            </g>
          );
        })}
        {ticks.map((i) => (
          <text key={i} x={xOf(i) + barW / 2} y={height - 6} textAnchor="middle" fontSize="9.5" fill="var(--text-3)">
            {tickLabel(labels[i], unit)}
          </text>
        ))}
      </svg>
      {hover !== null && (
        <div className="tooltip" style={{ top: 4, right: 8, maxWidth: 280 }}>
          <div className="muted">{tickLabel(labels[hover], unit)}</div>
          <div>
            <span className="v">{format(totals[hover])}</span> total
          </div>
          {bands
            .map((b) => [b, b.values[hover] ?? 0] as const)
            .filter(([b, v]) => v > 0 && (!activeKey || b.key === activeKey))
            .sort((a, b) => b[1] - a[1])
            .slice(0, 7)
            .map(([b, v]) => (
              <div key={b.key} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <span className="kind-key" style={{ background: b.color }} />
                <span className="v">{format(v)}</span> {b.label}
                {totals[hover] > 0 && <span className="muted"> · {Math.round((v / totals[hover]) * 100)}%</span>}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
