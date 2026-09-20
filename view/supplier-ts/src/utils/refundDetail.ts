import type { RefundDetail } from '@/types';
import { returnPreview } from '../../../common/refundReturn';
import { parseRefundHistory } from '../../../common/refundHistory';

/** Never bind actions or image elements to an unchecked/stale detail receipt. */
export function parseSupplierRefundDetail(value: unknown, id: number): RefundDetail {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('售后详情响应无效');
  const row = value as Record<string, unknown>;
  if (row.id !== id || !Number.isSafeInteger(id) || id <= 0
    || typeof row.store_order_id !== 'number' || !Number.isSafeInteger(row.store_order_id) || row.store_order_id <= 0
    || ![0, 1].includes(row.is_cancel as number) || ![1, 2, 3, 4].includes(row.apply_type as number)
    || ![0, 1, 2, 3, 4, 5, 6].includes(row.refund_type as number)) throw Error('售后详情标识或状态无效，请刷新核对');
  for (const key of ['refund_order_id', 'order_id', 'real_name', 'user_phone', 'refund_reason', 'refuse_reason', 'remark',
    'pay_type', 'refund_explain', 'refund_express', 'refund_express_name', 'refund_phone', 'refund_goods_explain', 'returnImagesError']) {
    if (typeof row[key] !== 'string' || row[key].length > 255) throw Error('售后详情字段缺失或过长，请更新接口后重试');
  }
  for (const key of ['apply_price', 'refund_price', 'refunded_price', 'pay_price']) {
    if (typeof row[key] !== 'string' || !/^\d{1,10}\.\d{2}$/.test(row[key])) throw Error('售后金额无效');
  }
  for (const key of ['refund_num', 'add_time', 'refunded_time']) {
    if (typeof row[key] !== 'number' || !Number.isSafeInteger(row[key]) || row[key] < 0) throw Error('售后详情数值无效');
  }
  for (const key of ['refund_provider', 'provider_status', 'provider_refund_id', 'out_refund_no', 'provider_error']) {
    if (row[key] != null && (typeof row[key] !== 'string' || row[key].length > 4096)) throw Error('渠道信息无效');
  }
  if (!Array.isArray(row.returnImages) || row.returnImages.length > 3) throw Error('退货凭证列表无效');
  const returnImages = row.returnImages.map(returnPreview);
  if (new Set(returnImages.map(image => image.url)).size !== returnImages.length || (row.returnImagesError && returnImages.length)) throw Error('退货凭证列表无效');
  const refundHistory = parseRefundHistory(row.refundHistory, { id, sourceOrderId: row.store_order_id,
    refundNum: Number(row.refund_num), refundType: Number(row.refund_type), isCancel: Number(row.is_cancel) });
  return { ...row, returnImages, refundHistory } as RefundDetail;
}
