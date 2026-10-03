import { useEffect, useRef, useState } from 'react';
import type { Paged, ServerEvent } from '../shared/types';

export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {
      /* not json */
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

// One EventSource for the whole app; components subscribe to it.
type Listener = (ev: ServerEvent) => void;
const listeners = new Set<Listener>();
const connListeners = new Set<(c: boolean) => void>();
let source: EventSource | null = null;
let connected = false;

function ensureSource() {
  if (source) return;
  source = new EventSource('/api/events');
  source.onopen = () => setConnected(true);
  source.onerror = () => setConnected(false);
  source.onmessage = (e) => {
    try {
      const ev = JSON.parse(e.data) as ServerEvent;
      for (const l of listeners) l(ev);
    } catch {
      /* ignore */
    }
  };
}

function setConnected(c: boolean) {
  connected = c;
  for (const l of connListeners) l(c);
}

export function useServerEvents(fn: Listener) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    ensureSource();
    const l: Listener = (ev) => ref.current(ev);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
}

export function useConnected(): boolean {
  const [c, setC] = useState(connected);
  useEffect(() => {
    ensureSource();
    connListeners.add(setC);
    return () => {
      connListeners.delete(setC);
    };
  }, []);
  return c;
}

/**
 * Fetch an incremental `Paged<T>` endpoint, then re-fetch `?after=cursor` each
 * time the server reports new records for the session. Rows merge by id, so
 * rows updated after their first appearance (e.g. a tool result arriving)
 * replace the earlier copy.
 */
export function useIncremental<T extends { id: number }>(
  sessionId: string | null,
  endpoint: string,
  enabled = true,
): { rows: T[]; loading: boolean; error: string | null } {
  const [rows, setRows] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = useRef<{ cursor: number; map: Map<number, T>; inflight: boolean; again: boolean; sid: string | null }>({
    cursor: 0,
    map: new Map(),
    inflight: false,
    again: false,
    sid: null,
  });

  const fetchMore = useRef<() => void>(() => {});
  fetchMore.current = () => {
    const st = state.current;
    const sid = sessionId;
    if (!sid || !enabled) return;
    if (st.inflight) {
      st.again = true;
      return;
    }
    st.inflight = true;
    getJson<Paged<T>>(`/api/sessions/${encodeURIComponent(sid)}/${endpoint}?after=${st.cursor}`)
      .then((page) => {
        if (state.current.sid !== sid) return;
        let changed = false;
        for (const r of page.rows) {
          st.map.set(r.id, r);
          changed = true;
        }
        st.cursor = Math.max(st.cursor, page.cursor);
        if (changed) setRows([...st.map.values()].sort((a, b) => a.id - b.id));
        setError(null);
      })
      .catch((e) => setError(String(e.message ?? e)))
      .finally(() => {
        st.inflight = false;
        setLoading(false);
        if (st.again) {
          st.again = false;
          fetchMore.current();
        }
      });
  };

  useEffect(() => {
    state.current = { cursor: 0, map: new Map(), inflight: false, again: false, sid: sessionId };
    setRows([]);
    setError(null);
    if (sessionId && enabled) {
      setLoading(true);
      fetchMore.current();
    }
  }, [sessionId, endpoint, enabled]);

  useServerEvents((ev) => {
    if (ev.type === 'session' && ev.sessionId === sessionId && ev.cursor > state.current.cursor) fetchMore.current();
  });

  return { rows, loading, error };
}

/** Plain fetch with refetch on session events (for small derived views). */
export function useSessionResource<T>(sessionId: string | null, path: string | null, live = true) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (!path) {
      setData(null);
      return;
    }
    let cancelled = false;
    getJson<T>(path)
      .then((d) => !cancelled && (setData(d), setError(null)))
      .catch((e) => !cancelled && setError(String(e.message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [path, tick]);
  useEffect(() => setData(null), [path]);
  useServerEvents((ev) => {
    if (!live || ev.type !== 'session' || ev.sessionId !== sessionId) return;
    // Debounce: derived views don't need every single record.
    if (timer.current !== null) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setTick((t) => t + 1);
    }, 750);
  });
  return { data, error };
}
