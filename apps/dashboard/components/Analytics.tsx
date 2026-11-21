'use client';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { api } from '../lib/api.ts';
import { usePolling } from '../lib/hooks.ts';
import type { Analytics as A, Project } from '../lib/types.ts';
import { Ago, ErrorBanner, StatusBadge } from './small.tsx';

const money = (n: number | null | undefined) => (n === null || n === undefined ? 'unknown' : `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`);
const percent = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${Math.round(n * 100)}%`);
const span = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v < 1000 ? `${Math.round(v)} ms` : v < 60_000 ? `${(v / 1000).toFixed(1)} s` : v < 3_600_000 ? `${Math.round(v / 60_000)} min` : `${(v / 3_600_000).toFixed(1)} h`);
const RANGES = [7, 30, 90] as const;

/** A figure with where it comes from. The "n of m" line is the product's signature: no number appears without its basis. */
function Stat({ label, value, basis }: { label: string; value: ReactNode; basis: ReactNode }) {
  return <div className="card stat-card"><div className="label">{label}</div><div className="stat">{value}</div><div className="basis">{basis}</div></div>;
}

function Ranked({ rows, empty }: { rows: { key: string; label: string; value: number; text: string; sub?: string }[]; empty: string }) {
  if (!rows.length) return <p className="muted small">{empty}</p>;
  const max = Math.max(...rows.map((r) => r.value), 1e-9);
  return (
    <ul className="rank">
      {rows.map((r) => (
        <li key={r.key}>
          <div className="rank-top"><span className="rank-name">{r.label}</span><span className="mono">{r.text}</span></div>
          <div className="rank-bar" aria-hidden="true"><span style={{ width: `${Math.max(2, (r.value / max) * 100)}%` }} /></div>
          {r.sub ? <div className="basis">{r.sub}</div> : null}
        </li>
      ))}
    </ul>
  );
}

/** Daily reported spend. One series, one colour. Days with runs but no reported cost are marked, never drawn as zero. */
function SpendChart({ a }: { a: A }) {
  const days: { day: string; usd: number; runs: number; reported: number }[] = [];
  const end = new Date(a.generatedAt); const byDay = new Map(a.cost.byDay.map((d) => [d.day, d]));
  const span = Math.min(a.windowDays, 90);
  for (let i = span - 1; i >= 0; i--) { const d = new Date(end.getTime() - i * 86_400_000).toISOString().slice(0, 10); const r = byDay.get(d); days.push({ day: d, usd: r?.costUsd ?? 0, runs: r?.runs ?? 0, reported: r?.reportedRuns ?? 0 }); }
  const max = Math.max(...days.map((d) => d.usd), 0.01); const W = 760, H = 220, L = 46, B = 26, T = 8; const bw = (W - L) / days.length;
  const nice = (v: number) => { const p = 10 ** Math.floor(Math.log10(v)); const f = v / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; };
  const top = nice(max); const y = (v: number) => T + (H - B - T) * (1 - v / top);
  const total = days.reduce((s, d) => s + d.usd, 0);
  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label={`Reported spend per day for the last ${span} days, ${money(total)} in total. The table below has the same figures.`}>
        {[0, 0.5, 1].map((f) => <g key={f}><line x1={L} x2={W} y1={y(top * f)} y2={y(top * f)} className="grid" /><text x={L - 8} y={y(top * f) + 4} textAnchor="end" className="axis">{f === 0 ? '$0' : money(top * f)}</text></g>)}
        {days.map((d, i) => {
          const x = L + i * bw + Math.min(2, bw * 0.15); const w = Math.max(1, bw - Math.min(4, bw * 0.3));
          return (
            <g key={d.day}>
              <title>{`${d.day}: ${d.runs} runs, ${d.reported} reported ${money(d.usd)}`}</title>
              {d.usd > 0 ? <rect x={x} y={y(d.usd)} width={w} height={Math.max(1, H - B - y(d.usd))} rx="2" className="bar" /> : null}
              {d.runs > 0 && d.reported === 0 ? <rect x={x} y={H - B - 3} width={w} height="3" className="bar-unknown" /> : null}
            </g>
          );
        })}
        {days.map((d, i) => (i % Math.ceil(days.length / 6) === 0 ? <text key={d.day} x={L + i * bw + bw / 2} y={H - 8} textAnchor="middle" className="axis">{d.day.slice(5)}</text> : null))}
      </svg>
      <p className="basis">Grey ticks are days with runs that reported no cost.</p>
      <details className="chart-table">
        <summary>Show as table</summary>
        <table className="data"><thead><tr><th>Day</th><th className="num">Runs</th><th className="num">Reported</th><th className="num">Spend</th></tr></thead>
          <tbody>{days.filter((d) => d.runs > 0).map((d) => <tr key={d.day}><td className="mono">{d.day}</td><td className="num">{d.runs}</td><td className="num">{d.reported}</td><td className="num">{money(d.usd)}</td></tr>)}</tbody></table>
      </details>
    </>
  );
}

export default function Analytics() {
  const [days, setDays] = useState<(typeof RANGES)[number]>(30); const [projectId, setProjectId] = useState('');
  const projects = usePolling(() => api<Project[]>('/projects'), 60000, 'an-projects');
  const q = usePolling(() => api<A>(`/analytics?days=${days}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''}`), 15000, `analytics-${days}-${projectId}`);
  const a = q.data;

  return (
    <>
      <div className="page-head">
        <div className="row spread">
          <h1>Analytics</h1>
          <div className="row">
            <label className="sr-only" htmlFor="an-project">Project</label>
            <select id="an-project" value={projectId} onChange={(e) => setProjectId(e.target.value)} className="inline-select">
              <option value="">All projects</option>{(projects.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <div className="seg range" role="group" aria-label="Time range">
              {RANGES.map((r) => <button key={r} type="button" aria-pressed={days === r} onClick={() => setDays(r)}>{r} days</button>)}
            </div>
          </div>
        </div>
        <p className="sub">Where cost goes, when work escalates to a stronger model, where it fails, and whether quality holds. Every figure is built from runs the system recorded; cost is only what providers reported.</p>
      </div>

      <ErrorBanner error={q.error} what="analytics" />
      {q.error && !a ? <button className="btn" onClick={() => void q.refresh()}>Try again</button> : null}
      {!a && !q.error ? <div className="card" aria-busy="true"><p className="muted">Loading analytics…</p></div> : null}

      {a ? (
        <div className="stack">
          <section className="card" aria-labelledby="an-ins">
            <h2 id="an-ins">What the data says</h2>
            <ul className="insights">
              {a.insights.map((i, k) => <li key={k}><span className={`topic topic-${i.topic}`}>{i.topic}</span><div><div>{i.text}</div><div className="basis">Based on {i.basis}</div></div></li>)}
            </ul>
          </section>

          <div className="cards four">
            <Stat label="Reported spend" value={money(a.totals.reportedUsd)} basis={`${a.totals.reportedRuns} of ${a.totals.runs} runs reported a cost`} />
            <Stat label="Cost per accepted work" value={money(a.accepted.costPerAcceptedUsd)} basis={`${a.accepted.acceptedWithCost} of ${a.accepted.accepted} accepted had a cost`} />
            <Stat label="Acceptance rate" value={percent(a.accepted.acceptanceRate)} basis={`${a.accepted.accepted} accepted of ${a.accepted.units} finished`} />
            <Stat label="Run failure rate" value={percent(a.reliability.failureRate)} basis={`${a.totals.failed} failed of ${a.totals.finished} finished runs`} />
          </div>

          <div className="grid-main">
            <section className="card" aria-labelledby="an-spend">
              <h2 id="an-spend">Spend per day</h2>
              <SpendChart a={a} />
            </section>
            <section className="card" aria-labelledby="an-models">
              <h2 id="an-models">Cost by model</h2>
              <Ranked empty="No runs in this period." rows={a.cost.byModel.map((m) => ({ key: m.model, label: m.model, value: m.costUsd, text: m.reportedRuns ? money(m.costUsd) : 'unknown',
                sub: `${m.runs} runs, ${m.reportedRuns} reported · ${percent(m.completionRate)} completed · median ${span(m.medianDurationMs)}` }))} />
            </section>
          </div>

          <div className="grid-2">
            <section className="card" aria-labelledby="an-esc">
              <h2 id="an-esc">Escalation and retries</h2>
              <dl className="kv">
                <dt>Routing decisions</dt><dd>{a.routing.decisions}</dd>
                <dt>Escalated</dt><dd>{a.routing.escalated} <span className="basis">({percent(a.routing.escalationRate)})</span></dd>
                <dt>Escalated runs that succeeded</dt><dd>{a.routing.escalatedRunsFinished ? `${a.routing.escalatedRunsCompleted} of ${a.routing.escalatedRunsFinished}` : '—'}</dd>
                <dt>Tasks that needed retries</dt><dd>{a.routing.tasksWithRetries} <span className="basis">({a.routing.extraRuns} extra runs, {a.routing.tasksRecoveredByRetry} recovered)</span></dd>
                <dt>Workflow step retries</dt><dd>{a.routing.workflowRetries} <span className="basis">({a.routing.workflowRetryLimitsHit} hit their limit)</span></dd>
                <dt>Stopped by the retry limit</dt><dd>{a.routing.refusedByRetryLimit}</dd>
              </dl>
              <h3>Escalation paths</h3>
              <Ranked empty="Nothing escalated." rows={a.routing.transitions.map((t) => ({ key: t.path, label: t.path, value: t.decisions, text: String(t.decisions) }))} />
              <h3>Runs by tier</h3>
              <Ranked empty="No routing decisions." rows={a.routing.byTier.map((t) => ({ key: t.tier, label: t.tier, value: t.decisions, text: String(t.decisions) }))} />
              {a.routing.savings ? <p className="basis">Estimated avoided cost from routing below {a.routing.savings.ceilingTier}: {money(a.routing.savings.estimatedUsd)} over {a.routing.savings.runsOnCheaperTier} runs. An estimate from the routing policy, not a measurement.</p> : null}
            </section>

            <section className="card" aria-labelledby="an-fail">
              <h2 id="an-fail">Failures and recovery</h2>
              <Ranked empty="No failed runs." rows={a.reliability.failuresByCause.map((f) => ({ key: f.cause, label: f.cause, value: f.runs, text: String(f.runs) }))} />
              <h3>Recovery</h3>
              <dl className="kv">
                <dt>Checkpoints saved</dt><dd>{a.reliability.checkpointsSaved} <span className="basis">({a.reliability.checkpointsFailed} failed)</span></dd>
                <dt>Resumes</dt><dd>{a.reliability.resumes}</dd>
                <dt>Resumed work that completed</dt><dd>{a.reliability.resumedSessions ? `${a.reliability.resumedThenCompleted} of ${a.reliability.resumedSessions} (${percent(a.reliability.recoveryRate)})` : '—'}</dd>
                <dt>Runs orphaned by a restart</dt><dd>{a.reliability.orphaned}</dd>
                <dt>Handoffs</dt><dd>{a.reliability.handoffs} <span className="basis">({a.reliability.handoffsRefused} refused)</span></dd>
              </dl>
            </section>
          </div>

          <div className="grid-2">
            <section className="card" aria-labelledby="an-time">
              <h2 id="an-time">Time</h2>
              <dl className="kv">
                <dt>Run, median</dt><dd>{span(a.time.runMedianMs)} <span className="basis">({a.time.runsTimed} runs)</span></dd>
                <dt>Run, 90th percentile</dt><dd>{span(a.time.runP90Ms)}</dd>
                <dt>Session to completion, median</dt><dd>{span(a.time.sessionMedianMs)} <span className="basis">({a.time.sessionsTimed} sessions)</span></dd>
                <dt>Workflow to completion, median</dt><dd>{span(a.time.workflowMedianMs)} <span className="basis">({a.time.workflowsTimed} workflows)</span></dd>
              </dl>
            </section>
            <section className="card" aria-labelledby="an-people">
              <h2 id="an-people">People</h2>
              <dl className="kv">
                <dt>Approvals requested</dt><dd>{a.humans.approvalsRequested} <span className="basis">({a.humans.approved} approved, {a.humans.rejected} rejected, {a.humans.pending} waiting)</span></dd>
                <dt>Decision time, median</dt><dd>{span(a.humans.medianWaitMs)} <span className="basis">(90th percentile {span(a.humans.p90WaitMs)})</span></dd>
                <dt>Accepted without a person</dt><dd>{a.humans.acceptedWithoutAPerson} of {a.accepted.accepted}</dd>
                <dt>Accepted on the first attempt</dt><dd>{a.humans.firstAttemptAccepted} of {a.accepted.accepted} <span className="basis">({percent(a.humans.firstAttemptRate)})</span></dd>
              </dl>
              {a.humans.byAction.length ? (
                <table className="data"><thead><tr><th>Action</th><th className="num">Requested</th><th className="num">Approved</th><th className="num">Waiting</th><th className="num">Median wait</th></tr></thead>
                  <tbody>{a.humans.byAction.map((r) => <tr key={r.action}><td className="mono">{r.action}</td><td className="num">{r.requested}</td><td className="num">{r.approved}</td><td className="num">{r.pending}</td><td className="num">{span(r.medianWaitMs)}</td></tr>)}</tbody></table>
              ) : null}
            </section>
          </div>

          <section className="card" aria-labelledby="an-recent">
            <h2 id="an-recent">Recently finished work</h2>
            <p className="basis">{a.accepted.definition}</p>
            {a.accepted.recent.length ? (
              <table className="data"><thead><tr><th>Work</th><th>Kind</th><th>Outcome</th><th className="num">Runs</th><th className="num">Cost</th><th>Finished</th></tr></thead>
                <tbody>{a.accepted.recent.map((r) => (
                  <tr key={r.id}>
                    <td>{r.kind === 'workflow' ? <Link href={`/workflows/${r.id}`}>{r.title}</Link> : <Link href={`/sessions/${r.id}`}>{r.title}</Link>}</td>
                    <td>{r.kind}</td><td><StatusBadge state={r.accepted ? 'completed' : r.status} /></td><td className="num">{r.runs}</td>
                    <td className="num">{r.costUsd === null ? <span className="basis">not reported</span> : money(r.costUsd)}</td><td><Ago iso={r.at} /></td>
                  </tr>))}</tbody></table>
            ) : <p className="muted">No work finished in this period.</p>}
          </section>
          <p className="basis" aria-live="polite">Updated <Ago ms={q.updatedAt} />{q.error ? ' — the last refresh failed, showing earlier figures' : ''}</p>
        </div>
      ) : null}
    </>
  );
}
