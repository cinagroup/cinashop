import { eq } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeProduct } from '@/models/schema';
import { HttpApiException, ValidateException } from '@/utils/errors';

/** Explicit decimal(12,2) intent; omission never targets the historical column. */
export function supplierProductIntegralInput(raw: Record<string, unknown>): string | undefined {
  if (!Object.hasOwn(raw, 'give_integral') || raw.give_integral === undefined) return undefined;
  const value = raw.give_integral;
  if (typeof value !== 'string' && typeof value !== 'number') throw new ValidateException('赠送积分格式错误');
  const text = String(value).trim();
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(text)) throw new ValidateException('赠送积分须为最多两位小数的非负数，整数部分最多十位');
  const [whole, fraction = ''] = text.split('.');
  return `${BigInt(whole)}.${fraction.padEnd(2, '0')}`;
}

export async function assertSupplierProductIntegral(tx: DbClient, supplierId: number, productId: number,
  productType: number, expected: string): Promise<void> {
  const [row] = await tx.select().from(storeProduct).where(eq(storeProduct.id, productId)).limit(1);
  if (!row || row.type !== 2 || row.relationId !== supplierId || row.productType !== productType || row.isDel !== 0
    || row.isShow !== 0 || row.isVerify !== 0 || row.giveIntegral !== expected) {
    throw new HttpApiException('商品赠送积分保存核对失败，请刷新后重试', 409, 409);
  }
}
