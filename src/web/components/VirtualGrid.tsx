import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

export interface Column<T> {
  key: string;
  title: string;
  width: string;
  className?: string;
  render: (row: T) => ReactNode;
  title2?: (row: T) => string | undefined;
}

interface Props<T> {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  selected: string | null;
  onSelect: (key: string | null) => void;
  /** Row click, after selection. Keyboard movement does not activate. */
  onActivate?: (key: string) => void;
  rowClass?: (row: T) => string;
  /**
   * Follow new rows like devtools. 'bottom': oldest-first lists stick to the
   * bottom while scrolled there. 'top': newest-first lists stay at the top
   * while scrolled there, and keep the user's place otherwise.
   */
  follow?: 'bottom' | 'top';
  empty?: ReactNode;
}

const ROW_H = 21;
const HEAD_H = 22;

export function VirtualGrid<T>({ rows, columns, rowKey, selected, onSelect, onActivate, rowClass, follow, empty }: Props<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const atTop = useRef(true);
  const prevLen = useRef(0);
  const template = columns.map((c) => c.width).join(' ');
  const v = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 20,
    // The sticky header sits above the rows inside the same scroller.
    scrollMargin: HEAD_H,
  });

  // Anchor: the row at the top of the viewport and how far into it we are.
  const anchor = useRef<{ key: string; offset: number } | null>(null);
  const captureAnchor = () => {
    const el = scrollRef.current;
    if (!el || rows.length === 0) return;
    const idx = Math.min(rows.length - 1, Math.floor(el.scrollTop / ROW_H));
    anchor.current = { key: rowKey(rows[idx]), offset: el.scrollTop - idx * ROW_H };
  };

  useLayoutEffect(() => {
    const added = rows.length - prevLen.current;
    const el = scrollRef.current;
    if (follow === 'bottom' && added > 0 && atBottom.current) {
      // Wait a frame so the virtualizer has sized the new rows.
      requestAnimationFrame(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      });
    } else if (follow === 'top' && el && !atTop.current && anchor.current) {
      // Rows were inserted (usually prepended): keep the anchored row where it was.
      const idx = rows.findIndex((r) => rowKey(r) === anchor.current!.key);
      if (idx >= 0) el.scrollTop = idx * ROW_H + anchor.current.offset;
    }
    prevLen.current = rows.length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, follow]);

  // Keep the selected row visible when it changes via the keyboard.
  const selIndex = selected === null ? -1 : rows.findIndex((r) => rowKey(r) === selected);
  useEffect(() => {
    if (selIndex < 0) return;
    // Keyboard moves scroll minimally; a jump from elsewhere (far off screen) centres the row.
    const el = scrollRef.current;
    const y = selIndex * ROW_H;
    const far = el ? y < el.scrollTop - ROW_H * 3 || y > el.scrollTop + el.clientHeight + ROW_H * 3 : false;
    v.scrollToIndex(selIndex, { align: far ? 'center' : 'auto' });
  }, [selIndex, v]);

  // j/k navigation (N4); ignored while typing in an input.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== 'j' && e.key !== 'k' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      if (rows.length === 0) return;
      e.preventDefault();
      const down = e.key === 'j' || e.key === 'ArrowDown';
      const i = selIndex < 0 ? (down ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, selIndex + (down ? 1 : -1)));
      onSelect(rowKey(rows[i]));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rows, selIndex, onSelect, rowKey]);

  return (
    <div
      className="grid"
      ref={scrollRef}
      tabIndex={0}
      onScroll={(e) => {
        const el = e.currentTarget;
        atBottom.current = el.scrollTop + el.clientHeight >= el.scrollHeight - ROW_H * 2;
        atTop.current = el.scrollTop < ROW_H * 2;
        captureAnchor();
      }}
    >
      <div className="grid-head" style={{ gridTemplateColumns: template }}>
        {columns.map((c) => (
          <div key={c.key} className={c.className}>
            {c.title}
          </div>
        ))}
      </div>
      {rows.length === 0 ? (
        <div className="empty">{empty ?? 'No rows'}</div>
      ) : (
        <div style={{ height: v.getTotalSize(), position: 'relative' }}>
          {v.getVirtualItems().map((vi) => {
            const row = rows[vi.index];
            const k = rowKey(row);
            return (
              <div
                key={k}
                className={`grid-row ${onActivate ? 'clickable' : ''} ${k === selected ? 'sel' : ''} ${rowClass?.(row) ?? ''}`}
                style={{ gridTemplateColumns: template, position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${vi.start - HEAD_H}px)` }}
                onClick={() => {
                  onSelect(k);
                  onActivate?.(k);
                }}
              >
                {columns.map((c) => (
                  <div key={c.key} className={c.className} title={c.title2?.(row)}>
                    {c.render(row)}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
