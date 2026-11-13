import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { ProviderAccount, ProviderHealth } from '../domain/types.ts';
import type { Store } from '../storage/store.ts';
import type { ProviderCapabilities } from '../runtime/adapters/types.ts';
import type { ProviderHealthService, Availability } from './health.ts';
import type { ProviderRegistry } from './registry.ts';

export class ProviderError extends Error {
  status: number; details?: unknown;
  constructor(status: number, msg: string, details?: unknown) { super(msg); this.status = status; this.details = details; }
}

export interface Candidate { accountId: string | null; label: string; priority: number; availability: Availability }

const ENV_REF = /^[A-Z][A-Z0-9_]{2,63}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;

// Accounts are references to something the USER has already set up and authorised:
//  - a separate login profile directory for the CLI, and/or
//  - the NAME of an environment variable that holds an API key (supplied by the user's secrets manager).
// The key itself is never accepted, stored, logged or returned: only its name is. Anything that does not look
// like a variable name is refused, so a pasted key cannot end up in the database by accident.
export class ProviderService {
  private store: Store; private registry: ProviderRegistry; private health: ProviderHealthService; private env: NodeJS.ProcessEnv;
  constructor(store: Store, registry: ProviderRegistry, health: ProviderHealthService, env: NodeJS.ProcessEnv = process.env) {
    this.store = store; this.registry = registry; this.health = health; this.env = env;
  }

  addAccount(i: { provider: string; label: string; configDir?: string; credentialRef?: string; priority?: number }, actor = 'user'): ProviderAccount {
    const adapter = this.registry.get(i.provider); if (!adapter) throw new ProviderError(400, `unknown provider: ${i.provider}`);
    if (typeof i.label !== 'string' || !LABEL.test(i.label)) throw new ProviderError(400, 'label must be 1-40 letters, digits, spaces, dots, dashes or underscores');
    const caps: ProviderCapabilities | undefined = adapter.capabilities;
    if (i.configDir !== undefined && i.configDir !== '') {
      if (!caps?.configDirEnv) throw new ProviderError(400, `${i.provider} does not support separate login profiles`);
      if (!isAbsolute(i.configDir)) throw new ProviderError(400, 'configDir must be an absolute path');
      let ok = false; try { ok = statSync(i.configDir).isDirectory(); } catch { /* missing */ }
      if (!ok) throw new ProviderError(400, 'configDir must be an existing directory');
    }
    if (i.credentialRef !== undefined && i.credentialRef !== '') {
      if (!caps?.credentialEnv) throw new ProviderError(400, `${i.provider} does not take an API credential`);
      if (!ENV_REF.test(i.credentialRef)) throw new ProviderError(400, 'credentialRef must be the NAME of an environment variable (for example WORK_CLAUDE_KEY). Never paste a key here.');
    }
    const priority = i.priority === undefined ? 0 : Number(i.priority);
    if (!Number.isInteger(priority) || priority < -100 || priority > 100) throw new ProviderError(400, 'priority must be an integer from -100 to 100');
    let acc: ProviderAccount;
    try { acc = this.store.createAccount({ provider: i.provider, label: i.label, configDir: i.configDir || undefined, credentialRef: i.credentialRef || undefined, priority }); }
    catch (e: any) { if (/UNIQUE/.test(String(e?.message))) throw new ProviderError(409, `an account labelled "${i.label}" already exists for ${i.provider}`); throw e; }
    this.store.audit(actor, 'account.added', `account:${acc.id}`, { provider: acc.provider, label: acc.label, hasConfigDir: !!acc.configDir, credentialRef: acc.credentialRef, priority });
    return acc;
  }

  setEnabled(id: string, enabled: boolean, actor = 'user'): ProviderAccount {
    const a = this.store.getAccount(id); if (!a) throw new ProviderError(404, 'account not found');
    this.store.setAccountEnabled(id, enabled);
    this.store.audit(actor, enabled ? 'account.enabled' : 'account.disabled', `account:${id}`, { provider: a.provider, label: a.label });
    return this.store.getAccount(id)!;
  }

  /** Environment for ONE launch. The secret value is read now, handed to the child process, and not kept. */
  launchEnv(accountId: string | null, provider: string): Record<string, string> {
    if (!accountId) return {};
    const a = this.store.getAccount(accountId); if (!a || a.provider !== provider) throw new ProviderError(400, 'account does not belong to that provider');
    const caps = this.registry.capabilities(provider); const out: Record<string, string> = {};
    if (a.configDir && caps?.configDirEnv) out[caps.configDirEnv] = a.configDir;
    if (a.credentialRef && caps?.credentialEnv) {
      const v = this.env[a.credentialRef];
      if (!v) throw new ProviderError(409, `credential variable ${a.credentialRef} is not set in the orchestrator's environment`);
      out[caps.credentialEnv] = v;
    }
    return out;
  }

  /**
   * Who could take work for this provider right now, best first. If the user registered accounts, ONLY those are used
   * (enabled ones, by priority then least recently used); otherwise the CLI's own login is the single implicit account.
   */
  candidates(provider: string): Candidate[] {
    const accounts = this.store.listAccounts(provider);
    if (!accounts.length) return [{ accountId: null, label: 'default login', priority: 0, availability: this.availabilityOf(provider, null) }];
    return accounts.filter((a) => a.enabled)
      .sort((a, b) => b.priority - a.priority || (a.lastUsedAt ?? '').localeCompare(b.lastUsedAt ?? ''))
      .map((a) => ({ accountId: a.id, label: a.label, priority: a.priority, availability: this.availabilityOf(provider, a.id) }));
  }

  /**
   * Availability of one account. An account is also unavailable while ANOTHER account of the same provider has a
   * reported rate limit: accounts exist to keep separate things separate, not to rotate around a limit.
   */
  availabilityOf(provider: string, accountId: string | null): Availability {
    const own = this.health.availability(provider, accountId ?? '');
    if (!own.available) return own;
    for (const a of this.store.listAccounts(provider)) {
      if (a.id === accountId) continue;
      const h = this.health.availability(provider, a.id);
      const hr = this.store.getHealth(provider, a.id);
      if (!h.available && hr?.lastOutcome === 'rate-limited')
        return { available: false, until: h.until, reason: `another ${provider} account (${a.label}) reported a rate limit until ${h.until}; accounts are not rotated to get around a limit` };
    }
    return own;
  }

  overview() {
    const healthBy = new Map<string, ProviderHealth>(this.store.listHealth().map((h) => [`${h.provider}/${h.accountId}`, h]));
    return this.registry.list().map((a) => {
      const accounts = this.store.listAccounts(a.provider);
      const view = (acc: ProviderAccount | null) => ({ account: acc, health: healthBy.get(`${a.provider}/${acc?.id ?? ''}`) ?? null, availability: this.health.availability(a.provider, acc?.id ?? '') });
      return { provider: a.provider, capabilities: a.capabilities ?? null,
        mode: accounts.length ? 'registered-accounts' : 'default-login',
        accounts: accounts.length ? accounts.map(view) : [view(null)] };
    });
  }
}
