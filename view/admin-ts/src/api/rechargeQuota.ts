import request, { getData } from '@/utils/request';

export interface RechargeQuotaInput { price: string; give_money: string; sort: number; status: 0 | 1 }
export interface RechargeQuota extends RechargeQuotaInput { id: number; add_time: string; revision: string; valid: boolean }
export interface RechargeQuotaPage { list: RechargeQuota[]; count: number; page: number; limit: number }
export interface RechargeQuotaMutationKey { request_id: string; revision: string }
export type RechargeQuotaSave = RechargeQuotaInput & { request_id: string; revision?: string };

/** Work in integer cents. Never round financial input through a floating-point number. */
export function normalizeRechargeMoney(value: string, field: 'price' | 'give_money'): string {
  const text = value.trim() || (field === 'give_money' ? '0' : '');
  const label = field === 'price' ? '充值金额' : '赠送金额';
  if (!/^\d{1,8}(?:\.\d{1,2})?$/u.test(text)) throw new Error(`${label}须为最多两位小数的非负金额`);
  const [integer, decimal = ''] = text.split('.');
  const fraction = decimal.padEnd(2, '0');
  const cents = BigInt(integer) * 100n + BigInt(fraction);
  const maximum = field === 'price' ? 10_000_000n : 9_999_999_999n;
  if (cents < (field === 'price' ? 1n : 0n) || cents > maximum) {
    throw new Error(field === 'price' ? '充值金额须为 0.01–100000.00 元' : '赠送金额须为 0.00–99999999.99 元');
  }
  return `${BigInt(integer).toString()}.${fraction}`;
}
function integer(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= 2_147_483_647;
}
export function parseRechargeQuota(value: unknown): RechargeQuota {
  const row = value as RechargeQuota | null;
  if (!row || !integer(row.id, 1) || !integer(row.sort) || ![0, 1].includes(row.status) || typeof row.valid !== 'boolean' ||
    typeof row.price !== 'string' || typeof row.give_money !== 'string' || typeof row.add_time !== 'string' ||
    typeof row.revision !== 'string' || !/^[a-f0-9]{64}$/u.test(row.revision)) throw new Error('充值档位记录格式错误');
  if (row.valid) {
    try {
      if (normalizeRechargeMoney(row.price, 'price') !== row.price || normalizeRechargeMoney(row.give_money, 'give_money') !== row.give_money) throw new Error();
    } catch { throw new Error('充值档位金额格式错误'); }
  }
  return row;
}
export function parseRechargeQuotaPage(value: unknown): RechargeQuotaPage {
  const result = value as RechargeQuotaPage | null;
  if (!result || !Array.isArray(result.list) || !Number.isSafeInteger(result.count) || result.count < 0 ||
    result.page !== 1 || result.limit !== 100 || result.list.length > 100 || result.list.length > result.count) throw new Error('充值档位列表格式错误');
  if (result.list.length !== result.count) throw new Error('未取得全部充值档位，请核查历史配置后重新读取');
  const ids = new Set<number>();
  for (const item of result.list) { const row = parseRechargeQuota(item); if (ids.has(row.id)) throw new Error('充值档位记录重复'); ids.add(row.id); }
  return result;
}
function mutationResult(value: unknown, expectedId: number): { id: number } {
  const result = value as { id: number } | null;
  if (!result || !integer(result.id, 1) || (expectedId !== 0 && result.id !== expectedId)) throw new Error('操作响应格式错误，请重新读取档位核对结果');
  return result;
}
export async function apiRechargeQuotaList(signal?: AbortSignal): Promise<RechargeQuotaPage> {
  return parseRechargeQuotaPage(await getData<unknown>(request.get('/marketing/recharge-quotas', { params: { page: 1, limit: 100 }, signal })));
}
export async function apiRechargeQuotaDetail(id: number, signal?: AbortSignal): Promise<RechargeQuota> {
  const row = parseRechargeQuota(await getData<unknown>(request.get(`/marketing/recharge-quotas/${id}`, { signal })));
  if (row.id !== id) throw new Error('充值档位详情与当前记录不一致');
  return row;
}
export async function apiRechargeQuotaSave(id: number, data: RechargeQuotaSave, signal?: AbortSignal): Promise<{ id: number }> {
  const response = id === 0 ? request.post('/marketing/recharge-quotas', data, { signal })
    : request.put(`/marketing/recharge-quotas/${id}`, data, { signal });
  return mutationResult(await getData<unknown>(response), id);
}
export async function apiRechargeQuotaStatus(id: number, data: RechargeQuotaMutationKey & { status: 0 | 1 }, signal?: AbortSignal): Promise<{ id: number }> {
  return mutationResult(await getData<unknown>(request.put(`/marketing/recharge-quotas/${id}/status`, data, { signal })), id);
}
export async function apiRechargeQuotaDelete(id: number, data: RechargeQuotaMutationKey, signal?: AbortSignal): Promise<{ id: number }> {
  return mutationResult(await getData<unknown>(request.delete(`/marketing/recharge-quotas/${id}`, { data, signal })), id);
}
