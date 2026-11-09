// Server-side gateway between the browser and the orchestrator.
//
// The browser only ever talks to this same-origin /api. The orchestrator itself stays on loopback and
// refuses any request carrying a browser Origin, so no other web page can drive it. This gateway adds the
// same protection for itself:
//   * Host must be a loopback name            -> blocks DNS-rebinding
//   * POST must come from this site (Origin)  -> blocks cross-site form / fetch posts
//   * bodies must be JSON
export const dynamic = 'force-dynamic';

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
