import { inArray, sql } from 'drizzle-orm';
import { createContainerFromDb, withTx, type Container } from '@/lib/di';
import type { Env } from '@/env';
import { storeOrder } from '@/models/schema';
import { AuthException } from '@/utils/errors';
import { themeDeadlines } from '@/services/content/ThemeReadService';
import { renderProductPictures } from '@/services/activity/ProductAssetPolicy';
import { resolvePublicUserAvatars } from './UserAvatarPolicy';
import { UserFinanceReadService } from './UserFinanceReadService';
import type { PromoterOrdersQuery } from './PromoterOrdersInput';

interface OrderRow { id: number; order_id: string; uid: number; nickname: string; avatar: string;
  add_time: number; time_key: string; type: 'brokerage' | 'number'; time: string; is_frozen: 0 | 1; store_name: string; number: string }
interface LegacyMonth { time: string; count: number; sumPrice: string }

/** A bounded projection of PHP's report: one readonly RR for account, orders,
 * month aggregates, payment timestamps and persisted buyer-avatar authority. */
export class PromoterOrdersService {
  constructor(private readonly container: Container, private readonly env: Env) {}
  async read(uid: number, query: PromoterOrdersQuery, now = Math.floor(Date.now() / 1000)) {
    if (!Number.isSafeInteger(uid) || uid <= 0 || uid > 2147483647) throw new AuthException();
    const result = await withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await themeDeadlines(tx);
      const legacy = await new UserFinanceReadService(createContainerFromDb(tx), { ...this.env, APP_KEY: '' }).spreadOrder(uid, { ...query }, now);
      const records = (legacy.list ?? []) as unknown as OrderRow[];
      const payments = records.length ? await tx.select({ id: storeOrder.id, paidAt: storeOrder.payTime }).from(storeOrder)
        .where(inArray(storeOrder.id, records.map(row => row.id))) : [];
      const paid = new Map(payments.map(row => [row.id, row.paidAt]));
      const sources = await resolvePublicUserAvatars(tx, records.map(row => ({ uid: row.uid, image: row.avatar })));
      return { count: legacy.count as number, sum: legacy.sum_brokerage as string,
        months: (legacy.time as LegacyMonth[]).map(month => ({ month: month.time, count: month.count, pay_price: month.sumPrice })),
        records, sources, paid };
    });
    const previews = await renderProductPictures(this.env.APP_KEY, result.sources);
    return { owner_uid: uid, query, count: result.count, sum_brokerage: result.sum,
      list: result.records.map((row, index) => ({ id: row.id, order_id: row.order_id, uid: row.uid, nickname: row.nickname,
        avatar_source: result.sources[index]!, avatar: previews[index]!, paid_at: result.paid.get(row.id)!, add_time: row.add_time,
        time_key: row.time_key, type: row.type, time: row.time, is_frozen: row.is_frozen, store_name: row.store_name, number: row.number })),
      months: result.months };
  }
}
