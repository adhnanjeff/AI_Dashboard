import type { Store } from '../storage/store.ts';

export interface HealthOptions {
  now?: () => number;
  /** How long to stop sending work to an account after a rate limit that says nothing about when it resets. */
  rateLimitCooldownMs?: number;
  /** After a provider-level error (cannot start, crashed) wait base * 2^(n-1), capped, before trying that account again. */
  backoffBaseMs?: number; backoffMaxMs?: number;
}
export interface Availability { available: boolean; until?: string; reason?: string }

// Tracks what each provider/account has REPORTED about itself. It never probes a provider and never
// retries on its own: a limited account is simply not offered work until the reported time has passed.
export class ProviderHealthService {
  private store: Store; private now: () => number;
  readonly rateLimitCooldownMs: number; private base: number; private max: number;
  constructor(store: Store, o: HealthOptions = {}) {
    this.store = store; this.now = o.now ?? Date.now;
    this.rateLimitCooldownMs = o.rateLimitCooldownMs ?? 15 * 60_000;
    this.base = o.backoffBaseMs ?? 30_000; this.max = o.backoffMaxMs ?? 10 * 60_000;
  }

  availability(provider: string, accountId = ''): Availability {
    const h = this.store.getHealth(provider, accountId);
    if (h?.limitedUntil && Date.parse(h.limitedUntil) > this.now())
      return { available: false, until: h.limitedUntil, reason: h.lastOutcome === 'rate-limited' ? `reported rate limit until ${h.limitedUntil}` : `backing off after an error until ${h.limitedUntil}` };
    return { available: true };
  }

  recordSuccess(provider: string, accountId = '') {
    if (!this.store.getHealth(provider, accountId)) return; // nothing recorded yet: nothing to clear
    this.store.saveHealth({ provider, accountId, limitedUntil: null, lastError: null, consecutiveFailures: 0, lastOutcome: 'ok' });
  }

  recordRateLimit(provider: string, accountId: string, resetsAt?: string, note?: string) {
    const prev = this.store.getHealth(provider, accountId);
    const reported = resetsAt && Date.parse(resetsAt) > this.now() ? Date.parse(resetsAt) : undefined;
    // Never shorten an existing block, and always block for at least the cool-down unless the provider gave a real reset time.
    const until = Math.max(reported ?? this.now() + this.rateLimitCooldownMs, prev?.limitedUntil ? Date.parse(prev.limitedUntil) : 0);
    this.store.saveHealth({ provider, accountId, limitedUntil: new Date(until).toISOString(), lastError: note ?? 'rate limited',
      consecutiveFailures: (prev?.consecutiveFailures ?? 0) + 1, lastOutcome: 'rate-limited' });
    this.store.audit('system', 'provider.rate_limited', `provider:${provider}${accountId ? '/' + accountId : ''}`,
      { until: new Date(until).toISOString(), reportedReset: reported ? new Date(reported).toISOString() : null, note: note ?? null });
  }

  recordError(provider: string, accountId: string, message: string) {
    const prev = this.store.getHealth(provider, accountId);
    const n = (prev?.consecutiveFailures ?? 0) + 1;
    const wait = Math.min(this.base * 2 ** (n - 1), this.max);
    this.store.saveHealth({ provider, accountId, limitedUntil: new Date(this.now() + wait).toISOString(), lastError: message,
      consecutiveFailures: n, lastOutcome: 'error' });
    this.store.audit('system', 'provider.error', `provider:${provider}${accountId ? '/' + accountId : ''}`, { message: message.slice(0, 200), backoffMs: wait, consecutiveFailures: n });
  }
}
