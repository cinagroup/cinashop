import { and, desc, eq, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeOrder, storeOrderOutbox, storeOrderStatus, systemMessage, systemNotification, type StoreOrderOutbox } from '@/models/schema';
import { assertSupplierOrderPriceRevisionReady } from '@/migrations/supplierOrderPriceRevision';
import { assertSupplierOrderEditOperationReadable } from '@/migrations/supplierOrderEditOperation';
import { createImmutableDelivery } from '@/services/order/OrderNotificationOutboxService';
import type { SupplierOrderEditResult } from './SupplierUnpaidOrderEditOperation';
import { supplierOrderEditCanonical, supplierOrderEditId, supplierOrderEditOperationId } from './SupplierUnpaidOrderEditInput';

export const SUPPLIER_ORDER_PRICE_REVISION_EVENT = 'order.price.revision';
export interface SupplierOrderPriceRevisionPayload { orderId: number; operationId: string }
export function parseSupplierOrderPriceRevisionPayload(value: unknown): SupplierOrderPriceRevisionPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2)
    throw Error('Order price revision payload invalid');
  const row = value as Record<string, unknown>;
  return { orderId: supplierOrderEditId(row.orderId), operationId: supplierOrderEditOperationId(row.operationId) };
}
/** Reference-only intent, committed atomically with the immutable edit proof.
 * Delivery resolves the actual protected operation and current order again. */
export async function enqueueSupplierOrderPriceRevision(tx: DbClient, value: SupplierOrderPriceRevisionPayload, now: number): Promise<StoreOrderOutbox> {
  await assertSupplierOrderPriceRevisionReady(tx);
  const payload = parseSupplierOrderPriceRevisionPayload(value);
  const expected = { eventKey: `${SUPPLIER_ORDER_PRICE_REVISION_EVENT}:${payload.orderId}:${payload.operationId}`,
    aggregateType: 'order', aggregateId: payload.orderId, eventType: SUPPLIER_ORDER_PRICE_REVISION_EVENT,
    payload, status: 'PENDING', dispatchCount: 0, attemptCount: 0, replayCount: 0, availableTime: now,
    leaseUntil: 0, leaseToken: '', lastError: '', enqueuedTime: 0, processedTime: 0, addTime: now, updateTime: now };
  const [saved] = await tx.insert(storeOrderOutbox).values(expected).returning();
  const matches = (row: StoreOrderOutbox | undefined) => !!row && Number.isSafeInteger(row.id) && row.id > 0
    && supplierOrderEditCanonical(row) === supplierOrderEditCanonical({ id: row.id, ...expected });
  if (!matches(saved)) throw Error('Order price revision outbox full receipt inconsistent');
  const [readback] = await tx.select().from(storeOrderOutbox).where(and(eq(storeOrderOutbox.id, saved.id), eq(storeOrderOutbox.eventKey, expected.eventKey))).limit(1);
  if (!matches(readback)) throw Error('Order price revision outbox full readback inconsistent');
  return saved;
}

async function noticeSource(tx: DbClient, event: StoreOrderOutbox) {
  const payload = parseSupplierOrderPriceRevisionPayload(event.payload);
  if (event.eventType !== SUPPLIER_ORDER_PRICE_REVISION_EVENT || event.aggregateType !== 'order' || event.aggregateId !== payload.orderId
    || event.eventKey !== `${SUPPLIER_ORDER_PRICE_REVISION_EVENT}:${payload.orderId}:${payload.operationId}`) throw Error('Order price revision event identity invalid');
  await assertSupplierOrderEditOperationReadable(tx);
  const [operation] = await tx.execute(sql`SELECT order_id, supplier_id, state, result, evidence FROM public.supplier_order_edit_operation_v1
    WHERE operation_id = ${payload.operationId}::uuid`) as unknown as Array<{ order_id: number; supplier_id: number; state: string; result: SupplierOrderEditResult | null; evidence: { status_id?: unknown; version?: unknown; operation_id?: unknown; source?: { order_id?: unknown; supplier_id?: unknown; buyer_id?: unknown } } | null }>;
  if (!operation || operation.state !== 'committed' || operation.order_id !== payload.orderId || !operation.result
    || operation.result.id !== payload.orderId || operation.result.changed !== true) throw Error('Order price revision protected operation missing');
  if (operation.evidence?.version !== 'supplier-unpaid-gain-edit-v1' || operation.evidence.operation_id !== payload.operationId
    || operation.evidence.source?.order_id !== payload.orderId || operation.evidence.source.supplier_id !== operation.supplier_id
    || !Number.isSafeInteger(operation.evidence.status_id) || Number(operation.evidence?.status_id) <= 0)
    throw Error('Order price revision protected status missing');
  const [edit] = await tx.select({ id: storeOrderStatus.id }).from(storeOrderStatus)
    .where(and(eq(storeOrderStatus.oid, payload.orderId), eq(storeOrderStatus.changeType, 'order_edit'))).orderBy(desc(storeOrderStatus.id)).limit(1);
  if (edit?.id !== operation.evidence!.status_id) return null;
  const [order] = await tx.select().from(storeOrder).where(eq(storeOrder.id, payload.orderId)).limit(1);
  if (!order || order.uid !== operation.evidence!.source!.buyer_id || order.supplierId !== operation.supplier_id || order.orderId !== operation.result.order_id
    || order.payPrice !== operation.result.pay_price || order.changePrice !== operation.result.change_price
    || order.gainIntegral !== operation.result.gain_integral || order.paid !== 0 || order.status !== 0 || order.pid !== 0
    || order.isDel !== 0 || order.isSystemDel !== 0 || order.refundStatus !== 0) return null;
  return { order, result: operation.result };
}
/** Rechecked before an external provider claim as well as when staging. A
 * later edit/payment/cancellation must not send an obsolete payment request. */
export async function supplierOrderPriceRevisionIsActive(tx: DbClient, eventKey: string): Promise<boolean> {
  if (!eventKey.startsWith(SUPPLIER_ORDER_PRICE_REVISION_EVENT + ':')) return true;
  const [event] = await tx.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventKey, eventKey)).limit(1);
  return !!event && !!await noticeSource(tx, event);
}
/** PHP NoticeService::priceRevision sends SMS and the user's inbox only. The
 * similarly named old WeChat helper has no consumer in that actual listener. */
export async function processSupplierOrderPriceRevision(tx: DbClient, event: StoreOrderOutbox, now: number): Promise<void> {
  const source = await noticeSource(tx, event); if (!source) return;
  const { order, result } = source;
  const templates = await tx.select().from(systemNotification).where(eq(systemNotification.mark, 'price_revision')).orderBy(desc(systemNotification.id)).limit(2);
  if (templates.length > 1) throw Error('Order price revision notification configuration duplicated');
  const config = templates[0]; if (!config) return;
  const values = { order_id: order.orderId, pay_price: result.pay_price };
  if (config.isSms === 1) {
    const target = order.userPhone.trim(), templateCode = config.smsId.trim();
    await createImmutableDelivery(tx, { event, payload: { orderId: order.id, userId: order.uid }, mark: 'price_revision', channel: 'sms', target, templateCode,
      deliveryPayload: { kind: 'sms', params: values }, now,
      skipReason: !target ? 'target_not_configured' : !templateCode ? 'template_not_configured' : undefined });
  }
  // A guest has an order phone but no UID0 inbox identity.
  if (config.isSystem !== 1 || order.uid === 0) return;
  const render = (text: string) => Object.entries(values).reduce((value, [key, replacement]) => value.replaceAll(`{${key}}`, replacement), text);
  const title = render(config.systemTitle), content = render(config.systemText);
  if ([...title].length > 256 || new TextEncoder().encode(content).length > 65536) throw Error('Order price revision message exceeds limits');
  const [inserted] = await tx.insert(systemMessage).values({ eventKey: event.eventKey, mark: 'price_revision', title, content,
    userId: order.uid, look: 0, type: 1, status: 1, addTime: now, isDel: 0 }).onConflictDoNothing({ target: systemMessage.eventKey }).returning({ id: systemMessage.id });
  if (inserted) return;
  const [existing] = await tx.select().from(systemMessage).where(eq(systemMessage.eventKey, event.eventKey)).limit(1);
  if (!existing || existing.mark !== 'price_revision' || existing.userId !== order.uid || existing.title !== title || existing.content !== content)
    throw Error('Order price revision inbox immutable identity conflict');
}
