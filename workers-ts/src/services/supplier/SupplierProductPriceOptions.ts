import { and, eq } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeProduct, storeProductAttrValue } from '@/models/schema';
import type { SupplierProductInput } from './SupplierProductManagementService';
import { HttpApiException, ValidateException } from '@/utils/errors';

export interface SupplierProductPriceOptions { isVip: 0 | 1; isSub: 0 | 1 }

/** The legacy editor combines independent price and commission switches. */
export function supplierProductPriceOptions(input: Record<string, unknown>): SupplierProductPriceOptions | undefined {
  if (!Object.hasOwn(input, 'is_sub') || input.is_sub === undefined) return undefined;
  if (!Array.isArray(input.is_sub) || input.is_sub.length > 2) throw new ValidateException('会员价与佣金选项格式错误');
  const selected = input.is_sub.map(value => {
    if (value !== 0 && value !== 1 && value !== '0' && value !== '1') throw new ValidateException('会员价与佣金选项格式错误');
    return Number(value);
  });
  if (new Set(selected).size !== selected.length) throw new ValidateException('会员价与佣金选项不能重复');
  return { isVip: selected.includes(0) ? 1 : 0, isSub: selected.includes(1) ? 1 : 0 };
}

/** PHP discards commission amounts before SKU validation when explicitly off. */
export function supplierProductPriceAttrs(value: unknown, options: SupplierProductPriceOptions | undefined): unknown {
  if (!options || options.isSub === 1) return value;
  const clear = (row: unknown) => row && typeof row === 'object' && !Array.isArray(row)
    ? { ...row as Record<string, unknown>, brokerage: 0, brokerage_two: 0 } : row;
  if (Array.isArray(value)) return value.map(clear);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, row]) => [key, clear(row)]));
  return value;
}

export function assertSupplierMemberPrices(input: SupplierProductInput, enabled: number): void {
  if (enabled === 1 && input.skus.some(sku => Number(sku.vipPrice) <= 0)) throw new ValidateException('启用会员价时所有SKU会员价必须大于0');
}

/** Verify the actual financial columns after every author and deferred trigger. */
export async function assertSupplierProductPriceOptions(tx: DbClient, supplierId: number, productId: number,
  input: SupplierProductInput, options: SupplierProductPriceOptions): Promise<void> {
  const conflict = () => new HttpApiException('商品会员价或佣金保存核对失败，请刷新后重试', 409, 409);
  const [product] = await tx.select().from(storeProduct).where(eq(storeProduct.id, productId)).limit(1);
  const minimum = input.skus.reduce((a, b) => Number(a.vipPrice) <= Number(b.vipPrice) ? a : b).vipPrice;
  if (!product || product.type !== 2 || product.relationId !== supplierId || product.isDel !== 0
    || product.productType !== input.productType || product.isShow !== 0 || product.isVerify !== 0
    || product.isVip !== options.isVip || product.isSub !== options.isSub || product.vipPrice !== minimum) throw conflict();
  const skus = await tx.select().from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId, productId),
    eq(storeProductAttrValue.type, 0), eq(storeProductAttrValue.isRetired, 0)));
  const expected = new Map(input.skus.map(sku => [sku.suk, sku]));
  if (skus.length !== expected.size || skus.some(row => {
    const sku = expected.get(row.suk);
    return !sku || row.productType !== input.productType || row.price !== sku.price || row.settlePrice !== sku.settlePrice
      || row.vipPrice !== sku.vipPrice || row.brokerage !== sku.brokerage || row.brokerageTwo !== sku.brokerageTwo;
  })) throw conflict();
}
