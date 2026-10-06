import type { storeIntegral, storeProduct, storeProductAttrValue } from '@/models/schema';
import { NotFoundException, ValidateException } from '@/utils/errors';
import { parseLevelActivationJson } from '@/services/admin/AdminLevelActivationInput';
import type { publicProductDetailDesign } from '@/services/content/ProductDetailDesignReadService';

export const INTEGRAL_DETAIL_LIMITS = { skus: 500, attributes: 10, definitions: 100, description: 200000, json: 100000, bodyAssets: 1000 } as const;
export const INTEGRAL_DETAIL_CONFIG_KEYS = ['site_name', 'share_qrcode', 'product_poster_title'] as const;
export type IntegralDetailSku = { id: number; unique: string; suk: string; image: string; price: string; otPrice: string; integral: number; stock: number; purchasable: boolean; issues: string[] };
export type IntegralDetail = {
  product_detail_design:ReturnType<typeof publicProductDetailDesign>;
  storeInfo: { id: number; productId: number; storeName: string; unitName: string; image: string; images: string[]; description: string;
    productType: number; sales: number; onceNum: number; num: number; systemFormId: number; deliveryType: string[];
    price: string; otPrice: string; integral: number; brandName: string;
    storeLabel: Array<{ id: number; labelName: string; styleType: number; color: string; bgColor: string; borderColor: string; icon: string }>;
    ensure: Array<{ id: number; name: string; image: string; desc: string }>;
    specs: Array<{ name: string; value: string; sort: number }>;
  };
  productAttr: Array<{ id: number; name: string; values: string[] }>;
  productValue: Record<string, IntegralDetailSku>;
  skus: IntegralDetailSku[]; saleStock: 0 | 1; issues: string[];
  siteName: string; siteUrl: string; shareQrcode: 0 | 1; productPosterTitle: string;
};
/** The catalogue may diagnose this precise public-visibility failure. SQL,
 * deadlines and unexpected errors must not be converted into hidden rows. */
export class IntegralProductUnavailableException extends NotFoundException {
  constructor(readonly issues: string[]) { super('积分商品不存在、已下架或关联信息异常'); }
}
export function integralDetailId(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2147483647) return value;
  if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value)) throw new ValidateException('积分商品ID须为正整数');
  const id = Number(value); if (id > 2147483647) throw new ValidateException('积分商品ID超过有效范围'); return id;
}
export function integralDetailInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 2147483647;
}
export function integralDetailMoney(value: unknown): string | null {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.'); return `${whole}.${fraction.padEnd(2, '0')}`;
}
/** Public H5 share origin is an explicit deployment binding, never request
 * Host, SQL site_url or the API endpoint. Accept only canonical HTTPS DNS. */
export function integralPublicH5Origin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 255 || !value.startsWith('https://')) return '';
  try {
    const parsed = new URL(value), labels = parsed.hostname.split('.');
    if (parsed.origin !== value || parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash) return '';
    if (labels.length < 2 || parsed.hostname.length > 253 || !/^[a-z]{2,63}$/.test(labels.at(-1)!) || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return '';
    return value;
  } catch { return ''; }
}
export function integralDetailText(value: unknown, maximum: number): string {
  return typeof value === 'string' && [...value].length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value) ? value : '';
}
export function integralDetailJson(value: string | null, issues: string[], issue: string): unknown {
  if (!value) return null;
  if (value.length > INTEGRAL_DETAIL_LIMITS.json) { issues.push(issue); return null; }
  try { return parseLevelActivationJson(value); } catch { issues.push(issue); return null; }
}
export function integralDetailIds(value: string | null, issues: string[], issue: string): number[] {
  if (!value) return [];
  if (value.length > 2000) { issues.push(issue); return []; }
  const pieces = value.split(',').filter(part => part.trim() !== '');
  if (pieces.length > INTEGRAL_DETAIL_LIMITS.definitions || pieces.some(part => !/^[1-9]\d{0,9}$/.test(part.trim()) || Number(part.trim()) > 2147483647)) { issues.push(issue); return []; }
  return [...new Set(pieces.map(part => Number(part.trim())))];
}
export function integralDetailSpecs(value: string | null, issues: string[]): IntegralDetail['storeInfo']['specs'] {
  const parsed = integralDetailJson(value, issues, 'specs_invalid'); if (parsed === null) return [];
  if (!Array.isArray(parsed) || parsed.length > INTEGRAL_DETAIL_LIMITS.definitions) { issues.push('specs_invalid'); return []; }
  const result: IntegralDetail['storeInfo']['specs'] = [];
  for (const row of parsed) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) { issues.push('specs_invalid'); continue; }
    const name = integralDetailText(row.name, 255), field = integralDetailText(row.value, 255);
    if (!name || !field || !Number.isSafeInteger(row.sort ?? 0) || (row.sort ?? 0) < -2147483648 || (row.sort ?? 0) > 2147483647) { issues.push('specs_invalid'); continue; }
    result.push({ name, value: field, sort: row.sort ?? 0 });
  }
  return result.sort((a, b) => b.sort - a.sort);
}
export function integralDetailColor(value: string): string {
  return /^(?:#[\da-f]{3,8}|[a-z]{1,20}|rgba?\([\d., %]+\))$/i.test(value) ? value : '';
}
export type IntegralSkuSource = Pick<typeof storeProductAttrValue.$inferSelect, 'id' | 'productId' | 'productType' | 'unique' | 'suk' | 'image' | 'price' | 'otPrice' | 'integral' | 'stock' | 'quota' | 'isRetired'>;
type StockActivity = Pick<typeof storeIntegral.$inferSelect, 'id' | 'productId' | 'productType' | 'stock' | 'quota'>;
type StockProduct = Pick<typeof storeProduct.$inferSelect, 'id' | 'productType' | 'stock'>;
/** Bulk form of the legacy bridge: exact (activity,4,suk) to (base,0,suk).
 * No first/last winner, no root-price or ordinary-SKU fallback. */
export function projectIntegralDetailSkus(activity: StockActivity, product: StockProduct, activityRows: IntegralSkuSource[], baseRows: IntegralSkuSource[], blocked: readonly string[] = []): IntegralDetailSku[] {
  const identities = (rows: IntegralSkuSource[], key: 'suk' | 'unique', value: string) => rows.filter(row => row[key].replace(/ +$/u, '') === value);
  return activityRows.map(row => {
    const issues = [...blocked], unique = row.unique.replace(/ +$/u, ''), suk = row.suk;
    if (row.isRetired !== 0) issues.push('activity_sku_retired');
    if (!unique || unique.length > 8 || /[\u0000-\u0020\u007f]/u.test(unique) || !suk || suk !== suk.trim() || /[\u0000-\u001f\u007f]/u.test(suk)) issues.push('sku_identity_invalid');
    if (identities(activityRows, 'unique', unique).length !== 1 || identities(activityRows, 'suk', suk).length !== 1) issues.push('activity_sku_ambiguous');
    const matches = baseRows.filter(base => base.suk === suk && base.isRetired === 0), base = matches.length === 1 ? matches[0] : null;
    if (matches.length !== 1) issues.push(matches.length ? 'base_sku_ambiguous' : 'base_sku_missing');
    const sameToken = identities(baseRows, 'unique', unique);
    if (sameToken.length > 1 || sameToken.some(base => base.suk !== suk) || (base && identities(baseRows, 'unique', base.unique.replace(/ +$/u, '')).length !== 1)) issues.push('sku_identity_conflict');
    if (row.productId !== activity.id || row.productType !== product.productType || (base && (base.productId !== product.id || base.productType !== product.productType))) issues.push('sku_product_type_mismatch');
    const price = integralDetailMoney(row.price), otPrice = integralDetailMoney(row.otPrice);
    if (price === null || otPrice === null) issues.push('sku_money_invalid');
    if (!integralDetailInteger(row.integral) || (row.integral === 0 && price === '0.00')) issues.push('sku_integral_invalid');
    const counters = [activity.stock, activity.quota, product.stock, row.stock, row.quota, base?.stock ?? 0];
    if (counters.some(value => !integralDetailInteger(value))) issues.push('sku_stock_invalid');
    const stock = issues.length ? 0 : Math.max(0, Math.min(...counters));
    return { id: row.id, unique: unique && unique.length <= 8 && !/[\u0000-\u0020\u007f]/u.test(unique) ? unique : '',
      suk: integralDetailText(suk, 512) && suk === suk.trim() ? suk : '', image: row.image, price: price ?? '0.00', otPrice: otPrice ?? '0.00', integral: integralDetailInteger(row.integral) ? row.integral : 0,
      stock, purchasable: !issues.length && stock > 0, issues: [...new Set(issues)] };
  });
}
