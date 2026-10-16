import { apiRequest } from './http';
import { getProductDetail, previewMode, previewProductRows, saveProduct } from './supplier';
import type { ProductDetail } from '@/types';

export interface ProductCopyContext { source_id: number; token: string; destination: { type: 2; relation_id: number } }
export interface ProductCopySeed { copy: ProductCopyContext; product: ProductDetail }
export interface PendingProductCopy { operation_id: string; actor_id: number; supplier_id: number; source_id: number }
export interface ProductCopyReceipt extends Omit<PendingProductCopy, 'source_id'> {
  source_id: number | null; state: 'unknown' | 'committed' | 'not_applied'; result: { id: number; is_show: 0; is_verify: 0 } | null;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= 2147483647;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** Copy carries only editable configuration. Historical identities, review
 * results and source-only configuration are reconstructed by the server. */
export function productCopyPayload(product: ProductDetail, labels?: number[]): ProductDetail {
  const fields = ['product_type', 'store_name', 'store_info', 'keyword', 'unit_name', 'bar_code', 'cate_id', 'slider_image',
    'description', 'spec_type', 'items', 'freight', 'postage', 'temp_id', 'is_postage', 'is_support_refund',
    'is_limit', 'limit_type', 'limit_num', 'sort', 'ficti', 'video_link'] as const;
  const skuFields = ['suk', 'detail', 'image', 'price', 'settle_price', 'cost', 'ot_price', 'vip_price', 'stock', 'bar_code',
    'weight', 'volume', 'brokerage', 'brokerage_two', 'code'] as const;
  const value = { id: 0, ...Object.fromEntries(fields.map(key => [key, product[key]])),
    attrs: product.attrs.map(sku => ({ ...Object.fromEntries(skuFields.map(key => [key, sku[key]])), disk_info: '' })),
    ...(labels ? { store_label_id: labels } : {}) };
  return JSON.parse(JSON.stringify(value)) as ProductDetail;
}
export function parsePendingProductCopy(value: unknown, actor: number, supplier: number): PendingProductCopy {
  if (!object(value) || Object.keys(value).length !== 4 || value.actor_id !== actor || value.supplier_id !== supplier
    || !positive(actor) || !positive(supplier) || !positive(value.source_id) || typeof value.operation_id !== 'string' || !uuid.test(value.operation_id))
    throw Error('未确认复制记录无效，请保留本窗口并核对原操作');
  return value as unknown as PendingProductCopy;
}
export function parseProductCopySeed(value: unknown, source: number, supplier: number): ProductCopySeed {
  if (!object(value) || !object(value.copy) || !object(value.copy.destination) || !object(value.product)) throw Error('复制来源资料不完整');
  const copy = value.copy, destination = value.copy.destination, product = value.product;
  if (!positive(source) || !positive(supplier) || copy.source_id !== source || typeof copy.token !== 'string' || !/^[a-f0-9]{64}$/.test(copy.token)
    || destination.type !== 2 || destination.relation_id !== supplier || product.id !== 0
    || ![0, 1, 3].includes(Number(product.product_type)) || typeof product.product_type !== 'number'
    || !Array.isArray(product.attrs) || product.attrs.length < 1 || product.attrs.length > 200
    || (product.retired_attrs !== undefined && (!Array.isArray(product.retired_attrs) || product.retired_attrs.length !== 0)))
    throw Error('复制来源归属、履约类型或规格无效');
  for (const sku of product.attrs) {
    if (!object(sku) || 'id' in sku || 'unique' in sku || (sku.disk_info !== undefined && sku.disk_info !== '')
      || (sku.original_disk_info !== undefined && sku.original_disk_info !== '') || sku.sales && sku.sales !== 0
      || sku.is_retired && sku.is_retired !== 0 || product.product_type === 1 && sku.stock !== 0
      || 'virtual_list' in sku || 'cards' in sku) throw Error('复制来源包含历史SKU身份或交付凭据');
  }
  return value as unknown as ProductCopySeed;
}
export function parseProductCopyReceipt(value: unknown, pending: PendingProductCopy): ProductCopyReceipt {
  if (!object(value) || Object.keys(value).length !== 6 || value.operation_id !== pending.operation_id
    || value.actor_id !== pending.actor_id || value.supplier_id !== pending.supplier_id
    || !['unknown', 'committed', 'not_applied'].includes(String(value.state))
    || (value.state === 'unknown' ? value.source_id !== null : value.source_id !== pending.source_id))
    throw Error('复制结果身份或操作编号不一致，请核对原结果');
  if (value.state === 'committed') {
    if (!object(value.result) || Object.keys(value.result).length !== 3 || !positive(value.result.id)
      || value.result.id === pending.source_id || value.result.is_show !== 0 || value.result.is_verify !== 0) throw Error('复制提交回执不完整');
  } else if (value.result !== null) throw Error('复制结果状态不一致');
  return value as unknown as ProductCopyReceipt;
}
const previewReceipts = new Map<string, ProductCopyReceipt>();
export async function getProductCopySeed(source: number, supplier: number, signal?: AbortSignal): Promise<ProductCopySeed> {
  if (!previewMode) return parseProductCopySeed(await apiRequest({ method: 'GET', url: `/product/product/copy/${source}`, signal }), source, supplier);
  if (!previewProductRows().some(row => row.id === source)) throw Error('示例复制来源不存在');
  const detail = await getProductDetail(source);
  const product = { ...detail, id: 0, is_show: 0, is_verify: 0, retired_attrs: [], attrs: detail.attrs.map(({ id, unique, ...sku }) => ({
    ...sku, sales: 0, is_retired: 0 as const, disk_info: '', original_disk_info: '', delivery_mode: 'card' as const,
    ...(detail.product_type === 1 ? { stock: 0, sumStock: 0 } : {}),
  })) };
  return parseProductCopySeed({ copy: { source_id: source, token: 'a'.repeat(64), destination: { type: 2, relation_id: supplier } }, product }, source, supplier);
}
export async function saveProductCopy(pending: PendingProductCopy, copy: ProductCopyContext, product: ProductDetail): Promise<ProductCopyReceipt> {
  if (copy.source_id !== pending.source_id || copy.destination.relation_id !== pending.supplier_id) throw Error('复制上下文已改变');
  if (!previewMode) return parseProductCopyReceipt(await apiRequest({ method: 'POST', url: `/product/product/copy/${pending.source_id}`,
    data: { operation_id: pending.operation_id, copy_token: copy.token, product } }), pending);
  const previous = previewReceipts.get(pending.operation_id); if (previous) return parseProductCopyReceipt(previous, pending);
  const saved = await saveProduct(0, product);
  const receipt: ProductCopyReceipt = { ...pending, state: 'committed', result: { id: saved.id, is_show: 0, is_verify: 0 } };
  previewReceipts.set(pending.operation_id, receipt); return receipt;
}
export async function recoverProductCopy(pending: PendingProductCopy, resolve = false): Promise<ProductCopyReceipt> {
  if (!previewMode) return parseProductCopyReceipt(await apiRequest({ method: resolve ? 'POST' : 'GET',
    url: `/product/product/copy_operations/${pending.operation_id}${resolve ? '/resolve' : ''}`,
    ...(resolve ? { data: { source_id: pending.source_id } } : {}) }), pending);
  let receipt = previewReceipts.get(pending.operation_id);
  if (!receipt && resolve) { receipt = { ...pending, state: 'not_applied', result: null }; previewReceipts.set(pending.operation_id, receipt); }
  return parseProductCopyReceipt(receipt ?? { ...pending, source_id: null, state: 'unknown', result: null }, pending);
}
