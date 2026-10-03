import { useId } from 'react';

// Geometry on a 32-unit grid. Three thin lines of "text" run in from the left
// under a lens; through the lens the middle line (the accent) is magnified.
const CX = 19.5;
const R = 11.5;
const RIM = 2.5;
const LINES = [10, 16, 22];
const THIN = 2;
const MAG = 2.4;

/** x where a line at height y meets the lens, plus half the rim so it tucks under. */
const lensEdge = (y: number) => CX - Math.sqrt(R * R - (y - 16) ** 2) + RIM / 2;

/**
 * Loupe's mark: a jeweller's loupe over lines of a log, showing one line
 * magnified. Ink is currentColor and the magnified line is --accent, so it
 * follows the theme. The favicon in index.html is the same drawing with fixed
 * colours.
 */
export function Logo({ size = 26, title = 'Loupe' }: { size?: number; title?: string }) {
  const clip = useId();
  const inner = R - RIM;
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 32 32" role="img" aria-label={title}>
      <title>{title}</title>
      {/* Each line stops where it meets the lens, tucked under the rim, so the
          mark needs no background fill and works on any surface. */}
      {LINES.map((y) => (
        <rect key={y} x="1" y={y - THIN / 2} width={lensEdge(y) - 1} height={THIN} fill={y === 16 ? 'var(--accent)' : 'currentColor'} />
      ))}
      {/* Through the lens the same lines are magnified about y=16. */}
      <clipPath id={clip}>
        <circle cx={CX} cy="16" r={inner} />
      </clipPath>
      <g clipPath={`url(#${clip})`}>
        {LINES.map((y) => (
          <rect key={y} x="0" y={16 + (y - 16) * MAG - (THIN * MAG) / 2} width="32" height={THIN * MAG} fill={y === 16 ? 'var(--accent)' : 'currentColor'} />
        ))}
      </g>
      <circle cx={CX} cy="16" r={R - RIM / 2} fill="none" stroke="currentColor" strokeWidth={RIM} />
    </svg>
  );
}
