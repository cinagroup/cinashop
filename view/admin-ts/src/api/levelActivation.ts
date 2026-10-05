import request, { getData } from '@/utils/request';

export interface LevelProfileSelection { field_key: string; required: 0 | 1 }
export interface LevelActivationSettings {
  member_func_status: 0 | 1; level_activate_status: 0 | 1;
  level_extend_info: LevelProfileSelection[] | null;
  level_integral_status: 0 | 1; level_give_integral: number | null;
  level_money_status: 0 | 1; level_give_money: string | null;
  level_coupon_status: 0 | 1; level_give_coupon: number[] | null;
}
export interface LevelProfileDefinition {
  info: string; tip: string; format: string; label: string; param: string;
  single: ''; singlearr: string[]; use: 0 | 1; user_show: 0 | 1; sort: number;
}
export interface LevelProfileOption {
  field_key: string; source: 'default' | 'base' | 'selected_legacy';
  definition: LevelProfileDefinition | null; selectable: boolean; issues: string[]; raw: unknown;
}
export interface LevelCoupon {
  id: number; title: string; revision: string | null; selectable: boolean; issues: string[];
  discount_type: number; coupon_price: string; use_min_price: string; effective_pay_percent: number | null; scope_type: number; deleted: boolean;
  status: number; category: number; app_type: number; receive_type: number;
  is_permanent: number; remain_count: number; valid_days: number;
  start_time: string | null; end_time: string | null; use_start_time: string | null; use_end_time: string | null;
}
export interface LevelActivationConfig {
  settings: LevelActivationSettings; revision: string; missing_keys: string[];
  issues: { key: string; message: string }[]; raw_values: Record<string, string | null>;
  effective: { member_enabled: boolean; activation_required: boolean; integral_enabled: boolean; integral: number | null;
    money_enabled: boolean; money_units: string; coupon_enabled: boolean; coupon_ids: number[]; gift_active: boolean };
  profile_options: LevelProfileOption[]; selected_coupons: LevelCoupon[];
  limits: { fields: number; coupons: number; config_value_characters: number; template_characters: number | null; integral_max: number; money_max: string };
}
export interface LevelActivationSave extends LevelActivationSettings {
  request_id: string; revision: string; coupon_revisions: { id: number; revision: string | null }[];
}
export interface LevelCouponQuery { page: number; limit: number; keyword: string }
export interface LevelCouponPage { list: LevelCoupon[]; count: number; page: number; limit: number }
export interface LevelActivationReceipt { committed: true; revision: string; request_id: string; cache_status: 'cleared' | 'pending' }
export const levelActivationKeys = ['member_func_status', 'level_activate_status', 'level_extend_info', 'level_integral_status',
  'level_give_integral', 'level_money_status', 'level_give_money', 'level_coupon_status', 'level_give_coupon'] as const;
const flags = ['member_func_status', 'level_activate_status', 'level_integral_status', 'level_money_status', 'level_coupon_status'] as const;
const integer = (v: unknown, min = 0, max = 2147483647): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const revision = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const flag = (v: unknown): v is 0 | 1 => v === 0 || v === 1;
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');
const ids = (v: unknown): v is number[] => Array.isArray(v) && v.every(x => integer(x, 1)) && new Set(v).size === v.length;
function object(v: unknown): Record<string, unknown> { if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('等级激活响应格式错误'); return v as Record<string, unknown>; }
function date(v: unknown) { return v === null || typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v; }
export function levelMoney(value: string): string {
  if (!/^(0|[1-9]\d{0,9})$/u.test(value)) throw Error('赠送余额须为0–9999999999的整数元，不接受小数或指数');
  return value;
}
function selections(v: unknown): v is LevelProfileSelection[] {
  return Array.isArray(v) && v.every(x => x && typeof x === 'object' && revision(x.field_key) && flag(x.required)) && new Set(v.map(x => x.field_key)).size === v.length;
}
export function parseLevelCoupon(value: unknown): LevelCoupon {
  const row = object(value);
  if (!integer(row.id, 1) || typeof row.title !== 'string' || !(row.revision === null || revision(row.revision)) || typeof row.selectable !== 'boolean' || !strings(row.issues) ||
    !['coupon_price', 'use_min_price'].every(key => typeof row[key] === 'string') ||
    !['discount_type', 'scope_type', 'status', 'category', 'app_type', 'receive_type', 'is_permanent', 'remain_count', 'valid_days'].every(key => integer(row[key], -2147483648)) || typeof row.deleted !== 'boolean' ||
    !(row.effective_pay_percent === null || integer(row.effective_pay_percent, -2147483648)) ||
    ![row.start_time, row.end_time, row.use_start_time, row.use_end_time].every(date) || row.selectable && row.revision === null) throw Error('等级赠券记录格式错误');
  return row as unknown as LevelCoupon;
}
export function parseLevelActivation(value: unknown): LevelActivationConfig {
  const row = object(value), settings = object(row.settings), effective = object(row.effective), raw = object(row.raw_values), limits = object(row.limits);
  if (!revision(row.revision) || !strings(row.missing_keys) || row.missing_keys.some(key => !(levelActivationKeys as readonly string[]).includes(key)) ||
    !Array.isArray(row.issues) || row.issues.some(x => !x || typeof x.key !== 'string' || typeof x.message !== 'string') ||
    !flags.every(key => flag(settings[key])) || !(settings.level_give_integral === null || integer(settings.level_give_integral)) ||
    !(settings.level_give_money === null || typeof settings.level_give_money === 'string' && /^(0|[1-9]\d{0,9})$/u.test(settings.level_give_money)) ||
    !(settings.level_give_coupon === null || ids(settings.level_give_coupon)) || !(settings.level_extend_info === null || selections(settings.level_extend_info)) ||
    !levelActivationKeys.every(key => raw[key] === null || typeof raw[key] === 'string') ||
    !['member_enabled', 'activation_required', 'integral_enabled', 'money_enabled', 'coupon_enabled', 'gift_active'].every(key => typeof effective[key] === 'boolean') ||
    !(effective.integral === null || typeof effective.integral === 'number' && Number.isFinite(effective.integral) && effective.integral >= 0) || typeof effective.money_units !== 'string' ||
    !Array.isArray(effective.coupon_ids) || effective.coupon_ids.some(id => !integer(id, 1, Number.MAX_SAFE_INTEGER)) || new Set(effective.coupon_ids).size !== effective.coupon_ids.length ||
    !Array.isArray(row.profile_options) || !Array.isArray(row.selected_coupons) || limits.fields !== 64 || limits.coupons !== 100 || limits.config_value_characters !== 5000 ||
    !(limits.template_characters === null || integer(limits.template_characters)) || limits.integral_max !== 2147483647 || limits.money_max !== '9999999999') throw Error('等级激活配置不完整，请重新读取');
  const profiles = row.profile_options.map(v => {
    const option = object(v);
    if (!revision(option.field_key) || !['default', 'base', 'selected_legacy'].includes(String(option.source)) || typeof option.selectable !== 'boolean' || !strings(option.issues)) throw Error('激活资料候选格式错误');
    if (option.definition !== null) {
      const definition = object(option.definition);
      if (!['info', 'tip', 'format', 'label', 'param', 'single'].every(key => typeof definition[key] === 'string') || !strings(definition.singlearr) || !integer(definition.sort) ||
        definition.single !== '' || !['use', 'user_show'].every(key => flag(definition[key]))) throw Error('激活资料定义格式错误');
    } else if (option.selectable) throw Error('可选资料缺少服务端定义');
    return option as unknown as LevelProfileOption;
  });
  const coupons = row.selected_coupons.map(parseLevelCoupon);
  if (new Set(profiles.map(x => x.field_key)).size !== profiles.length || new Set(coupons.map(x => x.id)).size !== coupons.length ||
    settings.level_extend_info !== null && (settings.level_extend_info as LevelProfileSelection[]).some(x => !profiles.some(p => p.field_key === x.field_key)) ||
    settings.level_give_coupon !== null && ((settings.level_give_coupon as number[]).length !== coupons.length || (settings.level_give_coupon as number[]).some(id => !coupons.some(c => c.id === id)))) throw Error('已选资料或优惠券响应不完整，不能静默丢弃');
  return row as unknown as LevelActivationConfig;
}
export function normalizeLevelActivation(value: LevelActivationSave): LevelActivationSave {
  if (!revision(value.revision) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value.request_id)) throw Error('配置版本或请求ID无效');
  if (!flags.every(key => flag(value[key]))) throw Error('开关须为开启或关闭');
  if (!integer(value.level_give_integral)) throw Error('请明确修复并填写0–2147483647的整数积分');
  if (typeof value.level_give_money !== 'string') throw Error('请明确修复并填写整数元余额');
  levelMoney(value.level_give_money);
  if (!selections(value.level_extend_info) || value.level_extend_info.length > 64) throw Error('请明确修复资料集合，最多选择64项');
  if (!ids(value.level_give_coupon) || value.level_give_coupon.length > 100) throw Error('请明确修复优惠券集合，最多选择100张');
  if (!Array.isArray(value.coupon_revisions) || value.coupon_revisions.length !== value.level_give_coupon.length ||
    value.coupon_revisions.some(row => !integer(row.id, 1) || !(row.revision === null || revision(row.revision)) || !value.level_give_coupon!.includes(row.id)) ||
    new Set(value.coupon_revisions.map(row => row.id)).size !== value.coupon_revisions.length) throw Error('优惠券版本不完整，请重新选择');
  return { member_func_status: value.member_func_status, level_activate_status: value.level_activate_status,
    level_extend_info: value.level_extend_info.map(row => ({ field_key: row.field_key, required: row.required })),
    level_integral_status: value.level_integral_status, level_give_integral: value.level_give_integral,
    level_money_status: value.level_money_status, level_give_money: value.level_give_money,
    level_coupon_status: value.level_coupon_status, level_give_coupon: [...value.level_give_coupon],
    revision: value.revision, request_id: value.request_id, coupon_revisions: value.coupon_revisions.map(row => ({ id: row.id, revision: row.revision })) };
}
export async function apiLevelActivation(signal?: AbortSignal): Promise<LevelActivationConfig> {
  return parseLevelActivation(await getData(request.get('/config/level-activation', { signal })));
}
export async function apiLevelActivationCoupons(query: LevelCouponQuery, signal?: AbortSignal): Promise<LevelCouponPage> {
  if (!integer(query.page, 1) || !integer(query.limit, 1, 100) || (query.page - 1) * query.limit > 10000 || [...query.keyword.trim()].length > 100 || /[\u0000-\u001f\u007f]/u.test(query.keyword)) throw Error('赠券查询或分页范围无效');
  const row = object(await getData(request.get('/config/level-activation/coupons', { params: query, signal })));
  if (!Array.isArray(row.list) || !integer(row.count) || row.page !== query.page || row.limit !== query.limit || row.list.length > query.limit || row.list.length > row.count) throw Error('赠券分页响应与请求不一致');
  const list = row.list.map(parseLevelCoupon);
  if (new Set(list.map(x => x.id)).size !== list.length) throw Error('赠券分页记录重复');
  return { list, count: row.count, page: query.page, limit: query.limit };
}
export async function apiSaveLevelActivation(value: LevelActivationSave, signal?: AbortSignal): Promise<LevelActivationReceipt> {
  const body = normalizeLevelActivation(value), row = object(await getData(request.post('/config/level-activation', body, { signal })));
  if (row.committed !== true || row.request_id !== body.request_id || !revision(row.revision) || !['cleared', 'pending'].includes(String(row.cache_status))) throw Error('保存响应未确认，请只重新读取配置核对');
  return row as unknown as LevelActivationReceipt;
}
