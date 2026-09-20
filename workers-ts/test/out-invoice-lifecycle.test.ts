import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { createContainerFromDb, type DbClient } from '../src/lib/di';
import { OutApiService } from '../src/services/out/OutApiService';
import { StoreOrderInvoiceService } from '../src/services/order/StoreOrderInvoiceService';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';
import { storeOrder, storeOrderCartInfo, storeOrderInvoice, storeOrderRefund, storeOrderStatus, userInvoice } from '../src/models/schema';

let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
const account = { id: 7, appid: 'local-invoice-writer', title: 'Synthetic Out identity', rules: [] };
const metadata = { header_type: 1, type: 1, name: '本地测试抬头', drawer_phone: '13800000000', email: 'local@example.invalid' };
const issued = { is_invoice: 1, invoice_number: '12345678', remark: 'Local only' };
const service = (db: DbClient = f.db) => new OutApiService(createContainerFromDb(db), f.env);
const write = (kind: string, db: DbClient = f.db, orderId = 'local-out-invoice') => kind === 'metadata'
  ? service(db).updateOrderInvoice(account, orderId, metadata)
  : service(db).updateOrderInvoiceStatus(account, orderId, issued);
const state = async () => ({ orders: await f.db.select().from(storeOrder).orderBy(storeOrder.id),
  invoices: await f.db.select().from(storeOrderInvoice).orderBy(storeOrderInvoice.id),
  refunds: await f.db.select().from(storeOrderRefund).orderBy(storeOrderRefund.id),
  statuses: await f.db.select().from(storeOrderStatus).orderBy(storeOrderStatus.id) });
beforeEach(async () => {
  f = await createPcCheckoutQuoteFixture([storeOrderCartInfo, storeOrderRefund, storeOrderInvoice, storeOrderStatus, userInvoice]);
  await f.db.insert(storeOrder).values({ id: 10, orderId: 'local-out-invoice', uid: 11, paid: 1, payType: 'yue', payPrice: '10.00' });
  await f.db.insert(userInvoice).values({ id: 1, uid: 11, name: '原始测试抬头' });
  await new StoreOrderInvoiceService(f.container).makeUp(11, 10, 1);
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
}, 30_000);
afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); } });

it.each(['metadata', 'status'])('blocks a new Out invoice %s write during an actual refund hold row with summary zero', async kind => {
  await f.db.insert(storeOrderRefund).values({ id: 1, uid: 11, storeOrderId: 10, orderId: 'local-open-refund', refundType: 0 });
  const before = await state(); expect(before.orders[0].refundStatus).toBe(0);
  await expect(write(kind)).rejects.toThrow('申请退款'); expect(await state()).toEqual(before);
});

it.each(['metadata', 'status'])('does not write Out invoice %s against an amount that no longer matches the order', async kind => {
  await f.db.update(storeOrderInvoice).set({ invoiceAmount: '9.99' });
  const before = await state(); await expect(write(kind)).rejects.toThrow('发票'); expect(await state()).toEqual(before);
});

it.each(['metadata', 'status'])('preserves Out %s writes, immutable request replay and later edits', async kind => {
  const first = await write(kind); expect(first.idempotent).toBe(false);
  if (kind === 'metadata') await service().updateOrderInvoice(account, 'local-out-invoice', { ...metadata, name: '更新测试抬头' });
  else await service().updateOrderInvoiceStatus(account, 'local-out-invoice', { is_invoice: -1, remark: 'Later rejection' });
  const before = await state();
  expect(await write(kind)).toEqual({ ...first, idempotent: true }); expect(await state()).toEqual(before);
  expect(before.invoices[0].invoiceAmount).toBe('10.00'); expect(before.statuses).toHaveLength(4);
  expect(JSON.stringify(before.statuses)).not.toContain('12345678'); expect(JSON.stringify(before.statuses)).not.toContain(metadata.name);
});

it.each(['metadata', 'status'])('returns a committed Out %s replay during a later hold, without granting a new write', async kind => {
  const first = await write(kind);
  await f.db.insert(storeOrderRefund).values({ id: 1, uid: 11, storeOrderId: 10, refundType: 0 });
  const before = await state(); expect(await write(kind)).toEqual({ ...first, idempotent: true });
  if (kind === 'metadata') await expect(service().updateOrderInvoice(account, 'local-out-invoice', { ...metadata, name: '迟到新抬头' })).rejects.toThrow('申请退款');
  else await expect(service().updateOrderInvoiceStatus(account, 'local-out-invoice', { ...issued, remark: 'New intent' })).rejects.toThrow('申请退款');
  expect(await state()).toEqual(before);
});

it.each([1, 2, 4, 5])('blocks both new Out invoice operations for open refund state %s', async refundType => {
  await f.db.insert(storeOrderRefund).values({ id: 1, uid: 11, storeOrderId: 10, refundType });
  const before = await state();
  for (const kind of ['metadata', 'status']) await expect(write(kind)).rejects.toThrow('申请退款');
  expect(await state()).toEqual(before);
});

it.each(['cancelled', 'deleted', 'refused'])('permits actual invoice writes when the application is %s', async kind => {
  await f.db.insert(storeOrderRefund).values({ id: 1, uid: 11, storeOrderId: 10,
    refundType: kind === 'refused' ? 3 : 0, isCancel: kind === 'cancelled' ? 1 : 0, isDel: kind === 'deleted' ? 1 : 0 });
  expect((await write('metadata')).idempotent).toBe(false); expect((await write('status')).is_invoice).toBe(1);
});

it('allows unpaid applicant metadata but never marks an unpaid application issued', async () => {
  await f.db.update(storeOrder).set({ paid: 0 }); await f.db.update(storeOrderInvoice).set({ isPay: 0 });
  await write('metadata'); const before = await state();
  await expect(write('status')).rejects.toThrow('未支付'); expect(await state()).toEqual(before);
});

it.each(['refunded-invoice', 'pay-flag', 'invalid-state', 'foreign-invoice', 'wrong-category', 'duplicate', 'cancelled-order', 'allocating', 'audit-root'])
  ('does not mutate %s or add an Out replay receipt', async kind => {
  if (kind === 'refunded-invoice') await f.db.update(storeOrderInvoice).set({ isRefund: 1 });
  if (kind === 'pay-flag') await f.db.update(storeOrderInvoice).set({ isPay: 0 });
  if (kind === 'invalid-state') await f.db.update(storeOrderInvoice).set({ isInvoice: 2 });
  if (kind === 'foreign-invoice') await f.db.update(storeOrderInvoice).set({ uid: 22 });
  if (kind === 'wrong-category') await f.db.update(storeOrderInvoice).set({ category: 'other' });
  if (kind === 'duplicate') {
    const { id: _id, ...copy } = (await state()).invoices[0]; await f.db.insert(storeOrderInvoice).values(copy);
  }
  if (kind === 'cancelled-order') await f.db.update(storeOrder).set({ status: -2 });
  if (kind === 'allocating') await f.db.update(storeOrder).set({ supplierAllocationStatus: 1 });
  if (kind === 'audit-root') await f.db.update(storeOrder).set({ pid: -1 });
  const before = await state();
  for (const operation of ['metadata', 'status']) await expect(write(operation)).rejects.toThrow();
  expect(await state()).toEqual(before);
});

it('admits an evidenced net application after a legacy partial refund, never rewrites its amount', async () => {
  await f.db.update(storeOrder).set({ refundPrice: '3.25', refundStatus: 3 });
  await f.db.update(storeOrderInvoice).set({ invoiceAmount: '6.75' });
  await f.db.insert(storeOrderRefund).values({ id: 1, uid: 11, storeOrderId: 10, refundType: 6, refundPrice: '3.25', refundedPrice: '3.25' });
  await write('metadata'); await write('status'); expect((await state()).invoices[0].invoiceAmount).toBe('6.75');
});

it.each(['metadata', 'status'])('rolls back invoice %s and its audit when the replay receipt insertion fails', async kind => {
  await f.exec(`CREATE FUNCTION fail_out_invoice_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.change_type IN ('out_order_invoice','out_order_invoice_status') THEN RAISE EXCEPTION 'local receipt failed'; END IF;
    RETURN NEW; END $$; CREATE TRIGGER fail_out_invoice_receipt BEFORE INSERT ON store_order_status
    FOR EACH ROW EXECUTE FUNCTION fail_out_invoice_receipt()`);
  const before = await state(); await expect(write(kind)).rejects.toThrow(); expect(await state()).toEqual(before);
});

it('rejects duplicate public order numbers without choosing a convenient invoice', async () => {
  await f.db.insert(storeOrder).values({ id: 20, orderId: 'local-out-invoice', uid: 11, payPrice: '10.00', paid: 1 });
  const before = await state(); await expect(write('status')).rejects.toThrow('歧义'); expect(await state()).toEqual(before);
});

it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('locks the payment root before child/invoice and revalidates a changed parent', async () => {
  await f.db.insert(storeOrder).values({ id: 20, orderId: 'local-out-root', uid: 11, pid: -1, paid: 1, payType: 'yue', payPrice: '10.00' });
  await f.db.update(storeOrder).set({ pid: 20 }).where(eq(storeOrder.id, 10));
  await withFinancePeers(f.db, async ([blocker, worker]) => {
    await blocker.exec('BEGIN; SELECT id FROM store_order WHERE id=20 FOR UPDATE');
    const pending = outcome(write('status', worker.db)); await waitForFinanceBlock(f.db, worker.pid, blocker.pid);
    await blocker.exec('SELECT id FROM store_order WHERE id=10 FOR UPDATE NOWAIT; SELECT id FROM store_order_invoice FOR UPDATE NOWAIT; UPDATE store_order SET pid=0 WHERE id=10; COMMIT');
    const before = await state(); expect((await pending).ok).toBe(false); expect(await state()).toEqual(before);
  });
});

it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('revalidates invoice amount after waiting for its row lock', async () => {
  await withFinancePeers(f.db, async ([blocker, worker]) => {
    await blocker.exec('BEGIN; SELECT id FROM store_order_invoice FOR UPDATE');
    const pending = outcome(write('status', worker.db)); await waitForFinanceBlock(f.db, worker.pid, blocker.pid);
    await blocker.exec("UPDATE store_order_invoice SET invoice_amount='9.99'; COMMIT");
    const before = await state(); expect((await pending).ok).toBe(false); expect(await state()).toEqual(before);
  });
});

it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('serializes identical actual Out writes to one change and one replay', async () => {
  await withFinancePeers(f.db, async ([blocker, first, second]) => {
    await blocker.exec('BEGIN; SELECT id FROM store_order_invoice FOR UPDATE');
    const a = outcome(write('status', first.db)); await waitForFinanceBlock(f.db, first.pid, blocker.pid);
    const b = outcome(write('status', second.db)); await waitForFinanceBlock(f.db, second.pid, first.pid);
    await blocker.exec('COMMIT'); const results = await Promise.all([a, b]);
    expect(results.every(row => row.ok)).toBe(true);
    expect(results.flatMap(row => row.ok ? [row.value.idempotent] : [])).toEqual([false, true]);
  });
  expect((await state()).statuses).toHaveLength(2);
});
