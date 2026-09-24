import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { StoreOrderCreateService } from '../src/services/order/StoreOrderCreateService';
import { allocatePaidOrderBySupplier } from '../src/services/order/OrderSupplierAllocationService';
import { SupplierFulfillmentService } from '../src/services/supplier/SupplierFulfillmentService';
import { recordSupplierPayment, SupplierFinanceService } from '../src/services/supplier/SupplierFinanceService';
import { applyOrderRefund, finalizeStoreOrderRefund } from '../src/services/order/StoreOrderRefundService';
import { AdminMobileOrderOperationService } from '../src/services/admin/AdminMobileOrderOperationService';
import { INVOICE_EVIDENCE_SQL } from '../src/migrations/invoiceEvidence';
import { createContainerFromDb, withTx, type DbClient } from '../src/lib/di';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';
import { agentLevel, printDocument, storeCart, storeOrder, storeOrderCartInfo, storeOrderRefund,
  storeOrderStatus, storeProduct, storeProductAttrValue, storeOrderInvoice, storeOrderRefundPayment,
  storeOrderOutbox, orderWaybillJob, userBrokerage, systemSupplier, supplierFlowingWater, paymentReconciliationCase,
  supplierTransactions, supplierExtract } from '../src/models/schema';

let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
const delivery = { deliveryType: 'express' as const, deliveryName: 'Local ledger test', deliveryCode: 'local',
  deliveryId: 'NO-SHIPMENT', fictitiousContent: '', deliveryUid: 0 };
const carts = (oid: number) => f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, oid)).orderBy(storeOrderCartInfo.id);
const order = async (oid: number) => (await f.db.select().from(storeOrder).where(eq(storeOrder.id, oid)))[0];
const flows = () => f.db.select().from(supplierFlowingWater).orderBy(supplierFlowingWater.id);
const transactions = () => f.db.select().from(supplierTransactions).orderBy(supplierTransactions.id);
const summary = () => new SupplierFinanceService(f.container, f.env).summary(7);
const state = async () => ({ ...await f.snapshot(), flows: await flows(), transactions: await transactions(),
  details: await f.db.select().from(storeOrderCartInfo).orderBy(storeOrderCartInfo.id),
  refunds: await f.db.select().from(storeOrderRefund).orderBy(storeOrderRefund.id),
  statuses: await f.db.select().from(storeOrderStatus).orderBy(storeOrderStatus.id),
  outbox: await f.db.select().from(storeOrderOutbox).orderBy(storeOrderOutbox.id) });
const refund = async (oid: number, quantity?: number) => {
  const current = await order(oid), [cart] = await carts(oid);
  const application = await applyOrderRefund(f.container, { uid: 11, orderId: current.orderId, applyType: 1,
    refundReason: 'Synthetic supplier refund', refundExplain: '',
    cartSelections: [{ cartId: Number(cart.cartId), cartNum: quantity ?? cart.cartNum }] });
  expect(await finalizeStoreOrderRefund(f.container, application.refundId)).toBe('completed');
  const saved = await state();
  expect(await finalizeStoreOrderRefund(f.container, application.refundId)).toBe('already-completed');
  expect(await state()).toEqual(saved);
};
const split = async (oid: number) => new SupplierFulfillmentService(f.container, f.env)
  .splitDelivery(7, oid, delivery, [{ cartId: (await carts(oid))[0].cartId, cartNum: 1 }]);
const create = async (mixed = false, price?: string) => {
  if (mixed) {
    await f.db.insert(storeProduct).values({ id: 71, storeName: 'Platform line', price: '30.00', stock: 8, isShow: 1, freight: 1 });
    await f.db.insert(storeProductAttrValue).values({ id: 2, productId: 71, unique: 'free0071', suk: 'Standard', price: '30.00', stock: 8 });
    await f.db.insert(storeCart).values({ id: 2, uid: 11, productId: 71, productAttrUnique: 'free0071', cartNum: 1, status: 1, isNew: 1 });
  }
  const result = await StoreOrderCreateService.createWithRuntime(f.container,
    { CONFIG_KV: f.env.CONFIG_KV, nextOrderId: async () => 'supplier_ledger_checkout' },
    { uid: 11, key: 'supplier_ledger', cartIds: mixed ? [1, 2] : [1], addressId: 11, userIp: '127.0.0.1' });
  if (price !== undefined) await new AdminMobileOrderOperationService(f.container).changePrice(100, { order_id: result.orderId, price });
  const [created] = await f.db.update(storeOrder).set({ paid: 1, payType: 'yue', payTime: 100 })
    .where(eq(storeOrder.orderId, result.orderId)).returning();
  // Synthetic paid flag; actual allocation and supplier payment accounting,
  // no customer payment debit, outbox worker or external payment/shipping call.
  const allocated = await withTx(f.container, async tx => {
    const result = await allocatePaidOrderBySupplier(tx, created.id, created.orderId, 100);
    for (const child of result.fulfillmentOrders) await recordSupplierPayment(tx, child, 100);
    return result;
  });
  return allocated.fulfillmentOrders.find(row => row.supplierId === 7)!;
};
beforeEach(async () => {
  f = await createPcCheckoutQuoteFixture([agentLevel, printDocument, storeOrderCartInfo, storeOrderRefund, storeOrderStatus,
    storeOrderInvoice, storeOrderRefundPayment, storeOrderOutbox, orderWaybillJob, userBrokerage, systemSupplier,
    supplierFlowingWater, supplierTransactions, supplierExtract, paymentReconciliationCase]);
  await f.exec('CREATE UNIQUE INDEX supplier_split_event ON store_order_outbox(event_key); CREATE UNIQUE INDEX supplier_split_flow ON supplier_flowing_water(order_id); CREATE UNIQUE INDEX supplier_split_transaction ON supplier_transactions(order_id)');
  await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
  await f.exec(INVOICE_EVIDENCE_SQL);
  await f.db.insert(systemSupplier).values({ id: 7, adminId: 7, supplierName: 'Local supplier' });
  await f.db.update(storeCart).set({ cartNum: 3 }).where(eq(storeCart.id, 1));
  await f.db.update(storeProduct).set({ type: 2, relationId: 7, freight: 2, tempId: 0, postage: '3.00' }).where(eq(storeProduct.id, 70));
  await f.db.update(storeProductAttrValue).set({ settlePrice: '2.50', cost: '2.00' }).where(eq(storeProductAttrValue.id, 1));
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
}, 30_000);
afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); } });

it.each([false, true])('partitions pending supplier income on first split; preallocated supplier child=%s', async mixed => {
  const source = await create(mixed), original = (await flows())[0], cash = await transactions();
  expect(original).toMatchObject({ number: '16.50', payPrice: '39.00', status: 0 });
  const result = await split(source.id), selected = await order(result.order_id), remaining = await order(result.remaining_order_id!);
  const current = (await flows()).filter(row => row.status === 0);
  expect(current.map(row => [row.linkId, row.number, row.payPrice])).toEqual([
    [selected.orderId, '5.50', '13.00'], [remaining.orderId, '11.00', '26.00'],
  ]);
  expect((await flows())[0]).toEqual({ ...original, status: -1, finishTime: expect.any(Number) });
  expect(await transactions()).toEqual(cash);
  expect(await summary()).toMatchObject({ available: '0.00', pending_settlement: '16.50' });
});

it.each([false, true])('repeated splitting, actual receipt and refunds settle each child once; supplier allocation=%s', async mixed => {
  const source = await create(mixed), originalCash = await transactions();
  const first = await split(source.id), second = await split(first.remaining_order_id!);
  const service = new SupplierFulfillmentService(f.container, f.env);
  await service.deliver(7, second.remaining_order_id!, delivery);
  const ids = [first.order_id, second.order_id, second.remaining_order_id!];
  for (const [index, oid] of ids.entries()) {
    await service.confirmTake(7, oid);
    expect(await summary()).toMatchObject({ available: '5.50', pending_settlement: ['11.00', '5.50', '0.00'][index] });
    await refund(oid);
    expect(await summary()).toMatchObject({ available: '0.00', pending_settlement: ['11.00', '5.50', '0.00'][index] });
  }
  const done = await state();
  expect(done.flows.filter(row => row.pm === 0).map(row => row.number)).toEqual(['5.50', '5.50', '5.50']);
  expect(done.transactions.filter(row => row.pm === 1)).toEqual(originalCash);
  expect(done.transactions.filter(row => row.pm === 0)).toHaveLength(3);
  expect(done.users[0].nowMoney).toBe('39.00');
  // Every retired entitlement still retains its original financial evidence.
  expect(done.flows.filter(row => row.pm === 1 && row.status === -1).map(row => row.number)).toEqual(['16.50', '11.00']);
});

it('a full refund of pending child income cannot consume another received child balance', async () => {
  const source = await create(), first = await split(source.id), service = new SupplierFulfillmentService(f.container, f.env);
  await service.confirmTake(7, first.order_id);
  expect(await summary()).toMatchObject({ available: '5.50', pending_settlement: '11.00' });
  await refund(first.remaining_order_id!);
  expect(await summary()).toMatchObject({ available: '5.50', pending_settlement: '0.00' });
});

it('pending partial refunds reduce only pending income, then settle with that same child on receipt', async () => {
  const source = await create(), first = await split(source.id), service = new SupplierFulfillmentService(f.container, f.env);
  await service.confirmTake(7, first.order_id);
  await refund(first.remaining_order_id!, 1);
  expect(await summary()).toMatchObject({ available: '5.50', pending_settlement: '5.50' });
  await service.deliver(7, first.remaining_order_id!, delivery);
  await service.confirmTake(7, first.remaining_order_id!);
  expect(await summary()).toMatchObject({ available: '11.00', pending_settlement: '0.00' });
  await refund(first.remaining_order_id!, 1);
  expect(await summary()).toMatchObject({ available: '5.50', pending_settlement: '0.00' });
});

it('successive pending refunds close income and every pending reversal at zero net without receipt', async () => {
  const source = await create(), first = await split(source.id), service = new SupplierFulfillmentService(f.container, f.env);
  await service.confirmTake(7, first.order_id);
  await refund(first.remaining_order_id!, 1); await refund(first.remaining_order_id!, 1);
  expect(await summary()).toMatchObject({ available: '5.50', pending_settlement: '0.00', total_refund: '11.00' });
  expect((await flows()).filter(row => row.status === 0)).toEqual([]);
  expect((await flows()).filter(row => row.type === 2).map(row => [row.number, row.status])).toEqual([['5.50', 1], ['5.50', 1]]);
});

it('late refund transaction failure rolls back income recognition and all financial side effects', async () => {
  const source = await create(), first = await split(source.id);
  const current = await order(first.remaining_order_id!), [cart] = await carts(current.id);
  const application = await applyOrderRefund(f.container, { uid: 11, orderId: current.orderId, applyType: 1,
    refundReason: 'Rollback test', refundExplain: '', cartSelections: [{ cartId: Number(cart.cartId), cartNum: cart.cartNum }] });
  const before = await state();
  await f.exec("CREATE FUNCTION reject_supplier_refund() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'late supplier refund failure'; END $$; CREATE TRIGGER reject_supplier_refund BEFORE INSERT ON supplier_transactions FOR EACH ROW EXECUTE FUNCTION reject_supplier_refund()");
  await expect(finalizeStoreOrderRefund(f.container, application.refundId)).rejects.toThrow();
  expect(await state()).toEqual(before);
  await f.exec('DROP TRIGGER reject_supplier_refund ON supplier_transactions');
  expect(await finalizeStoreOrderRefund(f.container, application.refundId)).toBe('completed');
  expect(await summary()).toMatchObject({ available: '0.00', pending_settlement: '5.50' });
});

it('a fully refunded pending child does not reserve another child balance from actual extraction admission', async () => {
  const source = await create(), first = await split(source.id), service = new SupplierFulfillmentService(f.container, f.env);
  await service.confirmTake(7, first.order_id); await refund(first.remaining_order_id!);
  await f.db.update(systemSupplier).set({ alipayAccount: 'local-only' }).where(eq(systemSupplier.id, 7));
  await new SupplierFinanceService(f.container, f.env).applyExtract(7, { extract_type: 'alipay', money: '5.50' });
  expect((await f.db.select().from(supplierExtract))[0]).toMatchObject({ supplierId: 7, extractPrice: '5.50', status: 0, payStatus: 0 });
  expect(await summary()).toMatchObject({ available: '0.00', pending_settlement: '0.00', pending_extract: '5.50' });
});

it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('a refund followed concurrently by receipt settles pending income and refund together', async () => {
  const source = await create(), first = await split(source.id), oid = first.remaining_order_id!;
  await new SupplierFulfillmentService(f.container, f.env).deliver(7, oid, delivery);
  const current = await order(oid), [cart] = await carts(oid);
  const application = await applyOrderRefund(f.container, { uid: 11, orderId: current.orderId, applyType: 1,
    refundReason: 'Concurrent receipt refund', refundExplain: '', cartSelections: [{ cartId: Number(cart.cartId), cartNum: 1 }] });
  await withFinancePeers(f.db, async ([holder, refunder, receiver]) => {
    await holder.exec(`BEGIN; SELECT id FROM store_order WHERE id=${oid} FOR UPDATE`);
    const a = outcome(finalizeStoreOrderRefund(createContainerFromDb(refunder.db), application.refundId));
    await waitForFinanceBlock(f.db, refunder.pid, holder.pid);
    const b = outcome(new SupplierFulfillmentService(createContainerFromDb(receiver.db), f.env).confirmTake(7, oid));
    await waitForFinanceBlock(f.db, receiver.pid, refunder.pid);
    await holder.exec('COMMIT');
    const one = await a, two = await b; expect(one.ok && two.ok).toBe(true);
    if (one.ok) expect(one.value).toBe('completed');
  });
  expect((await order(oid)).status).toBe(2);
  expect(await summary()).toMatchObject({ available: '5.50', pending_settlement: '5.50', total_refund: '5.50' });
  expect((await flows()).filter(row => row.linkId === current.orderId && row.status !== -1).map(row => [row.pm, row.status]))
    .toEqual([[1, 1], [0, 1]]);
}, 15_000);

it('a zero-cash selected child retains its genuine supplier entitlement, not a payment-weight allocation', async () => {
  const source = await create(false, '0.01'), result = await split(source.id);
  expect((await order(result.order_id)).payPrice).toBe('0.00');
  expect((await flows()).filter(row => row.status === 0).map(row => [row.number, row.payPrice]))
    .toEqual([['5.50', '0.00'], ['11.00', '0.01']]);
});

it.each(['missing', 'supplier', 'uid', 'payment', 'amount', 'settled', 'duplicate', 'cart-settlement'] as const)
  ('refuses inconsistent source ledger %s and rolls back new children', async kind => {
    const source = await create(), original = (await flows())[0];
    if (kind === 'missing') await f.db.delete(supplierFlowingWater);
    else if (kind === 'supplier') await f.db.update(supplierFlowingWater).set({ supplierId: 8 });
    else if (kind === 'uid') await f.db.update(supplierFlowingWater).set({ uid: 22 });
    else if (kind === 'payment') await f.db.update(supplierFlowingWater).set({ payPrice: '99.00' });
    else if (kind === 'amount') await f.db.update(supplierFlowingWater).set({ number: '16.51' });
    else if (kind === 'settled') await f.db.update(supplierFlowingWater).set({ status: 1 });
    else if (kind === 'duplicate') { const { id, ...copy } = original; await f.db.insert(supplierFlowingWater).values({ ...copy, orderId: 'duplicate' }); }
    else await f.db.update(storeOrderCartInfo).set({ settlePrice: '-0.01' }).where(eq(storeOrderCartInfo.oid, source.id));
    const before = await state();
    await expect(split(source.id)).rejects.toThrow('供应商拆单结算账本');
    expect(await state()).toEqual(before);
  });

it('late SQL failure restores source income, children, cart claims, audit and notice atomically', async () => {
  const source = await create(), before = await state();
  await f.exec("CREATE FUNCTION reject_split_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'late ledger split failure'; END $$; CREATE TRIGGER reject_split_audit BEFORE INSERT ON store_order_status FOR EACH ROW EXECUTE FUNCTION reject_split_audit()");
  await expect(split(source.id)).rejects.toThrow();
  expect(await state()).toEqual(before);
});

it('whole delivery does not replace any income or payment transaction', async () => {
  const source = await create(), original = await flows(), cash = await transactions(), [cart] = await carts(source.id);
  await new SupplierFulfillmentService(f.container, f.env).splitDelivery(7, source.id, delivery, [{ cartId: cart.cartId, cartNum: 3 }]);
  expect(await flows()).toEqual(original); expect(await transactions()).toEqual(cash);
});

it('committed split replay does not retire child income again, even after a child refund', async () => {
  const source = await create(), [cart] = await carts(source.id), service = new SupplierFulfillmentService(f.container, f.env);
  const options = { replay: { accountId: 77, requestHash: 'a'.repeat(64), changeType: 'out_order_split_delivery' as const } };
  const selected = [{ cartId: cart.cartId, cartNum: 1 }];
  const first = await service.splitDelivery(7, source.id, delivery, selected, options);
  await service.confirmTake(7, first.order_id); await refund(first.order_id);
  const before = await state();
  expect(await service.splitDelivery(7, source.id, delivery, selected, options)).toEqual({ ...first, idempotent: true });
  expect(await state()).toEqual(before);
});

it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('validates source ledger again after an independent flow-row lock wait', async () => {
  const source = await create(), original = (await flows())[0], [cart] = await carts(source.id);
  await withFinancePeers(f.db, async ([holder, caller]) => {
    await holder.exec(`BEGIN; SELECT id FROM supplier_flowing_water WHERE id=${original.id} FOR UPDATE`);
    const pending = outcome(new SupplierFulfillmentService(createContainerFromDb(caller.db), f.env)
      .splitDelivery(7, source.id, delivery, [{ cartId: cart.cartId, cartNum: 1 }]));
    await waitForFinanceBlock(f.db, caller.pid, holder.pid);
    await holder.db.update(supplierFlowingWater).set({ number: '16.51' }).where(eq(supplierFlowingWater.id, original.id));
    await holder.exec('COMMIT');
    const result = await pending; expect(result.ok).toBe(false);
    if (!result.ok) expect(String(result.error)).toContain('供应商拆单结算账本');
  });
  expect(await f.db.select().from(storeOrder)).toHaveLength(1);
  expect(await flows()).toEqual([{ ...original, number: '16.51' }]);
}, 15_000);

it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('concurrent split retries create one replacement pair and preserve the cash ledger', async () => {
  const source = await create(), original = (await flows())[0], cash = await transactions(), [cart] = await carts(source.id);
  const options = { replay: { accountId: 77, requestHash: 'b'.repeat(64), changeType: 'out_order_split_delivery' as const } };
  const run = (db: DbClient) => new SupplierFulfillmentService(createContainerFromDb(db), f.env)
    .splitDelivery(7, source.id, delivery, [{ cartId: cart.cartId, cartNum: 1 }], options);
  await withFinancePeers(f.db, async ([holder, first, second]) => {
    await holder.exec(`BEGIN; SELECT id FROM supplier_flowing_water WHERE id=${original.id} FOR UPDATE`);
    const a = outcome(run(first.db)); await waitForFinanceBlock(f.db, first.pid, holder.pid);
    const b = outcome(run(second.db)); await waitForFinanceBlock(f.db, second.pid, first.pid);
    await holder.exec('COMMIT');
    const one = await a, two = await b; expect(one.ok && two.ok).toBe(true);
    if (one.ok && two.ok) expect(two.value).toEqual({ ...one.value, idempotent: true });
  });
  expect(await flows()).toHaveLength(3); expect(await transactions()).toEqual(cash);
  expect((await state()).outbox).toHaveLength(1);
}, 15_000);
