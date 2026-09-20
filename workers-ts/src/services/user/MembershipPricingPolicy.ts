import type { DbClient } from '@/lib/di';
import { readMembershipPricingSources } from '@/services/order/CheckoutPricingSources';
import { ValidateException } from '@/utils/errors';

/** Matches checkout's normalized integer switches: absent/empty defaults to 1,
 * only integer 1 enables, and malformed values never grant cached rights. */
function enabled(value: string): boolean {
  if (value === '') return true;
  if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new ValidateException('会员计价配置无效');
  }
  return Number(value) === 1;
}

export async function readMembershipPricingPolicy(db: DbClient) {
  const { values, rightRows } = await readMembershipPricingSources(db);
  const paidMemberEnabled = enabled(values.member_card_status);
  const right = rightRows.find(row => row.rightType === 'vip_price');
  return {
    memberFunctionEnabled: enabled(values.member_func_status),
    paidMemberEnabled,
    paidMemberPriceEnabled: paidMemberEnabled && enabled(values.svip_price_status)
      && right?.status === 1 && right.number > 0,
  };
}
