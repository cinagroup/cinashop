import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { StoreOrderCreateService } from '../src/services/order/StoreOrderCreateService';
import { SupplierFulfillmentService } from '../src/services/supplier/SupplierFulfillmentService';
import { allocatePaidOrderBySupplier } from '../src/services/order/OrderSupplierAllocationService';
import { recordSupplierPayment } from '../src/services/supplier/SupplierFinanceService';
import { applyOrderRefundWithMaterialization, finalizeStoreOrderRefund } from '../src/services/order/StoreOrderRefundService';
import { createContainerFromDb, withTx, type DbClient } from '../src/lib/di';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';
import { REFUND_ORDER_SPLIT_SQL } from '../src/migrations/refundOrderSplit';
import { storeOrderInvoiceEvidence } from '../src/models/schema/invoice_evidence';
import { storeOrderInvoiceAllocation } from '../src/models/schema/invoice_allocation';
import { agentLevel, printDocument, storeCart, storeOrder, storeOrderCartInfo, storeOrderInvoice,
  storeOrderOutbox, storeOrderRefund, storeOrderRefundPayment, storeOrderStatus, storeProduct, storeProductAttrValue,
  systemSupplier, orderWaybillJob, userBrokerage, supplierFlowingWater, supplierTransactions } from '../src/models/schema';

let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
const delivery = { deliveryType: 'express' as const, deliveryName: 'Synthetic shipping', deliveryCode: 'local',
  deliveryId: 'NO-SHIPMENT', fictitiousContent: '', deliveryUid: 0 };
const order = async (id: number) => (await f.db.select().from(storeOrder).where(eq(storeOrder.id, id)))[0];
const invoices = () => f.db.select().from(storeOrderInvoice).orderBy(storeOrderInvoice.id);
const receipts = () => f.db.select().from(storeOrderInvoiceAllocation).orderBy(storeOrderInvoiceAllocation.addTime, storeOrderInvoiceAllocation.id);
const state = async () => ({ ...await f.snapshot(), invoices: await invoices(), receipts: await receipts(),
  evidence: await f.db.select().from(storeOrderInvoiceEvidence).orderBy(storeOrderInvoiceEvidence.invoiceId, storeOrderInvoiceEvidence.kind, storeOrderInvoiceEvidence.documentNumber),
  carts: await f.db.select().from(storeOrderCartInfo).orderBy(storeOrderCartInfo.id),
  statuses: await f.db.select().from(storeOrderStatus).orderBy(storeOrderStatus.id),
  outbox: await f.db.select().from(storeOrderOutbox).orderBy(storeOrderOutbox.id) });
const create = async (mixed = false) => {
  if (mixed) {
    await f.db.insert(systemSupplier).values({ id: 7, adminId: 7, supplierName: 'Synthetic supplier' });
    await f.db.update(storeProduct).set({ type: 2, relationId: 7, freight: 2, tempId: 0, postage: '3.00' }).where(eq(storeProduct.id, 70));
    await f.db.insert(storeProduct).values({ id: 71, storeName: 'Platform line', price: '30.00', stock: 8, isShow: 1, freight: 1 });
    await f.db.insert(storeProductAttrValue).values({ id: 2, productId: 71, unique: 'free0071', suk: 'Standard', price: '30.00', stock: 8 });
    await f.db.insert(storeCart).values({ id: 2, uid: 11, productId: 71, productAttrUnique: 'free0071', cartNum: 1, status: 1, isNew: 1 });
  }
  const created = await StoreOrderCreateService.createWithRuntime(f.container,
    { CONFIG_KV: f.env.CONFIG_KV, nextOrderId: async () => 'invoice_split_checkout' },
    { uid: 11, key: 'invoice_split', cartIds: mixed ? [1, 2] : [1], addressId: 11, userIp: '127.0.0.1' });
  // Synthetic paid admission; never calls a payment or shipping provider.
  const [paid] = await f.db.update(storeOrder).set({ paid: 1, payType: 'yue' })
    .where(eq(storeOrder.orderId, created.orderId)).returning();
  await f.db.insert(storeOrderInvoice).values({ uid: 11, orderId: paid.id, isPay: 1,
    invoiceAmount: paid.payPrice, name: 'Synthetic invoice', remark: 'Preserve this application' });
  return paid;
};
const split = async (id: number, quantity = 1) => {
  const [cart] = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, id)).orderBy(storeOrderCartInfo.id);
  return new SupplierFulfillmentService(f.container, f.env).splitDelivery((await order(id)).supplierId,
    id, delivery, [{ cartId: cart.cartId, cartNum: quantity }]);
};
beforeEach(async () => {
  f = await createPcCheckoutQuoteFixture([agentLevel, printDocument, storeOrderCartInfo, storeOrderInvoice,
    storeOrderOutbox, storeOrderRefund, storeOrderRefundPayment, storeOrderStatus, systemSupplier, orderWaybillJob,
    userBrokerage, supplierFlowingWater, supplierTransactions]);
  await f.exec(REFUND_ORDER_SPLIT_SQL);
  await f.exec('CREATE UNIQUE INDEX invoice_split_outbox ON store_order_outbox(event_key)');
  await f.exec('CREATE UNIQUE INDEX invoice_split_flow ON supplier_flowing_water(order_id); CREATE UNIQUE INDEX invoice_split_transaction ON supplier_transactions(order_id)');
  await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
  await f.db.update(storeCart).set({ cartNum: 3 }).where(eq(storeCart.id, 1));
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
}, 30_000);
afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); } });

it('partitions an unissued application on real fulfillment and preserves the remaining invoice ID on another split', async () => {
  const source = await create(), [original] = await invoices(), first = await split(source.id);
  const after = await invoices();
  expect(after.find(row => row.id === original.id)).toEqual({ ...original, isDel: 1 });
  expect(after.filter(row => !row.isDel).map(row => [row.orderId, row.invoiceAmount])).toEqual([
    [first.order_id, (await order(first.order_id)).payPrice],
    [first.remaining_order_id, (await order(first.remaining_order_id!)).payPrice],
  ]);
  const retained = after.find(row => row.orderId === first.remaining_order_id)!;
  const second = await split(first.remaining_order_id!);
  expect((await invoices()).find(row => row.id === retained.id)).toMatchObject({
    orderId: second.remaining_order_id, invoiceAmount: (await order(second.remaining_order_id!)).payPrice, isDel: 0,
  });
});

it('partitions a mixed supplier/platform paid order invoice with the actual allocated child amounts', async () => {
  const source = await create(true), [original] = await invoices();
  const result = await withTx(f.container, tx => allocatePaidOrderBySupplier(tx, source.id, source.orderId));
  expect(result.split).toBe(true);
  expect((await invoices()).find(row => row.id === original.id)).toEqual({ ...original, isDel: 1 });
  expect((await invoices()).filter(row => !row.isDel).map(row => [row.orderId, row.invoiceAmount])).toEqual(
    result.fulfillmentOrders.map(row => [row.id, row.payPrice]));
});

it.each([0, -1])('preserves metadata and never-issued state %s, including Out edit timestamps', async isInvoice => {
  const source = await create();
  await f.db.update(storeOrderInvoice).set({ isInvoice, invoiceTime: 123, dutyNumber: 'LOCAL', email: 'qa@example.invalid' });
  const [original] = await invoices(), result = await split(source.id), [receipt] = await receipts();
  expect(JSON.parse(receipt.sourceSnapshot)).toEqual(original);
  expect(receipt).toMatchObject({ sourceInvoiceId: original.id, sourceOrderId: source.id, paymentOrderId: source.id, reason: 'fulfillment', uid: 11 });
  expect(JSON.parse(receipt.targets)).toEqual([
    { invoiceId: 2, orderId: result.order_id, supplierId: 0, amount: '12.33' },
    { invoiceId: 3, orderId: result.remaining_order_id, supplierId: 0, amount: '24.67' },
  ]);
  for (const invoice of (await invoices()).filter(row => !row.isDel)) {
    expect(invoice).toEqual({ ...original, id: invoice.id, orderId: invoice.orderId, invoiceAmount: invoice.invoiceAmount });
  }
});

it('keeps the last cent and records both generations while leaving issued siblings untouched', async () => {
  const source = await create(), first = await split(source.id);
  const [sibling] = (await invoices()).filter(row => row.orderId === first.order_id);
  await f.db.update(storeOrderInvoice).set({ isInvoice: 1, invoiceNumber: 'LOCAL-ISSUED' }).where(eq(storeOrderInvoice.id, sibling.id));
  const second = await split(first.remaining_order_id!);
  expect((await invoices()).filter(row => !row.isDel).map(row => row.invoiceAmount).sort()).toEqual(['12.33', '12.33', '12.34']);
  expect(await receipts()).toHaveLength(2);
  expect((await invoices()).find(row => row.id === sibling.id)).toEqual({ ...sibling, isInvoice: 1, invoiceNumber: 'LOCAL-ISSUED' });
  expect((await order(second.remaining_order_id!)).payPrice).toBe('12.34');
});

it('supplier allocation followed by repeated supplier fulfillment preserves platform invoice isolation', async () => {
  const source = await create(true);
  const result = await withTx(f.container, tx => allocatePaidOrderBySupplier(tx, source.id, source.orderId));
  const supplier = result.fulfillmentOrders.find(row => row.supplierId === 7)!, platform = result.fulfillmentOrders.find(row => !row.supplierId)!;
  await withTx(f.container, tx => recordSupplierPayment(tx, supplier, 100));
  const platformInvoice = (await invoices()).find(row => row.orderId === platform.id)!;
  const first = await split(supplier.id); await split(first.remaining_order_id!);
  expect((await invoices()).find(row => row.id === platformInvoice.id)).toEqual(platformInvoice);
  expect((await invoices()).filter(row => !row.isDel).map(row => row.invoiceAmount).sort()).toEqual(['13.00', '13.00', '13.00', '30.00']);
  expect((await receipts()).map(row => row.reason).sort()).toEqual(['fulfillment', 'fulfillment', 'supplier']);
});

it.each(['issued', 'cleared', 'deleted', 'archived', 'wrong-amount', 'refunded', 'duplicate'] as const)
  ('blocks unsafe invoice %s in both actual split entry points with no business writes', async kind => {
    const source = await create(true), [invoice] = await invoices();
    if (['issued', 'cleared', 'deleted', 'archived'].includes(kind)) {
      await f.db.update(storeOrderInvoice).set({ isInvoice: 1, invoiceNumber: 'LOCAL-ISSUED' });
      if (kind !== 'issued') await f.db.update(storeOrderInvoice).set({ isInvoice: -1, invoiceNumber: '' });
      if (kind === 'deleted') await f.db.delete(storeOrderInvoice);
      if (kind === 'archived') await f.db.update(storeOrderInvoice).set({ isDel: 1 });
    } else if (kind === 'wrong-amount') await f.db.update(storeOrderInvoice).set({ invoiceAmount: '0.01' });
    else if (kind === 'refunded') await f.db.update(storeOrderInvoice).set({ isRefund: 1 });
    else { const { id: _id, ...base } = invoice; await f.db.insert(storeOrderInvoice).values(base); }
    const before = await state();
    await expect(split(source.id)).rejects.toThrow();
    expect(await state()).toEqual(before);
    await expect(withTx(f.container, tx => allocatePaidOrderBySupplier(tx, source.id, source.orderId))).rejects.toThrow();
    expect(await state()).toEqual(before);
  });

it('blocks a pre-install archived invoice even if a fresh active replacement has a creation baseline', async () => {
  const source = await create();
  await f.exec('ALTER TABLE store_order_invoice DISABLE TRIGGER soi_capture_evidence');
  await f.db.insert(storeOrderInvoice).values({ uid: 11, orderId: source.id, isDel: 1 });
  await f.exec('ALTER TABLE store_order_invoice ENABLE TRIGGER soi_capture_evidence');
  const before = await state(); await expect(split(source.id)).rejects.toThrow('未核验'); expect(await state()).toEqual(before);
});

it.each(['no-row', 'archived'] as const)('never invents an invoice for %s and still enforces history', async kind => {
  const source = await create();
  if (kind === 'no-row') await f.db.delete(storeOrderInvoice);
  else await f.db.update(storeOrderInvoice).set({ isDel: 1 });
  const before = await invoices(); await split(source.id);
  expect(await invoices()).toEqual(before); expect(await receipts()).toEqual([]);
});

it.each(['fulfillment', 'supplier'] as const)('does not reallocate invoice when %s makes no physical split', async kind => {
  const source = await create(); await f.db.update(storeOrderInvoice).set({ isInvoice: 1, invoiceNumber: 'LOCAL-ISSUED' });
  const before = await invoices();
  if (kind === 'fulfillment') expect(await split(source.id, 3)).toMatchObject({ split: false });
  else expect(await withTx(f.container, tx => allocatePaidOrderBySupplier(tx, source.id, source.orderId))).toMatchObject({ split: false });
  expect(await invoices()).toEqual(before); expect(await receipts()).toEqual([]);
});

it.each(['fulfillment', 'supplier'] as const)('replays %s after later issuance without rewriting invoices or receipts', async kind => {
  const source = await create(kind === 'supplier');
  const options = { replay: { accountId: 77, requestHash: 'd'.repeat(64), changeType: 'out_order_split_delivery' as const } };
  const run = () => kind === 'supplier'
    ? withTx(f.container, tx => allocatePaidOrderBySupplier(tx, source.id, source.orderId))
    : new SupplierFulfillmentService(f.container, f.env).splitDelivery(0, source.id, delivery, [{ cartId: '1', cartNum: 1 }], options);
  await run();
  await f.db.update(storeOrderInvoice).set({ isInvoice: 1, invoiceNumber: 'AFTER-COMMIT' });
  const before = await state(); await run(); expect(await state()).toEqual(before);
});

it.each(['insert', 'archive', 'receipt', 'late-audit', 'suppressed-receipt'] as const)
  ('rolls back orders, invoice evidence and notices after %s failure and then retries once', async kind => {
    const source = await create(), before = await state();
    const table = kind.includes('receipt') ? 'store_order_invoice_allocation' : kind === 'late-audit' ? 'store_order_status' : 'store_order_invoice';
    const event = kind === 'archive' ? 'UPDATE' : 'INSERT';
    const body = kind === 'suppressed-receipt' ? 'RETURN NULL;' : "RAISE EXCEPTION 'synthetic invoice failure';";
    await f.exec(`CREATE FUNCTION fail_invoice_split() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} END $$;
      CREATE TRIGGER fail_invoice_split BEFORE ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_invoice_split()`);
    await expect(split(source.id)).rejects.toThrow(); expect(await state()).toEqual(before);
    await f.exec(`DROP TRIGGER fail_invoice_split ON ${table}`);
    await split(source.id); expect(await receipts()).toHaveLength(1); expect(await invoices()).toHaveLength(3);
  });

it('rejects invoice issuance then clearing in a late receipt trigger and rolls the entire split back', async () => {
  const source = await create(), before = await state();
  await f.exec(`CREATE FUNCTION issue_during_split() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    UPDATE store_order_invoice SET is_invoice=1,invoice_number='LATE' WHERE id=NEW.source_invoice_id;
    UPDATE store_order_invoice SET is_invoice=-1,invoice_number='' WHERE id=NEW.source_invoice_id;
    RETURN NEW; END $$; CREATE TRIGGER issue_during_split AFTER INSERT ON store_order_invoice_allocation
    FOR EACH ROW EXECUTE FUNCTION issue_during_split()`);
  await expect(split(source.id)).rejects.toThrow(); expect(await state()).toEqual(before);
});

it.each(['receipt-rewrite', 'archive-restored', 'archive-amount', 'duplicate-child'] as const)
  ('rejects late SQL drift %s instead of committing inconsistent allocation evidence', async kind => {
    const source = await create(), before = await state();
    const body = kind === 'receipt-rewrite' ? `NEW.targets := '[{},{}]';`
      : kind === 'archive-restored' ? 'UPDATE store_order_invoice SET is_del=0 WHERE id=NEW.source_invoice_id;'
      : kind === 'archive-amount' ? "UPDATE store_order_invoice SET invoice_amount='0.01' WHERE id=NEW.source_invoice_id;"
      : `INSERT INTO store_order_invoice(uid,order_id,is_pay,invoice_amount)
        SELECT uid,order_id,is_pay,invoice_amount FROM store_order_invoice WHERE id=(NEW.targets::jsonb->0->>'invoiceId')::integer;`;
    await f.exec(`CREATE FUNCTION drift_invoice_split() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} RETURN NEW; END $$;
      CREATE TRIGGER drift_invoice_split ${kind === 'receipt-rewrite' ? 'BEFORE' : 'AFTER'} INSERT ON store_order_invoice_allocation
      FOR EACH ROW EXECUTE FUNCTION drift_invoice_split()`);
    await expect(split(source.id)).rejects.toThrow(); expect(await state()).toEqual(before);
  });

it.each(['null-identity', 'missing-identity', 'oversized-source', 'non-array-targets', 'excess-targets'] as const)
  ('the real candidate DDL rejects malformed receipt %s', async kind => {
    const source = await create(); await split(source.id); const [receipt] = await receipts();
    const snapshot = JSON.parse(receipt.sourceSnapshot);
    if (kind === 'null-identity') snapshot.uid = null;
    if (kind === 'missing-identity') delete snapshot.uid;
    if (kind === 'oversized-source') snapshot.extra = 'x'.repeat(16384);
    const targets = kind === 'non-array-targets' ? '{}' : kind === 'excess-targets' ? JSON.stringify(Array(201).fill({})) : receipt.targets;
    const before = await receipts();
    await expect(f.db.insert(storeOrderInvoiceAllocation).values({ ...receipt, id: crypto.randomUUID().replaceAll('-', ''),
      sourceSnapshot: JSON.stringify(snapshot), targets })).rejects.toThrow();
    expect(await receipts()).toEqual(before);
  });

it.each(['UPDATE store_order_invoice_allocation SET reason=\'supplier\'', 'DELETE FROM store_order_invoice_allocation',
  'TRUNCATE store_order_invoice_allocation'])('protects committed allocation evidence: %s', async statement => {
  const source = await create(); await split(source.id); const before = await receipts();
  await expect(f.exec(statement)).rejects.toThrow('append-only'); expect(await receipts()).toEqual(before);
});

it.each(['store_order_invoice_evidence', 'store_order_invoice_allocation'])('missing candidate table %s cannot authorize a no-invoice split', async table => {
  const source = await create(); await f.db.delete(storeOrderInvoice);
  await f.exec(`ALTER TABLE ${table} RENAME TO absent_candidate`);
  const before = await f.snapshot(); await expect(split(source.id)).rejects.toThrow(); expect(await f.snapshot()).toEqual(before);
});

it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('revalidates invoice history after a real independent invoice lock wait', async () => {
  const source = await create(), [invoice] = await invoices();
  await withFinancePeers(f.db, async ([holder, buyer]) => {
    await holder.exec(`BEGIN; SELECT id FROM store_order_invoice WHERE id=${invoice.id} FOR UPDATE`);
    const pending = outcome(new SupplierFulfillmentService(createContainerFromDb(buyer.db), f.env)
      .splitDelivery(0, source.id, delivery, [{ cartId: '1', cartNum: 1 }]));
    await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
    await holder.db.update(storeOrderInvoice).set({ isInvoice: 1, invoiceNumber: 'LOCKED' });
    await holder.db.update(storeOrderInvoice).set({ isInvoice: -1, invoiceNumber: '' });
    await holder.exec('COMMIT'); const before = await state(), result = await pending;
    expect(result.ok).toBe(false); expect(await state()).toEqual(before);
  });
}, 15_000);

it('a fulfillment child invoice continues through actual atomic refund and a further remainder delivery split', async () => {
  await f.db.update(storeCart).set({ cartNum: 5 }).where(eq(storeCart.id, 1));
  const source = await create(), shipped = await split(source.id), remainder = await order(shipped.remaining_order_id!);
  const [cart] = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, remainder.id));
  const application = await applyOrderRefundWithMaterialization(f.container, { uid: 11, orderId: remainder.orderId,
    applyType: 1, refundReason: 'Synthetic invoice roundtrip', refundExplain: '',
    cartSelections: [{ cartId: Number(cart.cartId), cartNum: 1 }] });
  expect(await finalizeStoreOrderRefund(f.container, application.refundId)).toBe('completed');
  const done = await state(); expect(await finalizeStoreOrderRefund(f.container, application.refundId)).toBe('already-completed');
  expect(await state()).toEqual(done);
  await split(remainder.id);
  const all = (await invoices()).filter(row => !row.isDel);
  expect(all.filter(row => row.isRefund === 1)).toHaveLength(1);
  expect(all.reduce((sum, row) => sum + Math.round(Number(row.invoiceAmount) * 100), 0)).toBe(5900);
  for (const invoice of all) expect(invoice.invoiceAmount).toBe((await order(invoice.orderId)).payPrice);
});

it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('serializes independent supplier allocation retries into one invoice allocation', async () => {
  const source = await create(true);
  const run = (db: DbClient) => withTx(createContainerFromDb(db), tx => allocatePaidOrderBySupplier(tx, source.id, source.orderId));
  await withFinancePeers(f.db, async ([holder, first, second]) => {
    await holder.exec(`BEGIN; SELECT id FROM store_order WHERE id=${source.id} FOR UPDATE`);
    const a = outcome(run(first.db)); await waitForFinanceBlock(f.db, first.pid, holder.pid);
    const b = outcome(run(second.db)); await waitForFinanceBlock(f.db, second.pid, first.pid);
    await holder.exec('COMMIT'); expect((await a).ok).toBe(true); expect((await b).ok).toBe(true);
  });
  expect(await invoices()).toHaveLength(3); expect(await receipts()).toHaveLength(1);
}, 15_000);
