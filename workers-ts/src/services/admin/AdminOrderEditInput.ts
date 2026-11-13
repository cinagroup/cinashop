import { ValidateException } from '@/utils/errors';

export function adminOrderEditId(value: unknown): number {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^[1-9]\d{0,9}$/.test(String(value))
    || Number(value) > 2_147_483_647) throw new ValidateException('订单主键格式错误');
  return Number(value);
}
function decimal(value: unknown, signed = false): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ValidateException('订单金额或积分格式错误');
    // JSON numeric fields from the PHP number widgets must not be rejected by
    // binary multiplication residue (e.g. 1234567890.12 * 100). Validate their
    // decimal rendering before doing exact bounded integer arithmetic.
    value = String(value);
  }
  if (typeof value !== 'string' || !(signed ? /^-?\d{1,10}(?:\.\d{1,2})?$/ : /^\d{1,10}(?:\.\d{1,2})?$/).test(value.trim()))
    throw new ValidateException('订单金额或积分格式错误');
  const cents = BigInt(value.trim().replace('-', '').split('.')[0]) * 100n + BigInt((value.trim().split('.')[1] ?? '').padEnd(2, '0'));
  return `${value.trim().startsWith('-') && cents ? '-' : ''}${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}
/** The original six fields remain sufficient. Modern clients additionally bind
 * a form revision; authority and provenance are always chosen by the server. */
export function parseAdminOrderEditInput(body: Record<string, unknown>) {
  if (typeof body.order_id !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(body.order_id)) throw new ValidateException('订单编号格式错误');
  if (body.revision !== undefined && (typeof body.revision !== 'string' || !/^[a-f0-9]{64}$/.test(body.revision))) throw new ValidateException('订单版本格式错误');
  return { orderId: body.order_id, totalPrice: decimal(body.total_price), totalPostage: decimal(body.total_postage, true),
    payPostage: decimal(body.pay_postage, true), payPrice: decimal(body.pay_price), gainIntegral: decimal(body.gain_integral, true),
    revision: body.revision as string | undefined };
}
export function adminOrderEditPoints(value: string): number {
  if (!/^(0|[1-9]\d{0,9})\.00$/.test(value)) throw new ValidateException('修改后的赠送积分必须是非负整数');
  return Number(value);
}
