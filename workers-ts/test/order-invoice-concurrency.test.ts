import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppVariables, Env } from '../src/env';
import { orderMakeUpInvoice, orderInvoiceList } from '../src/controllers/api/v1/OrderController';
import { financePostgres } from './helpers/financePostgres';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';
import { createContainerFromDb, type DbClient } from '../src/lib/di';
import { StoreOrderInvoiceService } from '../src/services/order/StoreOrderInvoiceService';
import { storeOrder, storeOrderCartInfo, storeOrderRefund, storeOrderInvoice, userInvoice } from '../src/models/schema';

let f: Awaited<ReturnType<typeof financePostgres>>;
const service = (db: DbClient = f.db) => new StoreOrderInvoiceService(createContainerFromDb(db));
const state = async () => ({
  orders: await f.db.select().from(storeOrder).orderBy(storeOrder.id),
  refunds: await f.db.select().from(storeOrderRefund).orderBy(storeOrderRefund.id),
  invoices: await f.db.select().from(storeOrderInvoice).orderBy(storeOrderInvoice.id),
  templates: await f.db.select().from(userInvoice).orderBy(userInvoice.id),
});
beforeEach(async () => {
  f = await financePostgres([storeOrder, storeOrderCartInfo, storeOrderRefund, storeOrderInvoice, userInvoice]);
  await f.db.insert(storeOrder).values({ id: 10, orderId: 'local-invoice-order', uid: 11, paid: 1, payType: 'yue',
    totalNum: 1, payPrice: '10.00', totalPrice: '10.00' });
  await f.db.insert(userInvoice).values({ id: 1, uid: 11, name: 'Local invoice title', email: 'local@example.invalid' });
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
}, 30_000);
afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); } });

it('rejects an ambiguous numeric reference rather than invoicing an arbitrary matching order', async () => {
  await f.db.insert(storeOrder).values({ id: 20, orderId: '10', uid: 11, paid: 1, payType: 'yue', payPrice: '20.00' });
  const before = await state(); await expect(service().makeUp(11, '10', 1)).rejects.toThrow(); expect(await state()).toEqual(before);
});

it('rejects an active refund even when the ordinary application leaves the order summary flag at zero', async () => {
  await f.db.insert(storeOrderRefund).values({ id: 1, storeOrderId: 10, uid: 11, orderId: 'local-refund', refundNum: 1, refundPrice: '10.00' });
  const before = await state(); await expect(service().makeUp(11, 10, 1)).rejects.toThrow(); expect(await state()).toEqual(before);
});

it('does not create an invoice for the payment audit root after physical splitting', async () => {
  await f.db.update(storeOrder).set({ pid: -1 }).where(eq(storeOrder.id, 10));
  const before = await state(); await expect(service().makeUp(11, 10, 1)).rejects.toThrow(); expect(await state()).toEqual(before);
});

it.each([0, 1])('preserves paid/unpaid creation and freezes the owned template snapshot; paid=%s', async paid => {
  await f.db.update(storeOrder).set({ paid }).where(eq(storeOrder.id, 10));
  const result = await service().makeUp(11, 'local-invoice-order', 1);
  const before = await state(); expect(before.invoices).toHaveLength(1);
  expect(before.invoices[0]).toMatchObject({ id: result.id, uid: 11, orderId: 10, invoiceId: 1,
    invoiceAmount: '10.00', isPay: paid, name: 'Local invoice title' });
  await f.db.update(userInvoice).set({ name: 'Later title' }).where(eq(userInvoice.id, 1));
  await expect(service().makeUp(11, 10, 1)).rejects.toThrow('发票已申请');
  expect((await state()).invoices).toEqual(before.invoices);
});

it.each([1, 2, 4, 5])('rejects actual open refund state %s without relying on summary flags', async refundType => {
  await f.db.insert(storeOrderRefund).values({ id: 1, storeOrderId: 10, uid: 11, refundType });
  const before = await state(); await expect(service().makeUp(11, 10, 1)).rejects.toThrow('申请退款'); expect(await state()).toEqual(before);
});

it.each(['cancelled', 'deleted', 'refused'])('does not retain an invoice hold for a %s application', async kind => {
  await f.db.insert(storeOrderRefund).values({ id: 1, storeOrderId: 10, uid: 11,
    isCancel: kind === 'cancelled' ? 1 : 0, isDel: kind === 'deleted' ? 1 : 0, refundType: kind === 'refused' ? 3 : 0 });
  expect(await service().makeUp(11, 10, 1)).toMatchObject({ id: expect.any(Number) });
});

it('invoices only the evidenced unrefunded cash after a nonmaterialized partial refund', async () => {
  await f.db.update(storeOrder).set({ refundStatus: 3, refundPrice: '3.25' }).where(eq(storeOrder.id, 10));
  await f.db.insert(storeOrderRefund).values({ id: 1, storeOrderId: 10, uid: 11, refundType: 6,
    refundPrice: '3.25', refundedPrice: '3.25' });
  await service().makeUp(11, 10, 1); expect((await state()).invoices[0].invoiceAmount).toBe('6.75');
});

it.each(['summary', 'owner', 'supplier', 'refunded-amount', 'overpaid', 'zero'])('rejects inconsistent %s refund amount evidence', async kind => {
  await f.db.update(storeOrder).set({ refundStatus: 3, refundPrice: kind === 'summary' ? '3.24' : kind === 'overpaid' ? '10.01' : kind === 'zero' ? '10.00' : '3.25' });
  const amount = kind === 'overpaid' ? '10.01' : kind === 'zero' ? '10.00' : '3.25';
  await f.db.insert(storeOrderRefund).values({ id: 1, storeOrderId: 10, uid: kind === 'owner' ? 22 : 11,
    supplierId: kind === 'supplier' ? 7 : 0, refundType: 6, refundPrice: amount,
    refundedPrice: kind === 'refunded-amount' ? '3.24' : amount });
  const before = await state(); await expect(service().makeUp(11, 10, 1)).rejects.toThrow(); expect(await state()).toEqual(before);
});

it.each(['foreign-order', 'deleted-order', 'system-deleted', 'cancelled-order', 'allocating', 'foreign-template', 'deleted-template'])
  ('does not write for %s', async kind => {
  if (kind === 'foreign-order') await f.db.update(storeOrder).set({ uid: 22 });
  if (kind === 'deleted-order') await f.db.update(storeOrder).set({ isDel: 1 });
  if (kind === 'system-deleted') await f.db.update(storeOrder).set({ isSystemDel: 1 });
  if (kind === 'cancelled-order') await f.db.update(storeOrder).set({ status: -2 });
  if (kind === 'allocating') await f.db.update(storeOrder).set({ supplierAllocationStatus: 1 });
  if (kind === 'foreign-template') await f.db.update(userInvoice).set({ uid: 22 });
  if (kind === 'deleted-template') await f.db.update(userInvoice).set({ isDel: 1 });
  const before = await state(); await expect(service().makeUp(11, 10, 1)).rejects.toThrow(); expect(await state()).toEqual(before);
});

it.each(['foreign', 'category', 'duplicate'])('rejects existing %s invoice evidence instead of creating another record', async kind => {
  await f.db.insert(storeOrderInvoice).values({ id: 1, orderId: 10, uid: kind === 'foreign' ? 22 : 11,
    category: kind === 'category' ? 'other' : 'order' });
  if (kind === 'duplicate') await f.db.insert(storeOrderInvoice).values({ id: 2, orderId: 10, uid: 11 });
  const before = await state(); await expect(service().makeUp(11, 10, 1)).rejects.toThrow('关联异常'); expect(await state()).toEqual(before);
});

it('preserves existing active root documents while filtering cross-owner, deleted and non-order records', async () => {
  await f.db.update(storeOrder).set({ pid: -1 });
  await f.db.insert(storeOrder).values([
    { id: 20, orderId: 'hidden-system-order', uid: 11, isSystemDel: 1 },
    { id: 30, orderId: 'foreign-order', uid: 22 },
    { id: 40, orderId: 'refunded-order', uid: 11, refundStatus: 2 },
  ]);
  await f.db.insert(storeOrderInvoice).values([
    { id: 1, orderId: 10, uid: 11, isPay: 1, isInvoice: 1, invoiceNumber: 'ORIGINAL-LOCAL-DOCUMENT' },
    { id: 2, orderId: 10, uid: 11, isPay: 1, isDel: 1 },
    { id: 3, orderId: 10, uid: 11, isPay: 1, category: 'other' },
    { id: 4, orderId: 20, uid: 11, isPay: 1 },
    { id: 5, orderId: 30, uid: 11, isPay: 1 },
    { id: 6, orderId: 40, uid: 11, isPay: 1 },
  ]);
  expect((await service().list(11)).map(row => row.id)).toEqual([1]);
  expect(await service().list(22)).toEqual([]);
});

it('rolls back the whole invoice creation on a late insert trigger failure', async () => {
  await f.exec(`CREATE FUNCTION fail_invoice() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'local invoice failure'; END $$;
    CREATE TRIGGER fail_invoice AFTER INSERT ON store_order_invoice FOR EACH ROW EXECUTE FUNCTION fail_invoice()`);
  const before = await state(); await expect(service().makeUp(11, 10, 1)).rejects.toThrow(); expect(await state()).toEqual(before);
});

it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('serializes order-number and numeric-ID aliases before either can insert a duplicate', async () => {
  await withFinancePeers(f.db, async ([blocker, first, second]) => {
    await blocker.exec('BEGIN; SELECT id FROM user_invoice WHERE id=1 FOR UPDATE');
    const a = outcome(service(first.db).makeUp(11, 'local-invoice-order', 1));
    let b: ReturnType<typeof outcome<{ id: number }>> | undefined;
    try {
      await waitForFinanceBlock(f.db, first.pid, blocker.pid);
      b = outcome(service(second.db).makeUp(11, 10, 1)); await waitForFinanceBlock(f.db, second.pid, first.pid);
    } finally { await blocker.exec('COMMIT'); }
    expect((await a).ok).toBe(true); expect((await b)!.ok).toBe(false);
  });
  expect((await state()).invoices).toHaveLength(1);
});

it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('waits for a template deletion and refuses to snapshot a deleted title', async () => {
  await withFinancePeers(f.db, async ([blocker, worker]) => {
    await blocker.exec('BEGIN; SELECT id FROM user_invoice WHERE id=1 FOR UPDATE');
    const pending = outcome(service(worker.db).makeUp(11, 10, 1));
    await waitForFinanceBlock(f.db, worker.pid, blocker.pid);
    await blocker.exec('UPDATE user_invoice SET is_del=1 WHERE id=1; COMMIT');
    expect((await pending).ok).toBe(false);
  });
  expect((await state()).invoices).toHaveLength(0);
});

it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('locks the payment root before a child and rejects changed ancestry after waiting', async () => {
  await f.db.update(storeOrder).set({ pid: -1 });
  await f.db.insert(storeOrder).values({ id: 20, orderId: 'child-order', pid: 10, uid: 11, paid: 1, payType: 'yue', payPrice: '6.00' });
  await withFinancePeers(f.db, async ([blocker, worker]) => {
    await blocker.exec('BEGIN; SELECT id FROM store_order WHERE id=10 FOR UPDATE');
    const pending = outcome(service(worker.db).makeUp(11, 20, 1));
    await waitForFinanceBlock(f.db, worker.pid, blocker.pid);
    await blocker.exec('SELECT id FROM store_order WHERE id=20 FOR UPDATE NOWAIT; SELECT id FROM user_invoice WHERE id=1 FOR UPDATE NOWAIT; UPDATE store_order SET pid=0 WHERE id=20; COMMIT');
    const before = await state(); expect((await pending).ok).toBe(false); expect(await state()).toEqual(before);
  });
});

it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('uses the locked current amount after a concurrent order change', async () => {
  await withFinancePeers(f.db, async ([blocker, worker]) => {
    await blocker.exec('BEGIN; SELECT id FROM store_order WHERE id=10 FOR UPDATE');
    const pending = outcome(service(worker.db).makeUp(11, 10, 1)); await waitForFinanceBlock(f.db, worker.pid, blocker.pid);
    await blocker.exec("UPDATE store_order SET pay_price=12.34 WHERE id=10; COMMIT"); expect((await pending).ok).toBe(true);
  });
  expect((await state()).invoices[0].invoiceAmount).toBe('12.34');
});

it('keeps the actual v1/v2 controller contract and refuses cross-route duplicate application', async () => {
  const app = new Hono<{ Variables: AppVariables; Bindings: Env }>();
  app.use('*', async (c, next) => {
    c.set('container', createContainerFromDb(f.db)); c.set('uid', c.req.header('x-test-user') === '11' ? 11 : 0); await next();
  });
  app.onError((error, c) => c.json({ status: 400, msg: error.message, data: null }));
  for (const prefix of ['/api', '/api/v2']) {
    app.post(`${prefix}/order/make_up_invoice`, orderMakeUpInvoice); app.get(`${prefix}/order/invoice_list`, orderInvoiceList);
  }
  const request = (prefix: string, reference: string | number, authorized = true) => app.request(`${prefix}/order/make_up_invoice`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(authorized ? { 'x-test-user': '11' } : {}) },
    body: JSON.stringify({ order_id: reference, invoice_id: 1 }),
  });
  expect(await (await request('/api', 'local-invoice-order', false)).json()).toMatchObject({ status: 400 });
  expect(await (await request('/api', 'local-invoice-order')).json()).toMatchObject({ status: 200, data: { id: expect.any(Number) } });
  expect(await (await request('/api/v2', 10)).json()).toMatchObject({ status: 400, msg: '发票已申请，正在审核打印中' });
  const response = await app.request('/api/v2/order/invoice_list', { headers: { 'x-test-user': '11' } });
  expect(await response.json()).toMatchObject({ status: 200, data: [{ uid: 11, invoiceAmount: '10.00' }] });
  expect((await state()).invoices).toHaveLength(1);
});

it.each([0, 1])('does not duplicate an active payment-root invoice; root document deleted=%s', async deleted => {
  await f.db.update(storeOrder).set({ pid: -1, supplierAllocationStatus: 2 });
  await f.db.insert(storeOrder).values({ id: 20, orderId: 'mixed-supplier-child', pid: 10, uid: 11,
    supplierId: 7, paid: 1, payType: 'yue', payPrice: '6.00' });
  await f.db.insert(storeOrderInvoice).values({ id: 10, uid: 11, orderId: 10, invoiceAmount: '10.00',
    isPay: 1, isInvoice: 1, invoiceNumber: 'EXISTING-LOCAL-DOCUMENT', isDel: deleted });
  const before = await state();
  if (!deleted) {
    await expect(service().makeUp(11, 20, 1)).rejects.toThrow('主单已有开票记录'); expect(await state()).toEqual(before);
  } else {
    await service().makeUp(11, 20, 1);
    const done = await state(); expect(done.invoices).toHaveLength(2);
    expect(done.invoices.find(row => row.id === 10)).toEqual(before.invoices[0]);
    expect(done.invoices.find(row => row.orderId === 20)).toMatchObject({ invoiceAmount: '6.00', isInvoice: 0 });
  }
});
