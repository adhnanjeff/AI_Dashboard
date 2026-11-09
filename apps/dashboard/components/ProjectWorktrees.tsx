'use client';
import Link from 'next/link';
import { api } from '../lib/api.ts';
import { usePolling } from '../lib/hooks.ts';
import type { WorktreeOverview } from '../lib/types.ts';
import { ErrorBanner } from './small.tsx';

export default function ProjectWorktrees({ id }: { id: string }) {
  const o = usePolling(() => api<WorktreeOverview>(`/projects/${id}/worktrees`), 8000, `wts:${id}`);
  const d = o.data;
  return (
    <>
      <div className="page-head">
        <p style={{ margin: 0 }}><Link href="/">← Overview</Link></p>
        <h1>Worktrees{d ? `: ${d.project.name}` : ''}</h1>
        {d && <p className="muted small" style={{ margin: 0 }}>Isolated branches and folders for parallel sessions. Merge checks are computed in memory and change nothing.</p>}
      </div>
      <ErrorBanner error={d ? null : o.error} what="worktrees" />
      {o.error && d && <div className="banner warn" role="status">Showing stale data: {o.error.message}</div>}
      {d && (
        <div className="stack">
          {d.overlaps.length > 0 && (
            <div className="banner warn" role="status">
              <strong>Sessions touching the same files</strong>
              {d.overlaps.map((x, i) => <div key={i}>• <span className="mono">{x.a}</span> and <span className="mono">{x.b}</span>: {x.files.join(', ')}</div>)}
            </div>
          )}
          <section className="card" aria-labelledby="wts-h">
            <h2 id="wts-h">Active worktrees ({d.worktrees.length})</h2>
            {d.worktrees.length === 0 && <p className="muted">None. Create one from a session page before its first run.</p>}
            {d.worktrees.length > 0 && (
              <table className="data">
                <thead><tr><th scope="col">Session</th><th scope="col">Branch</th><th scope="col">Ahead / behind</th><th scope="col">Uncommitted</th><th scope="col">State</th></tr></thead>
                <tbody>
                  {d.worktrees.map((w) => (
                    <tr key={w.worktree.id}>
                      <td><Link href={`/sessions/${w.worktree.sessionId}`} className="mono">{w.worktree.sessionId.slice(4, 12)}</Link></td>
                      <td className="mono small">{w.worktree.branch}</td>
                      <td>{w.ahead} / {w.behind}</td>
                      <td>{w.uncommitted.length}</td>
                      <td className="small">{!w.exists ? 'missing on disk' : w.busyRunId ? 'run in progress' : 'idle'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          <section className="card" aria-labelledby="int-h">
            <h2 id="int-h">Integration plan into {d.integration.target}</h2>
            {d.integration.order.length === 0 ? <p className="muted">No branch has commits yet, so there is nothing to integrate.</p> : (
              <ol>
                {d.integration.order.map((s) => (
                  <li key={s.branch}><span className="mono">{s.branch}</span>{' '}
                    {s.clean ? <span className="badge tone-good"><span aria-hidden="true">✓</span>merges cleanly</span> : <span className="badge tone-bad"><span aria-hidden="true">✕</span>conflicts: {s.conflicts.join(', ')}</span>}
                    {s.uncommitted > 0 && <span className="muted small"> · {s.uncommitted} uncommitted file(s) not included</span>}
                  </li>
                ))}
              </ol>
            )}
            {d.integration.pairConflicts.map((p, i) => <div key={i} className="banner warn" role="status"><span className="mono">{p.a}</span> and <span className="mono">{p.b}</span> conflict with each other in: {p.conflicts.join(', ')}</div>)}
            <h3>Suggested commands</h3>
            <pre className="log" tabIndex={0} aria-label="Suggested merge commands">{d.integration.commands.join('\n')}</pre>
            <p className="muted small" style={{ margin: '6px 0 0' }}>{d.integration.note}</p>
          </section>
        </div>
      )}
    </>
  );
}
