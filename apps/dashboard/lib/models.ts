// Model ids offered in the UI. The backend only validates the format; the Claude CLI rejects unknown ids.
export const MODELS = [
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5 — routine, cheap' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5 — normal coding' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5 — hard problems' },
];
export const DEFAULT_MODEL = MODELS[0].id;
