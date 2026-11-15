import { publicReviewId } from './publicProductReviews';
export const publicReviewListPath = '/pages/goods/commentList';
export const publicReviewDetailPath = '/pages/goods/commentDetail';
export const legacyPublicReviewListPath = '/pages/goods/goods_comment_list/index';
export const legacyPublicReviewDetailPath = '/pages/goods/goods_comment_con/comment_con';
const invalid = (): never => { throw Error('评价链接无效，请重新进入商品'); };
export function publicReviewParameters(input: Readonly<Record<string, unknown>>, detail = false): number {
  const aliases = detail ? ['id'] : ['productId', 'product_id', 'id'], keys = Object.keys(input);
  // Exactly one identity: equal aliases are still ambiguous and are rejected.
  if (keys.length !== 1 || !aliases.includes(keys[0]) || typeof input[keys[0]] !== 'string') return invalid();
  return publicReviewId(input[keys[0]]);
}
export function publicReviewQuery(raw: string, detail = false): number {
  if (raw.length > 2048 || /%(?![0-9a-f]{2})/iu.test(raw)) return invalid();
  const result: Record<string, string> = Object.create(null), decode = (v: string) => decodeURIComponent(v.replace(/\+/g, ' '));
  for (const part of (raw.startsWith('?') ? raw.slice(1) : raw).split('&')) {
    if (!part) continue; const offset = part.indexOf('='), key = decode(offset < 0 ? part : part.slice(0, offset)), value = decode(offset < 0 ? '' : part.slice(offset + 1));
    if (Object.prototype.hasOwnProperty.call(result, key)) return invalid(); result[key] = value;
  }
  return publicReviewParameters(result, detail);
}
export function publicReviewPageRoute(input: Readonly<Record<string, unknown>>, detail = false): string {
  const id = publicReviewParameters(input, detail); return (detail ? publicReviewDetailPath + '?id=' : publicReviewListPath + '?productId=') + id;
}
