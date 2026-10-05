import request, { getData } from '@/utils/request';
import { activityCategoryTree, type SeckillActivityCategory, type SeckillActivityLabel } from './seckillActivity';
export { activityCategoryTree as combinationCategoryTree } from './seckillActivity';
export type CombinationPhase = 'future' | 'active' | 'ended' | 'invalid';
export interface CombinationOwner { type: number; relation_id: number }
export interface CombinationShipping { delivery_type: number[]; freight: 1 | 2 | 3; postage: string; temp_id: number }
export interface CombinationSku {
  id: number | null; base_unique: string; unique: string; suk: string; image: string; image_preview: string;
  price: string; cost: string; ot_price: string; quota_total: number; consumed: number; remaining: number;
  stock: number; base_stock: number; enabled: boolean; retired: boolean; valid: boolean; issues: string[];
  weight?: string | number; volume?: string | number; bar_code?: string; code?: string;
}
export interface CombinationRow {
  id: number; product_id: number; title: string; image: string; image_preview: string; start_time: string; end_time: string;
  status: 0 | 1; phase: CombinationPhase; people: number; quota_total: number; consumed: number; remaining: number;
  stock: number; sales: number; sort: number; valid: boolean; issues: string[]; revision: string; raw?: Record<string, unknown>;
}
export interface CombinationSource {
  product_id: number; product_type: number; owner: CombinationOwner; title: string; info: string; unit_name: string;
  images: string[]; images_preview: string[]; description: string; description_preview: string; is_support_refund: 0 | 1;
  shipping: CombinationShipping; skus: CombinationSku[]; valid: boolean; issues: string[];
  templates?: CombinationOptions['templates'];
  source_metadata?: Record<string, unknown>;
}
export interface CombinationDetail extends CombinationRow, CombinationSource {
  effective_time: number; num: number; once_num: number; virtual: number; is_host: 0 | 1;
}
export interface CombinationProduct { product_id: number; store_name: string; image: string; image_preview: string; product_type: number; category_name: string; stock: number; valid: boolean; issues: string[] }
export interface CombinationOptions {
  categories: SeckillActivityCategory[]; labels: SeckillActivityLabel[]; units: { id: number; name: string }[];
  templates: { id: number; name: string; owner_type: number; relation_id: number }[];
  max_skus: number; max_categories: number; max_labels: number; max_images: number;
}
export interface CombinationQuery { page: number; limit: number; keyword: string; phase: '' | CombinationPhase; status: '' | 0 | 1 }
export interface CombinationProductQuery { page: number; limit: number; keyword: string; category_id: '' | number; label_id: '' | number }
export interface CombinationPage<T> { list: T[]; count: number; page: number; limit: number }
export interface CombinationSkuInput { id: number | null; base_unique: string; enabled: boolean; price: string; quota_total: number; image: string }
export interface CombinationInput {
  product_type?: number;
  product_id: number; title: string; info: string; unit_name: string; images: string[]; description: string;
  start_time: string; end_time: string; effective_time: number; people: number; num: number; once_num: number;
  virtual: number; sort: number; status: 0 | 1; is_host: 0 | 1; is_support_refund: 0 | 1;
  shipping: CombinationShipping; skus: CombinationSkuInput[];
}
export type CombinationSave = CombinationInput & { request_id: string; revision?: string };
export interface CombinationMutationKey { revision: string; request_id: string }
const endpoint = '/activity/combinations';
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 2147483647;
const positive = (value: unknown): value is number => integer(value) && value > 0;
const numeric = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const flag = (value: unknown): value is 0 | 1 => value === 0 || value === 1;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
export function combinationPreview(signed: string) { if (!/^(https:\/\/|\/(?!\/))/iu.test(signed) || /[\u0000-\u0020\u007f\\]/u.test(signed)) return ''; if (/^https:/iu.test(signed)) { try { const url = new URL(signed); if (url.username || url.password) return ''; } catch { return ''; } } return signed; }
export function combinationPicture(value: string, limit = 255) {
  const reference = value.trim();
  if (!reference || [...reference].length > limit || /[\u0000-\u0020\u007f\\]/u.test(reference)) throw Error(`图片须为不超过${limit}字的稳定地址`);
  if (/^\/api\/assets\//u.test(reference)) { if (!/^\/api\/assets\/[1-9]\d*$/u.test(reference)) throw Error('请从图库选择稳定图片引用'); }
  else if (!/^\/(?!\/)/u.test(reference)) { try { const url = new URL(reference); if (url.protocol !== 'https:' || url.username || url.password) throw Error(); } catch { throw Error('图片须为安全HTTPS或站内路径'); } }
  return reference;
}
export function combinationMoney(value: string, zero = true, digits = 10) {
  if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/u.test(value) || value.split('.')[0]!.length > digits || (!zero && Number(value) <= 0)) throw Error('金额须为非负规范十进制，最多两位小数');
  return Number(value).toFixed(2);
}
export function combinationTime(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.000)?Z$/u.test(value)) throw Error('活动时间须为UTC ISO时间');
  const date = new Date(value), seconds = date.getTime() / 1000;
  if (!positive(seconds) || date.toISOString().replace('.000Z', 'Z') !== value.replace('.000Z', 'Z')) throw Error('活动时间无效或超出支持范围');
  return date.toISOString();
}
export function combinationLocalTime(value: string) { try { return new Date(Date.parse(combinationTime(value)) + 8 * 3600000).toISOString().slice(0, 16); } catch { return ''; } }
export function combinationUtcTime(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(value)) throw Error('请选择完整日期和时间');
  const result = new Date(`${value}:00+08:00`).toISOString(); if (combinationLocalTime(result) !== value) throw Error('活动日期无效'); return combinationTime(result);
}
export function combinationRequiredReal(people: number, virtual: number) { return Math.ceil(people * virtual / 100); }
function text(value: string, max: number, name: string, empty = false) { const result = value.trim(); if ((!result && !empty) || [...result].length > max || /[\u0000-\u001f\u007f]/u.test(result)) throw Error(`${name}须为${empty ? '0' : '1'}–${max}字且不能包含控制字符`); return result; }
export function normalizeCombinationInput(value: CombinationInput): CombinationInput {
  if (!positive(value.product_id)) throw Error('请选择有效来源商品');
  const title = text(value.title, 256, '拼团名称'), info = text(value.info, 255, '简介'), unit_name = text(value.unit_name, 32, '商品单位');
  const start_time = combinationTime(value.start_time), end_time = combinationTime(value.end_time); if (start_time >= end_time) throw Error('开始时间须早于结束时间');
  if (!positive(value.effective_time) || !positive(value.people) || value.people < 2 || value.people > 500 || !positive(value.num) || !positive(value.once_num) || value.once_num > value.num) throw Error('时效、成团人数(2–500)及限购无效；单次不能大于累计');
  if (!positive(value.virtual) || value.virtual > 100 || !integer(value.sort) || !flag(value.status) || !flag(value.is_host) || !flag(value.is_support_refund)) throw Error('虚拟阈值、排序或开关错误');
  if (!Array.isArray(value.images) || value.images.length < 1 || value.images.length > 10) throw Error('请选择1–10张轮播图');
  const images = value.images.map(value => combinationPicture(value)); if (new Set(images).size !== images.length) throw Error('轮播图不能重复'); if ([...JSON.stringify(images)].length > 2000) throw Error('轮播图地址总长度超过2000字');
  if (typeof value.description !== 'string' || value.description.length > 200000) throw Error('商品内容不能超过200000字');
  const shipping = value.shipping;
  if (!shipping || !Array.isArray(shipping.delivery_type) || !shipping.delivery_type.length || shipping.delivery_type.some(value => ![1, 2, 3].includes(value)) || new Set(shipping.delivery_type).size !== shipping.delivery_type.length || ![1, 2, 3].includes(shipping.freight) || !integer(shipping.temp_id)) throw Error('配送方式或运费模板配置无效');
  const postage = combinationMoney(shipping.postage.trim(), true, 8); if (shipping.freight === 2 && Number(postage) <= 0 && !(value.product_type !== undefined && value.product_type > 0)) throw Error('固定邮费须大于0'); if (shipping.freight === 3 && !shipping.temp_id) throw Error('请选择运费模板');
  if (!Array.isArray(value.skus) || !value.skus.length || value.skus.length > 500) throw Error('规格不完整，每商品最多500规格');
  const ids = new Set<number>(), bases = new Set<string>();
  const skus = value.skus.map(sku => {
    if (!(sku.id === null || positive(sku.id)) || (sku.id !== null && ids.has(sku.id)) || typeof sku.base_unique !== 'string' || typeof sku.price !== 'string' || typeof sku.image !== 'string' || typeof sku.enabled !== 'boolean') throw Error('规格身份错误或重复');
    if (sku.id !== null) ids.add(sku.id);
    if (!sku.enabled && sku.id !== null) return { id: sku.id, base_unique: sku.base_unique, enabled: false, price: sku.price, quota_total: sku.quota_total, image: sku.image };
    if (!sku.base_unique || sku.base_unique.length > 8 || /[\u0000-\u0020\u007f]/u.test(sku.base_unique) || bases.has(sku.base_unique) || !integer(sku.quota_total)) throw Error('规格标识或配置总额度无效'); bases.add(sku.base_unique);
    if (sku.enabled && !sku.image.trim()) throw Error('参与规格须选择有效图片');
    return { id: sku.id, base_unique: sku.base_unique, enabled: sku.enabled, price: sku.enabled ? combinationMoney(sku.price.trim()) : sku.price, quota_total: sku.quota_total, image: sku.image ? combinationPicture(sku.image, 128) : '' };
  });
  if (value.status === 1 && !skus.some(sku => sku.enabled)) throw Error('开启活动须至少有一个参与规格');
  return { product_id: value.product_id, title, info, unit_name, images, description: value.description, start_time, end_time, effective_time: value.effective_time, people: value.people, num: value.num, once_num: value.once_num, virtual: value.virtual, sort: value.sort, status: value.status, is_host: value.is_host, is_support_refund: value.is_support_refund, shipping: { delivery_type: [...shipping.delivery_type], freight: shipping.freight, postage, temp_id: shipping.temp_id }, skus };
}
function sku(value: unknown): CombinationSku { const item = value as CombinationSku; if (!item || !(item.id === null || positive(item.id)) || ![item.base_unique, item.unique, item.suk, item.image, item.image_preview, item.price, item.cost, item.ot_price].every(value => typeof value === 'string') || ![item.quota_total, item.consumed, item.remaining, item.stock, item.base_stock].every(numeric) || ![item.enabled, item.retired, item.valid].every(value => typeof value === 'boolean') || !strings(item.issues)) throw Error('拼团规格响应错误'); return item; }
export function parseCombinationSource(value: unknown, historical = false): CombinationSource {
  const item = value as CombinationSource;
  if (!item || !(historical ? numeric(item.product_id) : positive(item.product_id)) || !(historical ? numeric(item.product_type) : integer(item.product_type)) || !item.owner || !(historical ? numeric(item.owner.type) : integer(item.owner.type)) || !(historical ? numeric(item.owner.relation_id) : integer(item.owner.relation_id)) || ![item.title, item.info, item.unit_name, item.description, item.description_preview].every(value => typeof value === 'string') || !strings(item.images) || !strings(item.images_preview) || item.images.length > 10 || item.images.length !== item.images_preview.length || !flag(item.is_support_refund) || !item.shipping || !Array.isArray(item.shipping.delivery_type) || !numeric(item.shipping.freight) || !numeric(item.shipping.temp_id) || typeof item.shipping.postage !== 'string' || !Array.isArray(item.skus) || item.skus.length > 500 || typeof item.valid !== 'boolean' || !strings(item.issues)) throw Error('拼团来源/详情不完整或超限，不能编辑截断数据');
  item.skus.forEach(sku); if (item.templates !== undefined) templates(item.templates); return item;
}
function templates(value: unknown) { const list = value as CombinationOptions['templates']; if (!Array.isArray(list) || list.length > 5000 || list.some(item => !item || !positive(item.id) || typeof item.name !== 'string' || !integer(item.owner_type) || !integer(item.relation_id)) || new Set(list.map(item => item.id)).size !== list.length) throw Error('运费模板响应不完整或超限'); return list; }
export function parseCombinationRow(value: unknown): CombinationRow { const item = value as CombinationRow; if (!item || !positive(item.id) || !numeric(item.product_id) || ![item.title, item.image, item.image_preview, item.start_time, item.end_time].every(value => typeof value === 'string') || !flag(item.status) || !['future', 'active', 'ended', 'invalid'].includes(item.phase) || ![item.people, item.quota_total, item.consumed, item.remaining, item.stock, item.sales, item.sort].every(numeric) || typeof item.valid !== 'boolean' || !strings(item.issues) || !/^[a-f0-9]{64}$/u.test(item.revision)) throw Error('拼团目录响应错误'); return item; }
export function parseCombinationDetail(value: unknown): CombinationDetail { const item = parseCombinationRow(value) as CombinationDetail; parseCombinationSource(item, true); if (![item.effective_time, item.num, item.once_num, item.virtual].every(numeric) || !flag(item.is_host)) throw Error('拼团详情字段不完整'); return item; }
function product(value: unknown): CombinationProduct { const item = value as CombinationProduct; if (!item || !positive(item.product_id) || !integer(item.product_type) || ![item.store_name, item.image, item.image_preview, item.category_name].every(value => typeof value === 'string') || !numeric(item.stock) || typeof item.valid !== 'boolean' || !strings(item.issues)) throw Error('候选商品响应错误'); return item; }
function page<T>(value: unknown, query: { page: number; limit: number }, parser: (value: unknown) => T, id: (value: T) => number): CombinationPage<T> { const item = value as CombinationPage<T>; if (!item || !Array.isArray(item.list) || !integer(item.count) || item.page !== query.page || item.limit !== query.limit || item.list.length > query.limit || item.list.length > item.count) throw Error('拼团分页响应错误'); item.list.forEach(parser); if (new Set(item.list.map(id)).size !== item.list.length) throw Error('拼团分页记录重复'); return item; }
export async function apiCombinationList(query: CombinationQuery, signal?: AbortSignal) { return page(await getData(request.get(endpoint, { params: query, signal })), query, parseCombinationRow, item => item.id); }
export async function apiCombinationDetail(id: number, signal?: AbortSignal) { const result = parseCombinationDetail(await getData(request.get(`${endpoint}/${id}`, { signal }))); if (result.id !== id) throw Error('详情身份与请求不符'); return result; }
export async function apiCombinationOptions(signal?: AbortSignal) { const result = await getData<CombinationOptions>(request.get(`${endpoint}/options`, { signal })); if (!result || result.max_skus !== 500 || result.max_categories !== 5000 || result.max_labels !== 5000 || result.max_images !== 10 || !Array.isArray(result.labels) || result.labels.length > 5000 || !Array.isArray(result.units) || result.units.length > 5000 || !Array.isArray(result.templates)) throw Error('拼团配置选项不完整'); activityCategoryTree(result.categories); templates(result.templates); if (result.labels.some(item => !positive(item.id) || typeof item.label_name !== 'string') || result.units.some(item => !positive(item.id) || typeof item.name !== 'string') || result.templates.some(item => !positive(item.id) || typeof item.name !== 'string' || !integer(item.owner_type) || !integer(item.relation_id))) throw Error('拼团单位/模板/标签选项错误'); for (const list of [result.labels, result.units, result.templates]) if (new Set(list.map(item => item.id)).size !== list.length) throw Error('拼团选项标识重复'); return result; }
export async function apiCombinationProducts(query: CombinationProductQuery, signal?: AbortSignal) { return page(await getData(request.get(`${endpoint}/products`, { params: query, signal })), query, product, item => item.product_id); }
export async function apiCombinationProduct(id: number, signal?: AbortSignal) { const result = parseCombinationSource(await getData(request.get(`${endpoint}/products/${id}`, { signal }))); if (result.product_id !== id) throw Error('来源商品身份与请求不符'); return result; }
function result(value: unknown, id: number) { const item = value as { id: number }; if (!item || !positive(item.id) || (id && item.id !== id)) throw Error('写结果未确认，请重新读取核对'); return item; }
export async function apiCombinationSave(id: number, body: CombinationSave, signal?: AbortSignal) { return result(await getData(id ? request.put(`${endpoint}/${id}`, body, { signal }) : request.post(endpoint, body, { signal })), id); }
export async function apiCombinationStatus(id: number, body: CombinationMutationKey & { status: 0 | 1 }, signal?: AbortSignal) { return result(await getData(request.put(`${endpoint}/${id}/status`, body, { signal })), id); }
export async function apiCombinationDelete(id: number, body: CombinationMutationKey, signal?: AbortSignal) { return result(await getData(request.delete(`${endpoint}/${id}`, { data: body, signal })), id); }
