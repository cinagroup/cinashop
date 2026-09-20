import { returnPreview, type ReturnImage } from '../../../common/refundReturn';
import { parseRefundHistory, type RefundHistory } from '../../../common/refundHistory';
export interface AdminRefund {
  id: number; storeOrderId: number; orderId: string; uid: number; storeId: number; supplierId: number;
  applyType: number; applyPrice: string; refundType: number; refundNum: number; refundPrice: string;
  refundedPrice: string; refundReason: string; isCancel: number; isDel: number; addTime: number; refundedTime: number;
  originalOrderId: string; payType: string; providerStatus: string | null;
}
export interface AdminRefundDetail extends AdminRefund {
  refundHistory?: RefundHistory | null;
  refundExplain: string; refuseReason: string; refundExpress: string; refundExpressName: string; refundPhone: string;
  refundGoodsExplain: string; returnImages: ReturnImage[]; returnImagesError: string;
  returnContact: { source: 'platform' | 'supplier' | 'store'; name: string; phone: string; address: string };
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('退款响应不完整，请刷新核对');
  return value as Record<string, unknown>;
}
function text(row: Record<string, unknown>, key: string, max = 255): string {
  const value = row[key]; if (typeof value !== 'string' || value.length > max) throw Error('退款字段无效，请刷新核对'); return value;
}
function number(row: Record<string, unknown>, key: string, min = 0, max = 2147483647): number {
  const value = row[key]; if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw Error('退款标识或状态无效'); return value;
}
function money(row: Record<string, unknown>, key: string): string {
  const value = text(row, key); if (!/^\d{1,10}\.\d{2}$/.test(value)) throw Error('退款金额响应无效'); return value;
}
export function parseAdminRefund(value: unknown): AdminRefund {
  const row = object(value);
  return { id: number(row, 'id', 1), storeOrderId: number(row, 'storeOrderId', 1), uid: number(row, 'uid', 1),
    storeId: number(row, 'storeId'), supplierId: number(row, 'supplierId'), orderId: text(row, 'orderId', 50),
    originalOrderId: text(row, 'originalOrderId', 50), payType: text(row, 'payType', 32),
    providerStatus: row.providerStatus === null ? null : text(row, 'providerStatus', 64),
    applyType: number(row, 'applyType', 1, 4), refundType: number(row, 'refundType', 0, 6), refundNum: number(row, 'refundNum'),
    applyPrice: money(row, 'applyPrice'), refundPrice: money(row, 'refundPrice'), refundedPrice: money(row, 'refundedPrice'),
    refundReason: text(row, 'refundReason'), isCancel: number(row, 'isCancel', 0, 1), isDel: number(row, 'isDel', 0, 0),
    addTime: number(row, 'addTime'), refundedTime: number(row, 'refundedTime') };
}
export function parseAdminRefundDetail(value: unknown, id: number): AdminRefundDetail {
  const base = parseAdminRefund(value), row = object(value), contact = object(row.returnContact);
  if (base.id !== id || !['platform', 'supplier', 'store'].includes(String(contact.source))
    || !Array.isArray(row.returnImages) || row.returnImages.length > 3) throw Error('退款详情与当前单据不一致');
  const returnImages = row.returnImages.map(returnPreview), returnImagesError = text(row, 'returnImagesError');
  if (new Set(returnImages.map(image => image.url)).size !== returnImages.length || (returnImagesError && returnImages.length)) throw Error('退货凭证响应无效');
  const refundHistory = parseRefundHistory(row.refundHistory, { id: base.id, sourceOrderId: base.storeOrderId,
    refundNum: base.refundNum, refundType: base.refundType, isCancel: base.isCancel });
  return { ...base, refundHistory, refundExplain: text(row, 'refundExplain'), refuseReason: text(row, 'refuseReason'),
    refundExpress: text(row, 'refundExpress'), refundExpressName: text(row, 'refundExpressName'), refundPhone: text(row, 'refundPhone'),
    refundGoodsExplain: text(row, 'refundGoodsExplain'), returnImages, returnImagesError,
    returnContact: { source: contact.source as AdminRefundDetail['returnContact']['source'], name: text(contact, 'name', 200),
      phone: text(contact, 'phone', 64), address: text(contact, 'address', 1000) } };
}
export function refundReview(row: AdminRefund) {
  return { uid: row.uid, storeOrderId: row.storeOrderId, storeId: row.storeId, supplierId: row.supplierId, orderId: row.orderId, refundPrice: row.refundPrice };
}
