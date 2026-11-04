/** PHP order.writeoff -> reminder_verification_status. This author has only
 * SMS/inbox effects; it does not consult or stage any WeChat account. */
import { createHash } from 'node:crypto';
import { asc, desc, eq, inArray } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeOrder, storeOrderWriteoff, storeProduct, storeOrderOutbox,
  systemNotification, systemMessage } from '@/models/schema';
import { WRITEOFF_NOTICE_EVENT } from '@/migrations/writeoffNotice';
import { createImmutableDelivery, type OrderNotificationOutboxEvent } from './OrderNotificationOutboxService';

import { captureWriteoffRecordIds, captureWriteoffNoticePayload, writeoffNoticeEventKey, writeoffNoticeValues, WRITEOFF_NOTICE_MARK } from './OrderWriteoffNoticeCodec';
export { captureWriteoffNoticePayload, writeoffNoticeEventKey, writeoffNoticeValues, WRITEOFF_NOTICE_MARK, MAX_WRITEOFF_NOTICE_RECORDS } from './OrderWriteoffNoticeCodec';

type RecordRow = typeof storeOrderWriteoff.$inferSelect;
function digest(rows: RecordRow[]): string {
  // Explicit tuples keep identity/order deterministic, without copying the
  // previous verify code or operator facts into the event's public payload.
  return createHash('sha256').update(JSON.stringify(rows.map(r => [r.id, r.uid, r.oid, r.orderCartId, r.type, r.relationId,
    r.staffId, r.productId, r.productType, r.writeoffNum, r.writeoffPrice, r.writeoffCode, r.isAdmin, r.adminId, r.addTime]))).digest('hex');
}
async function records(tx: DbClient, recordIds: number[], orderId: number, uid: number, now: number) {
  const rows = await tx.select().from(storeOrderWriteoff).where(inArray(storeOrderWriteoff.id, recordIds)).orderBy(asc(storeOrderWriteoff.id));
  if (rows.length !== recordIds.length || rows.some((r, i) => r.id !== recordIds[i] || r.oid !== orderId || r.uid !== uid || r.addTime !== now
    || !Number.isSafeInteger(r.orderCartId) || r.orderCartId < 1 || !Number.isSafeInteger(r.productId) || r.productId < 0 || !Number.isSafeInteger(r.writeoffNum) || r.writeoffNum < 1) || new Set(rows.map(r => r.orderCartId)).size !== rows.length)
    throw Error('核销通知与实际批次记录不一致');
  return rows;
}
/** Call only after the actual records/status/settlement writes, in that same
 * transaction. A batch is identified by its first generated record ID, never
 * by order ID or second; later partial batches remain independent. */
export async function enqueueOrderWriteoffNoticeTx(tx: DbClient, input: {
  order: Pick<typeof storeOrder.$inferSelect, 'id' | 'orderId' | 'uid' | 'userPhone'>;
  recordIds: number[]; explicitSelection: boolean; now: number;
}) {
  if (Object.hasOwn(tx, '$client')) throw Error('核销通知必须与实际核销共享事务');
  const recordIds = captureWriteoffRecordIds(input.recordIds), source = await records(tx, recordIds, input.order.id, input.order.uid, input.now);
  let storeName = '';
  if (input.explicitSelection) {
    const products = await tx.select({ id: storeProduct.id, name: storeProduct.storeName }).from(storeProduct)
      .where(inArray(storeProduct.id, [...new Set(source.map(r => r.productId))]));
    const names = new Map(products.map(p => [p.id, p.name]));
    // Match the cart/record order, including repeated product IDs. The PHP
    // listener intentionally renders an empty title for an all-items request.
    storeName = source.map(r => Array.from(names.get(r.productId) ?? '').slice(0, 10).join('')).join(' ');
  }
  const payload = captureWriteoffNoticePayload({ format: 1, orderId: input.order.id, orderNo: input.order.orderId,
    userId: input.order.uid, occurredAt: input.now, recordIds, recordsDigest: digest(source),
    selection: input.explicitSelection ? 'explicit' : 'all', phone: input.order.userPhone.trim(), storeName });
  const eventKey = writeoffNoticeEventKey(recordIds[0]);
  const [inserted] = await tx.insert(storeOrderOutbox).values({ eventKey, aggregateType: 'order', aggregateId: payload.orderId,
    eventType: WRITEOFF_NOTICE_EVENT, payload, status: 'PENDING', availableTime: input.now, addTime: input.now, updateTime: input.now })
    .onConflictDoNothing({ target: storeOrderOutbox.eventKey }).returning();
  const persisted = inserted ?? (await tx.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventKey, eventKey)).limit(1))[0];
  // RETURNING is the actual row, including BEFORE-trigger changes. Do not let
  // a local write/identity failure commit the writeoff without its real intent.
  if (!persisted || !Number.isSafeInteger(persisted.id) || persisted.id < 1 || persisted.eventKey !== eventKey
    || persisted.aggregateType !== 'order' || persisted.aggregateId !== payload.orderId || persisted.eventType !== WRITEOFF_NOTICE_EVENT
    || persisted.addTime !== input.now || JSON.stringify(captureWriteoffNoticePayload(persisted.payload)) !== JSON.stringify(payload))
    throw Error('核销通知批次不可变字段冲突');
  return { id: persisted.id, eventKey };
}
function render(template: string, values: Record<string, string>): string {
  for (const [key, value] of Object.entries(values)) template = template.replaceAll(`{${key}}`, () => value);
  return template;
}
export type WriteoffNoticeInboxGap = 'inbox_title_too_long';
/** An event is a notification occurrence, so later writeoff batches and product
 * edits do not rewrite it. Recheck its recorded batch, not today's remaining
 * quantity/current verify code. These public rows are not provider authority. */
export async function processOrderWriteoffNoticeTx(tx: DbClient, event: OrderNotificationOutboxEvent & { aggregateType?: string }, _now: number): Promise<WriteoffNoticeInboxGap | undefined> {
  const payload = captureWriteoffNoticePayload(event.payload);
  if (event.aggregateType !== 'order' || event.eventType !== WRITEOFF_NOTICE_EVENT || event.aggregateId !== payload.orderId || event.eventKey !== writeoffNoticeEventKey(payload.recordIds[0])
    || event.addTime !== payload.occurredAt) throw Error('核销通知事件身份不一致');
  const [order] = await tx.select({ id: storeOrder.id, no: storeOrder.orderId, uid: storeOrder.uid }).from(storeOrder).where(eq(storeOrder.id, payload.orderId)).limit(1);
  if (!order || order.no !== payload.orderNo || order.uid !== payload.userId
    || digest(await records(tx, payload.recordIds, payload.orderId, payload.userId, payload.occurredAt)) !== payload.recordsDigest)
    throw Error('核销通知实际批次来源发生变化');
  const templates = await tx.select({ isSms: systemNotification.isSms, isSystem: systemNotification.isSystem,
    smsId: systemNotification.smsId, title: systemNotification.systemTitle, content: systemNotification.systemText })
    .from(systemNotification).where(eq(systemNotification.mark, WRITEOFF_NOTICE_MARK)).orderBy(desc(systemNotification.id)).limit(2);
  if (templates.length > 1) throw Error('核销成功通知模板存在重复来源');
  const config = templates[0];
  if (!config) return;
  const values = writeoffNoticeValues(payload);
  // The logical PHP REMINDER_VERIFICATION_STATUS resolves to this mark's
  // configured sms_id. WeChat switches are deliberately irrelevant here.
  if (config.isSms === 1 && payload.phone) await createImmutableDelivery(tx, {
    event, payload, mark: WRITEOFF_NOTICE_MARK, channel: 'sms', target: payload.phone, templateCode: config.smsId.trim(),
    deliveryPayload: { kind: 'sms', params: values }, skipReason: !config.smsId.trim() ? 'template_not_configured' : undefined, now: payload.occurredAt,
  });
  if (config.isSystem !== 1 || payload.userId === 0) return;
  const title = render(config.title, values), content = render(config.content, values);
  // PHP dispatches SMS independently and catches inbox persistence failures.
  // Reject this known capacity gap without withdrawing the valid SMS intent.
  // Unknown SQL errors and immutable identity conflicts still abort normally.
  if (Array.from(title).length > 256) return 'inbox_title_too_long';
  const [inserted] = await tx.insert(systemMessage).values({ eventKey: event.eventKey, mark: WRITEOFF_NOTICE_MARK,
    title, content, userId: payload.userId, look: 0, type: 1, status: 1, addTime: payload.occurredAt, isDel: 0 })
    .onConflictDoNothing({ target: systemMessage.eventKey }).returning({ id: systemMessage.id });
  if (inserted) return;
  const [prior] = await tx.select().from(systemMessage).where(eq(systemMessage.eventKey, event.eventKey)).limit(1);
  if (!prior || prior.mark !== WRITEOFF_NOTICE_MARK || prior.userId !== payload.userId || prior.title !== title || prior.content !== content
    || prior.addTime !== payload.occurredAt || prior.type !== 1) throw Error('核销通知站内消息不可变字段冲突');
}
