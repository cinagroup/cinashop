import type { DbClient } from '@/lib/di';
import { publicProductPictures, renderProductPictures } from '@/services/activity/ProductAssetPolicy';
import { integralDescriptionAssetReferences } from '@/services/activity/IntegralCatalogReadability';
import { productDetailDescriptionHtml } from './ProductDetailDesignData';
import { ValidateException } from '@/utils/errors';

const invalid = () => new ValidateException('商品优惠券完整规则超过读取容量');
const references = (rules: readonly string[]) => [...new Set(rules.flatMap(integralDescriptionAssetReferences))];

/** Coupon templates have no supplier/customer owner. Their published rules can
 * use platform catalogue pictures, never the browsing product's attachment
 * privileges. Resolve persisted ownership in the same read-only snapshot. */
export async function readProductCouponRules(db: DbClient, values: readonly (string | null | undefined)[]) {
  const rules = values.map(value => {
    if (value !== null && typeof value !== 'string' || (value?.length ?? 0) > 64000) throw invalid();
    return productDetailDescriptionHtml(value ?? '');
  });
  const refs = references(rules);
  if (refs.length > 1000) throw invalid();
  const checked = await publicProductPictures(db, refs.map(image => ({ image, type: 0, relationId: 0 })));
  const allowed = new Set(refs.filter((_ref, index) => checked[index]));
  return rules.map(rule => rule.replace(/\b(href|src)="(\/api\/assets\/[1-9]\d*)"/g,
    (attribute, _key: string, reference: string) => allowed.has(reference) ? attribute : ''));
}

/** Signing does not fetch or mutate any object. Each allowed stable reference
 * is signed once after the database transaction has released its snapshot. */
export async function renderProductCouponRules(appKey: string | undefined, rules: readonly string[]) {
  const refs = references(rules), signed = await renderProductPictures(appKey, refs);
  const byRef = new Map(refs.map((ref, index) => [ref, signed[index]]));
  return rules.map(rule => rule.replace(/\b(href|src)="(\/api\/assets\/[1-9]\d*)"/g,
    (_attribute, key: string, ref: string) => byRef.get(ref) ? `${key}="${byRef.get(ref)!.replaceAll('&', '&amp;')}"` : ''));
}
