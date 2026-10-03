export function fmtInt(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  return n.toLocaleString('en-US');
}

export function fmtTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  if (n === 0) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export const COST_TERM = 'API cost';
export const COST_TERM_EST = 'API cost (est.)';
const NOT_BILLED = 'On a Pro or Max subscription you were not billed this.';
export const COST_NOTE_CLI = `Claude Code's own total for the session, priced at Anthropic API rates. ${NOT_BILLED}`;
export const COST_NOTE_EST = `Estimated from bundled Anthropic API prices. ${NOT_BILLED}`;
export const COST_NOTE = `Priced at Anthropic API rates. ${NOT_BILLED}`;

export function costTerm(source: 'cli' | 'estimate' | null | undefined): string {
  return source === 'cli' ? COST_TERM : COST_TERM_EST;
}

export function costNote(source: 'cli' | 'estimate' | null | undefined): string {
  return source === 'cli' ? COST_NOTE_CLI : COST_NOTE_EST;
}

export function fmtCost(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return '';
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 10) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export function fmtTime(ts: string | null | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-US', { hour12: false });
}

export function fmtDateTime(ts: string | null | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
        ' ' +
        d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

export function relMs(ts: string | null | undefined, origin: string | null | undefined): number | null {
  if (!ts || !origin) return null;
  const a = Date.parse(ts);
  const b = Date.parse(origin);
  return Number.isFinite(a) && Number.isFinite(b) ? a - b : null;
}

export function shortModel(m: string | null | undefined): string {
  if (!m) return '';
  return m.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

export function homeRelative(p: string | null | undefined): string {
  if (!p) return '';
  return p.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
}

/** Last 4 characters of a tool_use id: enough to tell calls apart on screen. */
export function shortToolId(id: string): string {
  return id.slice(-4);
}

/**
 * A stable colour per tool_use id, so a call and its result share a swatch
 * wherever they appear (Calls, Transcript). Hue from an FNV-1a hash; fixed
 * saturation and lightness read on both themes.
 */
export function pairColor(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `hsl(${(h >>> 0) % 360} 70% 55%)`;
}

/** Full local date and time, for detail views where "16:49" alone is ambiguous. */
export function fmtFullDateTime(ts: string | null | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}
