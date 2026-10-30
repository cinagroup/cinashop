import type { MiddlewareHandler } from 'hono';
import type { AppVariables, Env } from '@/env';
import { createCustomerCashierDatabaseSession } from '@/lib/di';
import { AuthException, ApiErrorCode } from '@/utils/errors';
import { authMiddleware } from './auth';
import { prepareCustomerCashierCapabilityContext } from '@/services/customer-work/CustomerCashierCapabilities';

/** App verifies the complete UserJWT before Cashier I/O opens. Individual
 * locked services distinguish fresh customer work from original UUID recovery;
 * losing current customer qualification never erases an owner's prior receipt. */
export function customerCashierRuntimeAuthMiddleware(options: { capabilities?: true } = {}): MiddlewareHandler<{ Bindings: Env; Variables: AppVariables }> {
  const authenticate = authMiddleware({ force: true }), capabilityEntry = options.capabilities === true;
  return (c, next) => {
    if (capabilityEntry) { c.header('Cache-Control', 'private, no-store'); c.header('Pragma', 'no-cache'); }
    return authenticate(c, async () => {
      const actor = c.get('uid');
      if (!Number.isSafeInteger(actor) || actor <= 0) throw new AuthException('无用户端权限', ApiErrorCode.ERR_BANNED);
      const application = c.get('container');
      // Only the exact capability route enables this server-owned option. App
      // DB identity is proved before the independent Cashier connection opens.
      const context = capabilityEntry ? await prepareCustomerCashierCapabilityContext(application, c.env) : undefined;
      const session = await createCustomerCashierDatabaseSession(c.env);
      const previous = c.get('cashierCapabilityContext');
      if (context) c.set('cashierCapabilityContext', context);
      c.set('container', session.container);
      try { await next(); }
      finally {
        c.set('container', application);
        if (context) c.set('cashierCapabilityContext', previous);
        await session.close();
      }
    });
  };
}
