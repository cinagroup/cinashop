import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import { createContainerFromDb, withTx, type DbClient } from '../src/lib/di';
import { storeOrder, storeOrderCartInfo, storeOrderInvoice, storeOrderOutbox, storeOrderRefund,
  storeOrderRefundPayment, storeOrderStatus, storeProductAttrValue, user, userBill, userInvoice } from '../src/models/schema';
import { storeOrderInvoiceEvidence } from '../src/models/schema/invoice_evidence';
import { storeOrderInvoiceManualRedNote, storeOrderInvoiceManualRedReview } from '../src/models/schema/invoice_manual_red_note';
import { storeOrderRefundSplit } from '../src/models/schema/order_refund_split';
import { CustomerWorkFinancialService } from '../src/services/customer-work/CustomerWorkFinancialService';
import { authorizeCustomerWorkActor } from '../src/services/customer-work/CustomerWorkScope';
import { financialRevisions } from '../src/services/customer-work/CustomerWorkFinancialReadService';
import { outRequestHash } from '../src/services/out/OutIdempotency';
import { CUSTOMER_FINANCIAL_VERSION, CUSTOMER_FINANCIAL_QUOTE_VERSION, type FinancialContext, type FinancialInput } from '../src/services/customer-work/CustomerWorkFinancialProtocol';
import type { CustomerJson } from '../src/services/customer-work/CustomerWorkOperationRequest';
import { manualRedDigest, manualRedRecordIntentHash, manualRedReviewIntentHash, type ManualRedNoteList, type ManualRedOperationReceipt, type ManualRedRecordInput, type ManualRedReviewInput } from '../src/services/order/InvoiceManualRedNoteProtocol';
import { invoiceManualRedNoteReadiness } from '../src/migrations/invoiceManualRedNoteCatalog';
import { adminGuestInvoiceManualRedNoteFixture, MANUAL_RED_ADMINS, type ManualRedAdmin } from './helpers/adminGuestInvoiceManualRedNoteFixture';
import { waitForFinanceBlock } from './helpers/financePeers';

/** Actual registered PostgreSQL16, AdminJWT and separate ordinary/Admin LOGINs.
 * Positive paid roots and COMPLETED events come from real producers/consumers;
 * actual HTTP Admin operations capture issuance and append manual record/review
 * facts. No tax-provider HTTP, pseudo user0 or fabricated success evidence. */
describe.skipIf(!process.env.TEST_FINANCE_POSTGRES_URL)('accountless invoice whole-ticket manual red-note and cash refund PostgreSQL16', { timeout: 30000 }, () => {
  let f: Awaited<ReturnType<typeof adminGuestInvoiceManualRedNoteFixture>>;
  let external: ReturnType<typeof vi.spyOn>;
  let number = 60000000;
  beforeAll(async () => { f = await adminGuestInvoiceManualRedNoteFixture(); }, 180000);
  beforeEach(() => { external = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Manual red-note native acceptance must not contact tax or payment providers')); });
  afterEach(() => { try { expect(external).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); vi.useRealTimers(); } });
  afterAll(async () => { await f?.close(); }, 30000);
  const path = (id: number, base = '/api/admin') => `${base}/order/invoices/${id}`;
  const service = (db: DbClient = f.db) => new CustomerWorkFinancialService(createContainerFromDb(db), f.env);
  const ctx = (request_key = crypto.randomUUID()): FinancialContext => ({ actor: f.actor(), request_key });
  const carts = (id: number) => f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, id)).orderBy(asc(storeOrderCartInfo.id));
  const data = <T>(result: Awaited<ReturnType<typeof f.request>>): T => { expect(result.body.status, result.body.msg).toBe(200); return result.body.data as T; };
  async function facts() {
    return {
      orders: await f.db.select().from(storeOrder).orderBy(asc(storeOrder.id)), carts: await f.db.select().from(storeOrderCartInfo).orderBy(asc(storeOrderCartInfo.id)),
      invoices: await f.db.select().from(storeOrderInvoice).orderBy(asc(storeOrderInvoice.id)), evidence: await f.db.select().from(storeOrderInvoiceEvidence)
        .orderBy(asc(storeOrderInvoiceEvidence.invoiceId), asc(storeOrderInvoiceEvidence.kind), asc(storeOrderInvoiceEvidence.documentNumber)),
      records: await f.db.select().from(storeOrderInvoiceManualRedNote).orderBy(asc(storeOrderInvoiceManualRedNote.id)),
      reviews: await f.db.select().from(storeOrderInvoiceManualRedReview).orderBy(asc(storeOrderInvoiceManualRedReview.id)),
      refunds: await f.db.select().from(storeOrderRefund).orderBy(asc(storeOrderRefund.id)), splits: await f.db.select().from(storeOrderRefundSplit).orderBy(asc(storeOrderRefundSplit.refundId)),
      payments: await f.db.select().from(storeOrderRefundPayment).orderBy(asc(storeOrderRefundPayment.id)), outbox: await f.db.select().from(storeOrderOutbox).orderBy(asc(storeOrderOutbox.id)),
      audits: await f.db.select().from(storeOrderStatus).orderBy(asc(storeOrderStatus.id)), users: await f.db.select().from(user).orderBy(asc(user.uid)),
      bills: await f.db.select().from(userBill).orderBy(asc(userBill.id)), skus: await f.db.select().from(storeProductAttrValue).orderBy(asc(storeProductAttrValue.id)),
      manual: await f.db.execute(sql`SELECT * FROM public.customer_financial_manual_refund_v1 ORDER BY refund_id`),
    };
  }
  async function input(id: number, payload: CustomerJson): Promise<FinancialInput> {
    const current = await f.order(id), scope = await authorizeCustomerWorkActor(f.db, f.actor()), revisions = await financialRevisions(f.db, current);
    return { version: CUSTOMER_FINANCIAL_VERSION, scope_key: scope.scope_key, order_id: id,
      expected_order_revision: revisions.order_revision, expected_financial_revision: revisions.financial_revision, payload };
  }
  async function quote(id: number, items: Array<{ cart_row_id: number; cart_num: number }> = []) {
    const body = await input(id, {});
    return service().reader.quote(f.actor(), { version: CUSTOMER_FINANCIAL_QUOTE_VERSION, scope_key: body.scope_key, order_id: id,
      expected_order_revision: body.expected_order_revision, expected_financial_revision: body.expected_financial_revision,
      mode: items.length ? 'items' : 'remaining', items });
  }
  async function creationBody(id: number, items: Array<{ cart_row_id: number; cart_num: number }> = []) {
    const quoted = (await quote(id, items)).data;
    return input(id, { mode: items.length ? 'items' : 'remaining', items, quoted_price: quoted.quoted_price,
      refund_price: quoted.quoted_price, quote_fingerprint: quoted.quote_fingerprint, reason: '已逐票整票红冲并人工核对' });
  }
  async function createRefund(id: number, items: Array<{ cart_row_id: number; cart_num: number }> = []) {
    const body = await creationBody(id, items);
    const createContext = ctx(), created = await service().create(createContext, body);
    expect(created.receipt?.outcome).toBe('refund-created');
    return { refundId: Number(created.receipt!.evidence.refund_id), created, body, createContext };
  }
  async function refundDecision(refundId: number) {
    const row = (await f.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.id, refundId)))[0];
    const review = (await service().reader.review(f.actor(), refundId, { refund_no: row.orderId })).data;
    const executionBody = await input(review.order_id, { refund_id: refundId, refund_no: review.refund_no,
      expected_refund_revision: review.refund_revision, review_fingerprint: review.review_fingerprint, refund_price: review.refund_price,
      decision: { apply_type: review.apply_type, refund_type: review.refund_type, received: false,
        ...(review.refund_settlement === 'cash' ? { cash_returned: true } : {}) } });
    return executionBody;
  }
  async function refund(id: number, items: Array<{ cart_row_id: number; cart_num: number }> = []) {
    const created = await createRefund(id, items), executionBody = await refundDecision(created.refundId);
    const executionContext = ctx(), executed = await service().execute('refund_execute', executionContext, executionBody);
    expect(executed.execution).toMatchObject({ completed: true, verified: true,
      status: (executionBody.payload as Record<string, CustomerJson>).refund_price === '0.00' ? 'ZERO_SUCCESS' : 'CASH_SUCCESS' });
    return { ...created, executed, executionBody, executionContext };
  }
  async function issued(buyer = 0, price = '7.00', quantity = 3, producer: 'cashier' | 'manager' | 'admin' = 'cashier') {
    if (producer !== 'cashier') await f.exec('UPDATE public.store_product SET product_type=0 WHERE id=70');
    const source = producer === 'cashier' ? await f.cashier(buyer, price, quantity) : await f.paid(producer, buyer, price, quantity);
    const invoice = await f.application(source.order.id);
    const detail = data<{ revision: string }>(await f.request(path(invoice.id)));
    const body = { is_invoice: 1, invoice_number: String(++number), remark: '税务平台原票已开具', revision: detail.revision, request_id: crypto.randomUUID() };
    const result = data<Record<string, unknown>>(await f.request(path(invoice.id) + '/process', body));
    expect(result).toMatchObject({ uid: buyer, committed: true, request_id: body.request_id, is_invoice: 1, invoice_number: body.invoice_number });
    const event = (await f.db.select().from(storeOrderOutbox).where(sql`${storeOrderOutbox.aggregateId}=${source.order.id} AND ${storeOrderOutbox.eventType}='order.paid'`))[0];
    expect(event).toMatchObject({ status: 'COMPLETED' });
    const original = (await f.db.select().from(storeOrderInvoiceEvidence).where(sql`${storeOrderInvoiceEvidence.invoiceId}=${invoice.id} AND ${storeOrderInvoiceEvidence.kind}='issued'`))[0];
    expect(original).toMatchObject({ uid: buyer, orderId: source.order.id, documentNumber: body.invoice_number });
    return { source, invoice, body, original, event };
  }
  const notes = async (id: number): Promise<ManualRedNoteList> => data(await f.request(path(id) + '/red-notes'));
  async function recordInput(id: number, document?: string): Promise<ManualRedRecordInput> {
    const list = await notes(id), original = list.issued.find(row => !document || row.document_number === document);
    expect(original).toBeDefined();
    return { request_id: crypto.randomUUID(), original_document_number: original!.document_number,
      original_snapshot_hash: original!.snapshot_hash, original_amount: original!.original_amount, currency: 'CNY',
      red_document_number: String(++number), red_amount: original!.original_amount,
      platform_evidence: '人工在税务平台办理：原票 ' + original!.document_number + ' 已整票红冲；本地仅登记并人工核对。' };
  }
  async function record(id: number, body?: ManualRedRecordInput, actor: ManualRedAdmin = 'manager') {
    const input = body ?? await recordInput(id), result = data<ManualRedOperationReceipt>(await f.request(path(id) + '/red-notes', input, actor));
    expect(result).toMatchObject({ version: 'invoice-manual-red-operation-v1', request_id: input.request_id,
      invoice_id: id, actor_id: MANUAL_RED_ADMINS[actor], kind: 'record', committed: true,
      record: { id: input.request_id, state: 'RECORDED', review: null } });
    return { input, result };
  }
  async function review(id: number, receipt: ManualRedOperationReceipt, decision: 'confirm' | 'reject' = 'confirm') {
    const body: ManualRedReviewInput = { request_id: crypto.randomUUID(), record_hash: receipt.record.record_hash,
      decision, manual_checked: true, review_note: '逐项核对原票、红票、金额、订单归属与平台人工办理记录' };
    const result = data<ManualRedOperationReceipt>(await f.request(path(id) + '/red-notes/' + receipt.record.id + '/review', body));
    expect(result).toMatchObject({ request_id: body.request_id, kind: 'review', committed: true,
      record: { state: decision === 'confirm' ? 'MANUAL_REVIEWED' : 'REJECTED', review: { id: body.request_id, decision, manual_checked: true } } });
    return { body, result };
  }
  async function withHeldRoot(id: number, callback: (holder: number, release: () => void, track: <T>(work: Promise<T>) => Promise<T>) => Promise<void>) {
    await f.admin.withPeer(async (db, holder) => {
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; }), arrived = new Promise<void>(resolve => { entered = resolve; });
      const held = withTx(createContainerFromDb(db), async tx => {
        await tx.execute(sql`SELECT id FROM public.store_order WHERE id=${id} FOR UPDATE`); entered(); await gate;
      }).then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
      const pending: Promise<void>[] = [];
      const track = <T>(work: Promise<T>): Promise<T> => { pending.push(work.then(() => undefined, () => undefined)); return work; };
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([arrived, held.then(result => { if (!result.ok) throw result.error; throw Error('Root holder ended before the barrier'); }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Actual independent Admin root lock was not acquired')), 4000); })]);
        if (timer) clearTimeout(timer); await callback(holder, release, track);
      } finally { if (timer) clearTimeout(timer); release(); const result = await held; await Promise.all(pending); if (!result.ok) throw result.error; }
    });
  }
  async function waitForAdminBlock(holder: number) {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const rows = await f.maintenanceDb.execute<{ pid: number; blockers: number[] }>(sql`
        SELECT a.pid,pg_blocking_pids(a.pid) AS blockers FROM pg_stat_activity a JOIN pg_roles r ON r.oid=a.usesysid
        WHERE a.datname=current_database() AND r.rolname=${f.admin.role} AND a.application_name='cinashop_admin' AND a.wait_event_type='Lock'`);
      const blocked = rows.find(row => row.blockers.includes(holder)); if (blocked) return blocked.pid;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw Error('Actual Admin HTTP backend did not wait on the exact owned holder PID');
  }

  it('uses independent ordinary, manager and Admin SQL identities without a guest user or invoice template', async () => {
    expect(new Set(f.independentIdentities.map(row => row.role)).size).toBe(3);
    expect(new Set(f.independentIdentities.map(row => row.pid)).size).toBe(3);
    expect(await f.db.select().from(user).where(eq(user.uid, 0))).toEqual([]);
    expect(await f.maintenanceDb.select().from(userInvoice).where(eq(userInvoice.uid, 0))).toEqual([]);
    expect((await invoiceManualRedNoteReadiness(f.db)).ready).toBe(true);
    expect((await invoiceManualRedNoteReadiness(f.admin.db, 'admin-write')).ready).toBe(true);
  });
  it.each(['/api/admin', '/adminapi'])('searches and reads an actual guest invoice using %s with private no-store responses', async base => {
    const fixture = await issued(), result = await f.request(`${base}/order/invoices?field=uid&keyword=0`);
    const list = data<{ list: Array<{ uid: number; id: number }> }>(result);
    expect(list.list.every(row => row.uid === 0)).toBe(true);
    // The default page is bounded; read this exact application separately.
    const info = await f.request(path(fixture.invoice.id, base) + '/order-info');
    expect(data(info)).toMatchObject({ invoice_id: fixture.invoice.id, order: { uid: 0, id: fixture.source.order.id },
      user: { nickname: '', spread_name: '', is_guest: true } });
    expect(result.response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(info.response.headers.get('Cache-Control')).toBe('private, no-store');
    expect((await f.request(`${base}/order/invoices?field=uid&keyword=00`)).body.status).not.toBe(200);
  });
  it.each([0, 11])('keeps original issued UUID recovery for buyer %i after clearing, replacing and archiving the mutable row', async buyer => {
    const fixture = await issued(buyer);
    expect(data(await f.request(path(fixture.invoice.id) + '/process', fixture.body))).toMatchObject({ idempotent: true, receipt_is_invoice: 1 });
    const current = data<{ revision: string }>(await f.request(path(fixture.invoice.id)));
    const clear = { is_invoice: -1, invoice_number: '', remark: '不等于红字办理', revision: current.revision, request_id: crypto.randomUUID() };
    data(await f.request(path(fixture.invoice.id) + '/process', clear));
    expect(data(await f.request(path(fixture.invoice.id) + '/process', fixture.body))).toMatchObject({ idempotent: true, superseded: true, receipt_is_invoice: 1, is_invoice: -1 });
    await f.maintenanceDb.update(storeOrderInvoice).set({ isDel: 1 }).where(eq(storeOrderInvoice.id, fixture.invoice.id));
    expect(data(await f.request(path(fixture.invoice.id) + '/process', fixture.body))).toMatchObject({ archived: true, receipt_is_invoice: 1, request_id: fixture.body.request_id });
    const before = await facts();
    await expect(quote(fixture.source.order.id)).rejects.toThrow();
    expect(await facts()).toEqual(before);
  });
  it.each(['cashier', 'manager', 'admin'] as const)('reviews every original ticket then refunds all three remaining generations from actual %s guest payment', async producer => {
    const fixture = await issued(0, '7.00', 3, producer), baseline = await facts();
    await expect(quote(fixture.source.order.id)).rejects.toThrow();
    const recorded = await record(fixture.invoice.id);
    await expect(quote(fixture.source.order.id)).rejects.toThrow();
    await review(fixture.invoice.id, recorded.result);
    expect((await notes(fixture.invoice.id)).issued).toMatchObject([{ manual_state: 'MANUAL_REVIEWED' }]);
    let sourceId = fixture.source.order.id;
    const saved: Awaited<ReturnType<typeof refund>>[] = [];
    for (let generation = 0; generation < 3; generation++) {
      const cart = (await carts(sourceId))[0];
      const done = await refund(sourceId, generation === 2 ? [] : [{ cart_row_id: cart.id, cart_num: 1 }]); saved.push(done);
      const split = (await f.db.select().from(storeOrderRefundSplit).where(eq(storeOrderRefundSplit.refundId, done.refundId)))[0];
      expect(split).toMatchObject({ uid: 0, paymentOrderId: fixture.source.order.id });
      if (generation === 0) expect(JSON.parse(split.invoiceAllocation)).toMatchObject({ version: 'refund-invoice-allocation-manual-red-v2',
        manual_disposition: { version: 'invoice-manual-disposition-v1', coverage_count: 1, coverage_hash: expect.stringMatching(/^[a-f0-9]{64}$/) } });
      if (generation < 2) {
        expect(split.remainingOrderId).toBeGreaterThan(0); sourceId = split.remainingOrderId!;
        const remaining = (await f.db.select().from(storeOrderInvoice).where(sql`${storeOrderInvoice.orderId}=${sourceId} AND ${storeOrderInvoice.isDel}=0`))[0];
        expect(remaining).toMatchObject({ uid: 0, isInvoice: 0, invoiceNumber: '', isRefund: 0, invoiceAmount: generation === 0 ? '14.00' : '7.00' });
      }
    }
    const after = await facts(), ownedRefunds = after.refunds.filter(row => saved.some(done => done.refundId === row.id));
    expect(ownedRefunds.reduce((sum, row) => sum + BigInt(row.refundPrice.replace('.', '')), 0n)).toBe(2100n);
    expect(after.users).toEqual(baseline.users); expect(after.bills).toEqual(baseline.bills);
    expect(after.skus[0].stock).toBe(baseline.skus[0].stock + 3);
    expect(after.evidence.find(row => row.invoiceId === fixture.invoice.id && row.kind === 'issued')).toEqual(fixture.original);
    for (const done of saved) {
      expect((await service().status(f.actor(), done.executionContext.request_key)).execution).toMatchObject({ completed: true, verified: true, status: 'CASH_SUCCESS' });
      const before = await facts();
      expect((await service().execute('refund_execute', done.executionContext, done.executionBody)).execution).toMatchObject({ completed: true, verified: true });
      expect(await facts()).toEqual(before);
    }
    expect(data(await f.request(path(fixture.invoice.id) + '/red-notes/operations/' + recorded.input.request_id))).toMatchObject({ request_id: recorded.input.request_id, committed: true });
  });
  it('invalidates the financial input only after a genuine manual confirmation and refunds using fresh evidence', async () => {
    const fixture = await issued(), order = await f.order(fixture.source.order.id), scope = await authorizeCustomerWorkActor(f.db, f.actor());
    const before = await financialRevisions(f.db, order);
    expect(Object.hasOwn(before.facts, 'manual_disposition')).toBe(false);
    expect(before.financial_revision).toBe(await outRequestHash({ version: 'customer-financial-source-v1', order, ...before.facts }));
    const recorded = await record(fixture.invoice.id), afterRecord = await financialRevisions(f.db, await f.order(order.id));
    expect(afterRecord.order_revision).toBe(before.order_revision);
    expect(afterRecord.financial_revision).toBe(before.financial_revision);
    expect(afterRecord.facts).toEqual(before.facts);
    await review(fixture.invoice.id, recorded.result);
    const current = await f.order(order.id), afterReview = await financialRevisions(f.db, current);
    expect(afterReview.order_revision).toBe(before.order_revision);
    expect(afterReview.financial_revision).not.toBe(before.financial_revision);
    expect(afterReview.facts.manual_disposition).toMatchObject({ version: 'invoice-manual-disposition-v1', coverage_count: 1,
      invoice_ids: [fixture.invoice.id], coverage_hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(afterReview.financial_revision).toBe(await outRequestHash({ version: 'customer-financial-source-manual-red-v2', order: current, ...afterReview.facts }));
    const factsBeforeStale = await facts();
    await expect(service().reader.quote(f.actor(), { version: CUSTOMER_FINANCIAL_QUOTE_VERSION, scope_key: scope.scope_key, order_id: order.id,
      expected_order_revision: before.order_revision, expected_financial_revision: before.financial_revision, mode: 'remaining', items: [] }))
      .rejects.toThrow('订单财务依据已变化');
    expect(await facts()).toEqual(factsBeforeStale);
    const done = await refund(order.id);
    expect(done.executed.execution).toMatchObject({ status: 'CASH_SUCCESS', completed: true, verified: true });
  });
  it('binds a genuine legacy imported nonnumeric original identifier without trimming its immutable snapshot', async () => {
    const source = await f.cashier(0, '7.00', 3), invoice = await f.application(source.order.id);
    const document = '  LEGACY-2020/原票-A  ';
    // Explicit historical import through the owned maintenance connection:
    // the published capture trigger records the actual legacy row. Paid and
    // COMPLETED facts remain produced by the real cashier and paid consumer.
    await f.maintenanceDb.update(storeOrderInvoice).set({ isInvoice: 1, invoiceNumber: document,
      invoiceTime: source.order.payTime, remark: '明确的旧票历史导入' }).where(eq(storeOrderInvoice.id, invoice.id));
    const original = (await f.db.select().from(storeOrderInvoiceEvidence).where(sql`${storeOrderInvoiceEvidence.invoiceId}=${invoice.id}
      AND ${storeOrderInvoiceEvidence.kind}='issued' AND ${storeOrderInvoiceEvidence.documentNumber}=${document}`))[0];
    expect(original).toMatchObject({ invoiceId: invoice.id, uid: 0, orderId: source.order.id, documentNumber: document });
    expect(JSON.parse(original.snapshot).invoice.invoice_number).toBe(document);
    expect((await f.db.select().from(storeOrderOutbox).where(sql`${storeOrderOutbox.aggregateId}=${source.order.id}
      AND ${storeOrderOutbox.eventType}='order.paid'`))[0]).toMatchObject({ status: 'COMPLETED' });
    const body = await recordInput(invoice.id, document);
    expect(body).toMatchObject({ original_document_number: document, original_snapshot_hash: await manualRedDigest(original.snapshot),
      original_amount: '21.00', red_amount: '21.00' });
    const recorded = await record(invoice.id, body), stored = (await f.db.select().from(storeOrderInvoiceManualRedNote)
      .where(eq(storeOrderInvoiceManualRedNote.id, body.request_id)))[0];
    const payload = JSON.parse(stored.recordJson), payment = await f.order(source.order.id);
    const identity = { id: payment.id, order_number: payment.orderId, uid: 0, pid: payment.pid, paid: 1, pay_type: payment.payType,
      pay_time: payment.payTime, store_id: payment.storeId, supplier_id: payment.supplierId };
    expect(payload.payment).toEqual(identity); expect(payload.source).toEqual(identity);
    expect(payload.original).toEqual({ document_number: document, snapshot_hash: body.original_snapshot_hash, amount: '21.00', snapshot: original.snapshot });
    const beforeMismatch = await facts();
    expect((await f.request(path(invoice.id) + '/red-notes', { ...body, request_id: crypto.randomUUID(), original_document_number: document.trim() })).body.status).not.toBe(200);
    expect(await facts()).toEqual(beforeMismatch);
    const verified = await review(invoice.id, recorded.result);
    expect(verified.result.record.original_document_number).toBe(document);
    expect(data<ManualRedOperationReceipt>(await f.request(path(invoice.id) + '/red-notes/operations/' + verified.body.request_id))
      .record.original_document_number).toBe(document);
    await refund(source.order.id);
    expect((await f.db.select().from(storeOrderInvoiceEvidence).where(sql`${storeOrderInvoiceEvidence.invoiceId}=${invoice.id}
      AND ${storeOrderInvoiceEvidence.kind}='issued' AND ${storeOrderInvoiceEvidence.documentNumber}=${document}`))[0]).toEqual(original);
  });
  it.each([{ buyer: 11, price: '7.00' }, { buyer: 0, price: '0.00' }, { buyer: 11, price: '0.00' }])(
    'settles buyer=$buyer unit=$price with whole-ticket review only for an actual issued invoice', async ({ buyer, price }) => {
      if (price === '0.00') {
        const source = await f.cashier(buyer, price, 1), invoice = await f.application(source.order.id);
        const detail = data<{ revision: string }>(await f.request(path(invoice.id))), beforeIssue = await facts();
        const rejected = await f.request(path(invoice.id) + '/process', { is_invoice: 1, invoice_number: String(++number),
          remark: '零付款不能开零额票', revision: detail.revision, request_id: crypto.randomUUID() });
        expect(rejected.body.status).not.toBe(200); expect(rejected.body.msg).toContain('订单剩余实际支付金额为0，不能开发票');
        expect(await facts()).toEqual(beforeIssue);
        expect(beforeIssue.evidence.filter(row => row.invoiceId === invoice.id && row.kind === 'issued')).toEqual([]);
        expect(beforeIssue.evidence.find(row => row.invoiceId === invoice.id && row.kind === 'created'))
          .toMatchObject({ uid: buyer, orderId: source.order.id, documentNumber: '' });
        expect(beforeIssue.outbox.find(row => row.aggregateId === source.order.id && row.eventType === 'order.paid'))
          .toMatchObject({ status: 'COMPLETED' });
        expect(await notes(invoice.id)).toMatchObject({ ready: true, can_record: false, issued: [] });
        const done = await refund(source.order.id), after = await facts();
        expect(done.executed.execution).toMatchObject({ completed: true, verified: true, status: 'ZERO_SUCCESS' });
        expect(after.users).toEqual(beforeIssue.users); expect(after.bills).toEqual(beforeIssue.bills);
        expect(after.records).toEqual(beforeIssue.records); expect(after.reviews).toEqual(beforeIssue.reviews);
        expect(after.evidence.filter(row => row.invoiceId === invoice.id && row.kind === 'issued')).toEqual([]);
        return;
      }
      const fixture = await issued(buyer, price, 1), baseline = await facts(), recorded = await record(fixture.invoice.id);
      await review(fixture.invoice.id, recorded.result);
      const done = await refund(fixture.source.order.id);
      expect(done.executed.execution).toMatchObject({ completed: true, verified: true, status: price === '0.00' ? 'ZERO_SUCCESS' : 'CASH_SUCCESS' });
      const after = await facts(); expect(after.users).toEqual(baseline.users); expect(after.bills).toEqual(baseline.bills);
      expect(after.evidence.find(row => row.invoiceId === fixture.invoice.id && row.kind === 'issued')).toEqual(fixture.original);
    },
  );
  it.each(['recorded', 'rejected', 'unknown-review'])('does not release an issued order while the manual disposition is %s', async state => {
    const fixture = await issued(), recorded = await record(fixture.invoice.id);
    if (state === 'rejected') await review(fixture.invoice.id, recorded.result, 'reject');
    if (state === 'unknown-review') {
      const absent = await f.request(path(fixture.invoice.id) + '/red-notes/operations/' + crypto.randomUUID());
      expect(absent.body.status).not.toBe(200);
    }
    const before = await facts(); await expect(quote(fixture.source.order.id)).rejects.toThrow();
    expect(await facts()).toEqual(before);
    expect((await notes(fixture.invoice.id)).issued[0].manual_state).toBe('UNCOVERED');
  });
  it.each([
    { original_document_number: '11111111' }, { original_snapshot_hash: 'f'.repeat(64) },
    { original_amount: '1.00', red_amount: '1.00' }, { red_amount: '1.00' }, { red_amount: '999.00' },
    { currency: 'USD' }, { red_document_number: 'bad' }, { platform_evidence: '' },
    { platform_evidence: '证'.repeat(1366) }, { platform_evidence: 'bad\u0000evidence' },
    { request_id: 'not-a-uuid' }, { actor_id: 0 }, { uid: 11 }, { payment_order_id: 999 },
  ])('rejects incomplete, partial, mismatched or client-forged red-note input %# without business effects', async patch => {
    const fixture = await issued(), body = { ...await recordInput(fixture.invoice.id), ...patch }, before = await facts();
    expect((await f.request(path(fixture.invoice.id) + '/red-notes', body)).body.status).not.toBe(200);
    expect(await facts()).toEqual(before); await expect(quote(fixture.source.order.id)).rejects.toThrow();
  });
  it.each([
    { manual_checked: false }, { decision: 'verified' }, { review_note: '' },
    { review_note: '核'.repeat(342) }, { record_hash: 'f'.repeat(64) }, { actor_id: 0 },
  ])('rejects incomplete or mismatched manual verification %# without confirming the original ticket', async patch => {
    const fixture = await issued(), recorded = await record(fixture.invoice.id), before = await facts();
    const body = { request_id: crypto.randomUUID(), record_hash: recorded.result.record.record_hash,
      decision: 'confirm', manual_checked: true, review_note: '已人工核对', ...patch };
    expect((await f.request(path(fixture.invoice.id) + '/red-notes/' + recorded.result.record.id + '/review', body)).body.status).not.toBe(200);
    expect(await facts()).toEqual(before); await expect(quote(fixture.source.order.id)).rejects.toThrow();
  });
  it('requires complete coverage of multiple original issued numbers and keeps every immutable snapshot', async () => {
    const fixture = await issued(), current = data<{ revision: string }>(await f.request(path(fixture.invoice.id)));
    const second = { ...fixture.body, request_id: crypto.randomUUID(), revision: current.revision, invoice_number: String(++number) };
    data(await f.request(path(fixture.invoice.id) + '/process', second));
    const originals = await f.db.select().from(storeOrderInvoiceEvidence).where(sql`${storeOrderInvoiceEvidence.invoiceId}=${fixture.invoice.id} AND ${storeOrderInvoiceEvidence.kind}='issued'`)
      .orderBy(asc(storeOrderInvoiceEvidence.documentNumber));
    expect(originals).toHaveLength(2);
    const first = await record(fixture.invoice.id, await recordInput(fixture.invoice.id, fixture.body.invoice_number)); await review(fixture.invoice.id, first.result);
    await expect(quote(fixture.source.order.id)).rejects.toThrow();
    const remaining = await record(fixture.invoice.id, await recordInput(fixture.invoice.id, second.invoice_number)); await review(fixture.invoice.id, remaining.result);
    await refund(fixture.source.order.id);
    expect(await f.db.select().from(storeOrderInvoiceEvidence).where(sql`${storeOrderInvoiceEvidence.invoiceId}=${fixture.invoice.id} AND ${storeOrderInvoiceEvidence.kind}='issued'`)
      .orderBy(asc(storeOrderInvoiceEvidence.documentNumber))).toEqual(originals);
  });
  it.each(['anonymous', 'user', 'supplier', 'kefu', 'viewer', 'orderManager'] as const)('refuses red-note writes from %s through actual JWT and route authorization', async actor => {
    const fixture = await issued(), body = await recordInput(fixture.invoice.id), before = await facts();
    expect((await f.request(path(fixture.invoice.id) + '/red-notes', body, actor)).body.status).not.toBe(200);
    expect(await facts()).toEqual(before);
    if (actor === 'viewer') expect(data(await f.request(path(fixture.invoice.id) + '/red-notes', undefined, actor))).toMatchObject({ invoice_id: fixture.invoice.id });
  });
  it('binds original UUID recovery to the exact invoice, actor, original intent and operation kind', async () => {
    const fixture = await issued(), recorded = await record(fixture.invoice.id), before = await facts();
    const originalPath = path(fixture.invoice.id) + '/red-notes';
    expect(data(await f.request(originalPath, recorded.input))).toMatchObject({ idempotent: true, request_id: recorded.input.request_id });
    expect((await f.request(originalPath, { ...recorded.input, platform_evidence: '不同人工凭据' })).body.status).not.toBe(200);
    expect((await f.request(originalPath, recorded.input, 'otherManager')).body.status).not.toBe(200);
    expect((await f.request(originalPath + '/operations/' + recorded.input.request_id, undefined, 'otherManager')).body.status).not.toBe(200);
    const other = await issued(), otherBefore = await facts();
    expect((await f.request(path(other.invoice.id) + '/red-notes', recorded.input)).body.status).not.toBe(200);
    expect(await facts()).toEqual(otherBefore);
    expect((await f.request(originalPath + '/' + recorded.result.record.id + '/review', {
      request_id: recorded.input.request_id, record_hash: recorded.result.record.record_hash,
      decision: 'confirm', manual_checked: true, review_note: '不能跨操作复用UUID',
    })).body.status).not.toBe(200);
    expect((await f.db.select().from(storeOrderInvoiceManualRedNote).where(eq(storeOrderInvoiceManualRedNote.id, recorded.input.request_id)))[0]).toEqual(before.records.find(row => row.id === recorded.input.request_id));
  });
  it('recovers a committed record and review by read-only original UUID after each actual HTTP response is lost', async () => {
    const fixture = await issued(), body = await recordInput(fixture.invoice.id), recordPath = path(fixture.invoice.id) + '/red-notes';
    f.loseResponseAfterCommit(recordPath, body.request_id);
    expect((await f.request(recordPath, body)).body.status).not.toBe(200);
    const beforeRecovery = await facts(), recovered = data<ManualRedOperationReceipt>(await f.request(recordPath + '/operations/' + body.request_id));
    expect(recovered).toMatchObject({ request_id: body.request_id, kind: 'record', committed: true, record: { state: 'RECORDED' } });
    expect(await facts()).toEqual(beforeRecovery); await expect(quote(fixture.source.order.id)).rejects.toThrow();
    const verification: ManualRedReviewInput = { request_id: crypto.randomUUID(), record_hash: recovered.record.record_hash,
      decision: 'confirm', manual_checked: true, review_note: '税务平台原票与整张红票已人工完整核对' };
    const reviewPath = recordPath + '/' + recovered.record.id + '/review'; f.loseResponseAfterCommit(reviewPath, verification.request_id);
    expect((await f.request(reviewPath, verification)).body.status).not.toBe(200);
    const confirmedFacts = await facts(), confirmed = data<ManualRedOperationReceipt>(await f.request(recordPath + '/operations/' + verification.request_id));
    expect(confirmed).toMatchObject({ request_id: verification.request_id, kind: 'review', committed: true,
      record: { state: 'MANUAL_REVIEWED', review: { id: verification.request_id } } });
    expect(await facts()).toEqual(confirmedFacts);
    await refund(fixture.source.order.id);
    const finalFacts = await facts();
    expect(data(await f.request(recordPath + '/operations/' + body.request_id))).toMatchObject({ request_id: body.request_id, kind: 'record', committed: true });
    expect(data(await f.request(recordPath + '/operations/' + verification.request_id))).toMatchObject({ request_id: verification.request_id, kind: 'review', committed: true });
    expect(await facts()).toEqual(finalFacts);
  });
  it('recovers a genuinely committed guest issuance after the HTTP response is lost without another issuance audit', async () => {
    const source = await f.cashier(0, '7.00', 1), invoice = await f.application(source.order.id);
    const detail = data<{ revision: string }>(await f.request(path(invoice.id)));
    const body = { is_invoice: 1, invoice_number: String(++number), remark: '原UUID保持', revision: detail.revision, request_id: crypto.randomUUID() };
    f.loseResponseAfterCommit(path(invoice.id) + '/process', body.request_id);
    expect((await f.request(path(invoice.id) + '/process', body)).body.status).not.toBe(200);
    const before = await facts();
    expect(data(await f.request(path(invoice.id) + '/process', body))).toMatchObject({ committed: true, idempotent: true, uid: 0, request_id: body.request_id });
    expect(await facts()).toEqual(before);
  });
  it('preserves reported issuance across physical deletion and still blocks refunds without reviewed red notes', async () => {
    const fixture = await issued();
    await f.maintenanceDb.delete(storeOrderInvoice).where(eq(storeOrderInvoice.id, fixture.invoice.id));
    const before = await facts();
    expect(data(await f.request(path(fixture.invoice.id) + '/process', fixture.body))).toMatchObject({ archived: true, request_id: fixture.body.request_id, receipt_is_invoice: 1 });
    await expect(quote(fixture.source.order.id)).rejects.toThrow(); expect(await facts()).toEqual(before);
    expect(before.evidence.find(row => row.invoiceId === fixture.invoice.id && row.kind === 'issued')).toEqual(fixture.original);
  });
  it('does not treat manual review as a repair for an unverified invoice history', async () => {
    const fixture = await issued(), recorded = await record(fixture.invoice.id);
    await review(fixture.invoice.id, recorded.result);
    // An explicit legacy-history counterexample, never a successful fact or
    // disabled capture trigger. Even previously reviewed tickets cannot erase it.
    await f.maintenanceDb.insert(storeOrderInvoiceEvidence).values({ invoiceId: fixture.invoice.id,
      orderId: fixture.source.order.id, uid: 0, kind: 'unverified', documentNumber: '', snapshot: fixture.original.snapshot });
    const before = await facts(); await expect(quote(fixture.source.order.id)).rejects.toThrow(); expect(await facts()).toEqual(before);
    expect((await f.request(path(fixture.invoice.id) + '/red-notes', await recordInput(fixture.invoice.id))).body.status).not.toBe(200);
  });
  it('prevents reuse of a confirmed red ticket on a different genuine issued order', async () => {
    const first = await issued(), recorded = await record(first.invoice.id); await review(first.invoice.id, recorded.result);
    const second = await issued(), body = { ...await recordInput(second.invoice.id), red_document_number: recorded.input.red_document_number };
    const attempted = await f.request(path(second.invoice.id) + '/red-notes', body);
    if (attempted.body.status === 200) {
      const receipt = attempted.body.data as ManualRedOperationReceipt;
      expect((await f.request(path(second.invoice.id) + '/red-notes/' + receipt.record.id + '/review', {
        request_id: crypto.randomUUID(), record_hash: receipt.record.record_hash, decision: 'confirm', manual_checked: true, review_note: '重复红票应拒绝',
      })).body.status).not.toBe(200);
    }
    const before = await facts(); await expect(quote(second.source.order.id)).rejects.toThrow(); expect(await facts()).toEqual(before);
    expect(before.reviews.filter(row => row.redDocumentNumber === recorded.input.red_document_number && row.decision === 'confirm')).toHaveLength(1);
  });
  it('lets a rejected submission be corrected with a new record while keeping its immutable rejection', async () => {
    const fixture = await issued(), wrong = await record(fixture.invoice.id); const rejected = await review(fixture.invoice.id, wrong.result, 'reject');
    const rejectedFact = (await f.db.select().from(storeOrderInvoiceManualRedReview).where(eq(storeOrderInvoiceManualRedReview.id, rejected.body.request_id)))[0];
    const corrected = await record(fixture.invoice.id); await review(fixture.invoice.id, corrected.result);
    await refund(fixture.source.order.id);
    expect((await f.db.select().from(storeOrderInvoiceManualRedReview).where(eq(storeOrderInvoiceManualRedReview.id, rejected.body.request_id)))[0]).toEqual(rejectedFact);
  });
  it('keeps original manual-operation recovery available after manage permission is narrowed to view', async () => {
    const fixture = await issued(), recorded = await record(fixture.invoice.id), before = await facts();
    await f.exec(`UPDATE public.system_role SET rules='invoice.view' WHERE id=${MANUAL_RED_ADMINS.manager}`);
    try {
      expect(data(await f.request(path(fixture.invoice.id) + '/red-notes/operations/' + recorded.input.request_id))).toMatchObject({ actor_id: MANUAL_RED_ADMINS.manager, committed: true, request_id: recorded.input.request_id });
      expect((await f.request(path(fixture.invoice.id) + '/red-notes', { ...recorded.input, request_id: crypto.randomUUID() })).body.status).not.toBe(200);
      expect(await facts()).toEqual(before);
    } finally { await f.restoreAdminAuthority(); }
  });
  it.each(['missing', 'main'] as const)('rejects a %s independent Admin binding without falling back to the ordinary customer LOGIN', async selector => {
    const fixture = await issued(), body = await recordInput(fixture.invoice.id), before = await facts();
    const bindings = { ...f.env };
    if (selector === 'missing') {
      // Exercise actual runtime absence without an undefined-valued binding
      // or a cast that would bypass the production selector's presence check.
      expect(Reflect.deleteProperty(bindings, 'HYPERDRIVE_ADMIN')).toBe(true);
      expect(Object.hasOwn(bindings, 'HYPERDRIVE_ADMIN')).toBe(false);
    } else bindings.HYPERDRIVE_ADMIN = f.env.HYPERDRIVE;
    expect((await f.request(path(fixture.invoice.id) + '/red-notes', body, 'manager', bindings)).body.status).not.toBe(200);
    expect(await facts()).toEqual(before);
  });
  it('enforces append-only facts against the Admin writer, customer reader and owned maintenance connection', async () => {
    const fixture = await issued(), recorded = await record(fixture.invoice.id); await review(fixture.invoice.id, recorded.result);
    const before = await facts(), row = before.records.find(value => value.id === recorded.input.request_id)!;
    await expect(f.db.insert(storeOrderInvoiceManualRedNote).values(row)).rejects.toThrow();
    for (const db of [f.db, f.admin.db, f.maintenanceDb]) {
      await expect(db.update(storeOrderInvoiceManualRedNote).set({ requestHash: 'f'.repeat(64) }).where(eq(storeOrderInvoiceManualRedNote.id, row.id))).rejects.toThrow();
      await expect(db.delete(storeOrderInvoiceManualRedNote).where(eq(storeOrderInvoiceManualRedNote.id, row.id))).rejects.toThrow();
      await expect(db.execute(sql`TRUNCATE public.store_order_invoice_manual_red_note,public.store_order_invoice_manual_red_review`)).rejects.toThrow();
    }
    expect(await facts()).toEqual(before);
  });
  it.each(['store_order_invoice_manual_red_note', 'store_order_invoice_manual_red_review'] as const)(
    'closes the refund gate after loss of the exact reader SELECT on %s', async table => {
      const fixture = await issued(), recorded = await record(fixture.invoice.id); await review(fixture.invoice.id, recorded.result);
      const before = await facts(); await f.exec(`REVOKE SELECT ON public.${table} FROM "${f.role}"`);
      try { expect((await invoiceManualRedNoteReadiness(f.db)).ready).toBe(false); await expect(quote(fixture.source.order.id)).rejects.toThrow(); }
      finally { await f.exec(`GRANT SELECT ON public.${table} TO "${f.role}"`); }
      expect((await invoiceManualRedNoteReadiness(f.db)).ready).toBe(true); expect(await facts()).toEqual(before);
    },
  );
  it.each(['store_order_invoice_manual_red_note', 'store_order_invoice_manual_red_review'] as const)(
    'refuses an Admin operation after loss of INSERT on %s without runtime ACL repair', async table => {
      const fixture = await issued(), recorded = table.endsWith('_review') ? await record(fixture.invoice.id) : undefined;
      const body = recorded ? { request_id: crypto.randomUUID(), record_hash: recorded.result.record.record_hash, decision: 'confirm', manual_checked: true, review_note: '权限不足不能核对' }
        : await recordInput(fixture.invoice.id);
      const endpoint = path(fixture.invoice.id) + '/red-notes' + (recorded ? '/' + recorded.result.record.id + '/review' : '');
      const before = await facts(); await f.exec(`REVOKE INSERT ON public.${table} FROM "${f.admin.role}"`);
      try {
        expect((await invoiceManualRedNoteReadiness(f.admin.db, 'admin-write')).ready).toBe(false);
        expect((await f.request(endpoint, body)).body.status).not.toBe(200);
        const [acl] = await f.maintenanceDb.execute<{ remains: boolean }>(sql`SELECT has_table_privilege(${f.admin.role},${'public.' + table},'INSERT') AS remains`);
        expect(acl.remains).toBe(false); expect(await facts()).toEqual(before);
      } finally { await f.exec(`GRANT INSERT ON public.${table} TO "${f.admin.role}"`); }
      expect((await invoiceManualRedNoteReadiness(f.admin.db, 'admin-write')).ready).toBe(true);
    },
  );
  it('refuses reader write authority even when the complete published ledger shape is unchanged', async () => {
    const fixture = await issued(), recorded = await record(fixture.invoice.id); await review(fixture.invoice.id, recorded.result);
    const before = await facts(); await f.exec(`GRANT INSERT ON public.store_order_invoice_manual_red_review TO "${f.role}"`);
    try { expect((await invoiceManualRedNoteReadiness(f.db)).ready).toBe(false); await expect(quote(fixture.source.order.id)).rejects.toThrow(); }
    finally { await f.exec(`REVOKE INSERT ON public.store_order_invoice_manual_red_review FROM "${f.role}"`); }
    expect((await invoiceManualRedNoteReadiness(f.db)).ready).toBe(true); expect(await facts()).toEqual(before);
  });
  it('rejects a changed catalog CHECK and guard function without trusting a freshly observed fingerprint', async () => {
    const fixture = await issued(), recorded = await record(fixture.invoice.id); await review(fixture.invoice.id, recorded.result);
    const before = await facts(), [constraint] = await f.maintenanceDb.execute<{ body: string }>(sql`
      SELECT pg_get_constraintdef(oid,true) AS body FROM pg_constraint WHERE conrelid='public.store_order_invoice_manual_red_note'::regclass AND conname='soimrn_hash_ck'`);
    expect(constraint.body).toMatch(/^CHECK \(/);
    const expression = constraint.body.slice(7, -1);
    await f.exec(`ALTER TABLE public.store_order_invoice_manual_red_note DROP CONSTRAINT soimrn_hash_ck;ALTER TABLE public.store_order_invoice_manual_red_note ADD CONSTRAINT soimrn_hash_ck CHECK ((${expression}) AND id IS NOT NULL)`);
    try { expect((await invoiceManualRedNoteReadiness(f.db)).ready).toBe(false); await expect(quote(fixture.source.order.id)).rejects.toThrow(); }
    finally { await f.exec(`ALTER TABLE public.store_order_invoice_manual_red_note DROP CONSTRAINT soimrn_hash_ck;ALTER TABLE public.store_order_invoice_manual_red_note ADD CONSTRAINT soimrn_hash_ck ${constraint.body}`); }
    expect((await invoiceManualRedNoteReadiness(f.db)).ready).toBe(true);
    await f.exec('ALTER FUNCTION public.guard_invoice_manual_red_note() SECURITY INVOKER');
    try { expect((await invoiceManualRedNoteReadiness(f.db)).ready).toBe(false); await expect(quote(fixture.source.order.id)).rejects.toThrow(); }
    finally { await f.exec('ALTER FUNCTION public.guard_invoice_manual_red_note() SECURITY DEFINER'); }
    expect((await invoiceManualRedNoteReadiness(f.db)).ready).toBe(true); expect(await facts()).toEqual(before);
  });
  it('requires the exact common invoice/order/ledger owner in addition to all catalog pins', async () => {
    const fixture = await issued(), recorded = await record(fixture.invoice.id); await review(fixture.invoice.id, recorded.result);
    const role = 'manual_red_drift_' + crypto.randomUUID().replaceAll('-', ''), before = await facts();
    await f.exec(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    try {
      await f.exec(`ALTER TABLE public.store_order_invoice_manual_red_review OWNER TO "${role}"`);
      expect((await invoiceManualRedNoteReadiness(f.db)).ready).toBe(false); await expect(quote(fixture.source.order.id)).rejects.toThrow();
    } finally { await f.exec(`ALTER TABLE public.store_order_invoice_manual_red_review OWNER TO finance_test;DROP ROLE "${role}"`); }
    expect((await invoiceManualRedNoteReadiness(f.db)).ready).toBe(true); expect(await facts()).toEqual(before);
  });
  it('rolls back invoice mutation and captured issuance on a real late audit failure, then recovers the original UUID', async () => {
    const source = await f.cashier(0, '7.00', 1), invoice = await f.application(source.order.id), detail = data<{ revision: string }>(await f.request(path(invoice.id)));
    const body = { is_invoice: 1, invoice_number: String(++number), remark: '晚审计失败须原子回滚', revision: detail.revision, request_id: crypto.randomUUID() };
    await f.exec(`CREATE FUNCTION public.owned_manual_red_late_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.oid=${source.order.id} AND NEW.change_type='admin_invoice_process' THEN RAISE EXCEPTION 'Owned late invoice audit failure' USING ERRCODE='23514';END IF;RETURN NEW;END$$;CREATE TRIGGER owned_manual_red_late_audit AFTER INSERT ON public.store_order_status FOR EACH ROW EXECUTE FUNCTION public.owned_manual_red_late_audit()`);
    const before = await facts();
    try { expect((await f.request(path(invoice.id) + '/process', body)).body.status).not.toBe(200); expect(await facts()).toEqual(before); }
    finally { await f.exec('DROP TRIGGER owned_manual_red_late_audit ON public.store_order_status;DROP FUNCTION public.owned_manual_red_late_audit()'); }
    expect(data(await f.request(path(invoice.id) + '/process', body))).toMatchObject({ committed: true, request_id: body.request_id, uid: 0 });
    expect((await f.db.select().from(storeOrderInvoiceEvidence).where(sql`${storeOrderInvoiceEvidence.invoiceId}=${invoice.id} AND ${storeOrderInvoiceEvidence.kind}='issued'`))).toHaveLength(1);
  });
  it.each(['request-hash', 'nested-source', 'root', 'buyer', 'actor'] as const)(
    'rejects direct Admin INSERT with forged %s even if the raw JSON digest is recomputed', async field => {
      const fixture = await issued(), recorded = await record(fixture.invoice.id);
      const row = (await f.db.select().from(storeOrderInvoiceManualRedNote).where(eq(storeOrderInvoiceManualRedNote.id, recorded.input.request_id)))[0];
      const id = crypto.randomUUID(), payload = JSON.parse(row.recordJson); payload.request_id = id;
      const candidate = { ...row, id };
      if (field === 'nested-source') payload.source.store_id += 1;
      if (field === 'root') { payload.payment_order_id += 1; payload.payment.id += 1; candidate.paymentOrderId += 1; }
      if (field === 'buyer') { payload.uid = 11; payload.payment.uid = 11; payload.source.uid = 11; candidate.uid = 11; }
      if (field === 'actor') { payload.actor_id = 0; candidate.actorId = 0; }
      candidate.recordJson = JSON.stringify(payload); candidate.recordHash = await manualRedDigest(candidate.recordJson);
      candidate.requestHash = field === 'request-hash' ? 'f'.repeat(64) : await manualRedRecordIntentHash(candidate.invoiceId, candidate.actorId,
        { ...recorded.input, request_id: id });
      const before = await facts(); await expect(f.admin.db.insert(storeOrderInvoiceManualRedNote).values(candidate)).rejects.toThrow();
      expect(await facts()).toEqual(before); await expect(quote(fixture.source.order.id)).rejects.toThrow();
    },
  );
  it('deduplicates two actual Admin HTTP writers by one UUID while PostgreSQL proves the shared root wait', async () => {
    const fixture = await issued(), body = await recordInput(fixture.invoice.id), endpoint = path(fixture.invoice.id) + '/red-notes';
    await withHeldRoot(fixture.source.order.id, async (holder, release, track) => {
      const first = track(f.request(endpoint, body)), waiter = await waitForAdminBlock(holder);
      const second = track(f.request(endpoint, body));
      try { await waitForAdminBlock(waiter); } finally { release(); }
      const results = await Promise.all([first, second]);
      for (const result of results) expect(data(result)).toMatchObject({ request_id: body.request_id, committed: true });
      expect(results.map(result => (result.body.data as ManualRedOperationReceipt).idempotent).sort()).toEqual([false, true]);
    });
    expect(await f.db.select().from(storeOrderInvoiceManualRedNote).where(eq(storeOrderInvoiceManualRedNote.id, body.request_id))).toHaveLength(1);
  });
  it('serializes two distinct manual confirmations for the same original ticket and commits exactly one cover', async () => {
    const fixture = await issued(), first = await record(fixture.invoice.id), second = await record(fixture.invoice.id);
    const body = (r: ManualRedOperationReceipt) => ({ request_id: crypto.randomUUID(), record_hash: r.record.record_hash,
      decision: 'confirm', manual_checked: true, review_note: '真实并发人工整票核对' });
    await withHeldRoot(fixture.source.order.id, async (holder, release, track) => {
      const a = track(f.request(path(fixture.invoice.id) + '/red-notes/' + first.result.record.id + '/review', body(first.result)));
      const waiter = await waitForAdminBlock(holder);
      const b = track(f.request(path(fixture.invoice.id) + '/red-notes/' + second.result.record.id + '/review', body(second.result)));
      try { await waitForAdminBlock(waiter); } finally { release(); }
      const outcomes = await Promise.all([a, b]); expect(outcomes.filter(result => result.body.status === 200)).toHaveLength(1);
    });
    expect((await f.db.select().from(storeOrderInvoiceManualRedReview).where(eq(storeOrderInvoiceManualRedReview.invoiceId, fixture.invoice.id))).filter(row => row.decision === 'confirm')).toHaveLength(1);
    await refund(fixture.source.order.id);
  });
  it('rechecks the fixed guard catalog after a genuine root lock wait before committing a manual record', async () => {
    const fixture = await issued(), body = await recordInput(fixture.invoice.id), before = await facts();
    await withHeldRoot(fixture.source.order.id, async (holder, release, track) => {
      const pending = track(f.request(path(fixture.invoice.id) + '/red-notes', body));
      await waitForAdminBlock(holder);
      await f.exec('ALTER FUNCTION public.guard_invoice_manual_red_note() SECURITY INVOKER');
      try { release(); expect((await pending).body.status).not.toBe(200); }
      finally { release(); await f.exec('ALTER FUNCTION public.guard_invoice_manual_red_note() SECURITY DEFINER'); }
    });
    expect((await invoiceManualRedNoteReadiness(f.admin.db, 'admin-write')).ready).toBe(true);
    expect(await facts()).toEqual(before);
  });
  it('rolls back the manual cash proof, split, invoice descendants and stock after a late finalizer audit failure', async () => {
    const fixture = await issued(), recorded = await record(fixture.invoice.id); await review(fixture.invoice.id, recorded.result);
    const cart = (await carts(fixture.source.order.id))[0], created = await createRefund(fixture.source.order.id, [{ cart_row_id: cart.id, cart_num: 1 }]);
    const body = await refundDecision(created.refundId), originalContext = ctx();
    await f.exec(`CREATE FUNCTION public.owned_manual_red_late_finance() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.oid=${fixture.source.order.id} THEN RAISE EXCEPTION 'Owned late red-note refund audit failure' USING ERRCODE='23514';END IF;RETURN NEW;END$$;CREATE TRIGGER owned_manual_red_late_finance AFTER INSERT ON public.store_order_status FOR EACH ROW EXECUTE FUNCTION public.owned_manual_red_late_finance()`);
    const before = await facts();
    try {
      const attempted = await service().execute('refund_execute', originalContext, body).catch(() => null);
      if (attempted) expect(attempted.execution?.completed).not.toBe(true);
      expect(await facts()).toEqual(before);
      expect((await service().status(f.actor(), originalContext.request_key)).execution?.completed).not.toBe(true);
    } finally { await f.exec('DROP TRIGGER owned_manual_red_late_finance ON public.store_order_status;DROP FUNCTION public.owned_manual_red_late_finance()'); }
    const recovered = await service().execute('refund_execute', originalContext, body);
    expect(recovered.execution).toMatchObject({ status: 'CASH_SUCCESS', completed: true, verified: true });
    const after = await facts();
    expect((await service().status(f.actor(), originalContext.request_key)).receipt).toEqual(recovered.receipt);
    expect(await facts()).toEqual(after);
  });
  it('keeps a completed original refund proof while a remaining child is newly issued and requires its own full manual red note', async () => {
    const fixture = await issued(), firstRecord = await record(fixture.invoice.id); await review(fixture.invoice.id, firstRecord.result);
    const firstCart = (await carts(fixture.source.order.id))[0], first = await refund(fixture.source.order.id, [{ cart_row_id: firstCart.id, cart_num: 1 }]);
    const split = (await f.db.select().from(storeOrderRefundSplit).where(eq(storeOrderRefundSplit.refundId, first.refundId)))[0];
    const remainingId = split.remainingOrderId!, remainingInvoice = (await f.db.select().from(storeOrderInvoice)
      .where(sql`${storeOrderInvoice.orderId}=${remainingId} AND ${storeOrderInvoice.isDel}=0`))[0];
    const detail = data<{ revision: string }>(await f.request(path(remainingInvoice.id)));
    const issuance = { is_invoice: 1, invoice_number: String(++number), remark: '剩余真实对价重新开具的新票', revision: detail.revision, request_id: crypto.randomUUID() };
    data(await f.request(path(remainingInvoice.id) + '/process', issuance));
    const before = await facts(); await expect(quote(remainingId)).rejects.toThrow();
    expect((await service().status(f.actor(), first.executionContext.request_key)).receipt).toEqual(first.executed.receipt);
    expect((await service().status(f.actor(), first.executionContext.request_key)).execution).toMatchObject({ status: 'CASH_SUCCESS', completed: true, verified: true });
    expect(await facts()).toEqual(before);
    const childRecord = await record(remainingInvoice.id); expect(childRecord.input.original_amount).toBe('14.00');
    await review(remainingInvoice.id, childRecord.result);
    const cart = (await carts(remainingId))[0], second = await refund(remainingId, [{ cart_row_id: cart.id, cart_num: 1 }]);
    const secondSplit = (await f.db.select().from(storeOrderRefundSplit).where(eq(storeOrderRefundSplit.refundId, second.refundId)))[0];
    expect(JSON.parse(secondSplit.invoiceAllocation)).toMatchObject({ version: 'refund-invoice-allocation-manual-red-v2', manual_disposition: { coverage_count: 2 } });
    const lastId = secondSplit.remainingOrderId!, lastInvoice = (await f.db.select().from(storeOrderInvoice)
      .where(sql`${storeOrderInvoice.orderId}=${lastId} AND ${storeOrderInvoice.isDel}=0`))[0];
    expect(lastInvoice).toMatchObject({ isInvoice: 0, invoiceNumber: '', invoiceAmount: '7.00' });
    await refund(lastId);
    expect((await service().status(f.actor(), first.executionContext.request_key)).receipt).toEqual(first.executed.receipt);
    expect(data(await f.request(path(remainingInvoice.id) + '/process', issuance))).toMatchObject({ committed: true, request_id: issuance.request_id, receipt_is_invoice: 1 });
  });
  it('binds a different authorized human reviewer without attributing the record or buyer to that reviewer', async () => {
    const fixture = await issued(), recorded = await record(fixture.invoice.id);
    const body: ManualRedReviewInput = { request_id: crypto.randomUUID(), record_hash: recorded.result.record.record_hash,
      decision: 'confirm', manual_checked: true, review_note: '另一实际管理员逐项核对完整票据' };
    const result = data<ManualRedOperationReceipt>(await f.request(path(fixture.invoice.id) + '/red-notes/' + recorded.result.record.id + '/review', body, 'otherManager'));
    expect(result).toMatchObject({ actor_id: MANUAL_RED_ADMINS.otherManager,
      record: { actor_id: MANUAL_RED_ADMINS.manager, review: { actor_id: MANUAL_RED_ADMINS.otherManager, id: body.request_id } } });
    await refund(fixture.source.order.id);
    expect(data(await f.request(path(fixture.invoice.id) + '/red-notes/operations/' + body.request_id, undefined, 'otherManager'))).toMatchObject({ actor_id: MANUAL_RED_ADMINS.otherManager, committed: true });
    expect((await f.request(path(fixture.invoice.id) + '/red-notes/operations/' + body.request_id)).body.status).not.toBe(200);
    expect(await f.db.select().from(user).where(eq(user.uid, 0))).toEqual([]);
  });
  it.each(['pending-consumer', 'dead-consumer', 'missing-completion-time', 'duplicate-paid-consumer'] as const)(
    'keeps real payment-source validation fail-closed despite manual red coverage when %s', async state => {
      const fixture = await issued(), recorded = await record(fixture.invoice.id); await review(fixture.invoice.id, recorded.result);
      if (state === 'pending-consumer') await f.maintenanceDb.update(storeOrderOutbox).set({ status: 'PENDING' }).where(eq(storeOrderOutbox.id, fixture.event.id));
      if (state === 'dead-consumer') await f.maintenanceDb.update(storeOrderOutbox).set({ status: 'DEAD' }).where(eq(storeOrderOutbox.id, fixture.event.id));
      if (state === 'missing-completion-time') await f.maintenanceDb.update(storeOrderOutbox).set({ processedTime: 0 }).where(eq(storeOrderOutbox.id, fixture.event.id));
      if (state === 'duplicate-paid-consumer') await f.maintenanceDb.insert(storeOrderStatus).values({ oid: fixture.source.order.id,
        changeType: 'pay_success', changeMessage: '订单支付成功，后置任务处理完成', changeTime: fixture.event.processedTime });
      const before = await facts(); await expect(quote(fixture.source.order.id)).rejects.toThrow(); expect(await facts()).toEqual(before);
    },
  );
  it.each(['invoice', 'refund'] as const)('serializes genuine Admin issuance against customer refund creation with %s winning', async winner => {
    const fixture = await issued(), recorded = await record(fixture.invoice.id); await review(fixture.invoice.id, recorded.result);
    const financial = await creationBody(fixture.source.order.id), financialContext = ctx();
    const detail = data<{ revision: string }>(await f.request(path(fixture.invoice.id)));
    const issuance = { is_invoice: 1, invoice_number: String(++number), remark: '真实并发新票号', revision: detail.revision, request_id: crypto.randomUUID() };
    await f.withPeer(async (customer, customerPid) => {
      await withHeldRoot(fixture.source.order.id, async (holder, release, track) => {
        if (winner === 'invoice') {
          const earlier = track(f.request(path(fixture.invoice.id) + '/process', issuance)), adminPid = await waitForAdminBlock(holder);
          const later = track(service(customer).create(financialContext, financial).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error })));
          try { await waitForFinanceBlock(f.maintenanceDb, customerPid, adminPid); } finally { release(); }
          expect(data(await earlier)).toMatchObject({ committed: true, request_id: issuance.request_id });
          const outcome = await later; if (outcome.ok) expect(outcome.value.receipt?.outcome).toBe('rollback-rejected');
        } else {
          const earlier = track(service(customer).create(financialContext, financial));
          await waitForFinanceBlock(f.maintenanceDb, customerPid, holder);
          const later = track(f.request(path(fixture.invoice.id) + '/process', issuance));
          try { await waitForAdminBlock(customerPid); } finally { release(); }
          expect((await earlier).receipt?.outcome).toBe('refund-created'); expect((await later).body.status).not.toBe(200);
        }
      });
    });
    const actual = await f.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.storeOrderId, fixture.source.order.id));
    expect(actual).toHaveLength(winner === 'refund' ? 1 : 0);
    const laterTicket = await f.db.select().from(storeOrderInvoiceEvidence).where(sql`${storeOrderInvoiceEvidence.invoiceId}=${fixture.invoice.id}
      AND ${storeOrderInvoiceEvidence.kind}='issued' AND ${storeOrderInvoiceEvidence.documentNumber}=${issuance.invoice_number}`);
    expect(laterTicket).toHaveLength(winner === 'invoice' ? 1 : 0);
  });
  it.each(['request-hash', 'record-hash', 'actor', 'buyer', 'unverified-history', 'changed-payment-time'] as const)(
    'rejects direct Admin confirmation with %s without admitting a manually reviewed cover', async field => {
      const fixture = await issued(), recorded = await record(fixture.invoice.id), recordRow = (await f.db.select().from(storeOrderInvoiceManualRedNote)
        .where(eq(storeOrderInvoiceManualRedNote.id, recorded.input.request_id)))[0];
      const id = crypto.randomUUID(), body: ManualRedReviewInput = { request_id: id, record_hash: recordRow.recordHash,
        decision: 'confirm', manual_checked: true, review_note: '仅为受保护writer负向fixture' };
      const payload = { version: 'invoice-manual-red-review-v1', request_id: id, record_id: recordRow.id, record_hash: recordRow.recordHash,
        actor_id: Number(MANUAL_RED_ADMINS.manager), invoice_id: recordRow.invoiceId, source_order_id: recordRow.sourceOrderId,
        payment_order_id: recordRow.paymentOrderId, uid: recordRow.uid, original_document_number: recorded.input.original_document_number,
        red_document_number: recorded.input.red_document_number, decision: 'confirm', manual_checked: true, review_note: body.review_note,
        created_time: Math.floor(Date.now() / 1000) };
      if (field === 'actor') payload.actor_id = 0;
      if (field === 'buyer') payload.uid = 11;
      if (field === 'record-hash') { payload.record_hash = 'f'.repeat(64); body.record_hash = payload.record_hash; }
      if (field === 'unverified-history') await f.maintenanceDb.insert(storeOrderInvoiceEvidence).values({ invoiceId: fixture.invoice.id,
        orderId: fixture.source.order.id, uid: 0, kind: 'unverified', documentNumber: '', snapshot: fixture.original.snapshot });
      if (field === 'changed-payment-time') await f.maintenanceDb.update(storeOrder).set({ payTime: fixture.source.order.payTime + 1 }).where(eq(storeOrder.id, fixture.source.order.id));
      const reviewJson = JSON.stringify(payload), before = await facts();
      await expect(f.admin.db.insert(storeOrderInvoiceManualRedReview).values({ id, recordId: recordRow.id, invoiceId: recordRow.invoiceId,
        sourceOrderId: recordRow.sourceOrderId, paymentOrderId: recordRow.paymentOrderId, uid: payload.uid, actorId: payload.actor_id,
        decision: 'confirm', originalDocumentNumber: recorded.input.original_document_number, redDocumentNumber: recorded.input.red_document_number,
        requestHash: field === 'request-hash' ? 'f'.repeat(64) : await manualRedReviewIntentHash(recordRow.invoiceId, recordRow.id, payload.actor_id, body),
        recordHash: payload.record_hash, reviewHash: await manualRedDigest(reviewJson), reviewJson, createdTime: payload.created_time })).rejects.toThrow();
      expect(await facts()).toEqual(before); await expect(quote(fixture.source.order.id)).rejects.toThrow();
    },
  );
});
