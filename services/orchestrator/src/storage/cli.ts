// Manual inspection helper: node services/orchestrator/src/storage/cli.ts <db-path> <seed|dump>
import { openDb } from './db.ts';
import { Store } from './store.ts';
import { seedDemo } from './seed.ts';

const [dbPath, cmd] = process.argv.slice(2);
if (!dbPath || !['seed', 'dump'].includes(cmd)) { console.log('usage: cli.ts <db-path> <seed|dump>'); process.exit(1); }
const store = new Store(openDb(dbPath));
if (cmd === 'seed') seedDemo(store);
for (const pr of store.listProjects()) {
  console.log(`PROJECT ${pr.name} (${pr.id})`);
  for (const s of store.listSessions(pr.id)) {
    console.log(`  SESSION [${s.status}] ${s.title}  checkpoint=${s.checkpointId ? 'yes' : 'no'}`);
    for (const t of store.listTasks(s.id)) console.log(`    TASK [${t.status}] ${t.description}`);
    for (const e of store.listEvents(s.id)) console.log(`    #${e.seq} ${e.type} ${JSON.stringify(e.payload)}`);
  }
}
