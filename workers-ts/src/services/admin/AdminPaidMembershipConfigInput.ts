import { ValidateException } from '@/utils/errors';
import { readBoundedUtf8Text } from '@/utils/request-body';
import { parseLevelActivationJson } from './AdminLevelActivationInput';

export const PAID_MEMBERSHIP_CONFIG_KEYS = ['member_card_status', 'svip_price_status'] as const;
export type PaidMembershipConfigKey = typeof PAID_MEMBERSHIP_CONFIG_KEYS[number];
export type PaidMembershipConfigInput = {
  member_card_status: 0 | 1; svip_price_status: 0 | 1; revision: string; request_id: string;
};
export type PaidMembershipConfigDto = {
  settings: Record<PaidMembershipConfigKey, 0 | 1 | null>;
  raw_values: Record<PaidMembershipConfigKey, string | null>;
  missing_keys: PaidMembershipConfigKey[];
  issues: Array<{ key: PaidMembershipConfigKey; message: string }>;
  revision: string;
};
export type PaidMembershipConfigResult = {
  committed: true; revision: string; request_id: string; cache_status: 'cleared' | 'pending';
};

export async function readAdminPaidMembershipConfigBody(request: Request): Promise<unknown> {
  const text = await readBoundedUtf8Text(request, 64 * 1024);
  // Reuse the reviewed recursive duplicate-key tokenizer without expanding the
  // ordinary-level domain or accepting any of its configuration fields.
  try { return parseLevelActivationJson(text); }
  catch (error) {
    if (error instanceof ValidateException) throw new ValidateException(error.message.replaceAll('会员激活', '付费会员'));
    throw error;
  }
}
export function parseAdminPaidMembershipConfigInput(value: unknown): PaidMembershipConfigInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new ValidateException('付费会员配置须为JSON对象');
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => ![...PAID_MEMBERSHIP_CONFIG_KEYS, 'revision', 'request_id'].includes(key))) throw new ValidateException('不支持的付费会员配置字段');
  if (typeof body.revision !== 'string' || !/^[a-f0-9]{64}$/.test(body.revision)) throw new ValidateException('付费会员配置版本无效，请重新读取');
  if (typeof body.request_id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(body.request_id)) throw new ValidateException('请求标识须为UUID');
  const bit = (key: PaidMembershipConfigKey): 0 | 1 => {
    const value = body[key];
    if (value !== 0 && value !== 1) throw new ValidateException(`${key}须明确选择整数0或1`);
    return value;
  };
  return { member_card_status: bit('member_card_status'), svip_price_status: bit('svip_price_status'),
    revision: body.revision, request_id: body.request_id };
}
export async function paidMembershipConfigHash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}
