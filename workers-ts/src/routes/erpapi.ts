import { Hono } from 'hono';
import type { AppVariables, Env } from '@/env';
import { adminRuntimeAuthMiddleware } from '@/middleware/admin-runtime-auth';
import * as ErpController from '@/controllers/erp/ErpController';

export const erpapiRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();
erpapiRoutes.use('*', async (c, next) => {
  c.header('Cache-Control', 'private, no-store');
  c.header('Pragma', 'no-cache');
  c.header('Referrer-Policy', 'no-referrer');
  await next();
});
const admin = adminRuntimeAuthMiddleware();
// Exact PHP route/erp.php paths. OAuth/callback authority is established by
// the independent connection services; management uses a genuine Admin JWT.
erpapiRoutes.get('/auth', admin, ErpController.erpAuth);
erpapiRoutes.get('/auth/call_back', ErpController.erpAuthCallback);
erpapiRoutes.get('/auth/access_token', admin, ErpController.erpAccessToken);
erpapiRoutes.get('/product/syncProduct', admin, ErpController.erpProductSync);
erpapiRoutes.post('/stock/callback', ErpController.erpStockCallback);
erpapiRoutes.post('/order/deliver_callback', ErpController.erpDeliverCallback);
erpapiRoutes.post('/order/cancel_callback', ErpController.erpCancelCallback);
erpapiRoutes.post('/refund/receive_callback', ErpController.erpRefundReceiveCallback);
