import { Hono, type MiddlewareHandler } from 'hono';
import type { AppVariables, Env } from '@/env';
import { managerRuntimeAuthMiddleware } from '@/middleware/manager-runtime-auth';
import * as assignment from '@/controllers/api/v1/StoreManagerAssignedFulfillmentController';

export const managerAssignedFulfillmentRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();
const privateResponse: MiddlewareHandler<{ Bindings: Env; Variables: AppVariables }> = async (c, next) => {
  c.header('Cache-Control', 'private, no-store'); c.header('Pragma', 'no-cache'); await next();
};
const auth = managerRuntimeAuthMiddleware();
managerAssignedFulfillmentRoutes.get('/inbox', privateResponse, auth, assignment.inbox);
managerAssignedFulfillmentRoutes.get('/review/:id', privateResponse, auth, assignment.review);
managerAssignedFulfillmentRoutes.post('/commit', privateResponse, auth, assignment.commit);
managerAssignedFulfillmentRoutes.get('/receipt/:requestKey', privateResponse, auth, assignment.receipt);
