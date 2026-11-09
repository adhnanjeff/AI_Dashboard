'use client';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { api } from '../lib/api.ts';
import { parseUnifiedDiff, type DiffFile } from '../lib/diff.ts';
import type { Polled } from '../lib/hooks.ts';
import type { Changes } from '../lib/types.ts';
import DiffViewer, { newFileAsDiff } from './DiffViewer.tsx';
import { Ago, ErrorBanner } from './small.tsx';

const CODE: Record<string, string> = { added: 'A', deleted: 'D', modified: 'M', renamed: 'R', untracked: '?' };

export default function ChangesPanel({ sessionId, changes }: { sessionId: string; changes: Polled<Changes> }) {
  const data = changes.data;
  const parsed = useMemo(() => parseUnifiedDiff(data?.diff ?? ''), [data?.diff]);
  const byPath = useMemo(() => new Map<string, DiffFile>(parsed.files.map((f) => [f.path, f])), [parsed]);
  const [picked, setPicked] = useState<string | null>(null);
  const [untrackedFile, setUntrackedFile] = useState<{ path: string; file: DiffFile | null; error: string | null } | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const files = data?.files ?? [];
  const selected = files.find((f) => f.path === picked) ?? files[0] ?? null;

  // Untracked files are not in `git diff`, so fetch their content from the (allow-listed) file endpoint.
  useEffect(() => {
    if (!selected?.untracked) { setUntrackedFile(null); return; }
    let live = true;
    api<{ path: string; content: string }>(`/sessions/${sessionId}/file?path=${encodeURIComponent(selected.path)}`)
      .then((r) => live && setUntrackedFile({ path: r.path, file: newFileAsDiff(r.path, r.content), error: null }))
      .catch((e: Error) => live && setUntrackedFile({ path: selected.path, file: null, error: e.message }));
    return () => { live = false; };
  }, [sessionId, selected?.path, selected?.untracked, data?.computedAt]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const btns = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const i = btns.indexOf(document.activeElement as HTMLButtonElement); if (i < 0) return;
    e.preventDefault(); btns[Math.min(btns.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))].focus();
  };

  const shownDiff: DiffFile | null = !selected ? null : selected.untracked ? untrackedFile?.file ?? null : byPath.get(selected.path) ?? null;

  return (
    <section className="card" aria-labelledby="changes-h">
      <div className="row spread">
        <h2 id="changes-h">Changed files {data && <span className="muted small">({files.length})</span>}</h2>
        <button className="btn" onClick={() => void changes.refresh()}>Refresh</button>
      </div>
      <ErrorBanner error={changes.data ? null : changes.error} what="changes" />
      {changes.error && data && <div className="banner warn" role="status">Showing stale file changes: {changes.error.message}</div>}
      {data && (
        <p className="muted small" style={{ margin: '0 0 8px' }}>
          {data.available ? <>Branch <span className="mono">{data.branch ?? '?'}</span>{data.revision && <> @ <span className="mono">{data.revision.slice(0, 8)}</span></>} · </> : null}
          Read live from the working directory <Ago iso={data.computedAt} />.
          {data.checkpoint && (data.checkpoint.matchesNow
            ? <> Matches checkpoint #{data.checkpoint.seq}.</>
            : <strong> Files changed since checkpoint #{data.checkpoint.seq}.</strong>)}
        </p>
      )}
      {data && !data.available && <div className="banner warn" role="status">The working directory is missing or is not a git repository, so changes cannot be shown.</div>}
      {data?.available && files.length === 0 && <p className="muted">No uncommitted changes.</p>}
      {files.length > 0 && (
        <ul className="files" ref={listRef} onKeyDown={onKey} aria-label="Changed files (use arrow keys)">
          {files.map((f) => {
            const d = byPath.get(f.path);
            const code = f.untracked ? CODE.untracked : CODE[d?.status ?? 'modified'];
            return (
              <li key={f.path}>
                <button className="file-btn" aria-pressed={selected?.path === f.path} onClick={() => setPicked(f.path)}>
                  <span className="file-code" title={f.untracked ? 'untracked (new)' : d?.status}>{code}</span>
                  <span style={{ flex: 1, overflowWrap: 'anywhere' }}>{f.path}</span>
                  {d && <><span className="adds">+{d.additions}</span><span className="dels">−{d.deletions}</span></>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {data?.diffTruncated && <div className="banner warn" role="status">The diff is very large and was cut off.</div>}
      {selected && (shownDiff ? <DiffViewer file={shownDiff} />
        : selected.untracked && untrackedFile?.error ? <p className="muted">Cannot show this file: {untrackedFile.error}</p>
        : selected.untracked ? <p className="muted">Loading file…</p>
        : <p className="muted">No diff available for this file.</p>)}
    </section>
  );
}
