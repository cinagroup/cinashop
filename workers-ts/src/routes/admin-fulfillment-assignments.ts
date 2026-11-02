import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import type { AppVariables, Env } from '@/env';
import { adminRuntimeAuthMiddleware } from '@/middleware/admin-runtime-auth';
import * as assignment from '@/controllers/api/v1/AdminOrderFulfillmentAssignmentController';

export const adminFulfillmentAssignmentRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();
const privateResponse: MiddlewareHandler<{ Bindings: Env; Variables: AppVariables }> = async (c, next) => {
  c.header('Cache-Control', 'private, no-store'); c.header('Pragma', 'no-cache'); await next();
};
const auth = adminRuntimeAuthMiddleware();
adminFulfillmentAssignmentRoutes.get('/review/:id', privateResponse, auth, assignment.review);
adminFulfillmentAssignmentRoutes.get('/stores', privateResponse, auth, assignment.stores);
adminFulfillmentAssignmentRoutes.post('/commit', privateResponse, auth, assignment.commit);
adminFulfillmentAssignmentRoutes.get('/receipt/:operationId', privateResponse, auth, assignment.receipt);
