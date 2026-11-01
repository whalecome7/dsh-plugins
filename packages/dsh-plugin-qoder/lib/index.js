/**
 * Host half of the Qoder panel.
 *
 * Serves a small JSON/SSE API that the browser half calls with plain `fetch`.
 * All routes live under `/api/qoder.*`, which dsh resolves as exact Fetch routes
 * owned by this plugin — authenticated and owner-scoped by the framework.
 */

import { QoderManager } from './qoder-manager.js';
import { diff as gitDiff, head as gitHead, status as gitStatus } from './git-tools.js';

export const name = 'dsh-plugin-qoder';

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
  const cwd = process.env.DSH_QODER_CWD || process.cwd();
  const manager = new QoderManager({ cwd, logger: ctx.logger });

  console.log(`[qoder] host apply() — workspace ${cwd}`);

  const routes = [];

  /** Register one exact Fetch route and remember it for disposal. */
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
            console.error(`[qoder] ${path} failed`, error);
            return json({ ok: false, error: String(error?.message ?? error) }, 500);
          }
        },
      }),
    );
  };

  route('/api/qoder.state', ['GET'], async () => {
    const [gitState, head, sessions] = await Promise.all([gitStatus(cwd), gitHead(cwd), manager.list()]);
    return json({ ok: true, cwd, git: { ...gitState, ...(head ?? {}) }, sessions });
  });

  route('/api/qoder.session', ['POST'], async (request) => {
    const body = await readJson(request);
    const session = manager.create(body.title);
    return json({ ok: true, session: { id: session.id, title: session.title } });
  });

  route('/api/qoder.send', ['POST'], async (request) => {
    const body = await readJson(request);
    const session = manager.ensure(body.sessionId);
    const result = await manager.send(session, body.prompt, {
      model: body.model || undefined,
      force: Boolean(body.force),
    });
    return json({ ok: result.accepted, ...result }, result.accepted ? 200 : 409);
  });

  route('/api/qoder.stream', ['GET'], async (request) => {
    const url = new URL(request.url);
    const session = manager.get(url.searchParams.get('sessionId'));
    if (!session) return new Response('unknown session', { status: 404 });
    const from = Number(url.searchParams.get('from') ?? 0) || 0;

    return new Response(manager.stream(session, from), {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    });
  });

  route('/api/qoder.abort', ['POST'], async (request) => {
    const body = await readJson(request);
    const session = manager.get(body.sessionId);
    if (!session) return json({ ok: false, error: 'unknown session' }, 404);
    return json(await manager.abort(session));
  });

  route('/api/qoder.approve', ['POST'], async (request) => {
    const body = await readJson(request);
    const session = manager.get(body.sessionId);
    if (!session) return json({ ok: false, error: 'unknown session' }, 404);
    return json(manager.approve(session, body.approvalId, body.behavior === 'allow' ? 'allow' : 'deny', body.message));
  });

  route('/api/qoder.diff', ['GET'], async (request) => {
    const url = new URL(request.url);
    const session = manager.get(url.searchParams.get('sessionId'));
    if (session?.lastDiff) return json({ ok: true, ...session.lastDiff });
    return json({ ok: true, ...(await gitDiff(cwd)) });
  });

  route('/api/qoder.summary', ['GET'], async (request) => {
    const url = new URL(request.url);
    const session = manager.get(url.searchParams.get('sessionId'));
    if (!session) return json({ ok: false, error: 'unknown session' }, 404);
    return json({ ok: true, markdown: await manager.readSummary(session) });
  });

  route('/api/qoder.close', ['POST'], async (request) => {
    const body = await readJson(request);
    const session = manager.get(body.sessionId);
    if (!session) return json({ ok: true });
    return json(await manager.close(session));
  });

  console.log(`[qoder] ${routes.length} routes registered`);

  ctx.effect(() => () => {
    console.log('[qoder] disposing');
    for (const dispose of routes) {
      try {
        dispose();
      } catch {
        /* ignore */
      }
    }
    void manager.dispose();
  }, 'qoder-panel: routes');
}
