import { afterEach, beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { financePostgres } from './helpers/financePostgres';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';
import { createContainerFromDb, withTx, type DbClient } from '../src/lib/di';
import { INVOICE_EVIDENCE_SQL } from '../src/migrations/invoiceEvidence';
import { storeOrder, storeOrderCartInfo, storeOrderRefund, storeOrderInvoice, storeOrderStatus, user } from '../src/models/schema';
import { storeOrderInvoiceEvidence } from '../src/models/schema/invoice_evidence';
import { AdminInvoiceService } from '../src/services/admin/AdminInvoiceService';
import { assertUnissuedInvoiceHistory } from '../src/services/order/InvoiceIssuanceEvidence';
import { lockOrderSettlement } from '../src/services/order/OrderBrokerageService';
import { requiredAdminPermission } from '../src/services/admin/AdminPermissionService';

let f: Awaited<ReturnType<typeof financePostgres>>;
const service = (db: DbClient = f.db) => new AdminInvoiceService(createContainerFromDb(db));
const rows = async () => ({ invoice: await f.db.select().from(storeOrderInvoice).orderBy(storeOrderInvoice.id),
  status: await f.db.select().from(storeOrderStatus).orderBy(storeOrderStatus.id),
  evidence: await f.db.select().from(storeOrderInvoiceEvidence).orderBy(storeOrderInvoiceEvidence.invoiceId,
    storeOrderInvoiceEvidence.kind) });
const input = (revision: string, is_invoice: -1 | 0 | 1 = 1, request_id = crypto.randomUUID()) => ({
  revision, is_invoice, invoice_number: is_invoice === 1 ? '12345678' : '', remark: '', request_id });
beforeEach(async () => {
  f = await financePostgres([storeOrder, storeOrderCartInfo, storeOrderRefund, storeOrderInvoice, storeOrderStatus, user]);
  await f.db.insert(storeOrder).values({ id: 10, orderId: 'admin-invoice-order', uid: 11, paid: 1,
    payType: 'yue', totalNum: 1, payPrice: '10.00', totalPrice: '10.00', addTime: 1_700_000_000,
    realName: 'Local buyer', userPhone: '13800000000' });
  await f.db.insert(user).values({ uid: 11, nickname: 'Buyer', spreadUid: 12 });
  await f.db.insert(user).values({ uid: 12, nickname: 'Promoter' });
}, 30_000);
afterEach(async () => { await f?.close(); });

it('maps both route surfaces to invoice permissions before broad order permissions', () => {
  for (const base of ['/adminapi', '/api/admin']) {
    expect(requiredAdminPermission('GET', `${base}/order/invoices`)).toBe('invoice.view');
    expect(requiredAdminPermission('GET', `${base}/order/invoices/7`)).toBe('invoice.view');
    expect(requiredAdminPermission('GET', `${base}/order/invoices/7/order-info`)).toBe('invoice.view');
    expect(requiredAdminPermission('POST', `${base}/order/invoices/7/process`)).toBe('invoice.manage');
    expect(requiredAdminPermission('GET', `${base}/order/list`)).toBe('order.view');
  }
});

it('reads the old order dialog through its invoice ID with bounded, explicit fields', async () => {
  await f.db.update(storeOrder).set({ totalNum: 3, payPostage: '1.00', couponPrice: '2.00',
    deductionPrice: '3.00', userAddress: 'Local delivery address', mark: 'Staff note' })
    .where(eq(storeOrder.id, 10));
  await f.db.insert(storeOrderInvoice).values({ id: 41, uid: 11, orderId: 10, invoiceId: 77,
    isPay: 1, invoiceAmount: '10.00', bank: 'PRIVATE-BANK' });
  await f.db.insert(storeOrderCartInfo).values({ id: 51, oid: 10, uid: 11, cartId: '501',
    productId: 71, cartNum: 3, cartInfo: JSON.stringify({ vip_truePrice: '0.0099',
      productInfo: { id: 71, store_name: 'Legacy item', image: '/item.png',
        attrInfo: { suk: 'Red', price: '4.00' } } }) });
  const result = await service().orderInfo(41);
  expect(result).toMatchObject({ invoice_id: 41,
    order: { id: 10, order_number: 'admin-invoice-order', uid: 11,
      total_num: 3, coupon_price: '2.00', vip_true_price: '0.02',
      user_address: 'Local delivery address', mark: 'Staff note' },
    user: { nickname: 'Buyer', spread_name: 'Promoter' },
    cart_items: [{ id: 51, product_id: 71, product_name: 'Legacy item',
      sku: 'Red', unit_price: '4.00', quantity: 3, image: '/item.png' }] });
  expect(JSON.stringify(result)).not.toContain('PRIVATE-BANK');
  expect(JSON.stringify(result)).not.toContain('invoice_amount');
  await f.db.update(user).set({ spreadUid: 0 }).where(eq(user.uid, 11));
  expect((await service().orderInfo(41)).user.spread_name).toBe('');
});

it('denies order context when the paid invoice is misbound, duplicated or points to an invalid split root', async () => {
  await f.db.insert(storeOrderInvoice).values({ id: 41, uid: 22, orderId: 10, isPay: 1 });
  await expect(service().orderInfo(41)).rejects.toThrow('归属');
  await f.db.update(storeOrderInvoice).set({ uid: 11, isPay: 0 }).where(eq(storeOrderInvoice.id, 41));
  await expect(service().orderInfo(41)).rejects.toThrow('未付款');
  await f.db.update(storeOrderInvoice).set({ isPay: 1 }).where(eq(storeOrderInvoice.id, 41));
  await f.db.insert(storeOrderInvoice).values({ id: 42, uid: 11, orderId: 10, isPay: 1 });
  await expect(service().orderInfo(41)).rejects.toThrow('重复');
  await f.db.update(storeOrderInvoice).set({ isDel: 1 }).where(eq(storeOrderInvoice.id, 42));
  await f.db.update(storeOrder).set({ pid: -1 }).where(eq(storeOrder.id, 10));
  await expect(service().orderInfo(41)).rejects.toThrow('归属');
});

it('binds an allocated split invoice to its child order and rejects a competing root application', async () => {
  await f.db.update(storeOrder).set({ pid: -1, supplierAllocationStatus: 2 })
    .where(eq(storeOrder.id, 10));
  await f.db.insert(storeOrder).values({ id: 20, orderId: 'allocated-invoice-child', pid: 10,
    uid: 11, paid: 1, payType: 'yue', supplierId: 7, storeId: 9,
    payPrice: '5.00', totalPrice: '5.00', totalNum: 1 });
  await f.db.insert(storeOrderInvoice).values({ id: 41, uid: 11, orderId: 20,
    isPay: 1, invoiceAmount: '5.00' });
  await f.db.insert(storeOrderCartInfo).values({ id: 51, oid: 20, uid: 11,
    cartId: '501', productId: 71, cartNum: 1,
    cartInfo: JSON.stringify({ productInfo: { id: 71, store_name: 'Child product' } }) });
  expect(await service().orderInfo(41)).toMatchObject({ invoice_id: 41,
    order: { id: 20, order_number: 'allocated-invoice-child', pid: 10 },
    cart_items: [{ product_name: 'Child product' }] });
  await f.db.insert(storeOrderInvoice).values({ id: 42, uid: 11, orderId: 10, isPay: 1 });
  await expect(service().orderInfo(41)).rejects.toThrow('重复');
});

it('denies corrupt, oversized and wrong-user order cart snapshots without returning partial private data', async () => {
  await f.db.insert(storeOrderInvoice).values({ id: 41, uid: 11, orderId: 10, isPay: 1 });
  await f.db.insert(storeOrderCartInfo).values({ id: 51, oid: 10, uid: 11, cartId: '501',
    productId: 71, cartNum: 1, cartInfo: '{' });
  await expect(service().orderInfo(41)).rejects.toThrow('快照');
  await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify({ productInfo: { store_name: 'x'.repeat(65_537) } }) })
    .where(eq(storeOrderCartInfo.id, 51));
  await expect(service().orderInfo(41)).rejects.toThrow('过大');
  await f.db.update(storeOrderCartInfo).set({ uid: 22, cartInfo: JSON.stringify({ productInfo: { store_name: 'Item' } }) })
    .where(eq(storeOrderCartInfo.id, 51));
  await expect(service().orderInfo(41)).rejects.toThrow('不一致');
});

it('reads paid invoice rows in a genuine READ ONLY transaction with exact identities and bounded filters', async () => {
  await f.exec(INVOICE_EVIDENCE_SQL);
  await f.db.insert(storeOrderInvoice).values({ id: 41, uid: 11, orderId: 10, invoiceId: 77,
    isPay: 1, invoiceAmount: '10.00', name: 'Local title', addTime: 1_700_000_010 });
  const data = await service().list(new URLSearchParams({ page: '1', limit: '10', status: 'pending' }));
  expect(data).toMatchObject({ count: 1, page: 1, limit: 10, list: [{ id: 41, order_db_id: 10,
    order_number: 'admin-invoice-order', template_id: 77, expected_amount: '10.00', can_process: true }] });
  const detail = await service().detail(41);
  expect(detail).toMatchObject({ id: 41, order: { id: 10, order_number: 'admin-invoice-order', add_time: 1_700_000_000 },
    revision: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect((await service().list(new URLSearchParams({ field: 'real_name', keyword: 'Local buyer' }))).count).toBe(1);
  expect((await service().list(new URLSearchParams({ field: 'user_phone', keyword: '13800000000' }))).count).toBe(1);
  expect((await service().list(new URLSearchParams({ start_time: '2023-11-15 06:13', end_time: '2023-11-15 06:13' }))).count).toBe(1);
  expect((await service().list(new URLSearchParams({ start_time: '2023-11-15 06:14', end_time: '2023-11-15 06:14' }))).count).toBe(0);
  await f.db.insert(storeOrderInvoice).values({ id: 42, uid: 11, orderId: 10, isPay: 1,
    isInvoice: 1, isRefund: 1, invoiceNumber: '87654321', invoiceAmount: '10.00' });
  expect((await service().list(new URLSearchParams({ status: '1' }))).count).toBe(0);
  expect((await service().list(new URLSearchParams({ status: 'refunded' }))).count).toBe(1);
});

it('derives a legacy 0.00 pending amount only from a captured created-unissued baseline, then preserves reported issuance', async () => {
  await f.exec(INVOICE_EVIDENCE_SQL);
  await f.db.insert(storeOrderInvoice).values({ id: 41, uid: 11, orderId: 10, invoiceId: 77,
    isPay: 1, invoiceAmount: '0.00', addTime: 1_700_000_010 });
  const detail = await service().detail(41);
  expect(detail).toMatchObject({ invoice_amount: '0.00', expected_amount: '10.00', can_process: true });
  const body = input(detail.revision);
  const result = await service().process(41, body, 9);
  expect(result).toMatchObject({ committed: true, request_id: body.request_id, idempotent: false,
    invoice_amount: '10.00', is_invoice: 1, invoice_number: '12345678' });
  expect((await rows()).evidence.map(row => row.kind)).toEqual(['created', 'issued']);
  expect((await rows()).status).toHaveLength(1);
  expect(await service().process(41, body, 9)).toMatchObject({ committed: true, idempotent: true, request_id: body.request_id });
  expect((await rows()).status).toHaveLength(1);
  const latest = await service().detail(41);
  const clear = input(latest.revision, -1);
  await service().process(41, clear, 9);
  expect((await rows()).evidence.map(row => row.kind)).toEqual(['created', 'issued']);
  expect((await rows()).invoice[0]).toMatchObject({ isInvoice: -1, invoiceNumber: '', invoiceAmount: '10.00' });
  expect(await service().process(41, body, 9)).toMatchObject({ committed: true, idempotent: true,
    is_invoice: -1, receipt_is_invoice: 1, superseded: true });
  await expect(withTx(createContainerFromDb(f.db), async tx => {
    await lockOrderSettlement(tx, 10);
    const [order] = await tx.select().from(storeOrder).where(eq(storeOrder.id, 10)).for('update');
    const [invoice] = await tx.select().from(storeOrderInvoice).where(eq(storeOrderInvoice.id, 41)).for('update');
    await assertUnissuedInvoiceHistory(tx, order, invoice);
  })).rejects.toThrow('开票历史');
});

it('keeps pre-install 0.00 rows read-only without fabricating creation evidence or audit', async () => {
  await f.db.insert(storeOrderInvoice).values({ id: 41, uid: 11, orderId: 10, invoiceId: 77,
    isPay: 1, invoiceAmount: '0.00' });
  await f.exec(INVOICE_EVIDENCE_SQL);
  const detail = await service().detail(41), before = await rows();
  expect(detail).toMatchObject({ expected_amount: '10.00', can_process: false });
  expect(detail.issues.join(' ')).toMatch(/历史|创建/);
  await expect(service().process(41, input(detail.revision), 9)).rejects.toThrow();
  expect(await rows()).toEqual(before);
});

it('preserves immutable audit across archive and physical delete before a request replay', async () => {
  await f.exec(INVOICE_EVIDENCE_SQL);
  await f.db.insert(storeOrderInvoice).values({ id: 41, uid: 11, orderId: 10, invoiceId: 77,
    isPay: 1, invoiceAmount: '10.00' });
  const body = input((await service().detail(41)).revision);
  const first = await service().process(41, body, 9);
  await f.db.update(storeOrderInvoice).set({ isDel: 1 }).where(eq(storeOrderInvoice.id, 41));
  expect(await service().process(41, body, 9)).toMatchObject({ id: 41, committed: true,
    request_id: body.request_id, idempotent: true, archived: true, revision: first.revision });
  await f.db.delete(storeOrderInvoice).where(eq(storeOrderInvoice.id, 41));
  expect(await service().process(41, body, 9)).toMatchObject({ id: 41, committed: true,
    request_id: body.request_id, idempotent: true, archived: true, revision: first.revision });
  expect((await rows()).status).toHaveLength(1);
});

it('rejects an active refund even when its summary flag is zero, without updating invoice or audit', async () => {
  await f.exec(INVOICE_EVIDENCE_SQL);
  await f.db.insert(storeOrderInvoice).values({ id: 41, uid: 11, orderId: 10, invoiceId: 77,
    isPay: 1, invoiceAmount: '10.00' });
  const detail = await service().detail(41);
  await f.db.insert(storeOrderRefund).values({ id: 7, storeOrderId: 10, uid: 11, refundType: 0,
    refundPrice: '10.00' });
  const before = await rows();
  await expect(service().process(41, input(detail.revision), 9)).rejects.toThrow('退款');
  expect(await rows()).toEqual(before);
});

it('processes a verified allocated child across supplier/store identities but refuses an unallocated root invoice', async () => {
  await f.exec(INVOICE_EVIDENCE_SQL);
  await f.db.update(storeOrder).set({ pid: -1, supplierAllocationStatus: 2 }).where(eq(storeOrder.id, 10));
  await f.db.insert(storeOrder).values({ id: 20, orderId: 'supplier-child-invoice', pid: 10, uid: 11,
    paid: 1, payType: 'yue', supplierId: 7, storeId: 9, payPrice: '5.00', totalPrice: '5.00' });
  await f.db.insert(storeOrderInvoice).values({ id: 41, uid: 11, orderId: 20, isPay: 1, invoiceAmount: '5.00' });
  const detail = await service().detail(41);
  expect(detail).toMatchObject({ order_db_id: 20, order_number: 'supplier-child-invoice',
    expected_amount: '5.00', can_process: true });
  await service().process(41, input(detail.revision), 9);
  expect((await rows()).invoice[0]).toMatchObject({ orderId: 20, invoiceAmount: '5.00', isInvoice: 1 });
  await f.db.insert(storeOrderInvoice).values({ id: 42, uid: 11, orderId: 10, isPay: 1, invoiceAmount: '10.00' });
  expect((await service().detail(42)).can_process).toBe(false);
  await expect(service().process(42, input((await service().detail(42)).revision), 9)).rejects.toThrow();
  expect((await rows()).status).toHaveLength(1);
});

it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('waits on the real root order before accepting a stale paid/refund snapshot', async () => {
  await f.exec(INVOICE_EVIDENCE_SQL);
  await f.db.insert(storeOrderInvoice).values({ id: 41, uid: 11, orderId: 10, invoiceId: 77,
    isPay: 1, invoiceAmount: '10.00' });
  const detail = await service().detail(41);
  await withFinancePeers(f.db, async ([blocker, worker]) => {
    await blocker.exec('BEGIN; SELECT id FROM store_order WHERE id=10 FOR UPDATE');
    const pending = outcome(service(worker.db).process(41, input(detail.revision), 9));
    await waitForFinanceBlock(f.db, worker.pid, blocker.pid);
    await blocker.exec('UPDATE store_order SET refund_status=1 WHERE id=10; COMMIT');
    expect((await pending).ok).toBe(false);
  });
  expect((await rows()).status).toHaveLength(0);
});

it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('serializes a reused UUID across two invoice rows and refuses the second payload', async () => {
  await f.exec(INVOICE_EVIDENCE_SQL);
  await f.db.insert(storeOrder).values({ id: 20, orderId: 'second-admin-invoice', uid: 22, paid: 1,
    payType: 'yue', payPrice: '20.00' });
  await f.db.insert(storeOrderInvoice).values([
    { id: 41, uid: 11, orderId: 10, isPay: 1, invoiceAmount: '10.00' },
    { id: 42, uid: 22, orderId: 20, isPay: 1, invoiceAmount: '20.00' },
  ]);
  const sharedId = crypto.randomUUID();
  const a = input((await service().detail(41)).revision, 1, sharedId);
  const b = input((await service().detail(42)).revision, 1, sharedId);
  await withFinancePeers(f.db, async ([blocker, first, second]) => {
    await blocker.exec('BEGIN; SELECT id FROM store_order WHERE id=10 FOR UPDATE');
    const earlier = outcome(service(first.db).process(41, a, 9));
    await waitForFinanceBlock(f.db, first.pid, blocker.pid);
    const later = outcome(service(second.db).process(42, b, 9));
    await waitForFinanceBlock(f.db, second.pid, first.pid);
    await blocker.exec('COMMIT');
    expect((await earlier).ok).toBe(true);
    const last = await later;
    expect(last.ok).toBe(false);
    if (!last.ok) expect(String(last.error)).toContain('请求标识');
  });
  expect((await rows()).status).toHaveLength(1);
  expect((await rows()).invoice.map(row => row.isInvoice)).toEqual([1, 0]);
});
