'use client';
import { useState, type ChangeEvent } from 'react';
import { api } from '../lib/api.ts';
import { bytes } from '../lib/format.ts';
import { usePolling } from '../lib/hooks.ts';
import type { BackupInfo, ImportReport, Project } from '../lib/types.ts';
import { Ago, ErrorBanner } from './small.tsx';

function save(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
}

/** Backup, export and import. Everything here is an explicit action: nothing runs in the background. */
export default function DataTools() {
  const backups = usePolling(() => api<{ dir: string; backups: { file: string; bytes: number; modifiedAt: string }[] }>('/admin/backups'), 20000, 'backups');
  const projects = usePolling(() => api<Project[]>('/projects'), 60000, 'data-projects');
  const [projectId, setProjectId] = useState(''); const pid = projectId || projects.data?.[0]?.id || '';
  const [last, setLast] = useState<BackupInfo | null>(null); const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null); const [report, setReport] = useState<ImportReport | null>(null); const [paste, setPaste] = useState('');

  async function backup() {
    setBusy('backup'); setError(null);
    try { setLast(await api<BackupInfo>('/admin/backups', { method: 'POST', body: {} })); await backups.refresh(); } catch (e) { setError(e as Error); } finally { setBusy(null); }
  }
  async function exportIt() {
    setBusy('export'); setError(null);
    try { const p = projects.data?.find((x) => x.id === pid); save(`${(p?.name ?? 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.export.json`, await api(`/projects/${encodeURIComponent(pid)}/export`)); }
    catch (e) { setError(e as Error); } finally { setBusy(null); }
  }
  async function importText(text: string) {
    setBusy('import'); setError(null); setReport(null);
    let file: unknown; try { file = JSON.parse(text); } catch { setError(new Error('That is not valid JSON.')); setBusy(null); return; }
    try { setReport(await api<ImportReport>(`/projects/${encodeURIComponent(pid)}/import-memory`, { method: 'POST', body: { file } })); setPaste(''); } catch (e) { setError(e as Error); } finally { setBusy(null); }
  }
  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; e.target.value = ''; if (!f) return;
    if (f.size > 1_000_000) { setError(new Error('That file is larger than 1 MB.')); return; }
    await importText(await f.text());
  }

  return (
    <>
      <div className="page-head">
        <h1>Data and backup</h1>
        <p className="sub">Keep a copy of the database, move a project's memory and workflows to another machine, or restore project memory from a file. Nothing here runs on its own.</p>
      </div>
      <ErrorBanner error={error} what="that action" />
      <div className="stack">
        <section className="card" aria-labelledby="bk">
          <div className="row spread"><h2 id="bk">Database backup</h2><button className="btn primary" disabled={busy !== null} onClick={() => void backup()}>{busy === 'backup' ? 'Backing up…' : 'Back up now'}</button></div>
          <p className="muted">A consistent copy of everything the orchestrator has recorded. Each backup is opened and checked before it is reported as done. To restore, stop the orchestrator and point <span className="mono">DB_PATH</span> at the backup file.</p>
          {last ? <div className="banner info" role="status">Saved <span className="mono">{last.file}</span> ({bytes(last.bytes)}). Integrity check: {last.integrity}. It holds {last.tables.project} {last.tables.project === 1 ? 'project' : 'projects'}, {last.tables.session} sessions, {last.tables.agent_run} runs and {last.tables.event} events.</div> : null}
          {backups.data ? (
            <>
              <p className="basis">Folder: <span className="mono">{backups.data.dir}</span></p>
              {backups.data.backups.length ? (
                <table className="data"><thead><tr><th>File</th><th className="num">Size</th><th>Created</th></tr></thead>
                  <tbody>{backups.data.backups.map((b) => <tr key={b.file}><td className="mono">{b.file}</td><td className="num">{bytes(b.bytes)}</td><td><Ago iso={b.modifiedAt} /></td></tr>)}</tbody></table>
              ) : <p className="muted">No backups yet.</p>}
            </>
          ) : null}
        </section>

        <section className="card" aria-labelledby="mv">
          <h2 id="mv">Project export and import</h2>
          <div className="row"><label htmlFor="data-project" className="sr-only">Project</label>
            <select id="data-project" value={pid} onChange={(e) => setProjectId(e.target.value)} className="inline-select">{(projects.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            <button className="btn" disabled={!pid || busy !== null} onClick={() => void exportIt()}>Download export</button>
          </div>
          <p className="muted">The export holds the project's settings, its memory and its workflow definitions. It leaves out the local folder, run logs, approvals and anything that could hold a credential.</p>
          <h3>Restore memory from an export</h3>
          <p className="muted">Only human-written, active entries are imported, and each goes through the normal memory checks. Agent-written entries are skipped because the runs they cite do not exist here. Importing the same file twice adds nothing new.</p>
          <div className="row">
            <label className="btn file-btn-label">Choose file<input type="file" accept="application/json,.json" onChange={(e) => void onFile(e)} className="sr-only" disabled={!pid || busy !== null} /></label>
          </div>
          <label className="field" htmlFor="data-paste"><span>Or paste the JSON</span></label>
          <textarea id="data-paste" value={paste} onChange={(e) => setPaste(e.target.value)} rows={5} className="mono" />
          <div className="row"><button className="btn" disabled={!pid || !paste.trim() || busy !== null} onClick={() => void importText(paste)}>{busy === 'import' ? 'Importing…' : 'Import pasted JSON'}</button></div>
          {report ? (
            <div className="banner info" role="status">
              <strong>{report.imported} imported</strong>, {report.duplicates} already present, {report.skipped.length} skipped.
              {report.skipped.length ? <ul className="problems">{report.skipped.slice(0, 20).map((s) => <li key={s.index}>Entry {s.index + 1}: {s.reason}</li>)}</ul> : null}
            </div>
          ) : null}
        </section>
      </div>
    </>
  );
}
