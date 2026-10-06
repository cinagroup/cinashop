import request, { getData } from '@/utils/request';

const endpoint = '/marketing/time-discounts';
const MAX_INT = 2_147_483_647;
const integer = (value: unknown, min = 0): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= MAX_INT;
const flag = (value: unknown): value is 0 | 1 => value === 0 || value === 1;
const revision = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{64}$/u.test(value);
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('限时折扣响应格式错误');
  return value as Record<string, unknown>;
};
const text = (value: unknown): value is string => typeof value === 'string' && !/[\u0000-\u001f\u007f]/u.test(value);

export type TimeDiscountScope = 1 | 2 | 3 | 4 | 5;
export type TimeDiscountOverlay = 2 | 3 | 5;
export interface TimeDiscountSelection { product_id: number; unique: string[] }
export interface TimeDiscountSku { id: number; unique: string; suk: string; price: string | number; stock: number; is_retired?: 0 | 1 }
export interface TimeDiscountProduct {
  id: number; store_name: string; image: string; price: string | number; stock: number; cate_name: string;
  attrValue: TimeDiscountSku[]; is_show?: 0 | 1; is_del?: 0 | 1; is_verify?: 0 | 1; pid?: number;
}
export interface TimeDiscountBrand { id: number; brand_name: string }
export interface TimeDiscountLabel { id: number; label_name: string }
export interface TimeDiscountRow {
  id: number; name: string; product_count: number; sum_pay_price: string | number;
  sum_promotions_price: string | number; sum_order: number; sum_user: number;
  old_user: number; new_user: number; status: 0 | 1; revision: string;
}
export interface TimeDiscountDetail extends TimeDiscountRow {
  start_time: string; stop_time: string; discount: number; is_limit: 0 | 1; limit_num: number;
  label_id: number[]; overlay: TimeDiscountOverlay[]; product_partake_type: TimeDiscountScope;
  product_id: TimeDiscountSelection[]; brand_id: number[]; store_label_id: number[]; sort: number;
  products: TimeDiscountProduct[]; brands: TimeDiscountBrand[]; labels: TimeDiscountLabel[];
  user_labels: TimeDiscountLabel[]; selection_issues: string[];
}
export interface TimeDiscountPage<T> { list: T[]; count: number; page: number; limit: number }
export interface TimeDiscountListQuery { page: number; limit: number; name?: string; status?: '' | 0 | 1 }
export interface TimeDiscountOptionQuery { page: number; limit: number; keyword: string }
export interface TimeDiscountInput {
  name: string; section_time: [string, string]; discount: number; is_limit: 0 | 1;
  limit_num: number; label_id: number[]; overlay: TimeDiscountOverlay[];
  product_partake_type: TimeDiscountScope; product_id: TimeDiscountSelection[];
  brand_id: number[]; store_label_id: number[]; status: 0 | 1; sort: number;
}
export type TimeDiscountMutationKey = { request_id: string; revision: string };
export type TimeDiscountSave = TimeDiscountInput & { request_id: string; revision?: string };

export function timeDiscountDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(value)) return false;
  const utc = new Date(value.replace(' ', 'T') + '+08:00');
  const epoch = utc.getTime() / 1000;
  return Number.isSafeInteger(epoch) && epoch >= 1 && epoch <= MAX_INT
    && new Date(utc.getTime() + 8 * 3_600_000).toISOString().replace('T', ' ').slice(0, 19) === value;
}
export function timeDiscountRange(value: unknown): [string, string] {
  if (!Array.isArray(value) || value.length !== 2 || !timeDiscountDate(value[0]) || !timeDiscountDate(value[1]) || value[0] > value[1]) {
    throw Error('请选择完整且有效的上海时间范围，开始时间不能晚于结束时间');
  }
  return [value[0], value[1]];
}
function ids(value: unknown, label: string, max = 10_000): number[] {
  if (Array.isArray(value) && value.length > max) throw Error(`${label}最多选择${max}个`);
  if (!Array.isArray(value) || value.some(id => !integer(id, 1)) || new Set(value).size !== value.length) {
    throw Error(`${label}列表不完整、重复或超过容量`);
  }
  return [...value];
}
function selections(value: unknown): TimeDiscountSelection[] {
  if (!Array.isArray(value) || value.length > 10_000) throw Error('商品与规格选择不完整');
  const selected = value.map(item => {
    const row = record(item);
    if (!integer(row.product_id, 1) || !Array.isArray(row.unique) || !row.unique.length || row.unique.length > 10_000
      || row.unique.some(unique => !text(unique) || !unique.trim() || unique.length > 8)
      || new Set(row.unique).size !== row.unique.length) throw Error('商品规格选择不完整或重复');
    return { product_id: row.product_id, unique: [...row.unique] as string[] };
  });
  if (new Set(selected.map(row => row.product_id)).size !== selected.length) throw Error('商品选择重复');
  return selected;
}
function overlayIds(value: unknown): TimeDiscountOverlay[] {
  if (!Array.isArray(value) || value.length > 3 || value.some(item => ![2, 3, 5].includes(item)) || new Set(value).size !== value.length) {
    throw Error('优惠叠加选项无效');
  }
  return [...value] as TimeDiscountOverlay[];
}
function requestKey(value: unknown) {
  if (typeof value !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/iu.test(value)) throw Error('操作请求 ID 无效');
  return value;
}
export function normalizeTimeDiscount(value: TimeDiscountInput): TimeDiscountInput {
  const name = value.name?.trim().normalize('NFC');
  if (!name || [...name].length > 255 || !text(name)) throw Error('请输入 1–255 字的活动名称');
  if (!integer(value.discount) || value.discount > 100) throw Error('折扣须为 0–100 的整数百分比，例如 90% 为九折');
  if (!flag(value.is_limit) || !integer(value.limit_num, value.is_limit ? 1 : 0) || value.limit_num > 99_999_999) throw Error('限购配置无效');
  if (!flag(value.status) || !integer(value.sort) || value.sort > 32_767 || ![1, 2, 3, 4, 5].includes(value.product_partake_type)) throw Error('活动状态、排序或商品参与范围无效');
  const product_id = selections(value.product_id), brand_id = ids(value.brand_id, '品牌');
  const store_label_id = ids(value.store_label_id, '商品标签'), label_id = ids(value.label_id, '用户标签', 100);
  const overlay = overlayIds(value.overlay);
  if ([2, 3].includes(value.product_partake_type) && !product_id.length) throw Error('请选择商品及具体规格');
  if (value.product_partake_type === 4 && !brand_id.length) throw Error('请选择参与活动的品牌');
  if (value.product_partake_type === 5 && !store_label_id.length) throw Error('请选择参与活动的商品标签');
  return {
    name, section_time: timeDiscountRange(value.section_time), discount: value.discount,
    is_limit: value.is_limit, limit_num: value.is_limit ? value.limit_num : 0,
    label_id, overlay, product_partake_type: value.product_partake_type,
    product_id: [2, 3].includes(value.product_partake_type) ? product_id : [],
    brand_id: value.product_partake_type === 4 ? brand_id : [],
    store_label_id: value.product_partake_type === 5 ? store_label_id : [],
    status: value.status, sort: value.sort,
  };
}
function money(value: unknown): value is string | number {
  return typeof value === 'number' ? Number.isFinite(value) && value >= 0
    : typeof value === 'string' && /^\d+(?:\.\d+)?$/u.test(value);
}
function parseRow(value: unknown): TimeDiscountRow {
  const row = record(value);
  if (!integer(row.id, 1) || !text(row.name) || !integer(row.product_count)
    || !money(row.sum_pay_price) || !money(row.sum_promotions_price)
    || !integer(row.sum_order) || !integer(row.sum_user) || !integer(row.old_user) || !integer(row.new_user)
    || !flag(row.status) || !revision(row.revision)) throw Error('限时折扣列表字段错误');
  return row as unknown as TimeDiscountRow;
}
function parseSku(value: unknown): TimeDiscountSku {
  const row = record(value);
  if (!integer(row.id, 1) || !text(row.unique) || !row.unique || !text(row.suk)
    || !money(row.price) || !integer(row.stock) || row.is_retired !== undefined && !flag(row.is_retired)) throw Error('商品规格身份不完整');
  return row as unknown as TimeDiscountSku;
}
function parseProduct(value: unknown): TimeDiscountProduct {
  const row = record(value);
  if (!integer(row.id, 1) || !text(row.store_name) || !text(row.image) || !money(row.price)
    || !integer(row.stock) || !text(row.cate_name) || !Array.isArray(row.attrValue) || row.attrValue.length > 10_000) throw Error('商品选项身份不完整');
  const attrValue = row.attrValue.map(parseSku);
  if (new Set(attrValue.map(item => item.unique)).size !== attrValue.length) throw Error('商品规格身份重复');
  return { ...row, attrValue } as unknown as TimeDiscountProduct;
}
function parseBrand(value: unknown): TimeDiscountBrand {
  const row = record(value); if (!integer(row.id, 1) || !text(row.brand_name)) throw Error('品牌身份不完整');
  return row as unknown as TimeDiscountBrand;
}
function parseLabel(value: unknown): TimeDiscountLabel {
  const row = record(value); if (!integer(row.id, 1) || !text(row.label_name)) throw Error('标签身份不完整');
  return row as unknown as TimeDiscountLabel;
}
function queryPage(query: { page: number; limit: number }) {
  if (!integer(query.page, 1) || !integer(query.limit, 1) || query.limit > 50 || (query.page - 1) * query.limit > 100_000) throw Error('分页范围无效');
}
function parsePage<T extends { id: number }>(value: unknown, query: { page: number; limit: number }, parse: (value: unknown) => T): TimeDiscountPage<T> {
  const payload = record(value);
  if (!Array.isArray(payload.list) || !integer(payload.count) || payload.page !== query.page || payload.limit !== query.limit || payload.list.length > query.limit || payload.list.length > payload.count) throw Error('限时折扣分页结果不完整');
  const list = payload.list.map(parse);
  if (new Set(list.map(row => row.id)).size !== list.length) throw Error('限时折扣分页记录重复');
  return { list, count: payload.count as number, page: query.page, limit: query.limit };
}
export async function apiTimeDiscountList(query: TimeDiscountListQuery, signal?: AbortSignal) {
  queryPage(query);
  if (query.name !== undefined && (!text(query.name) || query.name.length > 200) || query.status !== undefined && !['', 0, 1].includes(query.status)) throw Error('限时折扣筛选无效');
  return parsePage(await getData(request.get(endpoint, { params: query, signal })), query, parseRow);
}
export async function apiTimeDiscountProducts(query: TimeDiscountOptionQuery, signal?: AbortSignal) {
  queryPage(query); return parsePage(await getData(request.get(`${endpoint}/products`, { params: query, signal })), query, parseProduct);
}
export async function apiTimeDiscountBrands(query: TimeDiscountOptionQuery, signal?: AbortSignal) {
  queryPage(query); return parsePage(await getData(request.get(`${endpoint}/brands`, { params: query, signal })), query, parseBrand);
}
export async function apiTimeDiscountLabels(query: TimeDiscountOptionQuery, signal?: AbortSignal) {
  queryPage(query); return parsePage(await getData(request.get(`${endpoint}/labels`, { params: query, signal })), query, parseLabel);
}
export async function apiTimeDiscountUserLabels(query: TimeDiscountOptionQuery, signal?: AbortSignal) {
  queryPage(query); return parsePage(await getData(request.get(`${endpoint}/user-labels`, { params: query, signal })), query, parseLabel);
}
export async function apiTimeDiscountDetail(id: number, signal?: AbortSignal): Promise<TimeDiscountDetail> {
  if (!integer(id, 1)) throw Error('限时折扣 ID 无效');
  const payload = record(await getData(request.get(`${endpoint}/${id}`, { signal })));
  const info = record(payload.info); parseRow(info);
  if (info.id !== id || !timeDiscountDate(info.start_time) || !timeDiscountDate(info.stop_time)
    || !integer(info.discount) || info.discount > 100 || !flag(info.is_limit)
    || !integer(info.limit_num, info.is_limit === 1 ? 1 : 0) || !integer(info.sort) || info.sort > 32_767
    || ![1, 2, 3, 4, 5].includes(info.product_partake_type as number)) throw Error('限时折扣详情身份或配置不完整');
  const label_id = ids(info.label_id, '用户标签', 100), brand_id = ids(info.brand_id, '品牌');
  const store_label_id = ids(info.store_label_id, '商品标签'), product_id = selections(info.product_id);
  const overlay = overlayIds(info.overlay);
  if (!Array.isArray(info.products) || !Array.isArray(info.brands) || !Array.isArray(info.labels)
    || !Array.isArray(info.user_labels) || !Array.isArray(info.selection_issues)
    || info.selection_issues.some(item => !text(item))) throw Error('限时折扣详情选项不完整');
  if (info.selection_issues.length) throw Error(`现有商品或规格已变化，禁止直接保存：${info.selection_issues.join('；')}`);
  const products = info.products.map(parseProduct), brands = info.brands.map(parseBrand);
  const labels = info.labels.map(parseLabel), user_labels = info.user_labels.map(parseLabel);
  const matchIds = (selected: number[], rows: { id: number }[]) => selected.length === rows.length
    && new Set(rows.map(row => row.id)).size === rows.length && selected.every(id => rows.some(row => row.id === id));
  if (!matchIds(brand_id, brands) || !matchIds(store_label_id, labels) || !matchIds(label_id, user_labels)) throw Error('品牌或标签已失效，不能编辑截断数据');
  if ([2, 3].includes(info.product_partake_type as number)) {
    if (!matchIds(product_id.map(item => item.product_id), products)) throw Error('商品回显不完整，不能编辑截断数据');
    for (const choice of product_id) {
      const product = products.find(item => item.id === choice.product_id)!;
      if (product.is_show !== 1 || product.is_del !== 0 || product.is_verify !== 1 || product.pid !== 0
        || choice.unique.length !== product.attrValue.length
        || choice.unique.some(unique => !product.attrValue.some(sku => sku.unique === unique && sku.is_retired === 0))) {
        throw Error(`商品 #${choice.product_id} 的规格已退役或回显不完整，不能编辑截断数据`);
      }
    }
  }
  return { ...info, label_id, brand_id, store_label_id, product_id, overlay, products, brands, labels, user_labels } as unknown as TimeDiscountDetail;
}
function mutationResult(value: unknown, id = 0) {
  const row = record(value); if (!integer(row.id, 1) || id && row.id !== id) throw Error('写入响应未能确认，请重新读取限时折扣核对');
  return { id: row.id as number };
}
export async function apiTimeDiscountSave(id: number, value: TimeDiscountSave, signal?: AbortSignal) {
  if (!integer(id) || id && !revision(value.revision)) throw Error('限时折扣身份或版本无效');
  const body = { ...normalizeTimeDiscount(value), request_id: requestKey(value.request_id), ...(id ? { revision: value.revision } : {}) };
  return mutationResult(await getData(id ? request.put(`${endpoint}/${id}`, body, { signal }) : request.post(endpoint, body, { signal })), id);
}
export async function apiTimeDiscountStatus(id: number, value: TimeDiscountMutationKey & { status: 0 | 1 }, signal?: AbortSignal) {
  if (!integer(id, 1) || !revision(value.revision) || !flag(value.status)) throw Error('限时折扣身份、版本或状态无效');
  return mutationResult(await getData(request.patch(`${endpoint}/${id}/status`, { ...value, request_id: requestKey(value.request_id) }, { signal })), id);
}
export async function apiTimeDiscountDelete(id: number, value: TimeDiscountMutationKey, signal?: AbortSignal) {
  if (!integer(id, 1) || !revision(value.revision)) throw Error('限时折扣身份或版本无效');
  return mutationResult(await getData(request.delete(`${endpoint}/${id}`, { data: { ...value, request_id: requestKey(value.request_id) }, signal })), id);
}
