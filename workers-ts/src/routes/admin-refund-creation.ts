import { Hono } from 'hono';
import type { AppVariables, Env } from '@/env';
import { adminAuthMiddleware } from '@/middleware/admin-auth';
import { privateRefundOperationResponse } from '@/controllers/api/v1/AdminRefundOperationController';
import { adminRefundCreationQuote } from '@/controllers/api/v1/AdminRefundCreationQuoteController';
import { abandon, create, execute, receipt } from '@/controllers/api/v1/AdminRefundCreationController';

/** Local versioned candidate. No legacy body translation, implicit operation
 * key, automatic DDL or outer transaction around financial execution. */
export const adminRefundCreationRoutes=new Hono<{Bindings:Env;Variables:AppVariables}>();
const auth=adminAuthMiddleware();
adminRefundCreationRoutes.post('/quote',privateRefundOperationResponse,auth,adminRefundCreationQuote);
adminRefundCreationRoutes.post('/create',privateRefundOperationResponse,auth,create);
adminRefundCreationRoutes.post('/execute',privateRefundOperationResponse,auth,execute);
adminRefundCreationRoutes.post('/receipt',privateRefundOperationResponse,auth,receipt);
adminRefundCreationRoutes.post('/abandon',privateRefundOperationResponse,auth,abandon);
