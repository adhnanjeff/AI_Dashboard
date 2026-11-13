// Stand-in for the `claude` CLI. Behaviour is chosen with FAKE_SCENARIO; Claude's own flags are ignored.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const scenario = process.env.FAKE_SCENARIO ?? 'ok';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const init = () => out({ type: 'system', subtype: 'init', session_id: 'fake-session', model: 'fake-model' });
const noise = () => {
  out({ type: 'system', subtype: 'hook_response' });
  out({ type: 'system', subtype: 'thinking_tokens' });
  process.stdout.write('this line is not JSON\n');
};
const say = (text, tool) => out({ type: 'assistant', message: { content: [
  { type: 'text', text }, ...(tool ? [{ type: 'tool_use', id: 't1', name: tool, input: {} }] : [])] } });
const toolResult = () => out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'File created', is_error: false }] } });
const success = (text = 'DONE') => out({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 0.01 });

if (scenario === 'ok') { init(); noise(); say('working', 'Write'); toolResult(); say('finished'); success(); process.exit(0); }
if (scenario === 'usage') { init(); say('working', 'Write'); toolResult(); out({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', total_cost_usd: Number(process.env.FAKE_COST ?? 0.25), usage: { input_tokens: 1200, output_tokens: 340 } }); process.exit(0); }
if (scenario === 'nocost') { init(); say('working', 'Write'); toolResult(); out({ type: 'result', subtype: 'success', is_error: false, result: 'DONE' }); process.exit(0); }
if (scenario === 'ratelimit') { init(); out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: process.env.FAKE_RESET_EPOCH ? Number(process.env.FAKE_RESET_EPOCH) : undefined } }); process.exit(1); }
if (scenario === 'ratelimit-result') { init(); out({ type: 'result', subtype: 'error', is_error: true, result: 'Claude AI usage limit reached' }); process.exit(1); }
if (scenario === 'fail') { init(); process.stderr.write('boom: something broke\n'); process.exit(2); }
if (scenario === 'noresult') { init(); say('I am done, trust me'); process.exit(0); }
if (scenario === 'errresult') { init(); out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'tool failed' }); process.exit(0); }
if (scenario === 'secret') { init(); say('using key sk-ant-api03-abcdefghijklmnopqrstuv now'); success('password=hunter2hunter2'); process.exit(0); }
if (scenario === 'edit-then-hang') {
  // Does real work in cwd (an untracked file), reports it, then hangs like a stuck or interrupted worker.
  init(); writeFileSync('work.txt', 'precious\n'); say('writing work.txt', 'Write'); toolResult();
  setInterval(() => {}, 1000);
} else if (scenario === 'record-prompt') {
  // Records exactly what it was launched with, then finishes successfully.
  init();
  if (process.env.FAKE_ARGS_FILE) writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), configDir: process.env.CLAUDE_CONFIG_DIR ?? null, keyLength: (process.env.ANTHROPIC_API_KEY ?? '').length }));
  writeFileSync('part2.txt', 'finished by resumed worker\n'); say('continuing', 'Write'); toolResult(); success(); process.exit(0);
} else if (scenario === 'slow') {
  init();
  // A grandchild, like a tool subprocess. A correct cancel must kill it too.
  const gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  if (process.env.FAKE_PIDFILE) writeFileSync(process.env.FAKE_PIDFILE, String(gc.pid));
  setInterval(() => {}, 1000); // hang until killed
} else if (!['ok', 'fail', 'noresult', 'errresult', 'secret', 'edit-then-hang', 'record-prompt', 'usage', 'nocost', 'ratelimit', 'ratelimit-result'].includes(scenario)) {
  console.error('unknown scenario ' + scenario); process.exit(64);
}
