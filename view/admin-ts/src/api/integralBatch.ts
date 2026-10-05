import request, { getData } from '@/utils/request';

export interface IntegralBatchProduct { id: number; store_name: string; image: string; image_preview: string; stock: number; price: string; product_type: number; category_name: string; owner_type: number; relation_id: number; owner_name: string; valid: boolean; issues: string[]; }
export interface IntegralBatchSku { base_unique: string; suk: string; image: string; image_preview: string; price: string; integral: number; quota: number; cost: string; stock: number; weight: string; volume: string; bar_code: string; code: string; valid: boolean; issues: string[]; }
export interface IntegralBatchDetail { product: IntegralBatchProduct; revision: string; skus: IntegralBatchSku[]; }
export interface IntegralBatchPage { list: IntegralBatchProduct[]; count: number; categories: Array<{id: number; pid: number; cate_name: string}>; labels: Array<{id: number; label_name: string; status: number; is_show: number}>; limits: {max_products: number; max_total_skus: number; max_skus_per_product: number}; }
export interface IntegralBatchQuery { page: number; limit: number; keyword: string; category_id?: number | ''; label_id?: number | ''; }
export interface IntegralBatchInput { is_show: 0 | 1; products: Array<{product_id: number; revision: string; skus: Array<{base_unique: string; price: string; integral: number; quota: number; image: string}>}>; }
export interface IntegralBatchReceipt { request_id: string; payload_hash: string; products: Array<{product_id: number; integral_id: number}>; count: number; is_show: 0 | 1; }
const endpoint = '/activity/integral-batch';
const integer = (value: unknown, min = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= 2_147_483_647;
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value);
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('积分批量响应格式错误'); return value as Record<string, unknown>; }
function product(value: unknown): IntegralBatchProduct {
  const row = object(value);
  if (!integer(row.id, 1) || !integer(row.stock) || !integer(row.product_type) || !integer(row.owner_type) || !integer(row.relation_id) || typeof row.valid !== 'boolean' || !Array.isArray(row.issues) || row.issues.some(item => typeof item !== 'string') || ['store_name', 'image', 'image_preview', 'price', 'category_name', 'owner_name'].some(key => typeof row[key] !== 'string')) throw Error('基础商品响应格式错误');
  return row as unknown as IntegralBatchProduct;
}
export function parseIntegralBatchPage(value: unknown, limit: number): IntegralBatchPage {
  const page = object(value), limits = object(page.limits);
  if (!Array.isArray(page.list) || !integer(page.count) || page.list.length > limit || page.list.length > page.count || !Array.isArray(page.categories) || !Array.isArray(page.labels)
    || !integer(limits.max_products, 1) || limits.max_products > 100 || !integer(limits.max_total_skus, 1) || limits.max_total_skus > 1000 || !integer(limits.max_skus_per_product, 1) || limits.max_skus_per_product > 500) throw Error('商品选择分页响应格式错误');
  const list = page.list.map(product);
  if (new Set(list.map(row => row.id)).size !== list.length) throw Error('商品选择响应包含重复身份');
  for (const row of page.categories) { const item = object(row); if (!integer(item.id, 1) || !integer(item.pid) || typeof item.cate_name !== 'string') throw Error('商品分类响应格式错误'); }
  for (const row of page.labels) { const item = object(row); if (!integer(item.id, 1) || typeof item.label_name !== 'string') throw Error('商品标签响应格式错误'); }
  return {...page, list} as unknown as IntegralBatchPage;
}
export function parseIntegralBatchDetail(value: unknown, id: number): IntegralBatchDetail {
  const detail = object(value), source = product(detail.product);
  if (source.id !== id || !digest(detail.revision) || !Array.isArray(detail.skus) || !detail.skus.length || detail.skus.length > 500) throw Error('商品规格响应格式错误');
  const seen = new Set<string>();
  for (const value of detail.skus) {
    const row = object(value);
    if (typeof row.base_unique !== 'string' || !row.base_unique || seen.has(row.base_unique) || !integer(row.stock) || !integer(row.integral) || !integer(row.quota)
      || typeof row.valid !== 'boolean' || !Array.isArray(row.issues) || row.issues.some(item => typeof item !== 'string') || ['suk', 'image', 'image_preview', 'price', 'cost', 'weight', 'volume', 'bar_code', 'code'].some(key => typeof row[key] !== 'string')) throw Error('商品规格身份或数值无效');
    seen.add(row.base_unique);
  }
  return {...detail, product: source} as unknown as IntegralBatchDetail;
}
export function parseIntegralBatchReceipt(value: unknown, requestId: string): IntegralBatchReceipt {
  const receipt = object(value);
  if (receipt.request_id !== requestId || !uuid(receipt.request_id) || !digest(receipt.payload_hash) || !integer(receipt.count, 1) || receipt.count > 100
    || ![0, 1].includes(Number(receipt.is_show)) || typeof receipt.is_show !== 'number' || !Array.isArray(receipt.products) || receipt.products.length !== receipt.count) throw Error('积分批量回执格式错误');
  const ids = new Set<number>(), created = new Set<number>();
  for (const value of receipt.products) { const row = object(value); if (!integer(row.product_id, 1) || !integer(row.integral_id, 1) || ids.has(row.product_id) || created.has(row.integral_id)) throw Error('积分批量回执身份重复或无效'); ids.add(row.product_id); created.add(row.integral_id); }
  return receipt as unknown as IntegralBatchReceipt;
}
export function integralBatchMoney(value: string): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/u.test(value)) throw Error('现金价格须为非负金额，最多两位小数');
  return Number(value).toFixed(2);
}
export function integralBatchImage(value: string, signed = ''): string {
  const candidate = signed || (/^\/api\/assets\//u.test(value) ? '' : value);
  return /^(https:\/\/|\/(?!\/))/iu.test(candidate) && !/[\u0000-\u0020\u007f\\]/u.test(candidate) ? candidate : '';
}
export function normalizeIntegralBatch(input: IntegralBatchInput): IntegralBatchInput {
  if (![0, 1].includes(input.is_show) || !Array.isArray(input.products) || !input.products.length || input.products.length > 100) throw Error('请选择1–100个商品并设置上架状态');
  const ids = new Set<number>(); let total = 0;
  const products = input.products.map(row => {
    if (!integer(row.product_id, 1) || ids.has(row.product_id) || !digest(row.revision) || !Array.isArray(row.skus) || !row.skus.length || row.skus.length > 500) throw Error('商品或规格身份无效、重复或过期');
    ids.add(row.product_id); const seen = new Set<string>();
    const skus = row.skus.map(sku => {
      if (typeof sku.base_unique !== 'string' || !sku.base_unique || sku.base_unique.length > 8 || /[\u0000-\u0020\u007f]/u.test(sku.base_unique) || seen.has(sku.base_unique) || !integer(sku.integral) || !integer(sku.quota, 1)) throw Error('兑换积分须为非负整数，兑换次数须为正整数；规格标识须有效且不能重复');
      if (typeof sku.image !== 'string' || [...sku.image].length > 128 || (sku.image && !integralBatchImage(sku.image) && !/^\/api\/assets\/[1-9]\d*$/u.test(sku.image))) throw Error('规格图片须为128字内的安全HTTPS地址、站内路径或图库图片');
      if (/^https:\/\//iu.test(sku.image)) { const image = new URL(sku.image); if (image.username || image.password || image.hash) throw Error('规格图片不能包含账户或片段信息'); }
      const price = integralBatchMoney(sku.price);
      if (price === '0.00' && sku.integral === 0) throw Error('兑换积分和现金价格不能同时为0');
      seen.add(sku.base_unique); total++;
      return {base_unique: sku.base_unique, price, integral: sku.integral, quota: sku.quota, image: sku.image};
    });
    skus.sort((a,b) => a.base_unique < b.base_unique ? -1 : a.base_unique > b.base_unique ? 1 : 0);
    return {product_id: row.product_id, revision: row.revision, skus};
  });
  if (total > 1000) throw Error('一批最多1000个规格');
  products.sort((a,b) => a.product_id - b.product_id);
  return {is_show: input.is_show, products};
}
export async function apiIntegralBatchProducts(query: IntegralBatchQuery, signal?: AbortSignal): Promise<IntegralBatchPage> { return parseIntegralBatchPage(await getData(request.get(`${endpoint}/products`, {params: query, signal})), query.limit); }
export async function apiIntegralBatchProduct(id: number, signal?: AbortSignal): Promise<IntegralBatchDetail> { return parseIntegralBatchDetail(await getData(request.get(`${endpoint}/products/${id}`, {signal})), id); }
export async function apiIntegralBatchCreate(input: IntegralBatchInput & {request_id: string}, signal?: AbortSignal): Promise<IntegralBatchReceipt> { return parseIntegralBatchReceipt(await getData(request.post(endpoint, {...normalizeIntegralBatch(input), request_id: input.request_id}, {signal})), input.request_id); }
export async function apiIntegralBatchReceipt(requestId: string, signal?: AbortSignal): Promise<IntegralBatchReceipt> { return parseIntegralBatchReceipt(await getData(request.get(`${endpoint}/receipts/${requestId}`, {signal})), requestId); }
