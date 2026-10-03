import { EmptyState } from '@westonkd/sprint';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/** Per-viewer UI preference in localStorage. Storage may be unavailable, so every access is guarded. */
export function useStoredState<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const s = localStorage.getItem(key);
      return s === null ? initial : (JSON.parse(s) as T);
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        localStorage.setItem(key, JSON.stringify(v));
      } catch {
        /* storage unavailable */
      }
    },
    [key],
  );
  return [value, set];
}

export function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return match;
}

/**
 * Wide screens keep the detail pane open so the list doesn't reflow on every
 * selection. The floor is roughly a 360px detail pane plus a grid wide enough
 * to stay readable with the session rail open; collapse the rail to gain back
 * its width on a narrower window.
 */
export const WIDE = '(min-width: 1100px)';

interface SplitProps {
  /** Persisted width of the side pane, in px. */
  storageKey: string;
  side: 'left' | 'right';
  defaultWidth: number;
  min: number;
  /** Cap as a fraction of the container width. */
  maxFraction?: number;
  /** null hides the side pane (and the handle). */
  pane: ReactNode | null;
  children: ReactNode;
}

/**
 * Two panes with a draggable divider. The side pane has a fixed, remembered
 * width; the other pane takes the rest. Arrow keys on the focused divider
 * resize it, double-click resets.
 */
export function Split({ storageKey, side, defaultWidth, min, maxFraction = 0.7, pane, children }: SplitProps) {
  const [width, setWidth] = useStoredState(`split:${storageKey}`, defaultWidth);
  const ref = useRef<HTMLDivElement>(null);
  const clamp = (w: number) => {
    const total = ref.current?.clientWidth ?? window.innerWidth;
    return Math.round(Math.max(min, Math.min(w, total * maxFraction)));
  };

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const move = (ev: PointerEvent) => setWidth(clamp(startW + (side === 'left' ? ev.clientX - startX : startX - ev.clientX)));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('resizing');
    };
    document.body.classList.add('resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const grow = (e.key === 'ArrowRight') === (side === 'left');
    setWidth(clamp(width + (grow ? 1 : -1) * (e.shiftKey ? 80 : 20)));
  };

  const w = pane === null ? 0 : clamp(width);
  const handle = pane !== null && (
    <div
      className="splitter"
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={w}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => setWidth(defaultWidth)}
    />
  );
  return (
    <div ref={ref} className="split">
      {side === 'left' && pane !== null && (
        <div className="pane" style={{ width: w, flex: 'none' }}>
          {pane}
        </div>
      )}
      {side === 'left' && handle}
      <div className="pane" style={{ flex: 1 }}>
        {children}
      </div>
      {side === 'right' && handle}
      {side === 'right' && pane !== null && (
        <div className="pane" style={{ width: w, flex: 'none' }}>
          {pane}
        </div>
      )}
    </div>
  );
}

/** Placeholder for the detail pane when nothing is selected. */
export function DetailEmpty({ label, children }: { label: string; children: string }) {
  return (
    <div className="pane detail">
      <div className="detail-head" />
      <div className="detail-empty">
        <EmptyState label={label} description={children} />
      </div>
    </div>
  );
}
