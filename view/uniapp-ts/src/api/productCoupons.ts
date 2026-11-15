import { createUserCenterRequests } from '@/api/userCenter';
import { API_BASE } from '@/utils/request';
import { normalizeProductDetailCouponPage, normalizeProductDetailCouponReceipt, normalizeProductDetailCouponClaim,
  type ProductDetailCoupon, type ProductDetailCouponPage } from '../../../common/pcProductDetailContent';
import { articleRichTextNodes, sanitizeArticleRichText, type ArticleRichTextNode } from '../../../common/articleRichText';

export interface ProductCoupon extends ProductDetailCoupon { rule: string; ruleNodes: ArticleRichTextNode[] }
export interface ProductCouponPage extends Omit<ProductDetailCouponPage, 'items'> { view: 'uni_product_coupons'; items: ProductCoupon[] }
function couponRuleNodes(rule: string): ArticleRichTextNode[] {
  const result = articleRichTextNodes(rule), pending = [...result];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.type !== 'node') continue;
    const source = node.attrs.src;
    if (node.name === 'img' && API_BASE && source && /^\/api\/assets\/[1-9]\d*(?:\?|#|$)/u.test(source)) {
      node.attrs.src = API_BASE + source;
    }
    for (const child of node.children) pending.push(child);
  }
  return result;
}
function responseBytes(value: unknown) {
  let bytes = 0;
  // Mini-program/App JS engines need not expose the browser TextEncoder API.
  for (const character of JSON.stringify(value)) {
    const code = character.codePointAt(0)!; bytes += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4;
  }
  return bytes;
}
export function decodeProductCoupons(value: unknown, expected: { uid: number; productId: number; page: number; limit: number }): ProductCouponPage {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (value as Record<string, unknown>).view !== 'uni_product_coupons'
    || responseBytes(value) > 1024 * 1024) throw Error('商品优惠券完整资料暂不可读取，请重新读取');
  const page = normalizeProductDetailCouponPage(value, expected), raw = (value as { items: unknown[] }).items;
  const items = page.items.map((item, index) => {
    const rule = (raw[index] as Record<string, unknown>).rule;
    if (typeof rule !== 'string' || rule.length > 64_000) throw Error('商品优惠券完整规则暂不可读取，请重新读取');
    if ([item.validity.startTime, item.validity.endTime].some(value => value !== null && !Number.isFinite(new Date((value + 8 * 3600) * 1000).getTime())))
      throw Error('商品优惠券完整有效期暂不可读取，请重新读取');
    return { ...item, rule: sanitizeArticleRichText(rule), ruleNodes: couponRuleNodes(rule) };
  });
  return { ...page, view: 'uni_product_coupons', items };
}
export function createProductCouponRequests(current: () => boolean) {
  const r = createUserCenterRequests(current);
  return { ...r,
    list: async (productId: number, page: number) => decodeProductCoupons(await r.request(`product/detail/${productId}/coupons`, 'GET', { view: 'uni_product_coupons', page, limit: 10 }),
      { uid: r.owner.token ? r.owner.uid : 0, productId, page, limit: 10 }),
    receipt: async (productId: number, couponId: number) => normalizeProductDetailCouponReceipt(await r.request(`product/detail/${productId}/coupons/${couponId}/receipt`, 'GET', {}, true),
      { uid: r.owner.uid, productId, couponId }),
    claim: async (couponId: number) => normalizeProductDetailCouponClaim(await r.request('coupon/receive', 'POST', { id: couponId }, true)),
  };
}
export type ProductCouponRequests = ReturnType<typeof createProductCouponRequests>;
