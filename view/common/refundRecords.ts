import { orderDetailId } from './orderDetailIdentity';
import { returnPreview, type ReturnImage } from './refundReturn';

export const refundFilters = [
  { key: 'all', label: '全部记录' }, { key: 'pending', label: '申请中' },
  { key: 'returning', label: '待退货' }, { key: 'transit', label: '已寄回' },
  { key: 'completed', label: '已退款' }, { key: 'rejected', label: '已拒绝' }, { key: 'cancelled', label: '已撤销' },
] as const;
export type RefundFilter = typeof refundFilters[number]['key'];
export interface RefundRecord {
  id: number; uid: number; refundNo: string; orderId: string; storeOrderId: number;
  applyType: number; refundType: number; isCancel: number; refundNum: number;
  refundPrice: string; refundedPrice: string; refundReason: string; addTime: number; refundedTime: number;
}
export interface RefundRecordDetail extends RefundRecord {
  version: 1; refundExplain: string; refuseReason: string; refundExpress: string; refundExpressName: string;
  refundPhone: string; refundGoodsExplain: string; itemsError: string;
  returnImages: ReturnImage[]; returnImagesError: string; returnEvidenceReady: boolean;
  items: Array<{ id: number; cartId: number; name: string; sku: string; image: string; quantity: number | null }>;
  returnContact: { source: 'platform' | 'supplier' | 'store'; name: string; phone: string; address: string } | null;
}
export interface RefundQuery { filter: RefundFilter; q: string; limit: number; cursor: string | null }
export interface RefundPage { version: 1; items: RefundRecord[]; filter: RefundFilter; q: string; limit: number; nextCursor: string | null }
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('退款记录响应无效，请重新读取');
  return value as Record<string, unknown>;
};
const integer = (value: unknown, minimum = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
const money = (value: unknown): value is string => typeof value === 'string' && /^\d+\.\d{2}$/.test(value) && Number.isSafeInteger(Number(value.replace('.', '')));
const text = (value: unknown, max = 255): value is string => typeof value === 'string' && value.length <= max;
export function refundRecordId(value: unknown): number {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw Error('退款单链接无效');
  return Number(value);
}
export function refundQuery(filter: unknown = 'all', q: unknown = '', limit = 20, cursor: string | null = null): RefundQuery {
  if (typeof filter !== 'string' || !refundFilters.some(item => item.key === filter) || !text(q, 80)
    || /[\u0000-\u001f\u007f]/.test(q) || !integer(limit, 1) || limit > 50
    || (cursor !== null && (!text(cursor, 2048) || !/^[A-Za-z0-9_-]+$/.test(cursor)))) throw Error('退款筛选或分页参数无效');
  return { filter: filter as RefundFilter, q: q.trim(), limit, cursor };
}
export function matchesRefundFilter(row: RefundRecord, filter: RefundFilter) {
  if (filter === 'all') return true;
  if (filter === 'cancelled') return row.isCancel === 1;
  const types = { pending: [0, 1, 2], returning: [4], transit: [5], completed: [6], rejected: [3] };
  return row.isCancel === 0 && types[filter].includes(row.refundType);
}
function parseRecord(value: unknown, uid: number): RefundRecord {
  const row = object(value);
  if (!integer(uid, 1) || row.uid !== uid || !integer(row.id, 1) || !integer(row.storeOrderId, 1)
    || ![0, 1, 2, 3, 4].includes(row.applyType as number) || ![0, 1, 2, 3, 4, 5, 6].includes(row.refundType as number)
    || ![0, 1].includes(row.isCancel as number) || !integer(row.refundNum, 1) || !money(row.refundPrice) || !money(row.refundedPrice)
    || Number(row.refundedPrice) > Number(row.refundPrice) || !text(row.refundReason)
    || !integer(row.addTime) || !integer(row.refundedTime)) throw Error('退款记录与当前账号不一致或数据无效');
  orderDetailId(row.orderId); orderDetailId(row.refundNo);
  return { id: row.id, uid, storeOrderId: row.storeOrderId, orderId: row.orderId as string, refundNo: row.refundNo as string,
    applyType: row.applyType as number, refundType: row.refundType as number, isCancel: row.isCancel as number,
    refundNum: row.refundNum, refundPrice: row.refundPrice, refundedPrice: row.refundedPrice,
    refundReason: row.refundReason, addTime: row.addTime, refundedTime: row.refundedTime };
}
export function parseRefundPage(value: unknown, uid: number, query: RefundQuery, previous: RefundRecord[] = []): RefundPage {
  const page = object(value);
  if (page.version !== 1 || page.filter !== query.filter || page.q !== query.q || page.limit !== query.limit
    || !Array.isArray(page.items) || page.items.length > query.limit
    || (page.nextCursor !== null && (!text(page.nextCursor, 2048) || !/^[A-Za-z0-9_-]+$/.test(page.nextCursor)
      || page.items.length !== query.limit || page.nextCursor === query.cursor))) throw Error('退款分页响应与本次查询不一致');
  const items = page.items.map(item => parseRecord(item, uid)), seen = new Set(previous.map(row => row.id));
  let last = previous.at(-1);
  for (const row of items) {
    if (seen.has(row.id) || !matchesRefundFilter(row, query.filter)
      || (query.q && ![row.refundNo, row.orderId].some(id => id.toLowerCase().includes(query.q.toLowerCase())))
      || (last && (row.addTime > last.addTime || (row.addTime === last.addTime && row.id >= last.id)))) throw Error('退款记录重复、顺序或筛选范围异常，请刷新');
    seen.add(row.id); last = row;
  }
  return { version: 1, items, filter: query.filter, q: query.q, limit: query.limit, nextCursor: page.nextCursor as string | null };
}
export function parseRefundDetail(value: unknown, uid: number, id: number): RefundRecordDetail {
  const raw = object(value), row = parseRecord(raw, uid);
  if (raw.version !== 1 || row.id !== id || !Array.isArray(raw.items) || raw.items.length > 200
    || !['refundExplain', 'refuseReason', 'refundExpressName', 'refundGoodsExplain', 'itemsError'].every(key => text(raw[key]))
    || !text(raw.refundExpress, 100) || !text(raw.refundPhone, 32)) throw Error('退款详情与当前退款单不一致或数据无效');
  const seen = new Set<number>(), items = raw.items.map(value => {
    const item = object(value);
    if (!integer(item.id, 1) || !integer(item.cartId, 1) || seen.has(item.id) || !text(item.name, 4096) || !text(item.sku, 4096)
      || !text(item.image, 8192) || (item.quantity !== null && !integer(item.quantity, 1))) throw Error('退款商品响应无效');
    seen.add(item.id); return { id: item.id, cartId: item.cartId, name: item.name, sku: item.sku, image: item.image, quantity: item.quantity as number | null };
  });
  const sum = items.reduce((total, item) => total + (item.quantity ?? 0), 0);
  if (sum > row.refundNum || (!raw.itemsError && (!items.length || (items.every(item => item.quantity !== null) && sum !== row.refundNum)))
    || (raw.itemsError && items.length)) throw Error('退款商品件数与申请不一致');
  let returnContact: RefundRecordDetail['returnContact'] = null;
  if (raw.returnContact !== null) {
    const contact = object(raw.returnContact);
    if (row.isCancel || ![4, 5].includes(row.refundType) || !['platform', 'supplier', 'store'].includes(contact.source as string)
      || !text(contact.name, 200) || !text(contact.phone, 64) || !text(contact.address, 1000)) throw Error('退货收件信息响应无效');
    returnContact = { source: contact.source as 'platform' | 'supplier' | 'store', name: contact.name, phone: contact.phone, address: contact.address };
  }
  const returnEvidenceReady = raw.returnImages !== undefined && raw.returnImagesError !== undefined;
  if (returnEvidenceReady && (!Array.isArray(raw.returnImages) || raw.returnImages.length > 3 || !text(raw.returnImagesError))) throw Error('退货凭证响应无效');
  const returnImages = returnEvidenceReady ? (raw.returnImages as unknown[]).map(returnPreview) : [];
  if (new Set(returnImages.map(image => image.url)).size !== returnImages.length || (raw.returnImagesError && returnImages.length)) throw Error('退货凭证重复或状态冲突');
  return { version: 1, ...row, items, returnContact, itemsError: raw.itemsError as string, returnEvidenceReady,
    returnImages, returnImagesError: returnEvidenceReady ? raw.returnImagesError as string : '',
    refundExplain: raw.refundExplain as string, refuseReason: raw.refuseReason as string,
    refundExpress: raw.refundExpress, refundPhone: raw.refundPhone, refundExpressName: raw.refundExpressName as string,
    refundGoodsExplain: raw.refundGoodsExplain as string };
}
export function refundStatus(row: RefundRecord): string {
  if (row.isCancel === 1) return '已撤销';
  return ['待审核', '申请处理中', '申请处理中', '已拒绝', '待退回商品', '已寄回，待处理', '已退款'][row.refundType] ?? '状态待核对';
}
export function refundStatusDescription(row: RefundRecord): string {
  if (row.isCancel === 1) return '本次售后申请已撤销。';
  if (row.refundType === 6) return '服务器已记录退款处理完成；到账明细请核对对应支付渠道或余额记录。';
  if (row.refundType === 3) return '请查看拒绝原因，如有疑问可联系客服。';
  if (row.refundType === 4) return '请先核对商家提供的收件信息，再寄回商品。';
  if (row.refundType === 5) return '退货物流已提交，等待商家后续处理。';
  return '已收到售后申请，等待商家处理；申请金额不代表退款已到账。';
}
export function refundableCancellation(row: RefundRecord) { return row.isCancel === 0 && [0, 1, 2, 4, 5].includes(row.refundType); }
export function refundTime(value: number) {
  if (!value) return '时间未记录';
  const date = new Date(value * 1000), pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
