import { Hono } from 'hono';
import { customerRefundReturnFixture } from './customerRefundReturnFixture';
import { systemAdmin, systemRole, systemStore, systemSupplier, systemMenus, storeOrderOutbox } from '../../src/models/schema';
import { adminAuthMiddleware } from '../../src/middleware/admin-auth';
import { adminRefundList, adminRefundDetail, adminRefundAgree, adminRefundRefuse } from '../../src/controllers/api/v1/AdminCrudController';
import { execute, privateRefundOperationResponse } from '../../src/controllers/api/v1/AdminRefundOperationController';
import { createToken, md5 } from '../../src/utils/jwt';
import { ApiException } from '../../src/utils/errors';
import type { Env, AppVariables } from '../../src/env';
import type { PgTable } from 'drizzle-orm/pg-core';

/** Isolated SQL + real platform JWT/role/controller stack. No production fallback. */
export async function adminRefundEvidenceFixture(afterAuth?: () => Promise<void>, extraTables: PgTable[] = []) {
  const f = await customerRefundReturnFixture([systemAdmin, systemRole, systemStore, systemSupplier, systemMenus, storeOrderOutbox, ...extraTables]);
  try {
    await f.exec('CREATE UNIQUE INDEX admin_refund_fixture_event_key ON store_order_outbox(event_key)');
    await f.db.insert(systemRole).values({ id: 1, type: 1, roleName: '本地只读售后', rules: 'refund.view' });
    await f.db.insert(systemAdmin).values([
      { id: 100, account: 'local-admin', pwd: 'synthetic-digest', adminType: 1, level: 0 },
      { id: 101, account: 'local-reader', pwd: 'synthetic-digest', adminType: 1, level: 1, roles: '1' },
      { id: 102, account: 'local-denied', pwd: 'synthetic-digest', adminType: 1, level: 1 },
      { id: 103, account: 'local-supplier', pwd: 'synthetic-digest', adminType: 4, level: 0 },
    ]);
    const tokens = new Map<number, string>();
    for (const id of [100,101,102,103]) tokens.set(id, (await createToken(id, 'admin', md5('synthetic-digest'), f.env.APP_KEY)).token);
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use('*', async (c, next) => { c.set('container', f.container); await next(); });
    app.get('/adminapi/refund/list', adminAuthMiddleware(), adminRefundList);
    app.get('/adminapi/refund/detail/:id', adminAuthMiddleware(), adminRefundDetail);
    app.post('/adminapi/refund/refund/:id', privateRefundOperationResponse, adminAuthMiddleware(), adminRefundAgree);
    app.post('/adminapi/refund/refuse/:id', privateRefundOperationResponse, adminAuthMiddleware(), adminRefundRefuse);
    // Scoped decision tests use the production versioned controller. The hook
    // models changes after entry auth; assembled-route tests use createApp.
    // Tests which execute operations must explicitly install the receipt DDL.
    app.post('/adminapi/refund/operations/execute/:id', privateRefundOperationResponse, adminAuthMiddleware(),
      async (_c,next)=>{await afterAuth?.();await next();}, execute);
    app.onError((error, c) => c.json({ status: error instanceof ApiException ? error.code : 500, msg: error.message, data: null }));
    return { ...f, adminApp: app, tokens };
  } catch (error) { await f.close(); throw error; }
}
