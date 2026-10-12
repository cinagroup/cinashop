import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import { createContainerFromDb, type DbClient } from '../src/lib/di';
import { CustomerWorkFinancialService } from '../src/services/customer-work/CustomerWorkFinancialService';
import { authorizeCustomerWorkActor } from '../src/services/customer-work/CustomerWorkScope';
import { financialRevisions } from '../src/services/customer-work/CustomerWorkFinancialReadService';
import { CUSTOMER_FINANCIAL_VERSION, CUSTOMER_FINANCIAL_QUOTE_VERSION, type FinancialContext, type FinancialInput } from '../src/services/customer-work/CustomerWorkFinancialProtocol';
import type { CustomerJson } from '../src/services/customer-work/CustomerWorkOperationRequest';
import { CUSTOMER_MANUAL_OFFLINE_ORIGIN_VERSION } from '../src/services/order/CustomerManualOfflineOrigin';
import { customerManualManagerOriginReadiness, runCustomerManualManagerOriginRead } from '../src/migrations/customerManualOfflineOriginCatalog';
import { outRequestHash } from '../src/services/out/OutIdempotency';
import { storeOrder, storeOrderCartInfo, storeOrderRefund, storeOrderRefundPayment, storeOrderOutbox, storeOrderStatus, storeOrderInvoice, storeOrderPromotions, storeProduct, storeProductAttrValue, storeService, systemStoreStaff, systemAdmin, user, userBill } from '../src/models/schema';
import { storeOrderRefundSplit } from '../src/models/schema/order_refund_split';
import { customerWorkOfflineOriginRefundFixture, type OfflineNativeProducer } from './helpers/customerWorkOfflineOriginRefundFixture';

/** Real registered PG16. v1 routes authenticate on the ordinary application
 * LOGIN before opening the actual manager/Admin bindings. New roots, primary
 * audits, original manager intent/UUID and paid completion all come from real
 * producers/consumers. Maintenance only seeds inputs or explicit bad-source
 * counterexamples. Provider HTTP is prohibited throughout this suite. */
describe.skipIf(!process.env.TEST_FINANCE_POSTGRES_URL)('modern manager and Admin offline origins, ordinary customer refunds PostgreSQL16', { timeout: 30000 }, () => {
  let f: Awaited<ReturnType<typeof customerWorkOfflineOriginRefundFixture>>;
  let external: ReturnType<typeof vi.spyOn>;
  beforeAll(async () => { f = await customerWorkOfflineOriginRefundFixture(); }, 180000);
  beforeEach(async () => {
    await f.reset();
    external = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Offline native acceptance must not dispatch provider HTTP'));
  });
  afterEach(() => { try { expect(external).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); vi.useRealTimers(); } });
  afterAll(async () => { await f?.close(); }, 30000);
  const service = (db: DbClient = f.db) => new CustomerWorkFinancialService(createContainerFromDb(db), f.env);
  const context = (key = crypto.randomUUID(), uid = 101): FinancialContext => ({ actor: f.actor(uid), request_key: key });
  const order = (id: number) => f.order(id);
  const carts = (id: number) => f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, id)).orderBy(asc(storeOrderCartInfo.id));
  const manual = () => f.db.execute<Record<string, unknown>>(sql`SELECT * FROM public.customer_financial_manual_refund_v1 ORDER BY refund_id`);
  const managerRows = () => f.db.execute<Record<string, unknown>>(sql`SELECT actor_uid,request_key::text,request_hash,store_id,staff_id,order_id,kind,outcome,scope_key,expected_revision,intent,evidence,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at FROM public.manager_order_operation_request ORDER BY actor_uid,request_key`);
  const ledger = () => f.db.execute(sql`SELECT * FROM public.customer_financial_operation_request ORDER BY actor_uid,request_key`);
  async function facts() {
    return {
      orders: await f.db.select().from(storeOrder).orderBy(asc(storeOrder.id)),
      carts: await f.db.select().from(storeOrderCartInfo).orderBy(asc(storeOrderCartInfo.id)),
      refunds: await f.db.select().from(storeOrderRefund).orderBy(asc(storeOrderRefund.id)),
      splits: await f.db.select().from(storeOrderRefundSplit).orderBy(asc(storeOrderRefundSplit.refundId)),
      users: await f.db.select().from(user).orderBy(asc(user.uid)), bills: await f.db.select().from(userBill).orderBy(asc(userBill.id)),
      products: await f.db.select().from(storeProduct).orderBy(asc(storeProduct.id)), skus: await f.db.select().from(storeProductAttrValue).orderBy(asc(storeProductAttrValue.id)),
      payments: await f.db.select().from(storeOrderRefundPayment).orderBy(asc(storeOrderRefundPayment.id)),
      outbox: await f.db.select().from(storeOrderOutbox).orderBy(asc(storeOrderOutbox.id)),
      audits: await f.db.select().from(storeOrderStatus).orderBy(asc(storeOrderStatus.id)),
      invoices: await f.db.select().from(storeOrderInvoice).orderBy(asc(storeOrderInvoice.id)),
      promotions: await f.db.select().from(storeOrderPromotions).orderBy(asc(storeOrderPromotions.id)), manual: await manual(),
    };
  }
  async function input(id: number, payload: CustomerJson, uid = 101): Promise<FinancialInput> {
    const current = await order(id), scope = await authorizeCustomerWorkActor(f.db, f.actor(uid)), revisions = await financialRevisions(f.db, current);
    return { version: CUSTOMER_FINANCIAL_VERSION, scope_key: scope.scope_key, order_id: id,
      expected_order_revision: revisions.order_revision, expected_financial_revision: revisions.financial_revision, payload };
  }
  async function quote(id: number, items: Array<{ cart_row_id: number; cart_num: number }> = [], uid = 101) {
    const body = await input(id, {}, uid);
    return service().reader.quote(f.actor(uid), { version: CUSTOMER_FINANCIAL_QUOTE_VERSION, scope_key: body.scope_key, order_id: id,
      expected_order_revision: body.expected_order_revision, expected_financial_revision: body.expected_financial_revision,
      mode: items.length ? 'items' : 'remaining', items });
  }
  async function creation(id: number, items: Array<{ cart_row_id: number; cart_num: number }> = [], uid = 101) {
    const data = (await quote(id, items, uid)).data;
    return input(id, { mode: items.length ? 'items' : 'remaining', items, quoted_price: data.quoted_price, refund_price: data.quoted_price,
      quote_fingerprint: data.quote_fingerprint, reason: '核对原线下付款与实际退款' }, uid);
  }
  async function create(id: number, items: Array<{ cart_row_id: number; cart_num: number }> = [], uid = 101) {
    const body = await creation(id, items, uid), ctx = context(undefined, uid), result = await service().create(ctx, body);
    expect(result.receipt?.outcome).toBe('refund-created');
    return { id: Number(result.receipt!.evidence.refund_id), body, ctx, result };
  }
  async function decision(id: number, uid = 101) {
    const refund = (await f.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.id, id)))[0];
    const data = (await service().reader.review(f.actor(uid), id, { refund_no: refund.orderId })).data;
    return input(data.order_id, { refund_id: id, refund_no: data.refund_no, expected_refund_revision: data.refund_revision,
      review_fingerprint: data.review_fingerprint, refund_price: data.refund_price,
      decision: { apply_type: data.apply_type, refund_type: data.refund_type, received: false,
        ...(data.refund_settlement === 'cash' ? { cash_returned: true } : {}) } }, uid);
  }
  async function execute(id: number, uid = 101) {
    const body = await decision(id, uid), ctx = context(undefined, uid), result = await service().execute('refund_execute', ctx, body);
    return { body, ctx, result };
  }
  async function rejectedWithoutWrites(action: () => Promise<unknown>) {
    const before = await facts();
    const result = await action().catch(error => {
      expect(error.code, 'Predictable source/ACL rejection must be local, not raw SQL permission failure').not.toBe('42501');
      return null;
    });
    if (result && typeof result === 'object' && 'receipt' in result) {
      expect((result as { receipt?: { outcome?: string } }).receipt?.outcome).toBe('rollback-rejected');
    }
    expect(await facts()).toEqual(before);
  }
  function lostCommittedReply(db: DbClient, key: string, uid = 101) {
    let lost = false;
    const wrapped = new Proxy(db, { get(target, name, receiver) {
      const run = Reflect.get(target, name, receiver); if (typeof run !== 'function') return run;
      if (name !== 'transaction') return run.bind(target);
      return async (...args: unknown[]) => {
        const result = await Reflect.apply(run, target, args);
        const [row] = await f.maintenanceDb.execute<{ present: boolean }>(sql`SELECT EXISTS(SELECT 1 FROM public.customer_financial_operation_request WHERE actor_uid=${uid} AND request_key=${key}::uuid) AS present`);
        if (!lost && row.present) { lost = true; throw Object.assign(Error('Reply lost after independently observed actual COMMIT'), { code: '40003' }); }
        return result;
      };
    } });
    return { db: wrapped, occurred: () => lost };
  }
  const origins: OfflineNativeProducer[] = ['manager', 'admin'];
  const matrix = origins.flatMap(producer => [11, 0].flatMap(buyer => ['7.00', '0.00'].map(price => ({ producer, buyer, price }))));
  it.each(matrix)('actual $producer routes and paid consumer settle buyer=$buyer price=$price on customer LOGIN', async ({ producer, buyer, price }) => {
    const source = await f.paid(producer, buyer, price), before = await facts();
    expect(source.order).toMatchObject({ uid: buyer, paid: 1, payType: 'offline', staffId: 1, status: 0 });
    expect((await f.db.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id, source.event.id)))[0]).toMatchObject({ status: 'COMPLETED', payload: { orderId: source.order.id, orderNo: source.order.orderId } });
    const [identity] = await f.db.execute(sql`SELECT current_user AS role,session_user AS session,has_table_privilege(current_user,'public.manager_order_operation_request','SELECT') AS read,has_table_privilege(current_user,'public.manager_order_operation_request','INSERT,UPDATE,DELETE') AS write,has_any_column_privilege(current_user,'public.manager_order_operation_request','INSERT,UPDATE') AS column_write`);
    expect(identity).toEqual({ role: f.role, session: f.role, read: true, write: false, column_write: false });
    const createBody = await creation(source.order.id), createCtx = context();
    const posted = await f.request('/mobile/work/financial/refund-create', createBody, 101, 'api', createCtx.request_key);
    expect(posted.body.status, posted.body.msg).toBe(200);
    const createdId = Number((posted.body.data as { receipt: { evidence: { refund_id: number } } }).receipt.evidence.refund_id);
    const executeBody = await decision(createdId), executeCtx = context();
    const settled = await f.request('/mobile/work/financial/refund-execute', executeBody, 101, 'api', executeCtx.request_key);
    expect(settled.body.status, settled.body.msg).toBe(200);
    expect(settled.response.headers.get('Cache-Control')).toBe('private, no-store');
    const done = { body: executeBody, ctx: executeCtx, result: await service().status(f.actor(), executeCtx.request_key) };
    expect(done.result.execution).toMatchObject({ status: price === '0.00' ? 'ZERO_SUCCESS' : 'CASH_SUCCESS', completed: true, verified: true });
    expect(done.result.receipt).toMatchObject({ actor_uid: 101, outcome: price === '0.00' ? 'zero-settled' : 'cash-settled' });
    if (price === '0.00') {
      expect(done.result.receipt!.evidence).toEqual({ refund_id: createdId, verified: true });
      expect((done.body.payload as Record<string, CustomerJson>).decision).not.toHaveProperty('cash_returned');
    } else expect(done.result.receipt).toMatchObject({ evidence: { uid: buyer, payment_order_id: source.order.id, pay_type: 'offline', amount: source.order.payPrice } });
    const after = await facts(), proof = after.manual[0], frozen = proof.source as { payment: { payment_origin: Record<string, unknown> } };
    expect(after.manual).toHaveLength(1);
    const manualIdentity = { refund_id: createdId, actor_uid: 101, request_key: done.ctx.request_key, buyer_uid: buyer,
      payment_order_id: source.order.id, pay_type: 'offline', amount: source.order.payPrice,
      settlement: price === '0.00' ? 'zero' : 'cash', cash_returned: price !== '0.00' };
    expect(proof).toMatchObject(manualIdentity); expect(proof.proof).toMatchObject(manualIdentity);
    expect(frozen.payment.payment_origin).toMatchObject({ version: CUSTOMER_MANUAL_OFFLINE_ORIGIN_VERSION, kind: producer === 'manager' ? 'manager_order_offline' : 'admin_order_offline' });
    if (producer === 'manager') {
      const rows = await managerRows(); expect(rows).toHaveLength(1);
      expect(frozen.payment.payment_origin).toMatchObject({ actor_uid: 103, receipt: { request_key: source.key, intent: source.input, staff_id: 901 } });
      expect((frozen.payment.payment_origin.receipt as Record<string, unknown>).created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    } else { expect(await managerRows()).toEqual([]); expect(frozen.payment.payment_origin).not.toHaveProperty('receipt'); }
    expect(proof.source_hash).toBe(await outRequestHash(proof.source)); expect(proof.proof_hash).toBe(await outRequestHash(proof.proof));
    expect(after.users).toEqual(before.users); expect(after.bills).toEqual(before.bills); expect(after.payments).toEqual([]);
    expect(after.users.some(account => account.uid === 0)).toBe(false);
    expect(after.skus[0].stock).toBe(before.skus[0].stock + source.order.totalNum);
    expect(after.products[0].stock).toBe(before.products[0].stock + source.order.totalNum);
    expect((await service().status(f.actor(), done.ctx.request_key)).receipt).toEqual(done.result.receipt);
    const committed = await facts(); expect((await service().execute('refund_execute', done.ctx, done.body)).receipt).toEqual(done.result.receipt); expect(await facts()).toEqual(committed);
  });
  it('accepts actual positive-UID staff row id zero through manager route, exact audit and real consumer', async () => {
    await f.maintenanceDb.delete(systemStoreStaff).where(eq(systemStoreStaff.uid, 103));
    await f.maintenanceDb.insert(systemStoreStaff).values({ id: 0, uid: 103, storeId: 1, status: 1, isManager: 1, isDel: 0, orderStatus: 1 });
    const source = await f.paid('manager', 0), rows = await managerRows();
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ actor_uid: 103, staff_id: 0, order_id: source.order.id });
    expect(source.order.staffId).toBe(1);
    const audits = await f.db.select().from(storeOrderStatus).where(eq(storeOrderStatus.oid, source.order.id));
    expect(audits.find(row => row.changeType === 'manager_order_offline')?.changeMessage).toBe('用户 103 / 门店 1 / 员工 0 确认实际线下收款');
    expect((await execute((await create(source.order.id)).id)).result.execution).toMatchObject({ status: 'CASH_SUCCESS', verified: true });
  });
  it('preserves genuine payment when Worker Date leads PG clock and consumer is delayed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 60000);
    const source = await f.paid('manager', 11, '7.00', 3, 1100);
    const [recorded] = await f.maintenanceDb.execute<{ earlier: boolean }>(sql`SELECT created_at < to_timestamp(${source.order.payTime}) AS earlier FROM public.manager_order_operation_request WHERE request_key=${source.key}::uuid`);
    expect(recorded.earlier).toBe(true);
    const done = await execute((await create(source.order.id)).id);
    expect((await service().status(f.actor(), done.ctx.request_key)).execution).toMatchObject({ status: 'CASH_SUCCESS', completed: true, verified: true });
  });
  it.each(matrix)('retains $producer history after payer revocation through three invoice generations buyer=$buyer price=$price', async ({ producer, buyer, price }) => {
    const source = await f.paid(producer, buyer, price);
    await f.maintenanceDb.insert(storeOrderInvoice).values({ orderId: source.order.id, uid: buyer, category: 'order', invoiceAmount: source.order.payPrice, isPay: 1, isInvoice: 0 });
    if (producer === 'manager') await f.maintenanceDb.update(systemStoreStaff).set({ status: 0, isManager: 0 }).where(eq(systemStoreStaff.uid, 103));
    else await f.maintenanceDb.update(systemAdmin).set({ status: 0 }).where(eq(systemAdmin.id, 1));
    const before = await facts(), saved: Array<Awaited<ReturnType<typeof execute>>> = []; let active = source.order.id;
    for (let generation = 0; generation < 3; generation++) {
      const row = (await carts(active))[0], created = await create(active, generation === 2 ? [] : [{ cart_row_id: row.id, cart_num: 1 }], 102), done = await execute(created.id, 102);
      expect(done.result.execution).toMatchObject({ status: price === '0.00' ? 'ZERO_SUCCESS' : 'CASH_SUCCESS', completed: true, verified: true }); saved.push(done);
      const split = (await f.db.select().from(storeOrderRefundSplit).where(eq(storeOrderRefundSplit.refundId, created.id)))[0];
      expect(split).toMatchObject({ uid: buyer, paymentOrderId: source.order.id });
      if (generation < 2) { expect(split.remainingOrderId).toBeGreaterThan(0); expect(split.invoiceAllocation).not.toBe('null'); active = split.remainingOrderId!; }
    }
    const after = await facts(); expect(after.manual).toHaveLength(3);
    expect(after.manual.reduce((sum, row) => sum + BigInt(String(row.amount).replace('.', '')), 0n)).toBe(BigInt(source.order.payPrice.replace('.', '')));
    expect(after.skus[0].stock).toBe(before.skus[0].stock + 3); expect(after.users).toEqual(before.users); expect(after.payments).toEqual([]);
    for (const done of saved) expect((await service().status(f.actor(102), done.ctx.request_key)).execution).toMatchObject({ status: price === '0.00' ? 'ZERO_SUCCESS' : 'CASH_SUCCESS', verified: true });
    if (producer === 'manager') {
      const recovered = await f.request('/store/manager/order/operation/' + source.key + '/status', undefined, 103, 'api');
      expect(recovered.body).toMatchObject({ status: 200, data: { receipt: { request_key: source.key, outcome: 'offline-paid' } } });
    }
  });
  it.each(origins.flatMap(producer => ['refund_create', 'refund_execute'].map(kind => ({ producer, kind }))))('recovers $producer $kind original UUID after independently verified real COMMIT loss', async ({ producer, kind }) => {
    const source = await f.paid(producer, 0), target = kind === 'refund_execute' ? await create(source.order.id) : null;
    const body = target ? await decision(target.id) : await creation(source.order.id), ctx = context(), lost = lostCommittedReply(f.db, ctx.request_key), changed = service(lost.db);
    await (target ? changed.execute('refund_execute', ctx, body) : changed.create(ctx, body)).catch(error => { expect(error.message).toContain('actual COMMIT'); });
    expect(lost.occurred()).toBe(true);
    const original = await service().status(f.actor(), ctx.request_key); expect(original.receipt?.outcome).toBe(target ? 'cash-settled' : 'refund-created');
    expect((await ledger()).filter(row => row.request_key === ctx.request_key)).toHaveLength(1);
    const committed = await facts(), replay = target ? await service().execute('refund_execute', ctx, body) : await service().create(ctx, body);
    expect(replay.receipt).toEqual(original.receipt); expect(await facts()).toEqual(committed);
  });
  it.each(origins)('preserves %s completed owner proof after current customer revocation but denies fresh writes', async producer => {
    const source = await f.paid(producer, 0), row = (await carts(source.order.id))[0];
    const first = await create(source.order.id, [{ cart_row_id: row.id, cart_num: 1 }]), done = await execute(first.id);
    const split = (await f.db.select().from(storeOrderRefundSplit).where(eq(storeOrderRefundSplit.refundId, first.id)))[0], fresh = await creation(split.remainingOrderId!);
    await f.maintenanceDb.update(storeService).set({ customer: 0 }).where(eq(storeService.uid, 101));
    const before = await facts();
    expect((await service().status(f.actor(), done.ctx.request_key)).execution).toMatchObject({ status: 'CASH_SUCCESS', verified: true });
    expect((await service().execute('refund_execute', done.ctx, done.body)).receipt).toEqual(done.result.receipt);
    expect(await service().create(context(), fresh)).toMatchObject({ receipt: { actor_uid: 101, kind: 'refund_create', outcome: 'rollback-rejected' }, execution: null });
    expect(await facts()).toEqual(before);
    expect((await service().status(f.actor(102), done.ctx.request_key)).receipt).toBeNull();
  });
  it('Admin already-paid route response adds no second payment identity, audit or outbox', async () => {
    const source = await f.paid('admin'), before = await facts();
    expect((await f.adminOffline(source.order.id)).body.status).toBe(200); expect(await facts()).toEqual(before); expect(await managerRows()).toEqual([]);
    const done = await execute((await create(source.order.id)).id), origin = ((await manual())[0].source as { payment: { payment_origin: Record<string, unknown> } }).payment.payment_origin;
    expect(origin).toMatchObject({ kind: 'admin_order_offline', admin_id: 1 }); expect(origin).not.toHaveProperty('request_key');
    expect(done.result.execution?.completed).toBe(true);
  });
  it('actual UserJWT and independent binding failure do not enter or write the manager realm', async () => {
    const source = await f.unpaid(), body = await f.managerInput(source.order.id), before = await facts();
    expect((await f.managerOffline(body, crypto.randomUUID(), 1, 'admin')).body.status).not.toBe(200);
    for (const binding of [undefined, f.env.HYPERDRIVE, f.env.HYPERDRIVE_ADMIN]) {
      const result = await f.managerOffline(body, crypto.randomUUID(), 103, 'api', { ...f.env, HYPERDRIVE_MANAGER: binding });
      expect(result.body.status).toBe(503);
    }
    expect(await managerRows()).toEqual([]); expect(await facts()).toEqual(before);
  });
  it('live manager role loss denies new route payment while the old UUID remains readable', async () => {
    const paid = await f.paid('manager'), unpaid = await f.unpaid(), next = await f.managerInput(unpaid.order.id);
    await f.maintenanceDb.update(systemStoreStaff).set({ status: 0, isManager: 0 }).where(eq(systemStoreStaff.uid, 103));
    const before = await facts();
    expect((await f.managerOffline(next)).body).toMatchObject({ status: 200, data: { receipt: { actor_uid: 103, kind: 'confirm_offline', outcome: 'rollback-rejected' } } });
    expect(await facts()).toEqual(before);
    expect((await f.request('/store/manager/order/operation/' + paid.key + '/status', undefined, 103, 'api')).body).toMatchObject({ status: 200, data: { receipt: { request_key: paid.key, outcome: 'offline-paid' } } });
    expect((await managerRows()).filter(row => row.outcome === 'offline-paid')).toHaveLength(1);
  });
  const badManager = ['missing', 'hash', 'intent-payload', 'intent-version', 'revision', 'event-id', 'staff', 'duplicate'] as const;
  it.each(badManager)('rejects actual manager source contradiction %s before new customer business effects', async mutation => {
    const source = await f.paid('manager', 0), body = await creation(source.order.id);
    const key = source.key;
    if (mutation === 'missing') await f.maintenanceDb.execute(sql`DELETE FROM public.manager_order_operation_request WHERE request_key=${key}::uuid`);
    if (mutation === 'hash') await f.maintenanceDb.execute(sql`UPDATE public.manager_order_operation_request SET request_hash=${'a'.repeat(64)} WHERE request_key=${key}::uuid`);
    if (mutation === 'intent-payload') await f.maintenanceDb.execute(sql`UPDATE public.manager_order_operation_request SET intent=jsonb_set(intent,'{payload}','{"extra":true}'::jsonb) WHERE request_key=${key}::uuid`);
    if (mutation === 'intent-version') await f.maintenanceDb.execute(sql`UPDATE public.manager_order_operation_request SET intent=jsonb_set(intent,'{version}','"unknown-v9"'::jsonb) WHERE request_key=${key}::uuid`);
    if (mutation === 'revision') await f.maintenanceDb.execute(sql`UPDATE public.manager_order_operation_request SET expected_revision=${'b'.repeat(64)} WHERE request_key=${key}::uuid`);
    if (mutation === 'event-id') await f.maintenanceDb.execute(sql`UPDATE public.manager_order_operation_request SET evidence=jsonb_set(evidence,'{outbox_id}',to_jsonb(${source.event.id + 100}::integer)) WHERE request_key=${key}::uuid`);
    if (mutation === 'staff') await f.maintenanceDb.execute(sql`UPDATE public.manager_order_operation_request SET staff_id=0 WHERE request_key=${key}::uuid`);
    if (mutation === 'duplicate') await f.maintenanceDb.execute(sql`INSERT INTO public.manager_order_operation_request SELECT actor_uid,${crypto.randomUUID()}::uuid,request_hash,store_id,staff_id,order_id,kind,outcome,scope_key,expected_revision,intent,evidence,created_at FROM public.manager_order_operation_request WHERE request_key=${key}::uuid`);
    await rejectedWithoutWrites(() => service().create(context(), body)); expect(await manual()).toEqual([]);
  });
  const badPayments = origins.flatMap(producer => ['primary-message', 'missing-primary', 'missing-consumer', 'consumer-time', 'event-payload', 'event-aggregate', 'pending-event'].map(mutation => ({ producer, mutation })));
  it.each(badPayments)('rejects $producer payment contradiction $mutation without PHP downgrade', async ({ producer, mutation }) => {
    const source = await f.paid(producer, 0), body = await creation(source.order.id), primary = producer === 'manager' ? 'manager_order_offline' : 'admin_order_offline';
    if (mutation === 'primary-message') await f.maintenanceDb.update(storeOrderStatus).set({ changeMessage: '用户付款成功' }).where(sql`${storeOrderStatus.oid}=${source.order.id} AND ${storeOrderStatus.changeType}=${primary}`);
    if (mutation === 'missing-primary') await f.maintenanceDb.delete(storeOrderStatus).where(sql`${storeOrderStatus.oid}=${source.order.id} AND ${storeOrderStatus.changeType}=${primary}`);
    if (mutation === 'missing-consumer') await f.maintenanceDb.delete(storeOrderStatus).where(sql`${storeOrderStatus.oid}=${source.order.id} AND ${storeOrderStatus.changeType}='pay_success'`);
    if (mutation === 'consumer-time') await f.maintenanceDb.update(storeOrderStatus).set({ changeTime: source.order.payTime - 1 }).where(sql`${storeOrderStatus.oid}=${source.order.id} AND ${storeOrderStatus.changeType}='pay_success'`);
    if (mutation === 'event-payload') await f.maintenanceDb.update(storeOrderOutbox).set({ payload: { orderId: source.order.id, orderNo: source.order.orderId + '-wrong' } }).where(eq(storeOrderOutbox.id, source.event.id));
    if (mutation === 'event-aggregate') await f.maintenanceDb.update(storeOrderOutbox).set({ aggregateId: source.order.id + 100 }).where(eq(storeOrderOutbox.id, source.event.id));
    if (mutation === 'pending-event') await f.maintenanceDb.update(storeOrderOutbox).set({ status: 'PENDING' }).where(eq(storeOrderOutbox.id, source.event.id));
    await rejectedWithoutWrites(() => service().create(context(), body)); expect(await manual()).toEqual([]);
  });
  it.each(origins)('completed %s proof becomes UNKNOWN when its frozen source is changed', async producer => {
    const source = await f.paid(producer, 0), done = await execute((await create(source.order.id)).id);
    expect(done.result.execution?.completed).toBe(true);
    if (producer === 'manager') await f.maintenanceDb.execute(sql`UPDATE public.manager_order_operation_request SET created_at=created_at+interval '1 microsecond' WHERE request_key=${source.key}::uuid`);
    else await f.maintenanceDb.update(storeOrderStatus).set({ changeMessage: '管理员 2 确认订单线下收款' }).where(sql`${storeOrderStatus.oid}=${source.order.id} AND ${storeOrderStatus.changeType}='admin_order_offline'`);
    const before = await facts(), status = await service().status(f.actor(), done.ctx.request_key);
    expect(status.execution).toMatchObject({ status: 'UNKNOWN', completed: false, verified: false }); expect(await facts()).toEqual(before);
  });
  const aclMutations = ['select', 'table-insert', 'column-insert', 'set-writer', 'admin-writer', 'inherited-admin-writer'] as const;
  it.each(aclMutations)('manager source gate rejects actual %s authority before actions/writes', async mutation => {
    const source = await f.paid('manager', 0), body = await creation(source.order.id);
    const writer = 'offline_writer_' + crypto.randomUUID().replaceAll('-', ''), intermediary = 'offline_inherit_' + crypto.randomUUID().replaceAll('-', '');
    const role = '"' + f.role + '"', w = '"' + writer + '"', a = '"' + intermediary + '"';
    let createdWriter = false, createdIntermediary = false;
    try {
      if (mutation === 'select') await f.exec(`REVOKE SELECT ON public.manager_order_operation_request FROM ${role}`);
      if (mutation === 'table-insert') await f.exec(`GRANT INSERT ON public.manager_order_operation_request TO ${role}`);
      if (mutation === 'column-insert') await f.exec(`GRANT INSERT(actor_uid) ON public.manager_order_operation_request TO ${role}`);
      if (mutation.endsWith('writer')) {
        await f.exec(`CREATE ROLE ${w} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;GRANT INSERT ON public.manager_order_operation_request TO ${w}`); createdWriter = true;
        if (mutation === 'set-writer') await f.exec(`GRANT ${w} TO ${role} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`);
        if (mutation === 'admin-writer') await f.exec(`GRANT ${w} TO ${role} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`);
        if (mutation === 'inherited-admin-writer') {
          await f.exec(`CREATE ROLE ${a} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`); createdIntermediary = true;
          await f.exec(`GRANT ${w} TO ${a} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;GRANT ${a} TO ${role} WITH ADMIN FALSE, INHERIT TRUE, SET FALSE`);
        }
      }
      expect((await customerManualManagerOriginReadiness(f.db)).ready).toBe(false);
      const read = (await service().reader.order(f.actor(), source.order.id, { order_no: source.order.orderId })).data;
      expect(read.actions.refund_create.available).toBe(false);
      await rejectedWithoutWrites(() => service().create(context(), body)); expect(await manual()).toEqual([]);
      if (mutation === 'admin-writer' || mutation === 'inherited-admin-writer') {
        const [before] = await f.db.execute(sql`SELECT has_table_privilege(current_user,'public.manager_order_operation_request','INSERT') AS table_insert,has_any_column_privilege(current_user,'public.manager_order_operation_request','INSERT') AS column_insert,pg_has_role(current_user,${writer},'SET') AS can_set`);
        expect(before).toEqual({ table_insert: false, column_insert: false, can_set: false });
        await f.db.execute(sql.raw(`GRANT ${w} TO ${role} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`));
        const [after] = await f.db.execute(sql`SELECT pg_has_role(current_user,${writer},'SET') AS can_set`); expect(after.can_set).toBe(true);
      }
    } finally {
      // The real ADMIN counterexample issued a derived grant. Remove only
      // these fixture-owned membership chains, including their dependent
      // privileges, before restoring the reviewed customer reader profile.
      if (createdIntermediary) { await f.exec(`REVOKE ${w} FROM ${a} CASCADE;REVOKE ${a} FROM ${role} CASCADE;DROP OWNED BY ${a};DROP ROLE ${a}`); }
      if (createdWriter) { await f.exec(`REVOKE ${w} FROM ${role} CASCADE;DROP OWNED BY ${w};DROP ROLE ${w}`); }
      await f.exec(`REVOKE INSERT ON public.manager_order_operation_request FROM ${role};REVOKE INSERT(actor_uid) ON public.manager_order_operation_request FROM ${role}`);
      await runCustomerManualManagerOriginRead(f.maintenanceDb, f.role);
    }
    expect((await customerManualManagerOriginReadiness(f.db)).ready).toBe(true);
    expect((await execute((await create(source.order.id)).id)).result.execution).toMatchObject({ status: 'CASH_SUCCESS', verified: true });
  });
  it('Admin and published cashier origins remain available when manager SELECT is absent', async () => {
    const adminSource = await f.paid('admin', 0), cashierSource = await f.cashier(0);
    await f.exec(`REVOKE SELECT ON public.manager_order_operation_request FROM "${f.role}"`);
    try {
      expect((await customerManualManagerOriginReadiness(f.db)).ready).toBe(false);
      for (const source of [adminSource, cashierSource]) expect((await execute((await create(source.order.id)).id)).result.execution).toMatchObject({ status: 'CASH_SUCCESS', verified: true });
      const proofs = await manual(); expect(proofs).toHaveLength(2);
      const oldSource = proofs[1].source as { payment: Record<string, unknown> }; expect(oldSource.payment).not.toHaveProperty('payment_origin');
    } finally { await runCustomerManualManagerOriginRead(f.maintenanceDb, f.role); }
  });
});
