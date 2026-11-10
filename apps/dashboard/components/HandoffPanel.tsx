'use client';
import { useState } from 'react';
import { api } from '../lib/api.ts';
import type { Handoff } from '../lib/types.ts';

/** Builds the handoff on demand from persisted state and the live repository (nothing is cached or invented). */
export default function HandoffPanel({ sessionId }: { sessionId: string }) {
  const [h, setH] = useState<Handoff | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [copied, setCopied] = useState(false);
  async function build() {
    setBusy(true); setError(null); setCopied(false);
    try { setH(await api<Handoff>(`/sessions/${sessionId}/handoff`)); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(h!.markdown); setCopied(true); } catch { setError('Could not copy; select the text and copy it manually.'); }
  }
  return (
    <section className="card" aria-labelledby="handoff-h">
      <div className="row spread">
        <h2 id="handoff-h">Handoff summary</h2>
        <div className="row">
          {h && <button className="btn" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</button>}
          <button className="btn" onClick={() => void build()} disabled={busy}>{busy ? 'Building…' : h ? 'Rebuild' : 'Build handoff'}</button>
        </div>
      </div>
      <p className="muted small" style={{ margin: '0 0 8px' }}>For giving this work to a new worker: built from recorded state and the repository as it is now. Agent claims are labelled unverified.</p>
      {error && <div className="banner bad" role="alert">{error}</div>}
      {h && <pre className="log" tabIndex={0} aria-label="Handoff summary" style={{ maxHeight: 360 }}>{h.markdown}</pre>}
      {h && <p className="muted small" style={{ margin: '6px 0 0' }}>Built {new Date(h.generatedAt).toLocaleTimeString()}.</p>}
    </section>
  );
}
