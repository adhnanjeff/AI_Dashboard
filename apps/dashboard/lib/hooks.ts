'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { mergeEvents } from './events.ts';
import type { DomainEvent } from './types.ts';

export interface Polled<T> { data: T | null; error: Error | null; updatedAt: number | null; loading: boolean; refresh: () => Promise<void> }

/**
 * Fetches now, then every `intervalMs` while the tab is visible. A failed refresh keeps the last good data
 * (so the UI can show it as stale instead of blank). Responses that arrive out of order are discarded.
 */
export function usePolling<T>(fetcher: () => Promise<T>, intervalMs: number, key: string, enabled = true): Polled<T> {
  const [state, setState] = useState<{ data: T | null; error: Error | null; updatedAt: number | null; loading: boolean }>({ data: null, error: null, updatedAt: null, loading: true });
  const fetcherRef = useRef(fetcher); fetcherRef.current = fetcher;
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    try { const data = await fetcherRef.current(); if (mine === seq.current) setState({ data, error: null, updatedAt: Date.now(), loading: false }); }
    catch (e) { if (mine === seq.current) setState((s) => ({ ...s, error: e as Error, loading: false })); }
  }, []);

  useEffect(() => {
    setState({ data: null, error: null, updatedAt: null, loading: true });
    if (!enabled) return;
    void refresh();
    const tick = () => { if (!document.hidden) void refresh(); };
    const t = setInterval(tick, intervalMs);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', tick); seq.current++; };
  }, [key, intervalMs, enabled, refresh]);

  return { ...state, refresh };
}

export type StreamStatus = 'connecting' | 'live' | 'reconnecting' | 'closed';

/**
 * Live event stream for one session. The server replays history from the start on every (re)connect;
 * mergeEvents makes that harmless. Incoming events are batched so a long replay does not re-render per event.
 */
export function useSessionStream(sessionId: string, onEvent?: (e: DomainEvent) => void) {
  const [events, setEvents] = useState<DomainEvent[]>([]);
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const cb = useRef(onEvent); cb.current = onEvent;

  useEffect(() => {
    setEvents([]); setStatus('connecting'); setLastEventAt(null);
    const es = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/stream`);
    let buf: DomainEvent[] = []; let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null; const batch = buf; buf = [];
      if (!batch.length) return;
      setEvents((prev) => mergeEvents(prev, batch)); setLastEventAt(Date.now());
      batch.forEach((e) => cb.current?.(e));
    };
    es.onopen = () => setStatus('live');
    es.onerror = () => setStatus(es.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting');
    es.addEventListener('session-event', (m) => {
      try { buf.push(JSON.parse((m as MessageEvent).data)); } catch { return; }
      if (!timer) timer = setTimeout(flush, 100);
    });
    return () => { if (timer) clearTimeout(timer); es.close(); };
  }, [sessionId]);

  return { events, status, lastEventAt };
}

/** Re-renders every second so "5s ago" labels stay honest without refetching anything. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), intervalMs); return () => clearInterval(t); }, [intervalMs]);
  return now;
}
