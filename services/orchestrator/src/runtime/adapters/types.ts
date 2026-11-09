// Provider-neutral contract. The supervisor and scheduler only ever see these types,
// never a CLI's raw event format (roadmap principle 4).

export interface LaunchSpec {
  cwd: string;
  prompt: string;
  model: string;
  /** Session id we choose up front so it can be persisted before the process does any work. */
  cliSessionId: string;
  /** Continue an earlier provider session instead of starting a new one. */
  resumeId?: string;
}

export type NormalizedEvent =
  | { kind: 'init'; model?: string; providerSessionId?: string }
  | { kind: 'assistant'; text: string; tools: string[] }
  | { kind: 'tool_result'; isError: boolean; summary: string }
  | { kind: 'result'; ok: boolean; text: string; costUsd?: number }
  | { kind: 'other'; type: string };

export interface AdapterExit {
  exitCode: number | null;
  signal: string | null;
  /** Set when the process could not be started at all (e.g. executable not found). */
  spawnError?: string;
}

export interface AdapterProcess {
  pid: number | undefined;
  onEvent(cb: (e: NormalizedEvent, rawLine: string) => void): void;
  onStderr(cb: (chunk: string) => void): void;
  /** Resolves once, after the process (and its stdout) has fully ended. */
  done: Promise<AdapterExit>;
  /** Stops the process and its children. Safe to call more than once. */
  kill(): Promise<void>;
}

export interface ProviderAdapter {
  readonly provider: string;
  launch(spec: LaunchSpec): AdapterProcess;
}
