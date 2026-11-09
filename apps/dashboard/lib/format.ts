export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const t = Date.parse(iso); if (Number.isNaN(t)) return '—';
  const s = Math.round((now - t) / 1000);
  if (s < 0) return 'just now';
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function duration(start: string | null | undefined, end: string | null | undefined, now = Date.now()): string {
  if (!start) return '—';
  const a = Date.parse(start); const b = end ? Date.parse(end) : now;
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return '—';
  const s = Math.round((b - a) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const usd = (n: number) => `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
