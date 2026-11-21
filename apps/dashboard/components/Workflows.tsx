'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { api } from '../lib/api.ts';
import { usePolling } from '../lib/hooks.ts';
import type { Project, WorkflowSummary } from '../lib/types.ts';
import { Ago, ErrorBanner } from './small.tsx';

export const WF_STATUS: Record<string, { label: string; glyph: string; tone: string }> = {
  draft: { label: 'Draft', glyph: '○', tone: 'muted' }, running: { label: 'Running', glyph: '●', tone: 'info' }, completed: { label: 'Complete', glyph: '✓', tone: 'good' },
  failed: { label: 'Stopped', glyph: '✕', tone: 'bad' }, cancelled: { label: 'Cancelled', glyph: '⊘', tone: 'muted' },
  pending: { label: 'Pending', glyph: '○', tone: 'muted' }, waiting_approval: { label: 'Needs approval', glyph: '!', tone: 'warn' }, passed: { label: 'Passed', glyph: '✓', tone: 'good' }, skipped: { label: 'Skipped', glyph: '–', tone: 'muted' },
};
export function WfBadge({ status }: { status: string }) {
  const m = WF_STATUS[status] ?? { label: status, glyph: '?', tone: 'muted' };
  return <span className={`badge tone-${m.tone}`}><span aria-hidden="true">{m.glyph}</span> {m.label}</span>;
}

/** Turns a command typed like `npm test` into an argument list. There is no shell: quoting is not supported, and the server only allows known programs. */
const argv = (line: string) => line.trim().split(/\s+/).filter(Boolean);

export default function Workflows() {
  const router = useRouter();
  const list = usePolling(() => api<WorkflowSummary[]>('/workflows'), 4000, 'workflows');
  const projects = usePolling(() => api<Project[]>('/projects'), 30000, 'projects');
  const [projectId, setProjectId] = useState(''); const [title, setTitle] = useState(''); const [goal, setGoal] = useState('');
  const [parts, setParts] = useState(''); const [checks, setChecks] = useState('npm test'); const [review, setReview] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const ps = projects.data ?? []; const pid = projectId || ps[0]?.id || '';

  async function create(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const partList = parts.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const m = l.match(/^([a-z][a-z0-9-]*)\s*:\s*(.+)$/i); if (!m) throw new Error(`"${l.slice(0, 40)}": write each part as  name: what it should do`);
        return { id: m[1].toLowerCase(), prompt: m[2] };
      });
      const checkList = checks.split('\n').map((l) => l.trim()).filter(Boolean).map((l, i) => ({ id: `check-${i + 1}`, command: argv(l) }));
      const w = await api<WorkflowSummary>('/workflows', { method: 'POST', body: { projectId: pid, title: title.trim(), goal: goal.trim(), template: { parts: partList, checks: checkList, ...(review.trim() ? { reviewPrompt: review.trim() } : {}) } } });
      router.push(`/workflows/${w.id}`);
    } catch (err) { setError((err as Error).message); setBusy(false); }
  }

  const rows = list.data ?? [];
  return (
    <>
      <div className="page-head">
        <h1>Workflows</h1>
        <p className="sub">A workflow splits a feature across several agents, each in its own copy of the repository, then merges their work, runs your checks, has it reviewed, and stops for a person to approve. Nothing is merged for you.</p>
      </div>
      <ErrorBanner error={list.data ? null : list.error} what="workflows" />

      <section className="card" aria-labelledby="wf-list">
        <div className="row spread"><h2 id="wf-list">Your workflows</h2><Link href="/workflows/editor" className="btn">Open the editor</Link></div>
        {rows.length === 0 ? <p className="muted">None yet. Describe a feature below to create one.</p> : (
          <table className="data">
            <thead><tr><th scope="col">Workflow</th><th scope="col">Status</th><th scope="col">Progress</th><th scope="col">Updated</th></tr></thead>
            <tbody>
              {rows.map((w) => (
                <tr key={w.id}>
                  <td><Link href={`/workflows/${w.id}`}>{w.title}</Link><div className="muted small">{w.goal.slice(0, 110)}</div></td>
                  <td><WfBadge status={w.waiting ? 'waiting_approval' : w.status} />{w.haltedReason && w.status === 'failed' && <div className="muted small">{w.haltedReason.slice(0, 100)}</div>}</td>
                  <td className="small">{w.passed} of {w.steps} steps passed</td>
                  <td className="small"><Ago iso={w.updatedAt} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card" aria-labelledby="wf-new">
        <h2 id="wf-new">New feature workflow</h2>
        <p className="muted small" style={{ marginTop: 0 }}>The standard shape: each part runs in parallel in its own workspace, the parts are combined in a fresh workspace, your checks run on the result, a reviewer reads it, and you approve. A failed check or serious review finding goes back to the first part for a bounded number of corrections.</p>
        <form className="stackf" onSubmit={create}>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <label className="field" style={{ flex: '1 1 200px' }}>Project<select value={pid} onChange={(e) => setProjectId(e.target.value)} required>{ps.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <label className="field" style={{ flex: '2 1 260px' }}>Title<input type="text" required maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add CSV export" /></label>
          </div>
          <label className="field">Goal <span className="hint">What the finished feature should do. Every agent is told this.</span><textarea required value={goal} onChange={(e) => setGoal(e.target.value)} /></label>
          <label className="field">Parts <span className="hint">One per line, as  name: what to do. Parts should touch different files; overlapping edits stop the workflow at the merge.</span>
            <textarea required value={parts} onChange={(e) => setParts(e.target.value)} placeholder={'backend: add an /export endpoint that returns the rows as CSV\nfrontend: add an Export button to the table page'} /></label>
          <label className="field">Checks <span className="hint">One command per line, run in the combined workspace. Allowed programs: node, npm, npx, pnpm, tsc, eslint, pytest, cargo, go and similar.</span>
            <textarea value={checks} onChange={(e) => setChecks(e.target.value)} style={{ minHeight: 64 }} /></label>
          <label className="field">Reviewer instructions <span className="hint">Optional. What the reviewer should look for.</span><input type="text" value={review} onChange={(e) => setReview(e.target.value)} placeholder="Check error handling and that no secrets are logged" /></label>
          {error && <div className="banner bad" role="alert">{error}</div>}
          <div><button className="btn primary" disabled={busy || !pid} type="submit">{busy ? 'Creating…' : 'Create workflow'}</button> <span className="muted small">It does not start until you press Start on the next page.</span></div>
        </form>
      </section>
    </>
  );
}
