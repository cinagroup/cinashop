import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { withTx, type Container } from '@/lib/di';
import { otherOrder, user } from '@/models/schema';
import { offlineOrderAdmission } from '@/models/candidates/offline_order_admission';
import { AuthException, ValidateException } from '@/utils/errors';
import { assertOfflineAdmission } from './OfflineOrderPaymentContext';

/** Discovery of admitted consumption, not a payment-status endpoint. The
 * existing (uid, created_at, order_id) index supports backwards keyset scans.
 * The public cursor is an owned order number, not an authorization credential.
 */
export async function listOfflineOrders(container: Container, uid: number, input: { cursor?: string; order_id?: string }) {
  if (!Number.isSafeInteger(uid) || uid <= 0 || Object.keys(input).some(k => !['cursor', 'order_id'].includes(k))
    || (input.cursor !== undefined && !/^xx[0-9a-f]{30}$/.test(input.cursor))
    || (input.order_id !== undefined && !/^xx[0-9a-f]{30}$/.test(input.order_id))
    || (input.cursor !== undefined && input.order_id !== undefined)) throw new ValidateException('消费记录查询参数无效');
  return withTx(container, async tx => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    await tx.execute(sql`SELECT set_config('statement_timeout',
      LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true)`);
    const [account] = await tx.select({ uid: user.uid }).from(user)
      .where(and(eq(user.uid, uid), eq(user.status, 1), eq(user.isDel, 0), isNull(user.deleteTime)));
    if (!account) throw new AuthException('用户状态不可用，请重新登录');
    const [boundary] = input.cursor ? await tx.select({ createdAt: offlineOrderAdmission.createdAt, id: offlineOrderAdmission.orderId })
      .from(offlineOrderAdmission).where(and(eq(offlineOrderAdmission.uid, uid), eq(offlineOrderAdmission.orderNo, input.cursor))) : [];
    if (input.cursor && !boundary) throw new ValidateException('消费记录分页已失效，请重新查询');
    const rows = await tx.select({ admission: offlineOrderAdmission, order: otherOrder }).from(offlineOrderAdmission)
      .innerJoin(otherOrder, eq(otherOrder.id, offlineOrderAdmission.orderId))
      .where(and(eq(offlineOrderAdmission.uid, uid),
        input.order_id ? eq(offlineOrderAdmission.orderNo, input.order_id) : undefined,
        boundary ? sql`(${offlineOrderAdmission.createdAt},${offlineOrderAdmission.orderId}) < (${boundary.createdAt},${boundary.id})` : undefined))
      .orderBy(desc(offlineOrderAdmission.createdAt), desc(offlineOrderAdmission.orderId)).limit(21);
    // Hidden orders remain discoverable: hiding is not proof of cancellation.
    // No paid flag, request key, provider identity, ticket or financial receipt.
    const items = rows.slice(0, 20).map(({ admission, order }) => {
      assertOfflineAdmission(order, admission, uid);
      return { order_id: admission.orderNo, money: admission.rawPrice, pay_price: admission.payPrice,
        channel: admission.channel, created_at: admission.createdAt, hidden: order.isDel !== 0 };
    });
    return { items, next_cursor: rows.length > 20 ? items[items.length - 1].order_id : '' };
  });
}
