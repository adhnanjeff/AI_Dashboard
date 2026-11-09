'use client';
import { useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { api, newIdempotencyKey } from '../lib/api.ts';
import { usePolling } from '../lib/hooks.ts';
import { DEFAULT_MODEL, MODELS } from '../lib/models.ts';
import type { Project, Session, Task } from '../lib/types.ts';
import { ErrorBanner } from './small.tsx';

const NEW = '__new__';

export default function NewSession() {
  const router = useRouter();
  const projects = usePolling(() => api<Project[]>('/projects'), 30000, 'projects');
  const [projectId, setProjectId] = useState<string>('');
  const [projName, setProjName] = useState(''); const [repoPath, setRepoPath] = useState('');
  const [title, setTitle] = useState(''); const [description, setDescription] = useState(''); const [criteria, setCriteria] = useState('');
  const [model, setModel] = useState(DEFAULT_MODEL); const [startNow, setStartNow] = useState(true);
  const [isolate, setIsolate] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const idemKey = useRef(newIdempotencyKey());

  const list = projects.data ?? [];
  const loadingProjects = projects.data === null && !projects.error;
  const chosen = projectId || (list.length ? list[0].id : NEW);
  const creatingProject = chosen === NEW;

  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      let pid = chosen;
      if (creatingProject) pid = (await api<Project>('/projects', { method: 'POST', body: { name: projName.trim(), repoPath: repoPath.trim() } })).id;
      const session = await api<Session>('/sessions', { method: 'POST', body: { projectId: pid, title: title.trim() } });
      const task = await api<Task>(`/sessions/${session.id}/tasks`, { method: 'POST', body: {
        description: description.trim(), acceptanceCriteria: criteria.split('\n').map((s) => s.trim()).filter(Boolean) } });
      if (isolate) await api(`/sessions/${session.id}/worktree`, { method: 'POST', body: {} });
      if (startNow) await api(`/tasks/${task.id}/runs`, { method: 'POST', body: { model }, headers: { 'idempotency-key': idemKey.current } });
      router.push(`/sessions/${session.id}`);
    } catch (err) { setError((err as Error).message); setBusy(false); }
  }

  return (
    <>
      <div className="page-head"><h1>New session</h1><p className="muted" style={{ margin: 0 }}>A session holds one feature: its task, runs, checkpoints and changes.</p></div>
      <ErrorBanner error={projects.data ? null : projects.error} what="projects" />
      <form className="stackf" onSubmit={submit}>
        <label className="field">Project
          <select value={loadingProjects ? '' : chosen} disabled={loadingProjects} onChange={(e) => setProjectId(e.target.value)}>
            {loadingProjects && <option value="">Loading projects…</option>}
            {list.map((p) => <option key={p.id} value={p.id}>{p.name} — {p.repoPath}</option>)}
            <option value={NEW}>Add a new project…</option>
          </select>
        </label>
        {creatingProject && !loadingProjects && (
          <>
            <label className="field">Project name<input type="text" required value={projName} onChange={(e) => setProjName(e.target.value)} /></label>
            <label className="field">Repository folder
              <input type="text" required value={repoPath} onChange={(e) => setRepoPath(e.target.value)} placeholder="C:/path/to/your/repo" />
              <span className="hint">The agent will edit files in this folder. Use a git repository you are happy for it to change.</span>
            </label>
          </>
        )}
        <label className="field">Session title<input type="text" required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add subtract() to math.js" /></label>
        <label className="field">Task
          <textarea required value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Describe what the agent should do." />
        </label>
        <label className="field">Acceptance criteria <span className="hint">One per line (optional)</span>
          <textarea value={criteria} onChange={(e) => setCriteria(e.target.value)} />
        </label>
        <label className="field">Model
          <select value={model} onChange={(e) => setModel(e.target.value)}>{MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select>
        </label>
        <label className="field">
          <span className="row"><input type="checkbox" checked={isolate} onChange={(e) => setIsolate(e.target.checked)} /> Work in an isolated git worktree</span>
          <span className="hint">Creates a separate branch and folder next to the repository so parallel sessions cannot overwrite each other. Needs a git repository with at least one commit.</span>
        </label>
        <label className="row"><input type="checkbox" checked={startNow} onChange={(e) => setStartNow(e.target.checked)} /> Start the run immediately</label>
        {error && <div className="banner bad" role="alert">{error}</div>}
        <div className="row">
          <button className="btn primary" type="submit" disabled={busy || loadingProjects}>{busy ? 'Creating…' : startNow ? 'Create and start' : 'Create session'}</button>
        </div>
      </form>
    </>
  );
}
