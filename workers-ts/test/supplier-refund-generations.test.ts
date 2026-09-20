import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { StoreOrderCreateService } from '../src/services/order/StoreOrderCreateService';
import { allocatePaidOrderBySupplier } from '../src/services/order/OrderSupplierAllocationService';
import { reserveChildOrderIds, SupplierFulfillmentService } from '../src/services/supplier/SupplierFulfillmentService';
import { recordSupplierPayment, SupplierFinanceService } from '../src/services/supplier/SupplierFinanceService';
import { applyOrderRefund, finalizeStoreOrderRefund } from '../src/services/order/StoreOrderRefundService';
import { materializeCompletedRefundOrder, type RefundMaterializationIdentity } from '../src/services/order/RefundOrderMaterialization';
import { storeOrderRefundSplit, storeOrderFulfillmentBranch } from '../src/models/schema/order_refund_split';
import { REFUND_ORDER_SPLIT_SQL } from '../src/migrations/refundOrderSplit';
import { createContainerFromDb, withTx, type DbClient } from '../src/lib/di';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';
import { agentLevel, printDocument, storeCart, storeOrder, storeOrderCartInfo, storeOrderRefund,
  storeOrderStatus, storeProduct, storeProductAttrValue, storeOrderInvoice, storeOrderRefundPayment,
  storeOrderOutbox, orderWaybillJob, userBrokerage, systemSupplier, supplierFlowingWater,
  supplierTransactions, supplierExtract, user } from '../src/models/schema';

let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
let request = 0;
const shipping = { deliveryType: 'express', deliveryName: 'Local', deliveryCode: 'local',
  deliveryId: 'NO-SHIPMENT', fictitiousContent: '', deliveryUid: 0 } as const;
const order = async (id: number) => (await f.db.select().from(storeOrder).where(eq(storeOrder.id, id)))[0];
const carts = (id: number) => f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, id)).orderBy(storeOrderCartInfo.id);
const state = async () => ({ ...await f.snapshot(),
  flows: await f.db.select().from(supplierFlowingWater).orderBy(supplierFlowingWater.id),
  transactions: await f.db.select().from(supplierTransactions).orderBy(supplierTransactions.id),
  extracts: await f.db.select().from(supplierExtract).orderBy(supplierExtract.id),
  carts: await f.db.select().from(storeOrderCartInfo).orderBy(storeOrderCartInfo.id),
  refunds: await f.db.select().from(storeOrderRefund).orderBy(storeOrderRefund.id),
  records: await f.db.select().from(storeOrderRefundSplit).orderBy(storeOrderRefundSplit.refundId),
  branches: await f.db.select().from(storeOrderFulfillmentBranch).orderBy(storeOrderFulfillmentBranch.id),
  brokerages: await f.db.select().from(userBrokerage).orderBy(userBrokerage.id),
  outbox: await f.db.select().from(storeOrderOutbox).orderBy(storeOrderOutbox.id),
  statuses: await f.db.select().from(storeOrderStatus).orderBy(storeOrderStatus.id) });
const summary = (id = 7) => new SupplierFinanceService(f.container, f.env).summary(id);
const receive = async (id: number) => {
  const current = await order(id), service = new SupplierFulfillmentService(f.container, f.env);
  if (current.status === 0) await service.deliver(current.supplierId, id, shipping);
  await service.confirmTake(current.supplierId, id);
};
const create = async (received = false, mixed = false, useIntegral = false) => {
  if (mixed) {
    await f.db.insert(systemSupplier).values({ id: 8, adminId: 8, supplierName: 'Other local supplier' });
    await f.db.insert(storeProduct).values({ id: 72, storeName: 'Independent goods', type: 2, relationId: 8, price: '10.00', stock: 8, isShow: 1, freight: 1 });
    await f.db.insert(storeProductAttrValue).values({ id: 3, productId: 72, unique: 'supg0072', suk: 'Standard', price: '10.00', settlePrice: '4.00', stock: 8 });
    await f.db.insert(storeCart).values({ id: 3, uid: 11, productId: 72, productAttrUnique: 'supg0072', cartNum: 1, status: 1, isNew: 1 });
  }
  const created = await StoreOrderCreateService.createWithRuntime(f.container,
    { CONFIG_KV: f.env.CONFIG_KV, nextOrderId: async () => 'supplier_generations' },
    { uid: 11, key: 'supplier-generations', cartIds: mixed ? [1, 2, 3] : [1, 2], addressId: 11, userIp: '127.0.0.1', useIntegral });
  const [paid] = await f.db.update(storeOrder).set({ paid: 1, payType: 'yue', payTime: 100 })
    .where(eq(storeOrder.orderId, created.orderId)).returning();
  const source = await withTx(f.container, async tx => {
    const allocated = await allocatePaidOrderBySupplier(tx, paid.id, paid.orderId, 100);
    for (const child of allocated.fulfillmentOrders) await recordSupplierPayment(tx, child, 100);
    return allocated.fulfillmentOrders.find(row => row.supplierId === 7)!;
  });
  if (received) await receive(source.id);
  return source;
};
const refund = async (id: number, productId: number, quantity = 1, cents?: number) => {
  const source = await order(id), cart = (await carts(id)).find(row => row.productId === productId)!;
  const application = await applyOrderRefund(f.container, { uid: 11, orderId: source.orderId, applyType: cents === undefined ? 1 : 4,
    applicationOrderId: `supplier_generation_${++request}`, refundReason: 'Local generation test', refundExplain: '',
    cartSelections: [{ cartId: Number(cart.cartId), cartNum: quantity }],
    ...(cents === undefined ? {} : { privilegedActor: 'admin', requestedRefundAmountCents: cents, authorizeApplication: async () => {} }) });
  expect(await finalizeStoreOrderRefund(f.container, application.refundId)).toBe('completed');
  return (await f.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.id, application.refundId)))[0];
};
const materialize = (identity: RefundMaterializationIdentity, db: DbClient = f.db) =>
  withTx(createContainerFromDb(db), tx => materializeCompletedRefundOrder(tx, identity, 1789473000));
const splitDelivery = async (id: number, quantity = 1, db: DbClient = f.db) => {
  const line = (await carts(id)).find(row => row.productId === 70)!;
  return new SupplierFulfillmentService(createContainerFromDb(db), f.env)
    .splitDelivery(7, id, shipping, [{ cartId: line.cartId, cartNum: quantity }]);
};
beforeEach(async () => {
  request = 0;
  f = await createPcCheckoutQuoteFixture([agentLevel, printDocument, storeOrderCartInfo, storeOrderRefund, storeOrderStatus,
    storeOrderInvoice, storeOrderRefundPayment, storeOrderOutbox, orderWaybillJob, userBrokerage, systemSupplier,
    supplierFlowingWater, supplierTransactions, supplierExtract]);
  await f.exec(REFUND_ORDER_SPLIT_SQL);
  await f.exec('CREATE UNIQUE INDEX supplier_gen_event ON store_order_outbox(event_key); CREATE UNIQUE INDEX supplier_gen_flow ON supplier_flowing_water(order_id); CREATE UNIQUE INDEX supplier_gen_transaction ON supplier_transactions(order_id)');
  await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
  await f.db.insert(systemSupplier).values({ id: 7, adminId: 7, supplierName: 'Local supplier', alipayAccount: 'local@example.invalid' });
  await f.db.update(storeProduct).set({ type: 2, relationId: 7, freight: 2, tempId: 0, postage: '3.00' }).where(eq(storeProduct.id, 70));
  await f.db.update(storeProductAttrValue).set({ settlePrice: '2.50', cost: '2.00' }).where(eq(storeProductAttrValue.id, 1));
  await f.db.insert(storeProduct).values({ id: 71, storeName: 'Different margin', type: 2, relationId: 7, price: '30.00', stock: 8, isShow: 1, freight: 1 });
  await f.db.insert(storeProductAttrValue).values({ id: 2, productId: 71, unique: 'supg0071', suk: 'Standard', price: '30.00', settlePrice: '20.00', stock: 8 });
  await f.db.insert(storeCart).values({ id: 2, uid: 11, productId: 71, productAttrUnique: 'supg0071', cartNum: 1, status: 1, isNew: 1 });
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
}, 30_000);
afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); } });

it.each([false, true])('completes three supplier refunds across physical generations; received=%s', async received => {
  const source = await create(received), firstRefund = await refund(source.id, 70);
  const first = await materialize(firstRefund), remaining = first.remainingOrderId!;
  const secondRefund = await refund(remaining, 70);
  await materialize(secondRefund);
  const thirdRefund = await refund(remaining, 71), beforeWhole = await state();
  const third = await materialize(thirdRefund), done = await state();
  expect(third).toMatchObject({ disposition: 'whole', selectedOrderId: remaining, remainingOrderId: null });
  expect(done.flows).toEqual(beforeWhole.flows);
  expect(done.transactions).toEqual(beforeWhole.transactions);
  expect(done.refunds.map(row => row.refundedPrice)).toEqual(['13.00', '13.00', '30.00']);
  expect(done.users[0].nowMoney).toBe('56.00');
  expect(await summary()).toMatchObject({ available: '0.00', pending_settlement: '0.00', total_income: '31.00', total_refund: '31.00' });
  const committed = await state();
  for (const original of [firstRefund, secondRefund, thirdRefund]) {
    expect(await finalizeStoreOrderRefund(f.container, original.id)).toBe('already-completed');
    expect((await materialize(original)).replayed).toBe(true);
  }
  expect(await state()).toEqual(committed);
});

it.each(['selected', 'remaining'] as const)('refunds the %s branch after splitting a materialized remainder for delivery', async branch => {
  const source = await create(), first = await materialize(await refund(source.id, 70));
  const remaining = first.remainingOrderId!, line = (await carts(remaining)).find(row => row.productId === 70)!;
  const split = await new SupplierFulfillmentService(f.container, f.env).splitDelivery(7, remaining,
    shipping, [{ cartId: line.cartId, cartNum: 1 }]);
  const target = branch === 'selected' ? split.order_id : split.remaining_order_id;
  await materialize(await refund(target!, branch === 'selected' ? 70 : 71));
});

it.each([false, true])('keeps independent received incomes through repeated forks and refunds; paymentGifts=%s', async paymentGifts => {
  await f.setConfig({ integral_ratio_status: '1', integral_ratio: '0.01', integral_max_type: '1', integral_max_num: '100' });
  Object.assign(f.config, { brokerage_func_status: '1', store_brokerage_statu: '1', brokerage_level: '1',
    brokerage_compute_type: '1', store_brokerage_ratio: '10', order_give_integral: paymentGifts ? '3' : '0' });
  await f.db.update(user).set({ spreadUid: 22 }).where(eq(user.uid, 11));
  await f.db.insert(user).values({ uid: 22, account: 'Local fork referrer', status: 1, isPromoter: 1, spreadOpen: 1 });
  await f.db.update(storeProduct).set({ giveIntegral: '100.00', isSub: 1 }).where(eq(storeProduct.id, 70));
  await f.db.update(storeProductAttrValue).set({ brokerage: '0.30' }).where(eq(storeProductAttrValue.id, 1));
  await f.db.update(storeCart).set({ cartNum: 6 }).where(eq(storeCart.id, 1));
  const source = await create(false, false, true), firstRefund = await refund(source.id, 70);
  expect(source.payPrice).toBe('107.00');
  const first = await materialize(firstRefund), remaining = first.remainingOrderId!;
  const secondRefund = await refund(remaining, 70); await materialize(secondRefund);
  const beforeFork = await state(), firstFork = await splitDelivery(remaining, 2);
  expect(firstFork.remaining_order_id).toBe(remaining);
  const forked = await state(); expect(forked.refunds).toEqual(beforeFork.refunds);
  expect(forked.transactions).toEqual(beforeFork.transactions);
  expect(forked.bills).toEqual(beforeFork.bills); expect(forked.users).toEqual(beforeFork.users);
  const retainedEvidence = forked.branches.find(row => row.childOrderId === remaining)!;
  expect(JSON.parse(retainedEvidence.materializedRefunds).map((entry: [number, string]) => entry[0])).toEqual([secondRefund.id]);
  expect(JSON.parse(retainedEvidence.coveredRefunds)).toHaveLength(2);
  await receive(firstFork.order_id);
  const credited = await state();
  expect(credited.brokerages.filter(row => row.pm === 1).map(row => [row.linkId, row.number])).toEqual([[String(firstFork.order_id), '0.60']]);
  await materialize(await refund(firstFork.order_id, 70));
  await materialize(await refund(firstFork.order_id, 70));
  expect((await state()).users.find(row => row.uid === 22)?.brokeragePrice).toBe('0.00');
  const secondFork = await splitDelivery(remaining);
  await receive(secondFork.order_id);
  const siblingIncome = (await state()).brokerages.filter(row => row.linkId === String(secondFork.order_id));
  // The retained sibling must not consume the new received branch's income.
  await materialize(await refund(remaining, 70)); await materialize(await refund(remaining, 71));
  expect((await state()).brokerages.filter(row => row.linkId === String(secondFork.order_id))).toEqual(siblingIncome);
  await materialize(await refund(secondFork.order_id, 70));
  const done = await state();
  expect(done.users.find(row => row.uid === 11)).toMatchObject({ integral: 100, nowMoney: '107.00' });
  expect(done.users.find(row => row.uid === 22)?.brokeragePrice).toBe('0.00');
  expect(done.bills.filter(row => row.type === 'pay_product_integral_back').reduce((sum, row) => sum + Number(row.number), 0)).toBe(100);
  expect(done.brokerages.filter(row => row.pm === 0).every(row => [String(firstFork.order_id), String(secondFork.order_id)].includes(row.linkId))).toBe(true);
  expect(done.branches).toHaveLength(4);
  expect(await summary()).toMatchObject({ available: '0.00', pending_settlement: '0.00', total_refund: '53.00', total_income: '53.00' });
  for (const original of done.refunds) {
    expect(await finalizeStoreOrderRefund(f.container, original.id)).toBe('already-completed');
    expect((await materialize(original)).replayed).toBe(true);
  }
  expect(await state()).toEqual(done);
});

it('does not give a mixed payment sibling any branch history or supplier refund', async () => {
  const source = await create(false, true), first = await materialize(await refund(source.id, 70));
  const before = await state(), other = before.orders.find(row => row.supplierId === 8)!;
  const fork = await splitDelivery(first.remainingOrderId!);
  await receive(fork.order_id);
  await materialize(await refund(fork.order_id, 70)); await materialize(await refund(fork.remaining_order_id!, 71));
  const done = await state();
  expect(done.orders.find(row => row.id === other.id)).toEqual(other);
  expect(done.flows.filter(row => row.supplierId === 8)).toEqual(before.flows.filter(row => row.supplierId === 8));
  expect(await summary(8)).toMatchObject({ pending_settlement: '4.00', total_refund: '0.00' });
});

it.each(['store_order_fulfillment_branch', 'store_order_status', 'store_order_outbox'] as const)
  ('rolls back both branch baselines and child ledgers on a late %s failure', async table => {
  const source = await create(), first = await materialize(await refund(source.id, 70)), before = await state();
  await f.exec(`CREATE FUNCTION fail_fulfillment_branch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    RAISE EXCEPTION 'local branch failure'; END $$;
    CREATE TRIGGER fail_fulfillment_branch BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_fulfillment_branch()`);
  await expect(splitDelivery(first.remainingOrderId!)).rejects.toThrow(); expect(await state()).toEqual(before);
  await f.exec(`DROP TRIGGER fail_fulfillment_branch ON ${table}`);
  const fork = await splitDelivery(first.remainingOrderId!); expect((await state()).branches).toHaveLength(2);
  await materialize(await refund(fork.order_id, 70));
});

it.each(['owner', 'child', 'root', 'source-refund', 'source-branch', 'partition', 'covered', 'duplicate-bill', 'cross-child-marker'] as const)
  ('rejects corrupt durable branch evidence %s before refund writes', async kind => {
  const source = await create(), first = await materialize(await refund(source.id, 70)), fork = await splitDelivery(first.remainingOrderId!);
  const records = (await state()).branches, record = records.find(row => row.childOrderId === fork.remaining_order_id)!;
  // Disposable owner-only corruption. This is not a production ACL claim.
  await f.exec('ALTER TABLE store_order_fulfillment_branch DISABLE TRIGGER sofb_no_rewrite');
  const change: Partial<typeof storeOrderFulfillmentBranch.$inferInsert> = {};
  if (kind === 'owner') change.uid = 22;
  if (kind === 'child') change.childOrderId = source.id;
  if (kind === 'root') change.paymentOrderId = fork.order_id;
  if (kind === 'source-refund') change.sourceRefundId = 99999;
  if (kind === 'source-branch') change.sourceBranchId = 'a'.repeat(32);
  if (kind === 'partition') { const parts = JSON.parse(record.partitions); parts[0].quantity++; change.partitions = JSON.stringify(parts); }
  if (kind === 'covered') change.coveredRefunds = '[]';
  if (kind === 'duplicate-bill') change.returnedPointBillIds = '[1,1]';
  if (kind !== 'cross-child-marker') await f.db.update(storeOrderFulfillmentBranch).set(change).where(eq(storeOrderFulfillmentBranch.id, record.id));
  else {
    const cart = (await carts(fork.remaining_order_id!))[0], info = JSON.parse(cart.cartInfo!);
    info.refund_order_generation.branchId = records.find(row => row.childOrderId === fork.order_id)!.id;
    await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify(info) }).where(eq(storeOrderCartInfo.id, cart.id));
  }
  await f.exec('ALTER TABLE store_order_fulfillment_branch ENABLE TRIGGER sofb_no_rewrite');
  const before = await state(); await expect(refund(fork.remaining_order_id!, 71)).rejects.toThrow('证据'); expect(await state()).toEqual(before);
});

it.each(['UPDATE store_order_fulfillment_branch SET uid=22', 'DELETE FROM store_order_fulfillment_branch',
  'TRUNCATE store_order_fulfillment_branch'])('keeps branch evidence append-only: %s', async statement => {
  const source = await create(), first = await materialize(await refund(source.id, 70)); await splitDelivery(first.remainingOrderId!);
  const before = await state(); await expect(f.exec(statement)).rejects.toThrow(); expect(await state()).toEqual(before);
});

it('keeps ordinary unmarked fulfillment independent of both candidate tables', async () => {
  const source = await create();
  await f.exec('DROP TABLE store_order_fulfillment_branch; DROP TABLE store_order_refund_split');
  const fork = await splitDelivery(source.id);
  expect(fork.split).toBe(true); expect((await refund(fork.order_id, 70)).refundedPrice).toBe('13.00');
});

it('replays a completed fork without creating new baselines, flows, carts or notices', async () => {
  const source = await create(), first = await materialize(await refund(source.id, 70)), remaining = first.remainingOrderId!;
  const cart = (await carts(remaining)).find(row => row.productId === 70)!;
  const service = new SupplierFulfillmentService(f.container, f.env);
  const options = { replay: { accountId: 7, requestHash: 'a'.repeat(64), changeType: 'out_order_split_delivery' as const } };
  const original = await service.splitDelivery(7, remaining, shipping, [{ cartId: cart.cartId, cartNum: 1 }], options);
  const before = await state();
  expect(await service.splitDelivery(7, remaining, shipping, [{ cartId: cart.cartId, cartNum: 1 }], options)).toEqual({ ...original, idempotent: true });
  expect(await state()).toEqual(before);
});

it('refuses a marked fork with a missing candidate branch table and never auto-installs it', async () => {
  const source = await create(), first = await materialize(await refund(source.id, 70)), before = await state();
  await f.exec('ALTER TABLE store_order_fulfillment_branch RENAME TO local_saved_branch');
  try { await expect(splitDelivery(first.remainingOrderId!)).rejects.toThrow(); }
  finally { await f.exec('ALTER TABLE local_saved_branch RENAME TO store_order_fulfillment_branch'); }
  expect(await state()).toEqual(before);
});

it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('revalidates refund generation after the fulfillment cart-row wait', async () => {
  const source = await create(), first = await materialize(await refund(source.id, 70)), remaining = first.remainingOrderId!;
  const cart = (await carts(remaining))[0]; let changed: Awaited<ReturnType<typeof state>> | undefined;
  await withFinancePeers(f.db, async ([holder, worker]) => {
    await holder.exec(`BEGIN; SELECT id FROM store_order_cart_info WHERE id=${cart.id} FOR UPDATE`);
    const work = outcome(splitDelivery(remaining, 1, worker.db));
    try {
      await waitForFinanceBlock(f.db, worker.pid, holder.pid);
      const info = JSON.parse(cart.cartInfo!); info.refund_order_generation.refundId = 99999;
      await holder.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify(info) }).where(eq(storeOrderCartInfo.id, cart.id));
      await holder.exec('COMMIT'); changed = await state();
    } finally { await holder.exec('ROLLBACK'); }
    expect((await work).ok).toBe(false);
  });
  expect(await state()).toEqual(changed);
}, 20_000);

it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('serializes two genuine fulfillment forks at the payment root and reads the new baseline', async () => {
  await f.db.update(storeCart).set({ cartNum: 6 }).where(eq(storeCart.id, 1));
  const source = await create(), first = await materialize(await refund(source.id, 70)), remaining = first.remainingOrderId!;
  await withFinancePeers(f.db, async ([holder, left, right]) => {
    await holder.exec(`BEGIN; SELECT id FROM store_order WHERE id=${source.id} FOR UPDATE`);
    const a = outcome(splitDelivery(remaining, 1, left.db));
    const ready = await outcome(waitForFinanceBlock(f.db, left.pid, holder.pid));
    const b = outcome(splitDelivery(remaining, 1, right.db));
    const blocked = await outcome(waitForFinanceBlock(f.db, right.pid, left.pid));
    await holder.exec('COMMIT');
    const results = await Promise.all([a, b]);
    expect(ready.ok).toBe(true); expect(blocked.ok).toBe(true); expect(results.every(result => result.ok)).toBe(true);
  });
  expect((await state()).branches).toHaveLength(4);
  expect((await carts(remaining)).find(row => row.productId === 70)?.cartNum).toBe(3);
  await materialize(await refund(remaining, 70));
}, 20_000);

it.each([false, true])('derives exact owned entitlements without rewriting original transactions or flow amounts; received=%s', async received => {
  const source = await create(received), firstRefund = await refund(source.id, 70), before = await state(), balance = await summary();
  const split = await materialize(firstRefund), done = await state();
  for (const original of before.flows) expect(done.flows.find(row => row.id === original.id)).toEqual({ ...original, status: -1 });
  expect(done.transactions).toEqual(before.transactions); expect(done.refunds).toEqual(before.refunds);
  expect(done.users).toEqual(before.users); expect(done.products).toEqual(before.products); expect(done.skus).toEqual(before.skus);
  const selected = await order(split.selectedOrderId), remaining = await order(split.remainingOrderId!);
  const active = done.flows.filter(row => row.status >= 0);
  expect(active.filter(row => row.linkId === selected.orderId).map(row => [row.pm, row.number, row.status]))
    .toEqual([[1, '5.50', 1], [0, '5.50', 1]]);
  expect(active.find(row => row.linkId === remaining.orderId)).toMatchObject({ pm: 1, number: '25.50', status: received ? 1 : 0,
    payPrice: remaining.payPrice, totalPrice: remaining.totalPrice, payPostage: remaining.payPostage });
  expect(JSON.parse(done.records[0].sourceSnapshot).supplierLedger).toEqual({ version: 'supplier-refund-ledger-v1',
    income: before.flows[0], expense: before.flows[1], transaction: before.transactions[1], derivedFlowIds: active.map(row => row.id) });
  expect(await summary()).toMatchObject({ available: balance.available, pending_settlement: balance.pending_settlement, total_refund: balance.total_refund });
});

it('receives and withdraws the remaining entitlement between generations without refusing later customer refunds', async () => {
  const source = await create(), first = await materialize(await refund(source.id, 70)), remaining = first.remainingOrderId!;
  await receive(remaining); expect(await summary()).toMatchObject({ available: '25.50', pending_settlement: '0.00' });
  await new SupplierFinanceService(f.container, f.env).applyExtract(7, { extract_type: 'alipay', money: '25.50' });
  await materialize(await refund(remaining, 70)); await materialize(await refund(remaining, 71));
  expect(await summary()).toMatchObject({ available: '0.00', pending_extract: '25.50', total_income: '31.00', total_refund: '31.00' });
  expect((await state()).users[0].nowMoney).toBe('56.00');
});

it('retains the supplier-child identity under a mixed payment root without consuming the other supplier income', async () => {
  const source = await create(false, true), other = (await state()).orders.find(row => row.supplierId === 8)!;
  expect(source.pid).toBeGreaterThan(0); await receive(other.id);
  const otherFlows = (await state()).flows.filter(row => row.supplierId === 8);
  const first = await materialize(await refund(source.id, 70)); expect(first.remainingOrderId).toBe(source.id);
  await materialize(await refund(source.id, 70)); await materialize(await refund(source.id, 71));
  expect((await state()).flows.filter(row => row.supplierId === 8)).toEqual(otherFlows);
  expect(await summary(8)).toMatchObject({ available: '4.00', total_refund: '0.00' });
  expect(await summary()).toMatchObject({ available: '0.00', pending_settlement: '0.00', total_refund: '31.00' });
});

it('keeps supplier goods allocations independent of approved customer cash concessions', async () => {
  const source = await create(), first = await materialize(await refund(source.id, 70, 2, 100));
  expect(await summary()).toMatchObject({ available: '0.00', pending_settlement: '20.00', total_refund: '11.00' });
  await materialize(await refund(first.remainingOrderId!, 71, 1, 100));
  expect(await summary()).toMatchObject({ available: '0.00', pending_settlement: '0.00', total_refund: '31.00', total_income: '31.00' });
  expect((await state()).transactions.filter(row => row.pm === 0).map(row => row.payPrice)).toEqual(['1.00', '1.00']);
  expect((await state()).users[0].nowMoney).toBe('2.00');
});

it('preserves genuine zero supplier settlement across partial and whole refund generations', async () => {
  await f.db.update(storeProduct).set({ freight: 1, postage: '0.00' }); await f.db.update(storeProductAttrValue).set({ settlePrice: '0.00' });
  const source = await create(), first = await materialize(await refund(source.id, 70));
  await materialize(await refund(first.remainingOrderId!, 70)); await materialize(await refund(first.remainingOrderId!, 71));
  expect((await state()).flows.every(row => row.number === '0.00')).toBe(true);
  expect(await summary()).toMatchObject({ available: '0.00', pending_settlement: '0.00', total_refund: '0.00' });
});

it.each(['income-amount', 'income-owner', 'income-payment', 'income-status', 'expense-amount', 'expense-owner',
  'expense-identity', 'missing-expense', 'extra-expense', 'transaction-payment'] as const)
  ('rejects inconsistent original supplier evidence %s and rolls back all child writes', async kind => {
  const source = await create(), completed = await refund(source.id, 70), beforeCorruption = await state();
  const [income, expense] = beforeCorruption.flows;
  if (kind === 'income-amount') await f.db.update(supplierFlowingWater).set({ number: '31.01' }).where(eq(supplierFlowingWater.id, income.id));
  if (kind === 'income-owner') await f.db.update(supplierFlowingWater).set({ uid: 22 }).where(eq(supplierFlowingWater.id, income.id));
  if (kind === 'income-payment') await f.db.update(supplierFlowingWater).set({ payPrice: '56.01' }).where(eq(supplierFlowingWater.id, income.id));
  if (kind === 'income-status') await f.db.update(supplierFlowingWater).set({ status: 1 }).where(eq(supplierFlowingWater.id, income.id));
  if (kind === 'expense-amount') await f.db.update(supplierFlowingWater).set({ number: '5.51' }).where(eq(supplierFlowingWater.id, expense.id));
  if (kind === 'expense-owner') await f.db.update(supplierFlowingWater).set({ uid: 22 }).where(eq(supplierFlowingWater.id, expense.id));
  if (kind === 'expense-identity') await f.db.update(supplierFlowingWater).set({ orderId: 'different-refund' }).where(eq(supplierFlowingWater.id, expense.id));
  if (kind === 'missing-expense') await f.db.delete(supplierFlowingWater).where(eq(supplierFlowingWater.id, expense.id));
  if (kind === 'extra-expense') await f.db.insert(supplierFlowingWater).values({ supplierId: 7, uid: 11, orderId: 'unexpected-extra', linkId: source.orderId, pm: 0, type: 2, number: '0.00', status: 0 });
  if (kind === 'transaction-payment') await f.db.update(supplierTransactions).set({ payPrice: '13.01' }).where(eq(supplierTransactions.orderId, expense.orderId));
  const before = await state(); await expect(materialize(completed)).rejects.toThrow('账本'); expect(await state()).toEqual(before);
});

it.each(['supplier_flowing_water', 'store_order_refund_split', 'store_order_status'] as const)
  ('late %s insert failure rolls back retirement and child entitlements, then retries once', async table => {
  const source = await create(true), completed = await refund(source.id, 70), before = await state();
  await f.exec(`CREATE FUNCTION fail_supplier_generation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    RAISE EXCEPTION 'local supplier generation failure'; END $$;
    CREATE TRIGGER fail_supplier_generation BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_supplier_generation()`);
  await expect(materialize(completed)).rejects.toThrow(); expect(await state()).toEqual(before);
  await f.exec(`DROP TRIGGER fail_supplier_generation ON ${table}`);
  const split = await materialize(completed), done = await state();
  expect((await materialize(completed)).replayed).toBe(true); expect(await state()).toEqual(done);
  expect(await summary()).toMatchObject({ available: '25.50', total_refund: '5.50' });
  await materialize(await refund(split.remainingOrderId!, 70));
});

it.each([0, 1])('rejects an existing unrelated future-child flow; pm=%s', async pm => {
  const source = await create(), completed = await refund(source.id, 70);
  expect(source.pid).toBe(0);
  const [futureChildNo] = reserveChildOrderIds(source.orderId, [], 2);
  await f.db.insert(supplierFlowingWater).values({ supplierId: 7, uid: 11, orderId: 'unowned-future-child-flow',
    linkId: futureChildNo, pm, type: pm ? 1 : 2, number: '0.01', status: 1 });
  const before = await state(); await expect(materialize(completed)).rejects.toThrow('账本'); expect(await state()).toEqual(before);
});

it.each(['income', 'expense'] as const)('does not suppress a derived %s key collision owned by another supplier', async kind => {
  const source = await create(), completed = await refund(source.id, 70), initial = await state();
  expect(initial.orders.map(row => row.id)).toEqual([1]);
  // The fresh fixture has one order and no prior failed inserts: the observed
  // materializer's first new child is ID 2. This is not runtime ID allocation.
  const parent = initial.flows.find(row => row.pm === (kind === 'income' ? 1 : 0))!;
  await f.db.insert(supplierFlowingWater).values({ supplierId: 8, uid: 22,
    orderId: `${kind === 'income' ? 'S' : 'D'}${parent.id}-2`, linkId: 'foreign-order', pm: parent.pm, type: parent.type, number: '1.00', status: 1 });
  const before = await state(); await expect(materialize(completed)).rejects.toThrow(); expect(await state()).toEqual(before);
});

it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('revalidates income after a real materialization flow-row wait', async () => {
  const source = await create(), completed = await refund(source.id, 70), income = (await state()).flows[0];
  let changed: Awaited<ReturnType<typeof state>> | undefined;
  await withFinancePeers(f.db, async ([holder, worker]) => {
    await holder.exec(`BEGIN; SELECT id FROM supplier_flowing_water WHERE id=${income.id} FOR UPDATE`);
    const work = outcome(materialize(completed, worker.db));
    try {
      await waitForFinanceBlock(f.db, worker.pid, holder.pid);
      await holder.db.update(supplierFlowingWater).set({ number: '31.01' }).where(eq(supplierFlowingWater.id, income.id));
      await holder.exec('COMMIT'); changed = await state();
    } finally { await holder.exec('ROLLBACK'); }
    expect((await work).ok).toBe(false);
  });
  expect(await state()).toEqual(changed);
}, 20_000);

it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('serializes derived settled-ledger replacement with waiting withdrawal admission', async () => {
  const source = await create(true), completed = await refund(source.id, 70), income = (await state()).flows[0];
  await withFinancePeers(f.db, async ([holder, worker, extractor]) => {
    await holder.exec(`BEGIN; SELECT id FROM supplier_flowing_water WHERE id=${income.id} FOR UPDATE`);
    const work = outcome(materialize(completed, worker.db));
    const ready = await outcome(waitForFinanceBlock(f.db, worker.pid, holder.pid));
    const withdrawal = outcome(new SupplierFinanceService(createContainerFromDb(extractor.db), f.env)
      .applyExtract(7, { extract_type: 'alipay', money: '25.50' }));
    const blocked = await outcome(waitForFinanceBlock(f.db, extractor.pid, worker.pid));
    await holder.exec('COMMIT'); const results = await Promise.all([work, withdrawal]);
    expect(ready.ok).toBe(true); expect(blocked.ok).toBe(true); expect(results.every(result => result.ok)).toBe(true);
  });
  expect(await summary()).toMatchObject({ available: '0.00', pending_extract: '25.50', total_refund: '5.50' });
}, 20_000);
