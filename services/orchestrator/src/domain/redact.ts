// Redaction runs before anything is persisted (events, artifacts, checkpoints).
// Pattern-based, so it is a safety net, not a guarantee: secrets should also never be passed in prompts.
const RULES: [RegExp, string][] = [
  [/sk-ant-[A-Za-z0-9_-]{10,}/g, '[REDACTED:anthropic-key]'],
  [/\bsk-[A-Za-z0-9]{20,}/g, '[REDACTED:api-key]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[REDACTED:github-token]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED:aws-key]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 'Bearer [REDACTED]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED:private-key]'],
  [/((?:password|passwd|secret|token|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',}]{4,}/gi, '$1[REDACTED]'],
];

export const redactString = (s: string) => RULES.reduce((acc, [re, to]) => acc.replace(re, to), s);

export function redact<T>(value: T): T {
  if (typeof value === 'string') return redactString(value) as T;
  if (Array.isArray(value)) return value.map(redact) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)])) as T;
  return value;
}
