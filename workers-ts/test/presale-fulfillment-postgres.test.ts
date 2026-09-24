import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb, withTx } from '@/lib/di';
import type { AppVariables, Env } from '@/env';
import { adminOrderDelivery } from '@/controllers/api/v1/AdminCrudController';
import { assertPresaleDispatchReady, presaleDispatchBoundary } from '@/services/activity/PresaleFulfillmentSnapshot';
import { SupplierFulfillmentService } from '@/services/supplier/SupplierFulfillmentService';
import { OrderWaybillJobService } from '@/services/waybill/OrderWaybillJobService';
import { StoreOrderWriteoffService } from '@/services/order/StoreOrderWriteoffService';
import { expressCompany, memberRight, orderWaybillJob, orderWaybillJobAction, storeConfig, storeOrder, storeOrderCartInfo,
  storeOrderInvoice, storeOrderInvoiceAllocation, storeOrderInvoiceEvidence, storeOrderOutbox,
  storeOrderRefund, storeOrderStatus, storeOrderWriteoff, supplierFlowingWater, systemConfig, systemStore } from '@/models/schema';
import { financePostgres } from './helpers/financePostgres';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';

const terms = (endsAt = 100) => ({ version: 'presale-full-payment-v1', productId: 70,
  startsAt: 0, endsAt, shippingDaysAfterEnd: 7, paidMemberOnly: false, perOrderLimit: null });
const modern = (end = 100) => JSON.stringify({ presale: terms(end), product: { id: 70, storeName: 'Local presale' },
  sku: { price: '10.00', weight: '1.00' }, cart_num: 3, truePrice: '10.00' });
const legacy = (end: unknown = 100) => JSON.stringify({ productInfo: { id: 70, presale_end_time: end,
  presale_start_time: 0, presale_day: 7, is_presale_product: 1 } });
const shipping = { deliveryType: 'express', deliveryName: 'Local', deliveryCode: 'LOCAL',
  deliveryId: 'TEST-NO-SHIPMENT', fictitiousContent: '', deliveryUid: 0 } as const;

describe('presale immutable dispatch evidence', () => {
  it('reads versioned terms and canonical PHP numbers without adding purchase cutoff or shipping days', () => {
    expect(presaleDispatchBoundary(modern(), 70)).toBe(100);
    expect(presaleDispatchBoundary(legacy(), 70)).toBe(100);
    expect(presaleDispatchBoundary(legacy('100'), 70)).toBe(100);
  });
  it.each([null, '', '{}', 'null', '[]', '{', modern().replace('"productId":70', '"productId":71'),
    JSON.stringify({ presale: null, ...JSON.parse(legacy()) }),
    JSON.stringify({ presale: { ...terms(), version: 'future-v2' }, ...JSON.parse(legacy()) }),
    ...['startsAt', 'endsAt', 'shippingDaysAfterEnd', 'paidMemberOnly', 'perOrderLimit'].map(key => {
      const value: Record<string, unknown> = terms(); delete value[key]; return JSON.stringify({ presale: value });
    }),
    ...[null, false, '', ' ', '1e2', '01', '-1', 1.5, -1, 2147483648].map(end => legacy(end)),
    JSON.stringify({ productInfo: { presale_end_time: 100 } }),
    JSON.stringify({ productInfo: { id: 71, presale_end_time: 100 } }),
    JSON.stringify({ presale: { ...terms(), startsAt: 101 } }),
    JSON.stringify({ presale: { ...terms(), paidMemberOnly: 0 } }),
    JSON.stringify({ presale: { ...terms(), perOrderLimit: 0 } }),
    JSON.stringify({ presale: { ...terms(), endsAt: '100' } }),
    JSON.stringify({ presale: terms(), padding: '测'.repeat(22_000) }),
  ])('rejects malformed/missing/foreign/oversized evidence %# without downgrade', raw => {
    expect(() => presaleDispatchBoundary(raw, 70)).toThrow('履约快照缺失或无效');
  });
});

describe('presale manual delivery and waybill SQL entry points', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>;
  const sendBatch = vi.fn(async () => {});
  const env = { ORDER_QUEUE: { sendBatch }, CONFIG_KV: { get: async () => null, put: async () => {} },
    CRMEB_ONEPASS_ACCESS_KEY: 'local-test-only', CRMEB_ONEPASS_SECRET_KEY: 'local-test-only' } as unknown as Env;
  const actor = { actorType: 'admin', actorId: 1 } as const;
  const supplier = (db = f.db) => new SupplierFulfillmentService(createContainerFromDb(db), env);
  const waybill = () => new OrderWaybillJobService(createContainerFromDb(f.db), env);
  const pickup = (db = f.db) => new StoreOrderWriteoffService(createContainerFromDb(db), env)
    .execute({ kind: 'admin', adminId: 1 }, { code: '123456789012', items: [{ orderCartId: 1, quantity: 1 }] });
  const preparePickup = async () => {
    await f.db.insert(systemStore).values({ id: 9, name: 'Local pickup', isStore: 1, isShow: 1 });
    await f.db.update(storeOrder).set({ shippingType: 2, storeId: 9, verifyCode: '123456789012' });
    await f.db.update(storeOrderCartInfo).set({ writeTimes: 3, writeSurplusTimes: 3 });
  };
  const state = async () => ({ orders: await f.db.select().from(storeOrder).orderBy(storeOrder.id),
    carts: await f.db.select().from(storeOrderCartInfo).orderBy(storeOrderCartInfo.id),
    statuses: await f.db.select().from(storeOrderStatus).orderBy(storeOrderStatus.id),
    outbox: await f.db.select().from(storeOrderOutbox).orderBy(storeOrderOutbox.id),
    jobs: await f.db.select().from(orderWaybillJob).orderBy(orderWaybillJob.id),
    writeoffs: await f.db.select().from(storeOrderWriteoff).orderBy(storeOrderWriteoff.id) });
  const setSnapshot = (cartInfo: string | null) => f.db.update(storeOrderCartInfo).set({ cartInfo }).where(eq(storeOrderCartInfo.id, 1));
  const guard = (db = f.db) => withTx(createContainerFromDb(db), async tx => {
    const [order] = await tx.select().from(storeOrder).where(eq(storeOrder.id, 1)).for('update');
    await assertPresaleDispatchReady(tx, order);
  });
  const admin = async (db = f.db, body: Record<string, unknown> = {}) => {
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    // Synthetic authorized context, not production JWT/permission acceptance.
    app.use('*', async (c, next) => { c.set('container', createContainerFromDb(db)); await next(); });
    app.onError((error, c) => c.json({ error: error.message }, 400));
    app.post('/delivery/:orderId', adminOrderDelivery);
    return app.request('/delivery/PRESALE-LOCAL', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delivery_type: 'express', delivery_name: 'Local', delivery_id: 'TEST-NO-SHIPMENT', ...body }) }, env);
  };
  beforeAll(async () => {
    f = await financePostgres([storeOrder, storeOrderCartInfo, storeOrderStatus, storeOrderRefund, storeOrderOutbox,
      orderWaybillJob, orderWaybillJobAction, expressCompany, systemConfig, storeConfig,
      storeOrderInvoice, storeOrderInvoiceEvidence, storeOrderInvoiceAllocation, supplierFlowingWater, systemStore, storeOrderWriteoff, memberRight]);
    await f.exec('CREATE UNIQUE INDEX test_presale_notice_key ON store_order_outbox(event_key)');
  }, 30_000);
  afterAll(async () => { await f?.close(); });
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External requests forbidden'));
    // Isolate the provider's credential-keyed login cache between synthetic cases.
    env.CRMEB_ONEPASS_ACCESS_KEY = `local-test-${crypto.randomUUID()}`;
    sendBatch.mockClear();
    await f.reset();
    await f.db.insert(storeOrder).values({ orderId: 'PRESALE-LOCAL', uid: 11, type: 6, paid: 1,
      supplierId: 7, shippingType: 1, totalNum: 3, totalPrice: '30.00', payPrice: '30.00',
      realName: 'Local test', userPhone: '13000000000', userAddress: 'Local fixture', payType: 'yue' });
    await f.db.insert(storeOrderCartInfo).values({ oid: 1, uid: 11, productId: 70, cartId: '1',
      cartNum: 3, splitSurplusNum: 3, surplusNum: 3, cartInfo: modern(), settlePrice: '2.00' });
    await f.db.insert(supplierFlowingWater).values({ supplierId: 7, uid: 11, orderId: 'LOCAL-FLOW',
      linkId: 'PRESALE-LOCAL', type: 1, pm: 1, status: 0, number: '6.00', payType: 'yue', payPrice: '30.00', totalPrice: '30.00' });
    await f.db.insert(expressCompany).values({ id: 1, name: 'Local', code: 'LOCAL', isShow: 1, status: 1 });
    await f.db.insert(systemConfig).values(Object.entries({ config_export_open: '1', config_export_id: '1',
      config_export_temp_id: 'LOCAL-TEMPLATE', config_export_to_name: 'Local sender',
      config_export_to_tel: '13000000001', config_export_to_address: 'Local sender fixture' })
      .map(([menuName, value]) => ({ menuName, value, isStore: 0 })));
  });
  afterEach(() => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); } });

  it.each(['admin', 'supplier', 'split', 'waybill'] as const)('rejects future terms before %s writes/queue/provider', async route => {
    await setSnapshot(modern(2_147_483_647));
    const before = await state();
    if (route === 'admin') expect(await (await admin()).json()).toMatchObject({ error: '预售活动尚未结束，不能发货' });
    else if (route === 'supplier') await expect(supplier().deliver(7, 1, shipping)).rejects.toThrow('预售活动尚未结束');
    else if (route === 'split') await expect(supplier().splitDelivery(7, 1, shipping, [{ cartId: '1', cartNum: 1 }])).rejects.toThrow('预售活动尚未结束');
    else await expect(waybill().create('1', actor, { request_key: crypto.randomUUID() })).rejects.toThrow('预售活动尚未结束');
    expect(await state()).toEqual(before); expect(sendBatch).not.toHaveBeenCalled();
  });
  it.each(['admin', 'supplier', 'split', 'waybill'] as const)('rejects missing proof before %s mutation', async route => {
    await setSnapshot('{}'); const before = await state();
    if (route === 'admin') expect(await (await admin()).json()).toMatchObject({ error: expect.stringContaining('履约快照缺失或无效') });
    else if (route === 'supplier') await expect(supplier().deliver(7, 1, shipping)).rejects.toThrow('履约快照缺失或无效');
    else if (route === 'split') await expect(supplier().splitDelivery(7, 1, shipping, [{ cartId: '1', cartNum: 1 }])).rejects.toThrow('履约快照缺失或无效');
    else await expect(waybill().create('1', actor, { request_key: crypto.randomUUID() })).rejects.toThrow('履约快照缺失或无效');
    expect(await state()).toEqual(before); expect(sendBatch).not.toHaveBeenCalled();
  });
  it.each(['admin', 'supplier'] as const)('delivers ended immutable terms through %s and retains existing replay/state rules', async route => {
    const snapshot = modern();
    if (route === 'admin') {
      expect((await admin()).status).toBe(200);
      const before = await state(); expect((await admin()).status).toBe(400); expect(await state()).toEqual(before);
    } else {
      const replay = { accountId: 1, requestHash: 'a'.repeat(64), changeType: 'out_order_delivery' } as const;
      expect(await supplier().deliver(7, 1, shipping, { replay })).toMatchObject({ idempotent: false });
      const before = await state();
      expect(await supplier().deliver(7, 1, shipping, { replay })).toMatchObject({ idempotent: true });
      expect(await state()).toEqual(before);
    }
    const after = await state(); expect(after.orders[0].status).toBe(1); expect(after.outbox).toHaveLength(1);
    expect(after.carts[0].cartInfo).toBe(snapshot);
  });
  it('supports evidence-bearing PHP snapshots but never requires a current product row', async () => {
    // Deliberately no store_product table in this fixture.
    await setSnapshot(legacy('100'));
    expect(await supplier().deliver(7, 1, shipping)).toMatchObject({ order_id: 1 });
  });
  it.each(['future', 'missing'] as const)('rejects %s pickup evidence without counters/code/writeoff changes', async kind => {
    await preparePickup(); await setSnapshot(kind === 'future' ? modern(2_147_483_647) : '{}');
    const before = await state();
    await expect(pickup()).rejects.toThrow(kind === 'future' ? '预售活动尚未结束，不能核销' : '履约快照缺失或无效');
    expect(await state()).toEqual(before);
  });
  it('allows partial pickup after end and preserves the immutable contract while rotating the code', async () => {
    await preparePickup();
    expect(await pickup()).toMatchObject({ completed: false, status: 5 });
    const after = await state();
    expect(after.carts[0]).toMatchObject({ writeSurplusTimes: 2, cartInfo: modern() });
    expect(after.writeoffs).toHaveLength(1);
    expect(after.orders[0].verifyCode).toMatch(/^\d{12}$/);
    expect(after.orders[0].verifyCode).not.toBe('123456789012');
    await expect(pickup()).rejects.toThrow('核销订单不存在');
    expect(await state()).toEqual(after);
  });
  it('applies the same existing manual gate to fictitious delivery, without changing automatic delivery policy', async () => {
    await f.db.update(storeOrder).set({ productType: 3 }); await setSnapshot(modern(2_147_483_647));
    const body = { delivery_type: 'fictitious', fictitious_content: 'Local manual fixture' };
    expect(await (await admin(f.db, body)).json()).toMatchObject({ error: expect.stringContaining('尚未结束') });
    expect((await state()).outbox).toHaveLength(0);
    await setSnapshot(modern()); expect((await admin(f.db, body)).status).toBe(200);
    expect((await state()).orders[0]).toMatchObject({ status: 1, deliveryType: 'fictitious' });
  });
  it('preserves the new contract across two actual supplier splits and remaining-order delivery', async () => {
    const first = await supplier().splitDelivery(7, 1, shipping, [{ cartId: '1', cartNum: 1 }]);
    const remaining = (await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, first.remaining_order_id!)))[0];
    const second = await supplier().splitDelivery(7, first.remaining_order_id!, shipping, [{ cartId: remaining.cartId, cartNum: 1 }]);
    await supplier().deliver(7, second.remaining_order_id!, shipping);
    const after = await state();
    expect(after.orders.filter(row => row.pid === 1).map(row => row.status)).toEqual([1, 1, 1]);
    expect(after.outbox).toHaveLength(3);
    for (const row of after.carts) expect(JSON.parse(row.cartInfo!).presale).toEqual(terms());
  });
  it('keeps ordinary delivery, unpaid, pickup and supplier scope policies unchanged', async () => {
    await f.db.update(storeOrder).set({ type: 0 }); await setSnapshot('{}');
    expect((await admin()).status).toBe(200);
    await f.db.update(storeOrder).set({ status: 0, type: 6, paid: 0 });
    await expect(supplier().deliver(7, 1, shipping)).rejects.toThrow('订单未支付');
    await f.db.update(storeOrder).set({ paid: 1, shippingType: 2 });
    expect(await (await admin()).json()).toMatchObject({ error: expect.stringContaining('自提订单不能发货') });
    await expect(supplier().deliver(8, 1, shipping)).rejects.toThrow('不属于当前供应商');
  });
  it.each(['empty', 'too_many', 'oversized', 'second_future'] as const)('rejects %s order evidence as a whole', async kind => {
    if (kind === 'empty') await f.db.delete(storeOrderCartInfo);
    else if (kind === 'oversized') await setSnapshot(JSON.stringify({ presale: terms(), padding: '测'.repeat(22_000) }));
    else await f.db.insert(storeOrderCartInfo).values(Array.from({ length: kind === 'too_many' ? 200 : 1 }, (_, i) => ({
      oid: 1, productId: 70, cartId: String(i + 2), cartInfo: kind === 'second_future' ? legacy(2_147_483_647) : modern() })));
    const before = await state(); await expect(guard()).rejects.toThrow(kind === 'second_future' ? '尚未结束' : '履约快照');
    expect(await state()).toEqual(before);
  });
  // PGlite's host clock is JavaScript Date.now; only independent PostgreSQL can prove clock separation.
  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('uses DB time even if the application clock falsely reports that the activity has ended', async () => {
    await setSnapshot(modern(2_147_483_640)); vi.spyOn(Date, 'now').mockReturnValue(2_147_483_647_000);
    await expect(guard()).rejects.toThrow('尚未结束');
  });
  it('allows dispatch at the beginning of the database end second, without adding the seven shipping days', async () => {
    await f.exec("UPDATE store_order_cart_info SET cart_info=jsonb_set(cart_info::jsonb,'{presale,endsAt}',to_jsonb(floor(extract(epoch from clock_timestamp()))::integer))::text");
    await expect(guard()).resolves.toBeUndefined();
  });
  it('rolls back completed admin writes when the durable notice insert fails', async () => {
    await f.exec('ALTER TABLE store_order_outbox ADD CONSTRAINT test_presale_notice_failure CHECK (aggregate_id <> 1)');
    try { const before = await state(); expect((await admin()).status).toBe(400); expect(await state()).toEqual(before); }
    finally { await f.exec('ALTER TABLE store_order_outbox DROP CONSTRAINT test_presale_notice_failure'); }
  });
  it.each(['future', 'missing'] as const)('rechecks an older queued job with %s terms before any provider call', async kind => {
    const result = await waybill().create('1', actor, { request_key: crypto.randomUUID() });
    expect(sendBatch).toHaveBeenCalledTimes(1);
    await setSnapshot(kind === 'future' ? modern(2_147_483_647) : '{}');
    const provider = vi.fn();
    expect(await waybill().processMessage({ action: 'processOrderWaybillJob', waybillJobId: result.job.id,
      eventKey: result.job.event_key }, provider as unknown as typeof fetch)).toBe('dead');
    expect(provider).not.toHaveBeenCalled();
    const after = await state(); expect(after.orders[0].status).toBe(0); expect(after.outbox).toHaveLength(0);
    expect(after.jobs[0]).toMatchObject({ status: 'DEAD', trackingNumber: '', lastError: expect.stringContaining('pre_issue:') });
  });
  it('allocates a simulated provider number only after end, applies shipping, and never reallocates on replay', async () => {
    const key = crypto.randomUUID(), service = waybill();
    const result = await service.create('1', actor, { request_key: key });
    const provider = vi.fn(async (input: URL | RequestInfo) => String(input).endsWith('/v2/user/login')
      ? Response.json({ status: 200, data: { access_token: 'local-token' } })
      : Response.json({ status: 200, data: { kuaidinum: 'LOCAL-123', label: 'https://example.invalid/local-label' } }));
    const message = { action: 'processOrderWaybillJob', waybillJobId: result.job.id, eventKey: result.job.event_key } as const;
    expect(await service.processMessage(message, provider as typeof fetch)).toBe('sent');
    expect(provider).toHaveBeenCalledTimes(2);
    expect(await service.processMessage(message, provider as typeof fetch)).toBe('already-sent');
    expect((await service.create('1', actor, { request_key: key })).duplicate).toBe(true);
    expect(provider).toHaveBeenCalledTimes(2);
    expect((await state()).orders[0]).toMatchObject({ status: 1, deliveryId: 'LOCAL-123' });
  });
  it('retains the allocated number as UNKNOWN if proof changes during external I/O; replay never issues twice', async () => {
    const service = waybill(), result = await service.create('1', actor, { request_key: crypto.randomUUID() });
    const provider = vi.fn(async (input: URL | RequestInfo) => {
      if (String(input).endsWith('/v2/user/login')) return Response.json({ status: 200, data: { access_token: 'local-token' } });
      await setSnapshot('{}');
      return Response.json({ status: 200, data: { kuaidinum: 'LOCAL-EXISTING', label: '' } });
    });
    const message = { action: 'processOrderWaybillJob', waybillJobId: result.job.id, eventKey: result.job.event_key } as const;
    expect(await service.processMessage(message, provider as typeof fetch)).toBe('unknown');
    const after = await state();
    expect(after.jobs[0]).toMatchObject({ status: 'UNKNOWN', trackingNumber: 'LOCAL-EXISTING' });
    expect(after.orders[0].status).toBe(0); expect(after.outbox).toHaveLength(0);
    expect(await service.processMessage(message, provider as typeof fetch)).toBe('unknown');
    expect(provider).toHaveBeenCalledTimes(2);
    await expect(service.applyExisting(result.job.id, actor, { requestKey: crypto.randomUUID(), reason: 'Local operator verification' }))
      .rejects.toThrow('履约快照缺失或无效');
    expect(await state()).toEqual(after);
  });

  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('rejects an already-writing cart editor with NOWAIT and rolls back delivery', async () => {
    const before = await state();
    await withFinancePeers(f.db, async ([editor, writer]) => {
      await editor.exec("BEGIN; UPDATE store_order_cart_info SET cart_info='{}' WHERE id=1");
      expect(await outcome(supplier(writer.db).deliver(7, 1, shipping))).toMatchObject({ ok: false,
        error: { message: expect.stringContaining('履约快照正在更新') } });
      await editor.exec('ROLLBACK');
    });
    expect(await state()).toEqual(before);
  }, 15_000);
  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('rejects a pickup concurrent snapshot writer without changing redemption evidence', async () => {
    await preparePickup(); const before = await state();
    await withFinancePeers(f.db, async ([editor, writer]) => {
      await editor.exec("BEGIN; UPDATE store_order_cart_info SET cart_info='{}' WHERE id=1");
      expect(await outcome(pickup(writer.db))).toMatchObject({ ok: false,
        error: { message: expect.stringContaining('履约快照正在更新') } });
      await editor.exec('ROLLBACK');
    });
    expect(await state()).toEqual(before);
  }, 15_000);
  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('protects snapshot non-key fields until the shipping transaction commits', async () => {
    await withFinancePeers(f.db, async ([holder, writer, editor]) => {
      await holder.exec('BEGIN; SELECT pg_advisory_xact_lock(731645,1)');
      const delivery = outcome(withTx(createContainerFromDb(writer.db), async tx => {
        const result = await supplier(tx).deliver(7, 1, shipping);
        await tx.execute(sql`SELECT pg_advisory_xact_lock(731645,1)`); return result;
      }));
      await waitForFinanceBlock(f.db, writer.pid, holder.pid);
      const editing = outcome(editor.exec("UPDATE store_order_cart_info SET cart_info='{}' WHERE id=1"));
      await waitForFinanceBlock(f.db, editor.pid, writer.pid);
      await holder.exec('COMMIT');
      expect(await delivery).toMatchObject({ ok: true }); expect(await editing).toMatchObject({ ok: true });
    });
    expect((await state()).orders[0].status).toBe(1);
  }, 15_000);
});
