'use client';
import { useState, type FormEvent } from 'react';
import { api } from '../lib/api.ts';
import { usd } from '../lib/format.ts';
import { usePolling } from '../lib/hooks.ts';
import type { BudgetToday, PolicyResponse, UsageSummary } from '../lib/types.ts';
import { Ago, ErrorBanner } from './small.tsx';

const pct = (n: number | null) => (n === null ? '—' : `${Math.round(n * 100)}%`);

/** Usage & budgets: what has been spent, how trustworthy each number is, and the routing policy that governs it. */
export default function UsagePanel() {
  const [days, setDays] = useState(7);
  const today = usePolling(() => api<BudgetToday>('/routing/today'), 5000, 'today');
  const sum = usePolling(() => api<UsageSummary>(`/usage/summary?days=${days}`), 8000, `usage:${days}`);
  const pol = usePolling(() => api<PolicyResponse>('/routing/policy'), 15000, 'policy');
  const t = today.data, s = sum.data, p = pol.data;
  const seg = (v: number) => (t && t.limitUsd > 0 ? Math.min(100, (v / t.limitUsd) * 100) : 0);

  return (
    <>
      <div className="page-head">
        <h1>Usage &amp; budgets</h1>
        <p className="sub">Cost is only ever <strong>reported</strong> by the provider, or an <strong>estimate</strong> from the routing policy, and the two are always kept apart.</p>
      </div>
      <ErrorBanner error={t || s ? null : today.error ?? sum.error} what="usage" />

      {t && (
        <section className="card" aria-labelledby="today-h">
          <div className="row spread"><h2 id="today-h">Today</h2><span className="muted small">UTC day · policy v{t.policyVersion}</span></div>
          <div className="row" style={{ alignItems: 'baseline', gap: 16 }}>
            <span className="stat">{usd(t.totalUsd)}</span>
            <span className="muted">of {usd(t.limitUsd)} daily budget · {usd(t.remainingUsd)} left · {usd(t.perTaskLimitUsd)} per task</span>
          </div>
          <div className="meter" role="img" aria-label={`Spent ${usd(t.totalUsd)} of ${usd(t.limitUsd)}`}>
            <span className="m-reported" style={{ width: `${seg(t.bySource.reported)}%` }} />
            <span className="m-estimated" style={{ width: `${seg(t.bySource.estimated)}%` }} />
            <span className="m-reserved" style={{ width: `${seg(t.bySource.reserved)}%` }} />
          </div>
          <ul className="legend small">
            <li><i className="m-reported" /> Reported by the provider: {usd(t.bySource.reported)}</li>
            <li><i className="m-estimated" /> Estimated (the provider reported no cost): {usd(t.bySource.estimated)}</li>
            <li><i className="m-reserved" /> Reserved for runs still in progress: {usd(t.bySource.reserved)}</li>
          </ul>
          {t.remainingUsd <= 0 && <div className="banner warn" role="status">The daily budget is used up. New runs are refused until tomorrow (UTC) or until you raise the budget below.</div>}
        </section>
      )}

      <section className="card" aria-labelledby="sum-h">
        <div className="row spread">
          <h2 id="sum-h">Last {days} day{days === 1 ? '' : 's'}</h2>
          <label className="row small">Period
            <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: 'auto' }} aria-label="Period">
              <option value={1}>1 day</option><option value={7}>7 days</option><option value={30}>30 days</option>
            </select>
          </label>
        </div>
        {s && (
          <>
            <div className="cards">
              <div className="card stat-card tone-muted"><div className="label">Runs</div><div className="stat">{s.runs}</div></div>
              <div className="card stat-card tone-muted"><div className="label">Total cost</div><div className="stat">{usd(s.totalUsd)}</div></div>
              <div className="card stat-card tone-good"><div className="label">Per accepted task</div><div className="stat">{s.acceptedTasks.costPerAcceptedTask === null ? '—' : usd(s.acceptedTasks.costPerAcceptedTask)}</div></div>
              <div className="card stat-card tone-muted"><div className="label">Accepted tasks</div><div className="stat">{s.acceptedTasks.count}</div></div>
            </div>
            <p className="muted small">&ldquo;Per accepted task&rdquo; counts everything spent on a task, including failed attempts, divided by the tasks that finished successfully. Tokens: {s.tokens.input.toLocaleString()} in / {s.tokens.output.toLocaleString()} out ({s.tokens.note}).</p>
            {s.byModel.length === 0 ? <p className="muted">No runs in this period.</p> : (
              <table className="data">
                <caption>Quality and cost by model</caption>
                <thead><tr><th scope="col">Model</th><th scope="col">Runs</th><th scope="col">Success</th><th scope="col">Cost</th><th scope="col">Per completed run</th><th scope="col">Cost basis</th></tr></thead>
                <tbody>
                  {s.byModel.map((m) => (
                    <tr key={m.model}>
                      <td>{m.model}{m.tier && <span className="muted small"> · {m.tier}</span>}</td>
                      <td>{m.runs} <span className="muted small">({m.completed} done, {m.failed} failed)</span></td>
                      <td>{pct(m.successRate)}</td><td>{usd(m.costUsd)}</td>
                      <td>{m.costPerCompletedRun === null ? '—' : usd(m.costPerCompletedRun)}</td>
                      <td className="small">{m.reportedRuns} reported{m.estimatedRuns ? <>, <strong>{m.estimatedRuns} estimated</strong></> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <h3>Escalation</h3>
            <p className="small">{s.escalation.decisions} routing decisions · {s.escalation.escalated} escalated to a stronger model ({s.escalation.escalatedCompleted} then succeeded, {s.escalation.escalatedFailed} failed) · {s.escalation.manualOverrides} chosen by hand.</p>
            {s.escalation.paths.length > 0 && <ul className="small">{s.escalation.paths.map((x) => <li key={`${x.from}${x.to}`}>{x.from} → {x.to}: {x.runs} run(s), {x.completed} succeeded</li>)}</ul>}
          </>
        )}
      </section>

      {p && <PolicyEditor data={p} onSaved={() => { void pol.refresh(); void today.refresh(); }} />}
    </>
  );
}

function PolicyEditor({ data, onSaved }: { data: PolicyResponse; onSaved: () => void }) {
  const { policy } = data;
  const [perTask, setPerTask] = useState(String(policy.budgets.perTaskUsd)); const [daily, setDaily] = useState(String(policy.budgets.dailyUsd));
  const [after, setAfter] = useState(String(policy.escalation.afterFailures)); const [maxAtt, setMaxAtt] = useState(String(policy.escalation.maxAttemptsPerTask));
  const [note, setNote] = useState(''); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault(); setBusy(true); setMsg(null);
    try {
      const next = { ...policy, budgets: { ...policy.budgets, perTaskUsd: Number(perTask), dailyUsd: Number(daily) },
        escalation: { ...policy.escalation, afterFailures: Number(after), maxAttemptsPerTask: Number(maxAtt) } };
      const r = await api<{ version: number }>('/routing/policy', { method: 'POST', body: { policy: next, note: note.trim() || undefined } });
      setMsg({ ok: true, text: `Published policy version ${r.version}. It applies to the next run; older decisions keep the version they were made under.` }); setNote(''); onSaved();
    } catch (err) { setMsg({ ok: false, text: (err as Error).message }); } finally { setBusy(false); }
  }

  return (
    <section className="card" aria-labelledby="pol-h">
      <div className="row spread"><h2 id="pol-h">Routing policy</h2><span className="badge">version {data.version}</span></div>
      <p className="muted small">The first matching rule picks the tier. Failures move the model up one tier every {policy.escalation.afterFailures} failed attempt(s), up to {policy.escalation.maxTier}, and automatic routing stops after {policy.escalation.maxAttemptsPerTask} failed attempts.</p>
      <table className="data">
        <caption>Rules, in order</caption>
        <thead><tr><th scope="col">Rule</th><th scope="col">Tier</th><th scope="col">Why</th></tr></thead>
        <tbody>
          {policy.rules.map((r) => <tr key={r.id}><td className="mono">{r.id}</td><td>{r.tier} <span className="muted small">({policy.models[r.tier]})</span></td><td className="small">{r.reason}</td></tr>)}
          <tr><td className="muted">default</td><td>{policy.defaultTier} <span className="muted small">({policy.models[policy.defaultTier]})</span></td><td className="small muted">nothing above matched</td></tr>
        </tbody>
      </table>
      <form className="stackf" onSubmit={save}>
        <h3>Limits</h3>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <label className="field">Daily budget (USD)<input type="number" min="0.01" step="0.01" value={daily} onChange={(e) => setDaily(e.target.value)} required /></label>
          <label className="field">Per-task budget (USD)<input type="number" min="0.01" step="0.01" value={perTask} onChange={(e) => setPerTask(e.target.value)} required /></label>
          <label className="field">Escalate after (failures)<input type="number" min="1" max="10" value={after} onChange={(e) => setAfter(e.target.value)} required /></label>
          <label className="field">Stop after (failed attempts)<input type="number" min="1" max="20" value={maxAtt} onChange={(e) => setMaxAtt(e.target.value)} required /></label>
        </div>
        <label className="field">Note <span className="hint">Why you are changing it (optional)</span><input type="text" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} /></label>
        {msg && <div className={`banner ${msg.ok ? 'info' : 'bad'}`} role={msg.ok ? 'status' : 'alert'}>{msg.text}</div>}
        <div><button className="btn primary" disabled={busy} type="submit">{busy ? 'Publishing…' : 'Publish new version'}</button></div>
      </form>
      <h3>History</h3>
      <ul className="small">{data.versions.map((v) => <li key={v.version}>v{v.version} · <Ago iso={v.createdAt} /> · {v.createdBy}{v.note ? ` · ${v.note}` : ''}</li>)}</ul>
    </section>
  );
}
