import { ValidateException } from '@/utils/errors';
import { readBoundedUtf8Text } from '@/utils/request-body';

export const LEVEL_ACTIVATION_KEYS = ['member_func_status', 'level_activate_status', 'level_extend_info',
  'level_integral_status', 'level_give_integral', 'level_money_status', 'level_give_money',
  'level_coupon_status', 'level_give_coupon'] as const;
export type LevelActivationKey = typeof LEVEL_ACTIVATION_KEYS[number];
export type LevelFieldReference = { field_key: string; required: 0 | 1 };
export type LevelActivationSettings = {
  member_func_status: 0 | 1; level_activate_status: 0 | 1; level_extend_info: LevelFieldReference[] | null;
  level_integral_status: 0 | 1; level_give_integral: number | null;
  level_money_status: 0 | 1; level_give_money: string | null;
  level_coupon_status: 0 | 1; level_give_coupon: number[] | null;
};
export type LevelActivationInput = Omit<LevelActivationSettings, 'level_extend_info' | 'level_give_integral' | 'level_give_money' | 'level_give_coupon'> & {
  level_extend_info: LevelFieldReference[]; level_give_integral: number; level_give_money: string; level_give_coupon: number[];
  revision: string; request_id: string; coupon_revisions: Array<{ id: number; revision: string | null }>;
};
export type LevelProfileDefinition = {
  info: string; tip: string; format: string; label: string; param: string; single: ''; singlearr: string[];
  use: 0 | 1; user_show: 0 | 1; sort: number;
};
export type LevelProfileOption = { field_key: string; source: 'default' | 'base' | 'selected_legacy';
  definition: LevelProfileDefinition | null; selectable: boolean; issues: string[]; raw: unknown };
export type LevelActivationCouponDto = {
  id: number; title: string; discount_type: number; coupon_price: string; use_min_price: string;
  effective_pay_percent: number | null; scope_type: number; category: number; app_type: number;
  status: number; deleted: boolean; is_permanent: number; remain_count: number; receive_type: number;
  start_time: string | null; end_time: string | null; use_start_time: string | null; use_end_time: string | null;
  valid_days: number; revision: string | null; selectable: boolean; issues: string[];
};
export type LevelActivationConfigDto = {
  settings: LevelActivationSettings; revision: string; missing_keys: LevelActivationKey[];
  raw_values: Record<LevelActivationKey, string | null>; issues: Array<{ key: string; message: string }>;
  effective: { member_enabled: boolean; activation_required: boolean; integral_enabled: boolean; integral: number | null;
    money_enabled: boolean; money_units: string; coupon_enabled: boolean; coupon_ids: number[]; gift_active: boolean };
  profile_options: LevelProfileOption[]; selected_coupons: LevelActivationCouponDto[];
  limits: { fields: number; coupons: number; config_value_characters: number; template_characters: number | null;
    integral_max: number; money_max: string };
};
export type LevelActivationSaveResult = { committed: true; revision: string; request_id: string; cache_status: 'cleared' | 'pending' };

export function levelActivationObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new ValidateException('会员激活配置必须是JSON对象');
  return value as Record<string, unknown>;
}
export function levelActivationWhitelist(value: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new ValidateException('会员激活配置包含不支持的字段');
}
export function levelActivationInteger(value: unknown, label: string, min = 0, max = 2147483647): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new ValidateException(`${label}须为${min}至${max}的整数`);
  return value;
}
export function levelActivationRevision(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new ValidateException('配置或选项版本无效，请重新读取');
  return value;
}
export function levelActivationText(value: unknown, label: string, max = 80, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || [...value].length > max
    || /[\u0000-\u001f\u007f]/u.test(value) || [...value].some(c => { const n = c.codePointAt(0)!; return n >= 0xd800 && n <= 0xdfff; })) {
    throw new ValidateException(`${label}文本无效`);
  }
  return value;
}
export async function levelActivationHash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

/** Validate JSON syntax first, then walk tokens to reject duplicate decoded keys
 * (including escaped aliases) at every nesting level. Never use a reviver, which
 * runs only after JSON.parse has already discarded duplicate members. */
export function parseLevelActivationJson(text: string): unknown {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new ValidateException('会员激活配置JSON无效'); }
  let offset = 0;
  const whitespace = () => { while (/\s/u.test(text[offset] ?? '') && offset < text.length) offset++; };
  const string = () => {
    const start = offset++;
    while (offset < text.length) {
      const next = text[offset++];
      if (next === '\\') offset++;
      else if (next === '"') break;
    }
    return JSON.parse(text.slice(start, offset)) as string;
  };
  const visit = (depth: number) => {
    if (depth > 32) throw new ValidateException('JSON层级过深');
    whitespace();
    if (text[offset] === '{') {
      offset++; whitespace(); const keys = new Set<string>();
      while (text[offset] !== '}') {
        whitespace(); const key = string();
        if (keys.has(key)) throw new ValidateException('JSON字段不能重复');
        keys.add(key); whitespace(); offset++; visit(depth + 1); whitespace();
        if (text[offset] !== ',') break;
        offset++;
      }
      offset++;
    } else if (text[offset] === '[') {
      offset++; whitespace();
      while (text[offset] !== ']') { visit(depth + 1); whitespace(); if (text[offset] !== ',') break; offset++; }
      offset++;
    } else if (text[offset] === '"') string();
    else { while (offset < text.length && !/[\s,}\]]/u.test(text[offset])) offset++; }
  };
  visit(0); return parsed;
}
export async function readAdminLevelActivationBody(request: Request): Promise<unknown> {
  return parseLevelActivationJson(await readBoundedUtf8Text(request, 64 * 1024));
}
export function parseAdminLevelActivationInput(value: unknown): LevelActivationInput {
  const body = levelActivationObject(value);
  levelActivationWhitelist(body, [...LEVEL_ACTIVATION_KEYS, 'revision', 'request_id', 'coupon_revisions']);
  const revision = levelActivationRevision(body.revision);
  if (typeof body.request_id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(body.request_id)) throw new ValidateException('请求标识须为UUID');
  const flag = (key: string) => levelActivationInteger(body[key], key, 0, 1) as 0 | 1;
  if (typeof body.level_give_money !== 'string' || !/^(0|[1-9]\d{0,9})$/.test(body.level_give_money)) throw new ValidateException('赠送余额须为0至9999999999的整元字符串');
  if (!Array.isArray(body.level_extend_info) || body.level_extend_info.length > 64) throw new ValidateException('激活资料须为至多64项数组');
  const fields = body.level_extend_info.map(value => {
    const field = levelActivationObject(value); levelActivationWhitelist(field, ['field_key', 'required']);
    return { field_key: levelActivationRevision(field.field_key), required: levelActivationInteger(field.required, '必填', 0, 1) as 0 | 1 };
  });
  if (new Set(fields.map(field => field.field_key)).size !== fields.length) throw new ValidateException('激活资料不能重复');
  if (!Array.isArray(body.level_give_coupon) || body.level_give_coupon.length > 100) throw new ValidateException('赠券须为至多100项ID数组');
  const ids = body.level_give_coupon.map(id => levelActivationInteger(id, '发行ID', 1)).sort((a, b) => a - b);
  if (new Set(ids).size !== ids.length) throw new ValidateException('发行ID不能重复');
  if (!Array.isArray(body.coupon_revisions) || body.coupon_revisions.length !== ids.length) throw new ValidateException('赠券版本须完整覆盖所选ID');
  const proofs = body.coupon_revisions.map(value => {
    const proof = levelActivationObject(value); levelActivationWhitelist(proof, ['id', 'revision']);
    return { id: levelActivationInteger(proof.id, '发行ID', 1), revision: proof.revision === null ? null : levelActivationRevision(proof.revision) };
  }).sort((a, b) => a.id - b.id);
  if (proofs.some((proof, index) => proof.id !== ids[index])) throw new ValidateException('赠券版本须完整覆盖所选ID');
  return { member_func_status: flag('member_func_status'), level_activate_status: flag('level_activate_status'), level_extend_info: fields,
    level_integral_status: flag('level_integral_status'), level_give_integral: levelActivationInteger(body.level_give_integral, '赠送积分'),
    level_money_status: flag('level_money_status'), level_give_money: body.level_give_money,
    level_coupon_status: flag('level_coupon_status'), level_give_coupon: ids, revision, request_id: body.request_id, coupon_revisions: proofs };
}
export function parseAdminLevelActivationCouponQuery(parameters: URLSearchParams) {
  for (const key of new Set(parameters.keys())) if (!['page', 'limit', 'keyword'].includes(key) || parameters.getAll(key).length !== 1) throw new ValidateException('查询参数未知或重复');
  const integer = (key: string, fallback: number, max: number) => {
    const raw = parameters.get(key); if (raw === null) return fallback;
    if (!/^[1-9]\d*$/.test(raw)) throw new ValidateException('分页参数无效');
    return levelActivationInteger(Number(raw), '分页', 1, max);
  };
  const page = integer('page', 1, 10001), limit = integer('limit', 10, 100), offset = (page - 1) * limit;
  if (offset > 10000) throw new ValidateException('分页偏移不能超过10000');
  return { page, limit, offset, keyword: levelActivationText(parameters.get('keyword') ?? '', '关键词', 100, true).trim() };
}
