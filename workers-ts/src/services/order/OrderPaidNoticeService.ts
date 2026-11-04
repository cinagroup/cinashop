/** PHP Pay -> ShareOrder -> splitAfter -> order_pay_success. Each fulfillment
 * order owns one occurrence; the split audit root is never a buyer notice. */
import { and, asc, desc, eq, or, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeOrder, storeOrderCartInfo, storeOrderOutbox, systemNotification, systemMessage, wechatUser,
  type OrderPaidNoticeOutboxPayload } from '@/models/schema';
import { PAID_NOTICE_EVENT } from '@/migrations/paidNotice';
import { createRoutineSubscriptionPaidRequestTx } from '@/services/wechat/RoutineSubscriptionPaidRequest';
import { subscriptionSame } from '@/services/wechat/RoutineSubscriptionAccount';
import { stageRoutineSubscriptionNoticeTx, type RoutineSubscriptionNoticeEnvironment } from '@/services/wechat/RoutineSubscriptionNoticeAuthor';
import { captureOrderPaidSourcePayload, capturePaidNoticeAdmission, capturePaidNoticeBusiness, paidNoticeBusinessFromPayload, paidNoticeEventKey, paidNoticeDate } from './OrderPaidNoticeCodec';
import { amountToCents } from '@/services/payment/RefundGateway';
import { configuredTemplate, createImmutableDelivery, type OrderNotificationOutboxEvent } from './OrderNotificationOutboxService';
import type { SupplierAllocationResult } from './OrderSupplierAllocationService';

export const PAID_NOTICE_MARK = 'order_pay_success';
/** A completed supplier split has already run the distributor upgrade before
 * allocation. A duplicate may acknowledge only its complete admitted notice
 * batch, without borrowing the separate presale/refund recovery capability. */
export async function completedPaidSupplierNoticeReplayTx(tx: DbClient, eventId: number,
  rootId: number, expectedPayload: unknown): Promise<boolean> {
  const [event] = await tx.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id, eventId))
    .limit(1).for('share', { noWait: true });
  if (!event || event.status !== 'COMPLETED' || event.eventType !== 'order.paid' || event.aggregateType !== 'order'
    || event.aggregateId !== rootId || event.eventKey !== `order.paid:${rootId}` || !subscriptionSame(event.payload, expectedPayload)) return false;
  const source = captureOrderPaidSourcePayload(event.payload), admission = source.payNoticeAdmission;
  if (!admission || source.orderId !== rootId) return false;
  const family = await tx.select().from(storeOrder).where(or(eq(storeOrder.id, rootId), eq(storeOrder.pid, rootId)))
    .orderBy(asc(storeOrder.id)).limit(66).for('share', { noWait: true });
  if (family.length < 3 || family.length > 65 || new TextEncoder().encode(JSON.stringify(family)).byteLength > 1048576) return false;
  const root = family.find(row => row.id === rootId), leaves = family.filter(row => row.pid === rootId);
  if (!root || root.pid !== -1 || root.type === 6 || root.orderId !== source.orderNo || leaves.length !== family.length - 1
    || new Set(family.map(row => row.orderId)).size !== family.length
    || family.some(row => row.paid !== 1 || row.uid !== root.uid || row.payType !== root.payType || row.payTime !== root.payTime
      || row.tradeNo !== root.tradeNo || row.supplierAllocationStatus !== 2 || row.isDel !== 0 || row.isSystemDel !== 0
      || row.refundStatus !== 0 || row.refundType !== 0)) return false;
  const total = amountToCents(root.payPrice), amounts = leaves.map(row => amountToCents(row.payPrice));
  if (total === null || amounts.some(value => value === null || value < 0)
    || amounts.reduce<number>((sum, value) => sum + (value ?? 0), 0) !== total
    || leaves.reduce((sum, row) => sum + row.totalNum, 0) !== root.totalNum) return false;
  const batch = await tx.select().from(storeOrderOutbox).where(or(
    and(eq(storeOrderOutbox.eventType, PAID_NOTICE_EVENT), sql`${storeOrderOutbox.payload}->>'paymentEventId'=${String(event.id)}`),
    eq(storeOrderOutbox.eventKey, paidNoticeEventKey(root.id)),
    and(eq(storeOrderOutbox.eventType, PAID_NOTICE_EVENT), eq(storeOrderOutbox.aggregateId, root.id)))).orderBy(asc(storeOrderOutbox.id))
    .limit(66).for('share', { noWait: true });
  if (batch.length !== leaves.length || new TextEncoder().encode(JSON.stringify(batch)).byteLength > 1048576
    || new Set(batch.map(row => row.aggregateId)).size !== batch.length) return false;
  for (const notice of batch) {
    if (notice.eventType !== PAID_NOTICE_EVENT) return false;
    const p = paidNoticeBusinessFromPayload(notice.payload), child = leaves.find(row => row.id === p.orderId);
    if (!child || notice.aggregateType !== 'order' || notice.aggregateId !== child.id || notice.eventKey !== paidNoticeEventKey(child.id)
      || notice.addTime !== p.occurredAt || p.occurredAt < event.addTime || p.paymentEventId !== event.id
      || p.paymentOrderId !== root.id || p.paymentOrderNo !== root.orderId || p.paymentAdmissionNonce !== admission.nonce
      || p.orderNo !== child.orderId || p.userId !== root.uid || p.payPrice !== child.payPrice || p.totalNum !== child.totalNum
      || p.payTime !== root.payTime) return false;
  }
  return true;
}
function productName(snapshot: string | null): string {
  if (!snapshot || new TextEncoder().encode(snapshot).byteLength > 262144) throw Error('付款通知商品快照无效');
  const value: unknown = JSON.parse(snapshot);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('付款通知商品快照无效');
  const row = value as Record<string, unknown>, p = row.product ?? row.productInfo;
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw Error('付款通知商品快照无效');
  const product = p as Record<string, unknown>, name = product.storeName ?? product.store_name;
  if (typeof name !== 'string') throw Error('付款通知商品名称无效');
  return name;
}
/** Called only for a newly admitted paid event after actual allocation, in the
 * same transaction as the complete paid effects. No historical backfill. */
export async function enqueuePaidBuyerNoticesTx(tx: DbClient, event: OrderNotificationOutboxEvent,
  allocation: SupplierAllocationResult, env: Readonly<{ APP_KEY?: string }>, now: number): Promise<void> {
  if (Object.hasOwn(tx, '$client')) throw Error('付款通知必须与实际分配共享事务');
  if (!Object.hasOwn(event.payload, 'payNoticeAdmission')) return;
  const source = event.payload as { orderId: number; orderNo: string; payNoticeAdmission: unknown };
  const admission = capturePaidNoticeAdmission(source.payNoticeAdmission), root = allocation.paymentOrder;
  if (event.eventType !== 'order.paid' || event.eventKey !== `order.paid:${root.id}` || event.aggregateId !== root.id
    || source.orderId !== root.id || source.orderNo !== root.orderId || root.paid !== 1
    || !allocation.fulfillmentOrders.length || new Set(allocation.fulfillmentOrders.map(o => o.id)).size !== allocation.fulfillmentOrders.length)
    throw Error('付款通知实际付款来源不一致');
  for (const order of allocation.fulfillmentOrders) {
    if (order.paid !== 1 || order.uid !== root.uid || (allocation.split ? order.pid !== root.id || order.id === root.id : order.id !== root.id || order.pid !== 0))
      throw Error('付款通知履约家族不一致');
    const key = paidNoticeEventKey(order.id);
    const [prior] = await tx.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventKey, key)).limit(1);
    if (prior) {
      const p = paidNoticeBusinessFromPayload(prior.payload);
      if (prior.eventType !== PAID_NOTICE_EVENT || prior.aggregateType !== 'order' || prior.aggregateId !== order.id
        || p.paymentEventId !== event.id || p.paymentOrderId !== root.id || p.paymentOrderNo !== root.orderId
        || p.paymentAdmissionNonce !== admission.nonce || p.orderId !== order.id || p.orderNo !== order.orderId || p.userId !== order.uid)
        throw Error('付款通知历史不可变字段冲突');
      continue;
    }
    const carts = await tx.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, order.id)).orderBy(asc(storeOrderCartInfo.id));
    if (!carts.length || carts.length > 500 || carts.some(c => c.uid !== order.uid)) throw Error('付款通知商品来源无效');
    const body = capturePaidNoticeBusiness({ format: 1, paymentEventId: event.id, paymentOrderId: root.id, paymentOrderNo: root.orderId,
      paymentAdmissionNonce: admission.nonce, orderId: order.id, orderNo: order.orderId, userId: order.uid,
      payPrice: order.payPrice, totalNum: order.totalNum, phone: order.userPhone.trim(),
      storeName: Array.from(carts.map(c => productName(c.cartInfo)).join('|')).slice(0, 20).join(''), sendName: order.realName,
      payTime: order.payTime, occurredAt: now });
    const candidate = await createRoutineSubscriptionPaidRequestTx(tx, env, { eventKey: key, aggregateId: order.id, payload: body, now });
    const payload: OrderPaidNoticeOutboxPayload = { ...body, routineSubscriptionRequest: candidate.request };
    const [inserted] = await tx.insert(storeOrderOutbox).values({ eventKey: key, aggregateType: 'order', aggregateId: order.id,
      eventType: PAID_NOTICE_EVENT, payload, status: 'PENDING', availableTime: now, addTime: now, updateTime: now })
      .onConflictDoNothing({ target: storeOrderOutbox.eventKey }).returning();
    if (!inserted || inserted.eventKey !== key || inserted.eventType !== PAID_NOTICE_EVENT || inserted.aggregateType !== 'order'
      || inserted.aggregateId !== order.id || inserted.addTime !== now || !subscriptionSame(inserted.payload, payload))
      throw Error('付款通知批次不可变字段冲突');
  }
}
function render(template: string, values: Record<string, string>): string {
  for (const [key, value] of Object.entries(values)) template = template.replaceAll(`{${key}}`, () => value);
  return template;
}
export async function processPaidBuyerNoticeTx(tx: DbClient, event: OrderNotificationOutboxEvent, _now: number,
  routine: { env: Readonly<RoutineSubscriptionNoticeEnvironment>; earlyReady: boolean }): Promise<{
    deferred: boolean; gap?: 'inbox_title_too_long' }> {
  const p = paidNoticeBusinessFromPayload(event.payload);
  if (event.eventType !== PAID_NOTICE_EVENT || event.aggregateId !== p.orderId || event.eventKey !== paidNoticeEventKey(p.orderId)
    || event.addTime !== p.occurredAt) throw Error('付款通知事件身份不一致');
  const [source] = await tx.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id, p.paymentEventId)).limit(1);
  if (!source || source.eventType !== 'order.paid' || source.eventKey !== `order.paid:${p.paymentOrderId}`
    || source.aggregateType !== 'order' || source.aggregateId !== p.paymentOrderId || source.status !== 'COMPLETED'
    || !('payNoticeAdmission' in source.payload) || capturePaidNoticeAdmission(source.payload.payNoticeAdmission).nonce !== p.paymentAdmissionNonce
    || !('orderNo' in source.payload) || source.payload.orderNo !== p.paymentOrderNo) throw Error('付款通知原付款事件不一致');
  const [order] = await tx.select().from(storeOrder).where(eq(storeOrder.id, p.orderId)).limit(1);
  if (!order || order.uid !== p.userId || order.orderId !== p.orderNo) throw Error('付款通知买家身份发生变化');
  const templates = await tx.select().from(systemNotification).where(eq(systemNotification.mark, PAID_NOTICE_MARK)).orderBy(desc(systemNotification.id)).limit(2);
  if (templates.length > 1) throw Error('付款成功通知模板存在重复来源');
  const config = templates[0]; if (!config) return { deferred: false };
  const values = { order_id: p.orderNo, total_num: String(p.totalNum), pay_price: p.payPrice };
  if (config.isSms === 1 && p.phone) await createImmutableDelivery(tx, { event, payload: p, mark: PAID_NOTICE_MARK, channel: 'sms',
    target: p.phone, templateCode: config.smsId.trim(), deliveryPayload: { kind: 'sms', params: { order_id: p.orderNo, pay_price: p.payPrice } },
    skipReason: !config.smsId.trim() ? 'template_not_configured' : undefined, now: p.occurredAt });
  if (config.isWechat === 1 && p.userId > 0) {
    const identities = await tx.select().from(wechatUser).where(and(eq(wechatUser.uid, p.userId), eq(wechatUser.userType, 'wechat'), eq(wechatUser.isDel, 0)))
      .orderBy(desc(wechatUser.id)).limit(65);
    if (identities.length > 64) throw Error('付款通知公众号身份容量超限');
    const target = identities.find(row => row.openid.trim())?.openid.trim() ?? '', templateCode = await configuredTemplate(tx, '43216', 1);
    await createImmutableDelivery(tx, { event, payload: p, mark: PAID_NOTICE_MARK, channel: 'wechat_official', target, templateCode,
      deliveryPayload: { kind: 'wechat_official', data: { character_string2: p.orderNo, thing3: p.storeName, amount5: p.payPrice,
        phrase18: p.sendName, time4: paidNoticeDate(p.payTime) }, url: '/pages/goods/order_details/index?order_id=' + p.orderNo },
      skipReason: !target ? 'target_not_configured' : !templateCode ? 'template_not_configured' : undefined, now: p.occurredAt });
  }
  const deferred = config.isRoutine === 1 && p.userId > 0
    ? await stageRoutineSubscriptionNoticeTx(tx, routine.env, event, PAID_NOTICE_MARK, routine.earlyReady, p.occurredAt) === 'deferred' : false;
  if (config.isSystem !== 1 || p.userId === 0) return { deferred };
  const [prior] = await tx.select().from(systemMessage).where(eq(systemMessage.eventKey, event.eventKey)).limit(1);
  if (prior) {
    if (prior.userId !== p.userId || prior.mark !== PAID_NOTICE_MARK) throw Error('付款通知站内消息不可变字段冲突');
    return { deferred };
  }
  const title = render(config.systemTitle, values), content = render(config.systemText, values);
  if (Array.from(title).length > 256) return { deferred, gap: 'inbox_title_too_long' };
  const [inserted] = await tx.insert(systemMessage).values({ eventKey: event.eventKey, mark: PAID_NOTICE_MARK, title, content,
    userId: p.userId, look: 0, type: 1, status: 1, addTime: p.occurredAt, isDel: 0 }).onConflictDoNothing({ target: systemMessage.eventKey }).returning({ id: systemMessage.id });
  if (!inserted) throw Error('付款通知站内消息写入冲突');
  return { deferred };
}
