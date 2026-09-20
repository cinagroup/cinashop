import { refundReview, type AdminRefundDetail } from './refundDetail';

export type RefundAction = 'refund' | 'return' | 'refuse';
export interface RefundIntent {
  version: 2; nonce: string; actorId: number; refundId: number; action: RefundAction;
  review: ReturnType<typeof refundReview>; applyType: number; initialStatus: number;
  reason: string; received: boolean; createdAt: number; phase: 'pending' | 'resolved';
}
const integer = (value: unknown, min = 1): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= 2147483647;
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('待核对操作记录损坏，请人工核对');
  return value as Record<string, unknown>;
};
export function refundIntentKey(actorId: number, refundId: number) {
  if (!integer(actorId) || !integer(refundId)) throw Error('管理员或退款单标识无效');
  return `admin-refund-intent-v2:${actorId}:${refundId}`;
}
export function parseRefundIntent(value: unknown, actorId: number, refundId: number): RefundIntent {
  const row = object(value), review = object(row.review);
  if (!integer(actorId) || !integer(refundId) || row.version !== 2 || row.actorId !== actorId || row.refundId !== refundId
    || typeof row.nonce !== 'string' || !/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/.test(row.nonce)
    || !['refund','return','refuse'].includes(String(row.action)) || !['pending','resolved'].includes(String(row.phase))
    || !integer(row.applyType) || row.applyType > 4 || !integer(row.initialStatus, 0) || ![0,1,2,4,5].includes(row.initialStatus)
    || typeof row.received !== 'boolean' || typeof row.createdAt !== 'number' || !Number.isSafeInteger(row.createdAt) || row.createdAt <= 0
    || typeof row.reason !== 'string' || row.reason.length > 255 || (row.action === 'refuse' ? !row.reason.trim() : row.reason !== '')
    || !integer(review.uid) || !integer(review.storeOrderId) || !integer(review.storeId, 0) || !integer(review.supplierId, 0)
    || typeof review.orderId !== 'string' || !review.orderId || review.orderId.length > 50
    || typeof review.refundPrice !== 'string' || !/^\d{1,10}\.\d{2}$/.test(review.refundPrice)) throw Error('待核对操作记录无效，请人工核对');
  if (row.action === 'refund' && [2,3].includes(row.applyType) && !row.received) throw Error('原操作缺少退货验收确认');
  if (row.action === 'return' && (![2,3].includes(row.applyType) || ![0,1,2].includes(row.initialStatus))) throw Error('原操作不是可审批的退货申请');
  if (row.action === 'refund' && (row.applyType === 2 && row.initialStatus !== 5 || row.applyType === 3 && ![4,5].includes(row.initialStatus))) throw Error('原操作尚未达到退货验收阶段');
  if (row.action === 'refuse' && row.reason !== row.reason.trim()) throw Error('原拒绝原因格式无效');
  return { version: 2, nonce: row.nonce, actorId, refundId, action: row.action as RefundAction, phase: row.phase as RefundIntent['phase'],
    applyType: row.applyType, initialStatus: row.initialStatus, reason: row.reason, received: row.received, createdAt: row.createdAt,
    review: { uid: review.uid, storeOrderId: review.storeOrderId, storeId: review.storeId, supplierId: review.supplierId, orderId: review.orderId, refundPrice: review.refundPrice } };
}
export function makeRefundIntent(actorId: number, row: AdminRefundDetail, action: RefundAction, reason: string, received: boolean) {
  return parseRefundIntent({ version: 2, nonce: crypto.randomUUID(), actorId, refundId: row.id, action, review: refundReview(row),
    applyType: row.applyType, initialStatus: row.refundType, reason, received, createdAt: Date.now(), phase: 'pending' }, actorId, row.id);
}
export function readRefundIntent(actorId: number, refundId: number) {
  const legacy = localStorage.getItem('admin-refund-pending-v1:' + actorId);
  if (legacy && legacy.length > 12000) throw Error('历史待核对记录过大');
  const ids: unknown = JSON.parse(legacy ?? '[]');
  if (!Array.isArray(ids) || ids.length > 1000 || ids.some(id => !integer(id))) throw Error('历史待核对记录损坏');
  const raw = localStorage.getItem(refundIntentKey(actorId, refundId));
  if (raw && raw.length > 4096) throw Error('待核对操作记录过大');
  return { raw, legacy: ids.includes(refundId), intent: raw === null ? null : parseRefundIntent(JSON.parse(raw), actorId, refundId) };
}

/** Only call while holding the entity Web Lock. Keep resolved tombstones so a
 * second tab with an older null snapshot cannot send a new decision blindly. */
export function writeRefundIntent(intent: RefundIntent, expectedRaw: string | null) {
  const key = refundIntentKey(intent.actorId, intent.refundId), value = JSON.stringify(parseRefundIntent(intent, intent.actorId, intent.refundId));
  if (localStorage.getItem(key) !== expectedRaw) throw Error('其他标签页已更新原操作，请刷新核对');
  localStorage.setItem(key, value);
  if (localStorage.getItem(key) !== value) throw Error('原操作未能可靠保存，禁止提交');
  return value;
}
export async function withRefundActionLock<T>(refundId: number, work: () => Promise<T>): Promise<T> {
  if (!integer(refundId)) throw Error('退款单标识无效');
  // Structural browser type also keeps the shared test import compatible with Workers' Navigator.
  const locks = typeof navigator === 'undefined' ? undefined : (navigator as unknown as { locks?: {
    request<R>(name: string, options: { mode: 'exclusive'; ifAvailable: true }, callback: (lock: { name: string } | null) => Promise<R>): Promise<R>;
  } }).locks;
  if (!locks?.request) throw Error('当前浏览器不支持安全的跨标签操作，请使用支持 Web Locks 的浏览器');
  return locks.request('admin-refund-action:' + refundId, { mode: 'exclusive', ifAvailable: true }, async lock => {
    if (!lock) throw Error('另一标签页正在处理此单，请稍后刷新核对');
    return work();
  });
}
export function refundIntentOutcome(intent: RefundIntent, detail: AdminRefundDetail): { matched: boolean; message: string } {
  const same = detail.id === intent.refundId && detail.applyType === intent.applyType
    && JSON.stringify(refundReview(detail)) === JSON.stringify(intent.review);
  if (!same) return { matched: false, message: '退款单归属、类型或金额与原操作不一致，请人工核对' };
  if (detail.isCancel || detail.isDel) return { matched: false, message: '退款单已取消或删除，不能自动确认原操作结果' };
  let matched = false;
  if (intent.action === 'return') matched = [4,5,6].includes(detail.refundType);
  if (intent.action === 'refuse') matched = detail.refundType === 3 && detail.refuseReason === intent.reason
    && (!detail.providerStatus || ['CREATED','FAILED','CLOSED'].includes(detail.providerStatus));
  if (intent.action === 'refund') matched = detail.refundType === 6 && detail.refundedPrice === intent.review.refundPrice
    && (!detail.providerStatus || detail.providerStatus === 'SUCCESS');
  return { matched, message: matched ? '服务端已达到原操作目标，可以结束本机待核对；不会重发原操作'
    : '服务端尚不能确认原操作目标，请继续只读核对，不要重复提交' };
}
