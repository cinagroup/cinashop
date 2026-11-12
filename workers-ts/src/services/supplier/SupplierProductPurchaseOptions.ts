import { eq } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeProduct } from '@/models/schema';
import { outProductPresaleInput, outProductPresalePlan, assertOutProductPresaleFuture,
  type OutProductPresaleInput, type OutProductPresalePlan } from '@/services/out/OutProductPresaleBindings';
import { HttpApiException, ValidateException } from '@/utils/errors';

export interface SupplierProductPurchaseInput extends OutProductPresaleInput { isVipProduct?: 0 | 1 }
export interface SupplierProductPurchasePlan extends OutProductPresalePlan { isVipProduct: number }

/** Keep omitted legacy fields distinct from an explicit disabled intent. */
export function supplierProductPurchaseInput(raw: Record<string, unknown>): SupplierProductPurchaseInput | undefined {
  const input: SupplierProductPurchaseInput = outProductPresaleInput(raw);
  if (Object.hasOwn(raw, 'is_vip_product') && raw.is_vip_product !== undefined) {
    const value = raw.is_vip_product;
    if (value !== 0 && value !== 1 && value !== '0' && value !== '1' && value !== false && value !== true) throw new ValidateException('付费会员专属开关格式错误');
    input.isVipProduct = Number(value) as 0 | 1;
  }
  return Object.keys(input).length ? input : undefined;
}
export function supplierProductPurchasePlan(input: SupplierProductPurchaseInput,
  existing?: typeof storeProduct.$inferSelect): SupplierProductPurchasePlan {
  return { ...outProductPresalePlan(input, existing), isVipProduct: input.isVipProduct ?? existing?.isVipProduct ?? 0 };
}
export { assertOutProductPresaleFuture as assertSupplierProductPresaleFuture };

/** Check after all requested authors and deferred constraints have executed. */
export async function assertSupplierProductPurchase(tx: DbClient, supplierId: number, productId: number,
  productType: number, plan: SupplierProductPurchasePlan): Promise<void> {
  const [row] = await tx.select().from(storeProduct).where(eq(storeProduct.id, productId)).limit(1);
  if (!row || row.type !== 2 || row.relationId !== supplierId || row.productType !== productType || row.isDel !== 0
    || row.isShow !== 0 || row.isVerify !== 0 || row.isVipProduct !== plan.isVipProduct
    || row.isPresaleProduct !== plan.isPresaleProduct || row.presaleStartTime !== plan.presaleStartTime
    || row.presaleEndTime !== plan.presaleEndTime || row.presaleDay !== plan.presaleDay) {
    throw new HttpApiException('商品购买资格或预售条件保存核对失败，请刷新后重试', 409, 409);
  }
  await assertOutProductPresaleFuture(tx, plan);
}
