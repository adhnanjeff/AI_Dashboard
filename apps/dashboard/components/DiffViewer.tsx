import type { DiffFile } from '../lib/diff.ts';

/** Renders one parsed file diff. Every changed line carries a +/- sign, so colour is never the only cue. */
export default function DiffViewer({ file }: { file: DiffFile }) {
  if (file.binary) return <p className="muted">Binary file: no text diff available.</p>;
  if (!file.hunks.length) return <p className="muted">No line changes to show ({file.status}).</p>;
  return (
    <div className="diff-wrap" tabIndex={0} role="region" aria-label={`Diff of ${file.path}`}>
      <table className="diff">
        <tbody>
          {file.hunks.map((h, hi) => (
            <HunkRows key={hi} header={h.header} lines={h.lines} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HunkRows({ header, lines }: { header: string; lines: DiffFile['hunks'][number]['lines'] }) {
  return (
    <>
      <tr className="hunk"><td colSpan={4}>{header}</td></tr>
      {lines.map((l, i) => (
        <tr key={i} className={l.kind === 'ctx' ? '' : l.kind}>
          <td className="ln">{l.oldNo ?? ''}</td>
          <td className="ln">{l.newNo ?? ''}</td>
          <td className="sign" aria-label={l.kind === 'add' ? 'added' : l.kind === 'del' ? 'removed' : 'unchanged'}>{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</td>
          <td>{l.text}{l.noNewline && <span className="muted"> ⏎ (no newline at end of file)</span>}</td>
        </tr>
      ))}
    </>
  );
}

/** An untracked file has no diff; show its whole content as additions. */
export function newFileAsDiff(path: string, content: string): DiffFile {
  const lines = content.split('\n'); if (lines.at(-1) === '') lines.pop();
  return { path, status: 'added', binary: false, additions: lines.length, deletions: 0,
    hunks: [{ header: `@@ new file, ${lines.length} line${lines.length === 1 ? '' : 's'} @@`, lines: lines.map((text, i) => ({ kind: 'add' as const, oldNo: null, newNo: i + 1, text })) }] };
}
