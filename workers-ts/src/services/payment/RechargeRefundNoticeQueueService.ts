/** Dedicated passive-success notice discovery. Scanning emits addresses after
 * RR/RO COMMIT; processing stages notifications in its own actual App TX.
 * A scanner/Queue address carries no provider or financial authority. */
import {and,eq,sql}from 'drizzle-orm';
import type {Env}from '@/env';
import type {Container,DbClient}from '@/lib/di';
import {storeOrderOutbox}from '@/models/schema';
import {stageRechargeRefundSuccessNoticeTx}from '@/services/order/RechargeRefundSuccessNoticeService';
import {prepareRechargeRefundSuccessNoticeContextTx,readRechargeRefundSuccessNoticeSourceTx}from './RechargeRefundSuccessNoticeSource';
import {captureRechargeRefundNoticeDispatch,captureRechargeRefundNoticeMessage,type RechargeRefundNoticeDispatch,type RechargeRefundNoticeMessage}from './RechargeRefundNoticeQueue';
import {ServiceUnavailableException}from '@/utils/errors';
const fail=():never=>{throw new ServiceUnavailableException('充值退款通知后台处理暂不可核对');};
const root=(c:Container)=>{if(!Object.hasOwn(c.db,'$client')||!c.db.$client)return fail();return c.db;};
export class RechargeRefundNoticeQueueService{
 constructor(private readonly container:Container,private readonly env:Env){}
 async dispatch(raw:RechargeRefundNoticeDispatch){
  const message=captureRechargeRefundNoticeDispatch(raw),db=root(this.container);
  const page=await db.transaction(async rawTx=>{
   const tx=rawTx as unknown as DbClient;await prepareRechargeRefundSuccessNoticeContextTx(tx,'read');
   const [clock]=await tx.execute<{now:string}>(sql`SELECT floor(extract(epoch FROM pg_catalog.clock_timestamp()))::bigint AS now`),now=Number(clock?.now);
   if(!Number.isSafeInteger(now)||now<1||now>2147483647||message.cutoff!==null&&message.cutoff>now)return fail();const cutoff=message.cutoff??now;
   const rows=await tx.execute<{id:number;event_key:string}>(sql`SELECT id,event_key FROM public.store_order_outbox WHERE event_type='recharge.refund.success.notice' AND aggregate_type='recharge'
    AND status IN('PENDING','FAILED') AND available_time<=${cutoff} AND id>${message.afterId} ORDER BY id LIMIT 21`);
   const addresses=rows.slice(0,20).map(row=>captureRechargeRefundNoticeMessage({action:'processRechargeRefundNotice',outboxId:row.id,eventKey:row.event_key}));
   const continuation=rows.length>20?captureRechargeRefundNoticeDispatch({...message,cutoff,afterId:rows[19].id}):null;
   const [tail]=await tx.execute<{ready:boolean}>(sql`SELECT pg_catalog.clock_timestamp()<=pg_catalog.transaction_timestamp()+interval '5 seconds'AS ready`);if(tail?.ready!==true)return fail();
   return{addresses,continuation};
  },{isolationLevel:'repeatable read',accessMode:'read only'});
  const messages:Array<RechargeRefundNoticeMessage|RechargeRefundNoticeDispatch>=[...page.addresses];if(page.continuation)messages.push(page.continuation);
  if(messages.length)await this.env.ORDER_QUEUE.sendBatch(messages.map(body=>({body,contentType:'json'})));
  return{enqueued:page.addresses.length,hasMore:page.continuation!==null};
 }
 async process(raw:RechargeRefundNoticeMessage){
  const message=captureRechargeRefundNoticeMessage(raw),db=root(this.container);
  return db.transaction(async rawTx=>{
   const tx=rawTx as unknown as DbClient;await prepareRechargeRefundSuccessNoticeContextTx(tx);
   const rows=await tx.select().from(storeOrderOutbox).where(and(eq(storeOrderOutbox.id,message.outboxId),eq(storeOrderOutbox.eventKey,message.eventKey))).limit(2).for('update',{noWait:true}),row=rows[0];
   if(rows.length!==1||row.eventType!=='recharge.refund.success.notice'||row.aggregateType!=='recharge')return fail();
   if(row.status==='COMPLETED')return'already-completed' as const;
   if(row.status==='DEAD')return'dead' as const;
   if(!['PENDING','FAILED'].includes(row.status))return fail();
   const [clock]=await tx.execute<{now:string}>(sql`SELECT floor(extract(epoch FROM pg_catalog.clock_timestamp()))::bigint AS now`),now=Number(clock?.now);
   if(!Number.isSafeInteger(now)||now<1||now>2147483587)return fail();if(row.availableTime>now)return'waiting' as const;
   const source=await readRechargeRefundSuccessNoticeSourceTx(tx,this.env,{outboxId:message.outboxId,eventKey:message.eventKey});
   const staged=await stageRechargeRefundSuccessNoticeTx(tx,this.env,source);
   const changed=await tx.update(storeOrderOutbox).set({status:staged.deferred?'FAILED':'COMPLETED',attemptCount:row.attemptCount+1,availableTime:staged.deferred?now+60:row.availableTime,
    leaseUntil:0,leaseToken:'',lastError:staged.deferred?'recharge_refund_mini_staging_deferred':'',processedTime:staged.deferred?0:now,updateTime:now})
    .where(and(eq(storeOrderOutbox.id,row.id),eq(storeOrderOutbox.status,row.status),eq(storeOrderOutbox.eventKey,row.eventKey),sql`${storeOrderOutbox.payload}=${JSON.stringify(row.payload)}::jsonb`)).returning({id:storeOrderOutbox.id});
   if(changed.length!==1)return fail();
   const [tail]=await tx.execute<{ready:boolean}>(sql`SELECT pg_catalog.clock_timestamp()<=pg_catalog.transaction_timestamp()+interval '5 seconds'AS ready`);if(tail?.ready!==true)return fail();
   return staged.deferred?'deferred' as const:'completed' as const;
  },{isolationLevel:'read committed',accessMode:'read write'});
 }
}
