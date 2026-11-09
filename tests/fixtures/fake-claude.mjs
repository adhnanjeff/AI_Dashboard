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
if (scenario === 'fail') { init(); process.stderr.write('boom: something broke\n'); process.exit(2); }
if (scenario === 'noresult') { init(); say('I am done, trust me'); process.exit(0); }
if (scenario === 'errresult') { init(); out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'tool failed' }); process.exit(0); }
if (scenario === 'secret') { init(); say('using key sk-ant-api03-abcdefghijklmnopqrstuv now'); success('password=hunter2hunter2'); process.exit(0); }
if (scenario === 'slow') {
  init();
  // A grandchild, like a tool subprocess. A correct cancel must kill it too.
  const gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  if (process.env.FAKE_PIDFILE) writeFileSync(process.env.FAKE_PIDFILE, String(gc.pid));
  setInterval(() => {}, 1000); // hang until killed
} else if (!['ok', 'fail', 'noresult', 'errresult', 'secret'].includes(scenario)) {
  console.error('unknown scenario ' + scenario); process.exit(64);
}
