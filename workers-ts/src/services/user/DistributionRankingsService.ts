import { and, eq, isNull, sql } from 'drizzle-orm';
import { createContainerFromDb, withTx, type Container } from '@/lib/di';
import type { Env } from '@/env';
import { user, userBrokerage, userSpread } from '@/models/schema';
import { normalizeConfigScalar } from '@/utils/config';
import { AuthException } from '@/utils/errors';
import { themeDeadlines } from '@/services/content/ThemeReadService';
import { publicProductPictures, renderProductPictures } from '@/services/activity/ProductAssetPolicy';
import { resolvePublicUserAvatars } from './UserAvatarPolicy';
import { financeRankPeriod } from './UserFinanceReadService';
import type { DistributionRankingKind, DistributionRankingsPage } from './DistributionRankingsInput';

interface RankingRecord { uid: number; position: number; nickname: string; avatar: string; value: string }
interface RankingSnapshot { list: RankingRecord[]; self: { position: number; value: string } }

/** Read-only projections of the existing PHP referral-event and income rankings.
 * The legacy controllers retain their original fields and signing behavior. */
export class DistributionRankingsService {
  constructor(private readonly container: Container, private readonly env: Env) {}

  async read(uid: number, kind: DistributionRankingKind, paging: DistributionRankingsPage, now = Math.floor(Date.now() / 1000)) {
    if (!Number.isSafeInteger(uid) || uid <= 0 || uid > 2147483647) throw new AuthException();
    const { start, stop } = financeRankPeriod(paging.type, now), offset = (paging.page - 1) * paging.limit;
    const result = await withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await themeDeadlines(tx);
      const [account] = await tx.select({ uid: user.uid, nickname: user.nickname, avatar: user.avatar }).from(user)
        .where(and(eq(user.uid, uid), eq(user.status, 1), eq(user.isDel, 0), isNull(user.deleteTime))).limit(1);
      if (!account) throw new AuthException('请重新登录');
      // Match the existing read service: referral events, not current parents;
      // positive incoming brokerage, excluding refund/extract_fail restoration.
      // Global deterministic ranking precedes pagination. Monetary values stay SQL decimals.
      const totals = kind === 'promoter' ? sql`
        select s.spread_uid as uid, count(s.uid)::numeric as amount
        from ${userSpread} s inner join ${user} u on u.uid = s.spread_uid
          and u.status = 1 and u.is_del = 0 and u.delete_time is null
        where s.spread_time between ${start} and ${stop} group by s.spread_uid
      ` : sql`
        select b.uid, sum(b.number) as amount
        from ${userBrokerage} b inner join ${user} u on u.uid = b.uid
          and u.status = 1 and u.is_del = 0 and u.delete_time is null
        where b.pm = 1 and b.type not in ('extract_fail', 'refund') and b.add_time between ${start} and ${stop}
        group by b.uid having sum(b.number) > 0
      `;
      const decimal = kind === 'commission' ? sql`round(amount, 2)::text` : sql`trunc(amount)::text`;
      const zero = kind === 'commission' ? '0.00' : '0';
      const [row] = await tx.execute<{ data: RankingSnapshot }>(sql`
        with totals as (${totals}), ranked as (
          select uid, ${decimal} as value, row_number() over (order by amount desc, uid desc)::integer as position from totals
        ), page as (
          select r.*, u.nickname, u.avatar from ranked r inner join ${user} u on u.uid = r.uid
          order by r.position limit ${paging.limit} offset ${offset}
        ) select jsonb_build_object(
          'list', coalesce((select jsonb_agg(to_jsonb(p) order by position) from page p), '[]'::jsonb),
          'self', jsonb_build_object('position', coalesce((select position from ranked where uid = ${uid}), 0),
            'value', coalesce((select value from ranked where uid = ${uid}), ${zero}::text))
        ) as data
      `);
      const data = row?.data ?? { list: [], self: { position: 0, value: zero } };
      const records = [...data.list, { ...account, ...data.self }];
      // A fallback comes from the global SQL winner, never a caller-owned image
      // namespace or a cached value outside this repeatable snapshot.
      const defaultReference = kind === 'promoter'
        ? normalizeConfigScalar(await createContainerFromDb(tx).systemConfigDao.getValue('h5_avatar')) : '';
      const [fallback] = await publicProductPictures(tx, [{ image: defaultReference, type: 0, relationId: 0 }], 256);
      const own = await resolvePublicUserAvatars(tx, records.map(record => ({ uid: record.uid, image: record.avatar })));
      const sources = own.map((source, index) => records[index]!.avatar === '' ? fallback : source);
      return { records, sources, count: data.list.length };
    });
    // Only references already authorized against persisted UID and attachment
    // metadata receive a preview after the read transaction completes.
    const previews = await renderProductPictures(this.env.APP_KEY, result.sources);
    const projected = result.records.map((record, index) => ({ uid: record.uid, position: record.position,
      nickname: kind === 'promoter' ? record.nickname || '神秘人' : record.nickname,
      avatar_source: result.sources[index]!, avatar: previews[index]!, value: record.value }));
    return { owner_uid: uid, kind, ...paging, list: projected.slice(0, result.count), self: projected[result.count]! };
  }
}
