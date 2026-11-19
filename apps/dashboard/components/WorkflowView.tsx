'use client';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '../lib/api.ts';
import { usd } from '../lib/format.ts';
import { usePolling } from '../lib/hooks.ts';
import type { WorkflowDetail, WorkflowEvidence, WorkflowTransition } from '../lib/types.ts';
import { Ago, ErrorBanner } from './small.tsx';
import { WfBadge } from './Workflows.tsx';

const KIND: Record<string, string> = { agent: 'Agent', check: 'Check', review: 'Review', integrate: 'Combine', approval: 'Approval', merge_ready: 'Merge readiness' };

/** One workflow: the plan, who is doing what, the evidence for every decision, and the approval gate. */
export default function WorkflowView({ id }: { id: string }) {
  const wf = usePolling(() => api<WorkflowDetail>(`/workflows/${id}`), 1500, `wf:${id}`);
  const tr = usePolling(() => api<WorkflowTransition[]>(`/workflows/${id}/transitions`), 2500, `wft:${id}`);
  const ev = usePolling(() => api<WorkflowEvidence[]>(`/workflows/${id}/evidence?full=1`), 3000, `wfe:${id}`);
  const [approver, setApprover] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const d = wf.data;

  async function act(path: string, body: unknown = {}) {
    setBusy(true); setError(null);
    try { await api(`/workflows/${id}${path}`, { method: 'POST', body }); await Promise.all([wf.refresh(), tr.refresh(), ev.refresh()]); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  if (!d) return <><div className="page-head"><h1>Workflow</h1></div><ErrorBanner error={wf.error} what="this workflow" />{!wf.error && <p className="muted">Loading…</p>}</>;
  const w = d.workflow; const pending = d.approvals.find((a) => a.status === 'pending'); const open = w.status === 'draft' || w.status === 'running';

  return (
    <>
      <div className="page-head">
        <div className="row spread">
          <h1>{w.title}</h1>
          <div className="row"><WfBadge status={w.status} />
            {w.status === 'draft' && <button className="btn primary" disabled={busy} onClick={() => void act('/start')}>Start</button>}
            {open && w.status === 'running' && <button className="btn danger" disabled={busy} onClick={() => void act('/cancel')}>Cancel</button>}
          </div>
        </div>
        <p className="sub">{w.goal}</p>
        <p className="muted small" style={{ margin: 0 }}><Link href="/workflows">← All workflows</Link> · up to {w.definition.concurrency} steps at once · started by {w.createdBy} · <a href={`/api/workflows/${id}/record`} target="_blank" rel="noreferrer">Full audit record (JSON)</a></p>
      </div>
      <ErrorBanner error={wf.data ? null : wf.error} what="this workflow" />
      {error && <div className="banner bad" role="alert">{error}</div>}
      {w.status === 'failed' && w.haltedReason && <div className="banner bad" role="alert"><strong>Stopped.</strong> {w.haltedReason}</div>}
      {w.status === 'completed' && <div className="banner info" role="status"><strong>Ready to merge.</strong> Every step passed and a person approved. Merging is still yours to do: the combined work is on the branch shown under the Combine step.</div>}

      {pending && (
        <section className="card" aria-labelledby="appr-h" style={{ borderLeft: '4px solid var(--red)' }}>
          <h2 id="appr-h">Your approval is needed</h2>
          <p style={{ marginTop: 0 }}><strong>{pending.action}</strong></p>
          <p className="muted small">Read the evidence below first: check results, review findings and the merge check. Approving records your name; it does not merge anything.</p>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <label className="field" style={{ minWidth: 220 }}>Your name<input type="text" value={approver} onChange={(e) => setApprover(e.target.value)} placeholder="Who is approving" /></label>
            <button className="btn primary" disabled={busy || !approver.trim()} onClick={() => void act(`/steps/${pending.step}/approve`, { approver: approver.trim() })}>Approve</button>
            <button className="btn danger" disabled={busy || !approver.trim()} onClick={() => void act(`/steps/${pending.step}/reject`, { approver: approver.trim() })}>Reject and stop</button>
          </div>
        </section>
      )}

      <section className="card" aria-labelledby="steps-h">
        <h2 id="steps-h">Plan and progress</h2>
        <table className="data">
          <thead><tr><th scope="col">Step</th><th scope="col">Needs</th><th scope="col">Status</th><th scope="col">Tries</th><th scope="col">Model and cost</th><th scope="col">Detail</th></tr></thead>
          <tbody>
            {d.steps.map((s) => (
              <tr key={s.id}>
                <td><strong className="mono">{s.id}</strong><div className="muted small">{KIND[s.kind] ?? s.kind}{s.role ? ` · ${s.role}` : ''}</div></td>
                <td className="small">{s.needs.length ? s.needs.join(', ') : <span className="muted">nothing</span>}</td>
                <td><WfBadge status={s.state.status} /></td>
                <td className="small">{s.state.attempts}{s.kind !== 'approval' && s.kind !== 'merge_ready' ? ` of ${s.maxAttempts}` : ''}</td>
                <td className="small">{s.run ? <>{s.run.model}<div className="muted">{s.run.costUsd === null ? 'cost not reported' : usd(s.run.costUsd)}</div></> : <span className="muted">—</span>}</td>
                <td className="small">
                  {s.state.sessionId && <Link href={`/sessions/${s.state.sessionId}`}>Session</Link>}
                  {s.state.runId && <> · <Link href={`/runs/${s.state.runId}`}>Run</Link></>}
                  {s.command && <div className="mono muted">{s.command.map((c) => c.split(/[\\/]/).pop()).join(' ')}</div>}
                  {s.state.detail.branch && <div className="mono muted">{s.state.detail.branch}</div>}
                  {s.state.detail.failure && <div style={{ color: 'var(--bad)' }}>{String(s.state.detail.failure).split('\n')[0].slice(0, 140)}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <div className="grid-2">
        <section className="card" aria-labelledby="hist-h">
          <h2 id="hist-h">History</h2>
          <p className="muted small" style={{ marginTop: 0 }}>Every change of state, in order. Corrections and retries are listed here with the reason.</p>
          <ol className="timeline" style={{ listStyle: 'none' }}>
            {[...(tr.data ?? [])].reverse().slice(0, 120).map((t) => (
              <li key={t.id}><span className="t"><Ago iso={t.at} /></span><span className={`dot ${/failed|cancel/.test(t.toStatus) ? 'bad' : t.toStatus === 'passed' || t.toStatus === 'completed' ? 'good' : /correction|retry/.test(t.reason) ? 'warn' : 'muted'}`} aria-hidden="true">•</span>
                <span className="detail"><strong>{t.stepKey ?? 'workflow'}</strong> {t.fromStatus ? `${t.fromStatus} → ` : ''}{t.toStatus}<br />{t.reason}</span></li>
            ))}
          </ol>
        </section>
        <section className="card" aria-labelledby="evid-h">
          <h2 id="evid-h">Evidence</h2>
          <p className="muted small" style={{ marginTop: 0 }}>What each step produced: command output, review findings, merge checks, the approval itself. Kept permanently; it cannot be edited.</p>
          {(ev.data ?? []).filter((e) => e.stepKey !== '*').length === 0 ? <p className="muted">Nothing yet.</p> : (
            <ul className="plain">
              {[...(ev.data ?? [])].filter((e) => e.stepKey !== '*').reverse().slice(0, 60).map((e) => (
                <li key={e.id}>
                  <details>
                    <summary className="small"><span className="mono">{e.stepKey}</span> · {e.kind}{e.attempt ? ` (try ${e.attempt})` : ''} · {e.summary}</summary>
                    <pre className="log" style={{ maxHeight: 260, marginTop: 6 }}>{prettyEvidence(e.content ?? '')}</pre>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}

function prettyEvidence(c: string) {
  try { const j = JSON.parse(c); if (j && typeof j === 'object') { if (typeof j.output === 'string') return `${j.command ? `$ ${(j.command as string[]).join(' ')}\n` : ''}exit ${j.exitCode}\n\n${j.output}`; return JSON.stringify(j, null, 2); } } catch { /* plain text */ }
  return c;
}
