import { ValidateException } from '@/utils/errors';
import { readBoundedUtf8Text } from '@/utils/request-body';
import { parseLevelActivationJson } from './AdminLevelActivationInput';

export type DistributorResource = 'level' | 'task';
export type DistributorAction = 'create' | 'update' | 'status' | 'delete';
export type DistributorOperation = `${DistributorResource}:${DistributorAction}`;
export interface DistributorLevelValues { name: string; grade: number; image: string; color: string; one_brokerage: number; two_brokerage: number; status: 0 | 1 }
export interface DistributorTaskValues { level_id: number; name: string; type: number; number: number; desc: string; sort: number; status: 0 | 1 }
export type DistributorCanonical =
  | { operation: DistributorOperation; id: number; revision: string; values: DistributorLevelValues | DistributorTaskValues }
  | { operation: DistributorOperation; id: number; revision: string; status: 0 | 1 }
  | { operation: DistributorOperation; id: number; revision: string };
export interface DistributorReceipt { operation: DistributorOperation; id: number; request_id: string; payload_hash: string }
export interface DistributorQuery { page: number; limit: number; offset: number; keyword: string; status?: 0 | 1; level_id?: number }
export const DISTRIBUTOR_CATALOG_LOCK_NAMESPACE = 731_624;
const INT_MAX = 2_147_483_647;
export class DistributorLevelStaleVersion extends ValidateException {
  constructor(public readonly operation: DistributorOperation, public readonly request_id: string, public readonly payload_hash: string) {
    super('分销等级或任务已变化，请重新读取并确认'); this.name = 'DistributorLevelStaleVersion';
  }
}
/** A matching intent was rejected after journal/CAS checks, before business
 * DML. Only a successful transaction rollback may expose its HTTP proof. */
export class DistributorLevelRejected extends ValidateException {
  constructor(message: string, public readonly operation: DistributorOperation, public readonly request_id: string, public readonly payload_hash: string) {
    super(message); this.name = 'DistributorLevelRejected';
  }
}
export function distributorObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new ValidateException('分销数据须为JSON对象');
  return value as Record<string, unknown>;
}
function only(value: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new ValidateException('分销请求包含未知字段');
}
export function distributorInteger(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new ValidateException(`${label}须为${min}至${max}的整数`);
  return value;
}
export function distributorId(value: unknown): number {
  if (!['string', 'number'].includes(typeof value) || !/^[1-9]\d{0,9}$/.test(String(value)) || Number(value) > INT_MAX) throw new ValidateException('分销ID无效');
  return Number(value);
}
export function distributorRequestId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) throw new ValidateException('请求标识须为UUID');
  return value;
}
export function distributorText(value: unknown, maximum: number, label: string, multiline = false, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || [...value].length > maximum
    || (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u : /[\u0000-\u001f\u007f]/u).test(value)
    || [...value].some(c => { const n = c.codePointAt(0)!; return n >= 0xd800 && n <= 0xdfff; })) throw new ValidateException(`${label}文本无效或过长`);
  return value.trim();
}
export function distributorColor(value: unknown): string {
  const color = distributorText(value, 32, '背景颜色');
  if (/^#(?:[a-f0-9]{3}|[a-f0-9]{4}|[a-f0-9]{6}|[a-f0-9]{8})$/i.test(color)) return color;
  const match = /^(rgb|rgba)\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(0(?:\.\d{1,3})?|1(?:\.0{1,3})?))?\s*\)$/i.exec(color);
  if (!match || [match[2], match[3], match[4]].some(n => Number(n) > 255) || (match[1].toLowerCase() === 'rgba') !== (match[5] !== undefined)) throw new ValidateException('背景颜色须为安全的十六进制或RGB颜色');
  return color;
}
/** Stable media only; decoding checks prevent aliases into the signed-asset namespace. No network access. */
export function distributorImage(value: unknown): string {
  const text = distributorText(value, 255, '等级背景图');
  let current = text;
  for (let depth = 0; depth <= 3; depth++) {
    if ((depth === 0 && /\s/u.test(current)) || /[\\\u0000-\u001f\u007f]/u.test(current)) throw new ValidateException('图片地址包含危险字符');
    if (/^\/(?!\/)/u.test(current)) {
      const path = new URL(current, 'https://distributor.invalid').pathname;
      if (path.startsWith('//') || (!/^\/api\/assets\/[1-9]\d*$/.test(text) && path.startsWith('/api/assets/'))) throw new ValidateException('图片须使用未变形的稳定素材地址');
    } else {
      if (!/^https:\/\//i.test(current)) throw new ValidateException('图片只支持HTTPS或站内路径');
      const url = new URL(current);
      if (url.protocol !== 'https:' || url.username || url.password || [...url.searchParams.keys()].some(k => /^(?:signature|sig|token|expires|x-amz-signature|x-goog-signature)$/i.test(k))) throw new ValidateException('不能保存临时签名图片或用户信息');
    }
    if (!/%[a-f0-9]{2}/i.test(current)) break;
    if (depth === 3) throw new ValidateException('图片地址编码层数过深');
    try { current = decodeURIComponent(current); } catch { throw new ValidateException('图片地址编码无效'); }
  }
  if (text.startsWith('/api/assets/')) {
    const match = /^\/api\/assets\/([1-9]\d{0,9})$/.exec(text);
    if (!match || Number(match[1]) > INT_MAX) throw new ValidateException('素材地址须为稳定的规范ID');
  }
  return text;
}
export function distributorLevelValues(value: unknown): DistributorLevelValues {
  const raw = distributorObject(value); only(raw, ['name', 'grade', 'image', 'color', 'one_brokerage', 'two_brokerage', 'status']);
  const one = distributorInteger(raw.one_brokerage, 0, 1000, '一级佣金上浮'), two = distributorInteger(raw.two_brokerage, 0, 1000, '二级佣金上浮');
  if (two > one) throw new ValidateException('二级佣金上浮不能大于一级');
  return { name: distributorText(raw.name, 50, '等级名称'), grade: distributorInteger(raw.grade, 1, 32767, '等级'), image: distributorImage(raw.image),
    color: distributorColor(raw.color), one_brokerage: one, two_brokerage: two, status: distributorInteger(raw.status, 0, 1, '状态') as 0 | 1 };
}
export function distributorTaskValues(value: unknown): DistributorTaskValues {
  const raw = distributorObject(value); only(raw, ['level_id', 'name', 'type', 'number', 'desc', 'sort', 'status']);
  return { level_id: distributorInteger(raw.level_id, 1, INT_MAX, '任务所属等级'), name: distributorText(raw.name, 50, '任务名称'),
    type: distributorInteger(raw.type, 1, 5, '任务类型'), number: distributorInteger(raw.number, 1, INT_MAX, '任务要求'),
    desc: distributorText(raw.desc, 255, '任务说明', true, true), sort: distributorInteger(raw.sort, 0, 32767, '排序'),
    status: distributorInteger(raw.status, 0, 1, '状态') as 0 | 1 };
}
export function distributorCanonical(operation: DistributorOperation, idValue: unknown, value: unknown): { request_id: string; canonical: DistributorCanonical } {
  const raw = distributorObject(value), [resource, action] = operation.split(':') as [DistributorResource, DistributorAction];
  if (!['level', 'task'].includes(resource) || !['create', 'update', 'status', 'delete'].includes(action)) throw new ValidateException('分销操作无效');
  only(raw, ['request_id', 'revision', ...(action === 'create' || action === 'update' ? ['values'] : action === 'status' ? ['status'] : [])]);
  const request_id = distributorRequestId(raw.request_id), id = action === 'create' ? 0 : distributorId(idValue);
  if (typeof raw.revision !== 'string' || !/^[a-f0-9]{64}$/.test(raw.revision)) throw new ValidateException('分销版本无效');
  const revision = raw.revision;
  if (action === 'delete') return { request_id, canonical: { operation, id, revision } };
  if (action === 'status') return { request_id, canonical: { operation, id, revision, status: distributorInteger(raw.status, 0, 1, '状态') as 0 | 1 } };
  return { request_id, canonical: { operation, id, revision, values: resource === 'level' ? distributorLevelValues(raw.values) : distributorTaskValues(raw.values) } };
}
export async function distributorHash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('');
}
export function parseDistributorQuery(value: URLSearchParams | Record<string, unknown>, tasks = false): DistributorQuery {
  const params = value instanceof URLSearchParams ? [...value.entries()] : Object.entries(value), found = new Map<string, unknown>();
  for (const [key, val] of params) {
    if (!['page', 'limit', 'keyword', 'status', ...(tasks ? ['level_id'] : [])].includes(key) || found.has(key)) throw new ValidateException('分销查询包含未知或重复参数'); found.set(key, val);
  }
  const queryInt = (key: string, fallback: number, min: number, max: number) => {
    const raw = found.get(key); if (raw === undefined) return fallback;
    if (!['number', 'string'].includes(typeof raw) || !/^(?:0|[1-9]\d*)$/.test(String(raw))) throw new ValidateException(`${key}参数无效`);
    return distributorInteger(Number(raw), min, max, key);
  };
  const page = queryInt('page', 1, 1, INT_MAX), limit = queryInt('limit', 20, 1, 100), offset = (page - 1) * limit;
  if (offset > 100000) throw new ValidateException('分页偏移超过100000');
  const query: DistributorQuery = { page, limit, offset, keyword: distributorText(found.get('keyword') ?? '', 50, '搜索关键词', false, true) };
  if (found.has('status')) query.status = queryInt('status', 0, 0, 1) as 0 | 1;
  if (tasks) query.level_id = queryInt('level_id', 0, 1, INT_MAX);
  if (tasks && !query.level_id) throw new ValidateException('任务列表必须选择所属等级');
  return query;
}
export async function readDistributorBody(request: Request): Promise<unknown> {
  const type = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/json') throw new ValidateException('分销写入须使用application/json');
  return parseLevelActivationJson(await readBoundedUtf8Text(request, 16 * 1024));
}
