/** Isolated runtime entrypoint only: actual production API route assembly/auth.
 * No deployment config, maintenance SQL or test-only financial operations.
 */
import { Hono } from 'hono';
import type { AppVariables, Env } from '../../src/env';
import { createDb, createContainerFromDb } from '../../src/lib/di';
import { apiRoutes } from '../../src/routes';
import { errorHandler } from '../../src/middleware/error';
import { responseCacheMiddleware } from '../../src/middleware/response-cache';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!/^cinashop_kefu_runner_[a-f0-9]{32}$/.test(env.HYPERDRIVE.database)
      || !/^cinashop_runtime_[a-f0-9]{32}$/.test(env.HYPERDRIVE.user)) return new Response(null, { status: 503 });
    const db = createDb(env);
    try {
      const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
      app.onError(errorHandler); app.use('*', responseCacheMiddleware);
      app.use('*', async (c, next) => { c.set('container', createContainerFromDb(db)); await next(); });
      app.route('/api', apiRoutes);
      return await app.fetch(request, env);
    } finally { await db.$client.end({ timeout: 5 }); }
  },
} satisfies ExportedHandler<Env>;
