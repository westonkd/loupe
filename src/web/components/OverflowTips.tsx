import { useEffect, useRef, useState } from 'react';

const DELAY_MS = 250;
/** How far up from the hovered node to look for a truncated or titled element. */
const MAX_DEPTH = 4;

function isTruncated(el: HTMLElement): boolean {
  if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).textOverflow === 'ellipsis') return true;
  // Multi-line clamps.
  return el.scrollHeight > el.clientHeight + 1 && getComputedStyle(el).webkitLineClamp !== 'none';
}

interface Tip {
  text: string;
  x: number;
  y: number;
  below: boolean;
}

/**
 * One page-wide tooltip for text that doesn't fit. Hovering an element whose
 * text is cut off (ellipsis or line clamp), or that carries a `title`, shows
 * the full text after a short delay. Native `title` tooltips are suppressed
 * while hovering so the two never stack, and restored on leave. Mounted once
 * in App, so every panel gets it without per-cell wiring.
 */
export function OverflowTips() {
  const [tip, setTip] = useState<Tip | null>(null);
  const timer = useRef<number | null>(null);
  const current = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const clear = () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
      const el = current.current;
      if (el?.dataset.tipTitle !== undefined) {
        el.setAttribute('title', el.dataset.tipTitle);
        delete el.dataset.tipTitle;
      }
      current.current = null;
      setTip(null);
    };

    const onOver = (e: MouseEvent) => {
      let el = e.target as HTMLElement | null;
      let found: HTMLElement | null = null;
      for (let i = 0; el && i < MAX_DEPTH && el !== document.body; i++, el = el.parentElement) {
        if (el.dataset.noTip !== undefined) break;
        if (el.hasAttribute('title') || isTruncated(el)) {
          found = el;
          break;
        }
      }
      if (found === current.current) return;
      clear();
      if (!found) return;
      current.current = found;
      const title = found.getAttribute('title');
      if (title !== null) {
        found.dataset.tipTitle = title;
        found.removeAttribute('title');
      }
      const target = found;
      timer.current = window.setTimeout(() => {
        const full = (target.innerText || target.textContent || '').trim();
        const truncated = isTruncated(target);
        // A title usually carries the full value or extra detail; when the
        // visible text is also cut off and says something else, show both.
        const parts = [truncated ? full : '', title ?? ''].filter((p, i, a) => p && a.indexOf(p) === i);
        if (!parts.length) return;
        const r = target.getBoundingClientRect();
        const below = r.bottom + 120 < window.innerHeight;
        setTip({ text: parts.join('\n\n'), x: Math.min(r.left, window.innerWidth - 660), y: below ? r.bottom + 4 : r.top - 4, below });
      }, DELAY_MS);
    };

    const onOut = (e: MouseEvent) => {
      const to = e.relatedTarget as Node | null;
      if (current.current && to && current.current.contains(to)) return;
      if (current.current && !(to && current.current.contains(to))) clear();
    };

    document.addEventListener('mouseover', onOver);
    document.addEventListener('mouseout', onOut);
    window.addEventListener('scroll', clear, true);
    window.addEventListener('keydown', clear);
    window.addEventListener('blur', clear);
    return () => {
      clear();
      document.removeEventListener('mouseover', onOver);
      document.removeEventListener('mouseout', onOut);
      window.removeEventListener('scroll', clear, true);
      window.removeEventListener('keydown', clear);
      window.removeEventListener('blur', clear);
    };
  }, []);

  if (!tip) return null;
  return (
    <div
      className="overflow-tip"
      role="tooltip"
      style={{ left: Math.max(8, tip.x), top: tip.y, transform: tip.below ? undefined : 'translateY(-100%)' }}
    >
      {tip.text}
    </div>
  );
}
