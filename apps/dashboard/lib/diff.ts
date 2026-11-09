export interface DiffLine { kind: 'add' | 'del' | 'ctx'; oldNo: number | null; newNo: number | null; text: string; noNewline?: boolean }
export interface DiffHunk { header: string; lines: DiffLine[] }
export interface DiffFile {
  path: string; oldPath?: string; status: 'modified' | 'added' | 'deleted' | 'renamed'; binary: boolean;
  additions: number; deletions: number; hunks: DiffHunk[];
}
export interface ParsedDiff { files: DiffFile[]; truncated: boolean }

// "diff --git a/x b/x" is ambiguous when names contain spaces; this is only a fallback for headers
// that carry no ---/+++ lines (mode-only changes, binary files).
function pathsFromHeader(line: string): { a: string; b: string } {
  const rest = line.slice('diff --git '.length);
  const mid = rest.lastIndexOf(' b/');
  if (rest.startsWith('a/') && mid > 0) return { a: rest.slice(2, mid), b: rest.slice(mid + 3) };
  return { a: rest, b: rest };
}
const stripPrefix = (p: string) => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);

/** Parses the output of `git diff` into files, hunks and numbered lines. Never throws on unexpected input. */
export function parseUnifiedDiff(text: string): ParsedDiff {
  const out: ParsedDiff = { files: [], truncated: false };
  if (!text) return out;
  let file: DiffFile | null = null; let hunk: DiffHunk | null = null; let oldNo = 0, newNo = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const h = pathsFromHeader(line);
      file = { path: h.b, status: 'modified', binary: false, additions: 0, deletions: 0, hunks: [] };
      if (h.a !== h.b) file.oldPath = h.a;
      out.files.push(file); hunk = null; continue;
    }
    if (line === '[diff truncated]') { out.truncated = true; continue; }
    if (!file) continue;
    if (!hunk) {
      if (line.startsWith('new file mode')) file.status = 'added';
      else if (line.startsWith('deleted file mode')) file.status = 'deleted';
      else if (line.startsWith('rename from ')) { file.status = 'renamed'; file.oldPath = line.slice(12); }
      else if (line.startsWith('rename to ')) file.path = line.slice(10);
      else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) file.binary = true;
      else if (line.startsWith('--- ')) { const p = line.slice(4); if (p !== '/dev/null') { file.oldPath = stripPrefix(p); if (file.status !== 'renamed') file.path = stripPrefix(p); } }
      else if (line.startsWith('+++ ')) { const p = line.slice(4); if (p !== '/dev/null') file.path = stripPrefix(p); }
    }
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (m) { hunk = { header: line, lines: [] }; file.hunks.push(hunk); oldNo = Number(m[1]); newNo = Number(m[2]); continue; }
    if (!hunk) continue;
    if (line.startsWith('\\')) { const prev = hunk.lines.at(-1); if (prev) prev.noNewline = true; continue; }
    const c = line[0];
    if (c === '+') { hunk.lines.push({ kind: 'add', oldNo: null, newNo: newNo++, text: line.slice(1) }); file.additions++; }
    else if (c === '-') { hunk.lines.push({ kind: 'del', oldNo: oldNo++, newNo: null, text: line.slice(1) }); file.deletions++; }
    else if (c === ' ') hunk.lines.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text: line.slice(1) });
    // anything else (e.g. the empty string after the final newline) is not part of a hunk
  }
  return out;
}
