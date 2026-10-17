import { classifyProductMediaReference } from '../../../common/productMediaReference';
import { productImagePreview, type ProductMediaPreview } from './productMedia';
import type { SupplierProductDetail, SupplierProductDetailContext } from '@/types/productDetail';

const failure = () => { throw Error('商品详情与当前账号或商品不符，请重新读取'); };
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return failure();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) return failure();
  return row;
}
function integer(value: unknown, min = 0, max = 2_147_483_647): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return failure();
  return value;
}
function text(value: unknown, max = 4096): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) return failure();
  return value;
}
function money(value: unknown): string {
  const valueText = text(value, 21);
  return /^(?:0|[1-9]\d{0,17})\.\d{2}$/.test(valueText) ? valueText : failure();
}
export function formatSupplierProductDetailMoney(value: string): string {
  if (!/^(?:0|[1-9]\d{0,17})\.\d{2}$/.test(value)) return '—';
  const [whole, fraction] = value.split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction}`;
}
function array(value: unknown, max: number): unknown[] {
  return Array.isArray(value) && value.length <= max ? value : failure();
}
const productKeys = ['product_type', 'store_name', 'store_info', 'keyword', 'unit_name', 'bar_code', 'image', 'slider_image',
  'price', 'ot_price', 'vip_price', 'stock', 'sales', 'spec_type', 'freight', 'postage', 'temp_id', 'is_postage',
  'is_support_refund', 'is_limit', 'limit_type', 'limit_num', 'is_show', 'is_verify', 'refusal', 'sort', 'ficti',
  'add_time', 'video_link', 'video_preview_url'] as const;

export function parseSupplierProductDetail(value: unknown, expected: SupplierProductDetailContext): SupplierProductDetail {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 2 * 1024 * 1024) return failure();
  const row = object(value, ['version', 'actor_id', 'supplier_id', 'product_id', 'product', 'attributes', 'skus', 'media', 'bounded']);
  if (row.version !== 'supplier-product-detail-v1' || row.bounded !== true
    || integer(row.actor_id, 1) !== expected.actorId || integer(row.supplier_id, 1) !== expected.supplierId
    || integer(row.product_id, 1) !== expected.productId) return failure();
  const product = object(row.product, productKeys);
  for (const key of ['product_type', 'stock', 'sales', 'spec_type', 'freight', 'temp_id', 'is_postage',
    'is_support_refund', 'is_limit', 'limit_type', 'limit_num', 'is_show', 'ficti', 'add_time']) integer(product[key]);
  integer(product.sort, -2_147_483_648);
  integer(product.is_verify, -2, 2);
  for (const key of ['store_name', 'store_info', 'keyword', 'unit_name', 'bar_code', 'image', 'refusal', 'video_link', 'video_preview_url']) text(product[key]);
  for (const key of ['price', 'ot_price', 'vip_price', 'postage']) money(product[key]);
  const sliders = array(product.slider_image, 10).map(value => text(value));
  const attributes = array(row.attributes, 16).map(value => {
    const attribute = object(value, ['name', 'values']), name = text(attribute.name, 128);
    const values = array(attribute.values, 100).map(value => text(value, 512));
    if (!name || new Set(values).size !== values.length) return failure();
    return { name, values };
  });
  if (new Set(attributes.map(item => item.name)).size !== attributes.length) return failure();
  let previousId = 0;
  const skus = array(row.skus, 500).map(value => {
    const sku = object(value, ['id', 'suk', 'price', 'ot_price', 'vip_price', 'stock', 'sales', 'image', 'bar_code', 'is_retired']);
    const id = integer(sku.id, 1); if (id <= previousId || sku.is_retired !== 0) return failure(); previousId = id;
    return { id, suk: text(sku.suk, 512), price: money(sku.price), ot_price: money(sku.ot_price), vip_price: money(sku.vip_price),
      stock: integer(sku.stock), sales: integer(sku.sales), image: text(sku.image), bar_code: text(sku.bar_code), is_retired: 0 as const };
  });
  const rawMedia = object(row.media, ['version', 'status', 'previews', 'description_html']);
  if (rawMedia.version !== 1 || typeof rawMedia.status !== 'string' || !['ready', 'partial', 'too_many_references'].includes(rawMedia.status)) return failure();
  const description = text(rawMedia.description_html, 400_000), previews: Record<string, ProductMediaPreview> = Object.create(null);
  if (!rawMedia.previews || typeof rawMedia.previews !== 'object' || Array.isArray(rawMedia.previews)
    || Object.keys(rawMedia.previews).length > 640) return failure();
  for (const [key, value] of Object.entries(rawMedia.previews)) {
    text(key); if (['__proto__', 'prototype', 'constructor'].includes(key)) return failure();
    if (!value || typeof value !== 'object' || Array.isArray(value)) return failure();
    if ((value as { status?: unknown }).status === 'unavailable') {
      const entry = object(value, ['status', 'expires_at']); if (entry.expires_at !== null) return failure();
      previews[key] = { status: 'unavailable', expires_at: null }; continue;
    }
    const entry = object(value, ['status', 'src', 'expires_at']), src = text(entry.src);
    const classified = classifyProductMediaReference(key);
    if (entry.status !== 'ready' || classified.kind === 'invalid' || classified.reference !== key) return failure();
    if (classified.kind === 'asset') {
      const expires = integer(entry.expires_at, 1);
      const match = new RegExp(`^${key}\\?expires=([1-9]\\d*)&signature=([A-Za-z0-9_-]{43})$`).exec(src);
      if (!match || Number(match[1]) !== expires) return failure();
      previews[key] = { status: 'ready', src, expires_at: expires };
    } else {
      if (entry.expires_at !== null || src !== key) return failure();
      previews[key] = { status: 'ready', src, expires_at: null };
    }
  }
  if (rawMedia.status === 'too_many_references' && (description || Object.keys(previews).length)) return failure();
  return { version: 'supplier-product-detail-v1', actor_id: expected.actorId, supplier_id: expected.supplierId,
    product_id: expected.productId, bounded: true, product: { ...product, slider_image: sliders } as SupplierProductDetail['product'],
    attributes, skus, media: { version: 1, status: rawMedia.status as SupplierProductDetail['media']['status'], previews, description_html: description } };
}

/** Videos have their own server ownership projection; they are not image entries. */
export function supplierProductDetailVideo(detail: SupplierProductDetail, now = Date.now()): string | null {
  const { video_link: reference, video_preview_url: src } = detail.product;
  if (!reference || !src) return null;
  const classified = classifyProductMediaReference(reference);
  if (classified.kind === 'invalid' || classified.reference !== reference) return null;
  if (classified.kind === 'public') return src === reference ? src : null;
  const match = /^\/api\/assets\/[1-9]\d*\?expires=([1-9]\d*)&signature=[A-Za-z0-9_-]{43}$/.exec(src);
  return match ? productImagePreview(reference, { [reference]: { status: 'ready', src, expires_at: Number(match[1]) } }, now) : null;
}
