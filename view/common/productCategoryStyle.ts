/** Non-secret category visual settings. These are layout ordinals, not category IDs. */
export interface ProductCategoryStyleValue { level: 2 | 3; index: number }
export interface ProductCategoryStyleWrite extends ProductCategoryStyleValue { operationId: string; revision: string }
export interface ProductCategoryStyleSnapshot {
  revision: string; value: ProductCategoryStyleValue | null; configured: boolean; editable: boolean; issues: string[];
}
export interface ProductCategoryStyleReceipt { operation: 'update'; id: number; operationId: string; payloadHash: string }
export interface ProductCategoryStyleFailureProof {
  code: 'PRODUCT_CATEGORY_STYLE_STALE_VERSION' | 'PRODUCT_CATEGORY_STYLE_REJECTED';
  operation: 'update'; operationId: string; payloadHash: string;
}
/** PHP's public category object preserves non-secret extension fields. Only
 * level/index/configured/issues below have executable meaning for clients. */
export interface PublicProductCategoryStyle extends ProductCategoryStyleValue { [key: string]: unknown; configured: boolean; issues: string[] }
export const PRODUCT_CATEGORY_STYLE_DEFAULT: Readonly<ProductCategoryStyleValue> = Object.freeze({ level: 2, index: 1 });
export const PRODUCT_CATEGORY_STYLES = Object.freeze([
  { level: 2, index: 0, key: '1-2', template: 1 }, { level: 2, index: 1, key: '2-2', template: 3 },
  { level: 2, index: 2, key: '3-2', template: 2 }, { level: 2, index: 3, key: '2-2-1', template: 2 },
  { level: 2, index: 4, key: '3-2-1', template: 3 }, { level: 2, index: 5, key: '4-2', template: 4 },
  { level: 3, index: 0, key: '1-3', template: 1 }, { level: 3, index: 1, key: '2-3', template: 2 },
  { level: 3, index: 2, key: '3-3', template: 2 }, { level: 3, index: 3, key: '4-3', template: 4 },
] as const);
export function isProductCategoryStyleValue(value: unknown): value is ProductCategoryStyleValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (v.level === 2 || v.level === 3) && typeof v.index === 'number' && Number.isInteger(v.index)
    && v.index >= 0 && v.index <= (v.level === 2 ? 5 : 3);
}
export function productCategoryStyleCanonical(value: Pick<ProductCategoryStyleWrite, 'revision' | 'level' | 'index'>) {
  return { operation: 'update' as const, revision: value.revision, level: value.level, index: value.index };
}
