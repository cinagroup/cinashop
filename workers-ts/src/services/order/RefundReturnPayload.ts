import { and, eq, inArray } from 'drizzle-orm';
import type { Container } from '@/lib/di';
import { systemAttachment } from '@/models/schema';
import { ValidateException } from '@/utils/errors';
import { parseCanonicalAttachmentId, signAttachmentReferences } from '@/services/system/AttachmentService';

/** Canonical upload references are stored; short-lived preview signatures never are. */
export function returnImageReferences(value: unknown): string[] {
  let values: unknown = value;
  if (values === '' || values === undefined || values === null) return [];
  if (typeof values === 'string') {
    if (values.length > 8192) throw new ValidateException('退货凭证过大');
    try { values = values.trim().startsWith('[') ? JSON.parse(values) : values.split(','); }
    catch { throw new ValidateException('退货凭证格式无效'); }
  }
  if (!Array.isArray(values) || values.length > 3) throw new ValidateException('最多上传三张退货凭证');
  const images = values.map(value => {
    if (typeof value !== 'string' || !value || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) throw new ValidateException('退货凭证链接无效');
    if (parseCanonicalAttachmentId(value)) return value;
    // Retain public legacy HTTPS images, but do not accept signed private paths or active URL schemes.
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.pathname.startsWith('/api/assets/')) throw Error();
    } catch { throw new ValidateException('请使用已上传的退货凭证'); }
    return value;
  });
  if (new Set(images).size !== images.length || JSON.stringify(images).length > 8192) throw new ValidateException('退货凭证重复或过大');
  return images;
}

export async function ownedReturnImages(container: Container, uid: number, images: string[]) {
  const ids = images.map(parseCanonicalAttachmentId).filter((id): id is number => id !== null);
  if (!ids.length) return;
  const rows = await container.db.select({ id: systemAttachment.attId }).from(systemAttachment).where(and(
    inArray(systemAttachment.attId, ids), eq(systemAttachment.relationId, uid), eq(systemAttachment.type, 3),
    eq(systemAttachment.moduleType, 3), eq(systemAttachment.fileType, 1), eq(systemAttachment.imageType, 8),
  )).limit(4);
  if (rows.length !== ids.length) throw new ValidateException('退货凭证不存在或不属于当前账号');
}

export async function previewReturnImages(container: Container, uid: number, value: unknown, appKey?: string) {
  const images = returnImageReferences(value);
  await ownedReturnImages(container, uid, images);
  const sources = images.some(image => parseCanonicalAttachmentId(image)) ? await signAttachmentReferences(appKey, images) : images;
  return images.map((url, index) => ({ url, src: sources[index] }));
}

export function parseReturnPayload(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidateException('退货物流格式无效');
  const body = value as Record<string, unknown>;
  const alias = (keys: string[], fallback: unknown = '') => {
    const supplied = keys.filter(key => body[key] !== undefined);
    if (supplied.some(key => JSON.stringify(body[key]) !== JSON.stringify(body[supplied[0]]))) throw new ValidateException('退货物流参数冲突');
    return supplied.length ? body[supplied[0]] : fallback;
  };
  const field = (keys: string[], maximum: number, required = false) => {
    const value = alias(keys);
    if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value) || (required && !value.trim())) throw new ValidateException('退货物流字段无效或过长');
    return value.trim();
  };
  const id = typeof body.id === 'string' && /^[1-9]\d*$/.test(body.id) ? Number(body.id) : body.id;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw new ValidateException('退款单标识无效');
  return { id, refundExpress: field(['refund_express', 'refundExpress'], 100, true),
    refundPhone: field(['refund_phone', 'refundPhone'], 32),
    refundExpressName: field(['refund_express_name', 'refundExpressName'], 255),
    refundGoodsExplain: field(['refund_goods_explain', 'refundGoodsExplain', 'refund_explain'], 255),
    refundGoodsImg: JSON.stringify(returnImageReferences(alias(['refund_goods_img', 'refund_img', 'refundGoodsImg']))),
  };
}
