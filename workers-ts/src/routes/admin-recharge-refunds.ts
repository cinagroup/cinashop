import { Hono } from 'hono';
import type { AppVariables,Env } from '@/env';
import { adminRuntimeAuthMiddleware } from '@/middleware/admin-runtime-auth';
import { quote,execute,receipt,execution,query,abandon,cancel,privateRechargeRefundResponse } from '@/controllers/api/v1/AdminRechargeRefundController';

/** Both aliases authenticate in the ordinary App realm before opening an
 * independent actual Admin LOGIN. No URL-selected role or public key lookup. */
export const adminRechargeRefundRoutes=new Hono<{Bindings:Env;Variables:AppVariables}>();
const auth=adminRuntimeAuthMiddleware();
adminRechargeRefundRoutes.post('/quote/:id',privateRechargeRefundResponse,auth,quote);
adminRechargeRefundRoutes.post('/execute/:id',privateRechargeRefundResponse,auth,execute);
adminRechargeRefundRoutes.post('/receipt',privateRechargeRefundResponse,auth,receipt);
adminRechargeRefundRoutes.post('/execution',privateRechargeRefundResponse,auth,execution);
adminRechargeRefundRoutes.post('/query',privateRechargeRefundResponse,auth,query);
adminRechargeRefundRoutes.post('/abandon/:id',privateRechargeRefundResponse,auth,abandon);
adminRechargeRefundRoutes.post('/cancel/:id',privateRechargeRefundResponse,auth,cancel);
