import request, { getData } from '@/utils/request';

const endpoint = '/marketing/activity-background';
const MAX_INT = 2_147_483_647;
const integer = (value: unknown, min = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= MAX_INT;
const flag = (value: unknown): value is 0 | 1 => value === 0 || value === 1;
const revision = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('活动背景响应格式错误');
  return value as Record<string, unknown>;
};

export type ActivityBackgroundScope = 1 | 2 | 3 | 4 | 5;
export type ActivityBackgroundPhase = -1 | 0 | 1;
export interface ActivityBackgroundRow {
  id: number;
  name: string;
  image: string;
  start_time: string;
  stop_time: string;
  status: 0 | 1;
  start_status: ActivityBackgroundPhase;
  product_count: number;
  add_time: string | number;
  product_partake_type: ActivityBackgroundScope;
  revision: string;
}
export interface ActivityBackgroundProduct { id: number; store_name: string; image: string; price: string | number; stock: number; cate_name: string }
export interface ActivityBackgroundBrand { id: number; brand_name: string }
export interface ActivityBackgroundLabel { id: number; label_name: string }
export interface ActivityBackgroundDetail extends ActivityBackgroundRow {
  product_id: number[];
  brand_id: number[];
  store_label_id: number[];
  products: ActivityBackgroundProduct[];
  brands: ActivityBackgroundBrand[];
  labels: ActivityBackgroundLabel[];
  sort: number;
}
export interface ActivityBackgroundPage<T> { list: T[]; count: number; page: number; limit: number }
export interface ActivityBackgroundListQuery { page: number; limit: number; name?: string; status?: '' | ActivityBackgroundPhase; time?: string; create_time?: string }
export interface ActivityBackgroundOptionQuery { page: number; limit: number; keyword: string }
export interface ActivityBackgroundInput {
  name: string;
  image: string;
  status: 0 | 1;
  product_partake_type: ActivityBackgroundScope;
  product_id: number[];
  brand_id: number[];
  store_label_id: number[];
  section_time: [string, string];
  sort: number;
}
export type ActivityBackgroundMutationKey = { request_id: string; revision: string };
export type ActivityBackgroundSave = ActivityBackgroundInput & { request_id: string; revision?: string };

export function activityBackgroundDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(value)) return false;
  const utc = new Date(value.replace(' ', 'T') + '+08:00');
  const epoch = utc.getTime() / 1000;
  return Number.isSafeInteger(epoch) && epoch >= 1 && epoch <= MAX_INT && new Date(utc.getTime() + 8 * 3600_000).toISOString().replace('T', ' ').slice(0, 19) === value;
}
export function activityBackgroundTimeRange(value: unknown): [string, string] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (value.length !== 2 || !activityBackgroundDate(value[0]) || !activityBackgroundDate(value[1]) || value[0] > value[1]) throw Error('请选择完整且有效的时间范围，开始时间不能晚于结束时间');
  return [value[0], value[1]];
}
export function activityBackgroundRangeQuery(value: unknown): string {
  const range = activityBackgroundTimeRange(value);
  return range ? `${range[0]} - ${range[1]}` : '';
}
function ids(value: unknown, field: string): number[] {
  if (!Array.isArray(value) || value.length > 10_000 || value.some(id => !integer(id, 1)) || new Set(value).size !== value.length) throw Error(`${field}列表不完整、重复或超过容量`);
  return [...value];
}
function key(value: string) { if (!/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/iu.test(value)) throw Error('操作请求 ID 无效'); return value; }
export function normalizeActivityBackground(value: ActivityBackgroundInput): ActivityBackgroundInput {
  const name = value.name?.trim().normalize('NFC'), image = value.image?.trim();
  if (!name || [...name].length > 255 || /[\u0000-\u001f\u007f]/u.test(name)) throw Error('请输入 1–255 字的活动名称');
  if (!image || [...image].length > 255 || !/^(https:\/\/|\/(?!\/))/iu.test(image) || /[\u0000-\u0020\u007f\\]/u.test(image)) throw Error('请选择有效的活动图片');
  if (!flag(value.status) || ![1, 2, 3, 4, 5].includes(value.product_partake_type) || !integer(value.sort) || value.sort > 32767) throw Error('活动状态、商品参与范围或排序无效');
  const section_time = activityBackgroundTimeRange(value.section_time);
  if (!section_time) throw Error('请选择完整活动时间');
  const product_id = ids(value.product_id, '商品'), brand_id = ids(value.brand_id, '品牌'), store_label_id = ids(value.store_label_id, '标签');
  if ([2, 3].includes(value.product_partake_type) && !product_id.length) throw Error(value.product_partake_type === 3 ? '请选择不参与的商品' : '请选择参与活动的商品');
  if (value.product_partake_type === 4 && !brand_id.length) throw Error('请选择参与活动的品牌');
  if (value.product_partake_type === 5 && !store_label_id.length) throw Error('请选择参与活动的标签');
  return {
    name, image, status: value.status, product_partake_type: value.product_partake_type,
    product_id: [2, 3].includes(value.product_partake_type) ? product_id : [],
    brand_id: value.product_partake_type === 4 ? brand_id : [],
    store_label_id: value.product_partake_type === 5 ? store_label_id : [],
    section_time, sort: value.sort,
  };
}
function parseRow(value: unknown): ActivityBackgroundRow {
  const row = object(value);
  if (!integer(row.id, 1) || typeof row.name !== 'string' || typeof row.image !== 'string' || !(row.start_time === '' || activityBackgroundDate(row.start_time)) || !(row.stop_time === '' || activityBackgroundDate(row.stop_time)) || !flag(row.status) || ![-1, 0, 1].includes(row.start_status as number) || !integer(row.product_count) || ![1, 2, 3, 4, 5].includes(row.product_partake_type as number) || !revision(row.revision) || !(typeof row.add_time === 'string' || integer(row.add_time))) throw Error('活动背景列表字段错误');
  return row as unknown as ActivityBackgroundRow;
}
function parseProduct(value: unknown): ActivityBackgroundProduct {
  const row = object(value);
  if (!integer(row.id, 1) || typeof row.store_name !== 'string' || typeof row.image !== 'string' || !(typeof row.price === 'string' || typeof row.price === 'number') || typeof row.stock !== 'number' || typeof row.cate_name !== 'string') throw Error('候选商品格式错误');
  return row as unknown as ActivityBackgroundProduct;
}
function parseBrand(value: unknown): ActivityBackgroundBrand {
  const row = object(value); if (!integer(row.id, 1) || typeof row.brand_name !== 'string') throw Error('候选品牌格式错误'); return row as unknown as ActivityBackgroundBrand;
}
function parseLabel(value: unknown): ActivityBackgroundLabel {
  const row = object(value); if (!integer(row.id, 1) || typeof row.label_name !== 'string') throw Error('候选标签格式错误'); return row as unknown as ActivityBackgroundLabel;
}
function parsePage<T extends { id: number }>(value: unknown, query: { page: number; limit: number }, parse: (value: unknown) => T): ActivityBackgroundPage<T> {
  const result = object(value);
  if (!Array.isArray(result.list) || !integer(result.count) || result.page !== query.page || result.limit !== query.limit || result.list.length > query.limit || result.list.length > result.count) throw Error('活动背景分页结果不完整');
  const list = result.list.map(parse);
  if (new Set(list.map(row => row.id)).size !== list.length) throw Error('活动背景分页记录重复');
  return { list, count: result.count as number, page: query.page, limit: query.limit };
}
function queryPage(query: { page: number; limit: number }) {
  if (!integer(query.page, 1) || !integer(query.limit, 1) || query.limit > 50 || (query.page - 1) * query.limit > 100_000) throw Error('分页范围无效');
}
export async function apiActivityBackgroundList(query: ActivityBackgroundListQuery, signal?: AbortSignal) {
  queryPage(query); return parsePage(await getData(request.get(endpoint, { params: query, signal })), query, parseRow);
}
export async function apiActivityBackgroundDetail(id: number, signal?: AbortSignal): Promise<ActivityBackgroundDetail> {
  if (!integer(id, 1)) throw Error('活动背景 ID 无效');
  const payload = object(await getData(request.get(`${endpoint}/${id}`, { signal })));
  const row = object(payload.info); parseRow(row);
  if (row.id !== id) throw Error('活动背景详情身份不一致');
  const product_id = ids(row.product_id, '商品'), brand_id = ids(row.brand_id, '品牌'), store_label_id = ids(row.store_label_id, '标签');
  if (!integer(row.sort) || row.sort > 32767 || !Array.isArray(row.products) || row.products.length > 10_000 || !Array.isArray(row.brands) || !Array.isArray(row.labels)) throw Error('活动背景范围详情不完整');
  const products = row.products.map(parseProduct);
  const brands = row.brands.map(parseBrand), labels = row.labels.map(parseLabel);
  if (new Set(products.map(product => product.id)).size !== products.length || [2, 3].includes(row.product_partake_type as number) && (products.length !== product_id.length || products.some(item => !product_id.includes(item.id)))) throw Error('活动背景商品详情不完整，不能编辑截断数据');
  if (new Set(brands.map(item => item.id)).size !== brands.length || brands.length !== brand_id.length || brands.some(item => !brand_id.includes(item.id)) || new Set(labels.map(item => item.id)).size !== labels.length || labels.length !== store_label_id.length || labels.some(item => !store_label_id.includes(item.id))) throw Error('品牌或标签详情不完整，不能编辑截断数据');
  return { ...row, product_id, brand_id, store_label_id, products, brands, labels } as ActivityBackgroundDetail;
}
export async function apiActivityBackgroundProducts(query: ActivityBackgroundOptionQuery, signal?: AbortSignal) { queryPage(query); return parsePage(await getData(request.get(`${endpoint}/products`, { params: query, signal })), query, parseProduct); }
export async function apiActivityBackgroundBrands(query: ActivityBackgroundOptionQuery, signal?: AbortSignal) { queryPage(query); return parsePage(await getData(request.get(`${endpoint}/brands`, { params: query, signal })), query, parseBrand); }
export async function apiActivityBackgroundLabels(query: ActivityBackgroundOptionQuery, signal?: AbortSignal) { queryPage(query); return parsePage(await getData(request.get(`${endpoint}/labels`, { params: query, signal })), query, parseLabel); }
function mutationResult(value: unknown, id = 0) { const row = object(value); if (!integer(row.id, 1) || id && row.id !== id) throw Error('写入响应未能确认，请重新读取活动核对'); return { id: row.id as number }; }
export async function apiActivityBackgroundSave(id: number, value: ActivityBackgroundSave, signal?: AbortSignal) {
  if (!integer(id) || id && !revision(value.revision)) throw Error('活动背景身份或版本无效');
  const body = { ...normalizeActivityBackground(value), request_id: key(value.request_id), ...(id ? { revision: value.revision } : {}) };
  return mutationResult(await getData(id ? request.put(`${endpoint}/${id}`, body, { signal }) : request.post(endpoint, body, { signal })), id);
}
export async function apiActivityBackgroundStatus(id: number, value: ActivityBackgroundMutationKey & { status: 0 | 1 }, signal?: AbortSignal) {
  if (!integer(id, 1) || !revision(value.revision) || !flag(value.status)) throw Error('活动背景身份、版本或状态无效');
  return mutationResult(await getData(request.patch(`${endpoint}/${id}/status`, { ...value, request_id: key(value.request_id) }, { signal })), id);
}
export async function apiActivityBackgroundDelete(id: number, value: ActivityBackgroundMutationKey, signal?: AbortSignal) {
  if (!integer(id, 1) || !revision(value.revision)) throw Error('活动背景身份或版本无效');
  return mutationResult(await getData(request.delete(`${endpoint}/${id}`, { data: { ...value, request_id: key(value.request_id) }, signal })), id);
}
