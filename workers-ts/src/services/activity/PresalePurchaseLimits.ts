import { ValidateException } from '@/utils/errors';

interface LimitConfig { isLimit: number; limitType: number; limitNum: number }
export type PresalePurchaseLimits =
  | { mode: 'none'; quantity: null }
  | { mode: 'per_order' | 'cumulative'; quantity: number };

/** Configuration only, not a remaining user allowance or a quota reservation. */
export function presalePurchaseLimits(product: LimitConfig): PresalePurchaseLimits {
  if (product.isLimit === 0) return { mode: 'none', quantity: null };
  if (product.isLimit !== 1 || ![1, 2].includes(product.limitType) ||
    !Number.isSafeInteger(product.limitNum) || product.limitNum < 1 || product.limitNum > 2_147_483_647) {
    throw new ValidateException('预售限购配置无效');
  }
  return { mode: product.limitType === 1 ? 'per_order' : 'cumulative', quantity: product.limitNum };
}

export function assertPresalePurchaseLimit(limits: PresalePurchaseLimits, quantity: number): void {
  // refundNum includes pending reservations, not only completed refunds. Keep
  // this mode closed until a generation-aware order/refund quota ledger exists.
  if (limits.mode === 'cumulative') throw new ValidateException('累计限购预售暂未开放，请等待订单与退款额度核验完成');
  if (limits.mode === 'per_order' && quantity > limits.quantity) {
    throw new ValidateException(`该预售商品每单限购${limits.quantity}件`);
  }
}
