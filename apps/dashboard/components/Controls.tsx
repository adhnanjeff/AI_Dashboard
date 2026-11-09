'use client';
import { useEffect, useRef, useState } from 'react';
import { api, newIdempotencyKey } from '../lib/api.ts';
import { DEFAULT_MODEL, MODELS } from '../lib/models.ts';
import { availableActions } from '../lib/status.ts';
import type { Drift, Run, SessionDetail } from '../lib/types.ts';

interface Props { detail: SessionDetail; runs: Run[]; onChanged: () => void }

export default function Controls({ detail, runs, onChanged }: Props) {
  const actions = availableActions(detail, runs);
  const task = detail.tasks.find((t) => t.status === 'queued');
  const activeRun = runs.find((r) => r.status === 'running');
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [drift, setDrift] = useState<{ drift: Drift; nextAction: string } | null>(null);
  const keys = useRef<Record<string, string>>({});

  // Before offering Resume, ask the backend whether the repository still matches the checkpoint.
  const sid = detail.session.id;
  useEffect(() => {
    setDrift(null);
    if (!actions.resume) return;
    let live = true;
    api<{ drift: Drift; nextAction: string }>(`/sessions/${sid}/resume-check`).then((r) => live && setDrift(r)).catch(() => {});
    return () => { live = false; };
  }, [sid, actions.resume, detail.session.updatedAt]);

  async function act(name: string, fn: () => Promise<unknown>) {
    setBusy(name); setError(null);
    try { await fn(); delete keys.current[name]; setArmed(false); onChanged(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }
  // The same key is reused if the user retries the same action, so a retry cannot start a second worker.
  const key = (name: string) => (keys.current[name] ??= newIdempotencyKey());

  const modelSelect = (
    <label className="row small">Model
      <select value={model} onChange={(e) => setModel(e.target.value)} style={{ width: 'auto' }} aria-label="Model">
        {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
      </select>
    </label>
  );

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row">
        {actions.start && task && (
          <>
            {modelSelect}
            <button className="btn primary" disabled={!!busy} onClick={() => act('start', () => api(`/tasks/${task.id}/runs`, { method: 'POST', body: { model }, headers: { 'idempotency-key': key('start') } }))}>
              {busy === 'start' ? 'Starting…' : '▶ Start run'}
            </button>
          </>
        )}
        {actions.resume && (
          <>
            {modelSelect}
            <button className="btn primary" disabled={!!busy || drift?.drift.level === 'blocked'} onClick={() => act('resume', () => api(`/sessions/${sid}/resume`, { method: 'POST', body: { model }, headers: { 'idempotency-key': key('resume') } }))}>
              {busy === 'resume' ? 'Resuming…' : '↻ Resume from checkpoint'}
            </button>
          </>
        )}
        {actions.cancel && activeRun && (
          <button className={`btn danger${armed ? ' armed' : ''}`} disabled={!!busy}
            onClick={() => armed ? void act('cancel', () => api(`/runs/${activeRun.id}/cancel`, { method: 'POST' })) : setArmed(true)}
            onBlur={() => setArmed(false)}>
            {busy === 'cancel' ? 'Cancelling…' : armed ? 'Click again to confirm cancel' : '■ Cancel run'}
          </button>
        )}
        {!actions.start && !actions.resume && !actions.cancel && <span className="muted small">{actions.why}</span>}
      </div>
      {actions.cancel && <p className="muted small" style={{ margin: 0 }}>Cancelling stops the agent and pauses the session. Your files are kept and you can resume from the checkpoint.</p>}
      {actions.resume && <p className="muted small" style={{ margin: 0 }}>{actions.why}</p>}
      {actions.resume && drift && (
        <div className={`banner ${drift.drift.level === 'blocked' ? 'bad' : drift.drift.level === 'changed' ? 'warn' : 'info'}`} role="status">
          <strong>Resume check: {drift.drift.level}.</strong> Next action: {drift.nextAction}
          {drift.drift.notes.map((n, i) => <div key={i}>• {n}</div>)}
          {drift.drift.level === 'blocked' && <div>Resume is blocked until this is fixed.</div>}
        </div>
      )}
      {error && <div className="banner bad" role="alert">{error}</div>}
    </div>
  );
}
