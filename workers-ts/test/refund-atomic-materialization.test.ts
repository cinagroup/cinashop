import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { StoreOrderCreateService } from '../src/services/order/StoreOrderCreateService';
import { applyOrderRefundWithMaterialization as applyOrderRefund, applyOrderRefund as applyLegacyRefund,
  finalizeStoreOrderRefund, StoreOrderRefundService } from '../src/services/order/StoreOrderRefundService';
import { SupplierFulfillmentService } from '../src/services/supplier/SupplierFulfillmentService';
import { recordSupplierPayment, SupplierFinanceService } from '../src/services/supplier/SupplierFinanceService';
import { allocatePaidOrderBySupplier } from '../src/services/order/OrderSupplierAllocationService';
import { createContainerFromDb, withTx, type DbClient } from '../src/lib/di';
import { REFUND_ORDER_SPLIT_SQL } from '../src/migrations/refundOrderSplit';
import { storeOrderRefundSplit, storeOrderFulfillmentBranch } from '../src/models/schema/order_refund_split';
import { WechatPayService } from '../src/services/wechat/WechatPayService';
import { StoreOrderInvoiceService } from '../src/services/order/StoreOrderInvoiceService';
import { OutApiService } from '../src/services/out/OutApiService';
import { storeOrderInvoiceEvidence } from '../src/models/schema/invoice_evidence';
import { materializeCompletedRefundOrder } from '../src/services/order/RefundOrderMaterialization';
import { MATERIALIZED_REFUND_VERSION, readRefundQuantityReservation } from '../src/services/order/RefundQuantityReservation';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';
import { agentLevel, printDocument, storeCart, storeOrder, storeOrderCartInfo, storeOrderRefund,
  storeOrderStatus, storeProduct, storeProductAttrValue, storeOrderInvoice, storeOrderRefundPayment,
  storeOrderOutbox, orderWaybillJob, userBrokerage, systemSupplier, supplierFlowingWater,
  supplierTransactions, supplierExtract, user, userInvoice } from '../src/models/schema';

let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
let counter = 0;
const shipping = { deliveryType: 'express', deliveryName: 'Local', deliveryCode: 'local',
  deliveryId: 'NO-SHIPMENT', fictitiousContent: '', deliveryUid: 0 } as const;
const outAccount = { id: 7, appid: 'local-invoice-writer', title: 'Synthetic Out identity', rules: [] };
const outMetadata = { header_type: 1, type: 1, name: '本地测试抬头', drawer_phone: '13800000000', email: 'local@example.invalid' };
const outIssued = { is_invoice: 1, invoice_number: '12345678', remark: 'Local only' };
const out = (db: DbClient = f.db) => new OutApiService(createContainerFromDb(db), f.env);
const rejectOutDuringHold = async (orderId: string) => {
  const before = await state();
  await expect(out().updateOrderInvoice(outAccount, orderId, outMetadata)).rejects.toThrow('申请退款');
  await expect(out().updateOrderInvoiceStatus(outAccount, orderId, outIssued)).rejects.toThrow('申请退款');
  expect(await state()).toEqual(before);
};
const order = async (id: number) => (await f.db.select().from(storeOrder).where(eq(storeOrder.id, id)))[0];
const carts = (id: number) => f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, id)).orderBy(storeOrderCartInfo.id);
const state = async () => ({ ...await f.snapshot(),
  carts: await f.db.select().from(storeOrderCartInfo).orderBy(storeOrderCartInfo.id),
  refunds: await f.db.select().from(storeOrderRefund).orderBy(storeOrderRefund.id),
  flows: await f.db.select().from(supplierFlowingWater).orderBy(supplierFlowingWater.id),
  transactions: await f.db.select().from(supplierTransactions).orderBy(supplierTransactions.id),
  brokerages: await f.db.select().from(userBrokerage).orderBy(userBrokerage.id),
  payments: await f.db.select().from(storeOrderRefundPayment).orderBy(storeOrderRefundPayment.id),
  invoices: await f.db.select().from(storeOrderInvoice).orderBy(storeOrderInvoice.id),
  invoiceEvidence: await f.db.select().from(storeOrderInvoiceEvidence)
    .orderBy(storeOrderInvoiceEvidence.invoiceId, storeOrderInvoiceEvidence.kind, storeOrderInvoiceEvidence.documentNumber),
  records: await f.db.select().from(storeOrderRefundSplit).orderBy(storeOrderRefundSplit.refundId),
  branches: await f.db.select().from(storeOrderFulfillmentBranch).orderBy(storeOrderFulfillmentBranch.id),
  statuses: await f.db.select().from(storeOrderStatus).orderBy(storeOrderStatus.id) });
const create = async (received = false, supplier = 7, payType = 'yue') => {
  await f.db.update(storeProduct).set({ type: supplier ? 2 : 0, relationId: supplier });
  const created = await StoreOrderCreateService.createWithRuntime(f.container,
    { CONFIG_KV: f.env.CONFIG_KV, nextOrderId: async () => 'atomic_checkout' },
    { uid: 11, key: 'atomic-checkout', cartIds: [1, 2], addressId: 11, userIp: '127.0.0.1', useIntegral: true });
  const [paid] = await f.db.update(storeOrder).set({ paid: 1, payType, payTime: 100, tradeNo: 'local-atomic-payment' })
    .where(eq(storeOrder.orderId, created.orderId)).returning();
  const source = await withTx(f.container, async tx => {
    const allocated = await allocatePaidOrderBySupplier(tx, paid.id, paid.orderId, 100);
    for (const child of allocated.fulfillmentOrders) await recordSupplierPayment(tx, child, 100);
    return allocated.fulfillmentOrders[0];
  });
  if (received) await receive(source.id);
  return source;
};
const receive = async (id: number) => {
  const current = await order(id), service = new SupplierFulfillmentService(f.container, f.env);
  if (current.status === 0) await service.deliver(current.supplierId, id, shipping);
  await service.confirmTake(current.supplierId, id);
};
const input = async (id: number, productId = 70, quantity = 1) => {
  const source = await order(id), cart = (await carts(id)).find(row => row.productId === productId)!;
  return { uid: 11, orderId: source.orderId, applyType: 1 as const,
    refundReason: 'Atomic candidate test', refundExplain: '', applicationOrderId: `atomic_refund_${++counter}`,
    cartSelections: [{ cartId: Number(cart.cartId), cartNum: quantity }] };
};
const apply = async (id: number, productId = 70, quantity = 1) => applyOrderRefund(f.container, await input(id, productId, quantity));
const finish = (id: number, db: DbClient = f.db) => finalizeStoreOrderRefund(createContainerFromDb(db), id);
const receipt = async (id: number) => (await f.db.select().from(storeOrderRefundSplit).where(eq(storeOrderRefundSplit.refundId, id)))[0];
const businessState = async () => { const { payments: _payments, ...business } = await state(); return business; };
const invoice = async (id: number, rejected = false) => {
  await f.db.insert(userInvoice).values({ id: 1, uid: 11, name: 'Local frozen invoice title', dutyNumber: 'LOCAL-ONLY' });
  const created = await new StoreOrderInvoiceService(f.container).makeUp(11, id, 1);
  if (rejected) await f.db.update(storeOrderInvoice).set({ isInvoice: -1, remark: 'Local rejection', invoiceTime: 123 })
    .where(eq(storeOrderInvoice.id, created.id));
  return (await f.db.select().from(storeOrderInvoice).where(eq(storeOrderInvoice.id, created.id)))[0];
};
const failInsert = (table: string) => f.exec(`CREATE FUNCTION fail_atomic_materialization() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'local atomic materialization failure'; END $$;
  CREATE TRIGGER fail_atomic_materialization BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_atomic_materialization()`);
const removeFailure = (table: string) => f.exec(`DROP TRIGGER fail_atomic_materialization ON ${table}; DROP FUNCTION fail_atomic_materialization()`);
beforeEach(async () => {
  counter = 0;
  f = await createPcCheckoutQuoteFixture([agentLevel, printDocument, storeOrderCartInfo, storeOrderRefund, storeOrderStatus,
    storeOrderInvoice, storeOrderRefundPayment, storeOrderOutbox, orderWaybillJob, userBrokerage, systemSupplier,
    supplierFlowingWater, supplierTransactions, supplierExtract, userInvoice]);
  await f.exec(REFUND_ORDER_SPLIT_SQL);
  await f.exec('CREATE UNIQUE INDEX atomic_outbox ON store_order_outbox(event_key); CREATE UNIQUE INDEX atomic_flow ON supplier_flowing_water(order_id); CREATE UNIQUE INDEX atomic_transaction ON supplier_transactions(order_id)');
  await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
  await f.setConfig({ integral_ratio_status: '1', integral_ratio: '0.01', integral_max_type: '1', integral_max_num: '100' });
  Object.assign(f.config, { brokerage_func_status: '1', store_brokerage_statu: '1', brokerage_level: '1', brokerage_compute_type: '1', store_brokerage_ratio: '10' });
  await f.db.update(user).set({ spreadUid: 22 }).where(eq(user.uid, 11));
  await f.db.insert(user).values({ uid: 22, account: 'Local atomic referrer', status: 1, isPromoter: 1, spreadOpen: 1 });
  await f.db.insert(systemSupplier).values({ id: 7, adminId: 7, supplierName: 'Local atomic supplier' });
  await f.db.update(storeProduct).set({ freight: 2, tempId: 0, postage: '3.00', giveIntegral: '100.00', isSub: 1 }).where(eq(storeProduct.id, 70));
  await f.db.update(storeProductAttrValue).set({ settlePrice: '2.50', cost: '2.00', brokerage: '0.30' }).where(eq(storeProductAttrValue.id, 1));
  await f.db.insert(storeProduct).values({ id: 71, storeName: 'Local atomic remainder', price: '30.00', stock: 8, isShow: 1, freight: 1 });
  await f.db.insert(storeProductAttrValue).values({ id: 2, productId: 71, unique: 'atomic71', suk: 'Standard', price: '30.00', settlePrice: '20.00', stock: 8 });
  await f.db.insert(storeCart).values({ id: 2, uid: 11, productId: 71, productAttrUnique: 'atomic71', cartNum: 1, status: 1, isNew: 1 });
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
}, 30_000);
afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); } });

it.each(['retained', 'archived', 'deleted'])('rejects previously issued invoice history after manual rejection: %s', async mode => {
  const source = await create(); await invoice(source.id);
  await out().updateOrderInvoiceStatus(outAccount, source.orderId, outIssued);
  await out().updateOrderInvoiceStatus(outAccount, source.orderId, { is_invoice: -1, remark: 'Manual rejection, not a credit note' });
  if (mode === 'archived') await f.db.update(storeOrderInvoice).set({ isDel: 1 });
  if (mode === 'deleted') await f.db.delete(storeOrderInvoice);
  const before = await state(); await expect(apply(source.id)).rejects.toThrow('开票历史'); expect(await state()).toEqual(before);
});

it('requires creation evidence instead of treating an unverified legacy application as never-issued', async () => {
  const source = await create();
  await f.exec('ALTER TABLE store_order_invoice DISABLE TRIGGER soi_capture_evidence');
  try { await invoice(source.id); } finally { await f.exec('ALTER TABLE store_order_invoice ENABLE TRIGGER soi_capture_evidence'); }
  const before = await state(); await expect(apply(source.id)).rejects.toThrow('开票历史'); expect(await state()).toEqual(before);
  await out().updateOrderInvoice(outAccount, source.orderId, outMetadata);
  await f.db.delete(storeOrderInvoice); const deleted = await state();
  await expect(apply(source.id)).rejects.toThrow('开票历史'); expect(await state()).toEqual(deleted);
});

it.each([false, true])('rejects an uncaptured archived pre-install invoice, including with a new replacement: %s', async replacement => {
  const source = await create();
  await f.exec('ALTER TABLE store_order_invoice DISABLE TRIGGER soi_capture_evidence');
  try { await invoice(source.id); await f.db.update(storeOrderInvoice).set({ isDel: 1, isInvoice: -1 }); }
  finally { await f.exec('ALTER TABLE store_order_invoice ENABLE TRIGGER soi_capture_evidence'); }
  if (replacement) await new StoreOrderInvoiceService(f.container).makeUp(11, source.id, 1);
  const before = await state(); await expect(apply(source.id)).rejects.toThrow('开票历史'); expect(await state()).toEqual(before);
});

it('rejects provider admission if a nonconforming writer reports issuance then clears it after the refund hold', async () => {
  const source = await create(false, 7, 'weixin'); await invoice(source.id); const application = await apply(source.id);
  await f.db.update(storeOrderInvoice).set({ isInvoice: 1, invoiceNumber: '12345678' });
  await f.db.update(storeOrderInvoice).set({ isInvoice: -1, invoiceNumber: '' });
  const request = vi.spyOn(WechatPayService.prototype, 'requestRefund').mockRejectedValue(Error('Must not call provider'));
  const before = await state();
  await expect(new StoreOrderRefundService(f.container, f.env).agreeRefund(application.refundId)).rejects.toThrow('开票历史');
  expect(request).not.toHaveBeenCalled(); expect(await state()).toEqual(before);
});

it('rolls back actual Out issuance, audit and replay when immutable capture fails', async () => {
  const source = await create(); await invoice(source.id); const before = await state();
  await failInsert('store_order_invoice_evidence');
  await expect(out().updateOrderInvoiceStatus(outAccount, source.orderId, outIssued)).rejects.toThrow();
  expect(await state()).toEqual(before);
  await removeFailure('store_order_invoice_evidence');
  await out().updateOrderInvoiceStatus(outAccount, source.orderId, outIssued);
  const issued = await state(); expect(issued.invoiceEvidence.filter(row => row.kind === 'issued')).toHaveLength(1);
  await out().updateOrderInvoiceStatus(outAccount, source.orderId, outIssued); expect(await state()).toEqual(issued);
});

it('rechecks issued history after invoice preparation and rolls back a late issue-then-clear together with refund money', async () => {
  const source = await create(); await invoice(source.id); const application = await apply(source.id), before = await state();
  await f.exec(`CREATE FUNCTION late_invoice_issuance() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.refund_type=6 AND OLD.refund_type<>6 THEN
      UPDATE store_order_invoice SET is_invoice=1,invoice_number='12345678' WHERE order_id=NEW.id;
      UPDATE store_order_invoice SET is_invoice=0,invoice_number='' WHERE order_id=NEW.id;
    END IF; RETURN NEW; END $$;
    CREATE TRIGGER late_invoice_issuance AFTER UPDATE ON store_order FOR EACH ROW EXECUTE FUNCTION late_invoice_issuance()`);
  await expect(finish(application.refundId)).rejects.toThrow('开票历史'); expect(await state()).toEqual(before);
  await f.exec('DROP TRIGGER late_invoice_issuance ON store_order; DROP FUNCTION late_invoice_issuance()');
  await finish(application.refundId); expect((await state()).invoiceEvidence.every(row => row.kind === 'created')).toBe(true);
});

it('does not downgrade candidate admission when the invoice evidence table is missing, even with no active invoice', async () => {
  const source = await create(), before = await state();
  await f.exec('ALTER TABLE store_order_invoice_evidence RENAME TO hidden_invoice_evidence');
  try { await expect(apply(source.id)).rejects.toThrow(); }
  finally { await f.exec('ALTER TABLE hidden_invoice_evidence RENAME TO store_order_invoice_evidence'); }
  expect(await state()).toEqual(before);
});

it('commits the refund, wallet, rewards, supplier ledger and physical orders through the actual finalizer', async () => {
  const source = await create(), application = await apply(source.id);
  expect(await finish(application.refundId)).toBe('completed');
  const done = await state(); expect(done.records).toHaveLength(1); expect(done.orders).toHaveLength(3);
  expect(done.records[0].invoiceAllocation).toBe('null');
  expect(done.users.find(row => row.uid === 11)).toMatchObject({ nowMoney: '12.80', integral: 20 });
});

it.each([false, true])('partitions an existing unissued invoice across three actual refund generations; rejected=%s', async rejected => {
  const source = await create(), original = await invoice(source.id, rejected), first = await apply(source.id);
  await finish(first.refundId); const firstRecord = await receipt(first.refundId), remaining = firstRecord.remainingOrderId!;
  const afterFirst = await state(), retained = afterFirst.invoices.find(row => row.orderId === remaining)!;
  expect(afterFirst.invoices.find(row => row.id === original.id)).toEqual({ ...original, isDel: 1, isRefund: 1 });
  expect(afterFirst.invoices.filter(row => row.isDel === 0).map(row => row.invoiceAmount).sort()).toEqual(['12.80', '42.20']);
  expect(retained).toMatchObject({ isInvoice: rejected ? -1 : 0, name: original.name, invoiceNumber: '', isRefund: 0 });
  expect((await new StoreOrderInvoiceService(f.container).list(11)).map(row => row.id)).toEqual([retained.id]);
  expect(JSON.parse(firstRecord.invoiceAllocation)).toEqual({ version: 'refund-invoice-allocation-v1',
    sourceOrderId: source.id, paymentOrderId: source.id, original,
    selected: { invoiceId: afterFirst.invoices.find(row => row.orderId === firstRecord.selectedOrderId)!.id,
      orderId: firstRecord.selectedOrderId, amount: '12.80' },
    remaining: { invoiceId: retained.id, orderId: remaining, amount: '42.20' } });
  const second = await apply(remaining); await finish(second.refundId);
  expect((await state()).invoices.find(row => row.id === retained.id)).toEqual({ ...retained, invoiceAmount: '29.40' });
  expect(JSON.parse((await receipt(second.refundId)).invoiceAllocation).original).toEqual(retained);
  const third = await apply(remaining, 71); await finish(third.refundId);
  const done = await state();
  expect(done.invoices).toHaveLength(4); expect(done.invoices.filter(row => !row.isDel).every(row => row.isRefund === 1)).toBe(true);
  expect(done.invoices.filter(row => !row.isDel).reduce((sum, row) => sum + Math.round(Number(row.invoiceAmount) * 100), 0)).toBe(5500);
  expect(done.users.find(row => row.uid === 11)?.nowMoney).toBe('55.00');
  expect(await new StoreOrderInvoiceService(f.container).list(11)).toEqual([]);
  await expect(f.exec(`UPDATE store_order_refund_split SET invoice_allocation='null' WHERE refund_id=${first.refundId}`)).rejects.toThrow('append-only');
  await expect(f.exec(`DELETE FROM store_order_refund_split WHERE refund_id=${first.refundId}`)).rejects.toThrow('append-only');
  await expect(f.exec('TRUNCATE store_order_refund_split')).rejects.toThrow('append-only');
  for (const refund of done.refunds) expect(await finish(refund.id)).toBe('already-completed');
  expect(await state()).toEqual(done);
});

it('preserves the invoice identity and amount on an actual whole-order refund', async () => {
  const source = await create(), original = await invoice(source.id), params = await input(source.id);
  const application = await applyOrderRefund(f.container, { ...params,
    cartSelections: (await carts(source.id)).map(row => ({ cartId: Number(row.cartId), cartNum: row.cartNum })) });
  await finish(application.refundId);
  expect((await state()).invoices).toEqual([{ ...original, isRefund: 1 }]);
  expect(await receipt(application.refundId)).toMatchObject({ disposition: 'whole', selectedOrderId: source.id, remainingOrderId: null });
  expect(JSON.parse((await receipt(application.refundId)).invoiceAllocation)).toMatchObject({ original,
    selected: { invoiceId: original.id, orderId: source.id, amount: '55.00' }, remaining: null });
});

it.each([
  { isPay: 0 }, { isRefund: 1 }, { invoiceAmount: '54.99' },
  { isInvoice: 1 }, { isInvoice: 2 }, { invoiceNumber: '12345678' }, { isInvoice: -1, invoiceNumber: '12345678' },
])('rejects inconsistent or issued invoice evidence before application admission: %j', async changes => {
  const source = await create(), original = await invoice(source.id);
  await f.db.update(storeOrderInvoice).set(changes).where(eq(storeOrderInvoice.id, original.id));
  const expected = Object.hasOwn(changes, 'isInvoice') || Object.hasOwn(changes, 'invoiceNumber') ? '已开票' : '退款发票归属';
  const before = await state(); await expect(apply(source.id)).rejects.toThrow(expected); expect(await state()).toEqual(before);
});

it.each([{ uid: 22 }, { category: 'other' }])('rejects changing a captured invoice identity atomically: %j', async changes => {
  const source = await create(), original = await invoice(source.id), before = await state();
  await expect(f.db.update(storeOrderInvoice).set(changes).where(eq(storeOrderInvoice.id, original.id))).rejects.toThrow();
  expect(await state()).toEqual(before);
});

it('rejects duplicate active applications but does not revive a deleted invoice', async () => {
  const source = await create(), original = await invoice(source.id), { id: _id, ...copy } = original;
  const [duplicate] = await f.db.insert(storeOrderInvoice).values(copy).returning();
  const before = await state(); await expect(apply(source.id)).rejects.toThrow('发票'); expect(await state()).toEqual(before);
  await f.db.update(storeOrderInvoice).set({ isDel: 1 });
  const first = await apply(source.id); await finish(first.refundId);
  expect((await state()).invoices).toEqual([original, duplicate].map(row => ({ ...row, isDel: 1 })));
  expect((await receipt(first.refundId)).invoiceAllocation).toBe('null');
});

it('does not independently allocate an active payment-root application onto just one existing child', async () => {
  const source = await create(), first = await apply(source.id); await finish(first.refundId);
  const remaining = (await receipt(first.refundId)).remainingOrderId!;
  await f.db.insert(storeOrderInvoice).values({ uid: 11, orderId: source.id, isPay: 1, invoiceAmount: '55.00' });
  const before = await state(); await expect(apply(remaining)).rejects.toThrow('主单发票'); expect(await state()).toEqual(before);
});

it.each(['application', 'provider'])('rejects invoice cash concessions before %s writes or provider requests', async stage => {
  const source = await create(false, 7, 'weixin'), original = await invoice(source.id), params = await input(source.id);
  const createConcession = () => applyOrderRefund(f.container, { ...params, privilegedActor: 'admin', applyType: 4,
    requestedRefundAmountCents: 1000, authorizeApplication: async () => undefined });
  const request = vi.spyOn(WechatPayService.prototype, 'requestRefund').mockRejectedValue(Error('Must not request'));
  if (stage === 'application') {
    const before = await state(); await expect(createConcession()).rejects.toThrow('少退'); expect(await state()).toEqual(before);
  } else {
    await f.db.update(storeOrderInvoice).set({ isDel: 1 }).where(eq(storeOrderInvoice.id, original.id));
    const application = await createConcession();
    // A deliberately nonconforming legacy writer, after application admission.
    await f.db.update(storeOrderInvoice).set({ isDel: 0 }).where(eq(storeOrderInvoice.id, original.id));
    const before = await state();
    await expect(new StoreOrderRefundService(f.container, f.env).agreeRefund(application.refundId)).rejects.toThrow('少退');
    expect(await state()).toEqual(before);
  }
  expect(request).not.toHaveBeenCalled();
});

it('fails closed on the older candidate schema without an invoice allocation column', async () => {
  const source = await create(); await invoice(source.id); const before = await state();
  await f.exec('ALTER TABLE store_order_refund_split RENAME COLUMN invoice_allocation TO hidden_invoice_allocation');
  try { await expect(apply(source.id)).rejects.toThrow(); }
  finally { await f.exec('ALTER TABLE store_order_refund_split RENAME COLUMN hidden_invoice_allocation TO invoice_allocation'); }
  expect(await state()).toEqual(before);
});

it('does not retrofit invoice partitioning after a standalone legacy financial completion', async () => {
  const source = await create(); await invoice(source.id);
  const application = await applyLegacyRefund(f.container, await input(source.id)); await finish(application.refundId);
  const before = await state(), refund = before.refunds[0];
  await expect(withTx(f.container, tx => materializeCompletedRefundOrder(tx, refund, Math.floor(Date.now() / 1000)))).rejects.toThrow('发票');
  expect(await state()).toEqual(before);
});

it.each(['update-failure', 'suppressed-update', 'snapshot-drift'])('rolls back every financial and physical write on late invoice %s', async mode => {
  const source = await create(); await invoice(source.id); const application = await apply(source.id), before = await state();
  if (mode !== 'snapshot-drift') await f.exec(`CREATE FUNCTION fail_invoice_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    ${mode === 'suppressed-update' ? 'RETURN NULL;' : "RAISE EXCEPTION 'local invoice update failure';"} END $$;
    CREATE TRIGGER fail_invoice_update BEFORE UPDATE ON store_order_invoice FOR EACH ROW EXECUTE FUNCTION fail_invoice_update()`);
  else await f.exec(`CREATE FUNCTION drift_invoice() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.refund_type=6 AND OLD.refund_type<>6 THEN UPDATE store_order_invoice SET name='Unexpected drift' WHERE order_id=NEW.id; END IF;
    RETURN NEW; END $$; CREATE TRIGGER drift_invoice AFTER UPDATE ON store_order FOR EACH ROW EXECUTE FUNCTION drift_invoice()`);
  await expect(finish(application.refundId)).rejects.toThrow(); expect(await state()).toEqual(before);
});

it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('locks invoices before financial users and rechecks issuance after waiting', async () => {
  const source = await create(), original = await invoice(source.id), application = await apply(source.id);
  await withFinancePeers(f.db, async ([blocker, worker]) => {
    await blocker.exec(`BEGIN; SELECT id FROM store_order_invoice WHERE id=${original.id} FOR UPDATE`);
    const pending = outcome(finish(application.refundId, worker.db)); await waitForFinanceBlock(f.db, worker.pid, blocker.pid);
    await blocker.exec(`SELECT uid FROM "user" WHERE uid IN (11,22) FOR UPDATE NOWAIT;
      UPDATE store_order_invoice SET is_invoice=1, invoice_number='12345678' WHERE id=${original.id}; COMMIT`);
    const before = await state(); const result = await pending; expect(result.ok).toBe(false);
    if (!result.ok) expect(String(result.error)).toContain('已开票');
    expect(await state()).toEqual(before);
  });
});

it.each(['store_order', 'store_order_cart_info', 'supplier_flowing_water', 'store_order_invoice', 'store_order_refund_split'])
  ('rolls back the whole business completion when %s insertion fails, then retries once', async table => {
  const source = await create(); await invoice(source.id); const application = await apply(source.id), before = await state();
  await failInsert(table);
  await expect(finish(application.refundId)).rejects.toThrow(); expect(await state()).toEqual(before);
  await removeFailure(table); expect(await finish(application.refundId)).toBe('completed');
  const committed = await state(); expect(committed.records).toHaveLength(1);
  expect(await finish(application.refundId)).toBe('already-completed'); expect(await state()).toEqual(committed);
});

it.each([false, true])('settles three durable generations with cash, points and supplier conservation; received=%s', async received => {
  const source = await create(received), first = await apply(source.id);
  await finish(first.refundId); const remaining = (await receipt(first.refundId)).remainingOrderId!;
  const second = await apply(remaining); await finish(second.refundId);
  const third = await apply(remaining, 71); await finish(third.refundId);
  const done = await state(); expect(done.records).toHaveLength(3);
  expect(done.refunds.map(row => row.refundedPrice)).toEqual(['12.80', '12.80', '29.40']);
  expect(done.refunds.every(row => readRefundQuantityReservation(row)?.version === MATERIALIZED_REFUND_VERSION)).toBe(true);
  expect(done.users.find(row => row.uid === 11)).toMatchObject({ nowMoney: '55.00', integral: 100 });
  expect(done.users.find(row => row.uid === 22)?.brokeragePrice).toBe('0.00');
  expect(await new SupplierFinanceService(f.container, f.env).summary(7)).toMatchObject({
    available: '0.00', pending_settlement: '0.00', total_income: '31.00', total_refund: '31.00' });
  for (const row of done.refunds) expect(await finish(row.id)).toBe('already-completed');
  expect(await state()).toEqual(done);
});

it('keeps actual fulfillment forks compatible with subsequent atomic refunds', async () => {
  const source = await create(), first = await apply(source.id); await finish(first.refundId);
  const remaining = (await receipt(first.refundId)).remainingOrderId!, line = (await carts(remaining))[0];
  const split = await new SupplierFulfillmentService(f.container, f.env).splitDelivery(7, remaining, shipping,
    [{ cartId: line.cartId, cartNum: 1 }]);
  await receive(split.order_id);
  await finish((await apply(split.order_id)).refundId);
  await finish((await apply(split.remaining_order_id!, 71)).refundId);
  const done = await state(); expect(done.branches).toHaveLength(2); expect(done.records).toHaveLength(3);
  expect(done.users.find(row => row.uid === 11)).toMatchObject({ nowMoney: '55.00', integral: 100 });
  expect(done.users.find(row => row.uid === 22)?.brokeragePrice).toBe('0.00');
});

it('replays the original application after its source becomes an audit root, without accepting changed intent', async () => {
  const source = await create(), params = await input(source.id), application = await applyOrderRefund(f.container, params);
  await finish(application.refundId); expect((await order(source.id)).pid).toBe(-1);
  const before = await state(); expect(await applyOrderRefund(f.container, params)).toEqual(application);
  await expect(applyOrderRefund(f.container, { ...params, cartSelections: [{ ...params.cartSelections[0], cartNum: 2 }] })).rejects.toThrow('幂等参数');
  await expect(applyOrderRefund(f.container, { ...params, applicationOrderId: 'new_on_audit_root' })).rejects.toThrow('履约子单');
  expect(await state()).toEqual(before);
});

it('recovers provider SUCCESS after a failed local commit, with no second provider request or query', async () => {
  const source = await create(false, 7, 'weixin'); await invoice(source.id); const application = await apply(source.id);
  const request = vi.spyOn(WechatPayService.prototype, 'requestRefund').mockResolvedValue({ status: 'SUCCESS', providerRefundId: 'local-success' });
  const query = vi.spyOn(WechatPayService.prototype, 'queryRefund').mockRejectedValue(Error('Must not query known success'));
  const before = await businessState(); await failInsert('store_order_refund_split');
  await expect(new StoreOrderRefundService(f.container, f.env).agreeRefund(application.refundId)).rejects.toThrow();
  expect(await businessState()).toEqual(before); expect(request).toHaveBeenCalledTimes(1);
  const [payment] = await f.db.select().from(storeOrderRefundPayment);
  expect(payment).toMatchObject({ providerStatus: 'SUCCESS', requestAmount: 1280, totalAmount: 5500, attemptCount: 1 });
  await rejectOutDuringHold(source.orderId);
  await removeFailure('store_order_refund_split');
  const recovered = new StoreOrderRefundService(f.container, f.env);
  expect(await recovered.reconcilePendingRefunds()).toMatchObject({ checked: 1, completed: 1, errors: 0 });
  expect(request).toHaveBeenCalledTimes(1); expect(query).not.toHaveBeenCalled();
  expect(request.mock.calls[0][0]).toMatchObject({ outTradeNo: source.orderId, transactionId: 'local-atomic-payment',
    outRefundNo: `CNSR${application.refundId}`, refundAmount: 1280, totalAmount: 5500 });
  const committed = await businessState(); expect(committed.records).toHaveLength(1);
  expect(await recovered.reconcilePendingRefunds()).toMatchObject({ checked: 0, completed: 0, errors: 0 });
  const notice = { outTradeNo: source.orderId, transactionId: 'local-atomic-payment', outRefundNo: payment.outRefundNo,
    providerRefundId: 'local-success', status: 'SUCCESS' as const, refundAmount: 1280, totalAmount: 5500 };
  await recovered.handleWechatRefundNotification(notice); await recovered.handleWechatRefundNotification(notice);
  expect(await businessState()).toEqual(committed); expect(query).not.toHaveBeenCalled();
  const remaining = await order(committed.records[0].remainingOrderId!);
  await out().updateOrderInvoice(outAccount, remaining.orderId, outMetadata);
  await out().updateOrderInvoiceStatus(outAccount, remaining.orderId, outIssued);
  expect((await out().orderInfo(remaining.orderId)).invoice).toMatchObject({ invoice_amount: '42.20', is_invoice: 1 });
  expect(request).toHaveBeenCalledTimes(1); expect(query).not.toHaveBeenCalled();
});

it('queries an UNKNOWN result against the original payment and atomically settles its durable version', async () => {
  const source = await create(false, 7, 'weixin'), application = await apply(source.id);
  const request = vi.spyOn(WechatPayService.prototype, 'requestRefund').mockRejectedValue(Error('Local lost response'));
  const query = vi.spyOn(WechatPayService.prototype, 'queryRefund').mockResolvedValue({ status: 'SUCCESS', providerRefundId: 'local-recovered' });
  await expect(new StoreOrderRefundService(f.container, f.env).agreeRefund(application.refundId)).rejects.toThrow('结果未知');
  await f.db.update(storeOrderRefundPayment).set({ requestTime: 1, queryTime: 0 });
  expect(await new StoreOrderRefundService(f.container, f.env).reconcilePendingRefunds()).toMatchObject({ checked: 1, completed: 1, errors: 0 });
  expect(request).toHaveBeenCalledTimes(1); expect(query).toHaveBeenCalledTimes(1);
  expect(query.mock.calls[0][0]).toEqual(request.mock.calls[0][0]); expect(await receipt(application.refundId)).toBeTruthy();
});

it.each(['cancel', 'refuse'])('releases the v2 quantity hold on %s even when an invoice was subsequently added', async action => {
  const source = await create(), application = await apply(source.id), service = new StoreOrderRefundService(f.container, f.env);
  await f.db.insert(storeOrderInvoice).values({ uid: 11, orderId: source.id });
  if (action === 'cancel') await service.cancelApply(11, application.refundId);
  else { await service.refuseRefund(application.refundId, 'Local refusal'); await service.refuseRefund(application.refundId, 'Local refusal'); }
  expect((await carts(source.id)).every(row => row.refundNum === 0)).toBe(true);
  const done = await state(); expect(done.records).toHaveLength(0); expect(done.payments).toHaveLength(0);
  expect(done.users.find(row => row.uid === 11)?.nowMoney).toBe('0.00');
});

it.each(['invoice', 'promotion', 'freight', 'pink'])('rejects unsupported %s before persisting an atomic application', async kind => {
  const source = await create(), params = await input(source.id);
  if (kind === 'invoice') await f.db.insert(storeOrderInvoice).values({ uid: 11, orderId: source.id });
  if (kind === 'promotion') await f.db.update(storeOrder).set({ giveCoupon: '[1]' }).where(eq(storeOrder.id, source.id));
  if (kind === 'freight') await f.db.update(storeOrder).set({ freightPrice: '1.00' }).where(eq(storeOrder.id, source.id));
  if (kind === 'pink') await f.db.update(storeOrder).set({ type: 3 }).where(eq(storeOrder.id, source.id));
  const before = await state(); await expect(applyOrderRefund(f.container, params)).rejects.toThrow(); expect(await state()).toEqual(before);
});

it('does not admit a candidate without its schema or downgrade to the v1 execution path', async () => {
  const source = await create(), params = await input(source.id), before = await businessState();
  await f.exec('ALTER TABLE store_order_refund_split RENAME TO hidden_atomic_receipts');
  try { await expect(applyOrderRefund(f.container, params)).rejects.toThrow(); }
  finally { await f.exec('ALTER TABLE hidden_atomic_receipts RENAME TO store_order_refund_split'); }
  expect(await businessState()).toEqual(before);
});

it('rolls back financial and structural effects if the final locked operation receipt fails', async () => {
  const source = await create(), application = await apply(source.id), before = await state();
  await expect(finalizeStoreOrderRefund(f.container, application.refundId, Math.floor(Date.now() / 1000), {
    recordLockedDecision: async () => { throw Error('Local decision receipt failed'); },
  })).rejects.toThrow('Local decision receipt failed');
  expect(await state()).toEqual(before);
});

it('keeps platform-owned refund generations independent of supplier ledgers', async () => {
  const source = await create(false, 0), first = await apply(source.id); await finish(first.refundId);
  const remaining = (await receipt(first.refundId)).remainingOrderId!;
  await finish((await apply(remaining)).refundId); await finish((await apply(remaining, 71)).refundId);
  const done = await state(); expect(done.records).toHaveLength(3); expect(done.flows).toHaveLength(0);
  expect(done.users.find(row => row.uid === 11)).toMatchObject({ nowMoney: '55.00', integral: 100 });
});

it('does not upgrade an existing v1 application by replaying through the candidate entrypoint', async () => {
  const source = await create(), params = await input(source.id); await applyLegacyRefund(f.container, params);
  const before = await state(); await expect(applyOrderRefund(f.container, params)).rejects.toThrow('幂等参数');
  expect(await state()).toEqual(before);
});

it('rechecks newly unsupported evidence before provider admission and leaves the channel untouched', async () => {
  const source = await create(false, 7, 'weixin'), application = await apply(source.id);
  const request = vi.spyOn(WechatPayService.prototype, 'requestRefund').mockRejectedValue(Error('Forbidden admission'));
  await f.db.insert(storeOrderInvoice).values({ uid: 11, orderId: source.id });
  const before = await state(); await expect(new StoreOrderRefundService(f.container, f.env).agreeRefund(application.refundId)).rejects.toThrow('发票');
  expect(request).not.toHaveBeenCalled(); expect(await state()).toEqual(before);
});

it('rejects a terminal v2 completion with a missing immutable receipt instead of repairing it', async () => {
  const source = await create(), application = await apply(source.id); await finish(application.refundId);
  // Deliberate corruption by the isolated fixture owner, never a runtime repair.
  await f.exec('ALTER TABLE store_order_refund_split DISABLE TRIGGER sors_no_rewrite; DELETE FROM store_order_refund_split; ALTER TABLE store_order_refund_split ENABLE TRIGGER sors_no_rewrite');
  const before = await state(); await expect(finish(application.refundId)).rejects.toThrow('准入证据');
  await expect(new StoreOrderRefundService(f.container, f.env).agreeRefund(application.refundId)).rejects.toThrow('准入证据');
  expect(await state()).toEqual(before);
});

it('retains the original payment identity for a provider refund of a materialized remainder', async () => {
  const source = await create(false, 7, 'weixin'), first = await apply(source.id);
  const request = vi.spyOn(WechatPayService.prototype, 'requestRefund').mockResolvedValue({ status: 'SUCCESS', providerRefundId: 'local-first' });
  const query = vi.spyOn(WechatPayService.prototype, 'queryRefund').mockResolvedValue({ status: 'SUCCESS', providerRefundId: 'local-second' });
  await new StoreOrderRefundService(f.container, f.env).agreeRefund(first.refundId);
  const remaining = (await receipt(first.refundId)).remainingOrderId!, second = await apply(remaining);
  request.mockRejectedValueOnce(Error('Local second lost response'));
  await expect(new StoreOrderRefundService(f.container, f.env).agreeRefund(second.refundId)).rejects.toThrow('结果未知');
  await f.db.update(storeOrderRefundPayment).set({ requestTime: 1, queryTime: 0 }).where(eq(storeOrderRefundPayment.refundId, second.refundId));
  expect(await new StoreOrderRefundService(f.container, f.env).reconcilePendingRefunds()).toMatchObject({ checked: 1, completed: 1, errors: 0 });
  expect(request).toHaveBeenCalledTimes(2); expect(query).toHaveBeenCalledTimes(1);
  expect(query.mock.calls[0][0]).toEqual(request.mock.calls[1][0]);
  expect(query.mock.calls[0][0]).toMatchObject({ outTradeNo: source.orderId, transactionId: 'local-atomic-payment',
    outRefundNo: `CNSR${second.refundId}`, totalAmount: 5500, refundAmount: 1280 });
  expect((await state()).records).toHaveLength(2);
});

it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('holds the payment root before child and users, then revalidates a changed child association', async () => {
  const source = await create(), first = await apply(source.id); await finish(first.refundId);
  const remaining = (await receipt(first.refundId)).remainingOrderId!, next = await apply(remaining);
  await withFinancePeers(f.db, async ([blocker, worker]) => {
    await blocker.exec(`BEGIN; SELECT id FROM store_order WHERE id=${source.id} FOR UPDATE`);
    const work = outcome(finish(next.refundId, worker.db));
    await waitForFinanceBlock(f.db, worker.pid, blocker.pid);
    await blocker.exec(`SELECT id FROM store_order WHERE id=${remaining} FOR UPDATE NOWAIT; SELECT uid FROM "user" WHERE uid IN (11,22) FOR UPDATE NOWAIT;
      UPDATE store_order SET pid=0 WHERE id=${remaining}; COMMIT`);
    const expected = await state(); expect((await work).ok).toBe(false); expect(await state()).toEqual(expected);
  });
});

it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('serializes two actual finalizers into one financial and structural completion', async () => {
  const source = await create(); await invoice(source.id); const application = await apply(source.id);
  await withFinancePeers(f.db, async ([blocker, first, second]) => {
    await blocker.exec(`BEGIN; SELECT id FROM store_order WHERE id=${source.id} FOR UPDATE`);
    const a = outcome(finish(application.refundId, first.db)); await waitForFinanceBlock(f.db, first.pid, blocker.pid);
    const b = outcome(finish(application.refundId, second.db)); await waitForFinanceBlock(f.db, second.pid, first.pid);
    await blocker.exec('COMMIT');
    expect(await a).toEqual({ ok: true, value: 'completed' }); expect(await b).toEqual({ ok: true, value: 'already-completed' });
  });
  const done = await state(); expect(done.records).toHaveLength(1);
  expect(done.users.find(row => row.uid === 11)?.nowMoney).toBe('12.80');
});

it('creates an invoice for the current physical remainder without subtracting an older generation twice', async () => {
  const source = await create(), first = await apply(source.id); await finish(first.refundId);
  const remaining = (await receipt(first.refundId)).remainingOrderId!; await finish((await apply(remaining)).refundId);
  await f.db.insert(userInvoice).values({ id: 1, uid: 11, name: 'Local current-generation title' });
  const invoices = new StoreOrderInvoiceService(f.container), before = await state();
  await invoices.makeUp(11, remaining, 1); const done = await state();
  expect(done.invoices).toHaveLength(1); expect(done.invoices[0]).toMatchObject({ orderId: remaining, invoiceAmount: '29.40' });
  expect(done.refunds).toEqual(before.refunds); expect(done.bills).toEqual(before.bills);
  expect(done.transactions).toEqual(before.transactions); expect(done.records).toEqual(before.records);
  await expect(invoices.makeUp(11, source.id, 1)).rejects.toThrow('履约子单');
  expect((await invoices.list(11)).map(row => row.orderId)).toEqual([remaining]);
});

it('creates the evidenced net invoice after an actual legacy partial refund', async () => {
  const source = await create(), application = await applyLegacyRefund(f.container, await input(source.id)); await finish(application.refundId);
  await f.db.insert(userInvoice).values({ id: 1, uid: 11, name: 'Local net title' });
  await new StoreOrderInvoiceService(f.container).makeUp(11, source.id, 1);
  expect((await state()).invoices[0]).toMatchObject({ orderId: source.id, invoiceAmount: '42.20' });
});

it('blocks invoice creation during the actual v2 hold and permits it after user cancellation', async () => {
  const source = await create(), application = await apply(source.id);
  await f.db.insert(userInvoice).values({ id: 1, uid: 11, name: 'Local cancelled title' });
  const invoices = new StoreOrderInvoiceService(f.container), before = await state();
  await expect(invoices.makeUp(11, source.id, 1)).rejects.toThrow('申请退款'); expect(await state()).toEqual(before);
  await new StoreOrderRefundService(f.container, f.env).cancelApply(11, application.refundId);
  await invoices.makeUp(11, source.id, 1); expect((await state()).invoices[0].invoiceAmount).toBe('55.00');
});

it('does not invoice marked remaining goods when the durable generation receipt is missing', async () => {
  const source = await create(), first = await apply(source.id); await finish(first.refundId);
  const remaining = (await receipt(first.refundId)).remainingOrderId!;
  await f.db.insert(userInvoice).values({ id: 1, uid: 11, name: 'Local missing-evidence title' });
  const before = await state(); await f.exec('ALTER TABLE store_order_refund_split RENAME TO hidden_invoice_generation');
  try { await expect(new StoreOrderInvoiceService(f.container).makeUp(11, remaining, 1)).rejects.toThrow(); }
  finally { await f.exec('ALTER TABLE hidden_invoice_generation RENAME TO store_order_refund_split'); }
  expect(await state()).toEqual(before);
});

it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL)).each(['invoice-first', 'refund-first'])
  ('serializes the actual invoice and atomic-refund application services: %s', async mode => {
  const source = await create(), params = await input(source.id);
  await f.db.insert(userInvoice).values({ id: 1, uid: 11, name: 'Local raced title' });
  await withFinancePeers(f.db, async ([blocker, first, second]) => {
    await blocker.exec(mode === 'invoice-first' ? 'BEGIN; SELECT id FROM user_invoice WHERE id=1 FOR UPDATE'
      : `BEGIN; SELECT id FROM store_order WHERE id=${source.id} FOR UPDATE`);
    const a = outcome((async () => mode === 'invoice-first'
      ? new StoreOrderInvoiceService(createContainerFromDb(first.db)).makeUp(11, source.id, 1)
      : applyOrderRefund(createContainerFromDb(first.db), params))());
    await waitForFinanceBlock(f.db, first.pid, blocker.pid);
    const b = outcome((async () => mode === 'invoice-first'
      ? applyOrderRefund(createContainerFromDb(second.db), params)
      : new StoreOrderInvoiceService(createContainerFromDb(second.db)).makeUp(11, source.orderId, 1))());
    await waitForFinanceBlock(f.db, second.pid, first.pid); await blocker.exec('COMMIT');
    expect((await a).ok).toBe(true); expect((await b).ok).toBe(mode === 'invoice-first');
  });
  const done = await state(); expect(done.invoices).toHaveLength(mode === 'invoice-first' ? 1 : 0);
  expect(done.refunds).toHaveLength(1); expect(done.records).toHaveLength(0);
  if (mode === 'invoice-first') {
    await finish(done.refunds[0].id);
    const record = await receipt(done.refunds[0].id);
    expect((await state()).invoices.filter(row => !row.isDel).map(row => row.orderId).sort()).toEqual(
      [record.selectedOrderId, record.remainingOrderId].sort());
  }
});

it('writes and reads only the current remaining invoice amount after two actual refund generations', async () => {
  const source = await create(); await invoice(source.id); const first = await apply(source.id);
  await finish(first.refundId); const record = await receipt(first.refundId), remaining = await order(record.remainingOrderId!);
  await finish((await apply(remaining.id)).refundId); const before = await state();
  await out().updateOrderInvoice(outAccount, remaining.orderId, outMetadata);
  await out().updateOrderInvoiceStatus(outAccount, remaining.orderId, outIssued);
  expect((await out().orderInfo(remaining.orderId)).invoice).toMatchObject({ invoice_amount: '29.40', is_invoice: 1 });
  const done = await state(); expect(done.refunds).toEqual(before.refunds); expect(done.records).toEqual(before.records);
  expect(done.bills).toEqual(before.bills); expect(done.payments).toEqual(before.payments);
  expect(done.invoices.map(row => row.invoiceAmount)).toEqual(before.invoices.map(row => row.invoiceAmount));
  await expect(out().updateOrderInvoice(outAccount, source.orderId, outMetadata)).rejects.toThrow('主单');
  await expect(out().updateOrderInvoiceStatus(outAccount, (await order(record.selectedOrderId)).orderId, outIssued)).rejects.toThrow('已退款');
  expect(await state()).toEqual(done);
});

it('replays committed Out metadata during an actual hold and after the source invoice is archived', async () => {
  const source = await create(), original = await invoice(source.id);
  const written = await out().updateOrderInvoice(outAccount, source.orderId, outMetadata), application = await apply(source.id);
  const held = await state();
  expect(await out().updateOrderInvoice(outAccount, source.orderId, outMetadata)).toEqual({ ...written, idempotent: true });
  await expect(out().updateOrderInvoice(outAccount, source.orderId, { ...outMetadata, name: '迟到新抬头' })).rejects.toThrow('申请退款');
  expect(await state()).toEqual(held); await finish(application.refundId); const completed = await state();
  expect(completed.invoices.find(row => row.id === original.id)).toMatchObject({ isDel: 1, isRefund: 1 });
  expect(await out().updateOrderInvoice(outAccount, source.orderId, outMetadata)).toEqual({ ...written, invoice_id: original.id, idempotent: true });
  await expect(out().updateOrderInvoice(outAccount, source.orderId, { ...outMetadata, name: '迟到新抬头' })).rejects.toThrow('主单');
  expect(await state()).toEqual(completed);
});

it('blocks both actual Out writes while an admitted provider request is awaiting its response', async () => {
  const source = await create(false, 7, 'weixin'); await invoice(source.id); const application = await apply(source.id);
  let entered!: () => void, release!: () => void;
  const called = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const request = vi.spyOn(WechatPayService.prototype, 'requestRefund').mockImplementation(async () => {
    entered(); await gate; return { status: 'SUCCESS', providerRefundId: 'local-awaiting-provider' };
  });
  const query = vi.spyOn(WechatPayService.prototype, 'queryRefund').mockRejectedValue(Error('Must not query'));
  const pending = outcome(new StoreOrderRefundService(f.container, f.env).agreeRefund(application.refundId));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([called, pending.then(() => { throw Error('Refund ended before provider admission'); }),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(Error('Provider admission timed out')), 4000); })]);
    const [payment] = await f.db.select().from(storeOrderRefundPayment);
    expect(payment).toMatchObject({ providerStatus: 'REQUESTING', requestAmount: 1280, totalAmount: 5500, attemptCount: 1 });
    await rejectOutDuringHold(source.orderId);
  } finally { if (timeout) clearTimeout(timeout); release(); await pending; }
  expect(await pending).toEqual({ ok: true, value: { completed: true, status: 'SUCCESS' } });
  expect(request).toHaveBeenCalledTimes(1); expect(query).not.toHaveBeenCalled();
  const remaining = await order((await receipt(application.refundId)).remainingOrderId!);
  await out().updateOrderInvoiceStatus(outAccount, remaining.orderId, outIssued);
  expect((await out().orderInfo(remaining.orderId)).invoice).toMatchObject({ invoice_amount: '42.20', is_invoice: 1 });
});

it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL)).each(['out-first', 'refund-first'])
  ('serializes actual Out issuance against atomic-refund application: %s', async mode => {
  const source = await create(), original = await invoice(source.id), params = await input(source.id);
  await withFinancePeers(f.db, async ([blocker, first, second]) => {
    await blocker.exec(mode === 'out-first'
      ? `BEGIN; SELECT id FROM store_order_invoice WHERE id=${original.id} FOR UPDATE`
      : `BEGIN; SELECT id FROM store_order WHERE id=${source.id} FOR UPDATE`);
    const issue = (db: DbClient) => out(db).updateOrderInvoiceStatus(outAccount, source.orderId, outIssued);
    const request = (db: DbClient) => applyOrderRefund(createContainerFromDb(db), params);
    const a = outcome((async () => mode === 'out-first' ? issue(first.db) : request(first.db))());
    await waitForFinanceBlock(f.db, first.pid, blocker.pid);
    const b = outcome((async () => mode === 'out-first' ? request(second.db) : issue(second.db))());
    await waitForFinanceBlock(f.db, second.pid, first.pid); await blocker.exec('COMMIT');
    expect((await a).ok).toBe(true); const denied = await b; expect(denied.ok).toBe(false);
    if (!denied.ok) expect(String(denied.error)).toContain(mode === 'out-first' ? '已开票' : '申请退款');
  });
  const done = await state(); expect(done.refunds).toHaveLength(mode === 'out-first' ? 0 : 1);
  expect(done.invoices).toHaveLength(1); expect(done.invoices[0].isInvoice).toBe(mode === 'out-first' ? 1 : 0);
  expect(done.statuses.filter(row => row.changeType === 'out_order_invoice_status')).toHaveLength(mode === 'out-first' ? 1 : 0);
  expect(done.records).toHaveLength(0); expect(done.payments).toHaveLength(0);
});
