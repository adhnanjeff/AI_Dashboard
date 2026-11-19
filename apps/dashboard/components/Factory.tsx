'use client';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.ts';
import { describeEvent } from '../lib/events.ts';
import { usePolling } from '../lib/hooks.ts';
import type { Changes, DomainEvent, FactoryItem, FactorySnapshot, FactoryState } from '../lib/types.ts';
import { Ago, ErrorBanner } from './small.tsx';

/** Every state is a glyph + a word + a colour. Labels say what the database says, not what is pleasant. */
const META: Record<FactoryState, { label: string; glyph: string; tone: string }> = {
  queued: { label: 'Waiting', glyph: '○', tone: 'muted' }, paused: { label: 'Paused', glyph: '‖', tone: 'warn' }, blocked: { label: 'Blocked', glyph: '■', tone: 'warn' },
  running: { label: 'Working', glyph: '●', tone: 'info' }, waiting_approval: { label: 'Needs approval', glyph: '!', tone: 'warn' },
  completed: { label: 'Done', glyph: '✓', tone: 'good' }, skipped: { label: 'Skipped', glyph: '–', tone: 'muted' },
  failed: { label: 'Failed', glyph: '✕', tone: 'bad' }, cancelled: { label: 'Cancelled', glyph: '⊘', tone: 'muted' },
};
/** Where an item stands at its station. Purely a grouping of the stored state. */
const ZONES: { id: string; label: string; states: FactoryState[] }[] = [
  { id: 'wait', label: 'Waiting', states: ['queued', 'paused', 'blocked'] },
  { id: 'work', label: 'At the desk', states: ['running', 'waiting_approval'] },
  { id: 'done', label: 'Finished', states: ['completed', 'skipped'] },
  { id: 'bad', label: 'Problems', states: ['failed', 'cancelled'] },
];
const ICON: Record<string, string> = {
  planning: 'M4 5h16M4 12h10M4 19h6', coding: 'm8 7-5 5 5 5M16 7l5 5-5 5', testing: 'M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3',
  reviewing: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12ZM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6', integration: 'M6 3v8a4 4 0 0 0 4 4h8M18 11l4 4-4 4M6 3a2 2 0 1 0 0 .01',
};
const MAX_PER_ZONE = 6;

function Badge({ s, raw }: { s: FactoryState; raw?: string }) {
  const m = META[s]; return <span className={`badge tone-${m.tone}${s === 'running' ? ' pulse' : ''}`} title={raw ? `Stored status: ${raw}` : undefined}><span aria-hidden="true">{m.glyph}</span> {m.label}</span>;
}

/** The factory: stations that mirror the runtime. Only stored state is drawn; motion marks changes this page has actually seen. */
export default function Factory() {
  const snap = usePolling(() => api<FactorySnapshot>('/factory?activity=60'), 2000, 'factory');
  const [view, setView] = useState<'stations' | 'list'>('stations');
  const [showDemo, setShowDemo] = useState(true);
  const [selKey, setSelKey] = useState<string | null>(null);
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const prev = useRef<Map<string, FactoryState> | null>(null);
  const d = snap.data;

  // Highlight an item only when this page watched its state change. The first load highlights nothing.
  useEffect(() => {
    if (!d) return;
    const now = new Map(d.items.map((i) => [i.key, i.state] as const)); const before = prev.current; prev.current = now;
    if (!before) return;
    const changed = d.items.filter((i) => before.get(i.key) !== i.state).map((i) => i.key);
    if (!changed.length) return;
    setFlash((f) => new Set([...f, ...changed]));
    const t = setTimeout(() => setFlash((f) => { const n = new Set(f); changed.forEach((k) => n.delete(k)); return n; }), 2600);
    return () => clearTimeout(t);
  }, [d]);

  const items = useMemo(() => (d?.items ?? []).filter((i) => showDemo || !i.demo), [d, showDemo]);
  const sel = items.find((i) => i.key === selKey) ?? null;
  const count = (st: FactoryState[]) => items.filter((i) => st.includes(i.state)).length;
  const real = items.filter((i) => !i.demo).length; const demo = items.filter((i) => i.demo).length;

  return (
    <>
      <div className="page-head">
        <div className="row spread">
          <h1>Agent Factory</h1>
          <div className="row">
            <div className="seg two" role="group" aria-label="View">
              <button type="button" aria-pressed={view === 'stations'} onClick={() => setView('stations')}>Stations</button>
              <button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}>List</button>
            </div>
            <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={showDemo} onChange={(e) => setShowDemo(e.target.checked)} /> Show demo data</label>
          </div>
        </div>
        <p className="sub">A live view of real agent work, drawn from the orchestrator&apos;s records. Each token is one actual session or workflow step: select one to see its task, model, output and files. Nothing here is simulated.</p>
      </div>
      <ErrorBanner error={d ? null : snap.error} what="the factory" />
      {snap.error && d && <div className="banner warn">Showing stale data. Last update <Ago ms={snap.updatedAt} />. {snap.error.message}</div>}

      {d && (
        <>
          <div className="cards fac-cards">
            <div className="card stat-card tone-info"><span className="label"><span className="g" aria-hidden="true">●</span>Working</span><span className="stat">{count(['running'])}</span></div>
            <div className="card stat-card tone-warn"><span className="label"><span className="g" aria-hidden="true">!</span>Needs a person</span><span className="stat">{count(['waiting_approval', 'blocked', 'paused'])}</span></div>
            <div className="card stat-card tone-muted"><span className="label"><span className="g" aria-hidden="true">○</span>Waiting</span><span className="stat">{count(['queued'])}</span></div>
            <div className="card stat-card tone-good"><span className="label"><span className="g" aria-hidden="true">✓</span>Done</span><span className="stat">{count(['completed'])}</span></div>
            <div className="card stat-card tone-bad"><span className="label"><span className="g" aria-hidden="true">✕</span>Failed</span><span className="stat">{count(['failed'])}</span></div>
          </div>
          <p className="muted small" style={{ marginTop: -8 }}>{real} real item{real === 1 ? '' : 's'}{showDemo ? ` · ${demo} demo (dashed, tagged DEMO)` : ''} · updated <Ago ms={snap.updatedAt} /></p>
          {items.length === 0 && (
            <div className="card empty"><strong>The factory is empty.</strong><p>Nothing is running and nothing is queued. Start a session or a workflow and it will appear here as soon as it exists in the database.</p>
              <div className="row" style={{ justifyContent: 'center' }}><Link href="/new" className="btn primary">New session</Link><Link href="/workflows" className="btn">Workflows</Link></div></div>
          )}
        </>
      )}

      {d && items.length > 0 && (
        <div className="fac-layout">
          <div className="fac-main">
            {view === 'stations' ? (
              <section className="fac-line" aria-label="Stations">
                {d.stations.map((st, idx) => {
                  const mine = items.filter((i) => i.station === st.id);
                  return (
                    <div key={st.id} className="fac-station" data-empty={mine.length === 0}>
                      {idx > 0 && <svg className="fac-arrow" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>}
                      <header>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ICON[st.id]} /></svg>
                        <h2>{st.label}</h2><span className="muted small">{mine.length}</span>
                      </header>
                      <p className="muted small fac-blurb">{st.blurb}</p>
                      {ZONES.map((z) => {
                        const inZone = mine.filter((i) => z.states.includes(i.state)); if (!inZone.length) return null;
                        return (
                          <div key={z.id} className={`fac-zone z-${z.id}`}>
                            <h3>{z.label} <span>{inZone.length}</span></h3>
                            <ul>
                              {inZone.slice(0, MAX_PER_ZONE).map((i) => <li key={i.key}><Token i={i} on={selKey === i.key} fresh={flash.has(i.key)} pick={() => setSelKey(i.key)} /></li>)}
                              {inZone.length > MAX_PER_ZONE && <li className="muted small">+{inZone.length - MAX_PER_ZONE} more: see the List view</li>}
                            </ul>
                          </div>
                        );
                      })}
                      {mine.length === 0 && <p className="muted small fac-idle">Idle. Nothing here.</p>}
                    </div>
                  );
                })}
              </section>
            ) : (
              <section className="card" aria-label="All items">
                <table className="data">
                  <thead><tr><th scope="col">Item</th><th scope="col">Station</th><th scope="col">Status</th><th scope="col">Model</th><th scope="col">Updated</th></tr></thead>
                  <tbody>
                    {items.map((i) => (
                      <tr key={i.key} className={`${selKey === i.key ? 'sel ' : ''}${flash.has(i.key) ? 'fresh' : ''}`}>
                        <td><button type="button" className="linklike" onClick={() => setSelKey(i.key)}>{i.label}</button>{i.demo && <> <span className="badge demo">DEMO</span></>}
                          <div className="muted small">{i.workflowTitle ? `Workflow: ${i.workflowTitle}` : 'Session'}</div></td>
                        <td className="small">{d.stations.find((s) => s.id === i.station)?.label}</td>
                        <td><Badge s={i.state} raw={i.rawStatus} /></td>
                        <td className="small">{i.model ?? <span className="muted">none</span>}</td>
                        <td className="small"><Ago iso={i.updatedAt} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}

            <div className="grid-2 fac-below">
          <aside className="fac-detail" aria-label="Details">
            {sel ? <Detail i={sel} /> : <div className="card"><h2>Select an agent</h2><p className="muted">Pick any token or row to see the task it is on, the model, what it last said, its recorded events and the files it changed.</p></div>}
          </aside>
            <section className="card" aria-labelledby="act-h">
              <h2 id="act-h">What just happened</h2>
              <p className="muted small" style={{ marginTop: 0 }}>Recorded runtime events and workflow transitions, newest first.</p>
              {d.activity.length === 0 ? <p className="muted">No recorded activity yet.</p> : (
                <ol className="timeline" style={{ listStyle: 'none' }}>
                  {d.activity.slice(0, 40).map((a, n) => (
                    <li key={`${a.at}-${n}`}><span className="t"><Ago iso={a.at} /></span><span className="dot muted" aria-hidden="true">•</span>
                      <span className="detail">{a.text}<br /><span className="muted small">{a.source === 'workflow' ? 'workflow' : 'runtime'}{a.stepKey ? ` · ${a.stepKey}` : ''}</span></span></li>
                  ))}
                </ol>
              )}
            </section>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Token({ i, on, fresh, pick }: { i: FactoryItem; on: boolean; fresh: boolean; pick: () => void }) {
  const m = META[i.state];
  return (
    <button type="button" className={`fac-token tone-${m.tone}${on ? ' on' : ''}${fresh ? ' fresh' : ''}${i.demo ? ' demo' : ''}${i.state === 'running' ? ' live' : ''}`} aria-pressed={on} onClick={pick}
      title={`${i.label}: ${m.label}`}>
      <span className="g" aria-hidden="true">{m.glyph}</span>
      <span className="txt"><span className="nm">{i.label}</span><span className="sub">{m.label}{i.model ? ` · ${i.model}` : ''}{i.demo ? ' · DEMO' : ''}</span></span>
    </button>
  );
}

function Detail({ i }: { i: FactoryItem }) {
  const events = usePolling(() => api<DomainEvent[]>(`/sessions/${i.sessionId}/events`), 3000, `fev:${i.sessionId}`, !!i.sessionId);
  const changes = usePolling(() => api<Changes>(`/sessions/${i.sessionId}/changes`), 6000, `fch:${i.sessionId}`, !!i.sessionId);
  const evs = (events.data ?? []).filter((e) => !/^(agent\.(message|tool_result)|checkpoint\.)/.test(e.type)).slice(-12).reverse();
  return (
    <div className="card fac-card">
      <div className="row spread"><h2 style={{ margin: 0 }}>{i.label}</h2><Badge s={i.state} raw={i.rawStatus} /></div>
      {i.demo && <div className="banner warn" role="note">Demo data. This is a seeded sample, not a real run.</div>}
      <dl className="kv" style={{ marginTop: 12 }}>
        <dt>Source</dt><dd>{i.source === 'workflow' ? <>Workflow step <span className="mono">{i.stepKey}</span> of <Link href={`/workflows/${i.workflowId}`}>{i.workflowTitle}</Link></> : 'Standalone session'}</dd>
        <dt>Kind</dt><dd>{i.kind}{i.role ? ` · ${i.role}` : ''}</dd>
        <dt>Stored status</dt><dd className="mono">{i.rawStatus}</dd>
        <dt>Model</dt><dd>{i.model ? `${i.model} (${i.provider})` : <span className="muted">none: no model has run for this item</span>}</dd>
        {i.attempt !== null && <><dt>Attempt</dt><dd>{i.attempt}</dd></>}
        <dt>Started</dt><dd>{i.startedAt ? <Ago iso={i.startedAt} /> : <span className="muted">not started</span>}</dd>
        {i.endedAt && <><dt>Ended</dt><dd><Ago iso={i.endedAt} /></dd></>}
      </dl>
      {i.note && <div className="banner info" role="note" style={{ marginTop: 12 }}>{i.note}</div>}
      <h3>Last output</h3>
      {i.lastOutput ? <p style={{ margin: 0 }}>{i.lastOutput}</p> : <p className="muted" style={{ margin: 0 }}>Nothing recorded yet.</p>}
      <div className="row" style={{ marginTop: 14 }}>
        {i.sessionId && <Link className="btn" href={`/sessions/${i.sessionId}`}>Open session</Link>}
        {i.runId && <Link className="btn" href={`/runs/${i.runId}`}>Open run</Link>}
        {i.workflowId && <Link className="btn" href={`/workflows/${i.workflowId}`}>Open workflow</Link>}
      </div>
      {i.sessionId ? (
        <>
          <h3>Recorded events</h3>
          <ErrorBanner error={events.data ? null : events.error} what="events" />
          {evs.length === 0 ? <p className="muted small" style={{ margin: 0 }}>None yet.</p> : (
            <ul className="plain small">{evs.map((e) => { const v = describeEvent(e); return <li key={e.id}><span className="muted"><Ago iso={e.createdAt} /></span> {v.title}{v.detail ? <span className="muted"> · {String(v.detail).slice(0, 90)}</span> : null}</li>; })}</ul>
          )}
          <h3>Files changed</h3>
          {changes.data && changes.data.available ? (changes.data.files.length === 0 ? <p className="muted small" style={{ margin: 0 }}>No changes in the workspace.</p>
            : <ul className="plain mono">{changes.data.files.slice(0, 12).map((f) => <li key={f.path}>{f.path}{f.untracked ? ' (new)' : ''}</li>)}</ul>)
            : <p className="muted small" style={{ margin: 0 }}>{changes.data ? 'No workspace to inspect for this session.' : 'Loading…'}</p>}
        </>
      ) : <p className="muted small">This step has not created a session yet, so there are no events or files.</p>}
    </div>
  );
}
