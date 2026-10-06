import request, { getData } from '@/utils/request';

export interface CouponIssueInput {
  title: string; discount_type: 1 | 2; scope_type: 0 | 1 | 2 | 3; category: 0 | 2;
  category_id: number; brand_id: number; product_ids: number[]; coupon_price: string; use_min_price: string;
  valid_days: number; use_start_time: string | null; use_end_time: string | null; start_time: string | null; end_time: string | null;
  receive_type: 1 | 2 | 3 | 4; is_permanent: 0 | 1; total_count: number; rule: string; status: 0 | 1; sort: number;
}
export interface CouponIssueProduct { id: number; store_name: string; deleted: boolean }
export interface CouponIssueRow {
  id: number; title: string; discount_type: number; scope_type: number; category: number; category_id: number; brand_id: number;
  product_ids: number[]; coupon_price: string; use_min_price: string; valid_days: number;
  use_start_time: string | null; use_end_time: string | null; start_time: string | null; end_time: string | null;
  receive_type: number; status: number; deleted: boolean; is_permanent: number; total_count: number; remain_count: number;
  receive_limit: number; rule: string; sort: number; add_time: number; cid: number; app_type: number;
  source_template: { template_id: number; source_revision: string } | null; revision: string; valid: boolean; issues: string[];
  category_name: string; brand_name: string; products: CouponIssueProduct[]; copy_input: CouponIssueInput | null;
}
export interface CouponIssueOptions {
  categories: { id: number; pid: number; cate_name: string }[];
  brands: { id: number; pid: number; brand_name: string }[];
  max_products: 100; max_product_ids_length: 500;
}
export interface CouponIssuePage<T> { list: T[]; count: number; page: number; limit: number }
export interface CouponIssueQuery { page: number; limit: number; keyword?: string; status?: '' | -1 | 0 | 1; discount_type?: '' | 1 | 2; receive_type?: '' | 1 | 2 | 3 | 4 }
export interface CouponIssueClaim { id: number | null; row_key: string; uid: number | null; nickname: string; avatar_preview: string | null; add_time: number; missing_user: boolean; deleted_user: boolean }
export interface CouponIssueClaims extends CouponIssuePage<CouponIssueClaim> { issue_id: number; source: 'issue_log' | 'owned' }
export interface CouponIssueCreate extends CouponIssueInput { request_id: string; source_id: number; source_revision: string | null }
export interface CouponIssueKey { request_id: string; revision: string }
export interface CouponIssueNode { value: number; label: string; children?: CouponIssueNode[] }
const int = (v: unknown, min = 0, max = 2147483647): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const signed = (v: unknown) => int(v, -2147483648);
const flag = (v: unknown): v is 0 | 1 => v === 0 || v === 1;
const revision = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
function object(v: unknown): Record<string, unknown> { if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('优惠券发行响应格式错误'); return v as Record<string, unknown>; }
export function couponIssueMoney(v: string, positive = false): string {
  if (typeof v !== 'string' || !/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/u.test(v)) throw Error('金额须为最多10位整数、2位小数的十进制字符串');
  const [whole, fraction = ''] = v.split('.');
  if (positive && BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')) === 0n) throw Error('面额或折扣必须大于0');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}
function date(v: unknown): v is string | null {
  if (v === null) return true;
  if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/u.test(v)) return false;
  const normalized = v.replace(/(?:\.(\d{1,3}))?Z$/u, (_match, fraction: string | undefined) => `.${(fraction ?? '').padEnd(3, '0')}Z`);
  return Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === normalized;
}
function readDate(v: unknown): v is string | null {
  return date(v) || typeof v === 'string' && /^[+-]\d{6}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
}
export function couponIssueUtc(value: string): string | null {
  if (!value) return null;
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?$/u.test(value)) throw Error('请填写完整的上海时间');
  const seconds = value.length === 16 ? `${value}:00` : value;
  const normalized = seconds.includes('.') ? seconds.padEnd(23, '0') : `${seconds}.000`;
  const result = new Date(`${normalized}+08:00`);
  if (!Number.isFinite(result.getTime()) || new Date(result.getTime() + 8 * 3600000).toISOString().slice(0, 23) !== normalized) throw Error('日期无效');
  return result.toISOString();
}
export function couponIssueLocal(value: string | null): string {
  return value ? new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 23).replace(/\.000$/u, '') : '';
}
function inputIds(value: unknown): number[] {
  if (!Array.isArray(value) || value.length > 100 || value.some(id => !int(id, 1)) || new Set(value).size !== value.length || value.join(',').length > 500) throw Error('商品范围须完整且不重复，最多100项且ID不超过500字符');
  return [...value].sort((a, b) => a - b);
}
export function normalizeCouponIssue(value: CouponIssueInput): CouponIssueInput {
  if (typeof value.title !== 'string' || value.title.length > 128 || /[\u0000-\u001f\u007f]/u.test(value.title)) throw Error('优惠券名称无效');
  const title = value.title.trim().normalize('NFC');
  if (!title || [...title].length > 64) throw Error('优惠券名称须为1–64个字符');
  if (![1, 2].includes(value.discount_type) || ![0, 1, 2, 3].includes(value.scope_type) || ![0, 2].includes(value.category)) throw Error('优惠类型、适用范围或普通/会员种类无效');
  if (!int(value.category_id) || !int(value.brand_id)) throw Error('分类或品牌ID无效');
  const product_ids = inputIds(value.product_ids);
  if ((value.scope_type === 0 && (value.category_id || value.brand_id || product_ids.length)) ||
    (value.scope_type === 1 && (!value.category_id || value.brand_id || product_ids.length)) ||
    (value.scope_type === 2 && (value.category_id || value.brand_id || !product_ids.length)) ||
    (value.scope_type === 3 && (value.category_id || !value.brand_id || product_ids.length))) throw Error('请选择完整的适用范围，并清除其他范围选择');
  const coupon_price = couponIssueMoney(value.coupon_price, true), use_min_price = couponIssueMoney(value.use_min_price);
  if (value.discount_type === 2 && BigInt(coupon_price.replace('.', '')) > 10000n) throw Error('折扣百分数须大于0且不超过100');
  if (!int(value.valid_days, 0, 3650)) throw Error('领券后有效天数须为1–3650');
  for (const v of [value.start_time, value.end_time, value.use_start_time, value.use_end_time]) if (!date(v)) throw Error('时间须为精确UTC时间或留空');
  const pair = (start: string | null, end: string | null, label: string) => {
    if (Boolean(start) !== Boolean(end) || start && end && Date.parse(start) >= Date.parse(end)) throw Error(`${label}起止须完整且结束晚于开始`);
  };
  pair(value.start_time, value.end_time, '领取时间'); pair(value.use_start_time, value.use_end_time, '使用时间');
  if (value.valid_days > 0 ? !!(value.use_start_time || value.use_end_time) : !(value.use_start_time && value.use_end_time)) throw Error('领后天数与固定使用区间须二选一');
  if (value.use_start_time && value.start_time && Date.parse(value.use_start_time) < Date.parse(value.start_time)) throw Error('使用开始不能早于领取开始');
  if (value.use_end_time && value.end_time && Date.parse(value.use_end_time) < Date.parse(value.end_time)) throw Error('使用结束不能早于领取结束');
  if (![1, 2, 3, 4].includes(value.receive_type) || value.category === 2 && ![1, 4].includes(value.receive_type)) throw Error('会员券只能手动领取或保留既有会员发放方式');
  if (!flag(value.is_permanent) || !int(value.total_count) || (value.is_permanent ? value.total_count !== 0 : value.total_count === 0)) throw Error('不限量发行量须为0，限量发行量须大于0');
  if (value.receive_type === 2 && (!value.is_permanent || value.total_count !== 0)) throw Error('新人券须不限量');
  if (typeof value.rule !== 'string' || [...value.rule].length > 4096 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value.rule)) throw Error('使用规则须为最多4096字的纯文本');
  if (!flag(value.status) || !int(value.sort)) throw Error('开启状态或排序无效');
  return { title, discount_type: value.discount_type, scope_type: value.scope_type, category: value.category,
    category_id: value.category_id, brand_id: value.brand_id, product_ids, coupon_price, use_min_price,
    valid_days: value.valid_days, use_start_time: value.use_start_time, use_end_time: value.use_end_time,
    start_time: value.start_time, end_time: value.end_time, receive_type: value.receive_type,
    is_permanent: value.is_permanent, total_count: value.total_count, rule: value.rule, status: value.status, sort: value.sort };
}
function product(value: unknown): CouponIssueProduct {
  const row = object(value); if (!int(row.id, 1) || typeof row.store_name !== 'string' || typeof row.deleted !== 'boolean') throw Error('优惠券商品范围格式错误');
  return row as unknown as CouponIssueProduct;
}
export function parseCouponIssue(value: unknown): CouponIssueRow {
  const row = object(value);
  if (!int(row.id, 1) || !revision(row.revision) || !['title', 'coupon_price', 'use_min_price', 'rule', 'category_name', 'brand_name'].every(key => typeof row[key] === 'string') ||
    !['discount_type', 'scope_type', 'category', 'category_id', 'brand_id', 'valid_days', 'receive_type', 'status', 'is_permanent', 'total_count', 'remain_count', 'receive_limit', 'sort', 'add_time', 'cid', 'app_type'].every(key => signed(row[key])) ||
    typeof row.deleted !== 'boolean' || typeof row.valid !== 'boolean' || !Array.isArray(row.issues) || row.issues.some(v => typeof v !== 'string') ||
    ![row.start_time, row.end_time, row.use_start_time, row.use_end_time].every(readDate) || !Array.isArray(row.product_ids) || row.product_ids.some(id => !int(id, 1)) || !Array.isArray(row.products)) throw Error('优惠券发行字段格式错误');
  const ids = new Set(row.product_ids), products = row.products.map(product), seen = new Set(products.map(v => v.id));
  if (seen.size !== products.length || seen.size !== ids.size || products.some(v => !ids.has(v.id))) throw Error('商品范围详情不完整，不能使用截断数据');
  if (row.source_template !== null) { const source = object(row.source_template); if (!int(source.template_id, 1) || !revision(source.source_revision)) throw Error('来源模板信息无效'); }
  if (row.copy_input !== null) normalizeCouponIssue(object(row.copy_input) as unknown as CouponIssueInput);
  return row as unknown as CouponIssueRow;
}
export function couponIssueTree(values: { id: number; pid: number; name: string }[]): CouponIssueNode[] {
  if (!Array.isArray(values) || values.length > 5000) throw Error('范围选项不完整或超过容量');
  const nodes = new Map<number, CouponIssueNode>(), parents = new Map<number, number>();
  for (const value of values) { if (!int(value.id, 1) || !int(value.pid) || typeof value.name !== 'string' || nodes.has(value.id)) throw Error('范围选项重复或格式错误'); nodes.set(value.id, { value: value.id, label: value.name }); parents.set(value.id, value.pid); }
  for (const value of values) { let id = value.id; const visited = new Set<number>(); while (id) { if (visited.has(id) || !parents.has(id)) throw Error('范围选项存在循环或缺失父级'); visited.add(id); id = parents.get(id)!; } }
  const roots: CouponIssueNode[] = [];
  for (const value of values) { const node = nodes.get(value.id)!; if (!value.pid) roots.push(node); else (nodes.get(value.pid)!.children ??= []).push(node); }
  return roots;
}
function queryPage(query: { page: number; limit: number }) { if (!int(query.page, 1) || !int(query.limit, 1, 100) || (query.page - 1) * query.limit > 10000) throw Error('分页范围无效'); }
function page<T>(value: unknown, query: { page: number; limit: number }, parse: (v: unknown) => T, key: (v: T) => number | string): CouponIssuePage<T> {
  const result = object(value);
  if (!Array.isArray(result.list) || !int(result.count) || result.page !== query.page || result.limit !== query.limit || result.list.length > query.limit || result.list.length > result.count) throw Error('优惠券分页结果不完整或与请求不一致');
  const list = result.list.map(parse); if (new Set(list.map(key)).size !== list.length) throw Error('优惠券分页记录标识重复');
  return { list, count: result.count, page: query.page, limit: query.limit };
}
function id(value: number) { if (!int(value, 1)) throw Error('发行ID无效'); }
export async function apiCouponIssues(query: CouponIssueQuery, signal?: AbortSignal) {
  queryPage(query); return page(await getData(request.get('/marketing/coupon-issues', { params: query, signal })), query, parseCouponIssue, row => row.id);
}
export async function apiCouponIssueOptions(signal?: AbortSignal): Promise<CouponIssueOptions> {
  const value = object(await getData(request.get('/marketing/coupon-issues/options', { signal })));
  if (value.max_products !== 100 || value.max_product_ids_length !== 500 || !Array.isArray(value.categories) || !Array.isArray(value.brands)) throw Error('优惠券范围容量合同错误');
  couponIssueTree(value.categories.map(v => { const r = object(v); return { id: r.id as number, pid: r.pid as number, name: r.cate_name as string }; }));
  couponIssueTree(value.brands.map(v => { const r = object(v); return { id: r.id as number, pid: r.pid as number, name: r.brand_name as string }; }));
  return value as unknown as CouponIssueOptions;
}
export async function apiCouponIssueProducts(query: { page: number; limit: number; keyword: string }, signal?: AbortSignal) {
  queryPage(query); return page(await getData(request.get('/marketing/coupon-issues/products', { params: query, signal })), query, v => { const row = product(v); if (row.deleted) throw Error('候选商品已删除'); return row; }, row => row.id);
}
export async function apiCouponIssueDetail(value: number, signal?: AbortSignal) { id(value); const row = parseCouponIssue(await getData(request.get(`/marketing/coupon-issues/${value}`, { signal }))); if (row.id !== value) throw Error('发行详情身份不一致'); return row; }
export async function apiCouponIssueCopy(value: number, signal?: AbortSignal) { id(value); const row = parseCouponIssue(await getData(request.get(`/marketing/coupon-issues/${value}/copy`, { signal }))); if (row.id !== value) throw Error('复制来源身份不一致'); return row; }
export async function apiCouponIssueClaims(value: number, query: { page: number; limit: number }, signal?: AbortSignal): Promise<CouponIssueClaims> {
  id(value); queryPage(query); const data = object(await getData(request.get(`/marketing/coupon-issues/${value}/claims`, { params: query, signal })));
  if (data.issue_id !== value || !['issue_log', 'owned'].includes(String(data.source))) throw Error('领取记录发行归属或来源错误');
  const result = page(data, query, v => { const row = object(v);
    if (!(row.id === null || int(row.id, 1)) || typeof row.row_key !== 'string' || !row.row_key || !(row.uid === null || signed(row.uid)) || !signed(row.add_time) || typeof row.nickname !== 'string' ||
      !(row.avatar_preview === null || typeof row.avatar_preview === 'string') || typeof row.missing_user !== 'boolean' || typeof row.deleted_user !== 'boolean') throw Error('领取记录字段错误');
    return row as unknown as CouponIssueClaim;
  }, row => row.row_key);
  return { ...result, issue_id: value, source: data.source as CouponIssueClaims['source'] };
}
function requestId(value: string) { if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value)) throw Error('请求ID无效'); return value; }
function key(value: number, body: CouponIssueKey) { id(value); if (!revision(body.revision)) throw Error('发行版本无效'); return { request_id: requestId(body.request_id), revision: body.revision }; }
function result(value: unknown, expected = 0) { const row = object(value); if (!int(row.id, 1) || expected && row.id !== expected) throw Error('操作响应未确认，请只重新读取核对'); return { id: row.id }; }
export async function apiCouponIssueCreate(value: CouponIssueCreate, signal?: AbortSignal) {
  if (!int(value.source_id) || (value.source_id === 0 ? value.source_revision !== null : !revision(value.source_revision))) throw Error('复制来源版本无效');
  return result(await getData(request.post('/marketing/coupon-issues', { ...normalizeCouponIssue(value), source_id: value.source_id, source_revision: value.source_revision, request_id: requestId(value.request_id) }, { signal })));
}
export async function apiCouponIssueStatus(value: number, body: CouponIssueKey & { status: 0 | 1 }, signal?: AbortSignal) {
  if (!flag(body.status)) throw Error('发行状态无效');
  return result(await getData(request.post(`/marketing/coupon-issues/${value}/status`, { ...key(value, body), status: body.status }, { signal })), value);
}
export async function apiCouponIssueDelete(value: number, body: CouponIssueKey, signal?: AbortSignal) {
  return result(await getData(request.delete(`/marketing/coupon-issues/${value}`, { data: key(value, body), signal })), value);
}
