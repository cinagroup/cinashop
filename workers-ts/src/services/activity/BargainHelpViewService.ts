import { resolvePublicUserAvatars,renderPublicUserAvatars } from '@/services/user/UserProfilePublicAvatar';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { createContainerFromDb, withTx, type Container, type DbClient } from '@/lib/di';
import { storeBargain, storeBargainUser, storeBargainUserHelp, storeProduct, user } from '@/models/schema';
import { AuthException, NotFoundException, ValidateException } from '@/utils/errors';
import { centsToDecimal } from '@/services/order/OrderBrokerageService';
import { findBargainParticipation } from './BargainParticipationSelection';

function id(raw: unknown): number {
  if (typeof raw !== 'string' || !/^[1-9]\d{0,9}$/.test(raw) || Number(raw) > 2147483647)
    throw new ValidateException('砍价邀请标识无效');
  return Number(raw);
}
function integer(value: number, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > 2147483647) throw new ValidateException('砍价帮助配置无效');
  return value;
}
function cents(value: string): number {
  if (!/^\d{1,10}\.\d{2}$/.test(value)) throw new ValidateException('砍价记录金额异常');
  const [whole, fraction] = value.split('.'); return Number(whole) * 100 + Number(fraction);
}
function image(value: string): string {
  if (!value || value.length > 2048 || /[\u0000-\u0020\u007f\\]/u.test(value)) return '';
  if (/^\/(?!\/)/u.test(value)) return value;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? value : ''; }
  catch { return ''; }
}
function text(value: string, maximum: number): string { return value.replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, maximum); }

/** Exact invitation target shared by the read-only helper view and signed QR
 * descriptor. Never returns cart, order, contact or purchase-selection data. */
export async function readBargainInvitationTarget(db: DbClient, activityId: number, participantId: number) {
  integer(activityId, 1); integer(participantId, 1);
  const [row] = await db.select({
    participantId: storeBargainUser.id, ownerUid: storeBargainUser.uid, status: storeBargainUser.status,
    original: storeBargainUser.bargainPrice, minimum: storeBargainUser.bargainPriceMin, cut: storeBargainUser.price,
    nickname: user.nickname, avatar: user.avatar, productId: storeBargain.productId,
    title: storeBargain.title, storeName: storeBargain.storeName, image: storeBargain.image, productImage: storeProduct.image,
    people: storeBargain.people, friendLimit: storeBargain.bargainNum, stock: storeBargain.stock, quota: storeBargain.quota,
    productStock: storeProduct.stock, vipOnly: storeProduct.isVipProduct,
    startTime: storeBargain.startTime, stopTime: storeBargain.stopTime,
  }).from(storeBargainUser)
    .innerJoin(storeBargain, eq(storeBargain.id, storeBargainUser.bargainId))
    .innerJoin(storeProduct, and(eq(storeProduct.id, storeBargain.productId),
      eq(storeProduct.type, storeBargain.type), eq(storeProduct.relationId, storeBargain.relationId),
      eq(storeProduct.productType, storeBargain.productType)))
    .innerJoin(user, eq(user.uid, storeBargainUser.uid))
    .where(and(eq(storeBargainUser.id, participantId), eq(storeBargainUser.bargainId, activityId),
      eq(storeBargainUser.isDel, 0), eq(storeBargain.status, 1), eq(storeBargain.isDel, 0),
      eq(storeProduct.isShow, 1), eq(storeProduct.isVerify, 1), eq(storeProduct.isDel, 0),
      eq(user.status, 1), eq(user.isDel, 0), isNull(user.deleteTime))).limit(1);
  if (!row) throw new NotFoundException('砍价邀请不存在或已不可用');
  if (![1, 2, 3, 4].includes(row.status)) throw new ValidateException('砍价记录状态无效');
  const original = cents(row.original), minimum = cents(row.minimum), cut = cents(row.cut);
  const remaining = original - minimum - cut;
  if (minimum > original || remaining < 0 || row.status === 3 && remaining !== 0)
    throw new ValidateException('砍价记录金额异常');
  if ([row.startTime, row.stopTime].some(value => value !== null && !Number.isFinite(value.getTime()))
    || row.startTime && row.stopTime && row.startTime > row.stopTime) throw new ValidateException('砍价日期配置无效');
  integer(row.people, 1); integer(row.friendLimit); integer(row.stock); integer(row.quota); integer(row.productStock);
  const state = row.status === 4 ? 'used' as const : row.status === 2 ? 'closed' as const
    : remaining === 0 ? 'ready' as const : 'cutting' as const;
  return { ...row, progress: { id: participantId, status: row.status, state,
    original_price: row.original, minimum_price: row.minimum, cut_price: row.cut,
    current_price: centsToDecimal(original - cut), remaining_cut: centsToDecimal(remaining),
    progress_percent: original === minimum ? 100 : Math.floor(cut * 100 / (original - minimum)) } };
}

/** Authenticated invitation presentation; it grants no purchase authority.
 * Legacy owner links resolve once to a sole record, never a latest-row guess. */
export class BargainHelpViewService {
  constructor(private readonly container: Container, private readonly appKey?: string) {}
  async read(uid: number, rawActivity: unknown, rawParticipant?: unknown, rawOwner?: unknown, now = new Date()) {
    const activityId = id(rawActivity);
    if ((rawParticipant === undefined) === (rawOwner === undefined)) throw new ValidateException('请指定一条砍价邀请');
    const participantId = rawParticipant === undefined ? 0 : id(rawParticipant);
    const ownerUid = rawOwner === undefined ? 0 : id(rawOwner);
    if (!Number.isSafeInteger(uid) || uid <= 0 || uid > 2147483647) throw new AuthException('请登录后帮助好友砍价');
    if (!Number.isFinite(now.getTime())) throw new ValidateException('砍价查询时间无效');
    const result=await withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await tx.execute(sql.raw(`SELECT
        pg_catalog.set_config('statement_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
        pg_catalog.set_config('idle_in_transaction_session_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true)`));
      const current = await createContainerFromDb(tx).userDao.findForAuth(uid);
      if (!current || current.status !== 1) throw new AuthException('请重新登录');
      let exactId = participantId;
      if (!exactId) {
        const active = await findBargainParticipation(tx, ownerUid, activityId);
        if (active) exactId = active.id;
        else {
          const historical = await tx.select({ id: storeBargainUser.id }).from(storeBargainUser)
            .where(and(eq(storeBargainUser.uid, ownerUid), eq(storeBargainUser.bargainId, activityId), eq(storeBargainUser.isDel, 0)))
            .orderBy(desc(storeBargainUser.id)).limit(2);
          if (historical.length !== 1) throw new ValidateException('砍价记录不存在或不唯一，请索取新的邀请链接');
          exactId = historical[0].id;
        }
      }
      const target = await readBargainInvitationTarget(tx, activityId, exactId);
      if (target.vipOnly && !current.isMoneyLevel) throw new NotFoundException('砍价邀请不存在或已不可用');
      const [help] = await tx.select({
        count: sql<number>`COUNT(*)::int`,
        alreadyHelped: sql<boolean>`COALESCE(bool_or(${storeBargainUserHelp.uid}=${uid}),false)`,
        friendUses: sql<number>`(SELECT COUNT(*)::int FROM ${storeBargainUserHelp} h
          WHERE h.uid=${uid} AND h.bargain_id=${activityId} AND h.type=0)`,
      }).from(storeBargainUserHelp).where(eq(storeBargainUserHelp.bargainUserId, exactId));
      integer(help.count); integer(help.friendUses);
      const remainingUses = Math.max(0, target.friendLimit - help.friendUses);
      const dateWindow = target.startTime && target.startTime > now ? 'future' as const
        : target.stopTime && target.stopTime < now ? 'ended' as const : 'active' as const;
      const isOwner = uid === target.ownerUid, inStock = Math.min(target.stock, target.quota, target.productStock) > 0;
      const state = target.progress.state;
      const helpState = dateWindow !== 'active' ? dateWindow : state !== 'cutting' ? state
        : isOwner ? 'owner' : !inStock ? 'sold_out' : help.alreadyHelped ? 'already_helped'
        : remainingUses === 0 ? 'limit_reached' : help.count >= target.people ? 'people_full' : 'available';
      return { help_only: true as const, type: 2 as const, bargain_id: activityId, participant_id: exactId,
        product_id: target.productId, title: text(target.title || target.storeName, 255),
        image: image(target.image) || image(target.productImage),
        owner: { nickname: text(target.nickname, 128), avatar: (await resolvePublicUserAvatars(tx,[{uid:target.ownerUid,image:image(target.avatar)}]))[0] }, is_owner: isOwner,
        start_time: target.startTime?.toISOString() ?? null, stop_time: target.stopTime?.toISOString() ?? null,
        date_window: dateWindow, participation: target.progress, people: target.people,
        help_count: help.count, already_helped: help.alreadyHelped, remaining_helper_uses: remainingUses,
        in_stock: inStock, can_help: helpState === 'available', help_state: helpState };
    });
    [result.owner.avatar]=await renderPublicUserAvatars(this.appKey,[result.owner.avatar]);
    return result;
  }
}
