import { createHash } from 'node:crypto';
import { ValidateException } from '@/utils/errors';

export type ConfigClassOperation = 'create' | 'update' | 'status' | 'delete';
export interface ConfigClassRow {
  id: number; is_store: number; pid: number; title: string; eng_title: string;
  status: number; info: number; icon: string; type: number; sort: number;
}
export type ConfigClassValues = Omit<ConfigClassRow, 'id'>;
export interface ConfigClassReceipt {
  operation: ConfigClassOperation; request_id: string | null; actor_id: number;
  id: number; payload_hash: string; revision: string; verified: true;
}
/** Only returned after a live-authorized transaction has explicitly rejected
 * this exact intent and its rollback completed with the original error. */
export class ConfigClassNotApplied extends Error {
  constructor(message: string, readonly httpStatus: 400 | 409, readonly proof: {
    code: 'CONFIG_CLASS_NOT_APPLIED'; operation: ConfigClassOperation; id: number;
    request_id: string; payload_hash: string;
  }) { super(message); }
}
export const CONFIG_CLASS_FIELDS = ['is_store', 'pid', 'title', 'eng_title', 'status', 'info', 'icon', 'type', 'sort'] as const;
export const CONFIG_CLASS_HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
export const configClassHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function configClassObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidateException('配置分类正文必须是对象');
  return value as Record<string, unknown>;
}
export function configClassInteger(value: unknown, label: string, zero = false, max = 2147483647): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^(?:0|[1-9]\d*)$/u.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < (zero ? 0 : 1) || number > max) throw new ValidateException(`${label}必须是范围内整数`);
  return number;
}
function legacyInteger(value: unknown, label: string, fallback: number, max = 2147483647): number {
  const number = value === undefined || value === null || value === '' ? fallback : typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > max) throw new ValidateException(`${label}必须是范围内整数`);
  return number;
}
export function configClassRequestId(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new ValidateException('配置分类请求标识无效');
  return value;
}
function text(value: unknown, label: string, limit: number, required = false): string {
  if (typeof value !== 'string' || [...value].length > limit || /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value) || required && !value.trim()) throw new ValidateException(`${label}无效或超出长度`);
  return value;
}
function legacyText(value: unknown, label: string, limit: number, required = false): string {
  // Preserve SystemMetadataService.textValue's trim, non-string fallback and
  // UTF-16 length contract for callers without an author intent. The new
  // control/unpaired-surrogate rejection remains an explicit safety boundary.
  const result = typeof value === 'string' ? value.trim() : '';
  if (result.length > limit || typeof value === 'string' && /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value) || required && !result) throw new ValidateException(`${label}无效或超出长度`);
  return result;
}
export interface ConfigClassIntent { request_id: string | null; expected_revision: string | null }
export function configClassIntent(body: Record<string, unknown>): ConfigClassIntent {
  const hasRequest = body.request_id !== undefined, hasRevision = body.expected_revision !== undefined;
  if (hasRequest !== hasRevision) throw new ValidateException('配置分类请求标识和版本必须同时提供');
  if (!hasRequest) return { request_id: null, expected_revision: null };
  if (typeof body.expected_revision !== 'string' || !CONFIG_CLASS_HASH.test(body.expected_revision)) throw new ValidateException('配置分类版本无效');
  return { request_id: configClassRequestId(body.request_id), expected_revision: body.expected_revision };
}
export function configClassValues(body: Record<string, unknown>, prior?: ConfigClassRow, legacy = false): ConfigClassValues {
  let parent: unknown = body.pid ?? 0;
  // Original PHP takes the final cascader value. Validate the entire supplied
  // path before applying that same leaf-ID convention; never truncate it.
  if (Array.isArray(parent)) {
    if (parent.length > 5000) throw new ValidateException('父级路径超出容量');
    for (const item of parent) {
      if (legacy) legacyInteger(item, '父级分类', 0);
      else configClassInteger(item, '父级分类', true);
    }
    parent = parent.at(-1) ?? 0;
  }
  const info = prior?.info ?? 0;
  if (body.info !== undefined && (legacy ? legacyInteger(body.info, '历史显示元数据', 0, 255) : configClassInteger(body.info, '历史显示元数据', true, 255)) !== info) throw new ValidateException('历史显示元数据不可修改');
  const readText = legacy ? legacyText : text;
  const number = (value: unknown, label: string, fallback: number, max = 2147483647) => legacy ? legacyInteger(value, label, fallback, max) : configClassInteger(value ?? fallback, label, true, max);
  return {
    is_store: number(body.is_store, '配置类型', 0, 1),
    pid: number(parent, '父级分类', 0),
    title: readText(body.title, '分类名称', 255, true),
    eng_title: readText(body.eng_title, '分类字段', 255, true),
    status: number(body.status, '分类状态', 1, 255),
    info,
    icon: readText(body.icon ?? '', '分类图标', 30),
    type: number(body.type, '分类类型', 0),
    sort: number(body.sort, '分类排序', 0),
  };
}
export function configClassBody(input: unknown, operation: ConfigClassOperation, id: number) {
  const body = configClassObject(input), values = operation === 'create' || operation === 'update';
  const allowed = new Set<string>(['request_id', 'expected_revision', ...(values ? [...CONFIG_CLASS_FIELDS, 'id', 'children'] : operation === 'status' ? ['status'] : [])]);
  if (Object.keys(body).some(key => !allowed.has(key))) throw new ValidateException('配置分类正文含不支持字段');
  if (body.id !== undefined && configClassInteger(body.id, '配置分类ID', true) !== id) throw new ValidateException('配置分类正文与路径ID不一致');
  const intent = configClassIntent(body);
  if (values && intent.request_id && CONFIG_CLASS_FIELDS.some(key => !Object.hasOwn(body, key))) throw new ValidateException('配置分类作者请求字段不完整');
  return { body, intent };
}
export function configClassCanonical(operation: ConfigClassOperation, id: number, intent: ConfigClassIntent, values: ConfigClassValues | null, status: number | null) {
  // This fixed key order is shared with the Admin pending-intent fingerprint.
  return { operation, id, expected_revision: intent.expected_revision, values, status };
}
export function configClassQuery(query: URLSearchParams, allowed: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of query) {
    if (!allowed.includes(key) || Object.hasOwn(result, key)) throw new ValidateException('配置分类查询参数不支持或重复');
    result[key] = value;
  }
  return result;
}
