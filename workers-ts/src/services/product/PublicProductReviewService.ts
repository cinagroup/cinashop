/** Versioned public review consumption. Legacy authoring and V1 DTOs stay in ReplyService. */
import { and, desc, eq, getTableColumns, gt, inArray, ne, or, sql } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { storeProduct, storeProductReply, storeProductReplyComment, systemConfig, systemSupplier, systemUserLevel, user, userRelation } from '@/models/schema';
import { StoreProductReplyDao } from '@/dao/product/ReplyDaos';
import { actorInDatabase, type BuyerReviewActor } from '@/services/order/BuyerReviewSession';
import { withOrderLifecycleSnapshot } from '@/services/order/OrderLifecycleTimeline';
import { renderProductReplyMedia } from './ProductReplyMediaPolicy';
import { publicUserAvatars } from '@/services/user/UserProfilePublicAvatar';
import { publicProductPictures, renderProductPictures } from '@/services/activity/ProductAssetPolicy';
import { canonicalizePublishedAttachmentReference } from '@/services/content/ArticleContentPolicy';
import { parseCanonicalAttachmentId } from '@/services/system/AttachmentService';
import { AuthException, NotFoundException, ValidateException } from '@/utils/errors';
import { normalizeConfigScalar } from '@/utils/config';

type Review = typeof storeProductReply.$inferSelect;
type Comment = typeof storeProductReplyComment.$inferSelect;
const invalid = () => new ValidateException('评价资料已变化，请重新读取');
const visible = (id: number) => and(eq(storeProductReply.id, id), eq(storeProductReply.status, 1), eq(storeProductReply.isDel, 0));
const reviewColumns = { ...getTableColumns(storeProductReply), pics: sql<string | null>`CASE WHEN octet_length(${storeProductReply.pics})>20000 THEN 'oversized' ELSE ${storeProductReply.pics} END` };
const same = (a: unknown, b: unknown) => { if (a === b) return true; if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false; const x = a as Record<string, unknown>, y = b as Record<string, unknown>; return Object.keys(x).length === Object.keys(y).length && Object.keys(x).every(key => Object.hasOwn(y, key) && x[key] === y[key]); };
const time = (n: number, seconds = false) => n ? new Date((n + 28800) * 1000).toISOString().replace('T', ' ').slice(0, seconds ? 19 : 16) : '';
export function publicReviewNickname(value: string): string { const chars = Array.from(value.trim()); return !chars.length ? '用户' : chars.length === 1 ? `${chars[0]}***` : `${chars[0]}***${chars.at(-1)}`; }
export function publicReviewPictures(value: string | null): string[] {
  if (value === null) return [];
  let parsed: unknown; try { parsed = JSON.parse(value || '[]'); } catch { throw new ValidateException('评价图片格式异常'); }
  if (!Array.isArray(parsed)) return [];
  if (parsed.length > 9 || parsed.some(v => typeof v !== 'string' || v.length > 2048)) throw new ValidateException('评价图片超过完整读取容量');
  return parsed as string[];
}
export function publicReviewContent(raw: unknown): string {
  if (typeof raw !== 'string') throw new ValidateException('缺少回复内容');
  const value = raw.trim();
  if (!value || Array.from(value).length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) || Array.from(value).some(char => { const cp = char.codePointAt(0)!; return cp >= 0xd800 && cp <= 0xdfff; })) throw new ValidateException('回复内容无效');
  return value;
}
export interface PublicReviewQuery { page: number; limit: number; type: number }
export interface PublicReviewUser { uid: number; nickname: string; avatar: string; level_name: string; vip_status: number }
export interface PublicReviewComment {
  id: number; reply_id: number; pid: number; uid: number; content: string; praise: number; create_time: string; update_time: string; is_praise: boolean; user: PublicReviewUser;
}
export interface PublicReviewRoot extends PublicReviewComment { children: PublicReviewComment | null }

/** These are the existing TS disjoint score buckets. replyScore is unrelated. */
function bucket(type: number) {
  const r = storeProductReply;
  return type === 1 ? and(eq(r.productScore, 5), eq(r.serviceScore, 5), eq(r.deliveryScore, 5))
    : type === 2 ? and(or(ne(r.productScore, 5), ne(r.serviceScore, 5), ne(r.deliveryScore, 5)), gt(r.productScore, 2), gt(r.serviceScore, 2), gt(r.deliveryScore, 2))
      : type === 3 ? or(sql`${r.productScore}<=2`, sql`${r.serviceScore}<=2`, sql`${r.deliveryScore}<=2`) : undefined;
}
/** Only a root or an immediate merchant response is a supported public node. */
function merchant(comment: Comment, review: Review): boolean {
  return comment.uid === 0 && ((comment.type === 0 && comment.relationId === 0)
    || (comment.type === 2 && review.type === 2 && comment.relationId === review.relationId && comment.relationId > 0));
}
async function review(db: DbClient, id: number, lock = false): Promise<Review> {
  const query = db.select(reviewColumns).from(storeProductReply).where(visible(id)).limit(1);
  const [row] = await (lock ? query.for('update', { noWait: true }) : query);
  if (!row) throw new NotFoundException('评价不存在或已下架');
  publicReviewPictures(row.pics); return row;
}
async function config(db: DbClient) {
  const keys = ['site_name', 'site_logo_square', 'member_func_status', 'member_card_status'];
  // Select one exact winner per key, rather than downloading duplicate history.
  const rows = await db.selectDistinctOn([systemConfig.menuName], { key: systemConfig.menuName, value: sql<string | null>`CASE WHEN octet_length(${systemConfig.value})<=4096 THEN ${systemConfig.value} ELSE NULL END` })
    .from(systemConfig).where(and(inArray(systemConfig.menuName, keys), eq(systemConfig.isStore, 0)))
    .orderBy(systemConfig.menuName, desc(systemConfig.sort), desc(systemConfig.id)).limit(keys.length);
  if (rows.some(row => row.value === null)) throw invalid();
  // PHP persists JSON-quoted scalar values; current TS settings also contain
  // unquoted scalars. Decode the selected winner using the shared contract.
  return Object.fromEntries(rows.map(row => [row.key, normalizeConfigScalar(row.value!)]));
}
async function members(db: DbClient, ids: number[], settings: Record<string, string>) {
  const selected = [...new Set(ids.filter(id => id > 0))];
  const rows = selected.length ? await db.select({ uid: user.uid, nickname: user.nickname, avatar: user.avatar, level: user.level, isMoneyLevel: user.isMoneyLevel, isEverLevel: user.isEverLevel, overdueTime: user.overdueTime })
    .from(user).where(and(inArray(user.uid, selected), eq(user.status, 1), eq(user.isDel, 0), sql`${user.deleteTime} IS NULL`)).limit(selected.length) : [];
  const levelIds = [...new Set(rows.map(row => row.level).filter(id => id > 0))];
  const levels = levelIds.length ? await db.select({ id: systemUserLevel.id, name: systemUserLevel.name }).from(systemUserLevel)
    .where(and(inArray(systemUserLevel.id, levelIds), eq(systemUserLevel.isShow, 1), eq(systemUserLevel.isDel, 0))).limit(levelIds.length) : [];
  const names = new Map(levels.map(row => [row.id, row.name])), now = Math.floor(Date.now() / 1000);
  return new Map(rows.map(row => [row.uid, { ...row, level_name: (settings.member_func_status ?? '1') === '1' ? names.get(row.level) ?? '' : '',
    vip_status: (settings.member_card_status ?? '1') === '1' && (row.isEverLevel === 1 || row.isMoneyLevel === 1 && row.overdueTime > now) ? 1 : 0 }]));
}
async function liked(db: DbClient, uid: number, ids: number[], category: 'reply' | 'comment') {
  if (!uid || !ids.length) return new Set<number>();
  const rows = await db.select({ id: userRelation.relationId }).from(userRelation).where(and(eq(userRelation.uid, uid), eq(userRelation.type, 'like'), eq(userRelation.category, category), inArray(userRelation.relationId, ids))).limit(ids.length);
  return new Set(rows.map(row => row.id));
}
async function rootCounts(db: DbClient, ids: number[]) {
  const rows = ids.length ? await db.select({ id: storeProductReplyComment.replyId, n: sql<number>`count(*)::integer` }).from(storeProductReplyComment)
    .where(and(inArray(storeProductReplyComment.replyId, ids), eq(storeProductReplyComment.pid, 0), eq(storeProductReplyComment.isDel, 0))).groupBy(storeProductReplyComment.replyId) : [];
  return new Map(rows.map(row => [row.id, row.n]));
}

export class PublicProductReviewService {
  constructor(private readonly container: Container, private readonly appKey?: string,
    private readonly actor?: BuyerReviewActor, private readonly authorize: (db?: DbClient) => Promise<void> = async () => {}) {}
  private get uid() { return this.actor?.uid ?? 0; }
  private async fresh(required = false) {
    if (required && !this.actor) throw new AuthException('请先登录');
    if (this.actor) { await this.authorize(); await actorInDatabase(this.container.db, this.actor); }
  }
  private async read<T>(work: (db: DbClient) => Promise<T>, required = false) {
    await this.fresh(required);
    const result = await withOrderLifecycleSnapshot(this.container, async db => {
      await db.execute(sql`SET LOCAL lock_timeout='250ms'`);
      await db.execute(sql`SET LOCAL idle_in_transaction_session_timeout='5s'`);
      if (this.actor) await actorInDatabase(db, this.actor);
      return work(db);
    });
    await this.fresh(required); return result;
  }
  private async roots(db: DbClient, reviews: Review[], roots: Comment[], settings: Record<string, string>): Promise<PublicReviewRoot[]> {
    if (!roots.length) return [];
    if (roots.some(root => !reviews.some(row => row.id === root.replyId))) throw invalid();
    // The joined parent and exact (root, review) tuples bound one valid merchant
    // child per root before transfer; poisoned cross-review children cannot win.
    const child = storeProductReplyComment, parent = storeProductReply;
    const children = await db.selectDistinctOn([child.pid], getTableColumns(child)).from(child)
      .innerJoin(parent, eq(parent.id, child.replyId)).where(and(
        or(...roots.map(root => and(eq(child.pid, root.id), eq(child.replyId, root.replyId)))),
        eq(child.isDel, 0), eq(child.uid, 0),
        or(and(eq(child.type, 0), eq(child.relationId, 0)),
          and(eq(child.type, 2), eq(parent.type, 2), gt(child.relationId, 0), eq(child.relationId, parent.relationId)))))
      .orderBy(child.pid, desc(child.praise), desc(child.addTime), desc(child.id)).limit(roots.length);
    const nodes = [...roots, ...children], identities = await members(db, nodes.map(row => row.uid), settings);
    const supplierIds = [...new Set(nodes.filter(row => row.uid === 0 && row.type === 2).map(row => row.relationId))];
    const suppliers = supplierIds.length ? await db.select({ id: systemSupplier.id, name: systemSupplier.supplierName, avatar: systemSupplier.avatar }).from(systemSupplier)
      .where(and(inArray(systemSupplier.id, supplierIds), eq(systemSupplier.isDel, 0))).limit(supplierIds.length) : [];
    const supplierMap = new Map(suppliers.map(row => [row.id, row]));
    const praised = await liked(db, this.uid, nodes.map(row => row.id), 'comment');
    const avatars = await publicUserAvatars(db, this.appKey, nodes.map(row => ({ uid: row.uid, image: row.uid > 0 ? identities.get(row.uid)?.avatar || row.avatar : '' })));
    const serialize = (row: Comment): PublicReviewComment => {
      const person = identities.get(row.uid), index = nodes.indexOf(row), supplier = supplierMap.get(row.relationId);
      const officialName = row.type === 2 ? supplier?.name ?? '商家' : row.type === 0 && row.relationId === 0 ? settings.site_name || 'CinaShop' : '商家';
      const officialAvatar = row.type === 2 ? supplier?.avatar ?? '' : row.type === 0 && row.relationId === 0 ? settings.site_logo_square || '' : '';
      // Supplier/site identities do not inherit buyer or platform attachment capabilities.
      const safeOfficialAvatar = parseCanonicalAttachmentId(canonicalizePublishedAttachmentReference(officialAvatar)) === null ? officialAvatar : '';
      return { id: row.id, reply_id: row.replyId, pid: row.pid, uid: row.uid, content: row.content, praise: Math.max(0, row.praise), create_time: time(row.addTime, true), update_time: time(row.updateTime, true), is_praise: praised.has(row.id),
        user: { uid: row.uid, nickname: row.uid > 0 ? publicReviewNickname(person?.nickname || row.nickname) : officialName, avatar: row.uid > 0 ? avatars[index] ?? '' : safeOfficialAvatar, level_name: person?.level_name ?? '', vip_status: person?.vip_status ?? 0 } };
    };
    const byParent = new Map(children.map(row => [row.pid, row]));
    return roots.map(row => ({ ...serialize(row), children: byParent.has(row.id) ? serialize(byParent.get(row.id)!) : null }));
  }
  private async cards(db: DbClient, rows: Review[]) {
    const settings = await config(db), identities = await members(db, rows.map(row => row.uid), settings), counts = await rootCounts(db, rows.map(row => row.id));
    const roots = rows.length ? await db.selectDistinctOn([storeProductReplyComment.replyId]).from(storeProductReplyComment)
      .where(and(inArray(storeProductReplyComment.replyId, rows.map(row => row.id)), eq(storeProductReplyComment.pid, 0), eq(storeProductReplyComment.isDel, 0)))
      .orderBy(storeProductReplyComment.replyId, desc(storeProductReplyComment.praise), desc(storeProductReplyComment.addTime), desc(storeProductReplyComment.id)).limit(rows.length) : [];
    const renderedRoots = await this.roots(db, rows, roots, settings), rootMap = new Map(renderedRoots.map(row => [row.reply_id, row]));
    const praised = await liked(db, this.uid, rows.map(row => row.id), 'reply');
    const media = await renderProductReplyMedia(db, rows.map(row => ({ ...row, pics: publicReviewPictures(row.pics) })), this.appKey);
    return rows.map((row, i) => ({ id: row.id, product_id: row.productId, uid: row.uid, type: row.type, relation_id: row.relationId,
      nickname: publicReviewNickname(row.nickname), avatar: media[i].avatar, comment: row.comment || '此用户没有填写评价', suk: row.sku, sku: row.sku,
      product_score: row.productScore, service_score: row.serviceScore, delivery_score: row.deliveryScore, star: Math.trunc((row.productScore + row.serviceScore + row.deliveryScore) / 3),
      pics: media[i].pics as string[], merchant_reply: row.merchantReply, merchant_reply_content: row.merchantReplyContent, merchant_reply_time: time(row.merchantReplyTime), add_time: time(row.addTime),
      praise: Math.max(0, row.praise), is_praise: praised.has(row.id), views_num: Math.max(0, row.viewsNum), level_name: identities.get(row.uid)?.level_name ?? '', vip_status: identities.get(row.uid)?.vip_status ?? 0,
      comment_sum: counts.get(row.id) ?? 0, replyComment: rootMap.has(row.id) ? { ...rootMap.get(row.id)!, sum: counts.get(row.id) ?? 0 } : null }));
  }
  async directory(productId: number, query: PublicReviewQuery) {
    return this.read(async db => {
      const stats = await new StoreProductReplyDao(db).stats(productId);
      const rows = await db.select(reviewColumns).from(storeProductReply).where(and(eq(storeProductReply.productId, productId), eq(storeProductReply.status, 1), eq(storeProductReply.isDel, 0), bucket(query.type)))
        .orderBy(desc(storeProductReply.top), desc(storeProductReply.addTime), desc(storeProductReply.id)).limit(query.limit).offset((query.page - 1) * query.limit);
      return { version: 1 as const, uid: this.uid, productId, ...query, total: [stats.total, stats.good_count, stats.in_count, stats.poor_count][query.type], stats, items: await this.cards(db, rows) };
    });
  }
  private async detail(db: DbClient, row: Review) {
    const [card] = await this.cards(db, [row]);
    const [product] = await db.select({ id: storeProduct.id, store_name: storeProduct.storeName, image: storeProduct.image, type: storeProduct.type, relationId: storeProduct.relationId, is_presale_product: storeProduct.isPresaleProduct }).from(storeProduct).where(eq(storeProduct.id, row.productId)).limit(1);
    const settings = await config(db), current = (await members(db, [row.uid], settings)).get(row.uid);
    const [avatar] = await publicUserAvatars(db, this.appKey, [{ uid: current?.uid ?? 0, image: current?.avatar ?? '' }]);
    const [productImage] = product ? await renderProductPictures(this.appKey, await publicProductPictures(db, [{ image: product.image, type: product.type === 1 ? 0 : product.type, relationId: product.type === 1 ? 0 : product.relationId }])) : [''];
    return { reply: card, product: product ? { id: product.id, store_name: product.store_name, image: productImage, is_presale_product: product.is_presale_product } : {},
      user: { uid: row.uid, nickname: current ? publicReviewNickname(current.nickname) : card.nickname, avatar: current ? avatar ?? '' : card.avatar, is_money_level: current?.isMoneyLevel ?? 0, level_name: current?.level_name ?? '', vip_status: current?.vip_status ?? 0 },
      star: String(Math.trunc((row.productScore + row.serviceScore) / 2)), is_praise: card.is_praise };
  }
  async state(replyId: number) { return this.read(async db => ({ version: 1 as const, uid: this.uid, replyId, detail: await this.detail(db, await review(db, replyId)) }), true); }
  async comments(replyId: number, page: number, limit: number) {
    return this.read(async db => {
      const parent = await review(db, replyId), counts = await rootCounts(db, [replyId]);
      const roots = await db.select().from(storeProductReplyComment).where(and(eq(storeProductReplyComment.replyId, replyId), eq(storeProductReplyComment.pid, 0), eq(storeProductReplyComment.isDel, 0)))
        .orderBy(desc(storeProductReplyComment.praise), desc(storeProductReplyComment.addTime), desc(storeProductReplyComment.id)).limit(limit).offset((page - 1) * limit);
      return { version: 1 as const, uid: this.uid, replyId, page, limit, total: counts.get(replyId) ?? 0, items: await this.roots(db, [parent], roots, await config(db)) };
    }, true);
  }
  private async write<T>(replyId: number, work: (db: DbClient, row: Review) => Promise<T>) {
    await this.fresh(true);
    return withTx(this.container, async db => {
      await db.execute(sql`SET LOCAL statement_timeout='5s'`); await db.execute(sql`SET LOCAL lock_timeout='250ms'`); await db.execute(sql`SET LOCAL idle_in_transaction_session_timeout='5s'`);
      // Review before comment locks, matching Admin and Supplier moderation.
      const row = await review(db, replyId, true);
      await actorInDatabase(db, this.actor!, true);
      const value = await work(db, row);
      // Recheck token revocation on this transaction's connection. Request-scope
      // DAOs would otherwise wait on our own reserved connection with max=1.
      await this.authorize(db); await actorInDatabase(db, this.actor!); return value;
    });
  }
  async visit(replyId: number) {
    return this.write(replyId, async (db, row) => {
      const expected = { ...row, viewsNum: Math.min(2147483647, row.viewsNum + 1) };
      const returned = await db.update(storeProductReply).set({ viewsNum: expected.viewsNum }).where(visible(replyId)).returning();
      if (returned.length !== 1 || !same(returned[0], expected) || !same(await review(db, replyId), expected)) throw invalid();
      const detail = await this.detail(db, expected);
      if (!same(await review(db, replyId), expected)) throw invalid();
      return { version: 1 as const, uid: this.uid, replyId, detail };
    });
  }
  async comment(replyId: number, raw: unknown) {
    const content = publicReviewContent(raw);
    return this.write(replyId, async (db, parent) => {
      const [account] = await db.select({ nickname: user.nickname, avatar: user.avatar }).from(user).where(eq(user.uid, this.uid)).limit(1);
      if (!account) throw invalid();
      const before = (await rootCounts(db, [replyId])).get(replyId) ?? 0;
      const expected = { type: 0, relationId: 0, replyId, pid: 0, uid: this.uid, nickname: account.nickname, avatar: account.avatar, content, praise: 0, isDel: 0, addTime: Math.floor(Date.now() / 1000), updateTime: 0 };
      const inserted = await db.insert(storeProductReplyComment).values(expected).returning();
      if (inserted.length !== 1 || inserted[0].id <= 0 || !same(inserted[0], { id: inserted[0].id, ...expected })) throw invalid();
      const [fresh] = await db.select().from(storeProductReplyComment).where(eq(storeProductReplyComment.id, inserted[0].id)).limit(1);
      const [freshAccount] = await db.select({ nickname: user.nickname, avatar: user.avatar }).from(user).where(eq(user.uid, this.uid)).limit(1);
      if (!same(freshAccount, account) || !same(fresh, inserted[0]) || !same(await review(db, replyId), parent) || ((await rootCounts(db, [replyId])).get(replyId) ?? 0) !== before + 1) throw invalid();
      return { version: 1 as const, uid: this.uid, replyId, commentId: inserted[0].id };
    });
  }
  async praise(replyId: number, commentId: number | null, praised: boolean) {
    return this.write(replyId, async (db, parent) => {
      let target: Comment | undefined, rootSnapshot: Comment | undefined;
      if (commentId !== null) {
        const [row] = await db.select().from(storeProductReplyComment).where(and(eq(storeProductReplyComment.id, commentId), eq(storeProductReplyComment.replyId, replyId), eq(storeProductReplyComment.isDel, 0))).limit(1).for('update', { noWait: true });
        if (!row) throw new NotFoundException('回复不存在');
        if (row.pid !== 0) {
          const [root] = await db.select().from(storeProductReplyComment).where(and(eq(storeProductReplyComment.id, row.pid), eq(storeProductReplyComment.replyId, replyId), eq(storeProductReplyComment.pid, 0), eq(storeProductReplyComment.isDel, 0))).limit(1);
          if (!root || !merchant(row, parent)) throw new NotFoundException('回复不存在');
          rootSnapshot = root;
        }
        target = row;
      }
      const id = commentId ?? replyId, category = commentId === null ? 'reply' : 'comment';
      const where = and(eq(userRelation.uid, this.uid), eq(userRelation.relationId, id), eq(userRelation.type, 'like'), eq(userRelation.category, category));
      const countWhere = and(eq(userRelation.relationId, id), eq(userRelation.type, 'like'), eq(userRelation.category, category));
      const count = async () => (await db.select({ n: sql<number>`count(*)::integer` }).from(userRelation).where(countWhere))[0]?.n ?? 0;
      const previousCount = await count();
      const [existing] = await db.select().from(userRelation).where(where).limit(1);
      let receipt = existing;
      if (praised && !existing) {
        const expected = { uid: this.uid, relationId: id, type: 'like', category, addTime: Math.floor(Date.now() / 1000) };
        const inserted = await db.insert(userRelation).values(expected).returning();
        if (inserted.length !== 1 || !same(inserted[0], { id: inserted[0].id, ...expected })) throw invalid(); receipt = inserted[0];
      } else if (!praised && existing) {
        const removed = await db.delete(userRelation).where(where).returning();
        if (removed.length !== 1 || !same(removed[0], existing)) throw invalid();
      }
      const praise = await count();
      if (praise !== previousCount + (praised && !existing ? 1 : !praised && existing ? -1 : 0)) throw invalid();
      const expected = { ...(target ?? parent), praise };
      const updated = target ? await db.update(storeProductReplyComment).set({ praise }).where(eq(storeProductReplyComment.id, target.id)).returning()
        : await db.update(storeProductReply).set({ praise }).where(visible(replyId)).returning();
      if (updated.length !== 1 || !same(updated[0], expected)) throw invalid();
      const [after] = await db.select().from(userRelation).where(where).limit(2);
      const fresh = target ? (await db.select().from(storeProductReplyComment).where(eq(storeProductReplyComment.id, target.id)).limit(1))[0] : await review(db, replyId);
      if (rootSnapshot && !same((await db.select().from(storeProductReplyComment).where(eq(storeProductReplyComment.id, rootSnapshot.id)).limit(1))[0], rootSnapshot)) throw invalid();
      if (!same(fresh, expected) || praised !== !!after || praised && !same(after, receipt) || await count() !== praise || target && !same(await review(db, replyId), parent)) throw invalid();
      return { version: 1 as const, uid: this.uid, replyId, commentId, praise, isPraise: praised };
    });
  }
}
