import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { StoreOrderCreateService } from '../src/services/order/StoreOrderCreateService';
import { SupplierFulfillmentService } from '../src/services/supplier/SupplierFulfillmentService';
import { AdminMobileOrderOperationService } from '../src/services/admin/AdminMobileOrderOperationService';
import { allocatePaidOrderBySupplier } from '../src/services/order/OrderSupplierAllocationService';
import { recordSupplierPayment } from '../src/services/supplier/SupplierFinanceService';
import { INVOICE_EVIDENCE_SQL } from '../src/migrations/invoiceEvidence';
import { createContainerFromDb, withTx, type DbClient } from '../src/lib/di';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';
import { agentLevel, printDocument, storeCart, storeOrder, storeOrderCartInfo, storeOrderInvoice, storeOrderOutbox, storeOrderRefund,
  storeOrderStatus, storeProduct, storeProductAttrValue, systemSupplier, orderWaybillJob, user, userBrokerage, supplierFlowingWater, supplierTransactions } from '../src/models/schema';

let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
const delivery = { deliveryType: 'express' as const, deliveryName: 'Synthetic shipping', deliveryCode: 'local',
  deliveryId: 'NO-SHIPMENT', fictitiousContent: '', deliveryUid: 0 };
function snapshot(value: string | null): Record<string, unknown> {
  if (typeof value !== 'string') throw new Error('Missing snapshot');
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid snapshot');
  return parsed as Record<string, unknown>;
}
const carts = (oid: number) => f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, oid)).orderBy(storeOrderCartInfo.id);
const order = async (oid: number) => (await f.db.select().from(storeOrder).where(eq(storeOrder.id, oid)))[0];
const split = (oid: number, cartId: string, cartNum = 1) => new SupplierFulfillmentService(f.container, f.env)
  .splitDelivery(0, oid, delivery, [{ cartId, cartNum }]);
const create = async (cartIds = [1], useIntegral = false, changedPrice?: string) => {
  const result = await StoreOrderCreateService.createWithRuntime(f.container,
    { CONFIG_KV: f.env.CONFIG_KV, nextOrderId: async () => 'checkout_for_split' },
    { uid: 11, key: 'line_split', cartIds, addressId: 11, userIp: '127.0.0.1', useIntegral });
  const [saved] = await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, result.orderId));
  if (changedPrice !== undefined) await new AdminMobileOrderOperationService(f.container).changePrice(100,
    { order_id: saved.orderId, price: changedPrice });
  // Synthetic paid admission only; this suite does not test or call a payment provider.
  await f.db.update(storeOrder).set({ paid: 1, payType: 'yue' }).where(eq(storeOrder.id, saved.id));
  return saved.id;
};
const state = async () => ({ ...await f.snapshot(), details: await f.db.select().from(storeOrderCartInfo).orderBy(storeOrderCartInfo.id),
  outbox: await f.db.select().from(storeOrderOutbox).orderBy(storeOrderOutbox.id), statuses: await f.db.select().from(storeOrderStatus).orderBy(storeOrderStatus.id) });
const sequence = async () => (await f.db.execute<{ last_value: string }>(sql`SELECT last_value::text FROM store_order_cart_info_id_seq`))[0].last_value;
const secondLine = async () => {
  await f.db.insert(storeProduct).values({ id: 71, storeName: 'Free freight high cost', price: '30.00', stock: 8, isShow: 1, freight: 1 });
  await f.db.insert(storeProductAttrValue).values({ id: 2, productId: 71, unique: 'free0071', suk: 'Standard', price: '30.00', cost: '20.00', stock: 8 });
  await f.db.insert(storeCart).values({ id: 2, uid: 11, productId: 71, productAttrUnique: 'free0071', cartNum: 1, status: 1, isNew: 1 });
};
const supplierLines = async () => {
  await secondLine();
  await f.db.insert(systemSupplier).values({ id: 7, adminId: 7, supplierName: 'Synthetic supplier' });
  // This fixed-freight supplier product must not retain the base fixture's
  // platform-owned template. Keep actual checkout ownership guards enabled.
  await f.db.update(storeProduct).set({ type: 2, relationId: 7, freight: 2, tempId: 0, postage: '3.00', giveIntegral: '0.50' }).where(eq(storeProduct.id, 70));
  await f.db.update(storeProductAttrValue).set({ cost: '2.50' }).where(eq(storeProductAttrValue.id, 1));
};
const allocate = async (oid: number, db = f.db) => {
  const source = await order(oid);
  return withTx(createContainerFromDb(db), tx => allocatePaidOrderBySupplier(tx, oid, source.orderId, 100));
};
beforeEach(async () => {
  f = await createPcCheckoutQuoteFixture([agentLevel, printDocument, storeOrderCartInfo, storeOrderInvoice, storeOrderOutbox,
    storeOrderRefund, storeOrderStatus, systemSupplier, orderWaybillJob, userBrokerage, supplierFlowingWater, supplierTransactions]);
  await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
  await f.exec(INVOICE_EVIDENCE_SQL);
  await f.exec('CREATE UNIQUE INDEX split_fixture_outbox_event ON store_order_outbox(event_key)');
  await f.exec('CREATE UNIQUE INDEX split_fixture_flow ON supplier_flowing_water(order_id); CREATE UNIQUE INDEX split_fixture_transaction ON supplier_transactions(order_id)');
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
}, 30_000);
afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); } });

it('uses the selected line actual freight and cost instead of merchandise-weight totals or cloned cost', async () => {
  await f.db.update(storeProduct).set({ freight: 2, postage: '3.00' }).where(eq(storeProduct.id, 70));
  await f.db.update(storeProductAttrValue).set({ cost: '2.50' }).where(eq(storeProductAttrValue.id, 1));
  await secondLine();
  const oid = await create([1, 2]);
  const result = await split(oid, '1');
  expect(await order(result.order_id)).toMatchObject({ totalPrice: '10.00', cost: '2.50', payPostage: '3.00', totalPostage: '3.00', payPrice: '13.00' });
  expect(await order(result.remaining_order_id!)).toMatchObject({ totalPrice: '40.00', cost: '22.50', payPostage: '3.00', totalPostage: '3.00', payPrice: '43.00' });
  expect(snapshot((await carts(result.order_id))[0].cartInfo)).toMatchObject({ raw_postage_price: '3.00', postage_price: '3.00' });
});

it('retains specified-SKU commission on its selected line rather than allocating the whole order commission by price', async () => {
  await secondLine();
  Object.assign(f.config, { brokerage_func_status: '1', store_brokerage_statu: '1', brokerage_level: '1', brokerage_compute_type: '1', store_brokerage_ratio: '10' });
  await f.db.update(user).set({ spreadUid: 22 }).where(eq(user.uid, 11));
  await f.db.insert(user).values({ uid: 22, account: 'First referrer', status: 1, isPromoter: 1, spreadOpen: 1 });
  await f.db.update(storeProduct).set({ isSub: 1 }).where(eq(storeProduct.id, 70));
  await f.db.update(storeProductAttrValue).set({ brokerage: '0.30' }).where(eq(storeProductAttrValue.id, 1));
  const oid = await create([1, 2]), result = await split(oid, '1');
  expect((await order(oid)).oneBrokerage).toBe('3.60');
  expect((await order(result.order_id)).oneBrokerage).toBe('0.30');
  expect((await order(result.remaining_order_id!)).oneBrokerage).toBe('3.30');
  expect(snapshot((await carts(result.order_id))[0].cartInfo).one_brokerage).toBe('0.30');
  expect(await f.db.select().from(userBrokerage)).toEqual([]);
});

it.each([
  { price: '0.01', selected: '0.00', remaining: '0.01', selectedChange: '13.00', remainingChange: '12.99' },
  { price: '30.00', selected: '14.99', remaining: '15.01', selectedChange: '-1.99', remainingChange: '-2.01' },
  { price: '0.00', selected: '0.00', remaining: '0.00', selectedChange: '13.00', remainingChange: '13.00' },
])('uses actual Admin repricing $price and preserves zero-selected residue and bonus ownership', async expected => {
  const oid = await create([1], false, expected.price);
  await f.db.update(storeOrder).set({ giveIntegral: 7, giveCoupon: '[9]', promotionsGive: '{"source":"synthetic"}' }).where(eq(storeOrder.id, oid));
  const result = await split(oid, '1'), selected = await order(result.order_id), remaining = await order(result.remaining_order_id!);
  expect(selected).toMatchObject({ payPrice: expected.selected, changePrice: expected.selectedChange, giveIntegral: 0, giveCoupon: null, promotionsGive: null });
  expect(remaining).toMatchObject({ payPrice: expected.remaining, changePrice: expected.remainingChange, giveIntegral: 7, giveCoupon: '[9]', promotionsGive: '{"source":"synthetic"}' });
});

it('whole-order delivery preserves original bonuses and snapshots without allocating new cart identities', async () => {
  const oid = await create();
  const before = await carts(oid), seq = await sequence();
  await f.db.update(storeOrder).set({ giveIntegral: 7, giveCoupon: '[9]' }).where(eq(storeOrder.id, oid));
  expect(await split(oid, '1', 2)).toMatchObject({ split: false, order_id: oid });
  expect(await carts(oid)).toEqual(before); expect(await sequence()).toBe(seq);
  expect(await order(oid)).toMatchObject({ giveIntegral: 7, giveCoupon: '[9]' });
});

const corruptions = ['missing-freight', 'bad-money', 'boolean-money', 'fractional-points', 'boolean-integral', 'wrong-id', 'wrong-quantity',
  'cost-mismatch', 'unknown-version', 'removed-version', 'bad-json', 'oversized-json', 'writeoff-mismatch', 'refunded-quantity', 'order-cost', 'order-price', 'returned-points'] as const;
it.each(corruptions)('rejects inconsistent v1 evidence %s before child writes or sequence allocation', async kind => {
  const oid = await create(), [row] = await carts(oid), info = snapshot(row.cartInfo);
  if (kind === 'missing-freight') delete info.raw_postage_price;
  else if (kind === 'bad-money') info.postage_price = 'NaN';
  else if (kind === 'boolean-money') info.postage_price = true;
  else if (kind === 'fractional-points') info.use_integral = '0.50';
  else if (kind === 'boolean-integral') info.integral = true;
  else if (kind === 'wrong-id') info.id = '999';
  else if (kind === 'wrong-quantity') info.cart_num = 99;
  else if (kind === 'cost-mismatch') info.costPrice = '0.01';
  else if (kind === 'unknown-version') info.financial_version = 'unrecognized';
  else if (kind === 'removed-version') delete info.financial_version;
  if (kind === 'writeoff-mismatch') await f.db.update(storeOrderCartInfo).set({ writeTimes: 99 }).where(eq(storeOrderCartInfo.id, row.id));
  else if (kind === 'refunded-quantity') await f.db.update(storeOrderCartInfo).set({ refundNum: 1 }).where(eq(storeOrderCartInfo.id, row.id));
  else if (kind === 'order-cost') await f.db.update(storeOrder).set({ cost: '0.01' }).where(eq(storeOrder.id, oid));
  else if (kind === 'order-price') await f.db.update(storeOrder).set({ payPrice: '1.00' }).where(eq(storeOrder.id, oid));
  else if (kind === 'returned-points') await f.db.update(storeOrder).set({ backIntegral: '1.00' }).where(eq(storeOrder.id, oid));
  else await f.db.update(storeOrderCartInfo).set({ cartInfo: kind === 'bad-json' ? '{' : kind === 'oversized-json'
    ? JSON.stringify({ ...info, extra: 'x'.repeat(65536) }) : JSON.stringify(info) }).where(eq(storeOrderCartInfo.id, row.id));
  const before = await state(), seq = await sequence();
  await expect(split(oid, row.cartId)).rejects.toThrow('快照');
  expect(await state()).toEqual(before); expect(await sequence()).toBe(seq);
});

it('does not silently downgrade a mixed legacy and v1 order to weight allocation', async () => {
  await secondLine(); const oid = await create([1, 2]), rows = await carts(oid);
  const info = snapshot(rows[1].cartInfo); delete info.financial_version;
  await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify(info) }).where(eq(storeOrderCartInfo.id, rows[1].id));
  const before = await state(); await expect(split(oid, '1')).rejects.toThrow('快照'); expect(await state()).toEqual(before);
});

it.each([0, -1, 0.5])('rejects invalid direct-service quantities %s without mutating state', async quantity => {
  const oid = await create(), before = await state();
  await expect(split(oid, '1', quantity)).rejects.toThrow('数量或标识'); expect(await state()).toEqual(before);
});
it('rejects duplicate direct-service selectors instead of turning them into whole-order delivery', async () => {
  const oid = await create(), before = await state();
  await expect(new SupplierFulfillmentService(f.container, f.env).splitDelivery(0, oid, delivery,
    [{ cartId: '1', cartNum: 1 }, { cartId: '1', cartNum: 1 }])).rejects.toThrow('数量或标识');
  expect(await state()).toEqual(before);
});

it('rolls back planned amounts, child snapshots and notices after a late real SQL audit failure', async () => {
  const oid = await create(), before = await state(), seq = BigInt(await sequence());
  await f.exec("CREATE FUNCTION fail_line_split_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'line split audit failure'; END $$; CREATE TRIGGER fail_line_split_audit BEFORE INSERT ON store_order_status FOR EACH ROW EXECUTE FUNCTION fail_line_split_audit()");
  await expect(split(oid, '1')).rejects.toThrow(); expect(await state()).toEqual(before);
  expect(BigInt(await sequence())).toBeGreaterThan(seq); // Normal sequence gaps, never reuse/reset.
});

it('replays committed fulfillment before attempting to recalculate changed source snapshots', async () => {
  const oid = await create(), options = { replay: { accountId: 77, requestHash: 'b'.repeat(64), changeType: 'out_order_split_delivery' as const } };
  const service = new SupplierFulfillmentService(f.container, f.env), selected = [{ cartId: '1', cartNum: 1 }];
  const first = await service.splitDelivery(0, oid, delivery, selected, options);
  const [remaining] = await carts(first.remaining_order_id!);
  await f.db.update(storeOrderCartInfo).set({ cartInfo: '{' }).where(eq(storeOrderCartInfo.id, remaining.id));
  const before = await state(), seq = await sequence();
  expect(await service.splitDelivery(0, oid, delivery, selected, options)).toEqual({ ...first, idempotent: true });
  expect(await state()).toEqual(before); expect(await sequence()).toBe(seq);
});

it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('validates financial evidence read after an independent cart lock wait', async () => {
  const oid = await create(), [cart] = await carts(oid); const info = snapshot(cart.cartInfo); info.raw_postage_price = '0.00';
  let edited: Awaited<ReturnType<typeof state>> | undefined;
  await withFinancePeers(f.db, async ([holder, buyer]) => {
    await holder.exec(`BEGIN; SELECT id FROM store_order_cart_info WHERE id=${cart.id} FOR UPDATE`);
    const buying = outcome(new SupplierFulfillmentService(createContainerFromDb(buyer.db), f.env).splitDelivery(0, oid, delivery, [{ cartId: cart.cartId, cartNum: 1 }]));
    await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
    await holder.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify(info) }).where(eq(storeOrderCartInfo.id, cart.id));
    await holder.exec('COMMIT'); edited = await state();
    const result = await buying; expect(result.ok).toBe(false); if (!result.ok) expect(String(result.error)).toContain('快照');
  });
  expect(await state()).toEqual(edited);
}, 15_000);

it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('concurrent same-receipt splits produce one pair of financial children and one notice', async () => {
  const oid = await create(), [cart] = await carts(oid);
  const options = { replay: { accountId: 77, requestHash: 'c'.repeat(64), changeType: 'out_order_split_delivery' as const } };
  const run = (db: DbClient) => new SupplierFulfillmentService(createContainerFromDb(db), f.env)
    .splitDelivery(0, oid, delivery, [{ cartId: cart.cartId, cartNum: 1 }], options);
  await withFinancePeers(f.db, async ([holder, first, second]) => {
    await holder.exec(`BEGIN; SELECT id FROM store_order_cart_info WHERE id=${cart.id} FOR UPDATE`);
    const firstResult = outcome(run(first.db)); await waitForFinanceBlock(f.db, first.pid, holder.pid);
    const secondResult = outcome(run(second.db)); await waitForFinanceBlock(f.db, second.pid, first.pid);
    await holder.exec('COMMIT');
    const a = await firstResult, b = await secondResult; expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(b.value).toEqual({ ...a.value, idempotent: true });
  });
  const saved = await state(); expect(saved.orders).toHaveLength(3); expect(saved.details).toHaveLength(3); expect(saved.outbox).toHaveLength(1);
  expect(saved.orders.filter(row => row.pid === oid).map(row => row.payPrice)).toEqual(['13.00', '13.00']);
}, 15_000);

it('keeps integer deduction points and PHP line residue through repeated splits', async () => {
  await f.db.update(storeCart).set({ cartNum: 3 }).where(eq(storeCart.id, 1));
  await f.db.update(storeProduct).set({ freight: 1, giveIntegral: '0.50' }).where(eq(storeProduct.id, 70));
  await f.db.update(storeProductAttrValue).set({ price: '0.01' }).where(eq(storeProductAttrValue.id, 1));
  await f.setConfig({ integral_ratio_status: '1', integral_ratio: '0.01', integral_max_type: '1', integral_max_num: '1' });
  const oid = await create([1], true), first = await split(oid, '1');
  expect(await order(first.order_id)).toMatchObject({ payPrice: '0.00', useIntegral: '0.00', gainIntegral: '0.00' });
  expect(await order(first.remaining_order_id!)).toMatchObject({ payPrice: '0.02', useIntegral: '1.00', gainIntegral: '1.00' });
  const [remaining] = await carts(first.remaining_order_id!);
  const second = await split(first.remaining_order_id!, remaining.cartId);
  expect(await order(second.order_id)).toMatchObject({ payPrice: '0.01', useIntegral: '0.00', gainIntegral: '0.00' });
  expect(await order(second.remaining_order_id!)).toMatchObject({ payPrice: '0.01', useIntegral: '1.00', gainIntegral: '1.00' });
  for (const id of [first.order_id, second.order_id, second.remaining_order_id!]) {
    const [row] = await carts(id), info = snapshot(row.cartInfo);
    expect(Number(info.use_integral) % 1).toBe(0);
    expect(row.writeTimes).toBe(row.cartNum); expect(row.writeSurplusTimes).toBe(row.cartNum);
  }
});

it('allocates actual checkout lines to suppliers and retains consistent evidence through a subsequent fulfillment split', async () => {
  await supplierLines();
  Object.assign(f.config, { brokerage_func_status: '1', store_brokerage_statu: '1', brokerage_level: '1', brokerage_compute_type: '1', store_brokerage_ratio: '10' });
  await f.db.update(user).set({ spreadUid: 22 }).where(eq(user.uid, 11));
  await f.db.insert(user).values({ uid: 22, account: 'First referrer', status: 1, isPromoter: 1, spreadOpen: 1 });
  await f.db.update(storeProduct).set({ isSub: 1 }).where(eq(storeProduct.id, 70));
  await f.db.update(storeProductAttrValue).set({ brokerage: '0.30' }).where(eq(storeProductAttrValue.id, 1));
  const oid = await create([1, 2]), rootCarts = await carts(oid), result = await allocate(oid);
  expect(result.split).toBe(true);
  const [supplier, platform] = result.fulfillmentOrders;
  expect(supplier).toMatchObject({ supplierId: 7, totalPrice: '20.00', payPrice: '26.00', payPostage: '6.00', totalPostage: '6.00', cost: '5.00', gainIntegral: '1.00', oneBrokerage: '0.60' });
  expect(platform).toMatchObject({ supplierId: 0, totalPrice: '30.00', payPrice: '30.00', payPostage: '0.00', totalPostage: '0.00', cost: '20.00', gainIntegral: '0.00', oneBrokerage: '3.00' });
  const [supplierCart] = await carts(supplier.id);
  expect(supplierCart.id).not.toBe(rootCarts[0].id);
  expect(snapshot(supplierCart.cartInfo)).toMatchObject({ id: supplierCart.cartId, gain_integral: '1', raw_postage_price: '6.00' });
  const fulfillment = new SupplierFulfillmentService(f.container, f.env);
  expect(await fulfillment.splitCartInfo(7, supplier.id)).toHaveLength(1);
  expect((await fulfillment.splitOrders(7, supplier.id)).map(row => row.id)).toEqual([supplier.id]);
  await withTx(f.container, tx => recordSupplierPayment(tx, supplier, 100));
  const delivered = await fulfillment.splitDelivery(7, supplier.id, delivery, [{ cartId: supplierCart.cartId, cartNum: 1 }]);
  expect(await order(delivered.order_id)).toMatchObject({ payPrice: '13.00', cost: '2.50', oneBrokerage: '0.30', gainIntegral: '0.00' });
  expect(await order(delivered.remaining_order_id!)).toMatchObject({ payPrice: '13.00', cost: '2.50', oneBrokerage: '0.30', gainIntegral: '1.00' });
  expect(await order(platform.id)).toEqual(platform);
  expect(await f.db.select().from(userBrokerage)).toEqual([]);
});

it('preserves the last payment cent and whole-side bonuses across three supplier groups', async () => {
  await supplierLines();
  await f.db.insert(systemSupplier).values({ id: 8, adminId: 8, supplierName: 'Second synthetic supplier' });
  await f.db.update(storeProduct).set({ type: 2, relationId: 8 }).where(eq(storeProduct.id, 71));
  await f.db.insert(storeProduct).values({ id: 72, storeName: 'Platform item', price: '10.00', stock: 8, isShow: 1, freight: 1 });
  await f.db.insert(storeProductAttrValue).values({ id: 3, productId: 72, unique: 'free0072', suk: 'Standard', price: '10.00', cost: '1.00', stock: 8 });
  await f.db.insert(storeCart).values({ id: 3, uid: 11, productId: 72, productAttrUnique: 'free0072', cartNum: 1, status: 1, isNew: 1 });
  const oid = await create([1, 2, 3], false, '0.01');
  await f.db.update(storeOrder).set({ giveIntegral: 7, giveCoupon: '[9]', promotionsGive: '{"source":"synthetic"}' }).where(eq(storeOrder.id, oid));
  const { fulfillmentOrders: children } = await allocate(oid);
  expect(children.map(row => row.supplierId)).toEqual([7, 8, 0]);
  expect(children.map(row => row.payPrice)).toEqual(['0.00', '0.00', '0.01']);
  expect(children.map(row => row.changePrice)).toEqual(['26.00', '30.00', '9.99']);
  expect(children.map(row => row.cost)).toEqual(['5.00', '20.00', '1.00']);
  for (const child of children.slice(0, 2)) expect(child).toMatchObject({ giveIntegral: 0, giveCoupon: null, promotionsGive: null });
  expect(children[2]).toMatchObject({ giveIntegral: 7, giveCoupon: '[9]', promotionsGive: '{"source":"synthetic"}' });
});

it('replays committed supplier allocation without recalculating source or duplicating children', async () => {
  await supplierLines(); const oid = await create([1, 2]), first = await allocate(oid), [row] = await carts(oid);
  await f.db.update(storeOrderCartInfo).set({ cartInfo: '{' }).where(eq(storeOrderCartInfo.id, row.id));
  const before = await state(), seq = await sequence();
  expect((await allocate(oid)).fulfillmentOrders).toEqual(first.fulfillmentOrders);
  expect(await state()).toEqual(before); expect(await sequence()).toBe(seq);
});

it('rolls back every supplier child and audit marker after the final SQL audit write fails', async () => {
  await supplierLines(); const oid = await create([1, 2]), before = await state(), seq = BigInt(await sequence());
  await f.exec("CREATE FUNCTION fail_supplier_finance_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.change_type = 'supplier_order_split' THEN RAISE EXCEPTION 'supplier finance audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_supplier_finance_audit BEFORE INSERT ON store_order_status FOR EACH ROW EXECUTE FUNCTION fail_supplier_finance_audit()");
  await expect(allocate(oid)).rejects.toThrow(); expect(await state()).toEqual(before);
  expect(BigInt(await sequence())).toBeGreaterThan(seq);
});

it.each(['cost', 'mixed'] as const)('rejects inconsistent supplier financial evidence %s without allocating child rows', async kind => {
  await supplierLines(); const oid = await create([1, 2]), [row] = await carts(oid), info = snapshot(row.cartInfo);
  if (kind === 'cost') info.costPrice = '99.00'; else delete info.financial_version;
  await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify(info) }).where(eq(storeOrderCartInfo.id, row.id));
  const before = await state(), seq = await sequence();
  await expect(allocate(oid)).rejects.toThrow('快照'); expect(await state()).toEqual(before); expect(await sequence()).toBe(seq);
});

it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('serializes independent supplier allocations into one financially consistent child set', async () => {
  await supplierLines(); const oid = await create([1, 2]), [cart] = await carts(oid);
  await withFinancePeers(f.db, async ([holder, first, second]) => {
    await holder.exec(`BEGIN; SELECT id FROM store_order_cart_info WHERE id=${cart.id} FOR UPDATE`);
    const a = outcome(allocate(oid, first.db)); await waitForFinanceBlock(f.db, first.pid, holder.pid);
    const b = outcome(allocate(oid, second.db)); await waitForFinanceBlock(f.db, second.pid, first.pid);
    await holder.exec('COMMIT');
    const one = await a, two = await b; expect(one.ok && two.ok).toBe(true);
    if (one.ok && two.ok) expect(two.value.fulfillmentOrders).toEqual(one.value.fulfillmentOrders);
  });
  const saved = await state(); expect(saved.orders).toHaveLength(3); expect(saved.details).toHaveLength(4);
  expect(saved.statuses.filter(row => row.changeType === 'supplier_order_split')).toHaveLength(1);
  expect(saved.orders.filter(row => row.pid === oid).map(row => row.payPrice)).toEqual(['26.00', '30.00']);
}, 15_000);

it.each(['direct-root', 'other-child', 'other-supplier', 'wrong-root-owner', 'unfinished-root', 'different-user'] as const)
  ('keeps supplier fulfillment isolated for %s', async kind => {
    await supplierLines(); const oid = await create([1, 2]), { fulfillmentOrders: [supplier, platform] } = await allocate(oid);
    let requestedId = supplier.id, actor = 7;
    if (kind === 'direct-root') requestedId = oid;
    else if (kind === 'other-child') requestedId = platform.id;
    else if (kind === 'other-supplier') actor = 8;
    else if (kind === 'wrong-root-owner') await f.db.update(storeOrder).set({ supplierId: 8 }).where(eq(storeOrder.id, oid));
    else if (kind === 'unfinished-root') await f.db.update(storeOrder).set({ supplierAllocationStatus: 1 }).where(eq(storeOrder.id, oid));
    else await f.db.update(storeOrder).set({ uid: 22 }).where(eq(storeOrder.id, oid));
    const before = await state(), seq = await sequence(), service = new SupplierFulfillmentService(f.container, f.env);
    await expect(service.splitCartInfo(actor, requestedId)).rejects.toThrow('不属于当前供应商');
    await expect(service.splitOrders(actor, requestedId)).rejects.toThrow('不属于当前供应商');
    await expect(service.splitDelivery(actor, requestedId, delivery, [{ cartId: '1', cartNum: 1 }])).rejects.toThrow('不属于当前供应商');
    await expect(service.deliver(actor, requestedId, delivery)).rejects.toThrow('不属于当前供应商');
    expect(await state()).toEqual(before); expect(await sequence()).toBe(seq);
  });

it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('rechecks supplier child ownership after an independent row lock wait', async () => {
  await supplierLines(); const oid = await create([1, 2]), { fulfillmentOrders: [supplier] } = await allocate(oid);
  let edited: Awaited<ReturnType<typeof state>> | undefined;
  await withFinancePeers(f.db, async ([holder, buyer]) => {
    await holder.exec(`BEGIN; SELECT id FROM store_order WHERE id=${supplier.id} FOR UPDATE`);
    const pending = outcome(new SupplierFulfillmentService(createContainerFromDb(buyer.db), f.env)
      .splitDelivery(7, supplier.id, delivery, [{ cartId: '1', cartNum: 1 }]));
    await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
    await holder.db.update(storeOrder).set({ supplierId: 8 }).where(eq(storeOrder.id, supplier.id));
    await holder.exec('COMMIT'); edited = await state();
    const result = await pending; expect(result.ok).toBe(false);
    if (!result.ok) expect(String(result.error)).toContain('不属于当前供应商');
  });
  expect(await state()).toEqual(edited);
}, 15_000);
