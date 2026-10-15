import { normalizeSupplierProductDimensions, type SupplierProductDimension } from '@/services/product/ProductSkuInput';
import { parseLevelActivationJson } from './AdminLevelActivationInput';
import { readBoundedUtf8Text } from '@/utils/request-body';
import { ValidateException } from '@/utils/errors';

export const ADMIN_PRODUCT_GENERATE_BODY_BYTES = 64 * 1024;
export interface AdminLegacyProductGenerateInput { dimensions: SupplierProductDimension[]; productType: number }
export function normalizeAdminLegacyProductGenerateInput(body: unknown): AdminLegacyProductGenerateInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ValidateException('商品规格正文须为对象');
  const row = body as Record<string, unknown>;
  const raw = row.attrs ?? [];
  // The real single-spec Vue invokes generate(0) with items/attrs empty.
  if (!Array.isArray(raw)) throw new ValidateException('商品规格格式错误');
  const dimensions = raw.length ? normalizeSupplierProductDimensions(raw) : [];
  for (const dimension of dimensions) {
    if (['__proto__', 'prototype', 'constructor'].includes(dimension.value)
      || [dimension.value, ...dimension.detail].some(value => /[,\p{Cc}\p{Cs}]/u.test(value)))
      throw new ValidateException('规格名称和值不能包含逗号、保留名称或控制字符');
  }
  if (dimensions.reduce((size, dimension) => size * dimension.detail.length, 1) > 200)
    throw new ValidateException('SKU组合不能超过200项');
  const productType = row.product_type === undefined ? 0 : Number(row.product_type);
  if (!Number.isSafeInteger(productType) || ![0, 1, 3, 4].includes(productType)) throw new ValidateException('商品履约类型错误');
  // Source postMore ignores items and other UI echoes. None become rows,
  // owner overrides or seed values for generated prices/inventory.
  return { dimensions, productType };
}
export async function readAdminLegacyProductGenerateBody(request: Request): Promise<unknown> {
  return parseLevelActivationJson(await readBoundedUtf8Text(request, ADMIN_PRODUCT_GENERATE_BODY_BYTES));
}
