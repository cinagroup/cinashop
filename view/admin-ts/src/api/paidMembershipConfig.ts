import request, { getData } from '@/utils/request';

export const paidMembershipKeys = ['member_card_status', 'svip_price_status'] as const;
export type PaidMembershipKey = typeof paidMembershipKeys[number];
export type PaidMembershipSettings = Record<PaidMembershipKey, 0 | 1 | null>;
export interface PaidMembershipConfig {
  settings: PaidMembershipSettings;
  raw_values: Record<PaidMembershipKey, string | null>;
  missing_keys: PaidMembershipKey[];
  issues: { key: string; message: string }[];
  revision: string;
}
export interface PaidMembershipSave {
  member_card_status: 0 | 1;
  svip_price_status: 0 | 1;
  revision: string;
  request_id: string;
}
export interface PaidMembershipReceipt { committed: true; revision: string; request_id: string; cache_status: 'cleared' | 'pending' }
const flag = (value: unknown): value is 0 | 1 => value === 0 || value === 1;
const revision = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('付费会员配置响应格式错误');
  return value as Record<string, unknown>;
}
export function parsePaidMembershipConfig(value: unknown): PaidMembershipConfig {
  const row = object(value), settings = object(row.settings), raw = object(row.raw_values);
  if (!revision(row.revision) || !paidMembershipKeys.every(key => (settings[key] === null || flag(settings[key])) && (raw[key] === null || typeof raw[key] === 'string')) ||
    !Array.isArray(row.missing_keys) || row.missing_keys.some(key => !(paidMembershipKeys as readonly unknown[]).includes(key)) || new Set(row.missing_keys).size !== row.missing_keys.length ||
    !Array.isArray(row.issues) || row.issues.some(issue => !issue || typeof issue.key !== 'string' || typeof issue.message !== 'string')) throw Error('付费会员配置不完整，请重新读取');
  return row as unknown as PaidMembershipConfig;
}
export function normalizePaidMembershipSave(value: PaidMembershipSettings & { revision: string; request_id: string }): PaidMembershipSave {
  if (!flag(value.member_card_status) || !flag(value.svip_price_status)) throw Error('请明确选择两个开关的开启或关闭，修复缺失或异常配置后再保存');
  if (!revision(value.revision) || !uuid(value.request_id)) throw Error('配置版本或请求 ID 无效，请重新读取');
  return { member_card_status: value.member_card_status, svip_price_status: value.svip_price_status, revision: value.revision, request_id: value.request_id };
}
export async function apiPaidMembershipConfig(signal?: AbortSignal): Promise<PaidMembershipConfig> {
  return parsePaidMembershipConfig(await getData(request.get('/config/paid-membership', { signal })));
}
export async function apiSavePaidMembershipConfig(input: PaidMembershipSave, signal?: AbortSignal): Promise<PaidMembershipReceipt> {
  const body = normalizePaidMembershipSave(input);
  const row = object(await getData(request.post('/config/paid-membership', body, { signal })));
  if (row.committed !== true || !revision(row.revision) || row.request_id !== body.request_id || (row.cache_status !== 'cleared' && row.cache_status !== 'pending')) throw Error('保存回执不完整，结果未确认，请重新读取配置核对');
  return row as unknown as PaidMembershipReceipt;
}
