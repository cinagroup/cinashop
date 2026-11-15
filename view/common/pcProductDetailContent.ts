import { sanitizeArticleRichText } from './articleRichText';
import { categoryImage } from './categoryCatalog';

export interface DetailRecommendation { id: number; title: string; image: string; price: string; sales: number }
export interface ProductDetailCoupon {
  id: number; title: string; scopeType: 0 | 1 | 2 | 3; benefitType: 1 | 2;
  benefitValue: string; minimum: string;
  validity: { kind: 'relative' | 'fixed'; days: number; startTime: number | null; endTime: number | null };
  receivedCount: number; receiveLimit: number; claimable: boolean; claimReason: string; isMember: boolean;
}
export interface ProductDetailCouponPage { version: 1; uid: number; productId: number; page: number; limit: number; total: number; items: ProductDetailCoupon[] }
export interface ProductDetailCouponReceipt { version: 1; uid: number; productId: number; couponId: number; receivedCount: number; latestCouponUserId: number | null }

const invalid = (): never => { throw Error('商品优惠券资料不完整，请重新读取'); };
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
};
function integer(value: unknown, minimum = 0, maximum = 2147483647): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) return invalid();
  return value;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || [...value].length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) return invalid();
  return value;
}
function money(value: unknown): string {
  const source = text(value, 40);
  if (!/^\d+(?:\.\d{1,2})?$/.test(source) || !Number.isFinite(Number(source))) return invalid();
  return source;
}
export function normalizeProductDescription(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > 2 * 1024 * 1024) throw Error('商品正文超出可展示范围');
  return sanitizeArticleRichText(value);
}
export function normalizeDetailRecommendations(value: unknown): DetailRecommendation[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 24) throw Error('商品推荐资料无效');
  const ids = new Set<number>();
  const rows = value.map(input => {
    const row = object(input), id = integer(row.id, 1);
    if (ids.has(id)) throw Error('商品推荐出现重复记录，请重新读取');
    ids.add(id);
    const image = row.image === undefined ? '' : text(row.image, 8192);
    return { id, title: text(row.store_name ?? row.storeName ?? row.title ?? '', 256),
      image: image ? categoryImage(image) : '', price: money(row.price), sales: integer(row.sales ?? 0) };
  });
  // PHP's PC detail displays its first five recommendations. Validate the full
  // bounded server projection before choosing those visible cards.
  return rows.slice(0, 5);
}
function coupon(value: unknown): ProductDetailCoupon {
  const row = object(value), validity = object(row.validity);
  const scopeType = integer(row.scopeType, 0, 3) as ProductDetailCoupon['scopeType'];
  const benefitType = integer(row.benefitType, 1, 2) as 1 | 2;
  const benefitValue = money(row.benefitValue), minimum = money(row.minimum);
  if (benefitType === 2 && (Number(benefitValue) <= 0 || Number(benefitValue) > 100)) return invalid();
  if (!['relative', 'fixed'].includes(String(validity.kind)) || typeof row.claimable !== 'boolean' || typeof row.isMember !== 'boolean') return invalid();
  const kind = validity.kind as 'relative' | 'fixed', days = integer(validity.days, 0, 36500);
  const time = (input: unknown) => input === null ? null : integer(input, 0, 8640000000000);
  const startTime = time(validity.startTime), endTime = time(validity.endTime);
  if ((kind === 'relative' && days <= 0) || (kind === 'fixed' && days !== 0)
    || (startTime !== null && endTime !== null && startTime > endTime)) return invalid();
  return { id: integer(row.id, 1), title: text(row.title, 255), scopeType, benefitType, benefitValue, minimum,
    validity: { kind, days, startTime, endTime }, receivedCount: integer(row.receivedCount), receiveLimit: integer(row.receiveLimit),
    claimable: row.claimable, claimReason: text(row.claimReason, 255), isMember: row.isMember };
}
export function normalizeProductDetailCouponPage(value: unknown, expected: { uid: number; productId: number; page: number; limit: number }): ProductDetailCouponPage {
  const row = object(value);
  if (row.version !== 1 || row.uid !== expected.uid || row.productId !== expected.productId || row.page !== expected.page || row.limit !== expected.limit) return invalid();
  const total = integer(row.total, 0, 10000);
  if (!Array.isArray(row.items) || row.items.length > expected.limit || row.items.length !== Math.min(expected.limit, Math.max(0, total - (expected.page - 1) * expected.limit))) return invalid();
  const items = row.items.map(coupon);
  if (new Set(items.map(item => item.id)).size !== items.length) return invalid();
  return { version: 1, ...expected, total, items };
}
export function normalizeProductDetailCouponReceipt(value: unknown, expected: { uid: number; productId: number; couponId: number }): ProductDetailCouponReceipt {
  const row = object(value);
  if (row.version !== 1 || row.uid !== expected.uid || row.productId !== expected.productId || row.couponId !== expected.couponId) return invalid();
  const receivedCount = integer(row.receivedCount), latestCouponUserId = row.latestCouponUserId === null ? null : integer(row.latestCouponUserId, 1);
  // The issuance evidence may survive an owned-coupon row. It proves a prior
  // claim without inventing an owned coupon id which no longer exists.
  if (receivedCount === 0 && latestCouponUserId !== null) return invalid();
  return { version: 1, ...expected, receivedCount, latestCouponUserId };
}
export function normalizeProductDetailCouponClaim(value: unknown): number {
  return integer(object(value).couponUserId, 1);
}
export function normalizeProductDescriptionResponse(value: unknown): string {
  return normalizeProductDescription(object(value).description);
}
