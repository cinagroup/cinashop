import { promotionPresentation, promotionProductBlock } from '../../../common/diyPromotion';
import { listPreviewTheme, listSafeColor, normalizeDiyList } from './diyListProjection';
import { safeDiyImageUrl } from './diyStateProjection';
import { promotionPreviewBlock, type PromotionImageCapability, type PromotionRecord } from './diyPromotionEditor';
export function normalizeDiyPromotionPreview(raw: unknown, capabilities: readonly PromotionImageCapability[] = []) {
  const original = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as PromotionRecord : {};
  const block = promotionPreviewBlock(original, capabilities);
  const before = (original.tabConfig as { list?: unknown[] } | undefined)?.list, after = (block.tabConfig as { list?: unknown[] } | undefined)?.list;
  if (Array.isArray(before) && Array.isArray(after)) before.forEach((value, index) => {
    const tab = value && typeof value === 'object' && !Array.isArray(value) ? value as PromotionRecord : null;
    const target = after[index];
    if (tab && typeof tab.image === 'string' && !/^\/api\/assets\//u.test(tab.image.trim()) && target && typeof target === 'object' && !Array.isArray(target)) (target as PromotionRecord).image = tab.image;
  });
  return promotionPresentation(block, listPreviewTheme, safeDiyImageUrl, listSafeColor);
}
export function promotionPreviewProducts(block: unknown, index: number) {
  const source = promotionProductBlock(block, index);
  return source ? { block: source, config: normalizeDiyList(source, listPreviewTheme) } : null;
}
