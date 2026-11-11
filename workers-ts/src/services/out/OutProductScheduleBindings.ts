import { and, eq, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeProduct } from '@/models/schema';
import { supplierProductScheduleInput } from '@/services/supplier/SupplierProductScheduleInput';
import { ValidateException } from '@/utils/errors';

export function outProductScheduleInput(input: Record<string, unknown>) {
  // PHP treats the literal string "0" as empty; retain that wire spelling
  // while delegating every other timestamp to the shared strict parser.
  return supplierProductScheduleInput({ ...input,
    ...(input.auto_on_time === '0' ? { auto_on_time: 0 } : {}),
    ...(input.auto_off_time === '0' ? { auto_off_time: 0 } : {}),
  });
}
type Product = typeof storeProduct.$inferSelect;
export interface OutProductScheduleProof { productId: number; productType: 0 | 3 | 4; autoOnTime: number; autoOffTime: number; isShow: 0 | 1; rowPosition: string }
/** Keep the established manual-show clearing rule when off-time is omitted.
 * An explicit off-time is a new schedule and therefore wins that rule. */
async function selected(tx: DbClient, productId: number, productType: 0 | 3 | 4) {
  const [row] = await tx.select({ autoOnTime: storeProduct.autoOnTime, autoOffTime: storeProduct.autoOffTime,
    isShow: storeProduct.isShow, rowPosition: sql<string>`ctid::text` }).from(storeProduct)
    .where(and(eq(storeProduct.id, productId), eq(storeProduct.type, 0), eq(storeProduct.relationId, 0),
      eq(storeProduct.productType, productType), eq(storeProduct.isDel, 0))).limit(1);
  return row;
}
export async function outProductScheduleProof(tx: DbClient, productId: number, existing: Product | undefined,
  input: { productType: number; autoOnTime?: number; autoOffTime?: number; isShow: 0 | 1 }): Promise<OutProductScheduleProof> {
  if (input.productType !== 0 && input.productType !== 3 && input.productType !== 4) throw new ValidateException('平台商品履约类型无效');
  const autoOnTime = input.autoOnTime ?? existing?.autoOnTime ?? 0;
  const autoOffTime = input.autoOffTime ?? (input.isShow ? 0 : existing?.autoOffTime ?? 0);
  const row = await selected(tx, productId, input.productType);
  if (!row || row.autoOnTime !== autoOnTime || row.autoOffTime !== autoOffTime || row.isShow !== input.isShow) {
    throw new ValidateException('平台商品定时上下架状态已变化');
  }
  return { productId, productType: input.productType, autoOnTime, autoOffTime, isShow: input.isShow, rowPosition: row.rowPosition };
}
/** Row position catches an additional update inside this transaction even when
 * its values are unchanged and xmin still names the same transaction. */
export async function assertOutProductSchedule(tx: DbClient, proof: OutProductScheduleProof) {
  const row = await selected(tx, proof.productId, proof.productType);
  if (!row || row.autoOnTime !== proof.autoOnTime || row.autoOffTime !== proof.autoOffTime
    || row.isShow !== proof.isShow || row.rowPosition !== proof.rowPosition) {
    throw new ValidateException('平台商品定时上下架状态已变化');
  }
}
