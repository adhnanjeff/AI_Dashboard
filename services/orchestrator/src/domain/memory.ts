import { createHash } from 'node:crypto';
import { redactString } from './redact.ts';

// Pure rules for memory: who may write what, what may never be stored, and how entries are compared.

export const PROJECT_CATEGORIES = ['architecture', 'conventions', 'decisions', 'known-issues', 'instructions'] as const;
export const SESSION_CATEGORIES = ['decisions', 'rejected', 'questions', 'notes', 'handoff'] as const;
export const categoriesFor = (scope: 'project' | 'session'): readonly string[] => scope === 'project' ? PROJECT_CATEGORIES : SESSION_CATEGORIES;

/**
 * Which role may write which category. `user` is the human (everything). Agent roles get session notes plus a
 * narrow slice of project memory. Project "instructions" are repository-wide orders for every future agent, so
 * only a human may write them. An unknown role may write nothing.
 */
const RULES: Record<string, { project: readonly string[]; session: readonly string[] }> = {
  user: { project: PROJECT_CATEGORIES, session: SESSION_CATEGORIES },
  architect: { project: ['architecture', 'conventions', 'decisions'], session: SESSION_CATEGORIES },
  coder: { project: ['known-issues'], session: ['decisions', 'rejected', 'questions', 'notes'] },
  tester: { project: ['known-issues'], session: ['notes', 'questions'] },
  reviewer: { project: [], session: ['notes', 'questions'] },
};
export const KNOWN_ROLES = Object.keys(RULES);
export const canWrite = (role: string, scope: 'project' | 'session', category: string): boolean =>
  !!RULES[role] && RULES[role][scope].includes(category);

export const MAX_CONTENT = 2000;
const SOURCE_KINDS = ['user', 'run', 'checkpoint', 'event', 'file', 'commit'] as const;
export const isSourceKind = (k: unknown): k is (typeof SOURCE_KINDS)[number] => (SOURCE_KINDS as readonly unknown[]).includes(k);

// Text that tries to steer a future agent. Rejected when written by an agent (a human may write what they like).
const INJECTION: RegExp[] = [
  /\b(ignore|disregard|forget|override)\b.{0,30}\b(previous|prior|above|earlier|all|any|the|your)\b.{0,30}\b(instructions?|rules?|prompts?|guidelines?)\b/i,
  /\byou are now\b/i, /\bsystem prompt\b/i, /\bnew instructions?\s*:/i, /\bfrom now on,? (you|always|never)\b/i,
  /<\/?\s*(system|assistant|user|memory|instructions?)\b/i,
  /\b(run|execute|curl|wget|download)\b.{0,40}\b(this|the following|http|\| ?sh|\| ?bash)\b/i,
];

/** Returns why the text cannot be stored, or null if it is acceptable. */
export function screenMemory(content: string, trust: 'user' | 'agent'): string | null {
  if (!content.trim()) return 'content is empty';
  if (content.length > MAX_CONTENT) return `content is longer than ${MAX_CONTENT} characters; store a short claim, not a document`;
  if (redactString(content) !== content) return 'content looks like it contains a secret (key, token or password); memory never stores secrets';
  if (trust === 'agent' && INJECTION.some((re) => re.test(content))) return 'content looks like an instruction aimed at future agents; memory stores facts, not commands';
  return null;
}

export const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
export const hashContent = (s: string) => createHash('sha256').update(normalize(s)).digest('hex');

const STOP = new Set(['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was', 'one', 'our', 'out', 'has', 'have', 'with', 'this', 'that', 'from', 'they', 'will', 'would', 'there', 'their', 'what', 'about', 'which', 'when', 'make', 'like', 'into', 'than', 'then', 'them', 'these', 'some', 'could', 'should', 'does', 'use', 'used', 'using']);
export const tokens = (s: string): string[] => normalize(s).split(/[^a-z0-9_.]+/).map((w) => w.replace(/^[._]+|[._]+$/g, '')).filter((w) => w.length >= 3 && !STOP.has(w));
export function jaccard(a: string, b: string): number {
  const A = new Set(tokens(a)), B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let both = 0; for (const t of A) if (B.has(t)) both++;
  return both / (A.size + B.size - both);
}
