// Source-level extraction for the repository index (Phase 10). No parser dependency: line-oriented patterns over
// comment-stripped text. This is deliberately precise rather than clever: it records what is written in the source
// (declarations, import statements, call sites by name) and says so. It does not resolve types or dynamic dispatch.
// Every fact carries the line it came from so the UI can show the source.

export const EXTRACTOR = 'regex-v1';

export type Lang = 'ts' | 'py' | 'manifest' | 'other';
export interface Sym { name: string; kind: 'function' | 'class' | 'method' | 'interface' | 'type' | 'enum' | 'variable' | 'test-case'; line: number; endLine: number; indent: number; exported: boolean; owner?: string }
export interface ImportBinding { imported: string; local: string } // imported: 'default' | '*' | a name
export interface ImportRef { spec: string; line: number; bindings: ImportBinding[]; text: string }
export interface CallRef { from: string | null; name: string; line: number; via?: string; text: string } // from: symbol key, or null = module level
export interface Parsed { lang: Lang; isTest: boolean; symbols: Sym[]; imports: ImportRef[]; calls: CallRef[]; lines: number }

const TS_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i;
export const langOf = (path: string): Lang => (TS_EXT.test(path) ? 'ts' : /\.py$/i.test(path) ? 'py' : /(^|\/)package\.json$/.test(path) ? 'manifest' : 'other');
export const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py|json|md|yml|yaml|toml|css|html|sh|sql)$/i;
export const isTestPath = (p: string) => /(^|\/)(tests?|__tests__|spec)\//i.test(p) || /\.(test|spec)\.[a-z]+$/i.test(p) || /(^|\/)test_[^/]*\.py$/i.test(p) || /_test\.py$/i.test(p);

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'typeof', 'await', 'async', 'new', 'super', 'import', 'require', 'else', 'do', 'try', 'throw', 'delete', 'void', 'in', 'of', 'with', 'yield', 'def', 'class', 'print', 'not', 'and', 'or', 'lambda', 'assert', 'isinstance', 'len', 'range', 'str', 'int', 'list', 'dict', 'set', 'tuple']);
const BUILTIN_CALLS = new Set(['String', 'Number', 'Boolean', 'Array', 'Object', 'Map', 'Set', 'Promise', 'Error', 'Date', 'JSON', 'Math', 'RegExp', 'Symbol', 'parseInt', 'parseFloat', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'require', 'console']);

/** Replaces comments with spaces, keeping every newline, so line numbers still match the file. */
export function stripComments(text: string, lang: Lang): string {
  if (lang === 'py') return text.split('\n').map((l) => l.replace(/(^|[^'"\\])#.*$/, '$1')).join('\n');
  let out = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  out = out.split('\n').map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n');
  return out;
}

const IDENT = '[A-Za-z_$][\\w$]*';

function parseClause(clause: string): ImportBinding[] {
  const out: ImportBinding[] = []; const c = clause.replace(/\btype\s+/g, '').trim();
  if (!c) return out;
  const ns = c.match(new RegExp(`\\*\\s+as\\s+(${IDENT})`)); if (ns) out.push({ imported: '*', local: ns[1] });
  const named = c.match(/\{([\s\S]*)\}/);
  if (named) for (const part of named[1].split(',')) { const m = part.trim().match(new RegExp(`^(${IDENT})(?:\\s+as\\s+(${IDENT}))?$`)); if (m) out.push({ imported: m[1], local: m[2] ?? m[1] }); }
  const def = c.replace(/\{[\s\S]*\}/, '').replace(/\*\s+as\s+\S+/, '').split(',')[0].trim();
  if (new RegExp(`^${IDENT}$`).test(def)) out.push({ imported: 'default', local: def });
  return out;
}

export function extractTs(path: string, text: string): Parsed {
  const clean = stripComments(text, 'ts'); const lines = clean.split('\n'); const raw = text.split('\n');
  const lineAt = (idx: number) => clean.slice(0, idx).split('\n').length;
  const imports: ImportRef[] = [];
  for (const m of clean.matchAll(/(?:^|\n)[ \t]*import\s+(?:type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]/g)) { const line = lineAt(m.index! + (m[0].startsWith('\n') ? 1 : 0)); imports.push({ spec: m[2], line, bindings: parseClause(m[1]), text: raw[line - 1]?.trim() ?? '' }); }
  for (const m of clean.matchAll(/(?:^|\n)[ \t]*import\s*['"]([^'"]+)['"]/g)) { const line = lineAt(m.index! + (m[0].startsWith('\n') ? 1 : 0)); imports.push({ spec: m[1], line, bindings: [], text: raw[line - 1]?.trim() ?? '' }); }
  for (const m of clean.matchAll(/(?:^|\n)[ \t]*export\s+(?:type\s+)?(\*|\{[^}]*\})(?:\s+as\s+\w+)?\s*from\s*['"]([^'"]+)['"]/g)) { const line = lineAt(m.index! + (m[0].startsWith('\n') ? 1 : 0)); imports.push({ spec: m[2], line, bindings: m[1] === '*' ? [] : parseClause(m[1]), text: raw[line - 1]?.trim() ?? '' }); }
  for (const m of clean.matchAll(new RegExp(`(?:const|let|var)\\s+(\\{[^}]*\\}|${IDENT})\\s*=\\s*(?:await\\s+)?require\\(\\s*['"]([^'"]+)['"]\\s*\\)`, 'g'))) {
    const line = lineAt(m.index!); const clause = m[1].startsWith('{') ? m[1].replace(/:/g, ' as ') : m[1];
    imports.push({ spec: m[2], line, bindings: parseClause(clause), text: raw[line - 1]?.trim() ?? '' });
  }
  for (const m of clean.matchAll(/(?<![\w$.])(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)/g)) { const line = lineAt(m.index!); if (!imports.some((i) => i.spec === m[1] && i.line === line)) imports.push({ spec: m[1], line, bindings: [], text: raw[line - 1]?.trim() ?? '' }); }

  const symbols: Sym[] = []; let cls: { name: string; indent: number } | null = null;
  const push = (s: Omit<Sym, 'endLine'>) => symbols.push({ ...s, endLine: lines.length });
  lines.forEach((ln, i) => {
    const line = i + 1; const indent = ln.match(/^\s*/)![0].length; if (!ln.trim()) return;
    if (cls && indent <= cls.indent && /^\s*\}/.test(ln)) cls = null;
    let m: RegExpMatchArray | null;
    if (indent === 0) {
      if ((m = ln.match(new RegExp(`^(export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\*?\\s*(${IDENT})\\s*[(<]`)))) push({ name: m[2], kind: 'function', line, indent, exported: !!m[1] });
      else if ((m = ln.match(new RegExp(`^(export\\s+)?(?:default\\s+)?(?:abstract\\s+)?class\\s+(${IDENT})`)))) { push({ name: m[2], kind: 'class', line, indent, exported: !!m[1] }); cls = { name: m[2], indent }; }
      else if ((m = ln.match(new RegExp(`^(export\\s+)?(?:declare\\s+)?interface\\s+(${IDENT})`)))) push({ name: m[2], kind: 'interface', line, indent, exported: !!m[1] });
      else if ((m = ln.match(new RegExp(`^(export\\s+)?(?:declare\\s+)?type\\s+(${IDENT})\\s*(?:<[^=]*>)?\\s*=`)))) push({ name: m[2], kind: 'type', line, indent, exported: !!m[1] });
      else if ((m = ln.match(new RegExp(`^(export\\s+)?(?:declare\\s+)?(?:const\\s+)?enum\\s+(${IDENT})`)))) push({ name: m[2], kind: 'enum', line, indent, exported: !!m[1] });
      else if ((m = ln.match(new RegExp(`^(export\\s+)?(?:const|let|var)\\s+(${IDENT})\\s*(?::[^=]+)?=\\s*(async\\s*)?(\\(|function\\b|${IDENT}\\s*=>)?`)))) push({ name: m[2], kind: m[4] ? 'function' : 'variable', line, indent, exported: !!m[1] });
    } else if (cls && indent > cls.indent) {
      m = ln.match(new RegExp(`^\\s+(?:(?:public|private|protected|static|async|readonly|override|abstract)\\s+)*(?:get\\s+|set\\s+)?(${IDENT})\\s*(?:<[^>]*>)?\\(`));
      if (m && !KEYWORDS.has(m[1]) && /[{]\s*$|\)\s*(:[^{]+)?\{|;\s*$/.test(ln) && indent <= cls.indent + 4) push({ name: m[1], kind: 'method', line, indent, exported: false, owner: cls.name });
    }
    if ((m = ln.match(/^\s*(?:test|it|describe)(?:\.\w+)*\(\s*(['"`])(.+?)\1/))) push({ name: m[2].slice(0, 120), kind: 'test-case', line, indent, exported: false });
  });
  finishRanges(symbols, lines.length);
  return { lang: 'ts', isTest: isTestPath(path), symbols, imports, calls: scanCalls(clause(lines, raw), symbols, imports), lines: lines.length };
}
const clause = (lines: string[], raw: string[]) => ({ lines, raw });

export function extractPy(path: string, text: string): Parsed {
  const clean = stripComments(text, 'py'); const lines = clean.split('\n'); const raw = text.split('\n');
  const imports: ImportRef[] = [];
  for (let i = 0; i < lines.length; i++) {
    let m = lines[i].match(/^\s*import\s+([\w., ]+)$/);
    if (m) { for (const part of m[1].split(',')) { const mm = part.trim().match(/^([\w.]+)(?:\s+as\s+(\w+))?$/); if (mm) imports.push({ spec: mm[1], line: i + 1, bindings: [{ imported: '*', local: mm[2] ?? mm[1].split('.').pop()! }], text: raw[i].trim() }); } continue; }
    m = lines[i].match(/^\s*from\s+([.\w]+)\s+import\s+(.*)$/);
    if (m) {
      let rest = m[2]; let j = i;
      if (rest.includes('(') && !rest.includes(')')) { while (++j < lines.length && !lines[j].includes(')')) rest += ' ' + lines[j]; if (j < lines.length) rest += ' ' + lines[j]; }
      const bindings = rest.replace(/[()\\]/g, ' ').split(',').map((p) => p.trim().match(/^(\w+|\*)(?:\s+as\s+(\w+))?$/)).filter(Boolean).map((x) => ({ imported: x![1], local: x![2] ?? x![1] }));
      imports.push({ spec: m[1], line: i + 1, bindings, text: raw[i].trim() });
    }
  }
  const symbols: Sym[] = []; let cls: { name: string; indent: number } | null = null;
  lines.forEach((ln, i) => {
    if (!ln.trim()) return; const indent = ln.match(/^\s*/)![0].length; const line = i + 1;
    if (cls && indent <= cls.indent) cls = null;
    let m = ln.match(/^(\s*)class\s+(\w+)/);
    if (m && indent === 0) { symbols.push({ name: m[2], kind: 'class', line, endLine: lines.length, indent, exported: !m[2].startsWith('_') }); cls = { name: m[2], indent }; return; }
    m = ln.match(/^(\s*)(?:async\s+)?def\s+(\w+)/);
    if (m) {
      const isTest = /^test_/.test(m[2]);
      if (indent === 0) symbols.push({ name: m[2], kind: isTest ? 'test-case' : 'function', line, endLine: lines.length, indent, exported: !m[2].startsWith('_') });
      else if (cls && indent <= cls.indent + 4) symbols.push({ name: m[2], kind: isTest ? 'test-case' : 'method', line, endLine: lines.length, indent, exported: false, owner: cls.name });
    }
  });
  finishRanges(symbols, lines.length);
  return { lang: 'py', isTest: isTestPath(path), symbols, imports, calls: scanCalls(clause(lines, raw), symbols, imports), lines: lines.length };
}

function finishRanges(symbols: Sym[], total: number) {
  symbols.forEach((s, i) => {
    const next = symbols.slice(i + 1).find((x) => x.indent <= s.indent);
    s.endLine = next ? Math.max(s.line, next.line - 1) : total;
  });
  // a nested symbol never extends past its parent
}

function scanCalls(src: { lines: string[]; raw: string[] }, symbols: Sym[], imports: ImportRef[]): CallRef[] {
  const calls: CallRef[] = []; const seen = new Set<string>();
  const nsLocals = imports.flatMap((i) => i.bindings.filter((b) => b.imported === '*').map((b) => b.local));
  const keyOf = (s: Sym) => symKey(s);
  src.lines.forEach((ln, i) => {
    const line = i + 1; if (!ln.trim() || calls.length > 3000) return;
    // the innermost symbol that contains this line, but not the declaration line itself for its own name
    const owner = [...symbols].reverse().find((s) => s.line <= line && line <= s.endLine && s.kind !== 'interface' && s.kind !== 'type' && s.kind !== 'enum');
    const from = owner ? keyOf(owner) : null;
    const add = (name: string, via?: string) => {
      if (KEYWORDS.has(name) || BUILTIN_CALLS.has(name)) return;
      if (owner && owner.line === line && owner.name === name) return;
      const k = `${from}|${via ?? ''}|${name}`; if (seen.has(k)) return; seen.add(k);
      calls.push({ from, name, line, via, text: src.raw[i]?.trim().slice(0, 200) ?? '' });
    };
    for (const m of ln.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) add(m[1]);
    for (const m of ln.matchAll(/\bnew\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
    for (const m of ln.matchAll(/\bthis\.([A-Za-z_$][\w$]*)\s*\(/g)) add(m[1], 'this');
    for (const m of ln.matchAll(/\bself\.([A-Za-z_]\w*)\s*\(/g)) add(m[1], 'this');
    for (const ns of nsLocals) for (const m of ln.matchAll(new RegExp(`(?<![\\w$.])${ns.replace(/\$/g, '\\$')}\\.([A-Za-z_$][\\w$]*)\\s*\\(`, 'g'))) add(m[1], ns);
  });
  return calls;
}

/** Stable key of a symbol inside a file: "Class.method" or "name", disambiguated by line when it repeats. */
export const symKey = (s: Pick<Sym, 'name' | 'owner' | 'line'>) => `${s.owner ? `${s.owner}.` : ''}${s.name}@${s.line}`;
export const symLabel = (s: Pick<Sym, 'name' | 'owner'>) => `${s.owner ? `${s.owner}.` : ''}${s.name}`;

export function parseFile(path: string, text: string): Parsed {
  const lang = langOf(path);
  if (lang === 'ts') return extractTs(path, text);
  if (lang === 'py') return extractPy(path, text);
  return { lang, isTest: isTestPath(path), symbols: [], imports: [], calls: [], lines: text.split('\n').length };
}
