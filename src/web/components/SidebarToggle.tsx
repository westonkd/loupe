/**
 * Icon button that shows or hides the session rail. It sits on the rail's own
 * edge (in the rail's toolbar while open, at the start of the session header
 * while closed) instead of in the global top bar. A plain button: Sprint's
 * Button is a padded text action, too heavy for a panel toggle.
 */
export function SidebarToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const label = open ? 'Hide session list' : 'Show session list';
  return (
    <button className="icon-btn" onClick={onToggle} aria-label={label} aria-expanded={open} title={`${label} ([)`}>
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <rect x="1.5" y="2.5" width="13" height="11" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <rect x="1.5" y="2.5" width="4.5" height="11" fill="currentColor" opacity={open ? 1 : 0.35} />
      </svg>
    </button>
  );
}
