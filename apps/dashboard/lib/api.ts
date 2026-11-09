import type { DomainEvent } from './types.ts';

export class ApiError extends Error {
  status: number; body: any;
  constructor(status: number, message: string, body?: any) { super(message); this.status = status; this.body = body; }
}

export async function api<T>(path: string, init: { method?: 'GET' | 'POST'; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: init.method ?? 'GET', cache: 'no-store',
      headers: { ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...init.headers },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch { throw new ApiError(0, 'Cannot reach the dashboard server.'); }
  const text = await res.text(); let json: any; try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) throw new ApiError(res.status, json?.error ?? (text.slice(0, 200) || res.statusText), json);
  return json as T;
}

export async function apiText(path: string): Promise<string> {
  const res = await fetch(`/api${path}`, { cache: 'no-store' });
  if (!res.ok) { let m = res.statusText; try { m = (await res.json()).error ?? m; } catch { /* ignore */ } throw new ApiError(res.status, m); }
  return res.text();
}

/** A fresh key per user action; reused if that same action is retried, so a retry cannot start a second run. */
export const newIdempotencyKey = () => `ui-${crypto.randomUUID()}`;
export type { DomainEvent };
