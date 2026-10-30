import { randomUUID } from 'node:crypto';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { storeOrder, storeOrderCartInfo, storeOrderOutbox, storeOrderRefund, storeOrderStatus,
  systemConfig, user, userBill, userBrokerage, supplierFlowingWater, supplierTransactions } from '../src/models/schema';
import { CustomerWorkFinancialService } from '../src/services/customer-work/CustomerWorkFinancialService';
import { CUSTOMER_FINANCIAL_VERSION, type FinancialContext, type FinancialInput } from '../src/services/customer-work/CustomerWorkFinancialProtocol';
import { financialRevisions } from '../src/services/customer-work/CustomerWorkFinancialReadService';
import { authorizeCustomerWorkActor } from '../src/services/customer-work/CustomerWorkScope';
import { applyOrderRefund } from '../src/services/order/StoreOrderRefundService';
import type { CustomerJson } from '../src/services/customer-work/CustomerWorkOperationRequest';
import { ValidateException } from '../src/utils/errors';
import { customerWorkFinancialFixture } from './helpers/customerWorkFinancialFixture';

// Owned native PG16 only. Actual installer, independent local LOGIN, refund
// core and notification enqueue all run. The two negative cases use real SQL
// BEFORE INSERT triggers; no notification or SQL result is mocked.
describe.sequential('routine notification pin and strict customer refusal evidence on owned PG16', () => {
  let f: Awaited<ReturnType<typeof customerWorkFinancialFixture>>, service: CustomerWorkFinancialService;
  const APP = 'wx-owned-refusal-pin', OTHER = 'wx-owned-refusal-later';
  const reason = '核对原申请后的实际拒绝';
  beforeAll(async () => {
    if (!process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Owned native PG16 required');
    f = await customerWorkFinancialFixture();
  }, 180000);
  afterAll(async () => { await f?.close(); }, 30000);
  beforeEach(async () => {
    await f.reset();
    service = f.service();
    await f.maintenanceDb.delete(systemConfig).where(eq(systemConfig.menuName, 'routine_appId'));
    await f.maintenanceDb.insert(systemConfig).values({ menuName: 'routine_appId', value: APP });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No provider HTTP in notification compatibility fixture'));
  });
  afterEach(() => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); } });
  const ctx = (): FinancialContext => ({ actor: f.actor(), request_key: randomUUID() });
  const order = async () => (await f.db.select().from(storeOrder).where(eq(storeOrder.id, 1)))[0];
  const refund = async (id: number) => (await f.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.id, id)))[0];
  const ledger = () => f.db.execute(sql`SELECT actor_uid,request_key,kind,outcome,evidence
    FROM public.customer_financial_operation_request ORDER BY actor_uid,request_key`);
  async function input(payload: CustomerJson): Promise<FinancialInput> {
    const actual = await order(), scope = await authorizeCustomerWorkActor(f.db, f.actor()), revisions = await financialRevisions(f.db, actual);
    return { version: CUSTOMER_FINANCIAL_VERSION, scope_key: scope.scope_key, order_id: actual.id,
      expected_order_revision: revisions.order_revision, expected_financial_revision: revisions.financial_revision, payload };
  }
  async function application(applyType: 1 | 2) {
    const actual = await order(), cart = (await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.id, 1)))[0];
    return (await applyOrderRefund(f.container, { uid: 11, orderId: actual.orderId, applyType,
      applicationOrderId: 'N' + randomUUID().replaceAll('-', '').slice(0, 30), refundReason: '真实原申请',
      refundExplain: '保持旧类型及数量合同', cartSelections: [{ cartId: Number(cart.cartId), cartNum: 1 }] }, 0)).refundId;
  }
  async function decision(id: number, kind: 'refund_return' | 'refund_refuse') {
    const actual = await refund(id), review = (await service.reader.review(f.actor(), id, { refund_no: actual.orderId })).data;
    return input({ refund_id: id, refund_no: review.refund_no, expected_refund_revision: review.refund_revision,
      review_fingerprint: review.review_fingerprint, decision: { apply_type: review.apply_type, refund_type: review.refund_type, received: false },
      ...(kind === 'refund_refuse' ? { reason } : {}) });
  }
  const money = async () => ({ users: await f.db.select().from(user).orderBy(asc(user.uid)),
    bills: await f.db.select().from(userBill).orderBy(asc(userBill.id)), brokerages: await f.db.select().from(userBrokerage).orderBy(asc(userBrokerage.id)),
    supplierFlows: await f.db.select().from(supplierFlowingWater).orderBy(asc(supplierFlowingWater.id)),
    supplierTransactions: await f.db.select().from(supplierTransactions).orderBy(asc(supplierTransactions.id)) });
  const business = async () => ({ ...await money(), orders: await f.db.select().from(storeOrder).orderBy(asc(storeOrder.id)),
    carts: await f.db.select().from(storeOrderCartInfo).orderBy(asc(storeOrderCartInfo.id)),
    refunds: await f.db.select().from(storeOrderRefund).orderBy(asc(storeOrderRefund.id)),
    statuses: await f.db.select().from(storeOrderStatus).orderBy(asc(storeOrderStatus.id)),
    outbox: await f.db.select().from(storeOrderOutbox).orderBy(asc(storeOrderOutbox.id)) });

  it('commits actual approval/refusal, releases quantity, pins one notice and replays the unchanged original receipt after account rotation', async () => {
    const beforeMoney = await money(), id = await application(2);
    expect((await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.id, 1)))[0].refundNum).toBe(1);
    expect((await service.execute('refund_return', ctx(), await decision(id, 'refund_return'))).receipt?.outcome).toBe('return-approved');
    const context = ctx(), body = await decision(id, 'refund_refuse'), result = await service.execute('refund_refuse', context, body);
    expect(result.receipt).toMatchObject({ actor_uid: 101, service_id: 1, order_id: 1, kind: 'refund_refuse', outcome: 'refused', evidence: { refund_id: id, verified: true } });
    expect(await refund(id)).toMatchObject({ uid: 11, storeOrderId: 1, applyType: 2, refundType: 3, refuseReason: reason, refundedPrice: '0.00' });
    expect(await order()).toMatchObject({ uid: 11, orderId: 'customer-financial-1', payPrice: '10.00', paid: 1, payType: 'yue', refundStatus: 0, refundType: 3 });
    expect((await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.id, 1)))[0].refundNum).toBe(0);
    expect(await money()).toEqual(beforeMoney);
    const rows = await f.db.select().from(storeOrderOutbox);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ eventKey: 'order.refund.refused.notice:' + id, aggregateType: 'order', aggregateId: 1, eventType: 'order.refund.refused.notice' });
    expect(rows[0].payload).toEqual({ orderId: 1, orderNo: 'customer-financial-1', refundId: id, userId: 11, payPrice: '10.00', routineAppId: APP });
    const committed = await business(), receipts = await ledger();
    await f.maintenanceDb.update(systemConfig).set({ value: OTHER }).where(eq(systemConfig.menuName, 'routine_appId'));
    const replay = await service.execute('refund_refuse', context, body);
    expect(replay).toEqual({ ...result, replayed: true });
    expect(await service.status(f.actor(), context.request_key)).toEqual({ ...result, replayed: false });
    expect(await business()).toEqual(committed); expect(await ledger()).toEqual(receipts);
  });

  it.each(['payPrice', 'extra-field'] as const)('rolls the complete real refusal back when a real SQL trigger corrupts %s despite a valid account pin', async corruption => {
    const id = await application(1), context = ctx(), body = await decision(id, 'refund_refuse');
    const before = await business();
    // Observe the real domain error while still calling the actual receipt
    // method. No synthetic SQL, notification result or rollback is supplied.
    const errors: unknown[] = [], reject = service.ledger.reject.bind(service.ledger);
    vi.spyOn(service.ledger, 'reject').mockImplementation((prepared, error) => { errors.push(error); return reject(prepared, error); });
    const change = corruption === 'payPrice'
      ? `NEW.payload := pg_catalog.jsonb_set(NEW.payload,'{payPrice}','"99.99"'::jsonb,false);`
      : `NEW.payload := NEW.payload || '{"unreviewed_notice_field":true}'::jsonb;`;
    await f.exec(`CREATE FUNCTION public.owned_refusal_payload_drift() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
      SET search_path=pg_catalog AS $fixture$ BEGIN ${change} RETURN NEW; END; $fixture$;
      CREATE TRIGGER owned_refusal_payload_drift BEFORE INSERT ON public.store_order_outbox
      FOR EACH ROW WHEN (NEW.event_type='order.refund.refused.notice') EXECUTE FUNCTION public.owned_refusal_payload_drift()`);
    try {
      const result = await service.execute('refund_refuse', context, body);
      expect(result.receipt).toMatchObject({ actor_uid: 101, kind: 'refund_refuse', outcome: 'rollback-rejected' });
      expect(errors).toHaveLength(1); expect(errors[0]).toBeInstanceOf(ValidateException);
      expect(errors[0]).toMatchObject({ message: '实际支付或拒绝通知事件未完整持久化' });
      expect(await business()).toEqual(before);
      expect(await f.db.select().from(storeOrderOutbox)).toEqual([]);
      expect((await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.id, 1)))[0].refundNum).toBe(1);
      expect(await ledger()).toHaveLength(1);
      expect(await service.execute('refund_refuse', context, body)).toEqual({ ...result, replayed: true });
      expect(await business()).toEqual(before); expect(await ledger()).toHaveLength(1);
    } finally {
      await f.exec('DROP TRIGGER owned_refusal_payload_drift ON public.store_order_outbox; DROP FUNCTION public.owned_refusal_payload_drift()');
    }
  });
});
