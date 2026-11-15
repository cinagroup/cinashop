import { buyerReviewImageSource } from './buyerReview';

export type ReviewFilter = 0 | 1 | 2 | 3;
export const reviewFilters = [{ value: 0, label: '全部' }, { value: 1, label: '好评' }, { value: 2, label: '中评' }, { value: 3, label: '差评' }] as const;
export interface PublicReviewStats {
  sum_count: number; good_count: number; in_count: number; poor_count: number;
  reply_chance: number; reply_star: number; total: number; avgScore: string; goodRate: number; picsCount: number;
}
export interface PublicReviewUser { uid: number; nickname: string; avatar: string; level_name: string; vip_status: number }
export interface PublicReviewComment {
  id: number; reply_id: number; pid: number; uid: number; content: string; praise: number;
  create_time: string; update_time: string; is_praise: boolean; user: PublicReviewUser;
  children: Omit<PublicReviewComment, 'children'> | null;
}
export interface PublicReviewCard {
  id: number; product_id: number; uid: number; type: number; relation_id: number;
  nickname: string; avatar: string; comment: string; sku: string; suk: string;
  product_score: number; service_score: number; delivery_score: number; star: number; pics: string[];
  merchant_reply: string; merchant_reply_content: string; merchant_reply_time: string; add_time: string;
  praise: number; is_praise: boolean; views_num: number; level_name: string; vip_status: number;
  comment_sum: number; replyComment: (PublicReviewComment & { sum: number }) | null;
}
export interface PublicReviewPage {
  version: 1; uid: number; productId: number; type: ReviewFilter; page: number; limit: number;
  total: number; stats: PublicReviewStats; items: PublicReviewCard[];
}
export interface PublicReviewDetail {
  reply: Pick<PublicReviewCard, 'id' | 'product_id' | 'uid' | 'nickname' | 'avatar' | 'comment' | 'sku' | 'suk' | 'product_score' | 'service_score' | 'delivery_score' | 'pics' | 'praise' | 'views_num' | 'add_time' | 'comment_sum' | 'merchant_reply_content' | 'merchant_reply_time'>;
  product: { id?: number; store_name?: string; image?: string; is_presale_product?: number };
  user: { uid?: number; nickname: string; avatar?: string; level_name: string; vip_status: number };
  star: string; is_praise: boolean;
}
export interface PublicReviewDetailPage { version: 1; uid: number; replyId: number; detail: PublicReviewDetail }
export interface PublicReviewCommentsPage {
  version: 1; uid: number; replyId: number; page: number; limit: number; total: number; items: PublicReviewComment[];
}
export interface PublicReviewCommentAck { version: 1; uid: number; replyId: number; commentId: number }
export interface PublicReviewPraiseAck { version: 1; uid: number; replyId: number; commentId: number | null; praise: number; isPraise: boolean }
const invalid = (): never => { throw Error('评价资料与当前页面或账号不一致，请重新读取'); };
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid(); }
function integer(value: unknown, min = 0, max = 2147483647): number { return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : invalid(); }
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) return invalid();
  for (const c of value) if (c.length === 1 && c.charCodeAt(0) >= 0xd800 && c.charCodeAt(0) <= 0xdfff) return invalid();
  return value;
}
function bool(value: unknown): boolean { return typeof value === 'boolean' ? value : invalid(); }
function time(value: unknown): string { const s = text(value, 32); return s === '' || /^\d{4}-\d\d-\d\d \d\d:\d\d(?::\d\d)?$/.test(s) ? s : invalid(); }
function pictures(value: unknown): string[] { return Array.isArray(value) && value.length <= 9 ? value.map(buyerReviewImageSource) : invalid(); }
export function publicReviewId(value: unknown): number {
  if (typeof value === 'number') return integer(value, 1);
  if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value)) return invalid();
  return integer(Number(value), 1);
}
export function publicReviewFilter(value: unknown): ReviewFilter { return integer(value, 0, 3) as ReviewFilter; }
function user(value: unknown, uid: number): PublicReviewUser {
  const r = object(value); if (integer(r.uid) !== uid) return invalid();
  return { uid, nickname: text(r.nickname, 256), avatar: buyerReviewImageSource(r.avatar), level_name: text(r.level_name, 256), vip_status: integer(r.vip_status, 0, 1) };
}
function commentNode(value: unknown, replyId: number, pid: number): Omit<PublicReviewComment, 'children'> {
  const r = object(value), uid = integer(r.uid);
  if (integer(r.reply_id, 1) !== replyId || integer(r.pid) !== pid) return invalid();
  return { id: integer(r.id, 1), reply_id: replyId, pid, uid, content: text(r.content, 4000), praise: integer(r.praise),
    create_time: time(r.create_time), update_time: time(r.update_time), is_praise: bool(r.is_praise), user: user(r.user, uid) };
}
function comment(value: unknown, replyId: number): PublicReviewComment {
  const r = object(value), root = commentNode(r, replyId, 0);
  const child = r.children == null ? null : commentNode(r.children, replyId, root.id);
  if (child && (child.id === root.id || child.uid !== 0)) return invalid();
  return { ...root, children: child };
}
function uniqueIds(rows: readonly { id: number }[]): void { if (new Set(rows.map(r => r.id)).size !== rows.length) invalid(); }
function stats(value: unknown): PublicReviewStats {
  const r = object(value), result = { sum_count: integer(r.sum_count), good_count: integer(r.good_count), in_count: integer(r.in_count), poor_count: integer(r.poor_count),
    reply_chance: integer(r.reply_chance, 0, 100), reply_star: integer(r.reply_star, 0, 5), total: integer(r.total), avgScore: text(r.avgScore, 8), goodRate: integer(r.goodRate, 0, 100), picsCount: integer(r.picsCount) };
  if (result.sum_count !== result.total || result.good_count + result.in_count + result.poor_count !== result.total || result.picsCount > result.total
    || result.goodRate !== result.reply_chance || !/^[0-5]\.\d$/.test(result.avgScore) || Number(result.avgScore) > 5) return invalid();
  return result;
}
function card(value: unknown, productId: number): PublicReviewCard {
  const r = object(value), id = integer(r.id, 1);
  if (integer(r.product_id, 1) !== productId) return invalid();
  const summary = r.replyComment === null ? null : { ...comment(r.replyComment, id), sum: integer(object(r.replyComment).sum) };
  const result: PublicReviewCard = { id, product_id: productId, uid: integer(r.uid), type: integer(r.type, 0, 2), relation_id: integer(r.relation_id),
    nickname: text(r.nickname, 256), avatar: buyerReviewImageSource(r.avatar), comment: text(r.comment, 4096), sku: text(r.sku, 1024), suk: text(r.suk, 1024),
    product_score: integer(r.product_score, 1, 5), service_score: integer(r.service_score, 1, 5), delivery_score: integer(r.delivery_score, 1, 5), star: integer(r.star, 1, 5), pics: pictures(r.pics),
    merchant_reply: text(r.merchant_reply, 2000), merchant_reply_content: text(r.merchant_reply_content, 2000), merchant_reply_time: time(r.merchant_reply_time), add_time: time(r.add_time),
    praise: integer(r.praise), is_praise: bool(r.is_praise), views_num: integer(r.views_num), level_name: text(r.level_name, 256), vip_status: integer(r.vip_status, 0, 1),
    comment_sum: integer(r.comment_sum), replyComment: summary };
  if (result.star !== Math.trunc((result.product_score + result.service_score + result.delivery_score) / 3)
    || summary && summary.sum !== result.comment_sum || (summary === null) !== (result.comment_sum === 0)) return invalid();
  return result;
}
function envelope(raw: unknown, uid: number): Record<string, unknown> { const r = object(raw); if (r.version !== 1 || integer(r.uid) !== integer(uid)) return invalid(); return r; }
function pageIdentity(r: Record<string, unknown>, page: number, limit: number): void {
  if (integer(r.page, 1, 1000000) !== page || integer(r.limit, 1, 50) !== limit || (page - 1) * limit > 2147483647) invalid();
}
export function parsePublicReviewPage(raw: unknown, productId: number, type: ReviewFilter, page: number, limit: number, uid: number): PublicReviewPage {
  const r = envelope(raw, uid); pageIdentity(r, page, limit);
  if (integer(r.productId, 1) !== productId || publicReviewFilter(r.type) !== type || !Array.isArray(r.items) || r.items.length > limit) return invalid();
  const totals = stats(r.stats), count = [totals.total, totals.good_count, totals.in_count, totals.poor_count][type], items = r.items.map(v => card(v, productId)); uniqueIds(items);
  if (integer(r.total) !== count || items.length !== Math.min(limit, Math.max(0, count - (page - 1) * limit))) return invalid();
  for (const item of items) { const scores = [item.product_score, item.service_score, item.delivery_score], bucket = scores.every(n => n === 5) ? 1 : scores.some(n => n <= 2) ? 3 : 2; if (type && type !== bucket) return invalid(); }
  return { version: 1, uid, productId, type, page, limit, total: count, stats: totals, items };
}
export function parsePublicReviewDetail(raw: unknown, replyId: number, uid: number): PublicReviewDetailPage {
  const r = envelope(raw, uid), d = object(r.detail), v = object(d.reply), p = object(d.product), u = object(d.user);
  if (uid < 1 || integer(r.replyId, 1) !== replyId || integer(v.id, 1) !== replyId) return invalid();
  const productId = integer(v.product_id, 1), authorId = integer(v.uid), product: PublicReviewDetail['product'] = {};
  if (Object.keys(p).length) { if (integer(p.id, 1) !== productId) return invalid(); product.id = productId; product.store_name = text(p.store_name, 1024); product.image = buyerReviewImageSource(p.image); product.is_presale_product = integer(p.is_presale_product, 0, 1); }
  const author: PublicReviewDetail['user'] = { nickname: text(u.nickname, 256), level_name: text(u.level_name, 256), vip_status: integer(u.vip_status, 0, 1) };
  if (u.uid !== undefined) { if (integer(u.uid) !== authorId) return invalid(); author.uid = authorId; }
  if (u.avatar !== undefined) author.avatar = buyerReviewImageSource(u.avatar);
  const reply: PublicReviewDetail['reply'] = { id: replyId, product_id: productId, uid: authorId, nickname: text(v.nickname, 256), avatar: buyerReviewImageSource(v.avatar), comment: text(v.comment, 4096), sku: text(v.sku, 1024), suk: text(v.suk, 1024),
    product_score: integer(v.product_score, 1, 5), service_score: integer(v.service_score, 1, 5), delivery_score: integer(v.delivery_score, 1, 5), pics: pictures(v.pics), praise: integer(v.praise), views_num: integer(v.views_num), add_time: time(v.add_time), comment_sum: integer(v.comment_sum),
    merchant_reply_content: text(v.merchant_reply_content, 2000), merchant_reply_time: time(v.merchant_reply_time) };
  const star = text(d.star, 1); if (star !== String(Math.trunc((reply.product_score + reply.service_score) / 2))) return invalid();
  return { version: 1, uid, replyId, detail: { reply, product, user: author, star, is_praise: bool(d.is_praise) } };
}
export function parsePublicReviewComments(raw: unknown, replyId: number, page: number, limit: number, uid: number): PublicReviewCommentsPage {
  const r = envelope(raw, uid); pageIdentity(r, page, limit);
  if (uid < 1 || integer(r.replyId, 1) !== replyId || !Array.isArray(r.items) || r.items.length > limit) return invalid();
  const total = integer(r.total), items = r.items.map(v => comment(v, replyId)); uniqueIds(items);
  uniqueIds(items.flatMap(item => item.children ? [item, item.children] : [item]));
  if (items.length !== Math.min(limit, Math.max(0, total - (page - 1) * limit))) return invalid();
  return { version: 1, uid, replyId, page, limit, total, items };
}
export function publicReviewCommentContent(value: unknown): string { const s = text(value, 4000).trim(); return s && [...s].length <= 1000 ? s : invalid(); }
export function parsePublicReviewCommentAck(raw: unknown, replyId: number, uid: number): PublicReviewCommentAck {
  const r = envelope(raw, uid); if (uid < 1 || integer(r.replyId, 1) !== replyId) return invalid();
  return { version: 1, uid, replyId, commentId: integer(r.commentId, 1) };
}
export function parsePublicReviewPraiseAck(raw: unknown, replyId: number, commentId: number | null, praised: boolean, uid: number): PublicReviewPraiseAck {
  const r = envelope(raw, uid); if (uid < 1 || integer(r.replyId, 1) !== replyId || r.commentId !== commentId || bool(r.isPraise) !== praised) return invalid();
  return { version: 1, uid, replyId, commentId, praise: integer(r.praise), isPraise: praised };
}
