import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { createContainerFromDb, withTx, type DbClient } from '@/lib/di';
import { storeOrder, storeOrderCartInfo, storeOrderOutbox, storeOrderStatus, storeProductVirtual,
  storeOrderRefund, storeOrderRefundSplit, storeOrderFulfillmentBranch, storeOrderInvoice,
  storeProductCoupon, printDocument, user } from '@/models/schema';
import { enqueueOrderPaidEvent, OrderOutboxService, isPresaleDeliveryOutboxMessage } from '@/services/order/OrderOutboxService';
import { enqueuePresaleDeliveryIntent } from '@/services/activity/PresaleDeliveryIntent';
import { deliverPaidVirtualOrders } from '@/services/order/VirtualProductDeliveryService';
import { consumePresaleDeliveryOutboxQueueMessage } from '@/services/order/OrderPaidOutboxQueueConsumer';
import { prepareOrderQueueDeadLetter } from '@/services/order/OrderQueueDeadLetterService';
import { refundOrderSplitFingerprint } from '@/services/order/RefundOrderSplitIdentity';
import { reserveRefundQuantities, MATERIALIZED_REFUND_VERSION } from '@/services/order/RefundQuantityReservation';
import { financePostgres } from './helpers/financePostgres';
import { outcome, withFinancePeers } from './helpers/financePeers';
import type { OrderMessage } from '@/env';

const native = Boolean(process.env.TEST_FINANCE_POSTGRES_URL);
const snapshot = (end: number, disk = '') => JSON.stringify({ presale: {
  version: 'presale-full-payment-v1', productId: 70, startsAt: 0, endsAt: end,
  shippingDaysAfterEnd: 7, paidMemberOnly: false, perOrderLimit: null }, sku: { disk_info: disk } });

describe('registered presale payment -> durable Queue -> delivery transaction', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>;
  const queue = { sendBatch: vi.fn(async () => ({ successful: 1 })), send: vi.fn() };
  const service = (db = f.db) => new OrderOutboxService(createContainerFromDb(db), { ORDER_QUEUE: queue as unknown as Queue<OrderMessage> });
  const tx = <T>(fn: (db: DbClient) => Promise<T>) => withTx(createContainerFromDb(f.db), fn);
  const event = async () => {
    const created = await tx(db => enqueuePresaleDeliveryIntent(db, { id: 1, orderId: 'LOCAL-PRESALE' }, 1));
    return { action: 'processPresaleDeliveryOutbox' as const, outboxId: created.id, eventKey: created.eventKey };
  };
  const effects = async () => ({ orders: await f.db.select().from(storeOrder).orderBy(storeOrder.id),
    cards: await f.db.select().from(storeProductVirtual).orderBy(storeProductVirtual.id),
    logs: await f.db.select().from(storeOrderStatus).orderBy(storeOrderStatus.id),
    events: await f.db.select().from(storeOrderOutbox).orderBy(storeOrderOutbox.id), users: await f.db.select().from(user) });
  beforeAll(async () => {
    f = await financePostgres([storeOrder, storeOrderCartInfo, storeOrderOutbox, storeOrderStatus, storeProductVirtual,
      storeOrderRefund, storeOrderRefundSplit, storeOrderFulfillmentBranch, storeOrderInvoice, storeProductCoupon, printDocument, user]);
    await f.exec('CREATE UNIQUE INDEX soob_event_key_uq ON store_order_outbox(event_key)');
    const check = getTableConfig(storeOrderOutbox).checks.find(c => c.name === 'soob_event_type_ck')!;
    await f.exec(`ALTER TABLE store_order_outbox ADD CONSTRAINT soob_event_type_ck CHECK (${new PgDialect().sqlToQuery(check.value).sql})`);
  });
  afterAll(async () => { await f?.close(); });
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External requests forbidden'));
    queue.sendBatch.mockClear(); await f.reset();
    await f.db.insert(user).values({ uid: 11, account: 'local-presale-test' });
    await f.db.insert(storeOrder).values({ orderId: 'LOCAL-PRESALE', uid: 11, type: 6, productType: 1,
      paid: 1, totalNum: 3, supplierAllocationStatus: 2, payType: 'offline', payTime: 100,
      payPrice: '30.00', totalPrice: '30.00' });
    await f.db.insert(storeOrderCartInfo).values({ oid: 1, uid: 11, productId: 70, productType: 1, type: 1,
      skuUnique: 'presale1', cartId: '1', cartNum: 3, cartInfo: snapshot(100) });
    await f.db.insert(storeProductVirtual).values([1, 2, 3].map(n => ({ productId: 70, attrUnique: 'presale1', cardNo: `LOCAL-${n}`, cardPwd: `LOCAL-SECRET-${n}` })));
  });
  afterEach(() => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); } });

  it('finishes actual payment effects once while all presale cards remain unassigned', async () => {
    await f.db.update(storeOrderCartInfo).set({ cartInfo: snapshot(2_147_483_647) });
    const paid = await tx(db => enqueueOrderPaidEvent(db, { id: 1, orderId: 'LOCAL-PRESALE' }));
    const message = { action: 'processOrderPaidOutbox' as const, outboxId: paid.id, eventKey: paid.eventKey };
    expect(await service().processMessage(message)).toBe('completed');
    const before = await effects();
    expect(before.users[0].payCount).toBe(1);
    expect(before.logs.filter(log => log.changeType === 'pay_success')).toHaveLength(1);
    expect(before.cards.every(card => card.uid === 0)).toBe(true);
    expect(before.orders[0].status).toBe(0);
    expect(before.events).toEqual(expect.arrayContaining([expect.objectContaining({ eventType: 'order.presale.fulfillment',
      status: 'PENDING', availableTime: 2_147_483_647, attemptCount: 0 })]));
    expect(await service().processMessage(message)).toBe('already-completed');
    expect(await effects()).toEqual(before); expect(queue.sendBatch).not.toHaveBeenCalled();
  });
  it('does not delay physical-presale payment facts while manual fulfillment remains pending', async () => {
    await f.db.update(storeOrder).set({ productType: 0 });
    await f.db.update(storeOrderCartInfo).set({ productType: 0, cartInfo: snapshot(2_147_483_647) });
    const paid = await tx(db => enqueueOrderPaidEvent(db, { id: 1, orderId: 'LOCAL-PRESALE' }));
    const message = { action: 'processOrderPaidOutbox' as const, outboxId: paid.id, eventKey: paid.eventKey };
    expect(await service().processMessage(message)).toBe('completed');
    const before = await effects();
    expect(before.users[0].payCount).toBe(1);
    expect(before.logs.filter(log => log.changeType === 'pay_success')).toHaveLength(1);
    expect(before.orders[0].status).toBe(0);
    expect(before.cards.every(card => card.uid === 0)).toBe(true);
    expect(before.events).toHaveLength(1);
    expect(before.events[0]).toMatchObject({ eventType: 'order.paid', status: 'COMPLETED' });
    expect(await service().processMessage(message)).toBe('already-completed');
    expect(await effects()).toEqual(before);
  });
  it('dispatches reference-only messages and atomically delivers exactly once', async () => {
    const message = await event();
    expect(await service().dispatchPending()).toEqual({ claimed: 1, enqueued: 1 });
    expect(queue.sendBatch).toHaveBeenCalledWith([{ body: message, contentType: 'json' }]);
    expect(await service().processMessage(message)).toBe('completed');
    const before = await effects();
    expect(before.cards.every(card => card.uid === 11 && card.orderId === 'LOCAL-PRESALE')).toBe(true);
    expect(before.orders[0].status).toBe(1);
    expect(before.logs.filter(log => log.changeType === 'delivery_fictitious')).toHaveLength(1);
    expect(before.events.filter(e => e.eventType === 'order.delivery.notice')).toHaveLength(1);
    expect(before.events.find(e => e.id === message.outboxId)?.status).toBe('COMPLETED');
    expect(await service().processMessage(message)).toBe('already-completed'); expect(await effects()).toEqual(before);
  });
  it('ACKs early messages and replay without consuming attempts or assigning secrets', async () => {
    await f.db.update(storeOrderCartInfo).set({ cartInfo: snapshot(2_147_483_647) });
    const message = await event(); await service().replay(message.outboxId);
    for (let n = 0; n < 12; n++) {
      const ack = vi.fn(), retry = vi.fn();
      await consumePresaleDeliveryOutboxQueueMessage({ body: message, attempts: 4, ack, retry }, service());
      expect(ack).toHaveBeenCalledOnce(); expect(retry).not.toHaveBeenCalled();
    }
    const state = await effects();
    expect(state.events[0]).toMatchObject({ status: 'PENDING', availableTime: 2_147_483_647, attemptCount: 0 });
    expect(state.cards.every(card => card.uid === 0)).toBe(true);
  });
  it('waits for a pending refund without burning failures; cancellation allows the full original quantity', async () => {
    const message = await event();
    const [refund] = await f.db.insert(storeOrderRefund).values({ storeOrderId: 1, uid: 11, orderId: 'LOCAL-REFUND', refundType: 1 }).returning();
    await f.db.update(storeOrderCartInfo).set({ refundNum: 1 });
    for (let n = 0; n < 10; n++) {
      await f.db.update(storeOrderOutbox).set({ availableTime: 0 });
      expect(await service().processMessage(message)).toBe('deferred');
    }
    expect((await effects()).events[0].attemptCount).toBe(0);
    await f.db.update(storeOrderRefund).set({ isCancel: 1 }).where(eq(storeOrderRefund.id, refund.id));
    await f.db.update(storeOrderCartInfo).set({ refundNum: 0 });
    await f.db.update(storeOrderOutbox).set({ availableTime: 0 });
    expect(await service().processMessage(message)).toBe('completed');
    expect((await effects()).cards.filter(card => card.uid === 11)).toHaveLength(3);
  });
  it('rolls back cards, order, notice and receipt if the final completion SQL fails', async () => {
    const message = await event();
    await f.exec("ALTER TABLE store_order_outbox ADD CONSTRAINT presale_test_completion_failure CHECK (status <> 'COMPLETED')");
    try {
      await expect(service().processMessage(message)).rejects.toThrow();
      const state = await effects(); expect(state.cards.every(card => card.uid === 0)).toBe(true);
      expect(state.orders[0].status).toBe(0); expect(state.logs).toEqual([]);
      expect(state.events).toHaveLength(1); expect(state.events[0]).toMatchObject({ status: 'FAILED', attemptCount: 1 });
    } finally { await f.exec('ALTER TABLE store_order_outbox DROP CONSTRAINT presale_test_completion_failure'); }
    await f.db.update(storeOrderOutbox).set({ availableTime: 0 });
    expect(await service().processMessage(message)).toBe('completed');
  });
  it.each([{ uid: 12 }, { supplierId: 7 }, { storeId: 9 }, { totalNum: 2 }, { pid: -1 }, { refundStatus: 2 }])
    ('refuses changed order identity/state without allocating cards %#', async patch => {
      const message = await event(); await f.db.update(storeOrder).set(patch);
      await expect(service().processMessage(message)).rejects.toThrow();
      expect((await effects()).cards.every(card => card.uid === 0)).toBe(true);
    });
  it.each([{ cartNum: 2 }, { refundNum: 1 }, { skuUnique: 'other' }, { cartInfo: snapshot(101) }, { cartInfo: snapshot(100, 'changed-secret') }])
    ('refuses changed line evidence %#', async patch => {
      const message = await event(); await f.db.update(storeOrderCartInfo).set(patch);
      await expect(service().processMessage(message)).rejects.toThrow(); expect((await effects()).cards.every(card => card.uid === 0)).toBe(true);
    });
  it('also gates direct automatic delivery calls by the persisted presale boundary', async () => {
    await f.db.update(storeOrderCartInfo).set({ cartInfo: snapshot(2_147_483_647) });
    const [order] = await f.db.select().from(storeOrder);
    await expect(tx(db => deliverPaidVirtualOrders(db, [order], 2_147_483_647))).rejects.toThrow('预售活动尚未结束');
    expect((await effects()).cards.every(card => card.uid === 0)).toBe(true);
  });

  // Explicit synthetic ledger evidence: exercises the real generation resolver,
  // not the refund-money execution or its separately tested maintenance triggers.
  async function refundGeneration(sourceId: number, cartRowId: number, quantity: number, previous = 0, whole = false) {
    const [source] = await f.db.select().from(storeOrder).where(eq(storeOrder.id, sourceId));
    const [cart] = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.id, cartRowId));
    const claim = await tx(db => reserveRefundQuantities(db, source, [{ cartId: Number(cart.cartId), cartNum: quantity }], MATERIALIZED_REFUND_VERSION));
    const [refund] = await f.db.insert(storeOrderRefund).values({ storeOrderId: sourceId, uid: 11, orderId: `LOCAL-REFUND-${previous + 1}`,
      refundPrice: '10.00', refundedPrice: '10.00', refundNum: quantity, refundType: 6, cartInfo: claim }).returning();
    let remainingOrderId: number | null = null, remainingRowId: number | null = null, selectedOrderId = sourceId, selectedRowId = cartRowId;
    if (whole) {
      await f.db.update(storeOrder).set({ refundStatus: 2, refundType: 6 }).where(eq(storeOrder.id, sourceId));
      await f.db.update(storeOrderCartInfo).set({ refundNum: 0 }).where(eq(storeOrderCartInfo.id, cartRowId));
    } else {
      const [selected] = await f.db.insert(storeOrder).values({ ...source, id: undefined, orderId: `LOCAL-SELECTED-${refund.id}`, pid: 1, totalNum: quantity,
        refundStatus: 2, refundType: 6 }).returning(); selectedOrderId = selected.id;
      if (source.pid === 0) {
        const [remaining] = await f.db.insert(storeOrder).values({ ...source, id: undefined, orderId: `LOCAL-REMAINING-${refund.id}`, pid: 1,
          totalNum: cart.cartNum - quantity }).returning(); remainingOrderId = remaining.id;
        await f.db.update(storeOrder).set({ pid: -1 }).where(eq(storeOrder.id, sourceId));
        const [remainingCart] = await f.db.insert(storeOrderCartInfo).values({ ...cart, id: undefined, oid: remaining.id, cartId: '2',
          cartNum: cart.cartNum - quantity, refundNum: 0 }).returning(); remainingRowId = remainingCart.id;
        await f.db.update(storeOrderCartInfo).set({ cartId: String(remainingRowId) }).where(eq(storeOrderCartInfo.id, remainingRowId));
      } else {
        remainingOrderId = sourceId; remainingRowId = cartRowId;
        await f.db.update(storeOrder).set({ totalNum: cart.cartNum - quantity }).where(eq(storeOrder.id, sourceId));
      }
      await f.db.update(storeOrderCartInfo).set({ cartNum: cart.cartNum - quantity, refundNum: 0,
        cartInfo: JSON.stringify({ ...JSON.parse(cart.cartInfo!), financial_version: 'refund-order-line-finance-v1',
          refund_order_generation: { refundId: refund.id, role: 'remaining' } }),
      }).where(eq(storeOrderCartInfo.id, remainingRowId));
      const [selectedCart] = await f.db.insert(storeOrderCartInfo).values({ ...cart, id: undefined, oid: selectedOrderId,
        cartNum: quantity, refundNum: quantity, cartInfo: JSON.stringify({ ...JSON.parse(cart.cartInfo!),
          financial_version: 'refund-order-line-finance-v1', refund_order_generation: { refundId: refund.id, role: 'selected' } }),
      }).returning();
      selectedRowId = selectedCart.id;
      await f.db.update(storeOrderCartInfo).set({ cartId: String(selectedRowId) }).where(eq(storeOrderCartInfo.id, selectedRowId));
    }
    await f.db.insert(storeOrderRefundSplit).values({ refundId: refund.id, fingerprint: await refundOrderSplitFingerprint(refund),
      uid: 11, supplierId: 0, storeId: 0, sourceOrderId: sourceId, paymentOrderId: 1, selectedOrderId, remainingOrderId,
      disposition: whole ? 'whole' : 'split', previousRefundId: previous, baseBranchId: null, returnedPointBillIds: '[]', earnedIncomeScope: 'null',
      sourceSnapshot: '{}', partitions: JSON.stringify([{ sourceRowId: cartRowId, sourceCartId: cart.cartId,
        selectedRowId, remainingRowId, selectedNum: quantity, remainingNum: cart.cartNum - quantity }]), addTime: 100 });
    return { refundId: refund.id, remainingOrderId: remainingOrderId!, remainingRowId: remainingRowId! };
  }
  it('follows two proven refund generations and delivers only the final remaining unit', async () => {
    const message = await event(); const first = await refundGeneration(1, 1, 1);
    await refundGeneration(first.remainingOrderId, first.remainingRowId, 1, first.refundId);
    expect(await service().processMessage(message)).toBe('completed');
    const state = await effects(); expect(state.cards.filter(card => card.uid === 11)).toHaveLength(1);
    expect(state.orders.filter(order => order.status === 1).map(order => order.id)).toEqual([first.remainingOrderId]);
    expect(state.orders[0].pid).toBe(-1);
  });
  async function remainingEvent(orderId: number) {
    const [order] = await f.db.select().from(storeOrder).where(eq(storeOrder.id, orderId));
    const created = await tx(db => enqueuePresaleDeliveryIntent(db, { id: order.id, orderId: order.orderId }, 1));
    return { created, message: { action: 'processPresaleDeliveryOutbox' as const, outboxId: created.id, eventKey: created.eventKey } };
  }
  it.each([1, 2])('freezes %i already-materialized refund generations and delivers only the remaining entitlement', async count => {
    const first = await refundGeneration(1, 1, 1);
    if (count === 2) await refundGeneration(first.remainingOrderId, first.remainingRowId, 1, first.refundId);
    const { created, message } = await remainingEvent(first.remainingOrderId);
    expect(created.intent).toMatchObject({ version: 'presale-virtual-delivery-v2', baseline: { refundId: count,
      historyDigest: expect.stringMatching(/^[a-f0-9]{64}$/) }, lines: [{ quantity: 3 - count }] });
    const before = await effects();
    expect((await remainingEvent(first.remainingOrderId)).created).toEqual(created);
    expect(await effects()).toEqual(before);
    expect(await service().processMessage(message)).toBe('completed');
    expect((await effects()).cards.filter(card => card.uid === 11)).toHaveLength(3 - count);
  });
  it.each([false, true])('continues from a frozen refund baseline through a later refund (whole=%s)', async whole => {
    const first = await refundGeneration(1, 1, 1), { message } = await remainingEvent(first.remainingOrderId);
    await refundGeneration(first.remainingOrderId, first.remainingRowId, whole ? 2 : 1, first.refundId, whole);
    expect(await service().processMessage(message)).toBe('completed');
    expect((await effects()).cards.filter(card => card.uid === 11)).toHaveLength(whole ? 0 : 1);
    const before = await effects(); expect(await service().processMessage(message)).toBe('already-completed');
    expect(await effects()).toEqual(before);
  });
  it('keeps an already-refunded baseline pending before its original presale deadline', async () => {
    await f.db.update(storeOrderCartInfo).set({ cartInfo: snapshot(2_147_483_647) });
    const first = await refundGeneration(1, 1, 1), { message } = await remainingEvent(first.remainingOrderId);
    expect(await service().processMessage(message)).toBe('deferred');
    expect((await effects()).events[0]).toMatchObject({ status: 'PENDING', attemptCount: 0, availableTime: 2_147_483_647 });
    expect((await effects()).cards.every(card => card.uid === 0)).toBe(true);
  });
  it('refuses stripped generation markers before capture instead of inventing a v1 baseline', async () => {
    const first = await refundGeneration(1, 1, 1);
    await f.db.update(storeOrderCartInfo).set({ cartInfo: snapshot(100) }).where(eq(storeOrderCartInfo.id, first.remainingRowId));
    const before = await effects();
    await expect(remainingEvent(first.remainingOrderId)).rejects.toThrow('基线证据');
    expect(await effects()).toEqual(before);
  });
  it.each(['missing', 'fingerprint', 'source-cart', 'source-row', 'reuse-row', 'refund-mutated', 'digest', 'downgrade'])
    ('does not ignore changed baseline evidence: %s', async fault => {
      const first = await refundGeneration(1, 1, 1), { created, message } = await remainingEvent(first.remainingOrderId);
      if (fault === 'missing') await f.db.delete(storeOrderRefundSplit);
      if (fault === 'fingerprint') await f.db.update(storeOrderRefundSplit).set({ fingerprint: 'c'.repeat(64) });
      if (['source-cart', 'source-row', 'reuse-row'].includes(fault)) {
        const [record] = await f.db.select().from(storeOrderRefundSplit), parts = JSON.parse(record.partitions);
        if (fault === 'source-cart') parts[0].sourceCartId = '99';
        if (fault === 'source-row') parts[0].sourceRowId = 99;
        if (fault === 'reuse-row') parts[0].selectedRowId = parts[0].sourceRowId;
        await f.db.update(storeOrderRefundSplit).set({ partitions: JSON.stringify(parts) });
      }
      if (fault === 'refund-mutated') await f.db.update(storeOrderRefund).set({ refundPrice: '9.00', refundedPrice: '9.00' });
      if (created.intent.version !== 'presale-virtual-delivery-v2') throw Error('Expected v2 baseline');
      if (fault === 'digest') await f.db.update(storeOrderOutbox).set({ payload: { ...created.intent,
        baseline: { ...created.intent.baseline, historyDigest: 'd'.repeat(64) } } });
      if (fault === 'downgrade') {
        const { baseline: _baseline, ...original } = created.intent;
        await f.db.update(storeOrderOutbox).set({ payload: { ...original, version: 'presale-virtual-delivery-v1' } });
      }
      await expect(service().processMessage(message)).rejects.toThrow();
      expect((await effects()).cards.every(card => card.uid === 0)).toBe(true);
    });
  it('refuses late payment recovery with a synthetic receipt missing its frozen source snapshot', async () => {
    await refundGeneration(1, 1, 1);
    const paid = await tx(db => enqueueOrderPaidEvent(db, { id: 1, orderId: 'LOCAL-PRESALE' }));
    await expect(service().processMessage({ action: 'processOrderPaidOutbox', outboxId: paid.id, eventKey: paid.eventKey })).rejects.toThrow();
    const state = await effects(); expect(state.events).toHaveLength(1); expect(state.events[0].status).toBe('FAILED');
    expect(state.users[0].payCount).toBe(0); expect(state.cards.every(card => card.uid === 0)).toBe(true);
    expect(state.logs.some(log => log.changeType === 'pay_success')).toBe(false);
  });
  it.each([false, true])('completes a proven whole refund without delivering (after partial=%s)', async partial => {
    const message = await event();
    if (partial) { const first = await refundGeneration(1, 1, 1); await refundGeneration(first.remainingOrderId, first.remainingRowId, 2, first.refundId, true); }
    else await refundGeneration(1, 1, 3, 0, true);
    expect(await service().processMessage(message)).toBe('completed');
    const state = await effects(); expect(state.cards.every(card => card.uid === 0)).toBe(true); expect(state.logs).toEqual([]);
  });
  it.each(['fingerprint', 'partition', 'missing', 'refund-mutation'])('refuses broken generation proof: %s', async fault => {
    const message = await event(); await refundGeneration(1, 1, 1);
    if (fault === 'missing') await f.db.delete(storeOrderRefundSplit);
    else if (fault === 'refund-mutation') await f.db.update(storeOrderRefund).set({ refundPrice: '9.00' });
    else await f.db.update(storeOrderRefundSplit).set(fault === 'fingerprint' ? { fingerprint: '0'.repeat(64) } : { partitions: '[]' });
    await expect(service().processMessage(message)).rejects.toThrow(); expect((await effects()).cards.every(card => card.uid === 0)).toBe(true);
  });
  it.each([false, true].flatMap(baseline => [false, true].flatMap(whole =>
    ['source-cart', 'selected-row', 'claim-row'].map(fault => ({ baseline, whole, fault })))))
    ('binds every later receipt to its exact refund rows: %j', async ({ baseline, whole, fault }) => {
      const first = baseline ? await refundGeneration(1, 1, 1) : null;
      const message = first ? (await remainingEvent(first.remainingOrderId)).message : await event();
      const sourceId = first?.remainingOrderId ?? 1, rowId = first?.remainingRowId ?? 1;
      const later = await refundGeneration(sourceId, rowId, whole ? (baseline ? 2 : 3) : 1, first?.refundId ?? 0, whole);
      const [receipt] = await f.db.select().from(storeOrderRefundSplit).where(eq(storeOrderRefundSplit.refundId, later.refundId));
      if (fault === 'claim-row') {
        const [refund] = await f.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.id, later.refundId));
        const claim = JSON.parse(refund.cartInfo!); claim.quantityReservation.items[0].rowId = 999;
        const [changed] = await f.db.update(storeOrderRefund).set({ cartInfo: JSON.stringify(claim) })
          .where(eq(storeOrderRefund.id, later.refundId)).returning();
        await f.db.update(storeOrderRefundSplit).set({ fingerprint: await refundOrderSplitFingerprint(changed) })
          .where(eq(storeOrderRefundSplit.refundId, later.refundId));
      } else {
        const parts = JSON.parse(receipt.partitions);
        if (fault === 'source-cart') parts[0].sourceCartId = '999';
        else parts[0].selectedRowId = parts[0].remainingRowId ?? 999;
        await f.db.update(storeOrderRefundSplit).set({ partitions: JSON.stringify(parts) })
          .where(eq(storeOrderRefundSplit.refundId, later.refundId));
      }
      const before = await effects();
      await expect(service().processMessage(message)).rejects.toThrow();
      const after = await effects();
      for (const key of ['orders', 'cards', 'logs', 'users'] as const) expect(after[key]).toEqual(before[key]);
      expect(after.events.find(event => event.id === message.outboxId)?.status).toBe('FAILED');
    });
  it('validates Queue identity and archives only the canonical reference fields', () => {
    const message = { action: 'processPresaleDeliveryOutbox', outboxId: 1, eventKey: 'order.presale.fulfillment:1' };
    expect(isPresaleDeliveryOutboxMessage(message)).toBe(true);
    for (const patch of [{ action: 'processOrderPaidOutbox' }, { outboxId: 0 }, { eventKey: 'order.presale.fulfillment:01' },
      { eventKey: 'order.presale.fulfillment:2147483648' }, { eventKey: 'order.paid:1' }]) expect(isPresaleDeliveryOutboxMessage({ ...message, ...patch })).toBe(false);
    expect(prepareOrderQueueDeadLetter({ ...message, secret: 'unexpected', payload: 'private' })).toMatchObject({ replayPolicy: 'ALLOW', body: message, replayMessage: message });
  });
  it.skipIf(!native)('does not deliver when the PostgreSQL clock precedes the end despite application clock skew', async () => {
    await f.db.update(storeOrderCartInfo).set({ cartInfo: snapshot(2_147_483_647) }); const message = await event();
    vi.spyOn(Date, 'now').mockReturnValue(2_147_483_648_000);
    expect(await service().processMessage(message)).toBe('deferred'); expect((await effects()).cards.every(card => card.uid === 0)).toBe(true);
  });
  it.skipIf(!native)('concurrent duplicate consumers have a single committed delivery', async () => {
    const message = await event();
    await withFinancePeers(f.db, async ([one, two]) => {
      const results = await Promise.all([outcome(service(one.db).processMessage(message)), outcome(service(two.db).processMessage(message))]);
      expect(results.some(result => result.ok)).toBe(true);
    });
    expect((await effects()).logs.filter(log => log.changeType === 'delivery_fictitious')).toHaveLength(1);
    expect(await service().processMessage(message)).toBe('already-completed');
  });
});
