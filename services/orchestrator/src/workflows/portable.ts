import { DefinitionError, ROLES, SEVERITIES, STEP_KINDS, validateWorkflow, type WorkflowDef } from './definition.ts';

/**
 * Phase 13: workflow definitions as files you can export, review in git, and import again.
 *
 * The file is a small envelope around the same definition the engine already validates, so an imported workflow can
 * never be something the engine would not accept. Import is stricter than the engine: unknown keys are reported
 * (a typo like "maxAtempts" would otherwise be silently ignored and the default used).
 */
export const WORKFLOW_FORMAT = 'ai-control-center/workflow';
export const WORKFLOW_FORMAT_VERSION = 1;

const STEP_KEYS = ['id', 'kind', 'title', 'role', 'needs', 'prompt', 'acceptance', 'model', 'command', 'timeoutMs', 'verifies', 'reviews', 'fixer', 'blockAt', 'when', 'maxAttempts', 'budgetUsd'];
const ENVELOPE_KEYS = ['format', 'version', 'title', 'goal', 'exportedAt', 'definition'];
const DEFINITION_KEYS = ['concurrency', 'steps'];

export interface WorkflowFile { format: typeof WORKFLOW_FORMAT; version: number; title?: string; goal?: string; exportedAt: string; definition: WorkflowDef }

export function exportWorkflow(def: WorkflowDef, meta: { title?: string; goal?: string } = {}, now = new Date()): WorkflowFile {
  return { format: WORKFLOW_FORMAT, version: WORKFLOW_FORMAT_VERSION, ...(meta.title ? { title: meta.title } : {}), ...(meta.goal ? { goal: meta.goal } : {}), exportedAt: now.toISOString(), definition: def };
}

/** Accepts either the envelope or a bare definition. Throws DefinitionError listing every problem. */
export function parseWorkflowImport(input: unknown): { title?: string; goal?: string; definition: WorkflowDef; warnings: string[] } {
  const bad: string[] = []; const warnings: string[] = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DefinitionError(['a workflow file must be a JSON object']);
  const o = input as any; const wrapped = 'format' in o || 'definition' in o;
  let rawDef: any = o;
  if (wrapped) {
    if (o.format !== WORKFLOW_FORMAT) bad.push(`format must be "${WORKFLOW_FORMAT}"`);
    if (o.version !== WORKFLOW_FORMAT_VERSION) bad.push(o.version === undefined ? 'version is required' : `unsupported version ${JSON.stringify(o.version)} (this tool reads version ${WORKFLOW_FORMAT_VERSION})`);
    for (const k of Object.keys(o)) if (!ENVELOPE_KEYS.includes(k)) bad.push(`unknown key "${k}" in the file`);
    rawDef = o.definition;
    if (!rawDef || typeof rawDef !== 'object') { bad.push('definition is required'); throw new DefinitionError(bad); }
  }
  for (const k of Object.keys(rawDef)) if (!DEFINITION_KEYS.includes(k)) bad.push(`unknown key "${k}" in the definition`);
  if (Array.isArray(rawDef.steps)) rawDef.steps.forEach((s: any, i: number) => {
    if (!s || typeof s !== 'object') return;
    for (const k of Object.keys(s)) if (!STEP_KEYS.includes(k)) bad.push(`step ${s.id ? `"${s.id}"` : `#${i + 1}`}: unknown key "${k}"`);
  });
  let definition: WorkflowDef | undefined;
  try { definition = validateWorkflow(rawDef); } catch (e) { if (e instanceof DefinitionError) bad.push(...e.problems); else throw e; }
  if (bad.length) throw new DefinitionError(bad);
  if (wrapped && typeof o.title !== 'string') warnings.push('the file has no title');
  return { title: typeof o.title === 'string' ? o.title.slice(0, 200) : undefined, goal: typeof o.goal === 'string' ? o.goal.slice(0, 4000) : undefined, definition: definition!, warnings };
}

/** A JSON Schema (draft 2020-12) for the file format, so editors and CI can check workflow files without this tool. */
export function workflowJsonSchema() {
  const step = {
    type: 'object', additionalProperties: false, required: ['id', 'kind'],
    properties: {
      id: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,39}$' }, kind: { enum: [...STEP_KINDS] }, title: { type: 'string', maxLength: 120 },
      role: { enum: Object.keys(ROLES) }, needs: { type: 'array', items: { type: 'string' }, uniqueItems: true },
      prompt: { type: 'string', maxLength: 8000 }, acceptance: { type: 'array', items: { type: 'string' }, maxItems: 20 },
      model: { type: 'string', pattern: '^[A-Za-z0-9._:\\-/]{1,80}$' },
      command: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 500 }, minItems: 1, maxItems: 20 },
      timeoutMs: { type: 'integer', minimum: 1000, maximum: 3_600_000 }, verifies: { type: 'string' }, reviews: { type: 'string' }, fixer: { type: 'string' },
      blockAt: { enum: [...SEVERITIES] },
      when: { type: 'object', additionalProperties: false, required: ['step', 'status'], properties: { step: { type: 'string' }, status: { enum: ['passed', 'failed'] } } },
      maxAttempts: { type: 'integer', minimum: 1, maximum: 5 }, budgetUsd: { type: 'number', minimum: 0.01, maximum: 100000 },
    },
  };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'urn:ai-control-center:workflow:1', title: 'AI Engineering Control Center workflow', type: 'object',
    additionalProperties: false, required: ['format', 'version', 'definition'],
    properties: {
      format: { const: WORKFLOW_FORMAT }, version: { const: WORKFLOW_FORMAT_VERSION }, title: { type: 'string' }, goal: { type: 'string' }, exportedAt: { type: 'string' },
      definition: { type: 'object', additionalProperties: false, required: ['steps'], properties: { concurrency: { type: 'integer', minimum: 1, maximum: 4 }, steps: { type: 'array', minItems: 1, maxItems: 40, items: step } } },
    },
    description: 'The JSON Schema covers shape and ranges. Relations between steps (unknown ids, cycles, fixers upstream) are checked by the tool on import.',
  };
}
