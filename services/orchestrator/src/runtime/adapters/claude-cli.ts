import { spawn, execFile } from 'node:child_process';
import type { AdapterExit, AdapterProcess, LaunchSpec, NormalizedEvent, ProviderAdapter, ProviderCapabilities } from './types.ts';

export interface ClaudeCliOptions {
  /** Executable to run. Defaults to the installed `claude`. Tests point this at a fixture. */
  command?: string;
  /** Arguments placed before the Claude flags (tests use this to run `node fake-claude.mjs`). */
  baseArgs?: string[];
  permissionMode?: string;
  allowedTools?: string;
  env?: NodeJS.ProcessEnv;
  /** Provider name recorded on runs. Lets one protocol be registered more than once (e.g. a second login profile or CLI build). */
  providerName?: string;
  capabilities?: ProviderCapabilities;
}

// What the real Claude CLI accepts: full ids plus its short aliases.
export const CLAUDE_CLI_CAPABILITIES: ProviderCapabilities = {
  displayName: 'Claude Code CLI',
  models: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'haiku', 'sonnet', 'opus'],
  supportsNativeResume: true, canEditFiles: true,
  credentialEnv: 'ANTHROPIC_API_KEY', configDirEnv: 'CLAUDE_CONFIG_DIR',
};

const LIMIT_TEXT = /usage limit|rate[ -]?limit|too many requests|\b429\b|overloaded|quota (?:exceeded|exhausted)/i;
export const looksRateLimited = (text: string) => LIMIT_TEXT.test(text);

// Maps one raw stream-json line to a normalized event. Anything unknown becomes `other`,
// so a new CLI event type can never crash the supervisor.
export function normalizeLine(line: string): NormalizedEvent | undefined {
  let e: any;
  try { e = JSON.parse(line); } catch { return undefined; }
  if (!e || typeof e !== 'object') return undefined;
  if (e.type === 'system' && e.subtype === 'init') return { kind: 'init', model: e.model, providerSessionId: e.session_id };
  if (e.type === 'assistant') {
    const parts: any[] = Array.isArray(e.message?.content) ? e.message.content : [];
    return {
      kind: 'assistant',
      text: parts.filter((c) => c.type === 'text').map((c) => c.text).join('\n'),
      tools: parts.filter((c) => c.type === 'tool_use').map((c) => String(c.name)),
    };
  }
  if (e.type === 'user') {
    const parts: any[] = Array.isArray(e.message?.content) ? e.message.content : [];
    const r = parts.find((c) => c.type === 'tool_result');
    if (r) return { kind: 'tool_result', isError: !!r.is_error, summary: String(typeof r.content === 'string' ? r.content : JSON.stringify(r.content)).slice(0, 500) };
  }
  if (e.type === 'rate_limit_event') {
    const info = e.rate_limit_info ?? {};
    // allowed / allowed_warning are normal; anything else means the account cannot take more work now.
    if (typeof info.status === 'string' && !info.status.startsWith('allowed')) {
      const at = Number(info.resetsAt); return { kind: 'rate_limit', text: String(info.status), resetsAt: Number.isFinite(at) && at > 0 ? new Date(at * 1000).toISOString() : undefined };
    }
    return { kind: 'other', type: 'rate_limit_event/ok' };
  }
  if (e.type === 'result') {
    const u = e.usage, n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
    const ok = e.is_error === false && e.subtype === 'success';
    const text = String(e.result ?? '');
    // A failed result that says the account is out of capacity is a rate limit, not a task failure.
    if (!ok && looksRateLimited(text)) return { kind: 'rate_limit', text: text.slice(0, 300) };
    return { kind: 'result', ok, text, costUsd: n(e.total_cost_usd),
      usage: u && typeof u === 'object' ? { inputTokens: n(u.input_tokens), outputTokens: n(u.output_tokens) } : undefined };
  }
  return { kind: 'other', type: `${e.type}${e.subtype ? '/' + e.subtype : ''}` };
}

// Kills the process and every child it started. On Windows `child.kill()` only ends the parent,
// which would leave tool subprocesses running, so use taskkill /T.
function killTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => resolve());
    else { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } resolve(); }
  });
}

export class ClaudeCliAdapter implements ProviderAdapter {
  readonly provider: string;
  /** Opt-in: a bare adapter (a test double, a wrapper) declares nothing and is treated as accepting any model. */
  readonly capabilities?: ProviderCapabilities;
  private opts: ClaudeCliOptions;
  constructor(opts: ClaudeCliOptions = {}) { this.opts = opts; this.provider = opts.providerName ?? 'claude-code-cli'; this.capabilities = opts.capabilities; }

  launch(spec: LaunchSpec): AdapterProcess {
    const o = this.opts;
    // The prompt is passed as a single argv element and never through a shell
    // (a shell splits it on spaces; Phase 0 hit exactly that bug).
    const args = [...(o.baseArgs ?? []), '-p', spec.prompt, '--output-format', 'stream-json', '--verbose',
      '--model', spec.model, '--permission-mode', o.permissionMode ?? 'acceptEdits',
      '--allowedTools', o.allowedTools ?? 'Read,Edit,Write'];
    if (spec.resumeId) args.push('--resume', spec.resumeId); else args.push('--session-id', spec.cliSessionId);

    const child = spawn(o.command ?? 'claude', args, {
      cwd: spec.cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...o.env, ...spec.env },
      detached: process.platform !== 'win32', // own process group on POSIX so killTree can signal -pid
    });

    let eventCb: (e: NormalizedEvent, raw: string) => void = () => {};
    let errCb: (c: string) => void = () => {};
    let buf = '';
    const flush = (line: string) => {
      if (!line.trim()) return;
      const ev = normalizeLine(line);
      if (ev) eventCb(ev, line);
    };
    child.stdout!.on('data', (d: Buffer) => {
      buf += d.toString('utf8'); let i: number;
      while ((i = buf.indexOf('\n')) >= 0) { flush(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    child.stderr!.on('data', (d: Buffer) => {
      const t = d.toString('utf8'); errCb(t);
      if (looksRateLimited(t)) eventCb({ kind: 'rate_limit', text: t.slice(0, 300) }, t);
    });

    let spawnError: string | undefined;
    child.on('error', (err) => { spawnError = err.message; });
    const done = new Promise<AdapterExit>((resolve) => {
      // 'close' fires after stdio streams end, so every line has been delivered before we resolve.
      child.on('close', (exitCode, signal) => { flush(buf); buf = ''; resolve({ exitCode, signal, spawnError }); });
    });

    return {
      pid: child.pid,
      onEvent: (cb) => { eventCb = cb; },
      onStderr: (cb) => { errCb = cb; },
      done,
      kill: async () => { if (child.pid && child.exitCode === null && child.signalCode === null) await killTree(child.pid); },
    };
  }
}
