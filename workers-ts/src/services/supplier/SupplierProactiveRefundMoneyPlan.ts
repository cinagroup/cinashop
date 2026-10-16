import { ValidateException } from '@/utils/errors';
import { supplierProactiveRefundMoney, supplierProactiveRefundUuid } from './SupplierProactiveRefundInput';

export const SUPPLIER_MONEY_PROVIDER_STATUSES = ['INIT', 'REQUESTING', 'PROCESSING', 'SUCCESS', 'CLOSED', 'ABNORMAL', 'UNKNOWN'] as const;
type ProviderStatus = typeof SUPPLIER_MONEY_PROVIDER_STATUSES[number];
export interface SupplierMoneyCompletion {
  operationId: string;
  amount: string;
  beforeRefunded: string;
  afterRefunded: string;
}
export interface SupplierMoneyPayment {
  operationId: string;
  amount: string;
  status: ProviderStatus;
}
export interface SupplierMoneyHistory {
  paid: string;
  firstGoodsRefund: string;
  payType: 'cash' | 'offline' | 'yue' | 'weixin' | 'alipay';
  completions: readonly SupplierMoneyCompletion[];
  payments: readonly SupplierMoneyPayment[];
}
const invalid = () => new ValidateException('整单退货后的资金补退金额或原渠道凭据不一致，请核对原请求');
function money(value: unknown): bigint {
  const normalized = supplierProactiveRefundMoney(value);
  if (typeof value !== 'string' || value !== normalized) throw invalid();
  return BigInt(normalized.replace('.', ''));
}
function decimal(value: bigint): string {
  if (value < 0n || value > 999999999999n) throw invalid();
  return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
}

/** Monetary arithmetic only: the caller must independently prove the completed
 * whole-goods claim, immutable SQL records and original payment/tenant binding.
 * This cannot create a quantity claim or grant permission to execute a refund.
 * Goods, points, stock, coupon and settlement effects belong to the first claim.
 * Later money rows form a single exact chain from that claim's actual amount.
 * No timestamp ordering, floating point arithmetic or synthetic zero-item claim
 * may substitute for this chain. Provider uncertainty continues to reserve money.
 * This plans a NEW request. A stored provider SUCCESS without its completion
 * must first resume that original operation through its dedicated finalizer;
 * this function cannot authorize or fabricate the missing completion itself. */
export function planSupplierProactiveMoneyRefund(history: SupplierMoneyHistory, requestedAmount: string) {
  const paid = money(history.paid), first = money(history.firstGoodsRefund), requested = money(requestedAmount);
  if (!['cash', 'offline', 'yue', 'weixin', 'alipay'].includes(history.payType)
    || first > paid || first === 0n && paid > 0n || requested <= 0n
    || !Array.isArray(history.completions) || !Array.isArray(history.payments)
    || history.completions.length > 200 || history.payments.length > 200) throw invalid();
  const provider = history.payType === 'weixin' || history.payType === 'alipay';
  const completed = new Map<string, { amount: bigint; before: bigint; after: bigint }>();
  const byBefore = new Map<bigint, { operationId: string; amount: bigint; before: bigint; after: bigint }>();
  for (const row of history.completions) {
    const operationId = supplierProactiveRefundUuid(row.operationId), amount = money(row.amount),
      before = money(row.beforeRefunded), after = money(row.afterRefunded);
    if (completed.has(operationId) || byBefore.has(before) || amount <= 0n || before < first || after !== before + amount || after > paid) throw invalid();
    completed.set(operationId, { amount, before, after });
    byBefore.set(before, { operationId, amount, before, after });
  }
  let refunded = first, visited = 0;
  while (byBefore.has(refunded)) {
    refunded = byBefore.get(refunded)!.after;
    if (++visited > 200) throw invalid();
  }
  if (visited !== completed.size) throw invalid();

  let reserved = 0n;
  const payments = new Set<string>();
  for (const row of history.payments) {
    const operationId = supplierProactiveRefundUuid(row.operationId), amount = money(row.amount);
    if (!provider || payments.has(operationId) || amount <= 0n || !(SUPPLIER_MONEY_PROVIDER_STATUSES as readonly string[]).includes(row.status)) throw invalid();
    payments.add(operationId);
    const completion = completed.get(operationId);
    if (completion) {
      if (row.status !== 'SUCCESS' || completion.amount !== amount) throw invalid();
    } else {
      // SUCCESS is never merely a status string: the atomic completion proof
      // must exist too. ABNORMAL/UNKNOWN do not prove that no payout occurred.
      if (row.status === 'SUCCESS') throw invalid();
      if (row.status !== 'CLOSED') reserved += amount;
    }
  }
  if (provider && [...completed.keys()].some(id => !payments.has(id))) throw invalid();
  const available = paid - refunded - reserved;
  if (available < 0n || requested > available) throw new ValidateException('资金补退金额超过原付款扣除已退及渠道处理中金额后的余额');
  return Object.freeze({ version: 'supplier-proactive-money-plan-v1' as const,
    paid: decimal(paid), first_goods_refund: decimal(first), refunded: decimal(refunded),
    provider_reserved: decimal(reserved), available: decimal(available), requested: decimal(requested),
    after_refunded: decimal(refunded + requested), after_available: decimal(available - requested),
  });
}
