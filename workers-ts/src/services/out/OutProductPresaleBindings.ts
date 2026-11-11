import { eq, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeProduct } from '@/models/schema';
import { supplierProductScheduleTime } from '@/services/supplier/SupplierProductScheduleInput';
import { ValidateException } from '@/utils/errors';

type Product = typeof storeProduct.$inferSelect;
export interface OutProductPresaleInput {
  isPresaleProduct?: 0 | 1;
  presalePeriod?: [] | [number, number];
  presaleDay?: number;
}
export interface OutProductPresalePlan {
  isPresaleProduct: number; presaleStartTime: number; presaleEndTime: number; presaleDay: number;
  authored: boolean; requireFuture: boolean;
}
function integer(value: unknown, label: string, maximum = 2_147_483_647): number {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^\d+$/.test(String(value).trim())) {
    throw new ValidateException(`${label}格式错误`);
  }
  const result = Number(String(value).trim());
  if (!Number.isSafeInteger(result) || result < 0 || result > maximum) throw new ValidateException(`${label}超出允许范围`);
  return result;
}
function time(value: unknown): number {
  try {
    const result = supplierProductScheduleTime(value === '0' ? 0 : value);
    if (result === undefined) throw new Error('missing');
    return result;
  } catch { throw new ValidateException('预售时间须为合法北京时间、UTC时间或整数秒'); }
}
export function outProductPresaleInput(input: Record<string, unknown>): OutProductPresaleInput {
  const result: OutProductPresaleInput = {};
  if (Object.hasOwn(input, 'is_presale_product') && input.is_presale_product !== undefined) {
    result.isPresaleProduct = integer(input.is_presale_product, '预售开关', 1) as 0 | 1;
  }
  if (Object.hasOwn(input, 'presale_time') && input.presale_time !== undefined) {
    const period = input.presale_time;
    if (!Array.isArray(period) || (period.length !== 0 && period.length !== 2)) throw new ValidateException('预售时间须为空数组或起止时间');
    result.presalePeriod = period.length ? [time(period[0]), time(period[1])] : [];
  }
  if (Object.hasOwn(input, 'presale_day') && input.presale_day !== undefined) result.presaleDay = integer(input.presale_day, '预售发货天数');
  return result;
}

/** Resolve edits only after the product has been locked. Omission preserves
 * historical terms; an explicit disabled switch clears the stored window. */
export function outProductPresalePlan(input: OutProductPresaleInput, existing?: Product): OutProductPresalePlan {
  const authored = input.isPresaleProduct !== undefined || input.presalePeriod !== undefined || input.presaleDay !== undefined;
  const prior = { isPresaleProduct: existing?.isPresaleProduct ?? 0, presaleStartTime: existing?.presaleStartTime ?? 0,
    presaleEndTime: existing?.presaleEndTime ?? 0, presaleDay: existing?.presaleDay ?? 0 };
  if (!authored) return { ...prior, authored: false, requireFuture: false };
  const enabled = input.isPresaleProduct ?? prior.isPresaleProduct;
  if (enabled !== 0 && enabled !== 1) throw new ValidateException('历史预售开关无效，请先修复');
  const day = input.presaleDay ?? prior.presaleDay;
  if (enabled === 0) {
    if (input.presalePeriod?.length) throw new ValidateException('关闭预售时不能设置预售时间');
    const clear = input.isPresaleProduct === 0 || input.presalePeriod !== undefined;
    return { isPresaleProduct: 0, presaleStartTime: clear ? 0 : prior.presaleStartTime,
      presaleEndTime: clear ? 0 : prior.presaleEndTime, presaleDay: day, authored: true, requireFuture: false };
  }
  if (input.presalePeriod && !input.presalePeriod.length) throw new ValidateException('开启预售时必须设置起止时间');
  const [start, end] = input.presalePeriod ?? [prior.presaleStartTime, prior.presaleEndTime];
  if (!start || !end || end < start) throw new ValidateException('预售起止时间无效');
  return { isPresaleProduct: 1, presaleStartTime: start, presaleEndTime: end, presaleDay: day,
    authored: true, requireFuture: input.presalePeriod !== undefined || prior.isPresaleProduct !== 1 };
}
export async function assertOutProductPresale(tx: DbClient, productId: number, plan: OutProductPresalePlan): Promise<void> {
  const [row] = await tx.select({ isPresaleProduct: storeProduct.isPresaleProduct, presaleStartTime: storeProduct.presaleStartTime,
    presaleEndTime: storeProduct.presaleEndTime, presaleDay: storeProduct.presaleDay }).from(storeProduct)
    .where(eq(storeProduct.id, productId)).limit(1);
  if (!row || row.isPresaleProduct !== plan.isPresaleProduct || row.presaleStartTime !== plan.presaleStartTime ||
      row.presaleEndTime !== plan.presaleEndTime || row.presaleDay !== plan.presaleDay) throw new ValidateException('平台商品预售条件已变化');
}
/** Check the actual DB wall clock after acquiring product locks and after all
 * later waits; receipt replay must happen before this time-sensitive check. */
export async function assertOutProductPresaleFuture(tx: DbClient, plan: OutProductPresalePlan): Promise<void> {
  if (!plan.requireFuture) return;
  const [row] = await tx.select({ valid: sql<boolean>`floor(extract(epoch from clock_timestamp())) <= ${plan.presaleStartTime}` })
    .from(sql`(VALUES (1)) AS out_presale_clock(n)`);
  if (!row?.valid) throw new ValidateException('预售开始时间不能小于当前时间');
}
