import type { ProviderAdapter, ProviderCapabilities } from '../runtime/adapters/types.ts';

// The set of execution adapters this orchestrator can use. Everything provider-specific stays behind the
// ProviderAdapter contract; the scheduler only reads `capabilities` and the supervisor only calls `launch`.
export class ProviderRegistry {
  private adapters = new Map<string, ProviderAdapter>();
  constructor(adapters: ProviderAdapter[] = []) { adapters.forEach((a) => this.register(a)); }

  register(a: ProviderAdapter) {
    if (this.adapters.has(a.provider)) throw new Error(`provider already registered: ${a.provider}`);
    this.adapters.set(a.provider, a);
  }
  get(provider: string): ProviderAdapter | undefined { return this.adapters.get(provider); }
  list(): ProviderAdapter[] { return [...this.adapters.values()]; }
  /** The first registered adapter: used when a caller names no provider and no policy applies. */
  get default(): ProviderAdapter { const a = this.adapters.values().next().value; if (!a) throw new Error('no provider adapter registered'); return a; }
  capabilities(provider: string): ProviderCapabilities | undefined { return this.adapters.get(provider)?.capabilities; }
  /** An adapter that declares no model list accepts any model id (test doubles, simple wrappers). */
  supports(provider: string, model: string): boolean {
    const c = this.capabilities(provider); return !c || c.models.length === 0 || c.models.includes(model);
  }
  static of(x: ProviderAdapter | ProviderRegistry): ProviderRegistry { return x instanceof ProviderRegistry ? x : new ProviderRegistry([x]); }
}
