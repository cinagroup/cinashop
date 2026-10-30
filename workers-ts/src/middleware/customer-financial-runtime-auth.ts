import type { MiddlewareHandler } from 'hono';
import type { AppVariables, Env } from '@/env';
import { createCustomerFinancialDatabaseSession } from '@/lib/di';
import { authMiddleware } from './auth';

/** User authentication stays on App I/O. Current Customer work scope belongs
 * to the locked services; original owner receipts remain readable after the
 * customer qualification is withdrawn. No request-time DDL or ACL repair. */
export function customerFinancialRuntimeAuthMiddleware(): MiddlewareHandler<{ Bindings: Env; Variables: AppVariables }> {
  const authenticate = authMiddleware({ force: true });
  return (c, next) => authenticate(c, async () => {
    const application = c.get('container');
    const session = await createCustomerFinancialDatabaseSession(c.env);
    c.set('container', session.container);
    try { await next(); }
    finally {
      c.set('container', application);
      await session.close();
    }
  });
}
