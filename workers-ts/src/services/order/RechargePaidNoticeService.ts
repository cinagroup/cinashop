/** Actual first recharge settlement -> immutable source and buyer notice. */
import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Container, DbClient } from '@/lib/di';
import type { OrderOutboxEnvironment } from './OrderOutboxService';
import { userRecharge, userBill, storeOrderOutbox, systemMessage, systemNotification, user, wechatUser,
  type OrderNotificationChannel, type OrderNotificationDeliveryPayload } from '@/models/schema';
import { subscriptionSame } from '@/services/wechat/RoutineSubscriptionAccount';
import { createRoutineSubscriptionRechargeRequestTx } from '@/services/wechat/RoutineSubscriptionRechargeRequest';
import { stageRoutineSubscriptionNoticeTx, type RoutineSubscriptionNoticeEnvironment } from '@/services/wechat/RoutineSubscriptionNoticeAuthor';
import { configuredTemplate, type OrderNotificationOutboxEvent } from './OrderNotificationOutboxService';
import { captureRechargePaidNoticeBusiness, rechargePaidNoticeBusinessFromPayload, rechargePaidNoticeEventKey,
  rechargePaidSettlementKey, type RechargePaidNoticeBusiness } from './RechargePaidNoticeCodec';
import { rechargePaidSettlementPayload, readRechargePaidSettlementTx, type RechargeNoticeSigning, type RechargeNoticeProvider } from './RechargePaidNoticeSource';
import { paidNoticeDate } from './OrderPaidNoticeCodec';
import { emitOperationalEvent, operationalErrorCode } from '@/utils/observability';

export const RECHARGE_PAID_NOTICE_EVENT = 'recharge.pay.success.notice';
export const RECHARGE_PAID_NOTICE_MARK = 'recharge_success';
/** Queue is only an accelerator after commit. The scanner remains authoritative. */
export async function dispatchCommittedRechargePaidNotice(container:Container,env:OrderOutboxEnvironment,eventKey:string|undefined):Promise<void> {
  if (!eventKey) return;
  try {
    const rows = await container.db.select({id:storeOrderOutbox.id}).from(storeOrderOutbox)
      .where(and(eq(storeOrderOutbox.eventKey,eventKey),eq(storeOrderOutbox.eventType,RECHARGE_PAID_NOTICE_EVENT),eq(storeOrderOutbox.aggregateType,'recharge'))).limit(2);
    if (rows.length > 1) throw Error('充值通知加速来源重复');
    if (rows[0]) {
      const {OrderOutboxService} = await import('./OrderOutboxService');
      await new OrderOutboxService(container,env).dispatchById(rows[0].id);
    }
  } catch (error) {
    emitOperationalEvent('error',{event:'recharge_paid_notice_dispatch_failed',component:'queue',operation:'recharge_payment',
      outcome:'failure',errorCode:operationalErrorCode(error,'recharge_notice_dispatch_failed')});
  }
}
type RechargeChannel = Extract<OrderNotificationChannel,'sms'|'wechat_official'|'wechat_routine'>;
interface RechargeDeliveryRow extends Record<string,unknown> { id: number; outbox_id: number; event_key: string; order_id: number|null;
  withdrawal_id: number|null; subject_domain: string|null; subject_id: number|null; user_id: number;
  notice_mark: string; channel: string; target: string; template_code: string; payload: OrderNotificationDeliveryPayload;
  status: string; add_time: number; available_time: number; last_error: string }
/** Generic SMS/official claims prove the actual recharge source. Mini claims
 * prove the physical subject here and use the separate signed fresh-source /
 * immutable-attempt protocol immediately before any provider POST. */
export async function assertRechargePaidDeliveryTx(tx:DbClient, env:RechargeNoticeSigning,
  id:number,eventKey:string,channel:OrderNotificationChannel):Promise<void> {
  const rows = await tx.execute<RechargeDeliveryRow>(sql`SELECT * FROM public.order_notification_delivery WHERE id=${id} LIMIT 2`), row = rows[0];
  if (rows.length !== 1 || row.event_key !== eventKey || row.channel !== channel || row.order_id !== null || row.withdrawal_id !== null
    || row.subject_domain !== 'recharge' || !row.subject_id || !['sms','wechat_official','wechat_routine'].includes(channel)
    || row.notice_mark !== RECHARGE_PAID_NOTICE_MARK || row.payload.kind !== channel) throw Error('充值付款投递业务域无效');
  const events = await tx.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id,row.outbox_id)).limit(2).for('share',{noWait:true}), event = events[0];
  if (events.length !== 1 || event.eventType !== RECHARGE_PAID_NOTICE_EVENT || event.aggregateType !== 'recharge'
    || event.aggregateId !== row.subject_id || event.eventKey !== eventKey) throw Error('充值付款投递事件无效');
  const body = rechargePaidNoticeBusinessFromPayload(event.payload);
  if (body.orderId !== row.subject_id || row.event_key !== rechargePaidNoticeEventKey(body.orderId) || row.user_id !== body.userId
    || event.addTime !== body.occurredAt || (channel === 'wechat_routine' ? row.add_time < body.occurredAt : row.add_time !== body.occurredAt))
    throw Error('充值付款投递快照无效');
  if (channel === 'wechat_routine') return;
  await readRechargePaidSettlementTx(tx,env,body);
  const expected = channel === 'sms' ? { kind:'sms',params:{price:body.payPrice,now_money:body.postBalance} }
    : { kind:'wechat_official',subjectDomain:'recharge',url:null,data:{time11:paidNoticeDate(body.creationTime),amount5:body.payPrice} };
  if (!subscriptionSame(row.payload,expected) || channel === 'sms' && row.target !== body.phone)
    throw Error('充值付款投递渲染快照无效');
}
export async function createRechargePaidDeliveryTx(tx: DbClient, input: {
  event: OrderNotificationOutboxEvent; body: RechargePaidNoticeBusiness; channel: RechargeChannel;
  target: string; templateCode: string; payload: OrderNotificationDeliveryPayload; now: number;
  status?: 'PENDING'|'SKIPPED'; skipReason?: string;
}): Promise<{ id: number }> {
  const body = captureRechargePaidNoticeBusiness(input.body), key = rechargePaidNoticeEventKey(body.orderId);
  if (input.event.eventKey !== key || input.event.eventType !== RECHARGE_PAID_NOTICE_EVENT
    || input.event.aggregateId !== body.orderId || input.event.addTime !== body.occurredAt
    || !subscriptionSame(rechargePaidNoticeBusinessFromPayload(input.event.payload),body)
    || input.payload.kind !== input.channel || !['sms','wechat_official','wechat_routine'].includes(input.channel)
    || !Number.isSafeInteger(input.now) || input.now > 2147483647
    || (input.channel === 'wechat_routine' ? input.now < body.occurredAt : input.now !== body.occurredAt)) throw Error('充值付款投递来源无效');
  const metadata = (r: RechargeDeliveryRow) => {
    if (r.outbox_id !== input.event.id || r.event_key !== key || r.order_id !== null || r.withdrawal_id !== null
      || r.subject_domain !== 'recharge' || r.subject_id !== body.orderId || r.user_id !== body.userId
      || r.notice_mark !== RECHARGE_PAID_NOTICE_MARK || r.channel !== input.channel || r.payload.kind !== input.channel
      || (input.channel === 'wechat_routine' ? r.add_time < body.occurredAt || r.add_time > input.now : r.add_time !== body.occurredAt))
      throw Error('充值付款投递不可变主体冲突');
  };
  const existing = await tx.execute<RechargeDeliveryRow>(sql`SELECT * FROM public.order_notification_delivery
    WHERE event_key=${key} AND channel=${input.channel} LIMIT 2 FOR UPDATE NOWAIT`);
  if (existing.length) {
    if (existing.length !== 1) throw Error('充值付款投递来源重复');
    metadata(existing[0]);
    // A later Mini deferral must not adopt replacement SMS/official settings.
    // The signed Mini author additionally verifies its exact intent bytes.
    return { id: existing[0].id };
  }
  const status = input.status ?? (input.skipReason ? 'SKIPPED' : 'PENDING'), reason = input.skipReason ?? '';
  const inserted = await tx.execute<RechargeDeliveryRow>(sql`INSERT INTO public.order_notification_delivery
    (outbox_id,event_key,order_id,withdrawal_id,subject_domain,subject_id,user_id,notice_mark,channel,target,template_code,payload,
     status,available_time,last_error,add_time,update_time)
    VALUES(${input.event.id},${key},NULL,NULL,'recharge',${body.orderId},${body.userId},${RECHARGE_PAID_NOTICE_MARK},
      ${input.channel},${input.target},${input.templateCode},${JSON.stringify(input.payload)}::text::jsonb,
      ${status},${input.now},${reason},${input.now},${input.now}) RETURNING *`);
  if (inserted.length !== 1) throw Error('充值付款投递写入失败');
  const row = inserted[0]; metadata(row);
  if (row.target !== input.target || row.template_code !== input.templateCode || !subscriptionSame(row.payload,input.payload)
    || row.status !== status || row.last_error !== reason || row.available_time !== input.now || row.add_time !== input.now)
    throw Error('充值付款投递写入内容冲突');
  return { id: row.id };
}

/** Only the actual first verified external recharge CAS calls this inside its transaction.
 * Already-paid replay and commission-to-wallet do not call this author. */
export async function enqueueRechargePaidNoticeTx(tx:DbClient,env:RechargeNoticeSigning,
 subjectId:number,billId:number,authority:RechargeNoticeProvider,now:number):Promise<void>{
 if(Object.hasOwn(tx,'$client'))throw Error('充值付款通知需要实际结算事务');
 const rows=await tx.select().from(userRecharge).where(eq(userRecharge.id,subjectId)).limit(2),order=rows[0];
 const bills=await tx.select().from(userBill).where(eq(userBill.id,billId)).limit(2),bill=bills[0];
 if(rows.length!==1||bills.length!==1||order.paid!==1||order.payTime!==now||!['weixin','alipay'].includes(order.rechargeType))throw Error('充值付款通知作者来源无效');
 const buyers=await tx.select({uid:user.uid,phone:user.phone,nickname:user.nickname,nowMoney:user.nowMoney}).from(user).where(and(eq(user.uid,order.uid),eq(user.isDel,0))).limit(2),buyer=buyers[0];
 if(buyers.length!==1)throw Error('充值付款通知买家无效');
 // The author alone compares the actual locked post-credit wallet. Future
 // reads authenticate the saved bill and must not compare a later live wallet.
 if(bill.balance!==buyer.nowMoney)throw Error('充值付款通知账本与当次入账余额不一致');
 const body=captureRechargePaidNoticeBusiness({format:1,domain:'recharge',settlementNonce:randomUUID(),orderId:order.id,orderNo:order.orderId,userId:order.uid,
  payType:order.rechargeType,payPrice:order.price,giftPrice:order.givePrice,creditedAmount:bill.number,postBalance:bill.balance,billId:bill.id,
  payTime:order.payTime,creationTime:order.addTime,tradeNo:order.tradeNo,phone:buyer.phone.trim(),sendName:buyer.nickname,occurredAt:now});
 const signed=await rechargePaidSettlementPayload(tx,env,body,authority),sourceKey=rechargePaidSettlementKey(order.id);
 const [source]=await tx.insert(storeOrderOutbox).values({eventKey:sourceKey,aggregateType:'recharge',aggregateId:order.id,eventType:'recharge.settled',payload:signed,status:'COMPLETED',availableTime:now,processedTime:now,addTime:now,updateTime:now}).returning();
 if(!source||source.eventKey!==sourceKey||source.aggregateType!=='recharge'||source.aggregateId!==order.id||source.eventType!=='recharge.settled'||source.status!=='COMPLETED'||source.addTime!==now||source.processedTime!==now||!subscriptionSame(source.payload,signed))throw Error('充值付款结算证明写入冲突');
 const key=rechargePaidNoticeEventKey(order.id),candidate=await createRoutineSubscriptionRechargeRequestTx(tx,env,{eventKey:key,aggregateId:order.id,payload:body,now});
 const payload={...body,routineSubscriptionRequest:candidate.request};
 const [notice]=await tx.insert(storeOrderOutbox).values({eventKey:key,aggregateType:'recharge',aggregateId:order.id,eventType:RECHARGE_PAID_NOTICE_EVENT,payload,status:'PENDING',availableTime:now,addTime:now,updateTime:now}).returning();
 if(!notice||notice.eventKey!==key||notice.eventType!==RECHARGE_PAID_NOTICE_EVENT||notice.aggregateType!=='recharge'||notice.aggregateId!==order.id||notice.status!=='PENDING'||notice.addTime!==now||!subscriptionSame(notice.payload,payload))throw Error('充值付款通知写入冲突');
}
function render(template: string, values: Record<string,string>): string {
  for (const [key,value] of Object.entries(values)) template = template.replaceAll(`{${key}}`,() => value);
  return template;
}
export async function processRechargePaidNoticeTx(tx: DbClient, event: OrderNotificationOutboxEvent & {aggregateType?:string}, _now: number,
  routine: { env: Readonly<RoutineSubscriptionNoticeEnvironment>; earlyReady:boolean }): Promise<{ deferred:boolean; gap?:'inbox_title_too_long' }> {
  const body = rechargePaidNoticeBusinessFromPayload(event.payload);
  if (event.eventType !== RECHARGE_PAID_NOTICE_EVENT || event.aggregateType !== 'recharge' || event.aggregateId !== body.orderId
    || event.eventKey !== rechargePaidNoticeEventKey(body.orderId) || event.addTime !== body.occurredAt) throw Error('充值付款通知事件无效');
  await readRechargePaidSettlementTx(tx,routine.env,body);
  const configs = await tx.select().from(systemNotification).where(eq(systemNotification.mark,RECHARGE_PAID_NOTICE_MARK)).orderBy(desc(systemNotification.id)).limit(2);
  if (configs.length > 1) throw Error('充值付款通知模板存在重复来源');
  const config = configs[0]; if (!config) return { deferred:false };
  if (config.isSms === 1 && body.phone) await createRechargePaidDeliveryTx(tx,{event,body,channel:'sms',target:body.phone,
    templateCode:config.smsId.trim(), payload:{kind:'sms',params:{price:body.payPrice,now_money:body.postBalance}},
    skipReason:config.smsId.trim() ? undefined : 'template_not_configured', now:body.occurredAt });
  if (config.isWechat === 1) {
    const identities = await tx.select().from(wechatUser).where(and(eq(wechatUser.uid,body.userId),eq(wechatUser.userType,'wechat'),eq(wechatUser.isDel,0)))
      .orderBy(desc(wechatUser.id)).limit(65);
    if (identities.length > 64) throw Error('充值付款通知公众号身份容量超限');
    const target = identities.find(r => r.openid.trim())?.openid.trim() ?? '', templateCode = await configuredTemplate(tx,'42934',1);
    await createRechargePaidDeliveryTx(tx,{event,body,channel:'wechat_official',target,templateCode,now:body.occurredAt,
      payload:{kind:'wechat_official',subjectDomain:'recharge',url:null,data:{time11:paidNoticeDate(body.creationTime),amount5:body.payPrice}},
      skipReason:!target ? 'target_not_configured' : !templateCode ? 'template_not_configured' : undefined});
  }
  const deferred = config.isRoutine === 1
    ? await stageRoutineSubscriptionNoticeTx(tx,routine.env,event,RECHARGE_PAID_NOTICE_MARK,routine.earlyReady,body.occurredAt) === 'deferred' : false;
  if (config.isSystem !== 1) return { deferred };
  const [prior] = await tx.select().from(systemMessage).where(eq(systemMessage.eventKey,event.eventKey)).limit(1);
  if (prior) {
    if (prior.userId !== body.userId || prior.mark !== RECHARGE_PAID_NOTICE_MARK) throw Error('充值付款站内消息主体冲突');
    return { deferred };
  }
  const values = { order_id:body.orderNo,price:body.payPrice,now_money:body.postBalance }, title = render(config.systemTitle,values), content = render(config.systemText,values);
  if (Array.from(title).length > 256) return { deferred,gap:'inbox_title_too_long' };
  const [inserted] = await tx.insert(systemMessage).values({ eventKey:event.eventKey,mark:RECHARGE_PAID_NOTICE_MARK,title,content,
    userId:body.userId,look:0,type:1,status:1,addTime:body.occurredAt,isDel:0 }).onConflictDoNothing({target:systemMessage.eventKey}).returning();
  if (!inserted || inserted.userId !== body.userId || inserted.eventKey !== event.eventKey || inserted.mark !== RECHARGE_PAID_NOTICE_MARK
    || inserted.title !== title || inserted.content !== content) throw Error('充值付款站内消息写入冲突');
  return { deferred };
}
