import { and, eq, inArray } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeProductLabel } from '@/models/schema';
import { ValidateException } from '@/utils/errors';
import { resolveProductLabelIcons } from './ProductLabelAssetPolicy';

/** Preserve legacy CSV order and deduplication. Callers use the persisted
 * product field, never a client-supplied label projection or image owner. */
export function publicProductLabelIds(value: unknown): number[] {
  return [...new Set(String(value ?? '').split(',').map(part => Number(part.trim()))
    .filter(id => Number.isSafeInteger(id) && id > 0 && id <= 2147483647))];
}

/** One bounded label read per already paginated product page. Persisted label
 * visibility and the existing media owner policy apply identically to ordinary
 * /products, recommendation and presale cards. Signed icons are response-only. */
export async function readPublicProductLabelMap(db: DbClient, appKey: string | undefined, requested: readonly number[]) {
  const ids = [...new Set(requested)];
  if (ids.length > 10000 || ids.some(id => !Number.isSafeInteger(id) || id < 1 || id > 2147483647)) throw new ValidateException('商品标签超过完整读取容量');
  if (!ids.length) return new Map<number, { id: number; label_name: string; style_type: number; color: string; bg_color: string; border_color: string; icon: string }>();
  const labels = await db.select({ id: storeProductLabel.id, label_name: storeProductLabel.labelName, style_type: storeProductLabel.styleType,
    color: storeProductLabel.color, bg_color: storeProductLabel.bgColor, border_color: storeProductLabel.borderColor, icon: storeProductLabel.icon,
    type: storeProductLabel.type, relationId: storeProductLabel.relationId }).from(storeProductLabel)
    .where(and(inArray(storeProductLabel.id, ids), eq(storeProductLabel.status, 1), eq(storeProductLabel.isShow, 1))).limit(ids.length);
  const icons = await resolveProductLabelIcons(db, appKey, labels);
  return new Map(labels.map(({ type: _type, relationId: _owner, ...label }, index) => [label.id, { ...label, icon: icons[index] }]));
}
