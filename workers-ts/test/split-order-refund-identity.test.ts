import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { adminRefundEvidenceFixture } from './helpers/adminRefundEvidenceFixture';
import { orderWaybillJob, storeOrder, storeOrderCartInfo, storeOrderOutbox, userBrokerage } from '../src/models/schema';
import { SupplierFulfillmentService } from '../src/services/supplier/SupplierFulfillmentService';
import { quoteAdminRefundCreation } from '../src/services/admin/AdminRefundCreationQuoteService';
import { applyOrderRefund, finalizeStoreOrderRefund, StoreOrderRefundService } from '../src/services/order/StoreOrderRefundService';
import { reserveOrderCartRowIds } from '../src/services/order/OrderCartIdentity';
import { createContainerFromDb, withTx } from '../src/lib/di';
import { withFinancePeers } from './helpers/financePeers';
import { md5 } from '../src/utils/jwt';
import { WechatPayService } from '../src/services/wechat/WechatPayService';
import { AlipayRefundService } from '../src/services/payment/AlipayRefundService';
import { INVOICE_EVIDENCE_SQL } from '../src/migrations/invoiceEvidence';

let f: Awaited<ReturnType<typeof adminRefundEvidenceFixture>>;
const delivery = { deliveryType: 'express' as const, deliveryName: 'Local synthetic delivery', deliveryCode: 'local-a',
  deliveryId: 'NO-REAL-SHIPMENT', fictitiousContent: '', deliveryUid: 0 };
const actor = () => ({ id: 100, authVersion: md5('synthetic-digest'), expiresAt: Math.floor(Date.now() / 1000) + 3600 });
const fulfillment = () => new SupplierFulfillmentService(f.container, f.env);
const split = () => fulfillment().splitDelivery(0, 1, delivery, [{ cartId: '501', cartNum: 1 }]);
const carts = (oid: number) => f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, oid)).orderBy(storeOrderCartInfo.id);
const sequence = async () => (await f.db.execute<{ last_value: string }>(sql`SELECT last_value::text FROM store_order_cart_info_id_seq`))[0].last_value;
const state = async () => ({ business: await f.snapshot(), applications: await f.applications(), statuses: await f.statuses(),
  carts: await f.db.select().from(storeOrderCartInfo).orderBy(storeOrderCartInfo.id), outbox: await f.db.select().from(storeOrderOutbox).orderBy(storeOrderOutbox.id) });
beforeEach(async () => {
  f = await adminRefundEvidenceFixture(undefined, [orderWaybillJob, userBrokerage]);
  await f.exec(INVOICE_EVIDENCE_SQL);
  await f.db.update(storeOrder).set({ totalNum: 4, totalPrice: '20.00', payPrice: '20.00', cartId: '501' }).where(eq(storeOrder.id, 1));
  await f.db.update(storeOrderCartInfo).set({ cartNum: 4, splitSurplusNum: 4, surplusNum: 4, skuUnique: 'qared001',
    cartInfo: JSON.stringify({ id: '501', cart_num: 4, truePrice: '5.00', sku: { id: 1, price: '5.00' } }) }).where(eq(storeOrderCartInfo.id, 1));
  // This fixture seeds explicit primary keys; initialize only its own sequences
  // before exercising normal production inserts, never repair a runtime DB.
  await f.exec("SELECT setval(pg_get_serial_sequence('store_order','id'),(SELECT max(id) FROM store_order)); SELECT setval(pg_get_serial_sequence('store_order_cart_info','id'),(SELECT max(id) FROM store_order_cart_info)); SELECT setval(pg_get_serial_sequence('store_order_refund','id'),(SELECT max(id) FROM store_order_refund))");
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Unexpected external I/O'));
  for (const gateway of [WechatPayService, AlipayRefundService]) for (const method of ['requestRefund', 'queryRefund'] as const) {
    vi.spyOn(gateway.prototype, method).mockRejectedValue(Error('Unconfigured synthetic provider'));
  }
}, 30000);
afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); } }, 45000);

it.each(['selected', 'remaining'] as const)('a newly split %s child supports actual Admin refund quotation and customer application', async side => {
  const result = await split();
  const oid = side === 'selected' ? result.order_id : result.remaining_order_id!;
  const [order] = await f.db.select().from(storeOrder).where(eq(storeOrder.id, oid));
  const [cart] = await carts(oid);
  const quote = await quoteAdminRefundCreation(f.container, actor(), {
    version: 'admin-refund-creation-quote-v1', orderId: oid, mode: 'remaining', items: [],
  });
  expect(quote).toMatchObject({ quotedPrice: side === 'selected' ? '5.00' : '15.00',
    items: [{ cartId: Number(cart.cartId), cartNum: cart.cartNum }] });
  const input = { uid: 11, orderId: order.orderId, applyType: 1, refundExplain: '',
    refundReason: 'Split child identity acceptance', cartSelections: [{ cartId: Number(cart.cartId), cartNum: 1 }] };
  const application = await applyOrderRefund(f.container, input);
  expect((await carts(oid))[0].refundNum).toBe(1);
  await new StoreOrderRefundService(f.container, f.env).cancelApply(11, application.refundId);
  expect((await carts(oid))[0].refundNum).toBe(0);
  const next = await applyOrderRefund(f.container, input);
  await finalizeStoreOrderRefund(f.container, next.refundId);
  const finalized = await state();
  expect((await carts(oid))[0].refundNum).toBe(1);
  expect(finalized.business.users.find(row => row.uid === 11)?.nowMoney).toBe('5.00');
  expect(finalized.business.orders.find(row => row.id === 1)?.refundPrice).toBe('0.00');
  expect(finalized.business.bills.filter(row => row.type === 'pay_product_refund')).toHaveLength(1);
  expect(await finalizeStoreOrderRefund(f.container, next.refundId)).toBe('already-completed');
  expect(await state()).toEqual(finalized);
});

it('keeps new cart row identity, order list and embedded snapshot in agreement without changing the root identity', async () => {
  const before = (await carts(1))[0], result = await split();
  for (const oid of [result.order_id, result.remaining_order_id!]) {
    const rows = await carts(oid), [order] = await f.db.select().from(storeOrder).where(eq(storeOrder.id, oid));
    expect(order.cartId).toBe(rows.map(row => row.cartId).join(','));
    for (const row of rows) {
      expect(row.cartId).toBe(String(row.id)); expect(row.oldCartId).toBe('501');
      expect(JSON.parse(row.cartInfo!)).toMatchObject({ id: row.cartId, cart_num: row.cartNum, truePrice: '5.00' });
    }
  }
  expect((await carts(1))[0]).toEqual({ ...before, splitStatus: 2, splitSurplusNum: 0 });
});

it('repeated splits retain the remainder row primary key and cart ID, and the new delivered child stays refundable', async () => {
  const first = await split(), [original] = await carts(first.remaining_order_id!);
  const second = await fulfillment().splitDelivery(0, first.remaining_order_id!, delivery, [{ cartId: original.cartId, cartNum: 1 }]);
  expect(second.remaining_order_id).toBe(first.remaining_order_id);
  const [remaining] = await carts(second.remaining_order_id!);
  expect(remaining).toMatchObject({ id: original.id, cartId: original.cartId, oldCartId: '501', cartNum: 2 });
  expect(JSON.parse(remaining.cartInfo!)).toMatchObject({ id: original.cartId, cart_num: 2 });
  for (const oid of [second.order_id, second.remaining_order_id!]) {
    const quote = await quoteAdminRefundCreation(f.container, actor(), { version: 'admin-refund-creation-quote-v1', orderId: oid, mode: 'remaining', items: [] });
    expect(quote.quotedPrice).toBe(oid === second.order_id ? '5.00' : '10.00');
  }
});

it('multiple selected and remaining rows cannot collide with other rows numeric aliases', async () => {
  await f.db.update(storeOrderCartInfo).set({ oid: 1, cartId: '48', cartNum: 2, splitSurplusNum: 2,
    cartInfo: JSON.stringify({ id: '48', cart_num: 2, truePrice: '5.00' }) }).where(eq(storeOrderCartInfo.id, 2));
  await f.db.update(storeOrder).set({ totalNum: 6, totalPrice: '30.00', payPrice: '30.00', cartId: '501,48' }).where(eq(storeOrder.id, 1));
  const result = await fulfillment().splitDelivery(0, 1, delivery, [{ cartId: '501', cartNum: 1 }, { cartId: '48', cartNum: 1 }]);
  const all = [...await carts(result.order_id), ...await carts(result.remaining_order_id!)];
  expect(all).toHaveLength(4); expect(new Set(all.map(row => row.cartId)).size).toBe(4);
  for (const oid of [result.order_id, result.remaining_order_id!]) {
    const rows = await carts(oid);
    const quote = await quoteAdminRefundCreation(f.container, actor(), { version: 'admin-refund-creation-quote-v1', orderId: oid,
      mode: 'items', items: rows.map(row => ({ cartId: Number(row.cartId), cartNum: row.cartNum })) });
    expect(quote.quotedPrice).toBe(oid === result.order_id ? '10.00' : '20.00');
  }
});

it('a committed fulfillment replay creates no rows or additional sequence allocation', async () => {
  const options = { replay: { accountId: 77, requestHash: 'a'.repeat(64), changeType: 'out_order_split_delivery' as const } };
  const first = await fulfillment().splitDelivery(0, 1, delivery, [{ cartId: '501', cartNum: 1 }], options);
  const before = await state(), previousSequence = await sequence();
  expect(await fulfillment().splitDelivery(0, 1, delivery, [{ cartId: '501', cartNum: 1 }], options)).toEqual({ ...first, idempotent: true });
  expect(await state()).toEqual(before); expect(await sequence()).toBe(previousSequence);
});

it('a late audit failure rolls back split rows, parent state and notices but never reuses consumed sequence values', async () => {
  const before = await state(), initialSequence = BigInt(await sequence());
  await f.exec("CREATE FUNCTION split_identity_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic split audit failure'; END $$; CREATE TRIGGER split_identity_fail BEFORE INSERT ON store_order_status FOR EACH ROW EXECUTE FUNCTION split_identity_fail()");
  await expect(split()).rejects.toThrow(); expect(await state()).toEqual(before);
  const failedSequence = BigInt(await sequence()); expect(failedSequence).toBeGreaterThan(initialSequence);
  await f.exec('DROP TRIGGER split_identity_fail ON store_order_status');
  const result = await split();
  for (const row of [...await carts(result.order_id), ...await carts(result.remaining_order_id!)]) expect(BigInt(row.id)).toBeGreaterThan(failedSequence);
});

it('whole-order delivery consumes no new cart identity', async () => {
  const before = await sequence(), [cart] = await carts(1);
  expect(await fulfillment().splitDelivery(0, 1, delivery, [{ cartId: '501', cartNum: 4 }])).toMatchObject({ split: false, order_id: 1 });
  expect(await sequence()).toBe(before); expect(await carts(1)).toEqual([cart]);
});

it.each([0, -1, 1.5, 401])('rejects invalid reservation count %s without consuming a sequence value', async count => {
  const before = await sequence();
  await expect(withTx(f.container, tx => reserveOrderCartRowIds(tx, count))).rejects.toThrow('拆单商品数量无效');
  expect(await sequence()).toBe(before);
});

it('rejects root-client identity reservations before SQL', async () => {
  const before = await sequence();
  await expect(reserveOrderCartRowIds(f.db, 1)).rejects.toThrow('order transaction');
  expect(await sequence()).toBe(before);
});

it('does not guess a sequence when the resolved table lacks an owned sequence', async () => {
  const before = await sequence();
  await f.exec('ALTER SEQUENCE store_order_cart_info_id_seq OWNED BY NONE');
  await expect(withTx(f.container, tx => reserveOrderCartRowIds(tx, 1))).rejects.toThrow('拆单商品标识分配失败');
  expect(await sequence()).toBe(before);
});

it('resolves only the transaction-local table and owned sequence, never another schema default', async () => {
  const before = await sequence();
  await f.exec("CREATE SCHEMA split_identity_shadow; CREATE TABLE split_identity_shadow.store_order_cart_info (id INTEGER PRIMARY KEY); CREATE SEQUENCE split_identity_shadow.cloned_cart_sequence; ALTER SEQUENCE split_identity_shadow.cloned_cart_sequence OWNED BY split_identity_shadow.store_order_cart_info.id; ALTER TABLE split_identity_shadow.store_order_cart_info ALTER COLUMN id SET DEFAULT nextval('split_identity_shadow.cloned_cart_sequence'::regclass)");
  await withTx(f.container, async tx => {
    await tx.execute(sql`SET LOCAL search_path TO split_identity_shadow, pg_temp`);
    expect(await reserveOrderCartRowIds(tx, 2)).toEqual([1, 2]);
  });
  expect(await sequence()).toBe(before);
});

it('supports the bounded maximum of 400 new identities without rounding or duplication', async () => {
  const before = BigInt(await sequence());
  const ids = await withTx(f.container, tx => reserveOrderCartRowIds(tx, 400));
  expect(ids).toHaveLength(400); expect(new Set(ids).size).toBe(400);
  expect(BigInt(Math.min(...ids))).toBe(before + 1n); expect(BigInt(Math.max(...ids))).toBe(before + 400n);
});

it('independent native PostgreSQL transactions and ordinary inserts share the same collision-free sequence', async () => {
  await withFinancePeers(f.db, async ([first, second]) => {
    const [a, b, inserted] = await Promise.all([
      withTx(createContainerFromDb(first.db), tx => reserveOrderCartRowIds(tx, 50)),
      withTx(createContainerFromDb(second.db), tx => reserveOrderCartRowIds(tx, 50)),
      f.db.insert(storeOrderCartInfo).values({ oid: 3, uid: 11, cartId: 'ordinary-insert', cartNum: 1 }).returning({ id: storeOrderCartInfo.id }),
    ]);
    expect(a).toHaveLength(50); expect(b).toHaveLength(50);
    expect(new Set([...a, ...b, inserted[0].id]).size).toBe(101);
  });
});

it.each(['weixin', 'alipay'] as const)('a split child %s refund preserves the original payment total and refund number across UNKNOWN recovery', async payType => {
  await f.db.update(storeOrder).set({ payType, tradeNo: 'synthetic-original-payment' }).where(eq(storeOrder.id, 1));
  const result = await split(), [order] = await f.db.select().from(storeOrder).where(eq(storeOrder.id, result.order_id));
  const [cart] = await carts(order.id);
  const application = await applyOrderRefund(f.container, { uid: 11, orderId: order.orderId, applyType: 1,
    refundReason: 'Synthetic original-channel recovery', refundExplain: '', cartSelections: [{ cartId: Number(cart.cartId), cartNum: 1 }] });
  const gateway = payType === 'weixin' ? WechatPayService : AlipayRefundService;
  const request = vi.mocked(gateway.prototype.requestRefund).mockRejectedValue(Error('Synthetic lost response'));
  const query = vi.mocked(gateway.prototype.queryRefund).mockResolvedValue({ status: 'SUCCESS', providerRefundId: 'synthetic-child-refund' });
  const service = new StoreOrderRefundService(f.container, f.env);
  await expect(service.agreeRefund(application.refundId)).rejects.toThrow('结果未知');
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0][0]).toMatchObject({ outTradeNo: 'local_refund_1', transactionId: 'synthetic-original-payment',
    totalAmount: 2000, refundAmount: 500, outRefundNo: `CNSR${application.refundId}` });
  await expect(service.cancelApply(11, application.refundId)).rejects.toThrow('结果待确认');
  expect((await carts(order.id))[0].refundNum).toBe(1);
  expect(await service.agreeRefund(application.refundId)).toMatchObject({ completed: true });
  expect(query).toHaveBeenCalledTimes(1); expect(query.mock.calls[0][0]).toEqual(request.mock.calls[0][0]);
  expect((await f.snapshot()).users.find(row => row.uid === 11)?.nowMoney).toBe('0.00');
  const settled = await state(); await service.agreeRefund(application.refundId);
  expect(request).toHaveBeenCalledTimes(1); expect(query).toHaveBeenCalledTimes(1); expect(await state()).toEqual(settled);
});

it('a WeChat callback locates the split child through its retained payment association and settles once', async () => {
  await f.db.update(storeOrder).set({ payType: 'weixin', tradeNo: 'synthetic-original-payment' }).where(eq(storeOrder.id, 1));
  const result = await split(), [order] = await f.db.select().from(storeOrder).where(eq(storeOrder.id, result.order_id));
  const application = await applyOrderRefund(f.container, { uid: 11, orderId: order.orderId, applyType: 1,
    refundReason: 'Synthetic child callback', refundExplain: '' });
  vi.mocked(WechatPayService.prototype.requestRefund).mockResolvedValue({ status: 'PROCESSING', providerRefundId: 'synthetic-callback' });
  const service = new StoreOrderRefundService(f.container, f.env);
  expect(await service.agreeRefund(application.refundId)).toEqual({ completed: false, status: 'PROCESSING' });
  const notification = { outTradeNo: 'local_refund_1', transactionId: 'synthetic-original-payment', outRefundNo: `CNSR${application.refundId}`,
    providerRefundId: 'synthetic-callback', status: 'SUCCESS' as const, refundAmount: 500, totalAmount: 2000 };
  await service.handleWechatRefundNotification(notification); const settled = await state();
  await service.handleWechatRefundNotification(notification); expect(await state()).toEqual(settled);
  expect((await carts(order.id))[0].refundNum).toBe(1);
  expect(settled.business.orders.find(row => row.id === order.id)).toMatchObject({ refundStatus: 2, refundPrice: '5.00' });
  expect(settled.business.orders.find(row => row.id === 1)?.refundPrice).toBe('0.00');
});
