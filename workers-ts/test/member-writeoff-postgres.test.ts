import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { createContainerFromDb, type DbClient } from '../src/lib/di';
import { deliveryService, storeOrder, storeOrderCartInfo, storeOrderRefund, storeOrderStatus,
  storeOrderWriteoff, storePink, storeServiceRecord, systemStore, systemStoreStaff, user } from '../src/models/schema';
import { StoreOrderWriteoffService, normalizeMemberWriteoffCode } from '../src/services/order/StoreOrderWriteoffService';
import { runMemberBarcodeIndex } from '../src/migrations/runMemberBarcodeIndex';
import { financePostgres } from './helpers/financePostgres';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';
import { errorHandler } from '../src/middleware/error';

vi.mock('@/services/order/OrderBrokerageService', async (original) => {
  const real = await original<typeof import('../src/services/order/OrderBrokerageService')>();
  return { ...real, loadOrderReceiptSettlementContext: async () => ({ brokerage: {}, rewards: {} }),
    settleCompletedOrderInTx: vi.fn(async () => undefined) };
});

const TABLES = [user, systemStore, systemStoreStaff, deliveryService, storeOrder,
  storeOrderCartInfo, storeOrderRefund, storeOrderWriteoff, storeOrderStatus, storePink, storeServiceRecord];
const MEMBER = '123456789';
const VERIFY = '112233445566';
const actor = { kind: 'staff' as const, uid: 101 };
const items = [{ orderCartId: 401, quantity: 1 }];

function service(db: DbClient) {
  return new StoreOrderWriteoffService(createContainerFromDb(db), {} as never);
}

async function fixture(db: DbClient) {
  await db.insert(user).values([
    { uid: 11, barCode: MEMBER, status: 1 },
    { uid: 12, barCode: '987654321', status: 1 },
    { uid: 101, status: 1 }, { uid: 102, status: 1 },
    { uid: 201, status: 1 }, { uid: 202, status: 1 },
  ]);
  await db.insert(systemStore).values([
    { id: 1, name: '甲店', isStore: 1, isShow: 1 },
    { id: 2, name: '乙店', isStore: 1, isShow: 1 },
  ]);
  await db.insert(systemStoreStaff).values([
    { id: 1, uid: 101, storeId: 1, status: 1, verifyStatus: 1 },
    { id: 2, uid: 102, storeId: 2, status: 1, verifyStatus: 1 },
  ]);
  await db.insert(deliveryService).values([
    { id: 1, uid: 201, type: 0, relationId: 0, status: 1 },
    { id: 2, uid: 202, type: 0, relationId: 0, status: 1 },
  ]);
  await db.insert(storeOrder).values([
    { id: 301, uid: 11, orderId: 'member-pickup-1', storeId: 1, shippingType: 2,
      paid: 1, status: 0, verifyCode: VERIFY, totalNum: 1, payPrice: '10.00', payTime: 100 },
    { id: 302, uid: 11, orderId: 'member-pickup-2', storeId: 2, shippingType: 2,
      paid: 1, status: 0, verifyCode: '223344556677', totalNum: 1, payPrice: '10.00', payTime: 90 },
    { id: 303, uid: 11, orderId: 'member-delivery', shippingType: 1, deliveryType: 'send', deliveryUid: 201,
      paid: 1, status: 1, verifyCode: '334455667788', totalNum: 1, payPrice: '10.00', payTime: 80 },
  ]);
  await db.insert(storeOrderCartInfo).values([
    { id: 401, oid: 301, uid: 11, cartId: 'cart-1', writeTimes: 1, writeSurplusTimes: 1,
      cartInfo: JSON.stringify({ sku: { price: '10.00' } }) },
    { id: 402, oid: 302, uid: 11, cartId: 'cart-2', writeTimes: 1, writeSurplusTimes: 1,
      cartInfo: JSON.stringify({ sku: { price: '10.00' } }) },
    { id: 403, oid: 303, uid: 11, cartId: 'cart-3', writeTimes: 1, writeSurplusTimes: 1,
      cartInfo: JSON.stringify({ sku: { price: '10.00' } }) },
  ]);
}

it('keeps the member-code protocol distinct from twelve-digit order codes', () => {
  expect(normalizeMemberWriteoffCode(MEMBER)).toBe(MEMBER);
  expect(normalizeMemberWriteoffCode('1'.repeat(16))).toBe('1'.repeat(16));
  expect(() => normalizeMemberWriteoffCode(VERIFY)).toThrow(/会员码格式/);
  expect(() => normalizeMemberWriteoffCode(` ${MEMBER}`)).toThrow(/会员码格式/);
});

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('member writeoff on isolated native PostgreSQL 16', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>;
  beforeEach(async () => { f = await financePostgres(TABLES, { namespace: 'public' }); await fixture(f.db); });
  afterEach(async () => { await f?.close(); });

  it('requires the exact member unique index, rejects a public decoy, and keeps the legacy order code available', async () => {
    const worker = service(f.db);
    await expect(worker.memberSummarySearch(actor, MEMBER)).rejects.toThrow(/索引未就绪/);
    await expect(worker.executeMember(actor, { memberCode: MEMBER, orderId: 301, items })).rejects.toThrow(/索引未就绪/);
    await runMemberBarcodeIndex(f.db);
    expect((await worker.memberSummarySearch(actor, MEMBER)).data.map(row => row.id)).toEqual([301]);
    expect((await worker.info(actor, VERIFY)).id).toBe(301);
    await f.exec('DROP INDEX public.user_bar_code_uq');
    await f.exec('CREATE INDEX user_bar_code_uq ON public."user" (uid)');
    await expect(worker.memberInfo(actor, MEMBER, 301)).rejects.toThrow(/索引未就绪/);
  });

  it('lists only role-owned orders and rejects cross-store or cross-delivery previews and writes', async () => {
    await runMemberBarcodeIndex(f.db);
    const worker = service(f.db);
    expect((await worker.memberSummarySearch(actor, MEMBER)).data.map(row => row.id)).toEqual([301]);
    expect((await worker.memberSummarySearch({ kind: 'staff', uid: 102 }, MEMBER)).data.map(row => row.id)).toEqual([302]);
    expect((await worker.memberSummarySearch({ kind: 'delivery', uid: 201 }, MEMBER)).data.map(row => row.id)).toEqual([303]);
    expect((await worker.memberSummarySearch({ kind: 'delivery', uid: 202 }, MEMBER)).data).toEqual([]);
    await expect(worker.memberInfo(actor, MEMBER, 302)).rejects.toThrow();
    await expect(worker.executeMember(actor, { memberCode: MEMBER, orderId: 302, items: [{ orderCartId: 402, quantity: 1 }] })).rejects.toThrow();
    await expect(worker.memberInfo({ kind: 'delivery', uid: 202 }, MEMBER, 303)).rejects.toThrow();
    await expect(worker.executeMember({ kind: 'delivery', uid: 202 },
      { memberCode: MEMBER, orderId: 303, items: [{ orderCartId: 403, quantity: 1 }] })).rejects.toThrow();
    expect(await f.db.select().from(storeOrderWriteoff)).toEqual([]);
  });

  it('bounds the authorized store list after scoping away twenty newer foreign-store orders', async () => {
    await runMemberBarcodeIndex(f.db);
    await f.db.insert(storeOrder).values(Array.from({ length: 20 }, (_, index) => ({
      id: 500 + index, uid: 11, orderId: `foreign-store-${index}`, storeId: 2,
      shippingType: 2, paid: 1, status: 0, verifyCode: String(500000000000 + index),
      totalNum: 1, payPrice: '10.00', payTime: 1_000 + index,
    })));
    const worker = service(f.db);
    expect((await worker.memberSummarySearch(actor, MEMBER)).data.map(row => row.id)).toEqual([301]);
    await expect(worker.memberSummarySearch({ kind: 'staff', uid: 102 }, MEMBER))
      .rejects.toThrow(/超过20单/);
    expect(await worker.memberSummarySearch(actor, '000000000')).toEqual({ data: [] });
  });

  it('reports twenty-one authorized orders explicitly instead of silently hiding the oldest', async () => {
    await runMemberBarcodeIndex(f.db);
    await f.db.insert(storeOrder).values(Array.from({ length: 20 }, (_, index) => ({
      id: 600 + index, uid: 11, orderId: `owned-store-${index}`, storeId: 1,
      shippingType: 2, paid: 1, status: 0, verifyCode: String(600000000000 + index),
      totalNum: 1, payPrice: '10.00', payTime: 1_000 + index,
    })));
    await expect(service(f.db).memberSummarySearch(actor, MEMBER)).rejects.toThrow(/超过20单.*12位订单码/);
  });

  it('does not reveal a twenty-one-order account through a duplicated staff identity', async () => {
    await runMemberBarcodeIndex(f.db);
    await f.db.insert(storeOrder).values(Array.from({ length: 20 }, (_, index) => ({
      id: 700 + index, uid: 11, orderId: `duplicate-staff-${index}`, storeId: 1,
      shippingType: 2, paid: 1, status: 0, verifyCode: String(700000000000 + index),
      totalNum: 1, payPrice: '10.00', payTime: 1_000 + index,
    })));
    await f.db.insert(systemStoreStaff).values({
      id: 3, uid: 101, storeId: 1, status: 1, verifyStatus: 1,
    });
    const worker = service(f.db);
    expect(await worker.memberSummarySearch(actor, MEMBER)).toEqual({ data: [] });
    expect(await worker.memberSummarySearch(actor, '000000000')).toEqual({ data: [] });
    await expect(worker.memberInfo(actor, MEMBER, 301)).rejects.toThrow(/核销订单不存在或不可核销/);
  });

  it('gives the same HTTP envelope for unknown and valid-but-unauthorized member bindings', async () => {
    await runMemberBarcodeIndex(f.db);
    const worker = service(f.db);
    const app = new Hono();
    app.onError(errorHandler);
    app.post('/info', async c => {
      const body = await c.req.json() as { member_code: string; order_id: number };
      return c.json(await worker.memberInfo(actor, body.member_code, body.order_id));
    });
    app.post('/write', async c => {
      const body = await c.req.json() as { member_code: string; order_id: number };
      return c.json(await worker.executeMember(actor, { memberCode: body.member_code, orderId: body.order_id, items }));
    });
    for (const route of ['/info', '/write']) {
      const call = async (member_code: string) => app.request(`http://localhost${route}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ member_code, order_id: 302 }),
      });
      const unknown = await call('000000000');
      const unauthorized = await call(MEMBER);
      expect(unauthorized.status).toBe(unknown.status);
      expect(await unauthorized.text()).toBe(await unknown.text());
    }
  });

  it('does not reveal a twenty-one-order account to an unassigned kefu actor', async () => {
    await runMemberBarcodeIndex(f.db);
    await f.db.insert(storeOrder).values(Array.from({ length: 20 }, (_, index) => ({
      id: 750 + index, uid: 11, orderId: `unassigned-kefu-${index}`, storeId: 1,
      shippingType: 2, paid: 1, status: 0, verifyCode: String(750000000000 + index),
      totalNum: 1, payPrice: '10.00', payTime: 1_000 + index,
    })));
    const worker = service(f.db);
    const kefu = { kind: 'kefu' as const, kefuId: 1, kefuUid: 101 };
    expect(await worker.memberSummarySearch(kefu, MEMBER)).toEqual({ data: [] });
    expect(await worker.memberSummarySearch(kefu, '000000000')).toEqual({ data: [] });
  });

  for (const invalid of ['pickup_status', 'split', 'supplier_allocating', 'pink_pending', 'open_refund'] as const) {
    it(`excludes a ${invalid} order before the twenty-one-row member boundary`, async () => {
      await runMemberBarcodeIndex(f.db);
      await f.db.insert(storeOrder).values(Array.from({ length: 19 }, (_, index) => ({
        id: 800 + index, uid: 11, orderId: `eligible-${index}`, storeId: 1,
        shippingType: 2, paid: 1, status: 0, verifyCode: String(800000000000 + index),
        totalNum: 1, payPrice: '10.00', payTime: 1_000 + index,
      })));
      await f.db.insert(storeOrder).values({
        id: 819, uid: 11, orderId: `ineligible-${invalid}`, storeId: 1,
        shippingType: 2, paid: 1, status: invalid === 'pickup_status' ? 1 : 0,
        pid: invalid === 'split' ? -1 : 0,
        supplierAllocationStatus: invalid === 'supplier_allocating' ? 1 : 0,
        type: invalid === 'pink_pending' ? 3 : 0,
        pinkId: invalid === 'pink_pending' ? 999 : 0,
        verifyCode: '819000000000', totalNum: 1, payPrice: '10.00', payTime: 2_000,
      });
      if (invalid === 'open_refund') await f.db.insert(storeOrderRefund).values({
        id: 901, storeOrderId: 819, refundType: 0, isCancel: 0, isDel: 0,
      });
      const rows = (await service(f.db).memberSummarySearch(actor, MEMBER)).data;
      expect(rows).toHaveLength(20);
      expect(rows.map(row => row.id)).not.toContain(819);
    });
  }

  it('uses the same empty lookup response for unknown, retired, and valid codes without eligible orders', async () => {
    await runMemberBarcodeIndex(f.db);
    const worker = service(f.db);
    const unknown = await worker.memberSummarySearch(actor, '000000000');
    await f.db.update(user).set({ status: 0 }).where(eq(user.uid, 11));
    const retired = await worker.memberSummarySearch(actor, MEMBER);
    await f.db.update(user).set({ status: 1 }).where(eq(user.uid, 11));
    const noOrders = await worker.memberSummarySearch({ kind: 'delivery', uid: 202 }, MEMBER);
    expect(unknown).toEqual({ data: [] });
    expect(retired).toEqual(unknown);
    expect(noOrders).toEqual(unknown);
  });

  it('keeps the twelve-digit order-code execution on the original state machine', async () => {
    await runMemberBarcodeIndex(f.db);
    const worker = service(f.db);
    const result = await worker.execute(actor, { code: VERIFY, items });
    expect(result).toMatchObject({ order_id: 'member-pickup-1', completed: true, status: 2 });
    const rows = await f.db.select().from(storeOrderWriteoff);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.writeoffCode).toBe(VERIFY);
    expect((await f.db.select({ code: storeOrder.verifyCode }).from(storeOrder)
      .where(eq(storeOrder.id, 301)))[0]?.code).toBe('');
  });

  it('accepts an allocated sixteen-digit member barcode through lookup, preview, and write', async () => {
    const code = '1234567890123456';
    await runMemberBarcodeIndex(f.db);
    await f.db.update(user).set({ barCode: code }).where(eq(user.uid, 11));
    const worker = service(f.db);
    expect((await worker.memberSummarySearch(actor, code)).data.map(row => row.id)).toEqual([301]);
    expect((await worker.memberInfo(actor, code, 301)).id).toBe(301);
    expect(await worker.executeMember(actor, { memberCode: code, orderId: 301, items }))
      .toMatchObject({ completed: true, status: 2 });
    expect(await f.db.select().from(storeOrderWriteoff)).toHaveLength(1);
  });

  for (const change of ['barcode', 'inactive', 'deleted_flag', 'deleted_at', 'order_uid'] as const) {
    it(`rebinds after preview and rejects a changed ${change} before any write`, async () => {
      await runMemberBarcodeIndex(f.db);
      const worker = service(f.db);
      expect((await worker.memberInfo(actor, MEMBER, 301)).id).toBe(301);
      if (change === 'barcode') await f.db.update(user).set({ barCode: '5555555555555555' }).where(eq(user.uid, 11));
      if (change === 'inactive') await f.db.update(user).set({ status: 0 }).where(eq(user.uid, 11));
      if (change === 'deleted_flag') await f.db.update(user).set({ isDel: 1 }).where(eq(user.uid, 11));
      if (change === 'deleted_at') await f.db.update(user).set({ deleteTime: new Date() }).where(eq(user.uid, 11));
      if (change === 'order_uid') await f.db.update(storeOrder).set({ uid: 12 }).where(eq(storeOrder.id, 301));
      await expect(worker.executeMember(actor, { memberCode: MEMBER, orderId: 301, items })).rejects.toThrow();
      expect(await f.db.select().from(storeOrderWriteoff)).toEqual([]);
      expect((await f.db.select({ remaining: storeOrderCartInfo.writeSurplusTimes }).from(storeOrderCartInfo)
        .where(eq(storeOrderCartInfo.id, 401)))[0]?.remaining).toBe(1);
    });
  }

  it('serializes two confirmations for the same member/order on independent PostgreSQL backends', async () => {
    await runMemberBarcodeIndex(f.db);
    await withFinancePeers(f.db, async ([holder, first, second]) => {
      await holder.exec('BEGIN; SELECT id FROM public.store_order WHERE id=301 FOR UPDATE');
      let held = true;
      try {
        const a = outcome(service(first.db).executeMember(actor, { memberCode: MEMBER, orderId: 301, items }));
        await waitForFinanceBlock(f.db, first.pid, holder.pid);
        const b = outcome(service(second.db).executeMember(actor, { memberCode: MEMBER, orderId: 301, items }));
        await waitForFinanceBlock(f.db, second.pid, first.pid);
        await holder.exec('COMMIT'); held = false;
        const results = [await a, await b];
        expect(results.filter(result => result.ok)).toHaveLength(1);
        expect(results.filter(result => !result.ok)).toHaveLength(1);
      } finally { if (held) await holder.exec('ROLLBACK'); }
    });
    const rows = await f.db.select().from(storeOrderWriteoff);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.writeoffCode).toBe(VERIFY);
    const [order] = await f.db.select({ status: storeOrder.status, code: storeOrder.verifyCode })
      .from(storeOrder).where(eq(storeOrder.id, 301));
    expect(order).toMatchObject({ status: 2, code: '' });
    const [cart] = await f.db.select({ remaining: storeOrderCartInfo.writeSurplusTimes })
      .from(storeOrderCartInfo).where(eq(storeOrderCartInfo.id, 401));
    expect(cart?.remaining).toBe(0);
  }, 20_000);
});
