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
  /** Extra environment for this launch only (an account's config directory or credential). Never logged or stored. */
  env?: Record<string, string>;
}

export type NormalizedEvent =
  | { kind: 'init'; model?: string; providerSessionId?: string }
  | { kind: 'assistant'; text: string; tools: string[] }
  | { kind: 'tool_result'; isError: boolean; summary: string }
  | { kind: 'result'; ok: boolean; text: string; costUsd?: number; usage?: { inputTokens?: number; outputTokens?: number } }
  /** The provider said this account is out of capacity (usage limit, rate limit, overloaded). */
  | { kind: 'rate_limit'; text: string; resetsAt?: string }
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

/** What an adapter can really do. The scheduler only offers what is declared here. */
export interface ProviderCapabilities {
  displayName: string;
  /** Model ids (and aliases) this adapter accepts. */
  models: string[];
  /** Can continue the provider's own earlier conversation (never across providers or accounts). */
  supportsNativeResume: boolean;
  /** Can edit files in the working directory. A handoff target must be able to. */
  canEditFiles: boolean;
  /** Environment variable that carries an API credential, if the provider uses one. */
  credentialEnv?: string;
  /** Environment variable that selects a separate login profile, if the provider has one. */
  configDirEnv?: string;
}

export interface ProviderAdapter {
  readonly provider: string;
  readonly capabilities?: ProviderCapabilities;
  launch(spec: LaunchSpec): AdapterProcess;
}
