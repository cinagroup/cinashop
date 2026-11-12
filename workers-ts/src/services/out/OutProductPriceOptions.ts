import { ValidateException } from '@/utils/errors';

type Row = Record<string, unknown>;
export interface OutProductPriceOptions { isVip: 0 | 1; isSub: 0 | 1 }

/** PHP's is_sub editor array combines independent member-price (0) and
 * SKU-specific commission (1) switches. Omission retains historical Out
 * behavior and must not alter existing idempotency hashes. */
export function outProductPriceOptions(input: Row): OutProductPriceOptions | undefined {
  if (!Object.hasOwn(input, 'is_sub') || input.is_sub === undefined) return undefined;
  if (!Array.isArray(input.is_sub) || input.is_sub.length > 2) throw new ValidateException('会员价与佣金选项格式错误');
  const selected = input.is_sub.map(value => {
    if (value !== 0 && value !== 1 && value !== '0' && value !== '1') throw new ValidateException('会员价与佣金选项格式错误');
    return Number(value);
  });
  if (new Set(selected).size !== selected.length) throw new ValidateException('会员价与佣金选项不能重复');
  return { isVip: selected.includes(0) ? 1 : 0, isSub: selected.includes(1) ? 1 : 0 };
}

/** PHP clears commissions before validating SKU prices when the switch is off. */
export function outProductPriceAttrs(value: unknown, options: OutProductPriceOptions | undefined): unknown {
  if (!options || options.isSub === 1) return value;
  const clear = (row: unknown) => row && typeof row === 'object' && !Array.isArray(row)
    ? { ...row as Row, brokerage: 0, brokerage_two: 0 } : row;
  if (Array.isArray(value)) return value.map(clear);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Row).map(([key, row]) => [key, clear(row)]));
  return value;
}
