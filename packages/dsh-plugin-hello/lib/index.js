/**
 * Host half of the hello plugin.
 *
 * Purpose: prove that a third-party local plugin can (a) load into a dsh profile,
 * (b) acquire the `connection` service, and (c) serve an authenticated exact Fetch
 * route the browser half can call.
 */

export const name = 'dsh-plugin-hello';

/** `connection` owns the exact Fetch route registry. */
export const inject = ['connection'];

export function apply(ctx) {
  console.log('[hello-plugin] host apply() called');

  const dispose = ctx.connection.fetch.register({
    path: '/api/hello.ping',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: () =>
      Promise.resolve(
        Response.json(
          {
            ok: true,
            source: 'dsh-plugin-hello',
            pid: process.pid,
            node: process.version,
            cwd: process.cwd(),
            when: new Date().toISOString(),
          },
          { headers: { 'cache-control': 'no-store' } },
        ),
      ),
  });

  console.log('[hello-plugin] route /api/hello.ping registered');

  ctx.effect(() => () => {
    console.log('[hello-plugin] disposing');
    dispose();
  }, 'hello-plugin: ping route');
}
