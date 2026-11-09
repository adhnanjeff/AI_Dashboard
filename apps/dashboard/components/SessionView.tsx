'use client';
import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { api, ApiError } from '../lib/api.ts';
import { refreshHint } from '../lib/events.ts';
import { duration } from '../lib/format.ts';
import { usePolling, useSessionStream, useNow } from '../lib/hooks.ts';
import { isDemo } from '../lib/status.ts';
import type { Changes, Run, SessionDetail } from '../lib/types.ts';
import ChangesPanel from './ChangesPanel.tsx';
import Controls from './Controls.tsx';
import HandoffPanel from './HandoffPanel.tsx';
import MemoryPanel from './MemoryPanel.tsx';
import { Ago, ErrorBanner, StatusBadge, StreamBadge } from './small.tsx';
import Timeline from './Timeline.tsx';
import WorktreePanel from './WorktreePanel.tsx';

export default function SessionView({ id }: { id: string }) {
  const detail = usePolling(() => api<SessionDetail>(`/sessions/${id}`), 5000, `d:${id}`);
  const runs = usePolling(() => api<Run[]>(`/sessions/${id}/runs`), 5000, `r:${id}`);
  const changes = usePolling(() => api<Changes>(`/sessions/${id}/changes`), 8000, `c:${id}`);

  // Events are the trigger for refetching: the stream tells us when something changed.
  const timers = useRef<{ s?: ReturnType<typeof setTimeout>; c?: ReturnType<typeof setTimeout> }>({});
  const refetch = useRef({ detail: detail.refresh, runs: runs.refresh, changes: changes.refresh });
  refetch.current = { detail: detail.refresh, runs: runs.refresh, changes: changes.refresh };
  const stream = useSessionStream(id, (e) => {
    const h = refreshHint(e);
    if (h.session && !timers.current.s) timers.current.s = setTimeout(() => { timers.current.s = undefined; void refetch.current.detail(); void refetch.current.runs(); }, 300);
    if (h.changes && !timers.current.c) timers.current.c = setTimeout(() => { timers.current.c = undefined; void refetch.current.changes(); }, 600);
  });
  useEffect(() => () => { clearTimeout(timers.current.s); clearTimeout(timers.current.c); }, []);
  const now = useNow();

  const notFound = detail.error instanceof ApiError && detail.error.status === 404;
  if (notFound) return <div className="card empty"><p><strong>Session not found.</strong></p><Link href="/" className="btn">Back to overview</Link></div>;

  const d = detail.data;
  const reload = () => { void detail.refresh(); void runs.refresh(); void changes.refresh(); };

  return (
    <>
      <div className="page-head">
        <div className="row spread">
          <div className="row">
            <h1>{d?.session.title ?? 'Session'}</h1>
            {d && <StatusBadge state={d.session.status} pulse />}
            {d && isDemo(d.session.title) && <span className="badge demo" title="Seeded demo data, not a real run">DEMO</span>}
          </div>
          <StreamBadge status={stream.status} />
        </div>
        <div className="muted small">
          {d ? <>Created <Ago iso={d.session.createdAt} /> · updated <Ago iso={d.session.updatedAt} /></> : 'Loading…'}
          {detail.updatedAt && <> · refreshed <Ago ms={detail.updatedAt} /></>}
        </div>
        {d && <Controls detail={d} runs={runs.data ?? []} onChanged={reload} />}
      </div>

      <ErrorBanner error={detail.data ? null : detail.error} what="session" />
      {detail.error && d && <div className="banner warn" role="status">Showing stale session data (last refreshed <Ago ms={detail.updatedAt} />): {detail.error.message}</div>}
      {stream.status === 'closed' && <div className="banner bad" role="alert">The live event stream has stopped. Reload the page to reconnect.</div>}

      <div className="grid-2">
        <div className="stack">
          {d?.tasks.map((t) => (
            <section className="card" key={t.id} aria-label="Task">
              <div className="row spread"><h2>Task</h2><StatusBadge state={t.status} /></div>
              <p style={{ marginTop: 0, whiteSpace: 'pre-wrap' }}>{t.description}</p>
              {t.acceptanceCriteria.length > 0 && (<><h3>Acceptance criteria</h3><ul>{t.acceptanceCriteria.map((c, i) => <li key={i}>{c}</li>)}</ul></>)}
            </section>
          ))}
          <Timeline events={stream.events} />
        </div>

        <div className="stack">
          {d && <WorktreePanel sessionId={id} projectId={d.session.projectId} hasRuns={(runs.data?.length ?? 0) > 0} />}
          <ChangesPanel sessionId={id} changes={changes} />

          <section className="card" aria-labelledby="runs-h">
            <h2 id="runs-h">Runs</h2>
            {runs.data && runs.data.length === 0 && <p className="muted">No runs yet.</p>}
            {runs.data && runs.data.length > 0 && (
              <table className="data">
                <thead><tr><th scope="col">Run</th><th scope="col">Model</th><th scope="col">Status</th><th scope="col">Duration</th><th scope="col">Outcome</th></tr></thead>
                <tbody>
                  {[...runs.data].reverse().map((r) => (
                    <tr key={r.id}>
                      <td><Link href={`/runs/${r.id}`} className="mono">{r.id.slice(4, 12)}</Link></td>
                      <td>{r.model}</td>
                      <td><StatusBadge state={r.status} pulse /></td>
                      <td>{duration(r.startedAt, r.endedAt, now)}</td>
                      <td className="small">{r.terminationReason ?? <span className="muted">in progress</span>}{r.exitCode !== null && <span className="muted"> · exit {r.exitCode}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {d && <MemoryPanel scope="session" id={id} heading="Session notes" blurb="Decisions, rejected approaches and open questions for this feature only. Kept apart from project memory." />}
          {d && <p className="small" style={{ margin: 0 }}><Link href={`/projects/${d.session.projectId}/memory`}>Open shared project memory →</Link></p>}
          {d && <HandoffPanel sessionId={id} />}

          {d?.checkpoint && (
            <section className="card" aria-labelledby="cp-h">
              <h2 id="cp-h">Latest checkpoint</h2>
              <dl className="kv">
                <dt>Saved</dt><dd>#{d.checkpoint.seq} · <Ago iso={d.checkpoint.createdAt} /> · {d.checkpoint.data.reason}</dd>
                <dt>Next action</dt><dd>{d.checkpoint.nextAction}</dd>
                <dt>Files changed</dt><dd>{d.checkpoint.data.changedFiles.length ? d.checkpoint.data.changedFiles.join(', ') : 'none'}</dd>
                {d.checkpoint.data.lastAgentMessage && (<><dt>Last agent message</dt><dd>{d.checkpoint.data.lastAgentMessage}</dd></>)}
              </dl>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
