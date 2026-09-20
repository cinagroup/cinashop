import { ValidateException } from '@/utils/errors';

/** Allocate an already admitted total in stable cart order. Null precision is
 * an exact truncated ratio; PHP points use a four-place truncated weight ratio.
 * Template postage uses six places then rounds to cents (PHP sprintf). Cap each
 * rounded share at the still-unallocated total to prevent PHP's aggregate
 * rounding overflow. The last positive-weight line owns all residue. */
export function allocateCheckoutLineUnits(
  total: number, weights: readonly number[], precision: 4 | 6 | null,
): number[] {
  if (!Number.isSafeInteger(total) || total < 0 || !weights.length || weights.length > 200
    || weights.some(weight => !Number.isSafeInteger(weight) || weight < 0)
    || (precision !== null && precision !== 4 && precision !== 6)) {
    throw new ValidateException('订单行级分摊数据无效');
  }
  const sum = weights.reduce((value, weight) => value + BigInt(weight), 0n);
  if (total === 0) return weights.map(() => 0);
  if (sum === 0n) throw new ValidateException('订单行级分摊缺少有效基数');
  const last = weights.reduce((index, weight, current) => weight > 0 ? current : index, -1);
  let remaining = BigInt(total);
  return weights.map((weight, index) => {
    if (!weight) return 0;
    const factor = precision === null ? null : 10n ** BigInt(precision);
    const proposed = index === last ? remaining : factor === null
      ? BigInt(total) * BigInt(weight) / sum
      : ((BigInt(weight) * factor / sum) * BigInt(total) + (precision === 6 ? factor / 2n : 0n)) / factor;
    const share = proposed < remaining ? proposed : remaining;
    remaining -= share;
    return Number(share);
  });
}

/** Keep existing PHP discount shares wherever they fit. Only redistribute a
 * rounding residue that exceeds a line's remaining merchandise amount. Coupon,
 * first-order and points discounts are admitted in that order by the caller. */
export function fitCheckoutLineCapacities(proposed: readonly number[], capacities: readonly number[]): number[] {
  if (!proposed.length || proposed.length > 200 || proposed.length !== capacities.length
    || [...proposed, ...capacities].some(value => !Number.isSafeInteger(value) || value < 0)) {
    throw new ValidateException('订单行级优惠容量无效');
  }
  const result = proposed.map((value, index) => Math.min(value, capacities[index]));
  let residue = proposed.reduce((sum, value, index) => sum + BigInt(value - result[index]), 0n);
  // Prefer the last eligible line, as for the original PHP residue. Do not
  // change a quoted total or silently discard excess discounts.
  for (let index = result.length - 1; index >= 0 && residue > 0n; index--) {
    const room = BigInt(capacities[index] - result[index]);
    const moved = room < residue ? room : residue;
    result[index] += Number(moved); residue -= moved;
  }
  if (residue !== 0n) throw new ValidateException('订单行级优惠超过商品金额');
  return result;
}
