# Phase 10 decision record: repository index and knowledge graph

Scope (roadmap §14): index files, symbols, imports, tests and dependencies; link sessions, requirements, decisions and runs; separate verified from inferred facts; keep it fresh; answer "what is relevant / what breaks / which tests". Exit: queries return relevant files with evidence, and stale data is detectable.

## Decisions

### D1. Regex extractor, no parser dependency
`EXTRACTOR = 'regex-v1'` for TS/JS and Python plus `package.json` manifests. Comments are stripped keeping line numbers. Extracts symbols (function, class, method, interface, type, enum, variable, test-case), imports with bindings, and call sites by name. Resolves relative imports, Python modules, namespace calls and `this.` calls. A real parser would be more accurate; this keeps the backend dependency-free.

### D2. The graph reuses `knowledge_node` / `knowledge_edge`
Migration 8 adds path, line, end_line, meta, session_id, project_id, evidence, a unique `(project_id, kind, name)` index, plus `index_file` (hash, size, mtime) and `index_state`. `addNode`/`addEdge` now use named columns.

### D3. Every fact carries provenance
- `extracted:regex-v1`: verified, rebuilt from source.
- `recorded:session`: feature, requirement, run, decision nodes.
- `inferred:llm:<model>`: unverified; needs a rationale of at least 10 characters; kinds limited to relates_to / implements / affects / explains; removable.
- Edge kinds extracted: contains, imports, imports_external, calls, tests, depends_on, runs, has_script, describes. Recorded: has_requirement, executed_by, touched, decided, rejected, mentions.

### D4. Incremental and deterministic
Stat check first, then content hash; only changed files are re-parsed. All extracted edges are rebuilt from stored parse metadata each run, so results are deterministic (tested). Recorded and inferred edges survive.

### D5. Staleness is detectable
`status()` compares files by content hash and reports changed/added/removed and whether HEAD moved. `node()` returns a source snippet and a `changedSinceIndexed` flag. A background timer (`indexIntervalMs` = 20 s in `main.ts`) refreshes only already-indexed projects.

### D6. Queries return reasons
dependencies, dependents (downstream impact), testsFor, search, node, sessionGraph, `relevant` (scored, with reasons and evidence; test-case symbols weighted down), `linkSession` (idempotent).

### API and UI
`/projects/:id/index` (GET/POST), `/graph/search|files|relevant|inferred`, `/graph/nodes/:id`, `/graph/edges/:id/remove`, `/sessions/:id/graph`. Dashboard "Code graph": status banner with Update/Rebuild, find-code search, node inspector, per-session graph.

## Not done / limits
- The index covers the **main checkout only**; unmerged worktree files show as "not in the index".
- Regex extraction misses dynamic imports, re-export chains, and cross-language calls; call edges are by name and can over-link.
- Only TS/JS/Python. No embeddings, no LLM-produced inferences are generated automatically (the API accepts them).

## Testing
`tests/unit/phase10.test.ts`, 10 tests: extraction, graph facts and provenance, queries, node source/stale flag, staleness and incremental indexing, determinism, session graph, inferred edges, a real-repo test on this repository, HTTP.
Manual: restart `npm run api`, open Code graph, press Update, search a function name, open a node, edit a file and see it flagged changed.
