/**
 * Host half of Qoder Assist.
 *
 * Read-only observation of qodercli terminal sessions plus optional SDK-driven
 * review. All routes live under `/api/qoder-assist.*` and are authenticated by
 * the dsh Fetch bridge.
 */

import { Hub } from './hub.js';
import { hooksStatus, installHooks, uninstallHooks } from './hooks.js';

export const name = 'dsh-plugin-qoder-assist';

/** `connection` owns the exact Fetch route registry. */
export const inject = ['connection'];

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

async function readJson(request) {
  try {
    const text = await request.text();
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

export function apply(ctx) {
  const cwd = process.env.DSH_QODER_ASSIST_CWD || process.cwd();
  const hub = new Hub({ cwd, logger: ctx.logger });

  console.log(`[qoder-assist] host apply() — workspace ${cwd}`);

  const routes = [];
  const route = (path, methods, handler) => {
    routes.push(
      ctx.connection.fetch.register({
        path,
        methods,
        requestBody: 'buffered',
        fetch: async (request) => {
          try {
            return await handler(request);
          } catch (error) {
            console.error(`[qoder-assist] ${path} failed`, error);
            return json({ ok: false, error: String(error?.message ?? error) }, 500);
          }
        },
      }),
    );
  };

  route('/api/qoder-assist.state', ['GET'], async () => json(await hub.state()));

  route('/api/qoder-assist.messages', ['GET'], async (request) => {
    const url = new URL(request.url);
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) return json({ ok: false, error: 'sessionId required' }, 400);
    const before = Number(url.searchParams.get('before') ?? 0) || 0;
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 200) || 200, 500);
    return json({ ok: true, sessionId, ...(await hub.messages(sessionId, { before, limit })) });
  });

  route('/api/qoder-assist.stream', ['GET'], async (request) => {
    const url = new URL(request.url);
    const from = Number(url.searchParams.get('from') ?? 0) || 0;
    return new Response(hub.stream(from), {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    });
  });

  route('/api/qoder-assist.suggestions', ['GET'], async (request) => {
    const url = new URL(request.url);
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) return json({ ok: false, error: 'sessionId required' }, 400);
    return json({ ok: true, suggestions: await hub.suggestions(sessionId) });
  });

  route('/api/qoder-assist.feedback', ['POST'], async (request) => {
    const body = await readJson(request);
    return json(await hub.feedback(body.sessionId, body.suggestionId, Number(body.itemIndex) || 0, body.value));
  });

  route('/api/qoder-assist.read', ['POST'], async (request) => {
    const body = await readJson(request);
    return json(await hub.read(body.sessionId, Number(body.offset) || 0));
  });

  route('/api/qoder-assist.summary', ['GET', 'POST'], async (request) => {
    if (request.method === 'GET') {
      const url = new URL(request.url);
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId) return json({ ok: false, error: 'sessionId required' }, 400);
      return json(await hub.summary(sessionId));
    }
    const body = await readJson(request);
    return json(await hub.generateSummary(body.sessionId, { final: Boolean(body.final) }));
  });

  route('/api/qoder-assist.analyze', ['POST'], async (request) => {
    const body = await readJson(request);
    return json(await hub.analyze(body.sessionId));
  });

  route('/api/qoder-assist.hooks', ['GET', 'POST'], async (request) => {
    if (request.method === 'GET') return json({ ok: true, ...(await hooksStatus()) });
    const body = await readJson(request);
    const action = body.action === 'uninstall' ? 'uninstall' : 'install';
    const status = action === 'uninstall' ? await uninstallHooks() : await installHooks();
    return json({ ok: true, action, ...status });
  });

  console.log(`[qoder-assist] ${routes.length} routes registered`);

  void hub.start().catch((error) => console.error('[qoder-assist] start failed', error));

  ctx.effect(() => () => {
    console.log('[qoder-assist] disposing');
    for (const dispose of routes) {
      try {
        dispose();
      } catch {}
    }
    void hub.dispose();
  }, 'qoder-assist: routes');
}
