'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, apiText, ApiError } from '../lib/api.ts';
import { bytes, duration, usd } from '../lib/format.ts';
import { useNow, usePolling } from '../lib/hooks.ts';
import type { RunDetail } from '../lib/types.ts';
import { Ago, ErrorBanner, StatusBadge } from './small.tsx';

export default function RunView({ id }: { id: string }) {
  const run = usePolling(() => api<RunDetail>(`/runs/${id}`), 3000, id);
  const now = useNow();
  const r = run.data;
  const [log, setLog] = useState<{ text: string | null; error: string | null; loading: boolean }>({ text: null, error: null, loading: false });
  const [hideNoise, setHideNoise] = useState(true);

  async function loadLog() {
    setLog({ text: null, error: null, loading: true });
    try { setLog({ text: await apiText(`/runs/${id}/log`), error: null, loading: false }); }
    catch (e) { setLog({ text: null, error: (e as Error).message, loading: false }); }
  }
  // Load the log once the run has ended (it is stored when the process exits).
  useEffect(() => { if (r && !r.active && log.text === null && !log.loading && !log.error) void loadLog(); }, [r?.active]); // eslint-disable-line react-hooks/exhaustive-deps

  if (run.error instanceof ApiError && run.error.status === 404) return <div className="card empty"><p><strong>Run not found.</strong></p><Link href="/" className="btn">Back to overview</Link></div>;

  const lines = log.text ? log.text.split('\n').filter((l) => !(hideNoise && /"subtype":"(hook_|thinking_tokens)|"type":"rate_limit_event"/.test(l))) : [];

  return (
    <>
      <div className="page-head">
        <p style={{ margin: 0 }}><Link href={r ? `/sessions/${r.sessionId}` : '/'}>← Back to session</Link></p>
        <div className="row"><h1>Run <span className="mono">{id.slice(4, 12)}</span></h1>{r && <StatusBadge state={r.status} pulse />}</div>
      </div>
      <ErrorBanner error={run.data ? null : run.error} what="run" />
      {run.error && r && <div className="banner warn" role="status">Showing stale data (last refreshed <Ago ms={run.updatedAt} />): {run.error.message}</div>}

      {r && (
        <div className="grid-2">
          <section className="card" aria-labelledby="det-h">
            <h2 id="det-h">Details</h2>
            <dl className="kv">
              <dt>Model</dt><dd>{r.model}</dd>
              <dt>Provider</dt><dd>{r.provider}</dd>
              <dt>Role</dt><dd>{r.role}</dd>
              <dt>Status</dt><dd>{r.status}{r.active ? ' (process is running)' : ''}</dd>
              <dt>Exit code</dt><dd>{r.exitCode ?? '—'}</dd>
              <dt>Outcome</dt><dd>{r.terminationReason ?? (r.active ? 'in progress' : '—')}</dd>
              <dt>Started</dt><dd>{r.startedAt ? new Date(r.startedAt).toLocaleString() : '—'}</dd>
              <dt>Duration</dt><dd>{duration(r.startedAt, r.endedAt, now)}</dd>
              <dt>Process id</dt><dd>{r.pid ?? '—'}</dd>
              <dt>Provider session</dt><dd className="mono">{r.cliSessionId ?? '—'}</dd>
              <dt>Cost</dt><dd>{r.usage.source === 'reported' && r.usage.costUsd !== undefined ? <>{usd(r.usage.costUsd)} <span className="muted small">(reported by the provider)</span></> : <span className="muted">not available</span>}</dd>
            </dl>
            <h3 style={{ marginTop: 14 }}>Artifacts</h3>
            {r.artifacts.length === 0 ? <p className="muted small">None yet.</p> : (
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {r.artifacts.map((a) => <li key={a.id}>{a.kind} · {bytes(a.bytes)} · <Ago iso={a.createdAt} />{a.kind === 'log' && <> · <a href={`/api/runs/${id}/log`} target="_blank" rel="noreferrer">open raw</a></>}</li>)}
              </ul>
            )}
          </section>

          <section className="card" aria-labelledby="log-h">
            <div className="row spread">
              <h2 id="log-h">Log</h2>
              <div className="row">
                <label className="row small"><input type="checkbox" checked={hideNoise} onChange={(e) => setHideNoise(e.target.checked)} /> Hide hook/token noise</label>
                <button className="btn" onClick={() => void loadLog()} disabled={log.loading}>{log.loading ? 'Loading…' : log.text === null ? 'Load log' : 'Reload'}</button>
              </div>
            </div>
            {r.active && <div className="banner info" role="status">The log is saved when the run ends. Follow progress on the session timeline.</div>}
            {log.error && <p className="muted">{log.error}</p>}
            {log.text !== null && <pre className="log" tabIndex={0} aria-label="Run log">{lines.join('\n') || '(empty)'}</pre>}
          </section>
        </div>
      )}
    </>
  );
}
