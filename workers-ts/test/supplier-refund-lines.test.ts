import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { StoreOrderCreateService } from '../src/services/order/StoreOrderCreateService';
import { allocatePaidOrderBySupplier } from '../src/services/order/OrderSupplierAllocationService';
import { SupplierFulfillmentService } from '../src/services/supplier/SupplierFulfillmentService';
import { recordSupplierPayment, SupplierFinanceService } from '../src/services/supplier/SupplierFinanceService';
import { applyOrderRefund, finalizeStoreOrderRefund } from '../src/services/order/StoreOrderRefundService';
import { withTx, createContainerFromDb, type Container } from '../src/lib/di';
import { AdminSupplierFinanceService } from '../src/services/admin/AdminSupplierFinanceService';
import { INVOICE_EVIDENCE_SQL } from '../src/migrations/invoiceEvidence';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';
import { agentLevel, printDocument, storeCart, storeOrder, storeOrderCartInfo, storeOrderRefund,
  storeOrderStatus, storeProduct, storeProductAttrValue, storeOrderInvoice, storeOrderRefundPayment,
  storeOrderOutbox, orderWaybillJob, userBrokerage, systemSupplier, supplierFlowingWater,
  supplierTransactions, supplierExtract, shippingTemplates, shippingTemplatesRegion } from '../src/models/schema';

let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
let request = 0;
const shipping = { deliveryType: 'express', deliveryName: 'Local', deliveryCode: 'local',
  deliveryId: 'NO-SHIPMENT', fictitiousContent: '', deliveryUid: 0 } as const;
const state = async () => ({ ...await f.snapshot(),
  flows: await f.db.select().from(supplierFlowingWater).orderBy(supplierFlowingWater.id),
  transactions: await f.db.select().from(supplierTransactions).orderBy(supplierTransactions.id),
  extracts: await f.db.select().from(supplierExtract).orderBy(supplierExtract.id),
  carts: await f.db.select().from(storeOrderCartInfo).orderBy(storeOrderCartInfo.id),
  refunds: await f.db.select().from(storeOrderRefund).orderBy(storeOrderRefund.id),
  statuses: await f.db.select().from(storeOrderStatus).orderBy(storeOrderStatus.id) });
const summary = () => new SupplierFinanceService(f.container, f.env).summary(7);
const receive = async (id: number) => {
  const service = new SupplierFulfillmentService(f.container, f.env);
  await service.deliver(7, id, shipping); await service.confirmTake(7, id);
};
const create = async (received = false) => {
  const created = await StoreOrderCreateService.createWithRuntime(f.container,
    { CONFIG_KV: f.env.CONFIG_KV, nextOrderId: async () => 'supplier_refund_lines' },
    { uid: 11, key: 'supplier-refund-lines', cartIds: [1, 2], addressId: 11, userIp: '127.0.0.1' });
  const [paid] = await f.db.update(storeOrder).set({ paid: 1, payType: 'yue', payTime: 100 })
    .where(eq(storeOrder.orderId, created.orderId)).returning();
  const order = await withTx(f.container, async tx => {
    const allocated = await allocatePaidOrderBySupplier(tx, paid.id, paid.orderId, 100);
    for (const child of allocated.fulfillmentOrders) await recordSupplierPayment(tx, child, 100);
    return allocated.fulfillmentOrders.find(row => row.supplierId === 7)!;
  });
  if (received) await receive(order.id);
  return order;
};
const apply = (orderId: string, cartId: number, cartNum = 1, cents?: number) => applyOrderRefund(f.container,
  { uid: 11, orderId, applyType: cents === undefined ? 1 : 4, applicationOrderId: `supplier_lines_${++request}`,
    refundReason: 'Local supplier line test', refundExplain: '', cartSelections: [{ cartId, cartNum }],
    ...(cents === undefined ? {} : { privilegedActor: 'admin', requestedRefundAmountCents: cents, authorizeApplication: async () => {} }) });
beforeEach(async () => {
  request = 0;
  f = await createPcCheckoutQuoteFixture([agentLevel, printDocument, storeOrderCartInfo, storeOrderRefund, storeOrderStatus,
    storeOrderInvoice, storeOrderRefundPayment, storeOrderOutbox, orderWaybillJob, userBrokerage, systemSupplier,
    supplierFlowingWater, supplierTransactions, supplierExtract]);
  await f.exec('CREATE UNIQUE INDEX supplier_line_event ON store_order_outbox(event_key); CREATE UNIQUE INDEX supplier_line_flow ON supplier_flowing_water(order_id); CREATE UNIQUE INDEX supplier_line_transaction ON supplier_transactions(order_id)');
  await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
  await f.exec(INVOICE_EVIDENCE_SQL);
  await f.db.insert(systemSupplier).values({ id: 7, adminId: 7, supplierName: 'Local supplier', alipayAccount: 'local-fixture@example.invalid' });
  await f.db.update(storeProduct).set({ type: 2, relationId: 7, freight: 2, tempId: 0, postage: '3.00' }).where(eq(storeProduct.id, 70));
  await f.db.update(storeProductAttrValue).set({ settlePrice: '2.50', cost: '2.00' }).where(eq(storeProductAttrValue.id, 1));
  await f.db.insert(storeProduct).values({ id: 71, storeName: 'Different supplier margin', type: 2, relationId: 7, price: '30.00', stock: 8, isShow: 1, freight: 1 });
  await f.db.insert(storeProductAttrValue).values({ id: 2, productId: 71, unique: 'supf0071', suk: 'Standard', price: '30.00', settlePrice: '20.00', stock: 8 });
  await f.db.insert(storeCart).values({ id: 2, uid: 11, productId: 71, productAttrUnique: 'supf0071', cartNum: 1, status: 1, isNew: 1 });
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
}, 30_000);
afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); } });

it.each([false, true])('uses the selected settlement price and freight, not the customer cash proportion; received=%s', async received => {
  const order = await create(received), original = await state();
  expect(order.payPrice).toBe('56.00'); expect(original.flows[0].number).toBe('31.00');
  const application = await apply(order.orderId, 1);
  expect(await finalizeStoreOrderRefund(f.container, application.refundId)).toBe('completed');
  const done = await state(); expect(done.flows.filter(row => row.pm === 0).map(row => row.number)).toEqual(['5.50']);
  expect(await summary()).toMatchObject({ available: received ? '25.50' : '0.00', pending_settlement: received ? '0.00' : '25.50', total_refund: '5.50' });
  expect(done.flows[0]).toEqual(original.flows[0]);
  expect(done.transactions.filter(row => row.pm === 1)).toEqual(original.transactions);
  expect(await finalizeStoreOrderRefund(f.container, application.refundId)).toBe('already-completed'); expect(await state()).toEqual(done);
});

it.each([false, true])('refunds unequal-margin goods completely in either order; expensive first=%s', async expensive => {
  const order = await create(), sequence = expensive ? [2, 1, 1] : [1, 1, 2];
  for (const cartId of sequence) { const next = await apply(order.orderId, cartId); await finalizeStoreOrderRefund(f.container, next.refundId); }
  const done = await state();
  expect(done.flows.filter(row => row.pm === 0).map(row => row.number)).toEqual(expensive ? ['20.00', '5.50', '5.50'] : ['5.50', '5.50', '20.00']);
  expect(done.flows.every(row => row.status === 1)).toBe(true);
  expect(await summary()).toMatchObject({ available: '0.00', pending_settlement: '0.00', total_refund: '31.00' });
  expect(done.users[0].nowMoney).toBe('56.00');
});

it('settles completed-goods income at net zero despite approved cash concessions', async () => {
  const order = await create();
  const first = await apply(order.orderId, 1, 2, 100); await finalizeStoreOrderRefund(f.container, first.refundId);
  expect(await summary()).toMatchObject({ available: '0.00', pending_settlement: '20.00', total_refund: '11.00' });
  const second = await apply(order.orderId, 2, 1, 100); await finalizeStoreOrderRefund(f.container, second.refundId);
  const done = await state(); expect(done.flows.filter(row => row.pm === 0).map(row => row.number)).toEqual(['11.00', '20.00']);
  expect(done.flows.every(row => row.status === 1)).toBe(true);
  expect(done.transactions.filter(row => row.pm === 0).map(row => row.payPrice)).toEqual(['1.00', '1.00']);
  expect(done.users[0].nowMoney).toBe('2.00');
  expect(await summary()).toMatchObject({ available: '0.00', pending_settlement: '0.00', total_refund: '31.00' });
});

it('receipt between partial refunds recognizes only the remaining supplier entitlement', async () => {
  const order = await create(), first = await apply(order.orderId, 1); await finalizeStoreOrderRefund(f.container, first.refundId);
  await receive(order.id); expect(await summary()).toMatchObject({ available: '25.50', pending_settlement: '0.00' });
  const second = await apply(order.orderId, 2); await finalizeStoreOrderRefund(f.container, second.refundId);
  expect(await summary()).toMatchObject({ available: '5.50', pending_settlement: '0.00', total_refund: '25.50' });
});

it('uses stored settlement units after current product/SKU prices change', async () => {
  const order = await create();
  await f.db.update(storeProductAttrValue).set({ settlePrice: '99.00', price: '99.00' });
  const next = await apply(order.orderId, 1); await finalizeStoreOrderRefund(f.container, next.refundId);
  expect((await state()).flows.filter(row => row.pm === 0).map(row => row.number)).toEqual(['5.50']);
});

it('returns a shared one-cent freight residue exactly once on the last unit', async () => {
  await f.db.update(storeCart).set({ cartNum: 3 }).where(eq(storeCart.id, 1));
  await f.db.update(storeProduct).set({ freight: 3, tempId: 10, postage: '0.00' }).where(eq(storeProduct.id, 70));
  await f.db.update(shippingTemplates).set({ ownerType: 2, relationId: 7 }).where(eq(shippingTemplates.id, 10));
  await f.db.update(shippingTemplatesRegion).set({ first: '10.00', firstPrice: '0.01', continuePrice: '0.00' }).where(eq(shippingTemplatesRegion.id, 1));
  const order = await create(); expect((await state()).flows[0].number).toBe('27.51');
  for (const cartId of [1, 1, 1, 2]) { const next = await apply(order.orderId, cartId); await finalizeStoreOrderRefund(f.container, next.refundId); }
  expect((await state()).flows.filter(row => row.pm === 0).map(row => row.number)).toEqual(['2.50', '2.50', '2.51', '20.00']);
  expect(await summary()).toMatchObject({ available: '0.00', pending_settlement: '0.00', total_refund: '27.51' });
});

it('preserves a genuine zero settlement entitlement without division by zero or premature recognition', async () => {
  await f.db.update(storeProduct).set({ freight: 1, postage: '0.00' });
  await f.db.update(storeProductAttrValue).set({ settlePrice: '0.00' });
  const order = await create(), first = await apply(order.orderId, 1); await finalizeStoreOrderRefund(f.container, first.refundId);
  expect((await state()).flows.map(row => [row.number, row.status])).toEqual([['0.00', 0], ['0.00', 0]]);
  for (const cartId of [1, 2]) { const next = await apply(order.orderId, cartId); await finalizeStoreOrderRefund(f.container, next.refundId); }
  expect((await state()).flows.every(row => row.number === '0.00' && row.status === 1)).toBe(true);
  expect(await summary()).toMatchObject({ available: '0.00', pending_settlement: '0.00', total_refund: '0.00' });
});

it.each(['missing', 'amount', 'uid', 'payment', 'cart-unit', 'negative-history', 'excess-history', 'foreign-history', 'payment-history'] as const)
  ('rejects inconsistent supplier settlement evidence %s without partial cash or ledger writes', async kind => {
  const order = await create(), next = await apply(order.orderId, 1);
  if (kind === 'missing') await f.db.delete(supplierFlowingWater);
  if (kind === 'amount') await f.db.update(supplierFlowingWater).set({ number: '31.01' });
  if (kind === 'uid') await f.db.update(supplierFlowingWater).set({ uid: 22 });
  if (kind === 'payment') await f.db.update(supplierFlowingWater).set({ payPrice: '56.01' });
  if (kind === 'cart-unit') await f.db.update(storeOrderCartInfo).set({ settlePrice: '-0.01' }).where(eq(storeOrderCartInfo.oid, order.id));
  if (kind.endsWith('-history')) await f.db.insert(supplierFlowingWater).values({ supplierId: 7, uid: kind === 'foreign-history' ? 22 : 11,
    orderId: 'bad-history', linkId: order.orderId, pm: 0, type: 2, payType: kind === 'payment-history' ? 'weixin' : 'yue',
    number: kind === 'negative-history' ? '-0.01' : kind === 'excess-history' ? '6.00' : '1.00', status: 0 });
  const before = await state(); await expect(finalizeStoreOrderRefund(f.container, next.refundId)).rejects.toThrow(); expect(await state()).toEqual(before);
});

it.each(['flow', 'transaction'] as const)('does not silently suppress a conflicting original refund %s identity', async kind => {
  const order = await create(), next = await apply(order.orderId, 1);
  const foreign = { supplierId: 8, uid: 22, orderId: `R${next.refundId}-${order.orderId}`, linkId: 'foreign-order', pm: 0, type: 2, payType: 'yue', payPrice: '1.00' };
  if (kind === 'flow') await f.db.insert(supplierFlowingWater).values({ ...foreign, number: '1.00', status: 1 });
  else await f.db.insert(supplierTransactions).values(foreign);
  const before = await state(); await expect(finalizeStoreOrderRefund(f.container, next.refundId)).rejects.toThrow(); expect(await state()).toEqual(before);
});

it('late cash-transaction failure rolls back pending income recognition, customer funds and inventory', async () => {
  const order = await create(), first = await apply(order.orderId, 1, 2); await finalizeStoreOrderRefund(f.container, first.refundId);
  const last = await apply(order.orderId, 2), before = await state();
  await f.exec(`CREATE FUNCTION fail_supplier_line() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'local supplier line failure'; END $$;
    CREATE TRIGGER fail_supplier_line BEFORE INSERT ON supplier_transactions FOR EACH ROW EXECUTE FUNCTION fail_supplier_line()`);
  await expect(finalizeStoreOrderRefund(f.container, last.refundId)).rejects.toThrow(); expect(await state()).toEqual(before);
  await f.exec('DROP TRIGGER fail_supplier_line ON supplier_transactions');
  expect(await finalizeStoreOrderRefund(f.container, last.refundId)).toBe('completed');
  expect(await summary()).toMatchObject({ available: '0.00', pending_settlement: '0.00', total_refund: '31.00' });
});

it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('revalidates supplier income after a real flow-row lock wait', async () => {
  const order = await create(), next = await apply(order.orderId, 1), original = (await state()).flows[0];
  let changed: Awaited<ReturnType<typeof state>> | undefined;
  await withFinancePeers(f.db, async ([holder, worker]) => {
    await holder.exec(`BEGIN; SELECT id FROM supplier_flowing_water WHERE id=${original.id} FOR UPDATE`);
    const work = outcome(finalizeStoreOrderRefund(createContainerFromDb(worker.db), next.refundId));
    await waitForFinanceBlock(f.db, worker.pid, holder.pid);
    await holder.db.update(supplierFlowingWater).set({ number: '31.01' }).where(eq(supplierFlowingWater.id, original.id));
    await holder.exec('COMMIT'); changed = await state(); const result = await work;
    expect(result.ok).toBe(false); if (!result.ok) expect(String(result.error)).toContain('证据');
  });
  expect(await state()).toEqual(changed);
}, 15_000);

const native = it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL));
const extract = (container: Container, money = '31.00', supplierId = 7) =>
  new SupplierFinanceService(container, f.env).applyExtract(supplierId, { extract_type: 'alipay', money });

/** Pause the real first service after it owns its finance mutex. PostgreSQL's
 * blocker PIDs, not start times or sleeps, must prove the second service queues.
 * Release and drain BOTH services before asserting, including on a red test. */
async function queued<A, B>(gate: string, first: (c: Container) => Promise<A>, second: (c: Container) => Promise<B>, repeatableRead = false) {
  return withFinancePeers(f.db, async ([holder, one, two]) => {
    if (repeatableRead) await Promise.all([one.exec("SET default_transaction_isolation = 'repeatable read'"),
      two.exec("SET default_transaction_isolation = 'repeatable read'")]);
    await holder.exec(`BEGIN; ${gate}`);
    const a = outcome(first(createContainerFromDb(one.db)));
    const firstBlocked = await outcome(waitForFinanceBlock(f.db, one.pid, holder.pid));
    const b = outcome(second(createContainerFromDb(two.db)));
    const secondBlocked = await outcome(waitForFinanceBlock(f.db, two.pid, one.pid));
    await holder.exec('COMMIT');
    const results = await Promise.all([a, b]);
    expect(firstBlocked.ok, 'first service reached the controlled SQL gate').toBe(true);
    expect(secondBlocked.ok, 'second service waited for the first supplier transaction').toBe(true);
    return results;
  });
}

native('refund-first withdrawal admission reads the committed lower balance', async () => {
  const order = await create(true), next = await apply(order.orderId, 1), flow = (await state()).flows[0];
  const [refund, withdrawal] = await queued(`SELECT id FROM supplier_flowing_water WHERE id=${flow.id} FOR UPDATE`,
    c => finalizeStoreOrderRefund(c, next.refundId), c => extract(c));
  expect(refund).toEqual({ ok: true, value: 'completed' });
  expect(withdrawal.ok).toBe(false); if (!withdrawal.ok) expect(String(withdrawal.error)).toContain('25.50');
  expect((await state()).extracts).toEqual([]);
  expect(await summary()).toMatchObject({ available: '25.50', total_refund: '5.50' });
}, 20_000);

native('withdrawal-first still completes the customer refund without revoking the admitted withdrawal', async () => {
  const order = await create(true), next = await apply(order.orderId, 1);
  const [withdrawal, refund] = await queued('LOCK TABLE supplier_extract IN SHARE MODE',
    c => extract(c), c => finalizeStoreOrderRefund(c, next.refundId));
  expect(withdrawal.ok).toBe(true); expect(refund).toEqual({ ok: true, value: 'completed' });
  const done = await state(); expect(done.extracts).toHaveLength(1);
  expect(done.extracts[0]).toMatchObject({ extractPrice: '31.00', balance: '0.00', status: 0, payStatus: 0 });
  expect(done.users[0].nowMoney).toBe('13.00');
  expect(await summary()).toMatchObject({ available: '0.00', pending_extract: '31.00', total_refund: '5.50' });
  await expect(extract(f.container, '0.01')).rejects.toThrow('暂无可提现金额');
  expect(await finalizeStoreOrderRefund(f.container, next.refundId)).toBe('already-completed');
  expect(await state()).toEqual(done);
}, 20_000);

native('receipt-first withdrawal sees pending income and its prior refund recognized together', async () => {
  const order = await create(), next = await apply(order.orderId, 1);
  await finalizeStoreOrderRefund(f.container, next.refundId);
  await new SupplierFulfillmentService(f.container, f.env).deliver(7, order.id, shipping);
  const flow = (await state()).flows[0];
  const [receipt, withdrawal] = await queued(`SELECT id FROM supplier_flowing_water WHERE id=${flow.id} FOR UPDATE`,
    c => new SupplierFulfillmentService(c, f.env).confirmTake(7, order.id), c => extract(c, '25.50'));
  expect(receipt.ok).toBe(true); expect(withdrawal.ok).toBe(true);
  expect(await summary()).toMatchObject({ available: '0.00', pending_settlement: '0.00', pending_extract: '25.50' });
}, 20_000);

native('two simultaneous withdrawals cannot reserve the same available balance', async () => {
  await create(true);
  const [first, second] = await queued('LOCK TABLE supplier_extract IN SHARE MODE', c => extract(c), c => extract(c));
  expect(first.ok).toBe(true); expect(second.ok).toBe(false);
  if (!second.ok) expect(String(second.error)).toContain('暂无可提现金额');
  expect((await state()).extracts).toHaveLength(1);
}, 20_000);

native('withdrawal admission does not inherit a stale repeatable-read snapshot from session defaults', async () => {
  await create(true);
  const [first, second] = await queued('LOCK TABLE supplier_extract IN SHARE MODE', c => extract(c), c => extract(c), true);
  expect(first.ok).toBe(true); expect(second.ok).toBe(false);
  if (!second.ok) expect(String(second.error)).toContain('暂无可提现金额');
  expect((await state()).extracts).toHaveLength(1);
}, 20_000);

native('admin rejection-first releases its reservation before the waiting withdrawal reads it', async () => {
  await create(true); await extract(f.container); const old = (await state()).extracts[0];
  const [review, withdrawal] = await queued(`SELECT id FROM supplier_extract WHERE id=${old.id} FOR UPDATE`,
    c => new AdminSupplierFinanceService(c).review(old.id, 19, { type: -1, message: 'Local test rejection' }), c => extract(c));
  expect(review.ok).toBe(true); expect(withdrawal.ok).toBe(true);
  expect((await state()).extracts.map(row => [row.extractPrice, row.status])).toEqual([['31.00', -1], ['31.00', 0]]);
  expect(await summary()).toMatchObject({ available: '0.00', pending_extract: '31.00' });
}, 20_000);

native('withdrawal-first does not include an uncommitted receipt in its admission balance', async () => {
  const order = await create();
  await f.db.insert(supplierFlowingWater).values({ supplierId: 7, uid: 11, orderId: 'received-other-order',
    linkId: 'other-order', pm: 1, type: 1, number: '5.00', status: 1 });
  await new SupplierFulfillmentService(f.container, f.env).deliver(7, order.id, shipping);
  const [withdrawal, receipt] = await queued('LOCK TABLE supplier_extract IN SHARE MODE',
    c => extract(c, '5.00'), c => new SupplierFulfillmentService(c, f.env).confirmTake(7, order.id));
  expect(withdrawal.ok).toBe(true); expect(receipt.ok).toBe(true);
  expect((await state()).extracts[0]).toMatchObject({ extractPrice: '5.00', balance: '0.00' });
  expect(await summary()).toMatchObject({ available: '31.00', pending_settlement: '0.00', pending_extract: '5.00' });
}, 20_000);

native('late refund rollback releases its mutex and preserves the waiting withdrawal balance', async () => {
  const order = await create(true), next = await apply(order.orderId, 1), before = await state();
  await f.exec(`CREATE FUNCTION fail_queued_refund() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    RAISE EXCEPTION 'local queued refund failure'; END $$;
    CREATE TRIGGER fail_queued_refund BEFORE INSERT ON supplier_transactions FOR EACH ROW EXECUTE FUNCTION fail_queued_refund()`);
  const [refund, withdrawal] = await queued('LOCK TABLE supplier_transactions IN SHARE MODE',
    c => finalizeStoreOrderRefund(c, next.refundId), c => extract(c));
  expect(refund.ok).toBe(false); expect(withdrawal.ok).toBe(true);
  const done = await state(); expect({ ...done, extracts: [] }).toEqual(before);
  expect(done.extracts[0]).toMatchObject({ extractPrice: '31.00', status: 0 });
  await f.exec('DROP TRIGGER fail_queued_refund ON supplier_transactions');
  expect(await finalizeStoreOrderRefund(f.container, next.refundId)).toBe('completed');
  expect((await state()).users[0].nowMoney).toBe('13.00');
  expect(await summary()).toMatchObject({ available: '0.00', total_refund: '5.50', pending_extract: '31.00' });
}, 20_000);

native('failed withdrawal insertion releases its mutex and never blocks the queued refund permanently', async () => {
  const order = await create(true), next = await apply(order.orderId, 1);
  await f.exec(`CREATE FUNCTION fail_queued_extract() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    RAISE EXCEPTION 'local queued withdrawal failure'; END $$;
    CREATE TRIGGER fail_queued_extract BEFORE INSERT ON supplier_extract FOR EACH ROW EXECUTE FUNCTION fail_queued_extract()`);
  const [withdrawal, refund] = await queued('LOCK TABLE supplier_extract IN SHARE MODE',
    c => extract(c), c => finalizeStoreOrderRefund(c, next.refundId));
  expect(withdrawal.ok).toBe(false); expect(refund).toEqual({ ok: true, value: 'completed' });
  expect((await state()).extracts).toEqual([]);
  expect(await summary()).toMatchObject({ available: '25.50', total_refund: '5.50' });
  await f.exec('DROP TRIGGER fail_queued_extract ON supplier_extract');
  await extract(f.container, '25.50'); expect((await state()).extracts).toHaveLength(1);
}, 20_000);

native('a different supplier can withdraw while this supplier refund is still blocked', async () => {
  const order = await create(true), next = await apply(order.orderId, 1), flow = (await state()).flows[0];
  await f.db.insert(systemSupplier).values({ id: 8, adminId: 8, supplierName: 'Independent local supplier', alipayAccount: 'other@example.invalid' });
  await f.db.insert(supplierFlowingWater).values({ supplierId: 8, orderId: 'other-supplier-income',
    linkId: 'other-supplier-order', pm: 1, type: 1, number: '10.00', status: 1 });
  await withFinancePeers(f.db, async ([holder, one, two]) => {
    await holder.exec(`BEGIN; SELECT id FROM supplier_flowing_water WHERE id=${flow.id} FOR UPDATE`);
    const refund = outcome(finalizeStoreOrderRefund(createContainerFromDb(one.db), next.refundId));
    try {
      await waitForFinanceBlock(f.db, one.pid, holder.pid);
      await extract(createContainerFromDb(two.db), '10.00', 8);
      await waitForFinanceBlock(f.db, one.pid, holder.pid);
      expect((await state()).extracts.map(row => row.supplierId)).toEqual([8]);
    } finally {
      await holder.exec('ROLLBACK');
      expect(await refund).toEqual({ ok: true, value: 'completed' });
    }
  });
}, 20_000);

native.each([false, true])('opposing concurrent admin decisions release the reservation at most once; approve-first=%s', async approved => {
  await create(true); await extract(f.container); const old = (await state()).extracts[0];
  const review = (c: Container, approve: boolean) => new AdminSupplierFinanceService(c)
    .review(old.id, approve ? 19 : 20, { type: approve ? 1 : -1, message: 'Local decision' });
  const [first, second] = await queued(`SELECT id FROM supplier_extract WHERE id=${old.id} FOR UPDATE`,
    c => review(c, approved), c => review(c, !approved));
  expect(first.ok).toBe(true); expect(second.ok).toBe(false);
  if (!second.ok) expect(String(second.error)).toContain('已审核');
  expect((await state()).extracts[0]).toMatchObject({ status: approved ? 1 : -1, adminId: approved ? 19 : 20 });
  expect(await summary()).toMatchObject({ available: approved ? '0.00' : '31.00' });
}, 20_000);

it('review and transfer keep paid withdrawals reserved and refuse repeats or missing records', async () => {
  await create(true); await extract(f.container); const old = (await state()).extracts[0];
  const admin = new AdminSupplierFinanceService(f.container);
  const voucher = { voucher_title: 'Local fixture only', voucher_image: 'https://example.invalid/local-voucher.png' };
  await expect(admin.review(999, 19, { type: 1 })).rejects.toThrow('不存在');
  await expect(admin.transfer(old.id, 19, voucher)).rejects.toThrow('请先审核');
  await admin.review(old.id, 19, { type: 1 }); await admin.transfer(old.id, 19, voucher);
  const done = await state(); expect(done.extracts[0]).toMatchObject({ status: 1, payStatus: 1 });
  expect(await summary()).toMatchObject({ available: '0.00', paid_extract: '31.00' });
  await expect(admin.review(old.id, 20, { type: -1, message: 'Cannot release paid amount' })).rejects.toThrow('已审核');
  await expect(admin.transfer(old.id, 19, voucher)).rejects.toThrow('已经完成');
  await expect(extract(f.container, '0.01')).rejects.toThrow('暂无可提现金额');
  expect(await state()).toEqual(done);
});
