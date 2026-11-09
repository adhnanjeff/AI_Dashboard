'use client';
import Link from 'next/link';
import { api } from '../lib/api.ts';
import { usePolling } from '../lib/hooks.ts';
import { isDemo, STATE_META } from '../lib/status.ts';
import type { SessionSummary, WorkState } from '../lib/types.ts';
import { Ago, ErrorBanner, StatusBadge } from './small.tsx';

const CARD_STATES: WorkState[] = ['running', 'paused', 'failed', 'queued', 'completed'];

export default function Overview() {
  const list = usePolling(() => api<SessionSummary[]>('/sessions'), 4000, 'overview');
  const rows = list.data ?? [];
  const count = (s: WorkState) => rows.filter((r) => r.session.status === s).length;

  return (
    <>
      <div className="page-head">
        <div className="row spread">
          <h1>Overview</h1>
          <Link href="/new" className="btn primary">+ New session</Link>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          Every number and status here comes from the orchestrator&apos;s database.
          {list.updatedAt && <> Updated <Ago ms={list.updatedAt} />.</>}
        </p>
      </div>

      <ErrorBanner error={list.data ? null : list.error} what="sessions" />
      {list.error && list.data && <div className="banner warn" role="status">Showing stale data: {list.error.message}</div>}

      <section aria-label="Totals" className="cards">
        {CARD_STATES.map((s) => (
          <div className="card" key={s}>
            <div className="stat">{count(s)}</div>
            <div className="muted">{STATE_META[s].glyph} {STATE_META[s].label}</div>
          </div>
        ))}
      </section>

      {list.loading && !list.data && <p className="muted">Loading…</p>}
      {list.data && rows.length === 0 && (
        <div className="card empty">
          <p><strong>No sessions yet.</strong></p>
          <p>Create a session to run a coding task in one of your repositories.</p>
          <Link href="/new" className="btn primary">Create the first session</Link>
        </div>
      )}
      {rows.length > 0 && (
        <table className="data">
          <caption>All sessions, newest first</caption>
          <thead><tr><th scope="col">Session</th><th scope="col">Project</th><th scope="col">Status</th><th scope="col">Latest run</th><th scope="col">Updated</th></tr></thead>
          <tbody>
            {rows.map(({ session, project, latestRun }) => (
              <tr key={session.id}>
                <td>
                  <Link href={`/sessions/${session.id}`}>{session.title}</Link>{' '}
                  {isDemo(session.title) && <span className="badge demo" title="Seeded demo data, not a real run">DEMO</span>}
                </td>
                <td>{project.name}</td>
                <td><StatusBadge state={session.status} pulse /></td>
                <td>{latestRun ? <><Link href={`/runs/${latestRun.id}`}>{latestRun.model}</Link> <span className="muted small">({latestRun.status})</span></> : <span className="muted">—</span>}</td>
                <td><Ago iso={session.updatedAt} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
