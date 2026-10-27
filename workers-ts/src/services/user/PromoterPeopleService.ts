import { sql } from 'drizzle-orm';
import { withTx, type Container } from '@/lib/di';
import type { Env } from '@/env';
import { AuthException } from '@/utils/errors';
import { normalizeConfigScalar } from '@/utils/config';
import { themeDeadlines } from '@/services/content/ThemeReadService';
import { renderProductPictures } from '@/services/activity/ProductAssetPolicy';
import { resolvePublicUserAvatars } from './UserAvatarPolicy';
import { readPromoterPeople } from './PromoterPeopleRead';
import type { PromoterPeopleQuery } from './PromoterPeopleInput';

/** Report, current relationship scope, config winner and persisted participant
 * avatar authority share one bounded readonly snapshot. Only signing follows it. */
export class PromoterPeopleService {
  constructor(private readonly container: Container, private readonly env: Env) {}
  async read(uid: number, query: PromoterPeopleQuery) {
    if (!Number.isSafeInteger(uid) || uid <= 0 || uid > 2147483647) throw new AuthException();
    const { report, sources } = await withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await themeDeadlines(tx);
      const report = await readPromoterPeople({ db: tx }, uid, { ...query, offset: (query.page - 1) * 20 }, true);
      const sources = await resolvePublicUserAvatars(tx, report.list.map(row => ({ uid: row.uid, image: row.avatar })));
      return { report, sources };
    });
    const previews = await renderProductPictures(this.env.APP_KEY, sources);
    const configured = report.config_value === null ? 2 : Number.parseInt(normalizeConfigScalar(report.config_value), 10) || 0;
    const level = Math.min(2147483647, Math.max(-2147483648, configured));
    return { owner_uid: uid, query, total: report.total, total_level: report.totalLevel,
      filtered_count: report.filtered_count, page_count: report.count, brokerage_level: level,
      division_mode: report.division_mode, commission: report.count ? report.price : '0.00',
      list: report.list.map((row,index) => ({ uid: row.uid, nickname: row.nickname, avatar_source: sources[index]!, avatar: previews[index]!,
        add_time: row.add_time, joined_at: row.spread_time, time: row.time, child_count: row.childCount,
        order_count: row.orderCount ?? 0, number_count: row.numberCount ?? '0.00' })) };
  }
}
