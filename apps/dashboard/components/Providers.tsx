'use client';
import { useState, type FormEvent } from 'react';
import { api } from '../lib/api.ts';
import { usePolling } from '../lib/hooks.ts';
import type { AuditEntry, ProviderView, QueueItem } from '../lib/types.ts';
import { Ago, ErrorBanner } from './small.tsx';

/** Providers: which execution adapters exist, which accounts you have authorised, what each has reported, and the queue. */
export default function Providers() {
  const prov = usePolling(() => api<{ providers: ProviderView[]; queued: number }>('/providers'), 5000, 'providers');
  const queue = usePolling(() => api<QueueItem[]>('/queue'), 5000, 'queue');
  const audit = usePolling(() => api<AuditEntry[]>('/audit?limit=30'), 8000, 'audit');
  const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [note, setNote] = useState<string | null>(null);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true); setError(null); setNote(null);
    try { await fn(); await Promise.all([prov.refresh(), queue.refresh(), audit.refresh()]); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const providers = prov.data?.providers ?? [];

  return (
    <>
      <div className="page-head">
        <h1>Providers &amp; accounts</h1>
        <p className="sub">Work only ever runs on an adapter or account you have registered. If one reports a rate limit it is left alone until the reported time; accounts are never rotated to get around a limit.</p>
      </div>
      <ErrorBanner error={prov.data ? null : prov.error} what="providers" />
      {error && <div className="banner bad" role="alert">{error}</div>}
      {note && <div className="banner info" role="status">{note}</div>}

      {providers.map((p) => (
        <section className="card" key={p.provider} aria-label={p.provider}>
          <div className="row spread"><h2>{p.capabilities?.displayName ?? p.provider} <span className="muted small mono">{p.provider}</span></h2>
            <span className="badge">{p.mode === 'default-login' ? 'default login' : 'registered accounts'}</span></div>
          <p className="small muted" style={{ marginTop: 0 }}>
            {p.capabilities ? <>Models: {p.capabilities.models.join(', ')} · {p.capabilities.canEditFiles ? 'can edit files' : 'read-only'} · {p.capabilities.supportsNativeResume ? 'can continue its own conversation (same account only)' : 'portable resume only'}</> : 'This adapter declares no capabilities, so any model id is accepted.'}
          </p>
          <table className="data">
            <thead><tr><th scope="col">Account</th><th scope="col">Status</th><th scope="col">Credential</th><th scope="col">Used</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {p.accounts.map(({ account, health, availability }) => (
                <tr key={account?.id ?? 'default'}>
                  <td>{account ? <>{account.label} <span className="muted small">priority {account.priority}</span></> : <span>Default login <span className="muted small">(the CLI&apos;s own sign-in)</span></span>}</td>
                  <td className="small">
                    {account && !account.enabled ? <span className="badge tone-muted">disabled</span>
                      : availability.available ? <span className="badge tone-good">available</span>
                      : <><span className="badge tone-warn">waiting</span> <span className="muted">{availability.reason}</span></>}
                    {health?.lastError && !availability.available && <div className="muted">{health.lastError}</div>}
                  </td>
                  <td className="small mono">{account?.credentialRef ? `$${account.credentialRef}` : account?.configDir ? 'login profile' : '—'}</td>
                  <td className="small">{account?.lastUsedAt ? <Ago iso={account.lastUsedAt} /> : <span className="muted">never</span>}</td>
                  <td>{account && <button className="btn" disabled={busy} onClick={() => void act(() => api(`/providers/accounts/${account.id}/enabled`, { method: 'POST', body: { enabled: !account.enabled } }))}>{account.enabled ? 'Disable' : 'Enable'}</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}

      <AddAccount providers={providers} disabled={busy} onAdd={(b) => act(() => api('/providers/accounts', { method: 'POST', body: b }))} />

      <section className="card" aria-labelledby="q-h">
        <div className="row spread">
          <h2 id="q-h">Waiting for capacity</h2>
          <button className="btn" disabled={busy} onClick={() => void act(async () => { const r = await api<{ started: string[]; stillQueued: number }>('/queue/drain', { method: 'POST', body: {} }); setNote(`${r.started.length} started, ${r.stillQueued} still waiting.`); })}>Check capacity now</button>
        </div>
        <p className="muted small" style={{ marginTop: 0 }}>Work that could not start because no authorised account was available. It is checked again every 30 seconds; it is never sent to a limited account.</p>
        {(queue.data ?? []).length === 0 ? <p className="muted">Nothing is waiting.</p> : (
          <table className="data">
            <thead><tr><th scope="col">Queued</th><th scope="col">Status</th><th scope="col">Why</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {(queue.data ?? []).map((q) => (
                <tr key={q.id}>
                  <td><Ago iso={q.createdAt} /></td><td>{q.status}{q.attempts ? <span className="muted small"> · checked {q.attempts}×</span> : null}</td>
                  <td className="small">{q.reason}</td>
                  <td>{q.status === 'queued' && <button className="btn" disabled={busy} onClick={() => void act(() => api(`/queue/${q.id}/cancel`, { method: 'POST', body: {} }))}>Cancel</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card" aria-labelledby="a-h">
        <h2 id="a-h">Audit trail</h2>
        <p className="muted small" style={{ marginTop: 0 }}>Account changes, policy changes, rate limits and handoffs. Append-only.</p>
        {(audit.data ?? []).length === 0 ? <p className="muted">Nothing recorded yet.</p> : (
          <table className="data"><thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">What</th><th scope="col">Detail</th></tr></thead>
            <tbody>{(audit.data ?? []).map((a) => <tr key={a.id}><td><Ago iso={a.at} /></td><td>{a.actor}</td><td className="mono small">{a.action}</td><td className="small muted" style={{ overflowWrap: 'anywhere' }}>{a.subject} {Object.keys(a.details).length ? JSON.stringify(a.details).slice(0, 140) : ''}</td></tr>)}</tbody></table>
        )}
      </section>
    </>
  );
}

function AddAccount({ providers, disabled, onAdd }: { providers: ProviderView[]; disabled: boolean; onAdd: (b: Record<string, unknown>) => Promise<void> }) {
  const [provider, setProvider] = useState(''); const [label, setLabel] = useState(''); const [configDir, setConfigDir] = useState('');
  const [credentialRef, setCredentialRef] = useState(''); const [priority, setPriority] = useState('0');
  const chosen = provider || providers[0]?.provider || '';
  const caps = providers.find((p) => p.provider === chosen)?.capabilities;
  async function submit(e: FormEvent) {
    e.preventDefault();
    await onAdd({ provider: chosen, label: label.trim(), priority: Number(priority), ...(configDir.trim() ? { configDir: configDir.trim() } : {}), ...(credentialRef.trim() ? { credentialRef: credentialRef.trim() } : {}) });
    setLabel(''); setConfigDir(''); setCredentialRef('');
  }
  if (!providers.length) return null;
  return (
    <section className="card" aria-labelledby="add-h">
      <h2 id="add-h">Authorise an account</h2>
      <p className="muted small" style={{ marginTop: 0 }}>Register an account you already own and have signed in to. Only references are stored: a login-profile folder and/or the <em>name</em> of an environment variable that holds an API key. Never paste a key here: it is refused.</p>
      <form className="stackf" onSubmit={submit}>
        <label className="field">Provider<select value={chosen} onChange={(e) => setProvider(e.target.value)}>{providers.map((p) => <option key={p.provider} value={p.provider}>{p.provider}</option>)}</select></label>
        <label className="field">Label<input type="text" required maxLength={40} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Work account" /></label>
        {caps?.configDirEnv && <label className="field">Login profile folder <span className="hint">Optional. Absolute path to a folder this CLI was signed in with.</span><input type="text" value={configDir} onChange={(e) => setConfigDir(e.target.value)} placeholder="C:/Users/you/.claude-work" /></label>}
        {caps?.credentialEnv && <label className="field">API key variable name <span className="hint">Optional. The NAME of an environment variable set where the orchestrator runs.</span><input type="text" value={credentialRef} onChange={(e) => setCredentialRef(e.target.value)} placeholder="WORK_CLAUDE_KEY" /></label>}
        <label className="field">Priority <span className="hint">Higher is used first.</span><input type="number" min={-100} max={100} value={priority} onChange={(e) => setPriority(e.target.value)} /></label>
        <div><button className="btn primary" type="submit" disabled={disabled}>Add account</button></div>
      </form>
    </section>
  );
}
