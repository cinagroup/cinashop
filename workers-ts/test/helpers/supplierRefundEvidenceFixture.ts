import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { customerRefundReturnFixture } from './customerRefundReturnFixture';
import { storeOrder, storeOrderRefund, systemAdmin, systemSupplier, systemRole } from '../../src/models/schema';
import { supplierAuthMiddleware } from '../../src/middleware/supplier-auth';
import { supplierPermissionMiddleware } from '../../src/middleware/supplier-permission';
import { refundDetail, refundList, updateRefundRemark } from '../../src/controllers/supplier/SupplierController';
import { createToken, md5 } from '../../src/utils/jwt';
import type { AppVariables, Env } from '../../src/env';

/** Real auth/permission/controllers and isolated SQL. No merchant refund execution route. */
export async function supplierRefundEvidenceFixture() {
  const f = await customerRefundReturnFixture([systemAdmin, systemSupplier, systemRole]);
  try {
    await f.db.insert(systemSupplier).values([{ id: 20, adminId: 100, supplierName: '本地商家甲', isShow: 1 }, { id: 40, adminId: 200, supplierName: '本地商家乙', isShow: 1 }]);
    await f.db.insert(systemRole).values({ id: 1, type: 4, relationId: 20, roleName: '只读售后', rules: 'supplier.refund.view' });
    await f.db.insert(systemAdmin).values([
      { id: 100, account: 'local-merchant', pwd: 'synthetic-digest', adminType: 4, relationId: 20 },
      { id: 101, account: 'local-reader', pwd: 'synthetic-digest', adminType: 4, relationId: 20, roles: '1' },
      { id: 102, account: 'local-denied', pwd: 'synthetic-digest', adminType: 4, relationId: 20 },
      { id: 200, account: 'local-other', pwd: 'synthetic-digest', adminType: 4, relationId: 40 },
    ]);
    for (const id of [25, 32, 39]) {
      await f.db.update(storeOrder).set({ supplierId: 20, realName: '本地客户', userPhone: '000000' }).where(eq(storeOrder.id, id));
      await f.db.update(storeOrderRefund).set({ supplierId: 20 }).where(eq(storeOrderRefund.id, id));
    }
    const tokens = new Map<number, string>();
    for (const id of [100, 101, 102, 200]) tokens.set(id, (await createToken(id, 'supplier', md5('synthetic-digest'), f.env.APP_KEY)).token);
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use('*', async (c, next) => { c.set('container', f.container); await next(); });
    app.use('*', supplierAuthMiddleware, supplierPermissionMiddleware);
    app.get('/supplierapi/refund/list', refundList);
    app.get('/supplierapi/refund/detail/:id', refundDetail);
    app.put('/supplierapi/refund/remark/:id', updateRefundRemark);
    app.onError((error, c) => c.json({ status: 400, msg: error.message, data: null }));
    return { ...f, supplierApp: app, tokens };
  } catch (error) { await f.close(); throw error; }
}
