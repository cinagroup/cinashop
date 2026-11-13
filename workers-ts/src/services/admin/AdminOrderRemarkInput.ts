import { parseAdminOrderNumber } from './AdminMobileOrderReadService';
import { ValidateException } from '@/utils/errors';

export interface AdminOrderRemarkInput { orderId: string; remark: string }

export function parseAdminOrderRemarkValue(value: unknown): string {
  const remark = typeof value === 'string' ? value.trim() : '';
  if (!remark || remark === '0') throw new ValidateException('请填写备注内容');
  if ([...remark].length > 512) throw new ValidateException('备注不能超过512个字符');
  if (/[\u0000\ud800-\udfff]/u.test(remark)) throw new ValidateException('备注包含无效字符');
  return remark;
}

export function parseAdminOrderRemarkInput(input: Record<string, unknown>): AdminOrderRemarkInput {
  return { orderId: parseAdminOrderNumber(input.order_id), remark: parseAdminOrderRemarkValue(input.remark) };
}
