// Starts the orchestrator backend on localhost only.
//   DB_PATH (default .sandbox/orchestrator.db)   PORT (default 4317)
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { openDb } from './storage/db.ts';
import { Store } from './storage/store.ts';
import { ClaudeCliAdapter } from './runtime/adapters/claude-cli.ts';
import { Supervisor } from './runtime/process-manager/supervisor.ts';
import { createApi } from './api/server.ts';

const dbPath = resolve(process.env.DB_PATH ?? '.sandbox/orchestrator.db');
const port = Number(process.env.PORT ?? 4317);
mkdirSync(dirname(dbPath), { recursive: true });

const db = openDb(dbPath);
const store = new Store(db);
const supervisor = new Supervisor(store, new ClaudeCliAdapter());

const server = createApi(store, supervisor);
// Binding the port doubles as the single-instance lock. Orphan recovery runs only AFTER it succeeds:
// a second instance must never mark the first instance's live runs as orphaned.
server.on('error', (e: NodeJS.ErrnoException) => {
  console.error(e.code === 'EADDRINUSE' ? `port ${port} is in use: another orchestrator is already running. Not touching the database.` : e);
  db.close(); process.exit(1);
});
server.listen(port, '127.0.0.1', () => {
  for (const o of supervisor.recoverOrphans()) console.warn(`recovered orphaned run ${o.runId} (pid ${o.pid}, still alive: ${o.stillAlive})`);
  console.log(`orchestrator listening on http://127.0.0.1:${port} (db: ${dbPath})`);
});

let stopping = false;
const stop = async () => {
  if (stopping) return; stopping = true;
  console.log('shutting down: stopping workers');
  server.close();
  await supervisor.shutdown();
  db.close(); // an open handle keeps the WAL files locked on Windows
  process.exit(0);
};
process.on('SIGINT', stop); process.on('SIGTERM', stop);
