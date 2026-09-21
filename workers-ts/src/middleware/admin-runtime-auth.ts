import type { MiddlewareHandler } from 'hono';
import type { AppVariables, Env } from '@/env';
import { createAdminDatabaseSession } from '@/lib/di';
import { adminAuthMiddleware } from './admin-auth';

/** Production Admin routes must use this boundary, not URL-based connection
 * selection. Authentication, live account state, password claim and route
 * authorization all run on the ordinary connection before any Admin I/O. */
export function adminRuntimeAuthMiddleware(): MiddlewareHandler<{ Bindings: Env; Variables: AppVariables }> {
  const authenticate = adminAuthMiddleware();
  return (c, next) => authenticate(c, async () => {
    const application = c.get('container');
    const session = createAdminDatabaseSession(c.env);
    c.set('applicationContainer', application);
    c.set('container', session.container);
    try { await next(); }
    finally {
      c.set('container', application);
      c.set('applicationContainer', undefined);
      await session.close();
    }
  });
}
