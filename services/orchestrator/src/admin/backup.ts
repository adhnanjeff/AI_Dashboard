import { mkdirSync, statSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import type { Store } from '../storage/store.ts';
import type { MemoryService } from '../memory/memory-service.ts';
import { MIGRATIONS } from '../storage/migrations.ts';

/**
 * Phase 13: backup, export and migration tools.
 *
 *  - backup: a consistent copy of the whole database (SQLite VACUUM INTO), written into a fixed backup folder under a
 *    name the server chooses. A caller can never pick a path. The copy is opened and checked before it is reported.
 *  - export: one project's portable data (settings, human-written memory, workflow definitions) as JSON. It leaves out
 *    run logs, events, approvals and anything that could carry a credential.
 *  - import: only human-written, active project memory is accepted, re-screened by the normal memory rules, so an edited
 *    file cannot smuggle in agent-trusted text or instructions.
 */

export const PROJECT_EXPORT_FORMAT = 'ai-control-center/project-export';
export const PROJECT_EXPORT_VERSION = 1;
export class AdminError extends Error { status: number; constructor(status: number, msg: string) { super(msg); this.status = status; } }

export interface BackupInfo { file: string; path: string; bytes: number; createdAt: string; schemaVersion: number; integrity: string; tables: Record<string, number> }
const COUNTED = ['project', 'session', 'task', 'agent_run', 'event', 'memory_entry', 'workflow', 'approval', 'usage_record', 'audit_log'];

export function backupDatabase(store: Store, dir: string, now = new Date()): BackupInfo {
  const folder = resolve(dir); mkdirSync(folder, { recursive: true });
  const file = `orchestrator-${now.toISOString().replace(/[:.]/g, '-')}.db`; const path = join(folder, file);
  store.sql().run('VACUUM INTO ?', path);
  return inspectBackup(path, now.toISOString());
}

/** Opens a backup read-only and checks it. A backup nobody has opened is a hope, not a backup. */
export function inspectBackup(path: string, createdAt = new Date().toISOString()): BackupInfo {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = String((db.prepare('PRAGMA integrity_check').get() as any).integrity_check);
    const schemaVersion = (db.prepare('SELECT MAX(version) v FROM schema_migration').get() as any).v as number;
    const tables: Record<string, number> = {}; for (const t of COUNTED) tables[t] = (db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as any).n;
    if (integrity !== 'ok') throw new AdminError(500, `backup failed its integrity check: ${integrity}`);
    if (schemaVersion !== MIGRATIONS.at(-1)!.version) throw new AdminError(500, `backup has schema version ${schemaVersion}, expected ${MIGRATIONS.at(-1)!.version}`);
    return { file: path.split(/[\\/]/).pop()!, path, bytes: statSync(path).size, createdAt, schemaVersion, integrity, tables };
  } finally { db.close(); }
}

export function listBackups(dir: string): { file: string; bytes: number; modifiedAt: string }[] {
  try {
    return readdirSync(resolve(dir)).filter((f) => /^orchestrator-.*\.db$/.test(f)).map((f) => { const s = statSync(join(resolve(dir), f)); return { file: f, bytes: s.size, modifiedAt: s.mtime.toISOString() }; })
      .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, 50);
  } catch { return []; }
}

export function exportProject(store: Store, projectId: string, now = new Date()) {
  const project = store.getProject(projectId); if (!project) throw new AdminError(404, 'project not found');
  const memory = store.listMemory({ projectId }).filter((m) => m.scope === 'project');
  const workflows = store.sql().all<any>('SELECT title, goal, definition, status, created_at FROM workflow WHERE project_id=? ORDER BY created_at', projectId);
  return {
    format: PROJECT_EXPORT_FORMAT, version: PROJECT_EXPORT_VERSION, exportedAt: now.toISOString(),
    project: { name: project.name, defaultBranch: project.defaultBranch, settings: project.settings, note: 'repoPath is not exported: a project is re-attached to a local folder on import.' },
    memory: memory.map((m) => ({ category: m.category, content: m.content, trust: m.trust, authorRole: m.authorRole, status: m.status, source: m.source, createdAt: m.createdAt })),
    workflows: workflows.map((w) => ({ title: w.title, goal: w.goal, status: w.status, createdAt: w.created_at, definition: JSON.parse(w.definition) })),
    counts: { memory: memory.length, workflows: workflows.length },
  };
}

export interface ImportReport { imported: number; duplicates: number; skipped: { index: number; reason: string }[]; limit: number }
const IMPORT_LIMIT = 500;

export function importProjectMemory(memory: MemoryService, projectId: string, file: unknown): ImportReport {
  const f = file as any;
  if (!f || typeof f !== 'object') throw new AdminError(400, 'the file must be a JSON object');
  if (f.format !== PROJECT_EXPORT_FORMAT) throw new AdminError(400, `format must be "${PROJECT_EXPORT_FORMAT}"`);
  if (f.version !== PROJECT_EXPORT_VERSION) throw new AdminError(400, `unsupported version ${JSON.stringify(f.version)} (this tool reads version ${PROJECT_EXPORT_VERSION})`);
  if (!Array.isArray(f.memory)) throw new AdminError(400, 'memory must be an array');
  if (f.memory.length > IMPORT_LIMIT) throw new AdminError(413, `at most ${IMPORT_LIMIT} entries per import`);
  const rep: ImportReport = { imported: 0, duplicates: 0, skipped: [], limit: IMPORT_LIMIT };
  f.memory.forEach((m: any, index: number) => {
    const skip = (reason: string) => rep.skipped.push({ index, reason });
    if (!m || typeof m !== 'object') return skip('not an object');
    if (m.trust !== 'user') return skip('agent-written entries are not imported (their source runs do not exist in this project)');
    if (m.status !== undefined && m.status !== 'active') return skip(`status is ${JSON.stringify(m.status)}, only active entries are imported`);
    if (typeof m.category !== 'string' || typeof m.content !== 'string') return skip('category and content are required');
    try { const r = memory.add({ projectId, category: m.category, content: m.content, role: 'user' }); if (r.deduped) rep.duplicates++; else rep.imported++; }
    catch (e: any) { skip(String(e.message ?? e).slice(0, 200)); }
  });
  return rep;
}
