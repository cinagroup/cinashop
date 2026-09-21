import { Hono } from 'hono';
import type { AppVariables, Env } from '@/env';
import { adminRuntimeAuthMiddleware } from '@/middleware/admin-runtime-auth';
import { abandon, execute, receipt, privateRefundOperationResponse } from '@/controllers/api/v1/AdminRefundOperationController';

/** Both Admin URL domains share exactly this authenticated versioned protocol.
 * Legacy decision routes are not silently upgraded or given fabricated keys. */
export const adminRefundOperationRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();
const auth = adminRuntimeAuthMiddleware();
adminRefundOperationRoutes.post('/execute/:id', privateRefundOperationResponse, auth, execute);
adminRefundOperationRoutes.post('/receipt', privateRefundOperationResponse, auth, receipt);
adminRefundOperationRoutes.post('/abandon/:id', privateRefundOperationResponse, auth, abandon);
