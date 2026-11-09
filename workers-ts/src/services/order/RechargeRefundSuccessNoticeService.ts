/** Dedicated recharge-refund notification author. Financial success and the
 * immutable notice commit first; this transaction stages only SMS/Mini/inbox.
 * Generic outbox processing remains excluded from the UUID refund namespace. */
import {Buffer}from 'node:buffer';
import {timingSafeEqual}from 'node:crypto';
import {and,desc,eq,sql}from 'drizzle-orm';
import type {Env}from '@/env';
import type {DbClient}from '@/lib/di';
import {createContainerFromDb,withTx}from '@/lib/di';
import {orderNotificationDelivery,systemNotification,systemMessage,type OrderNotificationChannel,type OrderNotificationDeliveryPayload}from '@/models/schema';
import {readRechargeRefundSuccessNoticeSourceTx}from '@/services/payment/RechargeRefundSuccessNoticeSource';
import {rechargeRefundSuccessNoticeKey}from '@/services/payment/RechargeRefundSuccessNoticeKey';
import {rechargeRefundDecimal}from '@/services/payment/RechargeRefundMoney';
import {captureRechargeRefundJson}from '@/services/payment/RechargeRefundJournalCodec';
import {routineEvidenceCanonical,routineEvidenceHmac}from '@/services/payment/RoutineProviderObservation';
import {prepareRoutineSubscriptionNoticeAuthorTx,assertRoutineSubscriptionNoticeAuthorTx}from '@/services/wechat/RoutineSubscriptionDeliveryNotice';
import {routineSubscriptionScopeTx,routineSubscriptionUnavailable as fail,subscriptionObject as object}from '@/services/wechat/RoutineSubscriptionAccount';
import {parseRoutineSubscriptionRechargeRefundIntent,rechargeRefundSubscriptionMac,type RoutineSubscriptionRechargeRefundIntent}from '@/services/wechat/RoutineSubscriptionRechargeRefundEvidenceCodec';
import {readRoutineSubscriptionRechargeRefundDeliveryTx}from '@/services/wechat/RoutineSubscriptionRechargeRefundSource';
type Source=Awaited<ReturnType<typeof readRechargeRefundSuccessNoticeSourceTx>>;
const mark='recharge_order_refund_status',same=(a:unknown,b:unknown)=>routineEvidenceCanonical(a)===routineEvidenceCanonical(b);
const mac=(env:Pick<Env,'APP_KEY'>,v:unknown)=>routineEvidenceHmac(env,'recharge-refund-sms-stage-v1',v);
interface RefundDelivery extends Record<string,unknown>{id:number;outbox_id:number;event_key:string;order_id:number|null;withdrawal_id:number|null;subject_domain:string;subject_id:number;user_id:number;notice_mark:string;channel:string;target:string;template_code:string;payload:OrderNotificationDeliveryPayload;add_time:number;status:string}
async function prior(tx:DbClient,key:string,channel:'sms'|'wechat_routine'){
 const rows=await tx.execute<RefundDelivery>(sql`SELECT * FROM public.order_notification_delivery WHERE event_key=${key} AND channel=${channel} LIMIT 2 FOR UPDATE NOWAIT`);
 if(rows.length>1)return fail();return rows[0];
}
function subject(row:RefundDelivery,s:Source,channel:'sms'|'wechat_routine'){
 if(row.outbox_id!==s.event.id||row.event_key!==s.event.eventKey||row.order_id!==null||row.withdrawal_id!==null||row.subject_domain!=='recharge'||row.subject_id!==s.facts.recharge.id
  ||row.user_id!==s.facts.recharge.buyerUid||row.notice_mark!==mark||row.channel!==channel||row.payload.kind!==channel||row.add_time<s.facts.capturedAt)return fail();
}
async function insert(tx:DbClient,s:Source,channel:'sms'|'wechat_routine',target:string,template:string,payload:unknown,now:number,skip=''){
 const rows=await tx.execute<RefundDelivery>(sql`INSERT INTO public.order_notification_delivery(outbox_id,event_key,order_id,withdrawal_id,subject_domain,subject_id,user_id,notice_mark,channel,target,template_code,payload,status,available_time,last_error,add_time,update_time)
  VALUES(${s.event.id},${s.event.eventKey},NULL,NULL,'recharge',${s.facts.recharge.id},${s.facts.recharge.buyerUid},${mark},${channel},${target},${template},${JSON.stringify(payload)}::jsonb,${skip?'SKIPPED':'PENDING'},${now},${skip},${now},${now}) RETURNING *`);
 if(rows.length!==1)return fail();subject(rows[0],s,channel);
 if(rows[0].target!==target||rows[0].template_code!==template||!same(rows[0].payload,payload)||rows[0].status!==(skip?'SKIPPED':'PENDING'))return fail();return rows[0];
}
function smsUnsigned(s:Source,target:string,templateCode:string,createdAt:number){return{format:1,purpose:'recharge-refund-sms-stage-v1',scope:s.scope,eventKey:s.event.eventKey,outboxId:s.event.id,
 operationId:s.operation.operation_id,localSignature:s.local.signature,noticeSignature:(s.event.payload as unknown as {signature:string}).signature,physicalDigest:s.sourceDigest,
 buyerUid:s.facts.recharge.buyerUid,target,templateCode,createdAt,params:{refund_price:rechargeRefundDecimal(s.facts.recharge.principalCents)}};}
function assertSms(env:Pick<Env,'APP_KEY'>,s:Source,r:RefundDelivery){
 subject(r,s,'sms');const p=object(captureRechargeRefundJson(r.payload),['kind','params','rechargeRefundProof']);if(p.kind!=='sms')return fail();
 const proof=object(p.rechargeRefundProof,['format','purpose','scope','eventKey','outboxId','operationId','localSignature','noticeSignature','physicalDigest','buyerUid','target','templateCode','createdAt','params','signature']);
 const expected=smsUnsigned(s,s.facts.flow.phone,r.template_code,r.add_time),{signature,...unsigned}=proof;
 if(r.target!==s.facts.flow.phone||!same(unsigned,expected)||!same(p.params,expected.params)||typeof signature!=='string'||!/^[a-f0-9]{64}$/u.test(signature)||!timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(mac(env,expected),'hex')))return fail();
}
/** Called before the generic delivery claim may lend any provider capability.
 * Supplied delivery JSON alone never establishes physical success or recipient. */
export async function assertRechargeRefundSuccessDeliveryTx(tx:DbClient,env:Pick<Env,'APP_KEY'>,deliveryId:number,eventKey:string,channel:OrderNotificationChannel){
 if(!rechargeRefundSuccessNoticeKey(eventKey)||!['sms','wechat_routine'].includes(channel))return fail();
 const rows=await tx.execute<RefundDelivery>(sql`SELECT * FROM public.order_notification_delivery WHERE id=${deliveryId} LIMIT 2`),r=rows[0];
 if(rows.length!==1||r.event_key!==eventKey||r.channel!==channel)return fail();
 const s=await readRechargeRefundSuccessNoticeSourceTx(tx,env,{outboxId:r.outbox_id,eventKey});subject(r,s,channel as 'sms'|'wechat_routine');
 if(channel==='sms')assertSms(env,s,r);return s;
}
async function mini(tx:DbClient,env:Env,s:Source,now:number):Promise<boolean>{
 try{return await withTx(createContainerFromDb(tx),async nested=>{
  const exists=await prior(nested,s.event.eventKey,'wechat_routine');
  if(exists){subject(exists,s,'wechat_routine');
   const r=await readRoutineSubscriptionRechargeRefundDeliveryTx(nested,exists.id),payload=r.payload;
   if(payload.kind!=='wechat_routine')return fail();
   const intent=parseRoutineSubscriptionRechargeRefundIntent(env,payload.routineSubscriptionIntent,await routineSubscriptionScopeTx(nested));
   if(intent.deliveryId!==r.id||intent.outboxId!==s.event.id||intent.source.physicalDigest!==s.sourceDigest||intent.source.localSignature!==s.local.signature)return fail();
   return true;
  }
  const author=await prepareRoutineSubscriptionNoticeAuthorTx(nested,env,{outboxId:s.event.id,eventKey:s.event.eventKey});assertRoutineSubscriptionNoticeAuthorTx(nested,author);
  if(!('operationId'in author.facts)||author.facts.operationId!==s.operation.operation_id||author.renderedAt<now)return fail();
  const payload={kind:'wechat_routine' as const,routineAppId:author.facts.appId,data:Object.fromEntries(Object.entries(author.request.data).map(([k,v])=>[k,v.value])),url:author.request.page};
  const row=await insert(nested,s,'wechat_routine',author.request.touser,author.request.template_id,payload,author.renderedAt);
  const scope=await routineSubscriptionScopeTx(nested),[actor]=await nested.execute<{role:string;roleOid:string}>(sql`SELECT current_user AS role,(SELECT oid::text FROM pg_catalog.pg_roles WHERE rolname=current_user)AS "roleOid"`);if(!actor)return fail();
  const body:Omit<RoutineSubscriptionRechargeRefundIntent,'signature'>={format:10,scope,actor,deliveryId:row.id,outboxId:s.event.id,eventKey:s.event.eventKey,createdAt:author.renderedAt,requestSignature:author.requestSignature,
   source:{...author.facts,deliveryId:row.id},policy:author.account.account,request:author.request};
  const intent=parseRoutineSubscriptionRechargeRefundIntent(env,{...body,signature:rechargeRefundSubscriptionMac(env,'stage',body)},scope),final={...payload,routineSubscriptionIntent:intent};
  const changed=await nested.update(orderNotificationDelivery).set({payload:final}).where(and(eq(orderNotificationDelivery.id,row.id),eq(orderNotificationDelivery.attemptCount,0),eq(orderNotificationDelivery.status,'PENDING'),sql`${orderNotificationDelivery.payload}=${JSON.stringify(payload)}::jsonb`)).returning({id:orderNotificationDelivery.id});if(changed.length!==1)return fail();return true;
 });}catch{return false;}
}
const render=(text:string,data:Record<string,string>)=>{for(const [k,v]of Object.entries(data))text=text.replaceAll('{'+k+'}',()=>v);return text;};
export async function stageRechargeRefundSuccessNoticeTx(tx:DbClient,env:Env,s:Source){
 const rows=await tx.select().from(systemNotification).where(eq(systemNotification.mark,mark)).orderBy(desc(systemNotification.id)).limit(2);if(rows.length>1)return fail();const config=rows[0];if(!config)return{deferred:false};
 const [clock]=await tx.execute<{now:string}>(sql`SELECT floor(extract(epoch FROM pg_catalog.clock_timestamp()))::bigint AS now`),now=Number(clock?.now);if(!Number.isSafeInteger(now)||now<s.facts.capturedAt||now>2147483647)return fail();
 if(config.isSms===1){const existing=await prior(tx,s.event.eventKey,'sms');if(existing)assertSms(env,s,existing);else{
  const target=s.facts.flow.phone,template=config.smsId.trim(),body=smsUnsigned(s,target,template,now),payload={kind:'sms',params:body.params,rechargeRefundProof:{...body,signature:mac(env,body)}};
  await insert(tx,s,'sms',target,template,payload,now,!target?'target_not_configured':!template?'template_not_configured':'');
 }}
 if(config.isSystem===1){const data={refund_price:rechargeRefundDecimal(s.facts.recharge.principalCents),order_id:s.facts.recharge.orderNo,price:rechargeRefundDecimal(s.facts.recharge.principalCents)},title=render(config.systemTitle,data),content=render(config.systemText,data);
  if(Array.from(title).length>256)return fail();
  const existing=await tx.select().from(systemMessage).where(eq(systemMessage.eventKey,s.event.eventKey)).limit(2);if(existing.length>1)return fail();
  if(existing[0]){if(existing[0].userId!==s.facts.recharge.buyerUid||existing[0].mark!==mark)return fail();}
  else{const inserted=await tx.insert(systemMessage).values({eventKey:s.event.eventKey,mark,title,content,userId:s.facts.recharge.buyerUid,look:0,type:1,status:1,addTime:s.facts.capturedAt,isDel:0}).returning();if(inserted.length!==1||inserted[0].userId!==s.facts.recharge.buyerUid||inserted[0].eventKey!==s.event.eventKey)return fail();}
 }
 return{deferred:config.isRoutine===1?!await mini(tx,env,s,now):false};
}
