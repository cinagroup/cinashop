import request, { getData } from '@/utils/request';

export interface SeckillTimeInput { title: string; start_time: string; end_time: string; pic: string; describe: string; status: 0 | 1 }
export interface SeckillTime extends SeckillTimeInput { id: number; valid: boolean; revision: string; pic_preview?: string }
export interface SeckillTimeQuery { page: number; limit: number; title?: string; status?: '' | 0 | 1 }
export interface SeckillTimePage { list: SeckillTime[]; count: number; page: number; limit: number }
export interface SeckillTimeMutationKey { request_id: string; revision: string }
export type SeckillTimeSave = SeckillTimeInput & { request_id: string; revision?: string };

function integer(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= 2_147_483_647;
}
export function timeMinutes(value: string, end = false): number {
  if (end && value === '24:00') return 1440;
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value)) throw new Error('时间须为 HH:mm，结束时间可为 24:00');
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}
export function normalizeSeckillTimeInput(value: SeckillTimeInput): SeckillTimeInput {
  const result: SeckillTimeInput = { title: value.title.trim(), pic: value.pic.trim(), describe: value.describe.trim(), start_time: value.start_time, end_time: value.end_time, status: value.status };
  for (const [key, label] of [['title', '时段名称'], ['pic', '时段图片'], ['describe', '时段描述']] as const) {
    if (!result[key] || Array.from(result[key]).length > 255 || /[\u0000-\u001f\u007f]/u.test(result[key])) throw new Error(`${label}须为 1–255 字，不能包含控制字符`);
  }
  if (!imagePreview(result.pic)) throw new Error('时段图片须为 HTTPS 地址或站内图片路径');
  if (!result.pic.startsWith('/')) {
    const url = new URL(result.pic);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('时段图片须为不含账号密码的 HTTPS 地址');
  }
  if (timeMinutes(result.start_time) >= timeMinutes(result.end_time, true)) throw new Error('开始时间必须早于结束时间，时段不能跨午夜');
  if (![0, 1].includes(result.status)) throw new Error('状态须为显示或隐藏');
  return result;
}
/** Never render untrusted URL schemes from historical records. */
export function imagePreview(value: string): string {
  return /^(?:https?:\/\/|\/(?!\/))/iu.test(value) && !/[\u0000-\u0020\u007f\\]/u.test(value) ? value : '';
}
export function parseSeckillTime(value: unknown): SeckillTime {
  const row = value as SeckillTime | null;
  if (!row || !integer(row.id, 1) || ![0, 1].includes(row.status) || typeof row.valid !== 'boolean' ||
    !['title', 'start_time', 'end_time', 'pic', 'describe'].every(key => typeof (row as unknown as Record<string, unknown>)[key] === 'string') ||
    typeof row.revision !== 'string' || !/^[a-f0-9]{64}$/u.test(row.revision) ||
    (row.pic_preview !== undefined && typeof row.pic_preview !== 'string')) throw new Error('秒杀时段记录格式错误');
  if (row.valid) { try { normalizeSeckillTimeInput(row); } catch { throw new Error('秒杀时段内容格式错误'); } }
  return row;
}
export function parseSeckillTimePage(value: unknown, query: SeckillTimeQuery): SeckillTimePage {
  const result = value as SeckillTimePage | null;
  if (!result || !Array.isArray(result.list) || !integer(result.count) || result.page !== query.page || result.limit !== query.limit ||
    result.list.length > query.limit || result.list.length > result.count) throw new Error('秒杀时段分页响应格式错误');
  const ids = new Set<number>();
  for (const value of result.list) { const row = parseSeckillTime(value); if (ids.has(row.id)) throw new Error('秒杀时段记录重复'); ids.add(row.id); }
  return result;
}
function mutationResult(value: unknown, expectedId: number): { id: number } {
  const result = value as { id: number } | null;
  if (!result || !integer(result.id, 1) || (expectedId !== 0 && result.id !== expectedId)) throw new Error('操作响应格式错误，请重新读取时段核对结果');
  return result;
}
export async function apiSeckillTimeList(params: SeckillTimeQuery, signal?: AbortSignal): Promise<SeckillTimePage> {
  return parseSeckillTimePage(await getData<unknown>(request.get('/activity/seckill-times', { params, signal })), params);
}
export async function apiSeckillTimeDetail(id: number, signal?: AbortSignal): Promise<SeckillTime> {
  const row = parseSeckillTime(await getData<unknown>(request.get(`/activity/seckill-times/${id}`, { signal })));
  if (row.id !== id) throw new Error('秒杀时段详情与当前记录不一致');
  return row;
}
export async function apiSeckillTimeSave(id: number, data: SeckillTimeSave, signal?: AbortSignal): Promise<{ id: number }> {
  const response = id === 0 ? request.post('/activity/seckill-times', data, { signal }) : request.put(`/activity/seckill-times/${id}`, data, { signal });
  return mutationResult(await getData<unknown>(response), id);
}
export async function apiSeckillTimeStatus(id: number, data: SeckillTimeMutationKey & { status: 0 | 1 }, signal?: AbortSignal): Promise<{ id: number }> {
  return mutationResult(await getData<unknown>(request.put(`/activity/seckill-times/${id}/status`, data, { signal })), id);
}
export async function apiSeckillTimeDelete(id: number, data: SeckillTimeMutationKey, signal?: AbortSignal): Promise<{ id: number }> {
  return mutationResult(await getData<unknown>(request.delete(`/activity/seckill-times/${id}`, { data, signal })), id);
}
