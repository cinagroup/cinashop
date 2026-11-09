import { ValidateException } from '@/utils/errors';

const MAX_ID = 2_147_483_647;
const MAX_MONEY_CENTS = 999_999_999_999;
const money = /^(0|[1-9]\d{0,9})\.(\d{2})$/;

export interface RechargeRefundBasis {
  readonly id: number;
  readonly uid: number;
  readonly orderId: string;
  readonly price: string;
  readonly givePrice: string;
  readonly refundPrice: string;
  readonly paid: number;
  readonly nowMoney: string;
  readonly rechargeType: string;
}

export interface RechargeRefundAmounts {
  readonly principalCents: number;
  readonly giftCents: number;
  readonly recoverGift: boolean;
  readonly providerRefundCents: number;
  readonly walletDebitCents: number;
  readonly walletBeforeCents: number;
  readonly walletAfterCents: number;
  readonly providerRefund: string;
  readonly walletDebit: string;
  readonly walletBefore: string;
  readonly walletAfter: string;
}

export function rechargeRefundId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > MAX_ID) {
    throw new ValidateException('充值退款标识无效');
  }
  return value;
}

/** Parse canonical PostgreSQL numeric(12,2) without floating-point arithmetic. */
export function rechargeRefundCents(value: unknown, signed = false): number {
  if (typeof value !== 'string') throw new ValidateException('充值退款金额无效');
  const negative = signed && value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const match = money.exec(unsigned);
  if (!match || match[0] !== unsigned) throw new ValidateException('充值退款金额须为规范两位小数');
  const cents = Number(BigInt(match[1]) * 100n + BigInt(match[2]));
  if (cents > MAX_MONEY_CENTS || negative && cents === 0) throw new ValidateException('充值退款金额超出范围');
  return negative ? -cents : cents;
}

export function rechargeRefundDecimal(cents: number): string {
  if (!Number.isSafeInteger(cents) || Math.abs(cents) > MAX_MONEY_CENTS) {
    throw new ValidateException('充值退款金额超出范围');
  }
  const amount = BigInt(Math.abs(cents));
  return `${cents < 0 ? '-' : ''}${amount / 100n}.${String(amount % 100n).padStart(2, '0')}`;
}

/** Copy database projections before hashing/awaiting. This validates money and
 * identity shape; it does not authorize a principal, payment or provider call. */
export function captureRechargeRefundBasis(value: unknown): Readonly<RechargeRefundBasis> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidateException('充值退款快照无效');
  const names = ['id', 'uid', 'orderId', 'price', 'givePrice', 'refundPrice', 'paid', 'nowMoney', 'rechargeType'];
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(fields).length !== names.length || names.some(name => !fields[name]?.enumerable || !('value' in fields[name]))) {
    throw new ValidateException('充值退款快照字段无效');
  }
  const data = Object.fromEntries(names.map(name => [name, fields[name].value]));
  const id = rechargeRefundId(data.id), uid = rechargeRefundId(data.uid);
  if (typeof data.orderId !== 'string' || data.orderId.trim() !== data.orderId || !/^cz[A-Za-z0-9_-]{1,30}$/.test(data.orderId)
    || typeof data.rechargeType !== 'string' || data.rechargeType.trim() !== data.rechargeType || !/^[a-z][a-z0-9_]{0,31}$/.test(data.rechargeType)
    || data.paid !== 0 && data.paid !== 1) throw new ValidateException('充值退款订单身份无效');
  const price = rechargeRefundCents(data.price), gift = rechargeRefundCents(data.givePrice);
  const refunded = rechargeRefundCents(data.refundPrice);
  rechargeRefundCents(data.nowMoney, true);
  if (price <= 0 || refunded > price || gift < 0) throw new ValidateException('充值退款订单金额异常');
  return Object.freeze({ id, uid, orderId: data.orderId, price: data.price as string,
    givePrice: data.givePrice as string, refundPrice: data.refundPrice as string,
    paid: data.paid, nowMoney: data.nowMoney as string, rechargeType: data.rechargeType });
}

/** Full principal is the provider amount. The operator chooses whether the
 * wallet debit additionally recovers the original gift. The selected product
 * rule requires sufficient available balance BEFORE any provider admission.
 * This function never clamps a debit, permits debt, or infers historic refunds.
 * The caller must reserve this debit under the same wallet row lock as admission. */
export function rechargeRefundIntent(value: unknown, recoverGift: unknown) {
  const basis = captureRechargeRefundBasis(value);
  if (typeof recoverGift !== 'boolean') throw new ValidateException('充值退款赠送额选项无效');
  if (basis.paid !== 1) throw new ValidateException('充值订单未支付');
  if (basis.rechargeType === 'balance') throw new ValidateException('佣金转入余额不能原路退款');
  const principalCents = rechargeRefundCents(basis.price), giftCents = rechargeRefundCents(basis.givePrice);
  const priorRefund = rechargeRefundCents(basis.refundPrice);
  if (priorRefund === principalCents) throw new ValidateException('充值本金已全部退款，请查询原退款回执');
  if (priorRefund !== 0) throw new ValidateException('充值订单存在历史部分退款，须先人工核对归属和渠道结果');
  const walletBeforeCents = rechargeRefundCents(basis.nowMoney, true);
  const walletDebitCents = principalCents + (recoverGift ? giftCents : 0);
  const sufficient = walletBeforeCents >= walletDebitCents;
  // An insufficient request is a durable rejection, with NO wallet mutation.
  // Its requested debit may exceed numeric(12,2); keep integer cents here.
  const walletAfterCents = sufficient ? walletBeforeCents - walletDebitCents : walletBeforeCents;
  return Object.freeze({ basis, principalCents, giftCents, recoverGift, walletBeforeCents,
    walletDebitCents, walletAfterCents, sufficient });
}

export function rechargeRefundAmounts(value: unknown, recoverGift: unknown): Readonly<RechargeRefundAmounts> {
  const { principalCents, giftCents, recoverGift: selected, walletBeforeCents,
    walletDebitCents, walletAfterCents, sufficient } = rechargeRefundIntent(value, recoverGift);
  if (!sufficient) throw new ValidateException('钱包余额不足，充值退款须先人工处理');
  return Object.freeze({ principalCents, giftCents, recoverGift: selected, providerRefundCents: principalCents,
    walletDebitCents, walletBeforeCents, walletAfterCents, providerRefund: rechargeRefundDecimal(principalCents),
    walletDebit: rechargeRefundDecimal(walletDebitCents), walletBefore: rechargeRefundDecimal(walletBeforeCents),
    walletAfter: rechargeRefundDecimal(walletAfterCents) });
}
