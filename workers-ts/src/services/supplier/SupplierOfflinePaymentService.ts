import { and, asc, eq, sql } from 'drizzle-orm';
import { createContainerFromDb, withTx, type Container, type DbClient } from '@/lib/di';
import { storeOrder, storeOrderCartInfo, storeOrderRefund, storeOrderStatus, storeOrderOutbox, storeOrderInvoice, storePink, user, userBill } from '@/models/schema';
import { assertGuestRefundAccountless } from '@/services/order/CustomerManualRefund';
import { ORDER_PINK_SUCCESS_NOTICE_EVENT, assertOrderNotificationPayload } from '@/services/order/OrderNotificationOutboxService';
import { assertSupplierOfflinePaymentOperationReadable } from '@/migrations/supplierOfflinePaymentOperation';
import { lockOrderSettlement } from '@/services/order/OrderBrokerageService';
import { applyStoreOrderPayment, PayType } from '@/services/order/StoreOrderPayService';
import { assertPinkOrderPayable } from '@/services/activity/PinkLifecycleService';
import { hasInitiatedAssistedProviderPayment } from '@/services/payment/AssistedProviderPaymentClaim';
import { assertOrderPromotionLedger } from '@/services/order/OrderPromotionLedgerSplit';
import { loadUnpaidOrderGainIntegralProof } from '@/services/order/UnpaidOrderGainIntegralProof';
import { planUnpaidOrderGainIntegralEdit } from '@/services/order/UnpaidOrderGainIntegralEdit';
import { assertUnpaidOrderCashierEditSource } from '@/services/order/UnpaidOrderCashierSource';
import { assertSupplierVideoAuthority, type SupplierVideoActor } from './SupplierVideoAuthority';
import { prepareSupplierOfflinePayment, assertSupplierPaymentRevision, supplierPaymentCanonical, supplierPaymentConflict,
  supplierPaymentHash, supplierPaymentId, supplierPaymentOperationId, supplierPaymentRevision } from './SupplierOfflinePaymentInput';
import { appendSupplierOfflinePaymentOperation, readSupplierOfflinePaymentOperation, replaySupplierOfflinePaymentOperation,
  supplierOfflinePaymentReceipt, unknownSupplierOfflinePayment, lockSupplierOfflinePaymentOperation,
  type SupplierOfflinePaymentSource, type SupplierOfflinePaymentReceipt } from './SupplierOfflinePaymentOperation';
import { HttpApiException, NotFoundException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { emitOperationalEvent } from '@/utils/observability';

function failed(error: unknown): never {
  let cause = error;
  for (let depth = 0; depth < 8 && cause && typeof cause === 'object'; depth++) {
    const code = 'code' in cause ? String(cause.code) : '';
    if (['55P03', '40P01', '40001'].includes(code)) throw Object.assign(new HttpApiException('收款订单或权限正在变化，请核对原操作', 409, 409), { cause: error });
    if (['42501', '57014', '42P01', '42703', '23514'].includes(code)) throw Object.assign(new ServiceUnavailableException('供应商收款凭据或运行权限尚未就绪'), { cause: error });
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  throw error;
}
async function clock(tx: DbClient) {
  const [row] = await tx.execute(sql`SELECT floor(extract(epoch FROM clock_timestamp()))::integer AS now`);
  if (!row || !Number.isSafeInteger(row.now) || Number(row.now) <= 0) throw new ServiceUnavailableException('收款时钟无效');
  return Number(row.now);
}
async function source(tx: DbClient, id: number, actor: SupplierVideoActor, lock = false): Promise<SupplierOfflinePaymentSource> {
  const query = tx.select().from(storeOrder).where(and(eq(storeOrder.id, id), eq(storeOrder.supplierId, actor.supplierId),
    sql`octet_length(to_jsonb(${storeOrder})::text)<=262144`)).limit(1);
  const [order] = await (lock ? query.for('update') : query);
  if (!order) throw new NotFoundException('订单不存在或不属于当前供应商');
  const lines = tx.select().from(storeOrderCartInfo).where(and(eq(storeOrderCartInfo.oid, id),
    sql`COALESCE(octet_length(${storeOrderCartInfo.cartInfo}),0)<=65536`)).orderBy(asc(storeOrderCartInfo.id)).limit(201);
  const carts = await (lock ? lines.for('update') : lines);
  const [count] = await tx.select({ n: sql<number>`count(*)::integer` }).from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, id));
  // Zero owner columns belong only to original raw PHP purchases. A modern
  // checkout cannot become legacy by losing its SQL ownership; eligible()
  // subsequently verifies the complete historical financial projection.
  const legacy = carts.every(row => {
    if (row.type !== 0 || row.relationId !== 0) return false;
    try {
      const info = JSON.parse(row.cartInfo ?? '');
      return info && typeof info === 'object' && !Array.isArray(info) && !Object.hasOwn(info, 'financial_version')
        && info.productInfo && typeof info.productInfo === 'object' && !Array.isArray(info.productInfo)
        && info.productInfo.attrInfo && typeof info.productInfo.attrInfo === 'object' && !Array.isArray(info.productInfo.attrInfo);
    } catch { return false; }
  });
  if (!carts.length || carts.length > 200 || carts.length !== count.n || carts.some(row => row.uid !== order.uid
    || !legacy && (row.type !== 2 || row.relationId !== actor.supplierId))
    || carts.reduce((sum, row) => sum + new TextEncoder().encode(row.cartInfo ?? '').length, 0) > 8_388_608)
    throw new ValidateException('订单商品快照、数量或供应商归属不完整');
  const statuses = await tx.select().from(storeOrderStatus).where(eq(storeOrderStatus.oid, id)).orderBy(asc(storeOrderStatus.id)).limit(1001);
  const outboxes = await tx.select().from(storeOrderOutbox).where(and(eq(storeOrderOutbox.aggregateType, 'order'), eq(storeOrderOutbox.aggregateId, id))).orderBy(asc(storeOrderOutbox.id)).limit(1001);
  const result = { order, carts, statuses, outboxes };
  if (statuses.length > 1000 || outboxes.length > 1000 || new TextEncoder().encode(supplierPaymentCanonical(result)).length > 20_000_000)
    throw new ValidateException('收款完整来源过大，请先核对订单');
  return result;
}
async function eligible(tx: DbClient, state: SupplierOfflinePaymentSource, write = false) {
  const { order, carts } = state;
  if (order.paid !== 0 || order.payType !== 'offline' || order.pid !== 0 || order.status !== 0 || order.isDel !== 0 || order.isSystemDel !== 0
    || ![0, 2].includes(order.supplierAllocationStatus) || order.refundStatus !== 0 || order.refundType !== 0
    || Number(order.refundPrice) !== 0 || Number(order.backIntegral) !== 0 || order.tradeNo !== ''
    || !/^[A-Za-z0-9]{1,32}$/.test(order.orderId) || order.orderId === '0'
    || carts.some(row => row.refundNum !== 0 || row.splitStatus !== 0 || row.splitSurplusNum !== row.cartNum
      || row.surplusNum !== row.cartNum || row.isWriteoff !== 0)) throw new ValidateException('仅可确认当前供应商未支付、未拆分的线下订单');
  if ((await tx.select({ id: storeOrder.id }).from(storeOrder).where(eq(storeOrder.pid, order.id)).limit(1)).length
    || (await tx.select({ id: storeOrderRefund.id }).from(storeOrderRefund).where(eq(storeOrderRefund.storeOrderId, order.id)).limit(1)).length)
    throw new ValidateException('订单已有拆分或售后记录');
  if (await hasInitiatedAssistedProviderPayment(tx, order.orderId)) throw new ValidateException('支付已发起，请先核对原交易');
  if (state.outboxes.some(row => row.eventKey === `order.paid:${order.id}`)
    || state.statuses.some(row => ['supplier_order_offline', 'pay_success', 'manager_order_offline', 'admin_order_offline'].includes(row.changeType)))
    throw supplierPaymentConflict('订单已有付款记录，不能再次确认收款');
  await assertOrderPromotionLedger(tx, order, carts, !write);
  await assertUnpaidOrderCashierEditSource(tx, order, carts);
  const proof = await loadUnpaidOrderGainIntegralProof(tx, order, carts);
  await planUnpaidOrderGainIntegralEdit(order, carts, { operationId: crypto.randomUUID(), gainIntegral: Number(order.gainIntegral) }, proof);
  // The original order already selected offline at checkout. Marketing policy
  // belongs to that actual channel admission; a Supplier request cannot invent
  // from=pc, and confirming a policy-admitted PC order must remain possible.
  await assertPinkOrderPayable(tx, order);
}
export class SupplierOfflinePaymentService {
  constructor(private readonly container: Container, private readonly appKey: string,
    private readonly effects?: { dispatch(outboxId: number): Promise<void> }) {}
  private async transaction<T>(actor: SupplierVideoActor, write: boolean, run: (tx: DbClient) => Promise<T>): Promise<T> {
    try { return await withTx(this.container, async tx => {
      await tx.execute(sql.raw(write ? 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED' : 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY'));
      await tx.execute(sql`SELECT set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000)::text||'ms',true),
        set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true)`);
      if (write) await tx.execute(sql`LOCK TABLE ONLY public.system_admin, ONLY public.system_supplier, ONLY public.system_role, ONLY public.system_menus IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
      await assertSupplierVideoAuthority(tx, actor, null);
      const result = await run(tx);
      await assertSupplierVideoAuthority(tx, actor, null);
      return result;
    }); } catch (error) { return failed(error); }
  }
  async seed(id: number, actor: SupplierVideoActor) {
    supplierPaymentId(id);
    return this.transaction(actor, false, async tx => {
      await assertSupplierVideoAuthority(tx, actor, 'supplier.order.view'); await assertSupplierOfflinePaymentOperationReadable(tx);
      const state = await source(tx, id, actor); await eligible(tx, state);
      return { id, order_no: state.order.orderId, amount: state.order.payPrice, gain_integral: state.order.gainIntegral,
        cash_required: state.order.payPrice !== '0.00', revision: supplierPaymentRevision(this.appKey, actor, state) };
    });
  }
  async pay(id: number, body: unknown, actor: SupplierVideoActor): Promise<SupplierOfflinePaymentReceipt> {
    const intent = prepareSupplierOfflinePayment(id, body, actor);
    const done = await this.transaction(actor, true, async tx => {
      const replay = await replaySupplierOfflinePaymentOperation(tx, intent, actor);
      if (replay) return { receipt: replay, outboxId: null };
      await assertSupplierVideoAuthority(tx, actor, 'supplier.order.manage');
      await tx.execute(sql`LOCK TABLE ONLY public.store_order, ONLY public.store_order_cart_info, ONLY public.store_order_refund,
        ONLY public.payment_reconciliation_case IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
      await lockOrderSettlement(tx, id);
      const before = await source(tx, id, actor, true); await eligible(tx, before, true);
      assertSupplierPaymentRevision(intent.revision, supplierPaymentRevision(this.appKey, actor, before));
      if (intent.order_no !== before.order.orderId || intent.amount !== before.order.payPrice) throw supplierPaymentConflict('原订单或实际收款金额已变化');
      const now = await clock(tx), [buyer] = await tx.select().from(user).where(eq(user.uid, before.order.uid)).limit(1).for('update');
      if (before.order.uid === 0) await assertGuestRefundAccountless(tx, before.order);
      else if (!buyer || buyer.status !== 1 || buyer.isDel !== 0) throw new ValidateException('原买家账号不可用');
      const invoices = await tx.select().from(storeOrderInvoice).where(eq(storeOrderInvoice.orderId, id)).orderBy(asc(storeOrderInvoice.id)).for('update');
      const bills = await tx.select().from(userBill).where(and(eq(userBill.uid, before.order.uid), eq(userBill.linkId, String(id)))).orderBy(asc(userBill.id)).limit(1001);
      if (bills.length > 1000) throw new ValidateException('原订单积分台账过长');
      const audit = { changeType: 'supplier_order_offline', changeMessage: `供应商 ${actor.supplierId} / 管理员 ${actor.id} / 原请求 ${intent.operation_id} 确认实际线下收款` };
      const payment = await applyStoreOrderPayment(createContainerFromDb(tx), { orderId: id, payType: PayType.OFFLINE, now, audit,
        authorizeBeforePayment: async (db, order) => {
          await assertSupplierVideoAuthority(db, actor, 'supplier.order.manage');
          if (supplierPaymentCanonical(order) !== supplierPaymentCanonical(before.order)) throw supplierPaymentConflict('锁定付款来源不一致');
        } });
      if (payment.outcome !== 'paid' || !payment.outbox) throw supplierPaymentConflict('原订单未完成本次收款');
      const statuses = await tx.select().from(storeOrderStatus).where(eq(storeOrderStatus.oid, id)).orderBy(asc(storeOrderStatus.id));
      const primary = statuses.find(row => row.changeType === audit.changeType && row.changeMessage === audit.changeMessage && row.changeTime === now);
      if (!primary || supplierPaymentCanonical(statuses) !== supplierPaymentCanonical([...before.statuses, primary])) throw supplierPaymentConflict('原付款记录不完整');
      const [event] = await tx.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id, payment.outbox.id)).limit(1);
      if (!event || event.eventKey !== `order.paid:${id}` || event.eventType !== 'order.paid' || event.aggregateType !== 'order' || event.aggregateId !== id
        || event.status !== 'PENDING' || supplierPaymentCanonical(event.payload) !== supplierPaymentCanonical({ orderId: id, orderNo: before.order.orderId }))
        throw supplierPaymentConflict('原付款后置事件不完整');
      const expectedOrder = { ...before.order, paid: 1, payType: 'offline', payTime: now };
      if (before.order.type === 3) {
        const [paid] = await tx.select().from(storeOrder).where(eq(storeOrder.id, id)).limit(1);
        const members = await tx.select().from(storePink).where(and(eq(storePink.orderIdKey, String(id)), eq(storePink.orderId, intent.order_no))).limit(2);
        const member = members[0];
        if (!paid || members.length !== 1 || member.uid !== before.order.uid || member.combinationId !== before.order.activityId
          || member.totalPrice !== before.order.payPrice || member.totalNum !== before.order.totalNum || member.isRefund !== 0
          || member.isVirtual !== 0 || ![1, 2].includes(member.status) || paid.pinkId !== (member.kId || member.id))
          throw supplierPaymentConflict('实际拼团付款与成员凭据不一致');
        expectedOrder.pinkId = paid.pinkId;
      }
      const outboxes = await tx.select().from(storeOrderOutbox).where(and(eq(storeOrderOutbox.aggregateType, 'order'), eq(storeOrderOutbox.aggregateId, id))).orderBy(asc(storeOrderOutbox.id));
      const extra = outboxes.filter(row => row.id !== event.id && !before.outboxes.some(old => old.id === row.id));
      if (extra.length > 1 || extra.length && before.order.type !== 3) throw supplierPaymentConflict('实际付款后置事件多写');
      for (const notice of extra) {
        assertOrderNotificationPayload(notice.payload, ORDER_PINK_SUCCESS_NOTICE_EVENT, id);
        const payload = notice.payload as { pinkId: number; orderNo: string; userId: number; people: number };
        const [leader] = await tx.select().from(storePink).where(eq(storePink.id, expectedOrder.pinkId)).limit(1);
        if (!leader || leader.status !== 2 || leader.isRefund !== 0 || payload.pinkId !== leader.id || payload.people !== leader.people
          || payload.orderNo !== intent.order_no || payload.userId !== before.order.uid || notice.eventType !== ORDER_PINK_SUCCESS_NOTICE_EVENT
          || notice.eventKey !== `${ORDER_PINK_SUCCESS_NOTICE_EVENT}:${id}` || notice.status !== 'PENDING') throw supplierPaymentConflict('实际拼团成功通知不一致');
      }
      const expected = { order: expectedOrder, carts: before.carts, statuses,
        outboxes: [...before.outboxes, event, ...extra].sort((a, b) => a.id - b.id) };
      const receipt = await appendSupplierOfflinePaymentOperation(tx, { operation_id: intent.operation_id, actor_id: actor.id, supplier_id: actor.supplierId,
        order_id: id, request_hash: supplierPaymentHash(intent), state: 'committed', intent, source: before, source_hash: supplierPaymentHash(before),
        evidence: { primary_audit_id: primary.id, outbox_id: event.id }, result: { id, order_no: intent.order_no, paid: 1, pay_type: 'offline', pay_price: intent.amount, pay_time: now }, created_at: now });
      await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
      if (supplierPaymentCanonical(await source(tx, id, actor)) !== supplierPaymentCanonical(expected)) throw supplierPaymentConflict('付款完整最终证明不一致');
      const [afterBuyer] = await tx.select().from(user).where(eq(user.uid, before.order.uid)).limit(1);
      if (buyer && supplierPaymentCanonical(afterBuyer) !== supplierPaymentCanonical({ ...buyer, integral: buyer.integral - before.order.payIntegral }))
        throw supplierPaymentConflict('付款积分或买家资金最终证明不一致');
      if (before.order.uid === 0) await assertGuestRefundAccountless(tx, expectedOrder);
      const afterInvoices = await tx.select().from(storeOrderInvoice).where(eq(storeOrderInvoice.orderId, id)).orderBy(asc(storeOrderInvoice.id));
      if (supplierPaymentCanonical(afterInvoices) !== supplierPaymentCanonical(invoices.map(row => row.isDel === 0 ? { ...row, isPay: 1 } : row)))
        throw supplierPaymentConflict('付款发票最终证明不一致');
      const afterBills = await tx.select().from(userBill).where(and(eq(userBill.uid, before.order.uid), eq(userBill.linkId, String(id)))).orderBy(asc(userBill.id));
      const added = afterBills.filter(row => !bills.some(old => old.id === row.id));
      if (supplierPaymentCanonical(afterBills.filter(row => bills.some(old => old.id === row.id))) !== supplierPaymentCanonical(bills)
        || added.length !== (before.order.payIntegral > 0 ? 1 : 0)) throw supplierPaymentConflict('付款积分台账最终证明不一致');
      if (added.length) {
        const row = added[0], required = before.order.payIntegral;
        const expectedBill = { id: row.id, uid: before.order.uid, linkId: String(id), pm: 0, title: '积分兑换', category: 'integral', type: 'storeIntegral_use_integral',
          eventKey: 'order_pay_integral', number: String(required) + '.00', balance: String(buyer!.integral - required) + '.00', mark: `支付积分订单 ${before.order.orderId}`, status: 1, addTime: now,
          take: 0, frozenTime: 0 };
        if (supplierPaymentCanonical(row) !== supplierPaymentCanonical(expectedBill)) throw supplierPaymentConflict('实际付款积分记录不一致');
      }
      await assertSupplierVideoAuthority(tx, actor, 'supplier.order.manage');
      return { receipt, outboxId: event.id };
    });
    if (this.effects && done.outboxId !== null) try { await this.effects.dispatch(done.outboxId); }
    catch { emitOperationalEvent('error', { event: 'supplier_offline_payment_dispatch_failed', component: 'queue', outcome: 'retry', operation: 'supplier_offline_payment', errorCode: 'dispatch_pending' }); }
    return done.receipt;
  }
  async receipt(id: string, actor: SupplierVideoActor) {
    supplierPaymentOperationId(id);
    return this.transaction(actor, false, async tx => {
      const row = await readSupplierOfflinePaymentOperation(tx, id, actor);
      return row ? supplierOfflinePaymentReceipt(row) : unknownSupplierOfflinePayment(id, actor);
    });
  }
  async resolve(id: string, orderId: number, actor: SupplierVideoActor) {
    supplierPaymentOperationId(id); supplierPaymentId(orderId);
    return this.transaction(actor, true, async tx => {
      await lockSupplierOfflinePaymentOperation(tx, id);
      const row = await readSupplierOfflinePaymentOperation(tx, id, actor);
      if (row) {
        if (row.order_id !== orderId) throw supplierPaymentConflict('原收款订单不一致');
        return supplierOfflinePaymentReceipt(row);
      }
      return appendSupplierOfflinePaymentOperation(tx, { operation_id: id, actor_id: actor.id, supplier_id: actor.supplierId,
        order_id: orderId, request_hash: '', state: 'not_applied', intent: null, source: null, source_hash: '', evidence: null, result: null, created_at: await clock(tx) });
    });
  }
}
