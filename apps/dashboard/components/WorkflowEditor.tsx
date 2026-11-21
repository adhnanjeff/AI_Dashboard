'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { api } from '../lib/api.ts';
import { usePolling } from '../lib/hooks.ts';
import type { Project, WorkflowCheck } from '../lib/types.ts';
import { ErrorBanner } from './small.tsx';

type Kind = 'agent' | 'check' | 'review' | 'integrate' | 'approval' | 'merge_ready';
interface StepForm {
  id: string; kind: Kind; title: string; role: string; prompt: string; acceptance: string; needs: string[]; command: string; timeoutMs: string;
  verifies: string; reviews: string; fixer: string; blockAt: string; whenStep: string; whenStatus: 'passed' | 'failed'; maxAttempts: string; budgetUsd: string; model: string;
}
const KINDS: { id: Kind; label: string; hint: string }[] = [
  { id: 'agent', label: 'Agent', hint: 'An agent works in its own copy of the repository.' },
  { id: 'integrate', label: 'Integrate', hint: 'Combines the work of agent steps and checks it merges cleanly.' },
  { id: 'check', label: 'Check', hint: 'Runs a command, such as the tests, against a step. No model is involved.' },
  { id: 'review', label: 'Review', hint: 'A read-only reviewer reports findings. Findings at or above the block level send the work back.' },
  { id: 'approval', label: 'Approval gate', hint: 'Stops until a person approves.' },
  { id: 'merge_ready', label: 'Merge gate', hint: 'The final stop: a person approves before anything can be merged.' },
];
const blank = (id: string, kind: Kind): StepForm => ({ id, kind, title: '', role: kind === 'review' ? 'reviewer' : 'coder', prompt: '', acceptance: '', needs: [], command: '', timeoutMs: '', verifies: '', reviews: '', fixer: '', blockAt: 'high', whenStep: '', whenStatus: 'passed', maxAttempts: '', budgetUsd: '', model: '' });

/** One argument per word. There is no shell, so quoting is not supported, and the server only allows known programs. */
const argv = (line: string) => line.trim().split(/\s+/).filter(Boolean);

export function toDefinition(concurrency: string, steps: StepForm[]) {
  return {
    ...(concurrency.trim() ? { concurrency: Number(concurrency) } : {}),
    steps: steps.map((s) => {
      const o: Record<string, unknown> = { id: s.id, kind: s.kind };
      if (s.title.trim()) o.title = s.title.trim();
      if (s.needs.length) o.needs = s.needs;
      if (s.kind === 'agent' || s.kind === 'review') { o.role = s.role; if (s.prompt.trim()) o.prompt = s.prompt; if (s.model.trim()) o.model = s.model.trim(); if (s.budgetUsd.trim()) o.budgetUsd = Number(s.budgetUsd); }
      if (s.kind === 'agent') { const acc = s.acceptance.split('\n').map((l) => l.trim()).filter(Boolean); if (acc.length) o.acceptance = acc; }
      if (s.kind === 'check') { o.command = argv(s.command); if (s.verifies) o.verifies = s.verifies; if (s.timeoutMs.trim()) o.timeoutMs = Number(s.timeoutMs); }
      if (s.kind === 'review') { if (s.reviews) o.reviews = s.reviews; o.blockAt = s.blockAt; }
      if ((s.kind === 'check' || s.kind === 'review') && s.fixer) o.fixer = s.fixer;
      if (s.kind === 'approval' && s.prompt.trim()) o.prompt = s.prompt;
      if (s.maxAttempts.trim() && ['agent', 'check', 'review'].includes(s.kind)) o.maxAttempts = Number(s.maxAttempts);
      if (s.whenStep) o.when = { step: s.whenStep, status: s.whenStatus };
      return o;
    }),
  };
}
export function fromDefinition(def: any): { concurrency: string; steps: StepForm[] } {
  return {
    concurrency: def?.concurrency ? String(def.concurrency) : '',
    steps: (def?.steps ?? []).map((s: any) => ({ ...blank(s.id, s.kind), title: s.title ?? '', role: s.role ?? (s.kind === 'review' ? 'reviewer' : 'coder'), prompt: s.prompt ?? '', acceptance: (s.acceptance ?? []).join('\n'),
      needs: s.needs ?? [], command: (s.command ?? []).join(' '), timeoutMs: s.timeoutMs ? String(s.timeoutMs) : '', verifies: s.verifies ?? '', reviews: s.reviews ?? '', fixer: s.fixer ?? '',
      blockAt: s.blockAt ?? 'high', whenStep: s.when?.step ?? '', whenStatus: s.when?.status ?? 'passed', maxAttempts: s.maxAttempts ? String(s.maxAttempts) : '', budgetUsd: s.budgetUsd ? String(s.budgetUsd) : '', model: s.model ?? '' })),
  };
}

const TEMPLATE = fromDefinition({ concurrency: 2, steps: [
  { id: 'build', kind: 'agent', role: 'coder', prompt: 'Describe the change to make.', maxAttempts: 3 },
  { id: 'integrate', kind: 'integrate', needs: ['build'] },
  { id: 'tests', kind: 'check', command: ['npm', 'test'], verifies: 'integrate', fixer: 'build', maxAttempts: 3 },
  { id: 'review', kind: 'review', role: 'reviewer', reviews: 'integrate', fixer: 'build', needs: ['tests'], blockAt: 'high', maxAttempts: 2 },
  { id: 'merge-ready', kind: 'merge_ready', needs: ['integrate', 'review', 'tests'] },
] });

function Field({ label, hint, children, wide }: { label: string; hint?: string; children: ReactNode; wide?: boolean }) {
  return <label className={`field${wide ? ' wide' : ''}`}><span>{label}</span>{children}{hint ? <span className="hint">{hint}</span> : null}</label>;
}

export default function WorkflowEditor() {
  const router = useRouter(); const params = useSearchParams(); const from = params.get('from');
  const projects = usePolling(() => api<Project[]>('/projects'), 60000, 'ed-projects');
  const roles = usePolling(() => api<Record<string, { writes: boolean; brief: string }>>('/workflows/roles'), 600000, 'ed-roles').data ?? { coder: { writes: true, brief: '' }, reviewer: { writes: false, brief: '' } };
  const [projectId, setProjectId] = useState(''); const [title, setTitle] = useState(''); const [goal, setGoal] = useState('');
  const [concurrency, setConcurrency] = useState('2'); const [steps, setSteps] = useState<StepForm[]>(TEMPLATE.steps);
  const [check, setCheck] = useState<WorkflowCheck | null>(null); const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<Error | null>(null); const [notice, setNotice] = useState('');
  const [paste, setPaste] = useState(''); const [pasteOpen, setPasteOpen] = useState(false);
  const seq = useRef(0); const pid = projectId || projects.data?.[0]?.id || '';
  const ids = steps.map((s) => s.id);

  // Start from an existing workflow's definition: /workflows/editor?from=<id>
  useEffect(() => {
    if (!from) return;
    api<{ workflow: { title: string; goal: string; definition: any } }>(`/workflows/${encodeURIComponent(from)}`).then((g) => {
      const f = fromDefinition(g.workflow.definition); setSteps(f.steps); setConcurrency(f.concurrency); setTitle(`${g.workflow.title} (copy)`); setGoal(g.workflow.goal);
      setNotice('Loaded the definition of an existing workflow. Saving creates a new workflow; the original is not changed.');
    }).catch((e) => setError(e));
  }, [from]);

  // Validate on every change, after a short pause. The server is the only place that knows the rules.
  useEffect(() => {
    const mine = ++seq.current; setChecking(true);
    const t = setTimeout(() => {
      api<WorkflowCheck>('/workflows/validate', { method: 'POST', body: { definition: toDefinition(concurrency, steps), title, goal } })
        .then((r) => { if (mine === seq.current) { setCheck(r); setChecking(false); } })
        .catch((e) => { if (mine === seq.current) { setCheck({ ok: false, problems: [`Could not check: ${e.message}`] }); setChecking(false); } });
    }, 350);
    return () => clearTimeout(t);
  }, [concurrency, steps, title, goal]);

  const patch = (i: number, p: Partial<StepForm>) => setSteps((all) => all.map((s, k) => (k === i ? { ...s, ...p } : s)));
  const rename = (i: number, id: string) => setSteps((all) => { const old = all[i].id; return all.map((s, k) => {
    const fix = (v: string) => (v === old ? id : v);
    return k === i ? { ...s, id } : { ...s, needs: s.needs.map(fix), verifies: fix(s.verifies), reviews: fix(s.reviews), fixer: fix(s.fixer), whenStep: fix(s.whenStep) }; }); });
  const move = (i: number, d: -1 | 1) => setSteps((all) => { const j = i + d; if (j < 0 || j >= all.length) return all; const c = [...all]; [c[i], c[j]] = [c[j], c[i]]; return c; });
  const remove = (i: number) => setSteps((all) => { const gone = all[i].id; return all.filter((_, k) => k !== i).map((s) => ({ ...s, needs: s.needs.filter((n) => n !== gone), verifies: s.verifies === gone ? '' : s.verifies, reviews: s.reviews === gone ? '' : s.reviews, fixer: s.fixer === gone ? '' : s.fixer, whenStep: s.whenStep === gone ? '' : s.whenStep })); });
  const add = (kind: Kind) => setSteps((all) => { let n = 1; const base = kind.replace('_', '-'); while (all.some((s) => s.id === `${base}-${n}`)) n++; return [...all, blank(`${base}-${n}`, kind)]; });

  async function create() {
    setBusy(true); setError(null);
    try { const w = await api<{ id: string }>('/workflows', { method: 'POST', body: { projectId: pid, title: title.trim(), goal: goal.trim(), definition: toDefinition(concurrency, steps) } }); router.push(`/workflows/${w.id}`); }
    catch (e) { setError(e as Error); setBusy(false); }
  }
  function download() {
    if (!check?.file) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(check.file, null, 2) + '\n'], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `${(title.trim() || 'workflow').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workflow'}.workflow.json`; a.click(); URL.revokeObjectURL(url);
  }
  async function importText(text: string) {
    setError(null); setNotice('');
    let file: any; try { file = JSON.parse(text); } catch { setCheck({ ok: false, problems: ['That is not valid JSON.'] }); return; }
    try {
      const r = await api<WorkflowCheck>('/workflows/validate', { method: 'POST', body: { file } });
      if (!r.ok) { setCheck(r); setNotice('The file was not loaded. Fix the problems below and import again, or edit the file.'); return; }
      const f = fromDefinition(r.definition); setSteps(f.steps); setConcurrency(f.concurrency);
      if (typeof file.title === 'string') setTitle(file.title); if (typeof file.goal === 'string') setGoal(file.goal);
      setNotice(`Loaded ${f.steps.length} steps from the file.`); setPasteOpen(false); setPaste('');
    } catch (e) { setError(e as Error); }
  }
  async function onFile(e: ChangeEvent<HTMLInputElement>) { const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; if (f.size > 1_000_000) { setCheck({ ok: false, problems: ['That file is larger than 1 MB.'] }); return; } await importText(await f.text()); }

  const canCreate = !!check?.ok && !!pid && !!title.trim() && !!goal.trim() && !busy && !checking;
  const stepIds = (kinds: Kind[]) => steps.filter((s) => kinds.includes(s.kind)).map((s) => s.id);

  return (
    <>
      <div className="page-head">
        <p className="basis"><Link href="/workflows">Workflows</Link> / Editor</p>
        <h1>Workflow editor</h1>
        <p className="sub">Define the steps, what each one needs, who does it, and where a person has to approve. The server checks every change, and you can save the result as a file to review or reuse.</p>
      </div>
      <ErrorBanner error={error} what="the workflow" />
      {notice ? <div className="banner info" role="status">{notice}</div> : null}

      <div className="ed-layout">
        <div className="stack">
          <section className="card" aria-labelledby="ed-basics">
            <h2 id="ed-basics">Workflow</h2>
            <div className="ed-grid">
              <Field label="Project"><select value={pid} onChange={(e) => setProjectId(e.target.value)}>{(projects.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
              <Field label="Steps that may run at once" hint="1 to 4"><input type="text" inputMode="numeric" value={concurrency} onChange={(e) => setConcurrency(e.target.value)} /></Field>
              <Field label="Title" wide><input type="text" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} /></Field>
              <Field label="Goal" hint="What the finished work should achieve. Every agent sees it." wide><textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={3} /></Field>
            </div>
          </section>

          <ol className="ed-steps" aria-label="Steps">
            {steps.map((s, i) => {
              const k = KINDS.find((x) => x.id === s.kind)!; const others = ids.filter((x) => x !== s.id);
              return (
                <li key={i} className="card ed-step">
                  <div className="row spread">
                    <h2 className="ed-step-h"><span className="ed-n">{i + 1}</span>{s.id || 'unnamed'} <span className="badge tone-muted">{k.label}</span></h2>
                    <div className="row">
                      <button type="button" className="btn small-btn" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move step ${s.id} up`}>Up</button>
                      <button type="button" className="btn small-btn" onClick={() => move(i, 1)} disabled={i === steps.length - 1} aria-label={`Move step ${s.id} down`}>Down</button>
                      <button type="button" className="btn small-btn danger" onClick={() => remove(i)} aria-label={`Remove step ${s.id}`}>Remove</button>
                    </div>
                  </div>
                  <p className="basis">{k.hint}</p>
                  <div className="ed-grid">
                    <Field label="Step id" hint="Lowercase letters, digits and dashes"><input type="text" value={s.id} onChange={(e) => rename(i, e.target.value)} /></Field>
                    <Field label="Kind"><select value={s.kind} onChange={(e) => patch(i, { kind: e.target.value as Kind, role: e.target.value === 'review' ? 'reviewer' : s.role === 'reviewer' ? 'coder' : s.role })}>{KINDS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select></Field>
                    <Field label="Title" hint="Optional" wide><input type="text" value={s.title} onChange={(e) => patch(i, { title: e.target.value })} /></Field>
                    {(s.kind === 'agent' || s.kind === 'review') && <Field label="Role" hint={roles[s.role]?.writes === false ? 'Read-only: cannot change files' : 'Can edit files'}><select value={s.role} onChange={(e) => patch(i, { role: e.target.value })}>{Object.keys(roles).map((r) => <option key={r} value={r}>{r}</option>)}</select></Field>}
                    {(s.kind === 'agent' || s.kind === 'review') && <Field label="Model" hint="Leave empty to let routing choose"><input type="text" value={s.model} onChange={(e) => patch(i, { model: e.target.value })} /></Field>}
                    {(s.kind === 'agent' || s.kind === 'review' || s.kind === 'approval') && <Field label={s.kind === 'approval' ? 'Message to the approver' : 'Instructions'} wide><textarea value={s.prompt} onChange={(e) => patch(i, { prompt: e.target.value })} rows={s.kind === 'approval' ? 2 : 4} /></Field>}
                    {s.kind === 'agent' && <Field label="Acceptance criteria" hint="One per line" wide><textarea value={s.acceptance} onChange={(e) => patch(i, { acceptance: e.target.value })} rows={2} /></Field>}
                    {s.kind === 'check' && <Field label="Command" hint="Program and arguments separated by spaces, for example npm test. No shell." wide><input type="text" value={s.command} onChange={(e) => patch(i, { command: e.target.value })} /></Field>}
                    {s.kind === 'check' && <Field label="Verifies"><select value={s.verifies} onChange={(e) => patch(i, { verifies: e.target.value })}><option value="">Choose a step</option>{stepIds(['agent', 'integrate']).map((x) => <option key={x}>{x}</option>)}</select></Field>}
                    {s.kind === 'check' && <Field label="Time limit (ms)" hint="1000 to 3600000"><input type="text" inputMode="numeric" value={s.timeoutMs} onChange={(e) => patch(i, { timeoutMs: e.target.value })} placeholder="300000" /></Field>}
                    {s.kind === 'review' && <Field label="Reviews"><select value={s.reviews} onChange={(e) => patch(i, { reviews: e.target.value })}><option value="">Choose a step</option>{stepIds(['agent', 'integrate']).map((x) => <option key={x}>{x}</option>)}</select></Field>}
                    {s.kind === 'review' && <Field label="Send back at or above" hint="Findings below this are reported but do not block"><select value={s.blockAt} onChange={(e) => patch(i, { blockAt: e.target.value })}>{['low', 'medium', 'high', 'critical'].map((x) => <option key={x}>{x}</option>)}</select></Field>}
                    {(s.kind === 'check' || s.kind === 'review') && <Field label="Fixed by" hint="The agent step that corrects a failure"><select value={s.fixer} onChange={(e) => patch(i, { fixer: e.target.value })}><option value="">Default</option>{stepIds(['agent']).filter((x) => x !== s.id).map((x) => <option key={x}>{x}</option>)}</select></Field>}
                    {['agent', 'check', 'review'].includes(s.kind) && <Field label="Attempts allowed" hint="1 to 5. Retry limit for this step"><input type="text" inputMode="numeric" value={s.maxAttempts} onChange={(e) => patch(i, { maxAttempts: e.target.value })} placeholder="2" /></Field>}
                    {(s.kind === 'agent' || s.kind === 'review') && <Field label="Budget (USD)" hint="Stops retrying once reported spend reaches this. Unreported cost is not counted"><input type="text" inputMode="decimal" value={s.budgetUsd} onChange={(e) => patch(i, { budgetUsd: e.target.value })} placeholder="No limit" /></Field>}
                  </div>
                  {others.length ? (
                    <fieldset className="ed-needs"><legend>Starts after</legend>
                      {others.map((o) => <label key={o} className="check"><input type="checkbox" checked={s.needs.includes(o)} onChange={(e) => patch(i, { needs: e.target.checked ? [...s.needs, o] : s.needs.filter((n) => n !== o) })} />{o}</label>)}
                    </fieldset>
                  ) : null}
                  {others.length ? (
                    <div className="ed-when">
                      <Field label="Only run when"><select value={s.whenStep} onChange={(e) => patch(i, { whenStep: e.target.value })}><option value="">Always</option>{others.map((o) => <option key={o}>{o}</option>)}</select></Field>
                      {s.whenStep ? <Field label="has"><select value={s.whenStatus} onChange={(e) => patch(i, { whenStatus: e.target.value as 'passed' | 'failed' })}><option>passed</option><option>failed</option></select></Field> : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>

          <div className="row ed-add" role="group" aria-label="Add a step">
            <span className="muted">Add a step</span>
            {KINDS.map((k) => <button key={k.id} type="button" className="btn" onClick={() => add(k.id)}>{k.label}</button>)}
          </div>
        </div>

        <aside className="ed-side" aria-label="Validation and files">
          <section className="card" aria-labelledby="ed-check">
            <h2 id="ed-check">Check</h2>
            <div role="status" aria-live="polite">
              {checking ? <p className="muted">Checking…</p>
                : check?.ok ? <p className="ok-line"><span className="badge tone-good">Valid</span> {steps.length} steps, ready to save.</p>
                : check ? <><p><span className="badge tone-bad">{check.problems.length} {check.problems.length === 1 ? 'problem' : 'problems'}</span></p><ul className="problems">{check.problems.map((p, i) => <li key={i}>{p}</li>)}</ul></> : null}
            </div>
            <div className="stack-sm">
              <button type="button" className="btn primary" disabled={!canCreate} onClick={() => void create()}>{busy ? 'Saving…' : 'Create workflow'}</button>
              {!title.trim() || !goal.trim() ? <p className="basis">A title and a goal are needed to create it.</p> : null}
            </div>
          </section>
          <section className="card" aria-labelledby="ed-files">
            <h2 id="ed-files">Files</h2>
            <div className="stack-sm">
              <button type="button" className="btn" disabled={!check?.ok} onClick={download}>Download as file</button>
              <label className="btn file-btn-label">Import from file<input type="file" accept="application/json,.json" onChange={(e) => void onFile(e)} className="sr-only" /></label>
              <button type="button" className="btn" aria-expanded={pasteOpen} onClick={() => setPasteOpen((v) => !v)}>Paste JSON</button>
              {pasteOpen ? <><label className="sr-only" htmlFor="ed-paste">Workflow JSON</label><textarea id="ed-paste" value={paste} onChange={(e) => setPaste(e.target.value)} rows={8} className="mono" /><button type="button" className="btn" disabled={!paste.trim()} onClick={() => void importText(paste)}>Load</button></> : null}
              <button type="button" className="btn" onClick={() => { setSteps(TEMPLATE.steps); setConcurrency('2'); setNotice('Loaded the standard feature workflow.'); }}>Start from the feature template</button>
              <p className="basis">Files are checked against the same rules as the editor. Unknown keys are reported, so a misspelt limit is never silently ignored.</p>
            </div>
          </section>
        </aside>
      </div>
    </>
  );
}
