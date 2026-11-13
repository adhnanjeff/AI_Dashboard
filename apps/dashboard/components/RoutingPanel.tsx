'use client';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { api } from '../lib/api.ts';
import { usePolling } from '../lib/hooks.ts';
import type { HandoffRec, ProviderView, QueueItem, SessionRouting } from '../lib/types.ts';
import { Ago } from './small.tsx';

/** Session page: why each run used its model, work waiting for capacity, and handing the session to another provider. */
export default function RoutingPanel({ sessionId, status, onChanged }: { sessionId: string; status: string; onChanged: () => void }) {
  const routing = usePolling(() => api<SessionRouting[]>(`/sessions/${sessionId}/routing`), 6000, `route:${sessionId}`);
  const handoffs = usePolling(() => api<HandoffRec[]>(`/sessions/${sessionId}/handoffs`), 6000, `hand:${sessionId}`);
  const prov = usePolling(() => api<{ providers: ProviderView[] }>('/providers'), 10000, 'providers');
  const queue = usePolling(() => api<QueueItem[]>('/queue'), 6000, 'queue');
  const [provider, setProvider] = useState(''); const [model, setModel] = useState(''); const [accountId, setAccountId] = useState(''); const [reason, setReason] = useState('');
  const [armed, setArmed] = useState(false); const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const list = prov.data?.providers ?? [];
  const last = routing.data?.length ? routing.data[routing.data.length - 1] : undefined;
  const target = provider || list.find((p) => p.provider !== last?.provider)?.provider || list[0]?.provider || '';
  const tp = list.find((p) => p.provider === target);
  const models = tp?.capabilities?.models.filter((m) => !['haiku', 'sonnet', 'opus'].includes(m)) ?? [];
  const chosenModel = model || models[0] || '';
  const accounts = tp?.accounts.filter((a) => a.account?.enabled).map((a) => a.account!) ?? [];
  const canHandoff = ['running', 'paused', 'failed'].includes(status) && (routing.data?.length ?? 0) > 0 && list.length > 0;
  const waiting = (queue.data ?? []).filter((q) => q.sessionId === sessionId && q.status === 'queued');

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!armed) { setArmed(true); return; }
    setBusy(true); setMsg(null); setArmed(false);
    try {
      const r = await api<{ handoff: HandoffRec }>(`/sessions/${sessionId}/handoff`, { method: 'POST', body: { provider: target, model: chosenModel, reason: reason.trim(), ...(accountId ? { accountId } : {}) } });
      setMsg({ ok: true, text: r.handoff.status === 'queued' ? 'The old worker was stopped and your work saved. The new provider has no capacity right now, so the move is queued.' : 'Handed off. The old worker stopped first, your changes were verified, and a fresh worker started from the checkpoint.' });
      setReason(''); onChanged(); void routing.refresh(); void handoffs.refresh(); void queue.refresh();
    } catch (err) { setMsg({ ok: false, text: (err as Error).message }); void handoffs.refresh(); } finally { setBusy(false); }
  }

  return (
    <section className="card" aria-labelledby="rt-h">
      <h2 id="rt-h">Model routing &amp; handoff</h2>
      {(routing.data ?? []).length === 0 ? <p className="muted">No runs yet. The policy chooses the model when the first run starts, and explains why here.</p> : (
        <ul className="plain">
          {[...(routing.data ?? [])].reverse().map((r) => (
            <li key={r.runId} className="small">
              <Link href={`/runs/${r.runId}`} className="mono">{r.runId.slice(4, 12)}</Link> · <strong>{r.model}</strong> <span className="muted">on {r.provider}</span>
              {r.decisions.map((d) => <div key={d.id} className="muted">{d.reason} <span className="small">(policy v{d.policyVersion})</span></div>)}
            </li>
          ))}
        </ul>
      )}
      {waiting.length > 0 && <div className="banner warn" role="status"><strong>Waiting for capacity.</strong> {waiting[0].reason}. It starts by itself when an authorised account is available. <Link href="/providers">Providers →</Link></div>}

      {canHandoff && (
        <form className="stackf" onSubmit={submit} onBlur={() => setArmed(false)}>
          <h3>Hand off to another provider</h3>
          <p className="muted small" style={{ margin: 0 }}>Stops the current worker, saves a checkpoint, verifies the repository, then starts a new worker from that checkpoint. Your uncommitted changes are never reset. Not available to move work off a rate-limited account to a sibling account.</p>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <label className="field">Provider<select value={target} onChange={(e) => { setProvider(e.target.value); setModel(''); setAccountId(''); }}>{list.map((p) => <option key={p.provider} value={p.provider}>{p.provider}{p.provider === last?.provider ? ' (current)' : ''}</option>)}</select></label>
            {models.length > 0 && <label className="field">Model<select value={chosenModel} onChange={(e) => setModel(e.target.value)}>{models.map((m) => <option key={m} value={m}>{m}</option>)}</select></label>}
            {accounts.length > 0 && <label className="field">Account<select value={accountId} onChange={(e) => setAccountId(e.target.value)}><option value="">Any authorised</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</select></label>}
          </div>
          <label className="field">Reason <span className="hint">Kept in the audit trail</span><input type="text" required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Switching to the team account" /></label>
          {msg && <div className={`banner ${msg.ok ? 'info' : 'bad'}`} role={msg.ok ? 'status' : 'alert'}>{msg.text}</div>}
          <div><button type="submit" className={`btn${armed ? ' danger armed' : ' primary'}`} disabled={busy || !chosenModel && models.length > 0}>{busy ? 'Handing off…' : armed ? 'Click again: stop the worker and hand off' : 'Hand off'}</button></div>
        </form>
      )}

      {(handoffs.data ?? []).length > 0 && (
        <>
          <h3>Handoff history</h3>
          <ul className="plain small">
            {(handoffs.data ?? []).map((h) => (
              <li key={h.id}><strong>{h.status}</strong> → {h.toProvider} ({h.toModel}) · <Ago iso={h.createdAt} /> · {h.reason}
                <div className="muted">{h.notes.join(' · ')}</div></li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
