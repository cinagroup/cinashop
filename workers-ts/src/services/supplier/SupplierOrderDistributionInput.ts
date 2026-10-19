import { createHmac, timingSafeEqual } from 'node:crypto';
import { parseLevelActivationJson } from '@/services/admin/AdminLevelActivationInput';
import { readBoundedUtf8Text } from '@/utils/request-body';
import { HttpApiException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
export const distributionConflict = (message = '配送信息或权限已变化，请重新读取') => new HttpApiException(message, 409, 409);
export function distributionId(value: unknown): number {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^[1-9]\d{0,9}$/.test(String(value))
    || !Number.isSafeInteger(Number(value)) || Number(value) > 2147483647) throw new ValidateException('配送订单ID无效');
  return Number(value);
}
export function distributionText(value: unknown, max: number, multiline = false): string {
  if (typeof value !== 'string' || [...value].length > max
    || (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u : /[\u0000-\u001f\u007f]/u).test(value)
    || [...value].some(char => char.length === 1 && char.charCodeAt(0) >= 0xd800 && char.charCodeAt(0) <= 0xdfff))
    throw new ValidateException('配送信息格式或长度无效');
  return value;
}
export interface SupplierDistributionInput { expected_revision: string; delivery_name: string; delivery_id: string; fictitious_content: string }
export function distributionInput(value: unknown): SupplierDistributionInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidateException('配送信息须为JSON对象');
  const row = value as Record<string, unknown>, keys = ['expected_revision', 'delivery_name', 'delivery_id', 'fictitious_content'];
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) throw new ValidateException('配送信息须提交完整四字段');
  if (typeof row.expected_revision !== 'string' || !/^[a-f0-9]{64}$/.test(row.expected_revision)) throw new ValidateException('配送信息版本无效');
  return { expected_revision: row.expected_revision, delivery_name: distributionText(row.delivery_name, 64),
    delivery_id: distributionText(row.delivery_id, 64), fictitious_content: distributionText(row.fictitious_content, 500, true) };
}
export async function readDistributionInput(request: Request) {
  if (request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new ValidateException('配送信息须提交JSON');
  return distributionInput(parseLevelActivationJson(await readBoundedUtf8Text(request, 8192)));
}
export function distributionCanonical(value: unknown): string {
  return JSON.stringify(value, (_, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}
export function distributionMac(key: string, value: unknown) {
  if (!key) throw new ServiceUnavailableException('配送信息签名未配置');
  return createHmac('sha256', key).update('cinashop.supplier-distribution.v1\0').update(distributionCanonical(value)).digest('hex');
}
export function assertDistributionRevision(received: string, expected: string) {
  if (!/^[a-f0-9]{64}$/.test(received) || !timingSafeEqual(new TextEncoder().encode(received), new TextEncoder().encode(expected))) throw distributionConflict();
}
