import type { MiddlewareHandler } from 'hono';
import type { AppVariables, Env } from '@/env';
import { createManagerDatabaseSession } from '@/lib/di';
import { authMiddleware } from './auth';

/** Authentication stays on the ordinary application connection. Manager
 * services check current store scope for new writes inside their locked
 * transactions; original owner receipts remain readable after role loss. */
export function managerRuntimeAuthMiddleware(): MiddlewareHandler<{Bindings:Env;Variables:AppVariables}> {
  const authenticate = authMiddleware({force:true});
  return (c, next) => authenticate(c, async () => {
    const application = c.get('container');
    const session = createManagerDatabaseSession(c.env);
    c.set('container', session.container);
    try { await next(); }
    finally {
      c.set('container', application);
      await session.close();
    }
  });
}
