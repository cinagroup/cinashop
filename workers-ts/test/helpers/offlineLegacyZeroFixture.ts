import { createHash, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { DbClient } from '../../src/lib/di';
import { otherOrder, otherOrderStatus, user } from '../../src/models/schema';
import { offlineOrderAdmission } from '../../src/models/candidates/offline_order_admission';

/** Pre-policy history, not a current admission API. Only an owned PG16 fixture
 * maintenance connection may seed this; all current DB guards remain enabled. */
export async function seedHistoricalZeroOfflineOrder(db: DbClient, channel = 'h5') {
  if (!['h5', 'wechat', 'weixinh5', 'routine'].includes(channel)) throw Error('Invalid fixture channel');
  return db.transaction(async tx => {
    const [identity] = await tx.execute<{ database: string; role: string; session: string; version: string }>(sql`
      SELECT current_database() AS database,current_user AS role,session_user AS session,
        current_setting('server_version_num') AS version`);
    if (!/^cinashop_kefu_runner_[a-f0-9]{32}$/.test(identity.database)
      || identity.role !== 'finance_test' || identity.session !== 'finance_test'
      || Math.floor(Number(identity.version) / 10_000) !== 16) throw Error('Owned PG16 maintenance fixture required');
    const [account] = await tx.select({ uid: user.uid }).from(user).where(eq(user.uid, 11)).for('update');
    if (!account) throw Error('Missing fixture account');
    await tx.execute(sql`SELECT public.ooa_lock_pricing()`);
    const [clock] = await tx.execute<{ now: number }>(sql`SELECT floor(extract(epoch FROM statement_timestamp()))::integer AS now`);
    const orderNo = 'xx' + randomUUID().replaceAll('-', '').slice(0, 30), requestKey = randomUUID();
    const requestHash = createHash('sha256').update(JSON.stringify(['offline-admission-v1', 11, '0.01', '0.00', channel])).digest('hex');
    const [order] = await tx.insert(otherOrder).values({ uid: 11, type: 3, orderId: orderNo,
      money: '0.01', memberPrice: '0.00', payPrice: '0.00', channelType: channel, addTime: clock.now }).returning({ id: otherOrder.id });
    await tx.insert(offlineOrderAdmission).values({ uid: 11, requestKey, requestHash, orderId: order.id, orderNo,
      rawPrice: '0.01', payPrice: '0.00', memberActive: true, discountPercent: 80, channel, createdAt: clock.now });
    await tx.insert(otherOrderStatus).values({ oid: order.id, changeType: 'create_offline_scan_order',
      changeMessage: '线下收银订单生成', shopType: 3, changeTime: clock.now });
    return { id: order.id, order_id: orderNo, requestKey };
  });
}
