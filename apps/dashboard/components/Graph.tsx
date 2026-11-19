'use client';
import { useState, type FormEvent } from 'react';
import { api } from '../lib/api.ts';
import { usePolling } from '../lib/hooks.ts';
import type { FileLinks, GraphEvidence, GraphNodeBrief, GraphNodeDetail, IndexStatus, Project, RelevantFile, SessionGraph, SessionSummary } from '../lib/types.ts';
import { Ago, ErrorBanner } from './small.tsx';

const short = (rev: string | null) => (rev ? rev.slice(0, 8) : 'none');
/** How a fact got into the graph, in words. Extracted = read from source; recorded = from this system's own records; inferred = proposed, unverified. */
const sourceLabel = (prov: string) => (prov.startsWith('extracted') ? 'read from source' : prov.startsWith('recorded') ? 'recorded by the system' : 'INFERRED, not verified');
const loc = (e: { path: string | null; line: number | null }) => (e.path ? `${e.path}${e.line ? `:${e.line}` : ''}` : '');

function Evidence({ e }: { e: GraphEvidence }) {
  return <span className="muted small"><span className="mono">{loc(e)}</span> {e.evidence && <span className="mono">· {e.evidence.slice(0, 90)}</span>} <em>({sourceLabel(e.provenance)})</em></span>;
}

/** Code graph: what the repository's source says about itself, linked to features, runs and decisions, with the evidence for each link. */
export default function Graph() {
  const projects = usePolling(() => api<Project[]>('/projects'), 30000, 'projects');
  const sessions = usePolling(() => api<SessionSummary[]>('/sessions'), 10000, 'graph-sessions');
  const [projectId, setProjectId] = useState('');
  const ps = projects.data ?? []; const pid = projectId || ps[0]?.id || '';
  const status = usePolling(() => (pid ? api<IndexStatus>(`/projects/${pid}/index`) : Promise.resolve(null as unknown as IndexStatus)), 5000, `idx:${pid}`, !!pid);
  const [query, setQuery] = useState(''); const [hits, setHits] = useState<GraphNodeBrief[] | null>(null); const [rel, setRel] = useState<RelevantFile[] | null>(null);
  const [node, setNode] = useState<GraphNodeDetail | null>(null); const [links, setLinks] = useState<{ path: string; data: FileLinks } | null>(null);
  const [sg, setSg] = useState<SessionGraph | null>(null); const [sessionId, setSessionId] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const st = status.data;

  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> { setBusy(true); setError(null); try { return await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  const reindex = (full: boolean) => run(async () => { await api(`/projects/${pid}/index`, { method: 'POST', body: { full } }); await status.refresh(); });
  const search = (e: FormEvent) => { e.preventDefault(); void run(async () => {
    setNode(null); setLinks(null);
    setHits(await api<GraphNodeBrief[]>(`/projects/${pid}/graph/search?q=${encodeURIComponent(query)}`));
    setRel((await api<{ files: RelevantFile[] }>(`/projects/${pid}/graph/relevant?query=${encodeURIComponent(query)}`)).files);
  }); };
  const open = (id: string) => run(async () => { const n = await api<GraphNodeDetail>(`/graph/nodes/${id}`); setNode(n); setLinks(null); if (n.node.kind === 'file' && n.node.path) setLinks({ path: n.node.path, data: await api<FileLinks>(`/projects/${pid}/graph/files?path=${encodeURIComponent(n.node.path)}&depth=2`) }); });
  const openPath = (path: string) => run(async () => { const f = await api<GraphNodeBrief[]>(`/projects/${pid}/graph/search?q=${encodeURIComponent(path)}`); const hit = f.find((x) => x.kind === 'file' && x.name === path); if (hit) await open(hit.id); });
  const loadSession = (id: string) => { setSessionId(id); setSg(null); if (id) void run(async () => setSg(await api<SessionGraph>(`/sessions/${id}/graph`))); };
  const projectSessions = (sessions.data ?? []).filter((s) => s.project.id === pid).map((s) => s.session);

  return (
    <>
      <div className="page-head">
        <h1>Code graph</h1>
        <p className="sub">A map of the repository built by reading its source: files, functions and classes, who imports and calls whom, which tests cover what, plus the features, requirements, decisions and runs recorded here. Every link shows the line it came from.</p>
      </div>
      <ErrorBanner error={projects.data ? null : projects.error} what="projects" />
      {error && <div className="banner bad" role="alert">{error}</div>}

      <section className="card" aria-labelledby="idx-h">
        <div className="row spread"><h2 id="idx-h">Index</h2>
          <label className="row small">Project<select value={pid} onChange={(e) => { setProjectId(e.target.value); setHits(null); setRel(null); setNode(null); setSg(null); setSessionId(''); }} style={{ width: 'auto' }}>{ps.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label></div>
        {st && (
          <>
            <div className={`banner ${!st.indexed || st.stale ? 'warn' : 'info'}`} role="status"><strong>{!st.indexed ? 'Not indexed.' : st.stale ? 'Out of date.' : 'Current.'}</strong> {st.reason}</div>
            {st.indexed && <p className="muted small" style={{ margin: '4px 0 10px' }}>{st.files} files · {st.symbols} symbols · {st.edges} links · indexed <Ago iso={st.indexedAt} /> at revision <span className="mono">{short(st.indexedRevision)}</span> (repository is at <span className="mono">{short(st.headRevision)}</span>) · extractor {st.extractor}. The index covers the main checkout; a session's unmerged worktree is not in it.</p>}
            {st.stale && st.indexed && <p className="small" style={{ margin: '0 0 8px' }}>{[...st.changed.map((p) => `changed: ${p}`), ...st.added.map((p) => `new: ${p}`), ...st.removed.map((p) => `deleted: ${p}`)].slice(0, 6).join(' · ')}</p>}
            <div className="row">
              <button className="btn primary" disabled={busy || !pid} onClick={() => void reindex(false)}>{st.indexed ? 'Update index (changed files only)' : 'Build index'}</button>
              {st.indexed && <button className="btn" disabled={busy} onClick={() => void reindex(true)}>Rebuild from scratch</button>}
              <span className="muted small">It also updates itself about every 20 seconds once built.</span>
            </div>
          </>
        )}
      </section>

      {st?.indexed && (
        <>
          <section className="card" aria-labelledby="find-h">
            <h2 id="find-h">Find code</h2>
            <form onSubmit={search} className="row" style={{ alignItems: 'flex-end' }}>
              <label className="field" style={{ flex: '1 1 320px' }}>Describe what you are working on, or type a file or function name<input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="routing policy escalation budget" /></label>
              <button className="btn primary" type="submit" disabled={busy || !query.trim()}>Search</button>
            </form>
            {rel && rel.length > 0 && (
              <>
                <h3>Most relevant files</h3>
                <table className="data">
                  <thead><tr><th scope="col">File</th><th scope="col">Why it is here</th></tr></thead>
                  <tbody>{rel.slice(0, 12).map((f) => (
                    <tr key={f.path}><td><button className="linklike mono" onClick={() => void openPath(f.path)}>{f.path}</button>{f.isTest && <span className="badge tone-muted" style={{ marginLeft: 6 }}>test</span>}</td>
                      <td className="small">{f.reasons.slice(0, 3).map((r, i) => <div key={i}>{r.why}{r.evidence && r.evidence.line ? <> <span className="muted mono">{loc(r.evidence)}</span></> : null}</div>)}</td></tr>
                  ))}</tbody>
                </table>
              </>
            )}
            {hits && (
              <>
                <h3>Matching names</h3>
                {hits.length === 0 ? <p className="muted">Nothing matches.</p> : (
                  <ul className="plain small">{hits.slice(0, 25).map((h) => <li key={h.id}><button className="linklike mono" onClick={() => void open(h.id)}>{h.name}</button> <span className="muted">{h.symbolKind ?? h.kind}{h.line ? ` · line ${h.line}` : ''}</span></li>)}</ul>
                )}
              </>
            )}
          </section>

          {node && (
            <section className="card" aria-labelledby="node-h">
              <h2 id="node-h"><span className="mono" style={{ fontSize: 15 }}>{node.node.name}</span></h2>
              <p className="muted small" style={{ marginTop: 0 }}>{node.node.symbolKind ?? node.node.kind} · {sourceLabel(node.node.provenance)}{!node.node.verified && ' · unverified'}</p>
              {node.source && (
                <>
                  {node.source.changedSinceIndexed && <div className="banner warn" role="status">This file has changed since it was indexed. The lines below are what is on disk now and may not match the graph. Update the index.</div>}
                  <pre className="log" aria-label={`Source of ${node.source.path}`}>{node.source.lines.map((l, i) => { const n = node.source!.startLine + i; return `${node.source!.highlight === n ? '▶' : ' '} ${String(n).padStart(4)}  ${l}\n`; }).join('')}</pre>
                </>
              )}
              {links && (
                <div className="grid-2">
                  <div>
                    <h3>Imports</h3>
                    {links.data.dependencies.length === 0 ? <p className="muted small">Nothing inside the repository.</p> : <ul className="plain small">{links.data.dependencies.map((d) => <li key={d.id}><button className="linklike mono" onClick={() => void openPath(d.path!)}>{d.path}</button><br /><Evidence e={d.evidence} /></li>)}</ul>}
                    <h3>Tests that cover it</h3>
                    {links.data.tests.length === 0 ? <p className="muted small">No test imports this file, directly or through another module.</p> : <ul className="plain small">{links.data.tests.map((t) => <li key={t.test.id}><button className="linklike mono" onClick={() => void openPath(t.test.path!)}>{t.test.path}</button> <span className="muted">{t.depth === 1 ? 'imports it' : `${t.depth} steps away`}</span><br /><Evidence e={t.evidence} /></li>)}</ul>}
                  </div>
                  <div>
                    <h3>What a change here can affect</h3>
                    {links.data.dependents.length === 0 ? <p className="muted small">Nothing imports this file.</p> : <ul className="plain small">{links.data.dependents.map((d) => <li key={d.id}><button className="linklike mono" onClick={() => void openPath(d.path!)}>{d.path}</button> <span className="muted">{d.depth === 1 ? 'imports it' : `via ${d.via}`}</span><br /><Evidence e={d.evidence} /></li>)}</ul>}
                  </div>
                </div>
              )}
              <div className="grid-2">
                <div><h3>Links out ({node.out.length})</h3><ul className="plain small">{node.out.slice(0, 40).map((e) => <li key={e.edgeId}><strong>{e.kind.replace(/_/g, ' ')}</strong> <button className="linklike mono" onClick={() => void open(e.other.id)}>{e.other.name}</button><br /><Evidence e={e} /></li>)}</ul></div>
                <div><h3>Links in ({node.in.length})</h3><ul className="plain small">{node.in.slice(0, 40).map((e) => <li key={e.edgeId}><button className="linklike mono" onClick={() => void open(e.other.id)}>{e.other.name}</button> <strong>{e.kind.replace(/_/g, ' ')}</strong> this<br /><Evidence e={e} /></li>)}</ul></div>
              </div>
            </section>
          )}

          <section className="card" aria-labelledby="sg-h">
            <h2 id="sg-h">A session&apos;s graph</h2>
            <p className="muted small" style={{ marginTop: 0 }}>The feature, its requirements, runs and decisions, the files its work touched, and the code and tests around them.</p>
            <label className="field" style={{ maxWidth: 420 }}>Session<select value={sessionId} onChange={(e) => loadSession(e.target.value)}><option value="">Choose a session…</option>{projectSessions.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}</select></label>
            {sg && (
              <>
                {sg.staleness.stale && <div className="banner warn" role="status"><strong>Index out of date.</strong> {sg.staleness.reason}</div>}
                {sg.touchedNotInIndex.length > 0 && <div className="banner info" role="status">Not in the index (new in the session&apos;s workspace): <span className="mono">{sg.touchedNotInIndex.join(', ')}</span></div>}
                {sg.note && <p className="muted small">{sg.note}</p>}
                {['feature', 'requirement', 'decision', 'run', 'touched file', 'depends on touched file', 'imported by touched file', 'test'].map((role) => {
                  const ns = sg.nodes.filter((n) => n.role === role); if (!ns.length) return null;
                  return <div key={role}><h3>{role[0].toUpperCase() + role.slice(1)}{role.endsWith('s') ? '' : 's'} ({ns.length})</h3>
                    <ul className="plain small">{ns.slice(0, 30).map((n) => <li key={n.id}><button className="linklike mono" onClick={() => void open(n.id)}>{n.kind === 'file' || n.kind === 'symbol' ? n.name : n.name.replace(/^[a-z]+:/, '')}</button> <span className="muted">{sourceLabel(n.provenance)}</span></li>)}</ul></div>;
                })}
              </>
            )}
          </section>
        </>
      )}
    </>
  );
}
