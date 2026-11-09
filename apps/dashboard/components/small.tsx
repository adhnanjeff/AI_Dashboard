'use client';
import { useNow } from '../lib/hooks.ts';
import { relativeTime } from '../lib/format.ts';
import { stateMeta } from '../lib/status.ts';
import type { StreamStatus } from '../lib/hooks.ts';

export function StatusBadge({ state, pulse }: { state: string; pulse?: boolean }) {
  const m = stateMeta(state);
  return (
    <span className={`badge tone-${m.tone}${pulse && state === 'running' ? ' pulse' : ''}`}>
      <span aria-hidden="true">{m.glyph}</span>{m.label}
    </span>
  );
}

/** "5s ago" that keeps ticking. Rendered after mount only, so server and client HTML never disagree. */
export function Ago({ iso, ms }: { iso?: string | null; ms?: number | null }) {
  const now = useNow();
  const value = iso ?? (ms ? new Date(ms).toISOString() : null);
  return <time dateTime={value ?? undefined} suppressHydrationWarning>{relativeTime(value, now)}</time>;
}

const STREAM_TEXT: Record<StreamStatus, { text: string; tone: string }> = {
  connecting: { text: 'Connecting to live updates…', tone: 'muted' },
  live: { text: 'Live', tone: 'good' },
  reconnecting: { text: 'Reconnecting — data may be stale', tone: 'warn' },
  closed: { text: 'Live updates stopped', tone: 'bad' },
};
export function StreamBadge({ status }: { status: StreamStatus }) {
  const s = STREAM_TEXT[status];
  return <span className={`badge tone-${s.tone}`} role="status"><span aria-hidden="true">{status === 'live' ? '●' : '○'}</span>{s.text}</span>;
}

export function ErrorBanner({ error, what }: { error: Error | null; what: string }) {
  if (!error) return null;
  return <div className="banner bad" role="alert">Could not load {what}: {error.message}</div>;
}
