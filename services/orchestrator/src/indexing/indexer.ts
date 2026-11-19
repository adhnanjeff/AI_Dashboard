import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, resolve, sep } from 'node:path';
import { newId } from '../domain/ids.ts';
import { snapshot } from '../checkpoints/git.ts';
import type { MemoryService } from '../memory/memory-service.ts';
import type { Store } from '../storage/store.ts';
import { adminGit } from '../worktrees/git-admin.ts';
import { EXTRACTOR, TEXT_EXT, isTestPath, langOf, parseFile, symKey, symLabel, type CallRef, type ImportRef, type Parsed, type Sym } from './extract.ts';

export class IndexError extends Error { status: number; constructor(status: number, msg: string) { super(msg); this.status = status; } }

const now = () => new Date().toISOString();
const MAX_FILES = 5000, MAX_BYTES = 512 * 1024;
const SKIP = /(^|\/)(node_modules|\.git|\.next|dist|build|coverage|\.venv|__pycache__|\.sandbox)\//;
const sha = (s: string) => createHash('sha1').update(s).digest('hex');
const INFERRED_KINDS = ['relates_to', 'implements', 'affects', 'explains'] as const;

interface NodeRow { id: string; kind: string; name: string; path: string | null; line: number | null; endLine: number | null; provenance: string; verified: boolean; meta: any; sessionId: string | null }
interface EdgeRow { id: string; fromId: string; toId: string; kind: string; provenance: string; verified: boolean; path: string | null; line: number | null; evidence: string }
const nodeRow = (r: any): NodeRow => ({ id: r.id, kind: r.kind, name: r.name, path: r.path, line: r.line, endLine: r.end_line, provenance: r.provenance, verified: !!r.verified, meta: JSON.parse(r.meta || '{}'), sessionId: r.session_id });
const edgeRow = (r: any): EdgeRow => ({ id: r.id, fromId: r.from_id, toId: r.to_id, kind: r.kind, provenance: r.provenance, verified: !!r.verified, path: r.path, line: r.line, evidence: r.evidence });

interface FileEntry { path: string; size: number; mtimeMs: number }

/** Lists indexable files: tracked + untracked-but-not-ignored when it is a git repo, otherwise a directory walk. */
function listFiles(repo: string): FileEntry[] {
  let paths: string[] = [];
  const r = adminGit(repo, 'ls-files', '--cached', '--others', '--exclude-standard');
  if (r.code === 0) paths = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  else { const walk = (dir: string, rel: string) => { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) { if (!SKIP.test(`${p}/`)) walk(join(dir, e.name), p); } else paths.push(p); } }; walk(repo, ''); }
  const out: FileEntry[] = [];
  for (const p of [...new Set(paths)].sort()) {
    if (SKIP.test(p) || !TEXT_EXT.test(p)) continue;
    try { const st = statSync(join(repo, p)); if (st.isFile() && st.size <= MAX_BYTES) out.push({ path: p, size: st.size, mtimeMs: Math.floor(st.mtimeMs) }); } catch { /* deleted since listing */ }
    if (out.length >= MAX_FILES) break;
  }
  return out;
}

const TS_TRY = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];
function resolveTs(from: string, spec: string, files: Set<string>): string | null {
  if (!spec.startsWith('.')) return null;
  const base = posix.normalize(posix.join(posix.dirname(from), spec));
  const stem = base.replace(/\.(m|c)?jsx?$/i, '');
  for (const c of [base, ...TS_TRY.map((e) => base + e), ...TS_TRY.map((e) => stem + e), ...TS_TRY.map((e) => `${base}/index${e}`)]) if (files.has(c)) return c;
  return null;
}
function resolvePy(from: string, spec: string, names: string[], files: Set<string>): string[] {
  const dots = spec.match(/^\.+/)?.[0].length ?? 0; const rest = spec.slice(dots).replace(/\./g, '/');
  let dir = posix.dirname(from); for (let i = 1; i < dots; i++) dir = posix.dirname(dir);
  const roots = dots ? [dir === '.' ? '' : dir] : ['', posix.dirname(from) === '.' ? '' : posix.dirname(from)];
  const hit = new Set<string>();
  for (const root of roots) {
    const join_ = (x: string) => posix.normalize(root ? `${root}/${x}` : x);
    const mod = rest ? [join_(`${rest}.py`), join_(`${rest}/__init__.py`)] : [join_('__init__.py')];
    for (const m of mod) if (files.has(m)) hit.add(m);
    for (const n of names) for (const m of [join_(rest ? `${rest}/${n}.py` : `${n}.py`)]) if (files.has(m)) hit.add(m);
  }
  return [...hit];
}

export interface IndexResult { mode: 'full' | 'incremental'; files: number; parsed: number; removed: number; symbols: number; edges: number; revision: string | null; unchanged: number }
export interface Staleness { indexed: boolean; stale: boolean; reason: string; indexedRevision: string | null; headRevision: string | null; indexedAt: string | null; extractor: string | null; files: number; symbols: number; edges: number; changed: string[]; added: string[]; removed: string[] }

// Phase 10: a source-linked graph of the repository. Facts that come from reading the source are `extracted` (verified);
// facts recorded by this system (features, requirements, runs, decisions) are `recorded`; anything a model proposes is
// `inferred`, unverified, and must carry its rationale. The three are never merged, and each edge keeps path:line.
export class RepoIndex {
  private store: Store; private memory?: MemoryService; private q: ReturnType<Store['sql']>;
  constructor(store: Store, memory?: MemoryService) { this.store = store; this.memory = memory; this.q = store.sql(); }

  private project(id: string) { const p = this.store.getProject(id); if (!p) throw new IndexError(404, 'project not found'); return p; }
  private repoOf(id: string) { return resolve(this.project(id).repoPath); }
  private revisionOf(repo: string): { revision: string | null; branch: string | null } { const s = snapshot(repo); return { revision: s.available ? s.revision ?? null : null, branch: s.available ? s.branch ?? null : null }; }

  // ------------------------------------------------------------------ indexing
  index(projectId: string, o: { full?: boolean } = {}): IndexResult {
    const project = this.project(projectId); const repo = resolve(project.repoPath);
    if (!existsSync(repo)) throw new IndexError(409, `${repo} does not exist`);
    const first = !this.q.one('SELECT 1 FROM index_state WHERE project_id=?', projectId);
    const full = !!o.full || first;
    const current = listFiles(repo);
    const stored = new Map(this.q.all<any>('SELECT * FROM index_file WHERE project_id=?', projectId).map((r) => [r.path, r]));
    const toParse: { f: FileEntry; text: string; hash: string }[] = []; let unchanged = 0; const touch: FileEntry[] = [];
    for (const f of current) {
      const s = stored.get(f.path);
      if (!full && s && s.size === f.size && s.mtime_ms === f.mtimeMs) { unchanged++; continue; }
      let text: string; try { text = readFileSync(join(repo, f.path), 'utf8'); } catch { continue; }
      const hash = sha(text);
      if (!full && s && s.hash === hash) { unchanged++; touch.push(f); continue; }
      toParse.push({ f, text, hash });
    }
    const here = new Set(current.map((f) => f.path));
    const removed = [...stored.keys()].filter((p) => !here.has(p));
    const rev = this.revisionOf(repo);

    return this.q.tx(() => {
      for (const p of removed) { this.dropFile(projectId, p); this.q.run('DELETE FROM index_file WHERE project_id=? AND path=?', projectId, p); }
      for (const f of touch) this.q.run('UPDATE index_file SET mtime_ms=? WHERE project_id=? AND path=?', f.mtimeMs, projectId, f.path);
      for (const { f, text, hash } of toParse) {
        const parsed = parseFile(f.path, text);
        this.writeFile(projectId, f.path, parsed, text);
        this.q.run('INSERT INTO index_file (project_id,path,hash,size,mtime_ms,lang,indexed_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(project_id,path) DO UPDATE SET hash=excluded.hash,size=excluded.size,mtime_ms=excluded.mtime_ms,lang=excluded.lang,indexed_at=excluded.indexed_at',
          projectId, f.path, hash, f.size, f.mtimeMs, parsed.lang, now());
      }
      const edges = this.rebuildEdges(projectId, repo, here);
      const symbols = this.q.one<any>("SELECT COUNT(*) AS c FROM knowledge_node WHERE project_id=? AND kind='symbol'", projectId)!.c;
      const t = now();
      this.q.run(`INSERT INTO index_state (project_id,revision,branch,extractor,files,symbols,edges,full_at,updated_at,last_mode) VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision, branch=excluded.branch, extractor=excluded.extractor, files=excluded.files, symbols=excluded.symbols, edges=excluded.edges,
        full_at=CASE WHEN excluded.last_mode='full' THEN excluded.full_at ELSE index_state.full_at END, updated_at=excluded.updated_at, last_mode=excluded.last_mode`,
        projectId, rev.revision, rev.branch, EXTRACTOR, current.length, symbols, edges, t, t, full ? 'full' : 'incremental');
      return { mode: full ? 'full' : 'incremental', files: current.length, parsed: toParse.length, removed: removed.length, symbols, edges, revision: rev.revision, unchanged } as IndexResult;
    });
  }

  private dropFile(projectId: string, path: string) {
    const ids = this.q.all<any>('SELECT id FROM knowledge_node WHERE project_id=? AND path=? AND kind IN (\'file\',\'symbol\')', projectId, path).map((r) => r.id);
    for (const id of ids) { this.q.run('DELETE FROM knowledge_edge WHERE from_id=? OR to_id=?', id, id); this.q.run('DELETE FROM knowledge_node WHERE id=?', id); }
  }

  private writeFile(projectId: string, path: string, parsed: Parsed, text: string) {
    const prov = `extracted:${EXTRACTOR}`;
    const meta = JSON.stringify({ lang: parsed.lang, isTest: parsed.isTest, lines: parsed.lines, imports: parsed.imports, calls: parsed.calls, hash: sha(text) });
    const ex = this.q.one<any>("SELECT id FROM knowledge_node WHERE project_id=? AND kind='file' AND name=?", projectId, path);
    let fileId: string;
    if (ex) { fileId = ex.id; this.q.run('UPDATE knowledge_node SET meta=?, end_line=?, provenance=?, verified=1 WHERE id=?', meta, parsed.lines, prov, fileId); }
    else { fileId = newId('kn'); this.q.run("INSERT INTO knowledge_node (id,project_id,kind,name,provenance,verified,path,line,end_line,meta) VALUES (?,?,?,?,?,1,?,1,?,?)", fileId, projectId, 'file', path, prov, path, parsed.lines, meta); }
    for (const r of this.q.all<any>("SELECT id FROM knowledge_node WHERE project_id=? AND kind='symbol' AND path=?", projectId, path)) { this.q.run('DELETE FROM knowledge_edge WHERE from_id=? OR to_id=?', r.id, r.id); this.q.run('DELETE FROM knowledge_node WHERE id=?', r.id); }
    for (const s of parsed.symbols) {
      this.q.run("INSERT INTO knowledge_node (id,project_id,kind,name,provenance,verified,path,line,end_line,meta) VALUES (?,?,?,?,?,1,?,?,?,?)", newId('kn'), projectId, 'symbol', `${path}#${symKey(s)}`, prov, path, s.line, s.endLine,
        JSON.stringify({ label: symLabel(s), symbolKind: s.kind, exported: s.exported, owner: s.owner ?? null, key: symKey(s) }));
    }
  }

  /** Edges derived from source are rebuilt from the stored parse results every run (cheap: no file is re-read). Recorded and inferred edges are untouched. */
  private rebuildEdges(projectId: string, repo: string, files: Set<string>): number {
    this.q.run("DELETE FROM knowledge_edge WHERE project_id=? AND provenance LIKE 'extracted:%'", projectId);
    const prov = `extracted:${EXTRACTOR}`;
    const fileNodes = this.q.all<any>("SELECT * FROM knowledge_node WHERE project_id=? AND kind='file'", projectId).map(nodeRow);
    const symNodes = this.q.all<any>("SELECT * FROM knowledge_node WHERE project_id=? AND kind='symbol'", projectId).map(nodeRow);
    const fileId = new Map(fileNodes.map((n) => [n.path!, n.id]));
    const symsByFile = new Map<string, NodeRow[]>(); for (const s of symNodes) (symsByFile.get(s.path!) ?? symsByFile.set(s.path!, []).get(s.path!)!).push(s);
    const symByKey = new Map(symNodes.map((s) => [`${s.path}|${s.meta.key}`, s]));
    let count = 0;
    const edge = (from: string, to: string, kind: string, path: string | null, line: number | null, evidence: string) => {
      this.q.run('INSERT INTO knowledge_edge (id,from_id,to_id,kind,provenance,verified,project_id,path,line,evidence) VALUES (?,?,?,?,?,1,?,?,?,?)', newId('ke'), from, to, kind, prov, projectId, path, line, evidence.slice(0, 300)); count++;
    };
    const external = (name: string, kind: 'dependency' | 'external') => {
      const e = this.q.one<any>("SELECT id FROM knowledge_node WHERE project_id=? AND kind IN ('dependency','external') AND name=? ORDER BY kind LIMIT 1", projectId, name);
      if (e) return e.id as string;
      const id = newId('kn'); this.q.run('INSERT INTO knowledge_node (id,project_id,kind,name,provenance,verified) VALUES (?,?,?,?,?,1)', id, projectId, kind, name, prov); return id;
    };
    this.manifests(projectId, repo, files, fileId, edge, external);

    const pkgOf = (spec: string) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
    for (const fn of fileNodes) {
      const path = fn.path!; const m = fn.meta as { lang: string; isTest: boolean; imports: ImportRef[]; calls: CallRef[] };
      const local = new Map<string, { path: string; ref: ImportRef; imported: string }>();
      const seen = new Set<string>();
      for (const s of symsByFile.get(path) ?? []) edge(fn.id, s.id, 'contains', path, s.line, `${s.meta.symbolKind} ${s.meta.label}`);
      for (const ref of m.imports) {
        const targets = m.lang === 'py' ? resolvePy(path, ref.spec, ref.bindings.map((b) => b.imported), files) : (() => { const t = resolveTs(path, ref.spec, files); return t ? [t] : []; })();
        if (!targets.length) {
          const ext = m.lang === 'py' ? ref.spec.split('.')[0] : pkgOf(ref.spec);
          if (m.lang === 'ts' && ref.spec.startsWith('.')) continue; // unresolvable relative import: nothing to link
          if (ext) { const k = `x:${ext}`; if (!seen.has(k)) { seen.add(k); edge(fn.id, external(ext, this.q.one('SELECT 1 FROM knowledge_node WHERE project_id=? AND kind=\'dependency\' AND name=?', projectId, ext) ? 'dependency' : 'external'), 'imports_external', path, ref.line, ref.text); } }
          continue;
        }
        for (const t of targets) {
          const k = `f:${t}:${ref.line}`; if (seen.has(k)) continue; seen.add(k);
          edge(fn.id, fileId.get(t)!, 'imports', path, ref.line, ref.text);
          if (m.isTest && !isTestPath(t)) edge(fn.id, fileId.get(t)!, 'tests', path, ref.line, ref.text);
          for (const b of ref.bindings) local.set(b.local, { path: t, ref, imported: b.imported });
        }
      }
      // calls: resolve a name to a symbol in this file, an imported file, or the owning class
      for (const c of m.calls) {
        const caller = c.from ? symByKey.get(`${path}|${c.from}`) : undefined; const fromId = caller?.id ?? fn.id; if (c.from && !caller) continue;
        let to: NodeRow | undefined;
        const inFile = (p: string, name: string, owner?: string) => (symsByFile.get(p) ?? []).find((s) => s.meta.label === (owner ? `${owner}.${name}` : name) && ['function', 'class', 'method', 'variable'].includes(s.meta.symbolKind));
        if (c.via === 'this') { const owner = caller?.meta.owner; if (owner) to = inFile(path, c.name, owner); }
        else if (c.via) { const b = (local.get(c.via) as any); if (b?.imported === '*') to = inFile(b.path, c.name); }
        else {
          to = inFile(path, c.name);
          if (!to) { const b = local.get(c.name) as any; if (b && b.imported !== '*' && b.imported !== 'default') to = inFile(b.path, b.imported); }
        }
        if (to && to.id !== fromId) edge(fromId, to.id, 'calls', path, c.line, c.text);
      }
    }
    return count;
  }

  private manifests(projectId: string, repo: string, files: Set<string>, fileId: Map<string, string>, edge: (f: string, t: string, k: string, p: string | null, l: number | null, e: string) => void, external: (n: string, k: 'dependency' | 'external') => string) {
    const prov = `extracted:${EXTRACTOR}`;
    for (const path of [...files].filter((p) => /(^|\/)package\.json$/.test(p))) {
      let text: string, pkg: any; try { text = readFileSync(join(repo, path), 'utf8'); pkg = JSON.parse(text); } catch { continue; }
      const dir = posix.dirname(path) === '.' ? '' : posix.dirname(path);
      const lineOf = (needle: string) => { const i = text.split('\n').findIndex((l) => l.includes(`"${needle}"`)); return i < 0 ? 1 : i + 1; };
      const pkgName = `package:${pkg.name ?? (dir || '.')}`;
      const upsert = (kind: string, name: string, p: string, line: number, meta: object) => {
        const e = this.q.one<any>('SELECT id FROM knowledge_node WHERE project_id=? AND kind=? AND name=?', projectId, kind, name);
        if (e) { this.q.run('UPDATE knowledge_node SET path=?, line=?, meta=?, provenance=?, verified=1 WHERE id=?', p, line, JSON.stringify(meta), prov, e.id); return e.id as string; }
        const id = newId('kn'); this.q.run('INSERT INTO knowledge_node (id,project_id,kind,name,provenance,verified,path,line,meta) VALUES (?,?,?,?,?,1,?,?,?)', id, projectId, kind, name, prov, p, line, JSON.stringify(meta)); return id;
      };
      const pid = upsert('package', pkgName, path, 1, { version: pkg.version ?? null });
      if (fileId.has(path)) edge(fileId.get(path)!, pid, 'describes', path, 1, 'package.json');
      for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'])
        for (const [dep, ver] of Object.entries<string>(pkg[section] ?? {})) {
          const did = upsert('dependency', dep, path, lineOf(dep), { version: ver, section });
          edge(pid, did, 'depends_on', path, lineOf(dep), `${section}: "${dep}": "${ver}"`);
        }
      for (const [name, cmd] of Object.entries<string>(pkg.scripts ?? {})) {
        if (typeof cmd !== 'string') continue;
        const sid = upsert('script', `script:${pkgName}:${name}`, path, lineOf(name), { command: cmd, name });
        edge(pid, sid, 'has_script', path, lineOf(name), `"${name}": "${cmd}"`);
        const hit = new Set<string>();
        for (const tok of cmd.split(/\s+/)) {
          const rel = posix.normalize(dir ? `${dir}/${tok}` : tok).replace(/^\.\//, '');
          if (files.has(rel)) hit.add(rel);
          else if (tok.includes('*')) { const re = new RegExp(`^${(dir ? `${dir}/` : '') + tok.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`); for (const f of files) if (re.test(f) && hit.size < 60) hit.add(f); }
        }
        for (const f of hit) if (fileId.has(f)) edge(sid, fileId.get(f)!, 'runs', path, lineOf(name), `"${name}": "${cmd}"`);
      }
    }
  }

  // ------------------------------------------------------------------ staleness
  status(projectId: string): Staleness {
    const repo = this.repoOf(projectId); const st = this.q.one<any>('SELECT * FROM index_state WHERE project_id=?', projectId);
    const head = this.revisionOf(repo).revision;
    if (!st) return { indexed: false, stale: true, reason: 'This project has not been indexed yet.', indexedRevision: null, headRevision: head, indexedAt: null, extractor: null, files: 0, symbols: 0, edges: 0, changed: [], added: [], removed: [] };
    const stored = new Map(this.q.all<any>('SELECT * FROM index_file WHERE project_id=?', projectId).map((r) => [r.path, r]));
    const current = listFiles(repo); const changed: string[] = [], added: string[] = [];
    for (const f of current) {
      const s = stored.get(f.path);
      if (!s) { added.push(f.path); continue; }
      if (s.size === f.size && s.mtime_ms === f.mtimeMs) continue;
      try { if (sha(readFileSync(join(repo, f.path), 'utf8')) !== s.hash) changed.push(f.path); } catch { changed.push(f.path); }
    }
    const here = new Set(current.map((f) => f.path)); const removed = [...stored.keys()].filter((p) => !here.has(p));
    const stale = !!(changed.length || added.length || removed.length);
    const parts = [changed.length && `${changed.length} changed`, added.length && `${added.length} new`, removed.length && `${removed.length} deleted`].filter(Boolean).join(', ');
    const moved = st.revision && head && st.revision !== head;
    return { indexed: true, stale, indexedRevision: st.revision, headRevision: head, indexedAt: st.updated_at, extractor: st.extractor, files: st.files, symbols: st.symbols, edges: st.edges, changed: changed.slice(0, 100), added: added.slice(0, 100), removed: removed.slice(0, 100),
      reason: stale ? `The repository changed since it was indexed: ${parts}.` : moved ? `HEAD moved from ${st.revision.slice(0, 8)} to ${head!.slice(0, 8)}, but no indexed file differs, so the graph is still accurate.` : 'Up to date.' };
  }

  /** Re-index every project that already has an index and has changed. Used by the background timer. */
  refreshStale(): { projectId: string; result: IndexResult }[] {
    const out: { projectId: string; result: IndexResult }[] = [];
    for (const r of this.q.all<any>('SELECT project_id FROM index_state')) { try { if (this.status(r.project_id).stale) out.push({ projectId: r.project_id, result: this.index(r.project_id) }); } catch { /* a missing repo must not stop the others */ } }
    return out;
  }

  // ------------------------------------------------------------------ queries
  private fileNode(projectId: string, path: string): NodeRow | undefined { const r = this.q.one<any>("SELECT * FROM knowledge_node WHERE project_id=? AND kind='file' AND name=?", projectId, path); return r && nodeRow(r); }
  private need(projectId: string, path: string): NodeRow { const n = this.fileNode(projectId, path); if (!n) throw new IndexError(404, `"${path}" is not in the index (index the project, or the file is ignored)`); return n; }
  private edgesOf(id: string, dir: 'out' | 'in', kinds?: string[]): EdgeRow[] {
    return this.q.all<any>(`SELECT * FROM knowledge_edge WHERE ${dir === 'out' ? 'from_id' : 'to_id'}=?${kinds ? ` AND kind IN (${kinds.map(() => '?').join(',')})` : ''} ORDER BY path, line`, id, ...(kinds ?? [])).map(edgeRow);
  }
  private nodeById(id: string): NodeRow | undefined { const r = this.q.one<any>('SELECT * FROM knowledge_node WHERE id=?', id); return r && nodeRow(r); }
  private brief = (n: NodeRow) => ({ id: n.id, kind: n.kind, name: n.kind === 'symbol' ? `${n.path}#${n.meta.label}` : n.name, path: n.path, line: n.line, symbolKind: n.meta.symbolKind ?? null, verified: n.verified, provenance: n.provenance });
  private ev = (e: EdgeRow) => ({ edgeId: e.id, kind: e.kind, provenance: e.provenance, verified: e.verified, path: e.path, line: e.line, evidence: e.evidence });

  /** Files this file imports, to `depth` hops, each with the import line that proves it. */
  dependencies(projectId: string, path: string, depth = 1) { return this.walk(projectId, path, 'out', depth); }
  /** Files that (transitively) import this file: what a change here can affect downstream. */
  dependents(projectId: string, path: string, depth = 2) { return this.walk(projectId, path, 'in', depth); }
  private walk(projectId: string, path: string, dir: 'out' | 'in', depth: number) {
    const root = this.need(projectId, path); const seen = new Map<string, { node: NodeRow; depth: number; via: string; edge: EdgeRow }>(); let frontier = [root.id];
    for (let d = 1; d <= Math.min(depth, 6); d++) {
      const next: string[] = [];
      for (const id of frontier) for (const e of this.edgesOf(id, dir, ['imports'])) {
        const other = dir === 'out' ? e.toId : e.fromId; if (other === root.id || seen.has(other)) continue;
        const n = this.nodeById(other); if (!n || n.kind !== 'file') continue;
        seen.set(other, { node: n, depth: d, via: this.nodeById(id)!.name, edge: e }); next.push(other);
      }
      frontier = next;
    }
    return { root: path, direction: dir === 'out' ? 'dependencies' : 'dependents', results: [...seen.values()].map((v) => ({ ...this.brief(v.node), depth: v.depth, via: v.via, evidence: this.ev(v.edge) })).sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name)) };
  }
  /** Test files that depend on these files, directly or through other modules, plus the test cases that call into them. */
  testsFor(projectId: string, paths: string[], depth = 2) {
    const out = new Map<string, { test: ReturnType<RepoIndex['brief']>; covers: string[]; depth: number; evidence: ReturnType<RepoIndex['ev']> }>();
    for (const p of paths) {
      const root = this.need(projectId, p);
      for (const e of this.edgesOf(root.id, 'in', ['tests'])) { const n = this.nodeById(e.fromId)!; const x = out.get(n.name); if (x) { if (!x.covers.includes(p)) x.covers.push(p); } else out.set(n.name, { test: this.brief(n), covers: [p], depth: 1, evidence: this.ev(e) }); }
      for (const d of this.dependents(projectId, p, depth).results) for (const e of this.edgesOf(this.fileNode(projectId, d.path!)!.id, 'in', ['tests'])) {
        const n = this.nodeById(e.fromId)!; const x = out.get(n.name); if (x) { if (!x.covers.includes(p)) x.covers.push(p); } else out.set(n.name, { test: this.brief(n), covers: [p], depth: d.depth + 1, evidence: this.ev(e) });
      }
    }
    return { paths, tests: [...out.values()].sort((a, b) => a.depth - b.depth || a.test.name.localeCompare(b.test.name)) };
  }

  search(projectId: string, q: string, limit = 40) {
    this.project(projectId); const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
    return this.q.all<any>("SELECT * FROM knowledge_node WHERE project_id=? AND kind IN ('file','symbol','dependency','script','package','feature','requirement','decision') AND name LIKE ? ESCAPE '\\' ORDER BY (kind='file') DESC, length(name) LIMIT ?", projectId, like, Math.min(limit, 200)).map((r) => this.brief(nodeRow(r)));
  }

  /** One node with every edge in and out, the evidence for each, and the source lines it points at (checked against the file on disk). */
  node(id: string) {
    const n = this.nodeById(id); if (!n) throw new IndexError(404, 'node not found');
    const other = (e: EdgeRow, side: 'from' | 'to') => this.brief(this.nodeById(side === 'from' ? e.fromId : e.toId)!);
    const out = this.edgesOf(id, 'out').slice(0, 200).map((e) => ({ ...this.ev(e), other: other(e, 'to') }));
    const inn = this.edgesOf(id, 'in').slice(0, 200).map((e) => ({ ...this.ev(e), other: other(e, 'from') }));
    return { node: { ...this.brief(n), meta: n.kind === 'file' ? { lang: n.meta.lang, isTest: n.meta.isTest, lines: n.meta.lines } : n.meta, sessionId: n.sessionId }, out, in: inn, ...this.sourceOf(n) };
  }
  private sourceOf(n: NodeRow) {
    if (!n.path || !n.line) return { source: null };
    const projectId = this.q.one<any>('SELECT project_id FROM knowledge_node WHERE id=?', n.id)!.project_id; const repo = this.repoOf(projectId);
    const full = resolve(repo, n.path); if (!full.startsWith(repo + sep) && full !== repo) return { source: null };
    try {
      const text = readFileSync(full, 'utf8'); const idx = this.q.one<any>('SELECT hash FROM index_file WHERE project_id=? AND path=?', projectId, n.path);
      const lines = text.split('\n'); const start = Math.max(1, n.line - 2); const end = Math.min(lines.length, Math.max(n.line + 2, Math.min(n.endLine ?? n.line, n.line + 24)));
      return { source: { path: n.path, startLine: start, highlight: n.line, lines: lines.slice(start - 1, end), changedSinceIndexed: !!idx && idx.hash !== sha(text) } };
    } catch { return { source: { path: n.path, startLine: n.line, highlight: n.line, lines: [], missing: true, changedSinceIndexed: true } }; }
  }

  /** Files most relevant to a task: what a session touched, what the words of a query name, and their import neighbours and tests, each with a reason. */
  relevant(projectId: string, o: { query?: string; sessionId?: string; files?: string[]; limit?: number }) {
    this.project(projectId);
    const score = new Map<string, { score: number; reasons: { why: string; evidence?: ReturnType<RepoIndex['ev']> }[] }>();
    const add = (path: string, pts: number, why: string, evidence?: ReturnType<RepoIndex['ev']>) => { const x = score.get(path) ?? { score: 0, reasons: [] }; x.score += pts; if (x.reasons.length < 6) x.reasons.push({ why, evidence }); score.set(path, x); };
    const seeds = new Set<string>();
    for (const f of o.files ?? []) if (this.fileNode(projectId, f)) { seeds.add(f); add(f, 10, 'named explicitly'); }
    if (o.sessionId) for (const f of this.touchedBy(o.sessionId)) if (this.fileNode(projectId, f)) { seeds.add(f); add(f, 10, 'changed in this session'); }
    const stop = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'add', 'make', 'new', 'use', 'file', 'files', 'code', 'should', 'when', 'can']);
    for (const tok of [...new Set((o.query ?? '').toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [])].filter((t) => !stop.has(t)).slice(0, 12)) {
      for (const r of this.q.all<any>("SELECT * FROM knowledge_node WHERE project_id=? AND kind='file' AND lower(name) LIKE ? ESCAPE '\\' LIMIT 20", projectId, `%${tok.replace(/[%_\\]/g, '\\$&')}%`)) { add(r.name, 6, `path contains "${tok}"`); seeds.add(r.name); }
      const declSeen = new Set<string>();
      for (const r of this.q.all<any>("SELECT * FROM knowledge_node WHERE project_id=? AND kind='symbol' AND lower(json_extract(meta,'$.label')) LIKE ? ESCAPE '\\' LIMIT 20", projectId, `%${tok.replace(/[%_\\]/g, '\\$&')}%`)) { const n = nodeRow(r); if (declSeen.has(n.path!)) continue; declSeen.add(n.path!); add(n.path!, n.meta.symbolKind === 'test-case' ? 2 : 7, `declares ${n.meta.symbolKind} ${n.meta.label} (line ${n.line})`, { edgeId: '', kind: 'declares', provenance: n.provenance, verified: n.verified, path: n.path, line: n.line, evidence: n.meta.label }); seeds.add(n.path!); }
    }
    for (const s of [...seeds].slice(0, 25)) {
      for (const d of this.dependencies(projectId, s, 1).results) add(d.path!, 4, `imported by ${s}`, d.evidence);
      for (const d of this.dependents(projectId, s, 2).results) add(d.path!, d.depth === 1 ? 4 : 2, `${d.depth === 1 ? 'imports' : 'depends (via ' + d.via + ') on'} ${s}`, d.evidence);
      for (const t of this.testsFor(projectId, [s], 1).tests) add(t.test.path!, 3, `test that covers ${s}`, t.evidence);
    }
    const ranked = [...score.entries()].sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0])).slice(0, o.limit ?? 25);
    return { files: ranked.map(([path, v]) => ({ path, score: v.score, isTest: isTestPath(path), reasons: v.reasons })), seeds: [...seeds] };
  }

  private touchedBy(sessionId: string): string[] {
    const s = this.store.getSession(sessionId); if (!s) throw new IndexError(404, 'session not found');
    const set = new Set<string>();
    const wt = this.store.activeWorktreeForSession(sessionId);
    if (wt && existsSync(wt.path)) {
      const a = adminGit(wt.path, 'diff', '--name-only', wt.baseRevision); if (a.code === 0) a.stdout.split('\n').map((l) => l.trim()).filter(Boolean).forEach((p) => set.add(p));
      const u = adminGit(wt.path, 'ls-files', '--others', '--exclude-standard'); if (u.code === 0) u.stdout.split('\n').map((l) => l.trim()).filter(Boolean).forEach((p) => set.add(p));
    } else { const cp = this.store.latestCheckpoint(sessionId); for (const f of ((cp?.data as any)?.changedFiles ?? []) as string[]) set.add(f); }
    return [...set].sort();
  }

  // ------------------------------------------------------------------ session graph: features, requirements, decisions, runs
  private upsertNode(projectId: string, kind: string, name: string, prov: string, verified: boolean, meta: object, sessionId: string | null, path?: string) {
    const e = this.q.one<any>('SELECT id FROM knowledge_node WHERE project_id=? AND kind=? AND name=?', projectId, kind, name);
    if (e) { this.q.run('UPDATE knowledge_node SET meta=?, provenance=?, verified=?, session_id=? WHERE id=?', JSON.stringify(meta), prov, verified ? 1 : 0, sessionId, e.id); return e.id as string; }
    const id = newId('kn'); this.q.run('INSERT INTO knowledge_node (id,project_id,kind,name,provenance,verified,session_id,path,meta) VALUES (?,?,?,?,?,?,?,?,?)', id, projectId, kind, name, prov, verified ? 1 : 0, sessionId, path ?? null, JSON.stringify(meta)); return id;
  }
  /** Record what this system knows about a session as nodes and edges (idempotent): the feature, its requirements, runs, decisions, and the files its work touched. */
  linkSession(sessionId: string) {
    const s = this.store.getSession(sessionId); if (!s) throw new IndexError(404, 'session not found');
    const pid = s.projectId; const prov = 'recorded:session';
    const touched = this.touchedBy(sessionId);
    return this.q.tx(() => {
      const feature = this.upsertNode(pid, 'feature', `session:${s.id}`, prov, true, { title: s.title, status: s.status }, s.id);
      this.q.run("DELETE FROM knowledge_edge WHERE project_id=? AND provenance LIKE 'recorded:%' AND (from_id=? OR from_id IN (SELECT id FROM knowledge_node WHERE session_id=? AND kind IN ('run','requirement','decision')))", pid, feature, s.id);
      const edge = (from: string, to: string, kind: string, evidence: string, path?: string) => this.q.run('INSERT INTO knowledge_edge (id,from_id,to_id,kind,provenance,verified,project_id,path,evidence) VALUES (?,?,?,?,?,1,?,?,?)', newId('ke'), from, to, kind, prov, pid, path ?? null, evidence.slice(0, 300));
      for (const t of this.store.listTasks(s.id)) {
        t.acceptanceCriteria.forEach((c, i) => edge(feature, this.upsertNode(pid, 'requirement', `req:${t.id}:${i}`, prov, true, { text: c, task: t.id }, s.id), 'has_requirement', `acceptance criterion ${i + 1} of task "${t.description.slice(0, 60)}"`));
      }
      const runs = this.store.listRunsForSession(s.id);
      for (const r of runs) {
        const rid = this.upsertNode(pid, 'run', `run:${r.id}`, prov, true, { status: r.status, model: r.model, provider: r.provider, role: r.role }, s.id);
        edge(feature, rid, 'executed_by', `${r.role} run on ${r.model} (${r.status})`);
        for (const f of touched) { const fn = this.fileNode(pid, f); if (fn) edge(rid, fn.id, 'touched', `changed in the session's workspace`, f); }
      }
      if (!runs.length) for (const f of touched) { const fn = this.fileNode(pid, f); if (fn) edge(feature, fn.id, 'touched', `changed in the session's workspace`, f); }
      for (const m of this.memory?.list({ projectId: pid, sessionId: s.id, status: 'active' }) ?? []) {
        if (m.category !== 'decisions' && m.category !== 'rejected') continue;
        const did = this.upsertNode(pid, 'decision', `decision:${m.id}`, prov, true, { text: m.content, category: m.category, scope: m.scope }, s.id);
        edge(feature, did, m.category === 'rejected' ? 'rejected' : 'decided', m.content.slice(0, 120));
        for (const f of new Set(m.content.match(/[\w./-]+\.[a-z]{1,5}\b/gi) ?? [])) { const fn = this.fileNode(pid, f); if (fn) edge(did, fn.id, 'mentions', `the decision text names ${f}`, f); }
      }
      return { feature, touched };
    });
  }

  /** The graph for one session: its feature, requirements, runs, decisions and touched files, with their imports, dependents and tests. Source-linked, with a stale flag. */
  sessionGraph(sessionId: string) {
    const s = this.store.getSession(sessionId); if (!s) throw new IndexError(404, 'session not found');
    const { feature, touched } = this.linkSession(sessionId); const pid = s.projectId;
    const nodes = new Map<string, ReturnType<RepoIndex['brief']> & { role: string }>(); const edges = new Map<string, ReturnType<RepoIndex['ev']> & { from: string; to: string }>();
    const addNode = (n: NodeRow | undefined, role: string) => { if (n && !nodes.has(n.id) && nodes.size < 300) nodes.set(n.id, { ...this.brief(n), role }); };
    const addEdge = (e: EdgeRow) => { if (nodes.has(e.fromId) && nodes.has(e.toId)) edges.set(e.id, { ...this.ev(e), from: e.fromId, to: e.toId }); };
    const f = this.nodeById(feature)!; addNode(f, 'feature');
    const frontier: NodeRow[] = [];
    for (const e of this.edgesOf(feature, 'out')) { const n = this.nodeById(e.toId); addNode(n, n!.kind); if (n && n.kind === 'run') frontier.push(n); }
    for (const r of frontier) for (const e of this.edgesOf(r.id, 'out', ['touched'])) addNode(this.nodeById(e.toId), 'touched file');
    for (const p of touched) { const fn = this.fileNode(pid, p); if (fn) addNode(fn, 'touched file'); }
    for (const e of this.q.all<any>("SELECT * FROM knowledge_edge WHERE project_id=? AND provenance LIKE 'recorded:%' AND from_id IN (SELECT id FROM knowledge_node WHERE session_id=?)", pid, sessionId).map(edgeRow)) { addNode(this.nodeById(e.toId), 'recorded'); }
    for (const p of touched) {
      if (!this.fileNode(pid, p)) continue;
      for (const d of this.dependencies(pid, p, 1).results) addNode(this.nodeById(d.id), 'imported by touched file');
      for (const d of this.dependents(pid, p, 1).results) addNode(this.nodeById(d.id), 'depends on touched file');
      for (const t of this.testsFor(pid, [p], 1).tests) addNode(this.nodeById(t.test.id), 'test');
    }
    for (const id of nodes.keys()) { for (const e of this.edgesOf(id, 'out')) addEdge(e); }
    const idx = this.status(pid);
    const notInIndex = touched.filter((p) => !this.fileNode(pid, p));
    return { session: { id: s.id, title: s.title }, nodes: [...nodes.values()], edges: [...edges.values()], touched, touchedNotInIndex: notInIndex, staleness: idx,
      note: this.store.activeWorktreeForSession(sessionId) ? 'The index describes the main checkout. Files this session created in its worktree are listed under "not in the index" until they are merged and re-indexed.' : null };
  }

  /** An optional, model-proposed relationship. Stored as INFERRED: unverified, labelled, and never mixed with extracted facts. */
  addInferred(projectId: string, i: { fromId: string; toId: string; kind: string; rationale: string; model?: string; path?: string; line?: number }) {
    this.project(projectId);
    if (!(INFERRED_KINDS as readonly string[]).includes(i.kind)) throw new IndexError(400, `an inferred relationship must be one of ${INFERRED_KINDS.join(', ')}`);
    if (typeof i.rationale !== 'string' || i.rationale.trim().length < 10) throw new IndexError(400, 'an inferred relationship needs a rationale of at least 10 characters');
    for (const id of [i.fromId, i.toId]) { const n = this.nodeById(id); if (!n) throw new IndexError(404, `node ${id} not found`); if (this.q.one<any>('SELECT project_id FROM knowledge_node WHERE id=?', id)!.project_id !== projectId) throw new IndexError(400, 'nodes belong to another project'); }
    const id = newId('ke');
    this.q.run('INSERT INTO knowledge_edge (id,from_id,to_id,kind,provenance,verified,project_id,path,line,evidence) VALUES (?,?,?,?,?,0,?,?,?,?)', id, i.fromId, i.toId, i.kind, `inferred:${i.model ? `llm:${String(i.model).slice(0, 60)}` : 'unspecified'}`, projectId, i.path ?? null, i.line ?? null, i.rationale.trim().slice(0, 300));
    this.store.audit('user', 'index.inferred_edge', id, { kind: i.kind, from: i.fromId, to: i.toId, model: i.model ?? null });
    return edgeRow(this.q.one('SELECT * FROM knowledge_edge WHERE id=?', id));
  }
  removeInferred(edgeId: string) {
    const e = this.q.one<any>('SELECT * FROM knowledge_edge WHERE id=?', edgeId); if (!e) throw new IndexError(404, 'edge not found');
    if (!String(e.provenance).startsWith('inferred:')) throw new IndexError(409, 'only inferred relationships can be removed; extracted and recorded facts come from the source and the database');
    this.q.run('DELETE FROM knowledge_edge WHERE id=?', edgeId); return { removed: edgeId };
  }
  inferredEdges(projectId: string) { return this.q.all<any>("SELECT * FROM knowledge_edge WHERE project_id=? AND provenance LIKE 'inferred:%' ORDER BY rowid", projectId).map(edgeRow); }
}

