import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { AppVariables, Env } from '../src/env';
import { createContainerFromDb, type DbClient } from '../src/lib/di';
import { orderCreate } from '../src/controllers/api/v1/OrderController';
import { StoreOrderCreateService, type CreateOrderParams } from '../src/services/order/StoreOrderCreateService';
import { completePurchaseOriginEvidenceOrm } from '../src/migrations/runPurchaseOriginEvidence';
import { completePurchaseCancellationEvidenceOrm } from '../src/migrations/runPurchaseCancellationEvidence';
import {
  orderPrintJob, storeCart, storeOrder, storeOrderCartInfo, storeOrderOutbox,
  storeOrderPurchaseOrigin, storeProduct, storeProductAttrValue, storeIntegral, systemStore, user, userBill,
} from '../src/models/schema';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';

const input = { cartIds: [1], addressId: 11, couponId: 0, type: 0 };

function purchaseApp(db: DbClient) {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.use('*', async (c, next) => {
    // Synthetic request identity; the service and database transaction are real.
    c.set('container', createContainerFromDb(db));
    c.set('uid', 11);
    await next();
  });
  app.onError((error, c) => c.json({ status: 400, msg: error.message, data: null }));
  app.post('/api/order/create/:key', orderCreate);
  return app;
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('account deletion versus final order admission on native PostgreSQL', () => {
  let owned: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  let fixture: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;

  beforeEach(async () => {
    fixture = await createPcCheckoutQuoteFixture([], async () => {
      owned = await sequenceRunnerDatabase();
      try {
        const api = await import('drizzle-kit/api'), schema = await import('../src/models/schema');
        await owned.exec((await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(schema))).join('\n'));
        await completePurchaseOriginEvidenceOrm(owned.db);
        await completePurchaseCancellationEvidenceOrm(owned.db);
        return owned;
      } catch (error) { await owned.close(); throw error; }
    });
    expect(owned.format).toBe('pg16');
    await fixture.setConfig(Object.fromEntries(Object.keys(fixture.config).map(key => [key, '0'])));
    Object.assign(fixture.env, { SEQUENCE: { idFromName: () => 'isolated',
      get: () => ({ fetch: async () => new Response('account_cancel_order_admission') }) } });
  }, 120_000);

  afterEach(async () => { await fixture?.close(); }, 120_000);

  async function confirmation() {
    const response = await fixture.app.request('/api/order/confirm', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-user': '11' },
      body: JSON.stringify(input),
    }, fixture.env);
    const result = await response.json() as { status: number; msg: string; data: { orderKey: string; quoteToken: string } };
    expect(result.status, result.msg).toBe(200);
    return result.data;
  }

  async function buy(db: DbClient, receipt: Awaited<ReturnType<typeof confirmation>>) {
    const response = await purchaseApp(db).request(`/api/order/create/${receipt.orderKey}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...input, quoteToken: receipt.quoteToken }),
    }, fixture.env);
    return response.json() as Promise<{ status: number; msg: string; data: { orderId: string } | null }>;
  }

  async function durableState() {
    return {
      carts: await fixture.db.select().from(storeCart),
      products: await fixture.db.select().from(storeProduct),
      skus: await fixture.db.select().from(storeProductAttrValue),
      orders: await fixture.db.select().from(storeOrder),
      lines: await fixture.db.select().from(storeOrderCartInfo),
      bills: await fixture.db.select().from(userBill),
      origins: await fixture.db.select().from(storeOrderPurchaseOrigin),
      outbox: await fixture.db.select().from(storeOrderOutbox),
      printJobs: await fixture.db.select().from(orderPrintJob),
    };
  }

  it.each([
    ['legacy delete_time only', `UPDATE "user" SET delete_time=clock_timestamp() WHERE uid=11`],
    ['is_del only', `UPDATE "user" SET is_del=1 WHERE uid=11`],
    ['disabled status', `UPDATE "user" SET status=0 WHERE uid=11`],
  ])('%s commits while checkout waits for the SKU: creation rolls back every write', async (_label, mutation) => {
    const receipt = await confirmation();
    const before = await durableState();
    const withPeer = owned.withPeer;
    if (!withPeer) throw new Error('Dedicated PostgreSQL peers required');
    await withPeer(async skuHolder => withPeer(async deleter => withPeer(async buyer => {
      expect(new Set([skuHolder.pid, deleter.pid, buyer.pid]).size).toBe(3);
      await skuHolder.exec('BEGIN; SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE');
      let skuPending = true;
      let deletionPending = false;
      try {
        const buying = buy(buyer.db, receipt);
        await waitForFinanceBlock(fixture.db, buyer.pid, skuHolder.pid);
        await deleter.exec(`BEGIN; ${mutation}`);
        deletionPending = true;
        await deleter.exec('COMMIT');
        deletionPending = false;
        await skuHolder.exec('COMMIT');
        skuPending = false;
        const refused = await buying;
        expect(refused.status).not.toBe(200);
        // Quote-token calls deliberately turn definitive business rejection into
        // a fresh-confirmation response; the transaction still wrote nothing.
        expect(refused.msg).toContain('重新确认');
        const repeated = await buy(buyer.db, receipt);
        expect(repeated.status).not.toBe(200);
      } finally {
        if (deletionPending) await deleter.exec('ROLLBACK');
        if (skuPending) await skuHolder.exec('ROLLBACK');
      }
    })));
    expect(await durableState()).toEqual(before);
    const [account] = await fixture.db.select({ uid: user.uid, status: user.status,
      isDel: user.isDel, deleteTime: user.deleteTime }).from(user).limit(1);
    expect(account?.uid).toBe(11);
    expect(account!.status !== 1 || account!.isDel !== 0 || account!.deleteTime !== null).toBe(true);
  }, 30_000);

  it('a deletion rollback before the SKU wait ends allows purchase and preserves idempotent replay', async () => {
    const receipt = await confirmation();
    const withPeer = owned.withPeer;
    if (!withPeer) throw new Error('Dedicated PostgreSQL peers required');
    await withPeer(async skuHolder => withPeer(async deleter => withPeer(async buyer => {
      await skuHolder.exec('BEGIN; SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE');
      let skuPending = true;
      let deletionPending = false;
      try {
        const buying = buy(buyer.db, receipt);
        await waitForFinanceBlock(fixture.db, buyer.pid, skuHolder.pid);
        await deleter.exec('BEGIN; UPDATE "user" SET is_del=1, delete_time=clock_timestamp() WHERE uid=11');
        deletionPending = true;
        await deleter.exec('ROLLBACK');
        deletionPending = false;
        await skuHolder.exec('COMMIT');
        skuPending = false;
        const created = await buying;
        expect(created.status, created.msg).toBe(200);
        expect(created.data?.orderId).toBeTruthy();
        const beforeReplay = await durableState();
        const replayed = await buy(buyer.db, receipt);
        expect(replayed.status, replayed.msg).toBe(200);
        expect(replayed.data?.orderId).toBe(created.data?.orderId);
        expect(await durableState()).toEqual(beforeReplay);
      } finally {
        if (deletionPending) await deleter.exec('ROLLBACK');
        if (skuPending) await skuHolder.exec('ROLLBACK');
      }
    })));
    const [account] = await fixture.db.select({ status: user.status, isDel: user.isDel,
      deleteTime: user.deleteTime }).from(user).limit(1);
    expect(account).toMatchObject({ status: 1, isDel: 0, deleteTime: null });
    expect((await durableState()).orders).toHaveLength(1);
  }, 30_000);

  it('an uncommitted user change makes the final NOWAIT guard fail closed without a partial order', async () => {
    const receipt = await confirmation();
    const before = await durableState();
    const withPeer = owned.withPeer;
    if (!withPeer) throw new Error('Dedicated PostgreSQL peers required');
    await withPeer(async deleter => withPeer(async buyer => {
      await deleter.exec('BEGIN; UPDATE "user" SET is_del=1 WHERE uid=11');
      let pending = true;
      try {
        // This must finish before the deleter releases its lock.
        const refused = await buy(buyer.db, receipt);
        expect(refused.status).not.toBe(200);
        expect(refused.msg).toContain('重新确认');
        await deleter.exec('ROLLBACK');
        pending = false;
      } finally { if (pending) await deleter.exec('ROLLBACK'); }
    }));
    expect(await durableState()).toEqual(before);
  }, 30_000);

  it.each(['ordinary first', 'points first'])('%s: ordinary and points orders for the same SKU finish without a user/SKU cycle', async first => {
    await fixture.db.update(systemStore).set({ isStore: 1 });
    await fixture.db.insert(storeIntegral).values({ id: 9, productId: 70, storeName: 'points sample',
      stock: 8, quota: 8, status: 1, isShow: 1, isDel: 0, freight: 1 });
    await fixture.db.insert(storeProductAttrValue).values({ id: 2, productId: 9, type: 4,
      unique: 'point001', suk: '红色,大号', stock: 8, quota: 8, price: '2.00', integral: 30 });
    await fixture.db.insert(storeCart).values({ id: 2, uid: 11, productId: 70,
      productAttrUnique: 'qared001', cartNum: 2, type: 4, activityId: 9, isNew: 1, status: 1 });
    const ordinary: CreateOrderParams = { uid: 11, key: 'ordinary_order', cartIds: [1],
      shippingType: 2, storeId: 1, realName: 'Local buyer', userPhone: '00000000000', type: 0, userIp: '127.0.0.1' };
    const points: CreateOrderParams = { uid: 11, key: 'points_order', cartIds: [2],
      shippingType: 2, storeId: 1, realName: 'Local buyer', userPhone: '00000000000', type: 4, userIp: '127.0.0.1' };
    const withPeer = owned.withPeer;
    if (!withPeer) throw new Error('Dedicated PostgreSQL peers required');
    await withPeer(async holder => withPeer(async buyerA => withPeer(async buyerB => {
      // The second checkout's full quote pre-read can outlast the peers' default
      // eight-second lock timeout while the first request is parked on this fixture.
      await buyerA.exec("SET lock_timeout='30000ms'; SET statement_timeout='30000ms'");
      await buyerB.exec("SET lock_timeout='30000ms'; SET statement_timeout='30000ms'");
      await holder.exec('BEGIN; SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE');
      let pending = true;
      try {
        const create = (db: DbClient, params: CreateOrderParams) =>
          StoreOrderCreateService.createWithRuntime(createContainerFromDb(db),
            { CONFIG_KV: fixture.env.CONFIG_KV, nextOrderId: async () => `isolated_${params.key}` }, params);
        const firstParams = first === 'ordinary first' ? ordinary : points;
        const secondParams = first === 'ordinary first' ? points : ordinary;
        const firstOrder = outcome(create(buyerA.db, firstParams));
        await waitForFinanceBlock(fixture.db, buyerA.pid, holder.pid);
        const secondOrder = outcome(create(buyerB.db, secondParams));
        // The first transaction already owns an incompatible user lock, either
        // from the order FK or the points balance check. The second waits there.
        await waitForFinanceBlock(fixture.db, buyerB.pid, buyerA.pid);
        await holder.exec('COMMIT');
        pending = false;
        const [a, b] = await Promise.all([firstOrder, secondOrder]);
        expect(a).toMatchObject({ ok: true });
        expect(b).toMatchObject({ ok: true });
      } finally { if (pending) await holder.exec('ROLLBACK'); }
    })));
    const orders = await fixture.db.select().from(storeOrder);
    expect(orders).toHaveLength(2);
    expect(orders.map(order => order.type).sort()).toEqual([0, 4]);
    const [sku] = await fixture.db.select({ stock: storeProductAttrValue.stock })
      .from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 1));
    expect(sku.stock).toBe(4);
  }, 40_000);
});
