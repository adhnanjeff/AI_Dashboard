// Phase 12: permission profiles. What an agent process may do is decided here, by the backend, from its role.
// The decision is carried into the process as the provider CLI's own allow/deny tool lists, so it is the CLI that
// refuses a disallowed tool. This is not an operating-system sandbox: a process that has `terminal` can do anything
// the OS user can. That is exactly why `terminal`, `network` and `external` need a recorded human approval.

export const CAPABILITIES = ['read', 'edit', 'terminal', 'network', 'secrets', 'external'] as const;
export type Capability = (typeof CAPABILITIES)[number];

export interface Profile {
  id: ProfileId; label: string; description: string;
  grants: Capability[];
  /** Elevated profiles can reach beyond the workspace, so a launch needs an approval that names the profile and the task. */
  elevated: boolean;
  allowedTools: string[]; disallowedTools: string[];
}
export type ProfileId = 'read_only' | 'edit' | 'terminal' | 'network' | 'external';

// Secret-bearing files are denied to every profile. `secrets` is a capability no profile grants.
const SECRET_READS = ['Read(**/.env)', 'Read(**/.env.*)', 'Read(**/*.pem)', 'Read(**/*.key)', 'Read(**/id_rsa*)', 'Read(**/id_ed25519*)', 'Read(**/.npmrc)', 'Read(**/.aws/**)'];
const WRITE = ['Edit', 'Write', 'NotebookEdit'];
const SHELL = ['Bash'];
const WEB = ['WebFetch', 'WebSearch'];

export const PROFILES: Record<ProfileId, Profile> = {
  read_only: { id: 'read_only', label: 'Read only', description: 'Can read and search the workspace. Cannot change files, run commands or use the network.', grants: ['read'], elevated: false,
    allowedTools: ['Read', 'Grep', 'Glob'], disallowedTools: [...WRITE, ...SHELL, ...WEB, ...SECRET_READS] },
  edit: { id: 'edit', label: 'Edit files', description: 'Can read and edit files in its own workspace. No shell, no network.', grants: ['read', 'edit'], elevated: false,
    allowedTools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'], disallowedTools: [...SHELL, ...WEB, ...SECRET_READS] },
  terminal: { id: 'terminal', label: 'Edit and run commands', description: 'Adds a shell. A shell can do anything this user account can do, so it needs approval.', grants: ['read', 'edit', 'terminal'], elevated: true,
    allowedTools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'], disallowedTools: [...WEB, ...SECRET_READS] },
  network: { id: 'network', label: 'Edit and use the web', description: 'Adds web fetch and search. Page content is untrusted input, so it needs approval.', grants: ['read', 'edit', 'network'], elevated: true,
    allowedTools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', ...WEB], disallowedTools: [...SHELL, ...SECRET_READS] },
  external: { id: 'external', label: 'Full access to outside systems', description: 'Shell and web together: can push, publish or call outside services.', grants: ['read', 'edit', 'terminal', 'network', 'external'], elevated: true,
    allowedTools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', ...SHELL, ...WEB], disallowedTools: [...SECRET_READS] },
};
export const isProfileId = (x: unknown): x is ProfileId => typeof x === 'string' && x in PROFILES;

/** Least privilege by default: roles that only look never get write access. Unknown roles get the editor profile, not more. */
export const ROLE_PROFILE: Record<string, ProfileId> = { planner: 'read_only', reviewer: 'read_only', coder: 'edit', docs: 'edit', tester: 'edit' };
export const profileForRole = (role: string | undefined): ProfileId => ROLE_PROFILE[role ?? 'coder'] ?? 'edit';

/** The profile that may be granted for a role without a person's approval. Never more than the role's own default. */
export const needsElevation = (p: ProfileId) => PROFILES[p].elevated;

// ---- what a child process is allowed to inherit
// The orchestrator's own settings (decision token, credential names) and source-control tokens stay with the
// orchestrator. Provider credentials an account explicitly names are passed separately, per launch.
const WITHHELD = /^(ORCH_|GITHUB_TOKEN$|GH_TOKEN$|GITLAB_TOKEN$|NPM_TOKEN$|NODE_AUTH_TOKEN$)/;
export function agentEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!WITHHELD.test(k)) out[k] = v;
  return out;
}
