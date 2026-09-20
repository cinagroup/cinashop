import type { RefundRecordDetail } from './refundRecords';

export interface ReturnImage { url: string; src: string }
export interface ReturnCarrier { id: number; name: string; code: string }
export interface ReturnBody { id: number; refund_express: string; refund_express_name: string; refund_phone: string; refund_explain: string; refund_img: string[] }
export const newReturnForm = () => ({ carrierId: 0, tracking: '', phone: '', explain: '', acknowledged: false, images: [] as ReturnImage[] });
export const initialReturnState = () => ({ form: newReturnForm(), carriers: [] as ReturnCarrier[], carriersReady: false,
  carriersError: '', pending: null as ReturnBody | null, dispatched: false, outcome: null as 'unknown' | 'success' | null });
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('退货响应格式无效');
  return value as Record<string, unknown>;
};
export function parseReturnCarriers(value: unknown): ReturnCarrier[] {
  if (!Array.isArray(value) || value.length > 500) throw Error('快递公司列表无效');
  const seen = new Set<number>();
  return value.map(raw => {
    const row = object(raw);
    if (typeof row.id !== 'number' || !Number.isSafeInteger(row.id) || row.id <= 0 || seen.has(row.id)
      || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 64
      || typeof row.code !== 'string' || row.code.length > 50) throw Error('快递公司列表无效');
    seen.add(row.id); return { id: row.id, name: row.name, code: row.code };
  });
}
export function returnPreview(value: unknown): ReturnImage {
  const row = object(value);
  if (typeof row.url !== 'string' || typeof row.src !== 'string' || row.url.length > 2048 || row.src.length > 4096
    || /[\u0000-\u0020\u007f]/.test(row.url + row.src)) throw Error('退货凭证响应无效');
  if (/^\/api\/assets\/[1-9]\d*$/.test(row.url)) {
    const preview = new URL(row.src, 'https://local.invalid');
    if (!row.src.startsWith(row.url + '?') || preview.pathname !== row.url
      || !/^[1-9]\d*$/.test(preview.searchParams.get('expires') ?? '')
      || !/^[A-Za-z0-9_-]{43}$/.test(preview.searchParams.get('signature') ?? '')
      || [...preview.searchParams.keys()].sort().join(',') !== 'expires,signature') throw Error('退货凭证预览签名无效');
  } else {
    const url = new URL(row.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || row.src !== row.url || url.pathname.startsWith('/api/assets/')) throw Error('退货凭证链接无效');
  }
  return { url: row.url, src: row.src };
}
export function parseReturnUpload(value: unknown): ReturnImage {
  const row = object(value), image = returnPreview(row);
  if (typeof row.att_id !== 'number' || !Number.isSafeInteger(row.att_id) || row.att_id <= 0 || image.url !== `/api/assets/${row.att_id}`
    || typeof row.size !== 'number' || !Number.isSafeInteger(row.size) || row.size <= 0 || row.size > 10 * 1024 * 1024
    || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(row.type as string)) throw Error('图片上传回执无效');
  return image;
}
export function returnEligible(detail: RefundRecordDetail | null) { return !!detail && detail.applyType === 2 && detail.refundType === 4 && detail.isCancel === 0; }
export function prepareReturn(form: ReturnType<typeof newReturnForm>, carriers: ReturnCarrier[], id: number): ReturnBody {
  const carrier = carriers.find(row => row.id === Number(form.carrierId));
  if (!carrier) throw Error('请选择快递公司');
  const field = (value: string, max: number, required = false) => {
    if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value) || (required && !value.trim())) throw Error('请检查物流单号、电话和备注的格式及长度');
    return value.trim();
  };
  if (!form.acknowledged) throw Error('请确认已按商家收件信息寄出商品');
  const images = form.images.map(image => returnPreview(image).url);
  if (images.length > 3 || new Set(images).size !== images.length) throw Error('最多上传三张不同的凭证');
  return { id, refund_express: field(form.tracking, 100, true), refund_express_name: carrier.name.trim(),
    refund_phone: field(form.phone, 32), refund_explain: field(form.explain, 255), refund_img: images };
}
export function matchesReturned(detail: RefundRecordDetail, body: ReturnBody) {
  return detail.id === body.id && [5, 6].includes(detail.refundType) && detail.returnEvidenceReady && !detail.returnImagesError
    && detail.refundExpress === body.refund_express && detail.refundExpressName === body.refund_express_name
    && detail.refundPhone === body.refund_phone && detail.refundGoodsExplain === body.refund_explain
    && JSON.stringify(detail.returnImages.map(image => image.url)) === JSON.stringify(body.refund_img);
}
