/** A committed source from the actual membership settlement transaction.
 * Callers acquire commissioning gates before their business locks. */
import { eq, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { otherOrder, storeOrderOutbox } from '@/models/schema';
import { ServiceUnavailableException } from '@/utils/errors';
import { subscriptionMac, subscriptionEqual, subscriptionSame } from '@/services/wechat/RoutineSubscriptionAccount';
import { captureMembershipPaidNoticeBusiness, membershipPaidNoticeObject, membershipPaidSettlementKey,
  type MembershipPaidNoticeBusiness } from './MembershipPaidNoticeCodec';

export type MembershipNoticeSigning = Readonly<{ APP_KEY?: string }>;
export function membershipNoticeSigning(env: MembershipNoticeSigning | undefined): Readonly<{ APP_KEY: string }> {
  const d = env && Object.getOwnPropertyDescriptor(env,'APP_KEY');
  if (!d?.enumerable || !('value' in d) || typeof d.value !== 'string' || !d.value || d.value.length > 8192)
    throw new ServiceUnavailableException('会员付款通知签名尚未就绪');
  return Object.freeze({ APP_KEY: d.value });
}
async function scopeTx(tx:DbClient) {
  const [scope] = await tx.execute<{database:string;databaseOid:string;maintenance:string;maintenanceOid:string}>(sql`SELECT
    pg_catalog.current_database() AS database,(SELECT oid::text FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS "databaseOid",
    pg_catalog.pg_get_userbyid(c.relowner) AS maintenance,c.relowner::text AS "maintenanceOid"
    FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass('public.store_order_outbox')
      AND pg_catalog.to_regclass('store_order_outbox')=c.oid
      AND pg_catalog.to_regclass('other_order')=pg_catalog.to_regclass('public.other_order')
      AND pg_catalog.to_regclass('user')=pg_catalog.to_regclass('public.user')`);
  if (!scope || !scope.database || !scope.maintenance || !/^[1-9]\d*$/u.test(scope.databaseOid) || !/^[1-9]\d*$/u.test(scope.maintenanceOid))
    throw new ServiceUnavailableException('会员付款通知数据库来源无效');
  return scope;
}
export async function membershipPaidSettlementPayload(tx:DbClient, env: MembershipNoticeSigning, body: MembershipPaidNoticeBusiness) {
  const business = captureMembershipPaidNoticeBusiness(body), key = membershipNoticeSigning(env);
  const scope = await scopeTx(tx);
  return { scope, business, signature: subscriptionMac(key,'membership-paid-settlement-v1',{scope,business}) };
}
export async function readMembershipPaidSettlementTx(tx: DbClient, env: MembershipNoticeSigning,
  input: MembershipPaidNoticeBusiness) {
  const body = captureMembershipPaidNoticeBusiness(input), key = membershipNoticeSigning(env);
  const scope = await scopeTx(tx);
  const rows = await tx.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventKey,membershipPaidSettlementKey(body.orderId)))
    .limit(2).for('share',{noWait:true}), event = rows[0];
  if (rows.length !== 1 || event.eventType !== 'membership.settled' || event.aggregateType !== 'membership'
    || event.aggregateId !== body.orderId || event.status !== 'COMPLETED' || event.addTime !== body.occurredAt
    || event.processedTime !== body.occurredAt) throw new ServiceUnavailableException('会员付款通知结算来源无效');
  const p = membershipPaidNoticeObject(event.payload,['scope','business','signature']);
  if (!subscriptionSame(captureMembershipPaidNoticeBusiness(p.business),body)
    || !subscriptionSame(p.scope,scope) || !subscriptionEqual(p.signature,subscriptionMac(key,'membership-paid-settlement-v1',{scope,business:body})))
    throw new ServiceUnavailableException('会员付款通知结算签名无效');
  const orders = await tx.select().from(otherOrder).where(eq(otherOrder.id,body.orderId)).limit(2).for('share',{noWait:true}), order = orders[0];
  if (orders.length !== 1 || order.orderId !== body.orderNo || order.uid !== body.userId || order.paid !== 1 || order.isDel !== 0
    || order.type !== (body.kind === 'free-claim' ? 0 : 1) || order.isFree !== (body.kind === 'free-claim' ? 1 : 0)
    || order.payPrice !== body.payPrice || order.payType !== body.payType || order.payTime !== body.payTime || order.tradeNo !== body.tradeNo
    || order.memberType !== body.memberType || order.vipDay !== body.vipDay || order.isPermanent !== body.isPermanent
    || order.overdueTime !== body.overdueTime) throw new ServiceUnavailableException('会员付款通知实际主体发生变化');
  return { event, order };
}
