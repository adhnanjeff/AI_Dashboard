'use client';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '../lib/api.ts';
import { usePolling } from '../lib/hooks.ts';
import type { MergeCheck, RemovalPreview, WorktreeStatus } from '../lib/types.ts';
import { ErrorBanner } from './small.tsx';

/** Session page: the isolated git worktree this session works in (create, inspect, check merge, safely remove). */
export default function WorktreePanel({ sessionId, projectId, hasRuns }: { sessionId: string; projectId: string; hasRuns: boolean }) {
  const wt = usePolling(() => api<WorktreeStatus | null>(`/sessions/${sessionId}/worktree`), 6000, `wt:${sessionId}`);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<MergeCheck | null>(null); const [prev, setPrev] = useState<RemovalPreview | null>(null);
  const [armed, setArmed] = useState(false);

  async function run(fn: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await fn(); await wt.refresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const s = wt.data;
  return (
    <section className="card" aria-labelledby="wt-h">
      <div className="row spread">
        <h2 id="wt-h">Isolated worktree</h2>
        <Link href={`/projects/${projectId}/worktrees`} className="small">All worktrees →</Link>
      </div>
      <ErrorBanner error={wt.data !== null ? null : wt.error} what="worktree" />
      {wt.error && wt.data !== null && <div className="banner warn" role="status">Showing stale worktree data: {wt.error.message}</div>}
      {error && <div className="banner bad" role="alert">{error}</div>}

      {wt.data === null && !wt.error && wt.updatedAt !== null && (
        <>
          <p className="muted" style={{ marginTop: 0 }}>This session works directly in the project folder. An isolated worktree gives it its own branch and folder, so parallel sessions cannot overwrite each other.</p>
          {hasRuns && <p className="muted small">A worktree can only be created before the session's first run.</p>}
          <button className="btn primary" disabled={busy || hasRuns} onClick={() => void run(async () => { await api(`/sessions/${sessionId}/worktree`, { method: 'POST', body: {} }); })}>
            {busy ? 'Creating…' : 'Create isolated worktree'}
          </button>
        </>
      )}

      {s && (
        <>
          <dl className="kv">
            <dt>Branch</dt><dd className="mono">{s.worktree.branch}{s.currentBranch && s.currentBranch !== s.worktree.branch && <strong> (currently on {s.currentBranch})</strong>}</dd>
            <dt>Folder</dt><dd className="mono" style={{ overflowWrap: 'anywhere' }}>{s.worktree.path}{!s.exists && <strong> (missing on disk)</strong>}</dd>
            <dt>Based on</dt><dd><span className="mono">{s.worktree.baseBranch}</span> @ <span className="mono">{s.worktree.baseRevision.slice(0, 8)}</span></dd>
            <dt>Commits</dt><dd>{s.ahead} ahead · {s.behind} behind {s.worktree.baseBranch}</dd>
            <dt>Uncommitted</dt><dd>{s.uncommitted.length ? s.uncommitted.join(', ') : 'none'}</dd>
            <dt>Committed files</dt><dd>{s.committed.length ? s.committed.join(', ') : 'none'}</dd>
            {s.busyRunId && <><dt>In use</dt><dd>run <span className="mono">{s.busyRunId.slice(4, 12)}</span> is writing here</dd></>}
          </dl>
          <div className="row">
            <button className="btn" disabled={busy} onClick={() => void run(async () => { setCheck(await api<MergeCheck>(`/sessions/${sessionId}/worktree/merge-check`)); })}>Check merge into {s.worktree.baseBranch}</button>
            <button className="btn" disabled={busy} onClick={() => void run(async () => { setArmed(false); setPrev(await api<RemovalPreview>(`/sessions/${sessionId}/worktree/remove-preview`)); })}>Preview removal</button>
          </div>
          {check && (
            <div className={`banner ${check.error ? 'bad' : check.clean ? 'info' : 'warn'}`} role="status" style={{ marginTop: 8 }}>
              {check.error ? <>Could not check: {check.error}</>
                : check.clean ? <><strong>No conflicts</strong> merging {check.branch} into {check.target}.</>
                : <><strong>Would conflict</strong> in: {check.conflicts.join(', ')}</>}
              {check.note && <div>{check.note}</div>}
            </div>
          )}
          {prev && (
            <div className={`banner ${prev.canRemove ? 'info' : 'warn'}`} role="status" style={{ marginTop: 8 }}>
              {prev.canRemove ? <>Safe to remove. {prev.note}</> : <><strong>Cannot remove yet:</strong>{prev.blockers.map((b, i) => <div key={i}>• {b}</div>)}</>}
              {prev.canRemove && (
                <div style={{ marginTop: 6 }}>
                  <button className={`btn danger${armed ? ' armed' : ''}`} disabled={busy} onBlur={() => setArmed(false)}
                    onClick={() => armed ? void run(async () => { await api(`/sessions/${sessionId}/worktree/remove`, { method: 'POST', body: {} }); setPrev(null); setCheck(null); setArmed(false); }) : setArmed(true)}>
                    {armed ? 'Click again to remove the folder' : 'Remove worktree folder'}
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
