// Server-side gateway between the browser and the orchestrator.
//
// The browser only ever talks to this same-origin /api. The orchestrator itself stays on loopback and
// refuses any request carrying a browser Origin, so no other web page can drive it. This gateway adds the
// same protection for itself:
//   * Host must be a loopback name            -> blocks DNS-rebinding
//   * POST must come from this site (Origin)  -> blocks cross-site form / fetch posts
//   * bodies must be JSON
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
export const dynamic = 'force-dynamic';

// Decisions on approvals (approve / reject) need the decision token. Only this server holds it, and it is added only
// to those routes, only for a same-site browser request. The orchestrator never hands it to agent processes.
const DECISION_PATH = /^\/?(approvals\/[^/]+\/(approve|reject)|workflows\/[^/]+\/steps\/[^/]+\/(approve|reject))$/;
function decisionToken(): string | undefined {
  const env = process.env.ORCH_DECISION_TOKEN?.trim(); if (env) return env;
  for (const p of [process.env.ORCH_DECISION_TOKEN_FILE, resolve(process.cwd(), '.sandbox/decision.token'), resolve(process.cwd(), '../../.sandbox/decision.token')]) {
    try { if (p && existsSync(p)) { const t = readFileSync(p, 'utf8').trim(); if (t) return t; } } catch { /* try the next place */ }
  }
  return undefined;
}

const BACKEND = process.env.ORCHESTRATOR_URL ?? 'http://127.0.0.1:4317';
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/;
const SEGMENT = /^[A-Za-z0-9._~-]+$/;
const FORWARD = ['content-type', 'idempotency-key', 'last-event-id'];

const fail = (status: number, error: string) => Response.json({ error }, { status, headers: { 'cache-control': 'no-store' } });

async function handle(req: Request, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const host = req.headers.get('host') ?? '';
  if (!LOCAL_HOST.test(host)) return fail(403, 'host not allowed');
  if (req.method !== 'GET' && req.method !== 'POST') return fail(405, 'method not allowed');

  let body: string | undefined;
  if (req.method === 'POST') {
    const origin = req.headers.get('origin');
    let sameSite = false; try { sameSite = !!origin && new URL(origin).host === host; } catch { /* malformed Origin */ }
    if (!sameSite) return fail(403, 'cross-site request refused');
    body = await req.text();
    if (body && !/^application\/json\b/i.test(req.headers.get('content-type') ?? '')) return fail(415, 'content-type must be application/json');
  }

  const { path } = await ctx.params;
  if (!path.length || path.some((s) => s === '.' || s === '..' || !SEGMENT.test(s))) return fail(400, 'bad path');
  const target = `${BACKEND}/${path.map(encodeURIComponent).join('/')}${new URL(req.url).search}`;

  const headers: Record<string, string> = {};
  for (const h of FORWARD) { const v = req.headers.get(h); if (v) headers[h] = v; }
  if (req.method === 'POST' && DECISION_PATH.test(path.join('/')) && req.headers.get('sec-fetch-site') !== 'cross-site') { const t = decisionToken(); if (t) headers['x-orch-decision-token'] = t; }

  let upstream: Response;
  try { upstream = await fetch(target, { method: req.method, headers, body: body || undefined, signal: req.signal, cache: 'no-store' }); }
  catch { return fail(502, `The orchestrator is not reachable at ${BACKEND}. Is it running?`); }

  const type = upstream.headers.get('content-type') ?? 'application/json';
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'content-type': type, 'cache-control': type.startsWith('text/event-stream') ? 'no-cache, no-transform' : 'no-store', 'x-accel-buffering': 'no' },
  });
}

export const GET = handle;
export const POST = handle;
