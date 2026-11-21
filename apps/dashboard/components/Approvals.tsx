'use client';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '../lib/api.ts';
import { usePolling } from '../lib/hooks.ts';
import type { ApprovalRisk, ApprovalView, ApprovalViewState, PolicyInfo } from '../lib/types.ts';
import { Ago, ErrorBanner } from './small.tsx';

const STATE: Record<ApprovalViewState, { label: string; glyph: string; tone: string }> = {
  pending: { label: 'Needs you', glyph: '!', tone: 'warn' }, approved: { label: 'Approved, not used yet', glyph: '✓', tone: 'info' }, used: { label: 'Approved and used', glyph: '✓', tone: 'good' },
  rejected: { label: 'Rejected', glyph: '✕', tone: 'bad' }, expired: { label: 'Expired', glyph: '–', tone: 'muted' },
};
const RISK_TONE: Record<string, string> = { high: 'bad', medium: 'warn', info: 'muted' };
const short = (s?: string | null) => (s ?? '').slice(0, 8);
const Badge = ({ s }: { s: ApprovalViewState }) => <span className={`badge tone-${STATE[s].tone}`}><span aria-hidden="true">{STATE[s].glyph}</span> {STATE[s].label}</span>;

/** The approval inbox: what is being asked, the evidence in one place, and the decision. The decision is enforced by the server. */
export default function Approvals() {
  const list = usePolling(() => api<ApprovalView[]>('/approvals?limit=200'), 3000, 'approvals');
  const policy = usePolling(() => api<PolicyInfo>('/policy'), 60000, 'policy');
  const [tab, setTab] = useState<'open' | 'history'>('open'); const [sel, setSel] = useState<string | null>(null);
  const all = list.data ?? []; const open = all.filter((a) => a.state === 'pending' || (a.state === 'approved' && /^merge\./.test(a.action)));
  const rows = tab === 'open' ? open : all.filter((a) => !open.includes(a));
  const cur = all.find((a) => a.id === sel) ?? rows[0] ?? null;

  return (
    <>
      <div className="page-head">
        <h1>Approvals</h1>
        <p className="sub">Everything that needs a person: merges into protected branches, discarding unsaved work, and giving an agent more than file access. The decision is checked by the server; an agent saying it was approved changes nothing.</p>
      </div>
      <ErrorBanner error={list.data ? null : list.error} what="approvals" />
      <div className="row" style={{ marginBottom: 12 }}>
        <div className="seg two" role="group" aria-label="Show">
          <button type="button" aria-pressed={tab === 'open'} onClick={() => setTab('open')}>Open ({open.length})</button>
          <button type="button" aria-pressed={tab === 'history'} onClick={() => setTab('history')}>History</button>
        </div>
      </div>
      <div className="appr-layout">
        <section className="card" aria-label="Requests">
          {rows.length === 0 ? <p className="muted">{tab === 'open' ? 'Nothing is waiting for you.' : 'No past decisions yet.'}</p> : (
            <ul className="plain appr-list">
              {rows.map((a) => (
                <li key={a.id}><button type="button" className={`appr-row${cur?.id === a.id ? ' on' : ''}`} onClick={() => setSel(a.id)} aria-pressed={cur?.id === a.id}>
                  <span className="nm">{a.actionLabel ?? a.action}</span>
                  <span className="muted small">{a.subject ? a.subject.slice(0, 70) : a.sessionTitle}</span>
                  <span className="row small" style={{ gap: 8 }}><Badge s={a.state} /><span className="muted"><Ago iso={a.createdAt} /></span></span>
                </button></li>
              ))}
            </ul>
          )}
        </section>
        {cur ? <Detail key={cur.id} a={cur} onDone={() => list.refresh()} /> : <section className="card"><h2>Select a request</h2><p className="muted">Pick a request to see the evidence behind it.</p></section>}
      </div>
      <PolicyPanel p={policy.data} err={policy.data ? null : policy.error} />
    </>
  );
}

function Detail({ a, onDone }: { a: ApprovalView; onDone: () => void }) {
  const [who, setWho] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const [ok, setOk] = useState<string | null>(null);
  const ev = a.evidence; const risks: ApprovalRisk[] = ev.risks ?? ev.readiness?.risks ?? [];
  async function act(path: string, body: unknown, done?: string) {
    setBusy(true); setErr(null); setOk(null);
    try { await api(`/approvals/${a.id}/${path}`, { method: 'POST', body }); if (done) setOk(done); onDone(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  const mergeable = /^merge\./.test(a.action) && a.state === 'approved';
  return (
    <section className="card appr-detail" aria-label="Request details">
      <div className="row spread"><h2 style={{ margin: 0 }}>{a.actionLabel ?? a.action}</h2><Badge s={a.state} /></div>
      {a.risk && <div className="banner warn" role="note"><strong>Why this needs a person.</strong> {a.risk}</div>}
      <dl className="kv">
        <dt>Asked by</dt><dd>{a.requestedBy ?? 'the workflow engine'} · <Ago iso={a.createdAt} /></dd>
        <dt>For</dt><dd>{a.sessionTitle ?? a.sessionId}</dd>
        {a.subject && <><dt>Exactly</dt><dd className="mono">{a.subject}</dd></>}
        {a.expiresAt && <><dt>{a.state === 'pending' ? 'Expires' : 'Window'}</dt><dd>{new Date(a.expiresAt).toLocaleString()}</dd></>}
        {a.approver && <><dt>Decided by</dt><dd>{a.approver}{a.decidedAt ? <> · <Ago iso={a.decidedAt} /></> : null}{a.decidedVia ? <span className="muted"> ({a.decidedVia === 'human-token' ? 'through the dashboard' : a.decidedVia})</span> : null}</dd></>}
        {a.consumedAt && <><dt>Used</dt><dd><Ago iso={a.consumedAt} /> by {a.consumedBy}</dd></>}
      </dl>

      {risks.length > 0 && (<><h3>Risks</h3><ul className="plain">{risks.map((r, i) => <li key={i}><span className={`badge tone-${RISK_TONE[r.level]}`}>{r.level}</span> {r.text}</li>)}</ul></>)}

      {ev.kind === 'merge' && (<>
        <h3>Change</h3>
        <p className="small" style={{ margin: 0 }}><span className="mono">{ev.branch}</span> → <span className="mono">{ev.target}</span> at <span className="mono">{short(ev.head)}</span>. {ev.diff.files.length} file(s), <span className="adds">+{ev.diff.added}</span> <span className="dels">−{ev.diff.deleted}</span>. Merge check: {ev.mergeCheck.clean ? 'clean' : `conflicts in ${ev.mergeCheck.conflicts.join(', ')}`}.</p>
        {ev.diff.files.length > 0 && <table className="data" style={{ marginTop: 8 }}><thead><tr><th scope="col">File</th><th scope="col">Added</th><th scope="col">Removed</th></tr></thead><tbody>
          {ev.diff.files.slice(0, 40).map((f: any) => <tr key={f.path}><td className="mono">{f.path}</td><td className="adds">{f.added ?? 'binary'}</td><td className="dels">{f.deleted ?? ''}</td></tr>)}</tbody></table>}
        <h3>Test evidence</h3>
        {ev.tests.length === 0 ? <p className="muted small" style={{ margin: 0 }}>None recorded.</p> : <ul className="plain small">{ev.tests.map((t: any) => <li key={t.step}><span className={`badge tone-${t.passed ? 'good' : 'bad'}`}>{t.passed ? 'passed' : 'not passed'}</span> <span className="mono">{t.step}</span> {t.summary}</li>)}</ul>}
        <h3>Reviewer findings left unresolved</h3>
        {ev.findings.length === 0 ? <p className="muted small" style={{ margin: 0 }}>None recorded.</p> : <ul className="plain small">{ev.findings.map((f: any, i: number) => <li key={i}><span className="badge tone-warn">{f.severity}</span> <span className="mono">{f.path}</span> {f.message}</li>)}</ul>}
        <h3>CI and branch protection</h3>
        <p className="small" style={{ margin: 0 }}><span className={`badge tone-${ev.ci.state === 'success' ? 'good' : ev.ci.state === 'unknown' ? 'muted' : 'bad'}`}>{ev.ci.state}</span> {ev.ci.detail}</p>
      </>)}
      {ev.kind === 'discard' && (<>
        <h3>What will be lost</h3>
        <ul className="plain mono small">{(ev.uncommitted as string[]).map((f) => <li key={f}>{f}</li>)}</ul>
        <p className="muted small">{ev.unmergedCommits} commit(s) stay on branch <span className="mono">{ev.branch}</span>.</p>
      </>)}
      {ev.kind === 'permission' && (<><h3>Requested</h3><p className="small" style={{ margin: 0 }}>Profile <strong>{ev.profile}</strong>: {(ev.grants as string[]).join(', ')}. {ev.why ?? ''}</p></>)}
      {!ev.kind && ev.readiness && (<>
        <h3>Readiness</h3>
        <p className="small" style={{ margin: 0 }}>{ev.readiness.branch ? <><span className="mono">{ev.readiness.branch}</span> into <span className="mono">{ev.readiness.base}</span>. Merge check: {ev.readiness.mergeCheck?.clean ? 'clean' : 'conflicts'}. {ev.readiness.changedFiles?.length ?? 0} changed file(s).</> : null}</p>
        {a.sessionId && ev.workflowId && <p className="small"><Link href={`/workflows/${ev.workflowId}`}>Open the workflow</Link> for checks, findings and history.</p>}
      </>)}

      {a.state === 'pending' && (
        <div className="appr-decide">
          <p className="muted small" style={{ margin: '0 0 8px' }}>Read the evidence first. Approving records your name; it does not by itself change anything.</p>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <label className="field" style={{ minWidth: 220 }}>Your name<input type="text" value={who} onChange={(e) => setWho(e.target.value)} placeholder="Who is deciding" maxLength={80} /></label>
            <button className="btn primary" disabled={busy || !who.trim()} onClick={() => void act('approve', { approver: who.trim() })}>Approve</button>
            <button className="btn danger" disabled={busy || !who.trim()} onClick={() => void act('reject', { approver: who.trim() })}>Reject</button>
          </div>
        </div>
      )}
      {mergeable && (
        <div className="appr-decide">
          <p className="small" style={{ margin: '0 0 8px' }}>Approved. The merge happens only if the branch is still at <span className="mono">{short(ev.head)}</span>, <span className="mono">{ev.target}</span> is checked out and clean, and it still merges cleanly.</p>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <label className="field" style={{ minWidth: 220 }}>Your name<input type="text" value={who} onChange={(e) => setWho(e.target.value)} maxLength={80} /></label>
            <button className="btn primary" disabled={busy || !who.trim()} onClick={() => void act('execute-merge', { actor: who.trim() }, 'Merged.')}>Merge now</button>
          </div>
        </div>
      )}
      {err && <div className="banner bad" role="alert">{err}</div>}
      {ok && <div className="banner info" role="status">{ok}</div>}
    </section>
  );
}

function PolicyPanel({ p, err }: { p: PolicyInfo | null; err: Error | null }) {
  const roles = (id: string) => Object.entries(p?.roleDefaults ?? {}).filter(([, v]) => v === id).map(([k]) => k);
  return (
    <section className="card" aria-labelledby="pol-h" style={{ marginTop: 20 }}>
      <h2 id="pol-h">What agents are allowed to do</h2>
      <ErrorBanner error={err} what="the policy" />
      {p && (<>
        <p className="muted small" style={{ marginTop: 0 }}>Set by the backend from each agent&apos;s role and passed to the agent&apos;s tool as allow and deny lists. Profiles marked <em>needs approval</em> are only given after a person approves them for one task. Secret files (.env, keys) are denied to every profile. This limits the agent&apos;s tools; it is not an operating-system sandbox.</p>
        <table className="data">
          <thead><tr><th scope="col">Profile</th><th scope="col">Can</th><th scope="col">Default for</th><th scope="col">Approval</th></tr></thead>
          <tbody>{p.profiles.map((x) => (
            <tr key={x.id}><td><strong>{x.label}</strong><div className="muted small">{x.description}</div></td><td className="small">{x.grants.join(', ')}</td>
              <td className="small">{roles(x.id).join(', ') || <span className="muted">no role</span>}</td><td>{x.elevated ? <span className="badge tone-warn">needs approval</span> : <span className="badge tone-good">automatic</span>}</td></tr>))}</tbody>
        </table>
        <p className="muted small">Decisions {p.decisionTokenRequired ? 'must come through the dashboard (a secret held by the dashboard server)' : 'are open to any local caller: no decision token is set'}. {p.separationOfDuties ? 'The requester cannot approve their own request. ' : ''}Approvals expire after {Math.round(p.approvalTtlMs / 60000)} minutes and are used once. CI status: {p.ciConfigured ? 'connected' : 'not connected, so required checks are not verified by the system'}.</p>
      </>)}
    </section>
  );
}
