import request, { getData } from '@/utils/request';

const endpoint = '/marketing/coupon-templates';
export interface CouponTemplateInput { title: string; scope_type: 0 | 1 | 2; category_id: number; product_ids: number[]; coupon_price: string; use_min_price: string; valid_days: number; sort: number; status: 0 | 1 }
export interface CouponTemplateProduct { id: number; store_name: string; deleted: boolean }
export interface CouponTemplateRow extends CouponTemplateInput { id: number; deleted: boolean; add_time: number; revision: string; valid: boolean; issues: string[]; category_name: string; products: CouponTemplateProduct[]; issue_count: number }
export interface CouponTemplatePage<T> { list: T[]; count: number; page: number; limit: number }
export interface CouponTemplateQuery { page: number; limit: number; keyword?: string; status?: '' | 0 | 1 }
export interface CouponTemplateOptions { categories: { id: number; pid: number; cate_name: string }[]; max_products: 100; max_product_ids_length: 500 }
export interface CouponTemplateIssue { issue_id: number; template_id: number; title: string; receive_type: number; status: number; total_count: number; remain_count: number; is_permanent: number; start_time: string | null; end_time: string | null; issued_at: number; source_revision: string }
export interface CouponTemplatePublish { template_id: number; revision: string; receive_type: 1 | 2 | 3; status: 0 | 1; is_permanent: 0 | 1; count: number; start_time: string | null; end_time: string | null; full_reduction: string }
export interface CouponTemplateMutationKey { revision: string; request_id: string }
const integer = (value: unknown, min = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= 2147483647;
const flag = (value: unknown): value is 0 | 1 => value === 0 || value === 1;
const smallint = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= -32768 && value <= 32767;
const revision = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('优惠券响应格式错误'); return value as Record<string, unknown>; }
export function couponTemplateMoney(value: string, positive = false): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/u.test(value)) throw Error('金额须为最多10位整数、2位小数的数字');
  const [whole, fraction = ''] = value.split('.'), result = `${whole}.${fraction.padEnd(2, '0')}`;
  if (positive && !/[1-9]/u.test(result)) throw Error('优惠券面值必须大于0');
  return result;
}
function ids(value: unknown): number[] {
  if (!Array.isArray(value) || value.length > 100 || value.some(item => !integer(item, 1)) || new Set(value).size !== value.length || value.join(',').length > 500) throw Error('商品范围须完整且不重复，最多100项、500字符');
  return [...value];
}
export function normalizeCouponTemplate(value: CouponTemplateInput): CouponTemplateInput {
  const title = value.title.trim().normalize('NFC');
  if (!title || [...title].length > 64 || /[\u0000-\u001f\u007f]/u.test(title)) throw Error('模板名称须为1–64字，不能包含控制字符');
  if (![0, 1, 2].includes(value.scope_type) || !flag(value.status)) throw Error('适用范围或有效状态无效');
  if (!integer(value.valid_days, 1) || value.valid_days > 3650 || !integer(value.sort)) throw Error('有效天数须为1–3650，排序须为非负整数');
  const products = ids(value.product_ids);
  if (value.scope_type === 1 && !integer(value.category_id, 1)) throw Error('请选择适用品类');
  if (value.scope_type === 2 && !products.length) throw Error('请选择适用商品');
  return { title, scope_type: value.scope_type, category_id: value.scope_type === 1 ? value.category_id : 0,
    product_ids: value.scope_type === 2 ? products : [], coupon_price: couponTemplateMoney(value.coupon_price, true),
    use_min_price: couponTemplateMoney(value.use_min_price), valid_days: value.valid_days, sort: value.sort, status: value.status };
}
export function parseCouponTemplate(value: unknown): CouponTemplateRow {
  const row = object(value);
  if (!integer(row.id, 1) || !['title', 'coupon_price', 'use_min_price', 'category_name'].every(key => typeof row[key] === 'string') ||
    ![0, 1, 2].includes(Number(row.scope_type)) || !integer(row.scope_type) || !integer(row.category_id) || !integer(row.valid_days) || !integer(row.sort) || !flag(row.status) ||
    typeof row.deleted !== 'boolean' || typeof row.valid !== 'boolean' || !integer(row.add_time) || !integer(row.issue_count) || !revision(row.revision) ||
    !Array.isArray(row.issues) || row.issues.some(item => typeof item !== 'string') || !Array.isArray(row.products)) throw Error('优惠券模板字段错误');
  const productIds = ids(row.product_ids), seen = new Set<number>();
  for (const item of row.products) { const product = object(item); if (!integer(product.id, 1) || typeof product.store_name !== 'string' || typeof product.deleted !== 'boolean' || seen.has(product.id) || !productIds.includes(product.id)) throw Error('商品范围详情不完整'); seen.add(product.id); }
  if (seen.size !== productIds.length) throw Error('商品范围详情不完整，不能使用截断数据');
  if (row.valid) normalizeCouponTemplate(row as unknown as CouponTemplateInput);
  return row as unknown as CouponTemplateRow;
}
function page<T>(value: unknown, query: { page: number; limit: number }, parse: (value: unknown) => T, key: (row: T) => number): CouponTemplatePage<T> {
  const result = object(value);
  if (!Array.isArray(result.list) || !integer(result.count) || result.page !== query.page || result.limit !== query.limit || result.list.length > query.limit || result.list.length > result.count) throw Error('优惠券分页结果不完整或与请求不一致');
  const list = result.list.map(parse); if (new Set(list.map(key)).size !== list.length) throw Error('优惠券分页记录重复');
  return { list, count: result.count, page: query.page, limit: query.limit };
}
function queryPage(query: { page: number; limit: number }) { if (!integer(query.page, 1) || !integer(query.limit, 1) || query.limit > 100 || (query.page - 1) * query.limit > 10000) throw Error('分页范围无效'); }
function product(value: unknown): CouponTemplateProduct { const row = object(value); if (!integer(row.id, 1) || typeof row.store_name !== 'string' || row.deleted !== false) throw Error('候选商品格式错误'); return row as unknown as CouponTemplateProduct; }
export interface CouponCategoryNode { value: number; label: string; children?: CouponCategoryNode[] }
export function couponCategoryTree(categories: CouponTemplateOptions['categories']): CouponCategoryNode[] {
  if (!Array.isArray(categories) || categories.length > 5000) throw Error('分类配置不完整或超过容量');
  const nodes = new Map<number, CouponCategoryNode>();
  for (const row of categories) { if (!row || !integer(row.id, 1) || !integer(row.pid) || typeof row.cate_name !== 'string' || nodes.has(row.id)) throw Error('分类配置格式错误'); nodes.set(row.id, { value: row.id, label: row.cate_name }); }
  const parents = new Map(categories.map(row => [row.id, row.pid]));
  for (const row of categories) { let current = row.id; const visited = new Set<number>(); while (current) { if (visited.has(current) || !parents.has(current)) throw Error('分类存在循环或缺失父级'); visited.add(current); current = parents.get(current)!; } }
  const roots: CouponCategoryNode[] = [];
  for (const row of categories) { const node = nodes.get(row.id)!; if (!row.pid) roots.push(node); else (nodes.get(row.pid)!.children ??= []).push(node); }
  return roots;
}
export async function apiCouponTemplateList(query: CouponTemplateQuery, signal?: AbortSignal) { queryPage(query); return page(await getData(request.get(endpoint, { params: query, signal })), query, parseCouponTemplate, row => row.id); }
export async function apiCouponTemplateOptions(signal?: AbortSignal): Promise<CouponTemplateOptions> {
  const row = object(await getData(request.get(`${endpoint}/options`, { signal })));
  if (row.max_products !== 100 || row.max_product_ids_length !== 500) throw Error('模板容量合同错误'); couponCategoryTree(row.categories as CouponTemplateOptions['categories']); return row as unknown as CouponTemplateOptions;
}
export async function apiCouponTemplateProducts(query: { page: number; limit: number; keyword: string }, signal?: AbortSignal) { queryPage(query); return page(await getData(request.get(`${endpoint}/products`, { params: query, signal })), query, product, row => row.id); }
export async function apiCouponTemplateDetail(id: number, signal?: AbortSignal) { if (!integer(id, 1)) throw Error('模板ID无效'); const row = parseCouponTemplate(await getData(request.get(`${endpoint}/${id}`, { signal }))); if (row.id !== id) throw Error('模板详情身份不一致'); return row; }
function date(value: unknown): value is string | null { return value === null || typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19); }
function issue(value: unknown, templateId: number): CouponTemplateIssue {
  const row = object(value); if (!integer(row.issue_id, 1) || row.template_id !== templateId || typeof row.title !== 'string' || !smallint(row.receive_type) || !smallint(row.status) ||
    !integer(row.total_count) || !integer(row.remain_count) || !smallint(row.is_permanent) || !date(row.start_time) || !date(row.end_time) || !integer(row.issued_at) || !revision(row.source_revision)) throw Error('发行记录格式或模板归属错误'); return row as unknown as CouponTemplateIssue;
}
export async function apiCouponTemplateIssues(id: number, query: { page: number; limit: number }, signal?: AbortSignal) { if (!integer(id, 1)) throw Error('模板ID无效'); queryPage(query); return page(await getData(request.get(`${endpoint}/${id}/issues`, { params: query, signal })), query, value => issue(value, id), row => row.issue_id); }
export function couponTemplateUtc(value: string): string | null {
  if (!value) return null;
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/u.test(value)) throw Error('时间格式须为上海日期与时分');
  const utc = new Date(`${value}:00+08:00`); if (!Number.isFinite(utc.getTime()) || new Date(utc.getTime() + 8 * 3600000).toISOString().slice(0, 16) !== value) throw Error('时间无效'); return utc.toISOString();
}
export function normalizeCouponTemplatePublish(value: CouponTemplatePublish): CouponTemplatePublish {
  if (!integer(value.template_id, 1) || !revision(value.revision) || ![1, 2, 3].includes(value.receive_type) || !flag(value.status) || !flag(value.is_permanent)) throw Error('发布配置或模板身份无效');
  if (!integer(value.count) || value.is_permanent === 0 && value.count === 0 || value.is_permanent === 1 && value.count !== 0) throw Error('限量发行数量须大于0，不限量数量须为0');
  if (!date(value.start_time) || !date(value.end_time) || Boolean(value.start_time) !== Boolean(value.end_time) || value.start_time && value.end_time && (Date.parse(value.start_time) >= Date.parse(value.end_time) || Date.parse(value.end_time) <= Date.now())) throw Error('领取时间须完整、开始早于结束且结束尚未到期');
  const fullReduction = couponTemplateMoney(value.full_reduction); if (value.receive_type !== 3 && fullReduction !== '0.00') throw Error('只有赠送券可填写满赠金额');
  return { template_id: value.template_id, revision: value.revision, receive_type: value.receive_type, status: value.status, is_permanent: value.is_permanent, count: value.count, start_time: value.start_time, end_time: value.end_time, full_reduction: fullReduction };
}
function requestId(value: string) { if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value)) throw Error('操作请求ID无效'); return value; }
function mutationKey(id: number, value: CouponTemplateMutationKey) { if (!integer(id, 1) || !revision(value.revision)) throw Error('模板身份或版本无效'); return { revision: value.revision, request_id: requestId(value.request_id) }; }
function result(value: unknown, id = 0) { const row = object(value); if (!integer(row.id, 1) || id && row.id !== id) throw Error('写入响应未能确认，请只重新读取核对'); return { id: row.id }; }
export async function apiCouponTemplateCreate(value: CouponTemplateInput & { request_id: string }, signal?: AbortSignal) { return result(await getData(request.post(endpoint, { ...normalizeCouponTemplate(value), request_id: requestId(value.request_id) }, { signal }))); }
export async function apiCouponTemplateInvalidate(id: number, value: CouponTemplateMutationKey, signal?: AbortSignal) { return result(await getData(request.post(`${endpoint}/${id}/invalidate`, mutationKey(id, value), { signal })), id); }
export async function apiCouponTemplateDelete(id: number, value: CouponTemplateMutationKey, signal?: AbortSignal) { return result(await getData(request.delete(`${endpoint}/${id}`, { data: mutationKey(id, value), signal })), id); }
export async function apiCouponTemplatePublish(value: CouponTemplatePublish & { request_id: string }, signal?: AbortSignal) {
  const row = object(await getData(request.post('/marketing/coupon-template-issues', { ...normalizeCouponTemplatePublish(value), request_id: requestId(value.request_id) }, { signal })));
  if (!integer(row.issue_id, 1) || row.template_id !== value.template_id) throw Error('发行响应未能确认，请只重新读取发行记录核对'); return { issue_id: row.issue_id, template_id: value.template_id };
}
