import { sql } from 'drizzle-orm';
import type { Container } from '@/lib/di';
import { storeOrderRefund } from '@/models/schema';
import { ValidateException } from '@/utils/errors';
import { ownedReturnImages, previewReturnImages, returnImageReferences } from './RefundReturnPayload';

const MAX_BYTES = 8192;
const bytes = (value: string) => new TextEncoder().encode(value).length;
const invalid = () => new ValidateException('退款申请凭证无效、重复或过大，最多上传三张图片');

/** Original application evidence is independent from later refundGoodsImg.
 * Public HTTPS references retain the established Supplier return-image legacy
 * policy; they do not acquire a claim of authenticated uploader ownership. */
export function refundApplicationImageReferences(value: unknown): string[] {
  if (typeof value === 'string' && bytes(value) > MAX_BYTES) throw invalid();
  try {
    const images = returnImageReferences(value);
    if (bytes(JSON.stringify(images)) > MAX_BYTES) throw invalid();
    return images;
  } catch (error) {
    if (!(error instanceof ValidateException)) throw error;
    throw invalid();
  }
}

/** Only the ordinary Customer HTTP author calls this. Financial/materialized
 * service writers and their durable replay contracts are unchanged. */
export async function normalizeRefundApplicationEvidence(container: Container, uid: number,
  input: Record<string, unknown>): Promise<string | undefined> {
  const aliases = ['refundImg', 'refund_reason_wap_img'].filter(key => Object.hasOwn(input, key));
  if (!aliases.length) return undefined;
  const lists = aliases.map(key => {
    const value = input[key];
    if (typeof value !== 'string' && !(key === 'refund_reason_wap_img' && Array.isArray(value))) throw invalid();
    return refundApplicationImageReferences(value);
  });
  if (lists.some(images => JSON.stringify(images) !== JSON.stringify(lists[0])))
    throw new ValidateException('退款申请凭证参数冲突');
  try { await ownedReturnImages(container, uid, lists[0]); }
  catch (error) {
    if (!(error instanceof ValidateException)) throw error;
    throw new ValidateException('退款申请凭证不存在或不属于当前用户');
  }
  // Store canonical references (or bounded legacy public HTTPS), never a ticket.
  return JSON.stringify(lists[0]);
}

/** TEXT must be bounded before SQL transport. NULL/empty is known empty; an
 * oversized non-NULL value remains invalid instead of becoming false absence. */
export const supplierRefundApplicationImagesSql = sql<string | null>`CASE
  WHEN octet_length(${storeOrderRefund.refundImg}) <= 8192 THEN ${storeOrderRefund.refundImg}
  WHEN ${storeOrderRefund.refundImg} IS NULL THEN NULL ELSE '__invalid__' END`;

export async function previewRefundApplicationEvidence(container: Container, uid: number, value: unknown, appKey?: string) {
  try {
    const images = refundApplicationImageReferences(value);
    return { requestImages: await previewReturnImages(container, uid, images, appKey), requestImagesError: '' };
  } catch (error) {
    if (!(error instanceof ValidateException)) throw error;
    return { requestImages: [], requestImagesError: '退款申请凭证暂不可读取，请与用户核对' };
  }
}
