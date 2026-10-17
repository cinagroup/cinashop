export const SUPPLIER_REFUND_SETTLEMENT_VERSION = 'supplier-refund-settlement-v1' as const;

/** A read-only projection after the complete goods and subsequent money
 * evidence has been checked. It contains no execution or recovery capability. */
export interface SupplierRefundSettlement {
  version: typeof SUPPLIER_REFUND_SETTLEMENT_VERSION;
  state: 'verified';
  order_id: number; order_no: string; uid: number; supplier_id: number; store_id: number;
  refund_id: number; refund_no: string; pay_type: 'cash' | 'offline' | 'yue';
  paid: string; goods_refunded: string; money_refunded: string;
  refunded: string; available: string; money_payouts: number;
}
export interface SupplierRefundSettlementTarget {
  order_id: number; order_no: string; uid: number; supplier_id: number; store_id: number;
  refund_id?: number; refund_no?: string; goods_refunded?: string;
}
const keys = ['version', 'state', 'order_id', 'order_no', 'uid', 'supplier_id', 'store_id', 'refund_id',
  'refund_no', 'pay_type', 'paid', 'goods_refunded', 'money_refunded', 'refunded', 'available', 'money_payouts'];
const id = (value: unknown, zero = false): value is number => typeof value === 'number'
  && Number.isSafeInteger(value) && value >= (zero ? 0 : 1) && value <= 2_147_483_647;
const number = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,50}$/.test(value);
const money = (value: unknown): value is string => typeof value === 'string' && /^(?:0|[1-9]\d{0,9})\.\d{2}$/.test(value);
const cents = (value: string) => BigInt(value.replace('.', ''));
const invalid = () => Error('累计退款核验结果与当前订单或完整款项不匹配，请重新读取');

export function parseSupplierRefundSettlement(value: unknown, expected: SupplierRefundSettlementTarget): SupplierRefundSettlement {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const row = value as Record<string, unknown>, own = Object.keys(row);
  if (own.length !== keys.length || own.some(key => !keys.includes(key))
    || row.version !== SUPPLIER_REFUND_SETTLEMENT_VERSION || row.state !== 'verified'
    || !id(row.order_id) || !id(row.uid, true) || !id(row.supplier_id) || !id(row.store_id, true)
    || !id(row.refund_id) || !number(row.order_no) || !number(row.refund_no)
    || typeof row.pay_type !== 'string' || !['cash', 'offline', 'yue'].includes(row.pay_type)
    || ![row.paid, row.goods_refunded, row.money_refunded, row.refunded, row.available].every(money)
    || !id(row.money_payouts, true) || row.money_payouts > 200) throw invalid();
  for (const key of ['order_id', 'order_no', 'uid', 'supplier_id', 'store_id'] as const) {
    if (row[key] !== expected[key]) throw invalid();
  }
  for (const key of ['refund_id', 'refund_no', 'goods_refunded'] as const) {
    if (expected[key] !== undefined && row[key] !== expected[key]) throw invalid();
  }
  const paid = cents(row.paid as string), first = cents(row.goods_refunded as string),
    later = cents(row.money_refunded as string), refunded = cents(row.refunded as string), available = cents(row.available as string);
  if (paid <= 0n || first <= 0n || first + later !== refunded || refunded + available !== paid
    || (row.money_payouts === 0) !== (later === 0n)) throw invalid();
  // Return a closed copy. Caller-provided properties cannot become capabilities.
  return Object.fromEntries(keys.map(key => [key, row[key]])) as unknown as SupplierRefundSettlement;
}
