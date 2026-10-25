import { inArray } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeProduct } from '@/models/schema';
import { parseCanonicalAttachmentId } from '@/services/system/AttachmentService';
import { publicProductPictures } from '@/services/activity/ProductAssetPolicy';
import { seckillTimePicture } from '@/services/activity/SeckillTimeAssetPolicy';
import { ValidateException } from '@/utils/errors';

export const MAX_WECHAT_LIVE_MEDIA_REFERENCES = 10000;
export type WechatLivePicture = { image: unknown; scope: 'platform' }
  | { image: unknown; scope: 'product'; productId: number };

/** Only explicit public room/share/anchor fields and bound goods covers enter
 * here. Live rows have no product-owner tuple: goods authority must come from the
 * exact persisted productId, never a caller's owner or another matching picture.
 * Legacy static/HTTPS pictures retain their DTO values without acquiring an ID. */
export async function publicWechatLivePictures(db: Pick<DbClient, 'select'>,
  values: readonly WechatLivePicture[]): Promise<string[]> {
  if (values.length > MAX_WECHAT_LIVE_MEDIA_REFERENCES) throw new ValidateException('直播图片超过完整预览容量');
  const refs = values.map(value => { try { return value.image === '' ? '' : seckillTimePicture(value.image); } catch { return ''; } });
  const productIds = [...new Set(values.flatMap((value, index) => value.scope === 'product'
    && parseCanonicalAttachmentId(refs[index]) !== null && Number.isSafeInteger(value.productId)
    && value.productId > 0 && value.productId <= 2147483647 ? [value.productId] : []))];
  const products = productIds.length ? await db.select({ id: storeProduct.id, type: storeProduct.type, relationId: storeProduct.relationId })
    .from(storeProduct).where(inArray(storeProduct.id, productIds)) : [];
  const byId = new Map(products.map(row => [row.id, row]));
  return publicProductPictures(db, refs.map((image, index) => {
    const value = values[index];
    if (value.scope === 'platform') return { image, type: 0, relationId: 0 };
    if (value.scope !== 'product') return { image: '', type: -1, relationId: -1 };
    if (parseCanonicalAttachmentId(image) === null) return { image, type: 0, relationId: 0 };
    const owner = byId.get(value.productId);
    // Existing ordinary, combination and presale SKU readers resolve persisted
    // store-owned product pictures through the platform material namespace.
    // Preserve that domain mapping without granting supplier/user namespaces.
    if (owner?.type === 1 && Number.isSafeInteger(owner.relationId) && owner.relationId > 0 && owner.relationId <= 2147483647) {
      return { image, type: 0, relationId: 0 };
    }
    return owner ? { image, type: owner.type, relationId: owner.relationId } : { image: '', type: -1, relationId: -1 };
  }));
}
