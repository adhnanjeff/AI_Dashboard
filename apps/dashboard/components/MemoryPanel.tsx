'use client';
import { useState, type FormEvent } from 'react';
import { api } from '../lib/api.ts';
import { PROJECT_CATEGORIES, SESSION_CATEGORIES } from '../lib/models.ts';
import { usePolling } from '../lib/hooks.ts';
import type { MemoryEntry } from '../lib/types.ts';
import { Ago, ErrorBanner } from './small.tsx';

interface Props { scope: 'project' | 'session'; id: string; heading: string; blurb: string }

/** Lists the active notes of one scope grouped by category, and lets a person add, retire and compact them. */
export default function MemoryPanel({ scope, id, heading, blurb }: Props) {
  const base = scope === 'project' ? `/projects/${id}/memory` : `/sessions/${id}/memory`;
  const list = usePolling(() => api<MemoryEntry[]>(base), 6000, `mem:${base}`);
  const categories: readonly string[] = scope === 'project' ? PROJECT_CATEGORIES : SESSION_CATEGORIES;
  const [category, setCategory] = useState<string>(categories[0]);
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'bad' | 'info'; text: string } | null>(null);

  async function run(fn: () => Promise<string | void>) {
    setBusy(true); setMsg(null);
    try { const text = await fn(); if (text) setMsg({ tone: 'info', text }); await list.refresh(); }
    catch (e) { setMsg({ tone: 'bad', text: (e as Error).message }); }
    finally { setBusy(false); }
  }
  const add = (e: FormEvent) => { e.preventDefault(); void run(async () => {
    const r = await api<{ deduped: boolean }>(base, { method: 'POST', body: { category, content: content.trim() } });
    setContent(''); return r.deduped ? 'That note already exists; it was not added twice.' : undefined;
  }); };

  const entries = list.data ?? [];
  const h = `mem-h-${scope}`;
  return (
    <section className="card" aria-labelledby={h}>
      <div className="row spread">
        <h2 id={h}>{heading} {list.data && <span className="muted small">({entries.length})</span>}</h2>
        <button className="btn" disabled={busy} onClick={() => void run(async () => {
          const r = await api<{ superseded: string[]; archived: string[] }>(`${base}/compact`, { method: 'POST', body: {} });
          return `Compaction merged ${r.superseded.length} near-duplicate and archived ${r.archived.length} old note(s).`;
        })}>Compact</button>
      </div>
      <p className="muted small" style={{ margin: '0 0 8px' }}>{blurb}</p>
      <ErrorBanner error={list.data ? null : list.error} what="memory" />
      {list.error && list.data && <div className="banner warn" role="status">Showing stale notes: {list.error.message}</div>}
      {list.data && entries.length === 0 && <p className="muted">No notes yet.</p>}
      {categories.map((c) => {
        const rows = entries.filter((e) => e.category === c);
        return rows.length === 0 ? null : (
          <div key={c}>
            <h3 style={{ textTransform: 'capitalize' }}>{c.replace('-', ' ')}</h3>
            <ul className="notes">
              {rows.map((e) => (
                <li key={e.id}>
                  <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{e.content}</div>
                  <div className="muted small row">
                    <span>{e.trust === 'user' ? 'You' : `Agent (${e.authorRole})`}</span>
                    <span>source: {e.source.kind}{e.source.ref ? `:${e.source.ref}` : ''}</span>
                    <span>updated <Ago iso={e.updatedAt} /></span>
                    {e.seenCount > 1 && <span>seen {e.seenCount}×</span>}
                    <button className="btn" disabled={busy} onClick={() => void run(async () => { await api(`/memory/${e.id}/archive`, { method: 'POST', body: {} }); })} aria-label={`Archive note: ${e.content.slice(0, 40)}`}>Archive</button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      <form className="stackf" onSubmit={add} style={{ marginTop: 12 }}>
        <div className="row">
          <label className="row small">Category
            <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ width: 'auto' }}>
              {categories.map((c) => <option key={c} value={c}>{c.replace('-', ' ')}</option>)}
            </select>
          </label>
        </div>
        <label className="field">New note <span className="hint">A short fact, not a document. Never paste secrets: they are refused.</span>
          <textarea required maxLength={2000} value={content} onChange={(e) => setContent(e.target.value)} />
        </label>
        {msg && <div className={`banner ${msg.tone}`} role={msg.tone === 'bad' ? 'alert' : 'status'}>{msg.text}</div>}
        <div className="row"><button className="btn primary" type="submit" disabled={busy || !content.trim()}>Add note</button></div>
      </form>
    </section>
  );
}
