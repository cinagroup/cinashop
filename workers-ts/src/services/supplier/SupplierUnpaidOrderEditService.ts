import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { storeOrder, storeOrderCartInfo, storeOrderRefund, storeOrderStatus, storeOrderOutbox } from '@/models/schema';
import { assertSupplierOrderPriceRevisionReady } from '@/migrations/supplierOrderPriceRevision';
import { assertSupplierOrderEditOperationReadable } from '@/migrations/supplierOrderEditOperation';
import { computeAdminOrderPrice } from '@/services/admin/AdminMobileOrderOperationService';
import { lockOrderSettlement } from '@/services/order/OrderBrokerageService';
import { hasInitiatedAssistedProviderPayment } from '@/services/payment/AssistedProviderPaymentClaim';
import { planUnpaidOrderGainIntegralEdit } from '@/services/order/UnpaidOrderGainIntegralEdit';
import { assertUnpaidOrderCashierEditSource } from '@/services/order/UnpaidOrderCashierSource';
import { loadUnpaidOrderGainIntegralProof } from '@/services/order/UnpaidOrderGainIntegralProof';
import { assertOrderPromotionLedger } from '@/services/order/OrderPromotionLedgerSplit';
import { assertSupplierVideoAuthority, type SupplierVideoActor } from './SupplierVideoAuthority';
import { prepareSupplierOrderEdit, supplierOrderEditCanonical, supplierOrderEditConflict, supplierOrderEditId,
  supplierOrderEditMac, supplierOrderEditOperationId, assertSupplierOrderEditRevision, supplierOrderEditMoney } from './SupplierUnpaidOrderEditInput';
import { appendSupplierOrderEditOperation, lockSupplierOrderEditOperation, readSupplierOrderEditOperation,
  replaySupplierOrderEditOperation, supplierOrderEditReceipt, unknownSupplierOrderEdit, type SupplierOrderEditReceipt } from './SupplierUnpaidOrderEditOperation';
import { enqueueSupplierOrderPriceRevision, parseSupplierOrderPriceRevisionPayload, SUPPLIER_ORDER_PRICE_REVISION_EVENT } from './SupplierUnpaidOrderEditEffects';
import { HttpApiException, NotFoundException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { emitOperationalEvent } from '@/utils/observability';

type Order = typeof storeOrder.$inferSelect;
type Cart = typeof storeOrderCartInfo.$inferSelect;
type State = { order: Order; carts: Cart[]; editStatusId: number | null };
function failed(error: unknown): never {
  let cause = error;
  for (let depth = 0; depth < 8 && cause && typeof cause === 'object'; depth++) {
    const code = 'code' in cause ? String(cause.code) : '';
    if (['55P03', '40P01', '40001'].includes(code)) throw Object.assign(new HttpApiException('订单或权限正在变化，请核对原操作', 409, 409), { cause: error });
    if (['42501', '57014', '42P01', '42703', '23514'].includes(code)) throw Object.assign(new ServiceUnavailableException('订单编辑运行权限或维护协议尚未就绪'), { cause: error });
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  throw error;
}
async function clock(tx: DbClient): Promise<number> {
  const [row] = await tx.execute(sql`SELECT floor(extract(epoch FROM clock_timestamp()))::integer AS now`);
  if (!row || !Number.isSafeInteger(row.now) || Number(row.now) <= 0) throw new ServiceUnavailableException('订单编辑时钟无效');
  return Number(row.now);
}
async function readState(tx: DbClient, id: number, actor: SupplierVideoActor, lock = false): Promise<State> {
  let query = tx.select().from(storeOrder).where(and(eq(storeOrder.id, id), eq(storeOrder.supplierId, actor.supplierId),
    sql`octet_length(to_jsonb(${storeOrder})::text) <= 262144`)).limit(1);
  const [order] = await (lock ? query.for('update') : query);
  if (!order) throw new NotFoundException('订单不存在、不属于当前供应商或快照过大');
  const rows = tx.select().from(storeOrderCartInfo).where(and(eq(storeOrderCartInfo.oid, id),
    sql`COALESCE(octet_length(${storeOrderCartInfo.cartInfo}),0) <= 65536`)).orderBy(asc(storeOrderCartInfo.id)).limit(201);
  const carts = await (lock ? rows.for('update') : rows);
  const [count] = await tx.select({ n: sql<number>`count(*)::integer` }).from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, id));
  if (!carts.length || carts.length > 200 || carts.length !== count.n
    || carts.reduce((total, row) => total + new TextEncoder().encode(row.cartInfo ?? '').length, 0) > 8_388_608)
    throw new ValidateException('订单商品快照不完整或过大');
  const legacy = carts.every(row => row.type === 0 && row.relationId === 0);
  if (carts.some(row => row.uid !== order.uid || (!legacy && (row.type !== 2 || row.relationId !== actor.supplierId))))
    throw new ValidateException('订单商品供应商归属不一致');
  const [edit] = await tx.select({ id: storeOrderStatus.id }).from(storeOrderStatus)
    .where(and(eq(storeOrderStatus.oid, id), eq(storeOrderStatus.changeType, 'order_edit'))).orderBy(desc(storeOrderStatus.id)).limit(1);
  return { order, carts, editStatusId: edit?.id ?? null };
}
async function previousEditOperation(tx: DbClient, state: State, outboxes: readonly (typeof storeOrderOutbox.$inferSelect)[]): Promise<string | null> {
  if (state.editStatusId === null) return null;
  // Existing aggregate index bounds this history; the mutable outbox locates
  // a UUID only. The immutable receipt supplies all authority.
  const event = [...outboxes].reverse().find(row => row.eventType === SUPPLIER_ORDER_PRICE_REVISION_EVENT);
  if (!event) return null;
  const payload = parseSupplierOrderPriceRevisionPayload(event.payload);
  if (payload.orderId !== state.order.id || event.eventKey !== `${SUPPLIER_ORDER_PRICE_REVISION_EVENT}:${state.order.id}:${payload.operationId}`)
    throw supplierOrderEditConflict('订单编辑历史引用不一致');
  const [row] = await tx.execute(sql`SELECT operation_id::text, order_id, supplier_id, state, evidence
    FROM public.supplier_order_edit_operation_v1 WHERE operation_id=${payload.operationId}::uuid`);
  if (!row || row.state !== 'committed') throw supplierOrderEditConflict('订单编辑历史回执缺失');
  const evidence = row.evidence as Record<string, unknown> | null;
  const source = evidence?.source as Record<string, unknown> | undefined;
  if (row.order_id !== state.order.id || row.supplier_id !== state.order.supplierId || source?.order_id !== state.order.id
    || source.buyer_id !== state.order.uid || source.supplier_id !== state.order.supplierId)
    throw supplierOrderEditConflict('订单编辑历史归属不一致');
  return evidence!.status_id === state.editStatusId ? supplierOrderEditOperationId(row.operation_id) : null;
}
async function eligible(tx: DbClient, state: State, write = false): Promise<void> {
  const { order, carts } = state;
  if (order.paid !== 0 || order.status !== 0 || order.pid !== 0 || order.isDel !== 0 || order.isSystemDel !== 0
    || ![0, 2].includes(order.supplierAllocationStatus) || order.refundStatus !== 0 || order.refundType !== 0
    || supplierOrderEditMoney(order.refundPrice) !== '0.00' || supplierOrderEditMoney(order.backIntegral) !== '0.00'
    || !/^[A-Za-z0-9]{1,32}$/.test(order.orderId) || order.orderId === '0'
    || carts.some(row => row.refundNum !== 0 || row.splitStatus !== 0 || row.splitSurplusNum !== row.cartNum
      || row.surplusNum !== row.cartNum || row.isWriteoff !== 0))
    throw new ValidateException('订单已支付、取消、拆分或状态不允许修改');
  const child = await tx.select({ id: storeOrder.id }).from(storeOrder).where(eq(storeOrder.pid, order.id)).limit(1);
  const refund = await tx.select({ id: storeOrderRefund.id }).from(storeOrderRefund).where(eq(storeOrderRefund.storeOrderId, order.id)).limit(1);
  if (child.length || refund.length) throw new ValidateException('订单已有拆分或售后记录，请先核对');
  if (await hasInitiatedAssistedProviderPayment(tx, order.orderId)) throw new ValidateException('支付已发起，修改金额前请先完成对账');
  await assertOrderPromotionLedger(tx, order, carts, !write);
}
export class SupplierUnpaidOrderEditService {
  constructor(private readonly container: Container, private readonly appKey: string,
    private readonly effects?: { dispatch(outboxId: number): Promise<void> }) {}
  private async transaction<T>(actor: SupplierVideoActor, write: boolean, capability: string | null, run: (tx: DbClient) => Promise<T>): Promise<T> {
    try { return await withTx(this.container, async tx => {
      await tx.execute(sql.raw(write ? 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED' : 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY'));
      await tx.execute(sql`SELECT set_config('lock_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000)::text || 'ms',true),
        set_config('statement_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true)`);
      if (write) await tx.execute(sql`LOCK TABLE ONLY public.system_admin, ONLY public.system_supplier, ONLY public.system_role, ONLY public.system_menus IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
      await assertSupplierVideoAuthority(tx, actor, capability);
      const result = await run(tx);
      await assertSupplierVideoAuthority(tx, actor, capability);
      return result;
    }); } catch (error) { return failed(error); }
  }
  async seed(id: number, actor: SupplierVideoActor) {
    supplierOrderEditId(id);
    return this.transaction(actor, false, 'supplier.order.view', async tx => {
      await assertSupplierOrderEditOperationReadable(tx); await assertSupplierOrderPriceRevisionReady(tx);
      const state = await readState(tx, id, actor); await eligible(tx, state);
      await assertUnpaidOrderCashierEditSource(tx, state.order, state.carts);
      const proof = await loadUnpaidOrderGainIntegralProof(tx, state.order, state.carts);
      await planUnpaidOrderGainIntegralEdit(state.order, state.carts, { operationId: randomUUID(), gainIntegral: Number(state.order.gainIntegral) }, proof);
      const row = state.order;
      return { title: '修改订单', action: `/order/update/${id}`, method: 'PUT' as const,
        revision: supplierOrderEditMac(this.appKey, 'revision', { state, actorId: actor.id, supplierId: actor.supplierId, authVersion: actor.authVersion }),
        values: { order_id: row.orderId, total_price: row.totalPrice, total_postage: row.totalPostage,
          pay_postage: row.payPostage, pay_price: row.payPrice, gain_integral: String(Number(row.gainIntegral)) },
        fields: [
          { field: 'order_id', label: '订单编号', type: 'input', value: row.orderId, disabled: true },
          { field: 'total_price', label: '商品总价', type: 'number', value: row.totalPrice, min: 0, disabled: true },
          { field: 'total_postage', label: '原始邮费', type: 'number', value: row.totalPostage, min: 0, disabled: true },
          { field: 'pay_postage', label: '实际支付邮费', type: 'number', value: row.payPostage, disabled: true },
          { field: 'pay_price', label: '实际支付金额', type: 'number', value: row.payPrice, min: 0, precision: 2, required: true },
          { field: 'gain_integral', label: '赠送积分', type: 'number', value: String(Number(row.gainIntegral)), min: 0, precision: 0, required: true },
        ] };
    });
  }
  async save(id: number, body: unknown, actor: SupplierVideoActor): Promise<SupplierOrderEditReceipt> {
    const intent = prepareSupplierOrderEdit(id, body, actor, this.appKey);
    const done = await this.transaction(actor, true, 'supplier.order.manage', async tx => {
      const replay = await replaySupplierOrderEditOperation(tx, intent, actor);
      if (replay) return { receipt: replay, outboxId: null };
      await assertSupplierOrderPriceRevisionReady(tx);
      // NOWAIT physical barriers fence both present rows and absent children,
      // cart/refund rows and payment evidence. The
      // separate runtime feature grants are never installed by this service.
      await tx.execute(sql`LOCK TABLE ONLY public.store_order, ONLY public.store_order_cart_info, ONLY public.store_order_refund,
        ONLY public.payment_reconciliation_case IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
      await lockOrderSettlement(tx, id);
      const state = await readState(tx, id, actor, true); await eligible(tx, state, true);
      await assertUnpaidOrderCashierEditSource(tx, state.order, state.carts);
      assertSupplierOrderEditRevision(intent.revision, supplierOrderEditMac(this.appKey, 'revision', { state, actorId: actor.id, supplierId: actor.supplierId, authVersion: actor.authVersion }));
      const order = state.order;
      if (order.orderId !== intent.orderNo || order.totalPrice !== intent.totalPrice || order.totalPostage !== intent.totalPostage || order.payPostage !== intent.payPostage)
        throw supplierOrderEditConflict('订单编号或只读金额与当前订单不一致');
      const price = computeAdminOrderPrice(order.payPrice, order.changePrice, Number(BigInt(intent.payPrice.replace('.', ''))));
      const proof = await loadUnpaidOrderGainIntegralProof(tx, order, state.carts);
      const plan = await planUnpaidOrderGainIntegralEdit(order, state.carts, { operationId: intent.operationId, gainIntegral: intent.gainIntegral }, proof);
      const changed = price.changed || order.gainIntegral !== plan.gainIntegral;
      const expectedOrder = changed ? { ...order, payPrice: price.payPrice, changePrice: price.changePrice, gainIntegral: plan.gainIntegral } : order;
      const expectedCarts = state.carts.map(row => ({ ...row, cartInfo: plan.lines.find(line => line.rowId === row.id)!.afterCartInfo }));
      const statuses = await tx.select().from(storeOrderStatus).where(eq(storeOrderStatus.oid, id)).orderBy(asc(storeOrderStatus.id)).limit(1001);
      const outboxes = await tx.select().from(storeOrderOutbox).where(and(eq(storeOrderOutbox.aggregateType, 'order'), eq(storeOrderOutbox.aggregateId, id))).orderBy(asc(storeOrderOutbox.id)).limit(1001);
      if (statuses.length > 1000 || outboxes.length > 1000) throw new ValidateException('订单操作历史过长，请先核对');
      const previousOperationId = await previousEditOperation(tx, state, outboxes);
      let status: typeof storeOrderStatus.$inferSelect | undefined;
      let outbox: typeof storeOrderOutbox.$inferSelect | undefined;
      if (changed) {
        for (const line of plan.lines) if (line.afterCartInfo !== line.beforeCartInfo) {
          const saved = await tx.update(storeOrderCartInfo).set({ cartInfo: line.afterCartInfo }).where(and(eq(storeOrderCartInfo.id, line.rowId),
            eq(storeOrderCartInfo.oid, id), eq(storeOrderCartInfo.cartInfo, line.beforeCartInfo))).returning();
          if (saved.length !== 1 || supplierOrderEditCanonical(saved[0]) !== supplierOrderEditCanonical(expectedCarts.find(row => row.id === line.rowId)))
            throw supplierOrderEditConflict('订单积分行完整写入不一致');
        }
        const saved = await tx.update(storeOrder).set({ payPrice: price.payPrice, changePrice: price.changePrice, gainIntegral: plan.gainIntegral })
          .where(and(eq(storeOrder.id, id), eq(storeOrder.paid, 0), eq(storeOrder.payPrice, order.payPrice), eq(storeOrder.gainIntegral, order.gainIntegral))).returning();
        if (saved.length !== 1 || supplierOrderEditCanonical(saved[0]) !== supplierOrderEditCanonical(expectedOrder)) throw supplierOrderEditConflict('订单编辑完整写入不一致');
        const now = await clock(tx);
        const expected = { oid: id, changeType: 'order_edit', changeMessage: `商品总价为：${order.payPrice} 修改实际支付金额为：${price.payPrice}`, changeTime: now };
        [status] = await tx.insert(storeOrderStatus).values(expected).returning();
        if (!status || supplierOrderEditCanonical(status) !== supplierOrderEditCanonical({ id: status.id, ...expected })) throw supplierOrderEditConflict('订单改价记录不完整');
        outbox = await enqueueSupplierOrderPriceRevision(tx, { orderId: id, operationId: intent.operationId }, now);
      }
      const expectedState = { order: expectedOrder, carts: expectedCarts, editStatusId: status?.id ?? state.editStatusId };
      const receipt = await appendSupplierOrderEditOperation(tx, { operationId: intent.operationId, orderId: id, actor, now: await clock(tx), requestHash: intent.requestHash,
        beforeHash: supplierOrderEditMac(this.appKey, 'state', state), afterHash: supplierOrderEditMac(this.appKey, 'state', expectedState), evidence: { ...plan.evidence, status_id: status?.id ?? null, before_status_id: state.editStatusId,
          previous_operation_id: previousOperationId, before_cash: { pay_price: order.payPrice, change_price: order.changePrice } },
        result: { id, order_id: order.orderId, pay_price: price.payPrice, change_price: price.changePrice, gain_integral: plan.gainIntegral, changed } });
      // Flush deferred feature/business guards before the final exact proof;
      // audit/outbox tables retain their existing SELECT/INSERT-only grants.
      await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
      const finalState = await readState(tx, id, actor);
      await assertUnpaidOrderCashierEditSource(tx, finalState.order, finalState.carts);
      if (supplierOrderEditCanonical(finalState) !== supplierOrderEditCanonical(expectedState)
        || supplierOrderEditCanonical(await tx.select().from(storeOrderStatus).where(eq(storeOrderStatus.oid, id)).orderBy(asc(storeOrderStatus.id))) !== supplierOrderEditCanonical([...statuses, ...(status ? [status] : [])])
        || supplierOrderEditCanonical(await tx.select().from(storeOrderOutbox).where(and(eq(storeOrderOutbox.aggregateType, 'order'), eq(storeOrderOutbox.aggregateId, id))).orderBy(asc(storeOrderOutbox.id))) !== supplierOrderEditCanonical([...outboxes, ...(outbox ? [outbox] : [])]))
        throw supplierOrderEditConflict('订单、积分、记录或通知最终完整证明不一致');
      await eligible(tx, expectedState, true);
      return { receipt, outboxId: outbox?.id ?? null };
    });
    if (this.effects && done.outboxId !== null) try { await this.effects.dispatch(done.outboxId); }
    catch { emitOperationalEvent('error', { event: 'supplier_order_edit_effects_dispatch_failed', component: 'queue', outcome: 'retry', operation: 'order_edit', errorCode: 'dispatch_pending' }); }
    return done.receipt;
  }
  async receipt(operationId: string, actor: SupplierVideoActor): Promise<SupplierOrderEditReceipt> {
    supplierOrderEditOperationId(operationId);
    return this.transaction(actor, false, null, async tx => {
      const row = await readSupplierOrderEditOperation(tx, operationId, actor);
      return row ? supplierOrderEditReceipt(row) : unknownSupplierOrderEdit(operationId, actor);
    });
  }
  async resolve(operationId: string, orderId: number, actor: SupplierVideoActor): Promise<SupplierOrderEditReceipt> {
    supplierOrderEditOperationId(operationId); supplierOrderEditId(orderId);
    return this.transaction(actor, true, null, async tx => {
      await lockSupplierOrderEditOperation(tx, operationId);
      const row = await readSupplierOrderEditOperation(tx, operationId, actor);
      if (row) {
        if (row.order_id !== orderId) throw supplierOrderEditConflict('订单与原操作不一致');
        return supplierOrderEditReceipt(row);
      }
      return appendSupplierOrderEditOperation(tx, { operationId, orderId, actor, now: await clock(tx), requestHash: '', beforeHash: '', afterHash: '', evidence: null, result: null });
    });
  }
}
