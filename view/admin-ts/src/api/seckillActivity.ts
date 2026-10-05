import request, { getData } from '@/utils/request';

export type SeckillActivityPhase = 'future' | 'active' | 'ended' | 'invalid';
export interface SeckillActivityTime { id: number; title: string; start_time: string; end_time: string; status: 0 | 1; valid: boolean }
export interface SeckillActivityRow {
  id: number; name: string; start_day: string; end_day: string; time_ids: number[]; time_list: SeckillActivityTime[];
  image: string; image_preview: string; status: 0 | 1; phase: SeckillActivityPhase; product_count: number; add_time: number | string;
  valid: boolean; issues: string[]; revision: string; raw?: Record<string, unknown>;
}
export interface SeckillActivitySku {
  id: number | null; base_unique: string; unique: string; suk: string; price: string; quota: number; quota_show: number;
  quota_total: number; consumed: number; remaining: number; stock: number; base_stock: number;
  cost?: string; ot_price?: string;
  image: string; image_preview: string;
  enabled: boolean; retired?: boolean; valid: boolean; issues: string[];
}
export interface SeckillActivityProduct {
  child_id: number | null; product_id: number; store_name: string; image: string; image_preview: string;
  product_type: number; category_name: string;
  status: 0 | 1; valid: boolean; issues: string[]; deleted?: boolean; skus: SeckillActivitySku[];
}
export interface SeckillActivityDetail extends SeckillActivityRow { num: number; once_num: number; products: SeckillActivityProduct[] }
export interface SeckillActivityProductOption { product_id: number; store_name: string; image: string; image_preview: string; product_type: number; category_name: string; stock: number; valid: boolean; issues: string[] }
export interface SeckillActivityCategory { id: number; pid: number; cate_name: string }
export interface SeckillActivityLabel { id: number; label_name: string }
export interface SeckillActivityCategoryNode { value: number; label: string; children?: SeckillActivityCategoryNode[] }
export interface SeckillActivityProductQuery { page: number; limit: number; keyword: string; category_id?: number | ''; label_id?: number | '' }
export interface SeckillActivityQuery { page: number; limit: number; keyword?: string; phase?: '' | SeckillActivityPhase; status?: '' | 0 | 1 }
export interface SeckillActivityPage<T = SeckillActivityRow> { list: T[]; count: number; page: number; limit: number }
export interface SeckillActivityOptions { times: SeckillActivityTime[]; categories: SeckillActivityCategory[]; labels: SeckillActivityLabel[]; max_slots: number; max_products: number; max_skus: number; max_total_skus: number; max_categories: number; max_labels: number }
export interface SeckillActivitySkuInput { id: number | null; base_unique: string; price: string; quota_total: number; enabled: boolean }
export interface SeckillActivityProductInput { child_id: number | null; product_id: number; status: 0 | 1; skus: SeckillActivitySkuInput[] }
export interface SeckillActivityInput { name: string; start_day: string; end_day: string; time_ids: number[]; num: number; once_num: number; image: string; status: 0 | 1; products: SeckillActivityProductInput[] }
export type SeckillActivitySave = SeckillActivityInput & { request_id: string; revision?: string };
export interface SeckillActivityMutationKey { request_id: string; revision: string }
const endpoint = '/activity/seckill-activities';
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647;
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const flag = (value: unknown): value is 0 | 1 => value === 0 || value === 1;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const idOrNull = (value: unknown): value is number | null => value === null || positive(value);
export function activityImagePreview(image: string, signed = '') {
  const value = signed || (/^\/api\/assets\//u.test(image) ? '' : image);
  return /^(https:\/\/|\/(?!\/))/iu.test(value) && !/[\u0000-\u0020\u007f\\]/u.test(value) ? value : '';
}
export function activityDay(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw Error('活动日期须为年-月-日');
  const utc = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(utc) || new Date(utc).toISOString().slice(0, 10) !== value) throw Error('活动日期无效');
  const epoch = utc / 1000 - 28_800;
  if (!positive(epoch)) throw Error('活动日期超出支持范围');
  return epoch;
}
export function activityPrice(value: string) {
  if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/u.test(value) || Number(value) <= 0) throw Error('参与规格的秒杀价须大于0，最多两位小数');
  return Number(value).toFixed(2);
}
export function normalizeSeckillActivityInput(value: SeckillActivityInput): SeckillActivityInput {
  const name = value.name.trim(), image = value.image.trim();
  if (!name || [...name].length > 128 || /[\u0000-\u001f\u007f]/u.test(name)) throw Error('活动名称须为1–128字，不能包含控制字符');
  if (activityDay(value.start_day) > activityDay(value.end_day)) throw Error('开始日期不能晚于结束日期');
  if (!Array.isArray(value.time_ids) || value.time_ids.length < 1 || value.time_ids.length > 64 || value.time_ids.some(id => !positive(id)) || new Set(value.time_ids).size !== value.time_ids.length) throw Error('请选择1–64个不同的秒杀场次');
  if (!positive(value.num) || !positive(value.once_num) || value.once_num > value.num) throw Error('累计限购和单次限购须为正整数，单次不能大于累计');
  if ([...image].length > 128 || /[\u0000-\u0020\u007f\\]/u.test(image)) throw Error('氛围图地址不能超过128字或包含空白、控制字符');
  if (image) {
    if (!/^\/(?!\/)/u.test(image)) { try { const url = new URL(image); if (url.protocol !== 'https:' || url.username || url.password) throw Error(); } catch { throw Error('氛围图须为安全HTTPS地址或站内图片路径'); } }
    if (/^\/api\/assets\//u.test(image) && !/^\/api\/assets\/[1-9]\d*$/u.test(image)) throw Error('请通过图库选择稳定图片地址');
  }
  if (!flag(value.status)) throw Error('活动状态错误');
  if (!Array.isArray(value.products) || value.products.length < 1 || value.products.length > 100) throw Error('请选择1–100个商品');
  const productIds = new Set<number>(), childIds = new Set<number>(), skuIds = new Set<number>(); let total = 0;
  const products = value.products.map(product => {
    const orphanClosing = product.product_id === 0 && positive(product.child_id) && product.status === 0 && Array.isArray(product.skus) && product.skus.every(sku => !sku.enabled);
    if ((!positive(product.product_id) && !orphanClosing) || productIds.has(product.product_id) || !idOrNull(product.child_id) || (product.child_id !== null && childIds.has(product.child_id)) || !flag(product.status)) throw Error('商品或子商品标识重复、无效');
    productIds.add(product.product_id); if (product.child_id !== null) childIds.add(product.child_id);
    if (!Array.isArray(product.skus) || product.skus.length > 500 || (total += product.skus.length) > 5000) throw Error('每商品最多500个规格，活动规格总数最多5000');
    const bases = new Set<string>();
    const skus = product.skus.map(sku => {
      if (!idOrNull(sku.id) || (sku.id !== null && skuIds.has(sku.id)) || typeof sku.base_unique !== 'string' || typeof sku.price !== 'string' || typeof sku.enabled !== 'boolean') throw Error('规格身份无效或重复');
      if (sku.id !== null) skuIds.add(sku.id);
      if (sku.enabled) {
        if (!sku.base_unique || sku.base_unique !== sku.base_unique.trim() || sku.base_unique.length > 8 || /[\u0000-\u0020\u007f]/u.test(sku.base_unique) || bases.has(sku.base_unique)) throw Error('参与规格须有不同的有效基础规格标识');
        bases.add(sku.base_unique);
        if (!integer(sku.quota_total)) throw Error('规格总额度须为非负整数');
      }
      return { id: sku.id, base_unique: sku.base_unique, price: sku.enabled ? activityPrice(sku.price.trim()) : sku.price, quota_total: sku.quota_total, enabled: sku.enabled };
    });
    if (product.status === 1 && !skus.some(sku => sku.enabled)) throw Error(`商品${product.product_id}已开启，请至少选择一个参与规格，或停用商品`);
    return { child_id: product.child_id, product_id: product.product_id, status: product.status, skus };
  });
  return { name, image, start_day: value.start_day, end_day: value.end_day, time_ids: [...value.time_ids], num: value.num, once_num: value.once_num, status: value.status, products };
}
function time(value: unknown): SeckillActivityTime {
  const item = value as SeckillActivityTime;
  if (!item || !positive(item.id) || !flag(item.status) || typeof item.valid !== 'boolean' || ![item.title, item.start_time, item.end_time].every(item => typeof item === 'string')) throw Error('秒杀场次响应格式错误');
  return item;
}
export function parseSeckillActivityRow(value: unknown): SeckillActivityRow {
  const item = value as SeckillActivityRow;
  if (!item || !positive(item.id) || !flag(item.status) || typeof item.valid !== 'boolean' || !strings(item.issues) || ![item.name, item.start_day, item.end_day, item.image, item.image_preview].every(item => typeof item === 'string') || !integer(item.product_count) || !['future', 'active', 'ended', 'invalid'].includes(item.phase) || !/^[a-f0-9]{64}$/u.test(item.revision) || !Array.isArray(item.time_ids) || item.time_ids.some(id => !positive(id)) || !Array.isArray(item.time_list)) throw Error('秒杀父活动响应格式错误');
  item.time_list.forEach(time); return item;
}
export function parseSeckillActivitySku(value: unknown): SeckillActivitySku {
  const item = value as SeckillActivitySku;
  if (!item || !idOrNull(item.id) || ![item.base_unique, item.unique, item.suk, item.price, item.image, item.image_preview].every(item => typeof item === 'string') || ![item.quota, item.quota_show, item.quota_total, item.consumed, item.remaining, item.stock, item.base_stock].every(number) || [item.cost, item.ot_price].some(value => value !== undefined && typeof value !== 'string') || typeof item.enabled !== 'boolean' || typeof item.valid !== 'boolean' || !strings(item.issues) || (item.retired !== undefined && typeof item.retired !== 'boolean')) throw Error('秒杀活动规格响应格式错误');
  return item;
}
export function parseSeckillActivityProduct(value: unknown): SeckillActivityProduct {
  const item = value as SeckillActivityProduct;
  if (!item || !idOrNull(item.child_id) || !integer(item.product_id) || !number(item.product_type) || !flag(item.status) || typeof item.valid !== 'boolean' || !strings(item.issues) || (item.deleted !== undefined && typeof item.deleted !== 'boolean') || ![item.store_name, item.image, item.image_preview, item.category_name].every(item => typeof item === 'string') || !Array.isArray(item.skus) || item.skus.length > 500) throw Error('秒杀活动商品响应格式错误');
  item.skus.forEach(parseSeckillActivitySku); return item;
}
export function parseSeckillActivityDetail(value: unknown): SeckillActivityDetail {
  const item = parseSeckillActivityRow(value) as SeckillActivityDetail;
  if (!number(item.num) || !number(item.once_num) || !Array.isArray(item.products) || item.products.length > 100) throw Error('活动详情不完整或超过配置容量，不能编辑截断数据');
  item.products.forEach(parseSeckillActivityProduct);
  if (item.products.reduce((total, product) => total + product.skus.length, 0) > 5000) throw Error('活动详情不完整或超过配置容量，不能编辑截断数据');
  return item;
}
function page<T>(value: unknown, query: { page: number; limit: number }, parse: (value: unknown) => T, key: (value: T) => number): SeckillActivityPage<T> {
  const result = value as SeckillActivityPage<T>;
  if (!result || !Array.isArray(result.list) || !integer(result.count) || result.page !== query.page || result.limit !== query.limit || result.list.length > query.limit || result.list.length > result.count) throw Error('活动分页响应格式错误');
  result.list.forEach(parse); if (new Set(result.list.map(key)).size !== result.list.length) throw Error('活动分页记录重复'); return result;
}
function productOption(value: unknown): SeckillActivityProductOption {
  const item = value as SeckillActivityProductOption;
  if (!item || !positive(item.product_id) || !number(item.stock) || !number(item.product_type) || typeof item.valid !== 'boolean' || !strings(item.issues) || ![item.store_name, item.image, item.image_preview, item.category_name].every(item => typeof item === 'string')) throw Error('基础商品响应格式错误'); return item;
}
export function activityCategoryTree(categories: SeckillActivityCategory[]): SeckillActivityCategoryNode[] {
  if (!Array.isArray(categories) || categories.length > 5000 || categories.some(item => !item || !positive(item.id) || !integer(item.pid) || typeof item.cate_name !== 'string') || new Set(categories.map(item => item.id)).size !== categories.length) throw Error('商品分类选项格式错误');
  const byId = new Map(categories.map(item => [item.id, item])), complete = new Set<number>();
  for (const category of categories) {
    let id = category.id; const chain = new Set<number>();
    while (id && !complete.has(id)) { if (chain.has(id)) throw Error('商品分类存在循环'); const item = byId.get(id); if (!item) throw Error('商品分类父级不完整'); chain.add(id); id = item.pid; }
    chain.forEach(value => complete.add(value));
  }
  const nodes = new Map(categories.map(item => [item.id, { value: item.id, label: item.cate_name } as SeckillActivityCategoryNode])), roots: SeckillActivityCategoryNode[] = [];
  for (const category of categories) { const node = nodes.get(category.id)!; if (!category.pid) roots.push(node); else (nodes.get(category.pid)!.children ??= []).push(node); }
  return roots;
}
export async function apiSeckillActivityList(query: SeckillActivityQuery, signal?: AbortSignal) { return page(await getData(request.get(endpoint, { params: query, signal })), query, parseSeckillActivityRow, row => row.id); }
export async function apiSeckillActivityDetail(id: number, signal?: AbortSignal) { const result = parseSeckillActivityDetail(await getData(request.get(`${endpoint}/${id}`, { signal }))); if (result.id !== id) throw Error('活动详情与请求身份不一致'); return result; }
export async function apiSeckillActivityOptions(signal?: AbortSignal) {
  const result = await getData<SeckillActivityOptions>(request.get(`${endpoint}/options`, { signal }));
  if (!result || !Array.isArray(result.times) || !Array.isArray(result.labels) || result.labels.length > 5000 || result.max_slots !== 64 || result.max_products !== 100 || result.max_skus !== 500 || result.max_total_skus !== 5000 || result.max_categories !== 5000 || result.max_labels !== 5000) throw Error('活动配置选项响应格式错误');
  result.times.forEach(time); if (new Set(result.times.map(item => item.id)).size !== result.times.length) throw Error('秒杀场次选项重复');
  activityCategoryTree(result.categories);
  if (result.labels.some(item => !item || !positive(item.id) || typeof item.label_name !== 'string') || new Set(result.labels.map(item => item.id)).size !== result.labels.length) throw Error('商品标签选项格式错误'); return result;
}
export async function apiSeckillActivityProducts(query: SeckillActivityProductQuery, signal?: AbortSignal) { return page(await getData(request.get(`${endpoint}/products`, { params: query, signal })), query, productOption, item => item.product_id); }
export async function apiSeckillActivityProduct(id: number, signal?: AbortSignal) {
  const result = await getData<SeckillActivityProductOption & { skus: SeckillActivitySku[] }>(request.get(`${endpoint}/products/${id}`, { signal }));
  productOption(result); if (result.product_id !== id || !Array.isArray(result.skus) || result.skus.length > 500) throw Error('基础商品规格不完整'); result.skus.forEach(parseSeckillActivitySku); return result;
}
function mutation(value: unknown, id: number) { const result = value as { id: number }; if (!result || !positive(result.id) || (id !== 0 && result.id !== id)) throw Error('操作结果格式错误，请重新读取活动核对'); return result; }
export async function apiSeckillActivitySave(id: number, body: SeckillActivitySave, signal?: AbortSignal) { return mutation(await getData(id === 0 ? request.post(endpoint, body, { signal }) : request.put(`${endpoint}/${id}`, body, { signal })), id); }
export async function apiSeckillActivityStatus(id: number, body: SeckillActivityMutationKey & { status: 0 | 1 }, signal?: AbortSignal) { return mutation(await getData(request.put(`${endpoint}/${id}/status`, body, { signal })), id); }
export async function apiSeckillActivityDelete(id: number, body: SeckillActivityMutationKey, signal?: AbortSignal) { return mutation(await getData(request.delete(`${endpoint}/${id}`, { data: body, signal })), id); }
