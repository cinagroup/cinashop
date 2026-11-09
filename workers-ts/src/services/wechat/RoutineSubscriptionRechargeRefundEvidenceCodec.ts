/** Format10 historical recharge-refund Mini staging. Pure facts/MACs do not
 * establish physical success, current receiver/approval, or sending authority. */
import {Buffer}from 'node:buffer';
import {timingSafeEqual}from 'node:crypto';
import type {Env}from '@/env';
import {captureRechargeRefundJson}from '@/services/payment/RechargeRefundJournalCodec';
import {rechargeRefundSuccessNoticeKey,RECHARGE_REFUND_SUCCESS_NOTICE_PREFIX}from '@/services/payment/RechargeRefundSuccessNoticeKey';
import {rechargeRefundDecimal}from '@/services/payment/RechargeRefundMoney';
import {routineEvidenceCanonical,routineEvidenceHmac}from '@/services/payment/RoutineProviderObservation';
import {parseRoutineSubscriptionAccountJournal,type RoutineSubscriptionScope,type RoutineSubscriptionAccountJournal}from '@/services/payment/RoutinePurposeAccountEvidenceCodec';
import {routineSubscriptionUnavailable as fail,freezeSubscription,subscriptionObject as object,subscriptionInteger as integer,subscriptionUuid as uuid}from './RoutineSubscriptionAccount';
export interface RoutineSubscriptionRechargeRefundFacts{
 deliveryId:number;outboxId:number;eventKey:string;orderId:number;rootId:number;buyerUid:number;subjectDomain:'recharge';appId:string;
 ownershipId:string;bindingId:number;observationId:string;templateMark:'755';operationId:string;
 family:'first'|'counted-first'|'query'|'callback';totalAttempts:number;localResultId:string;localSignature:string;
 causeResultId:string;causeSignature:string;noticeSignature:string;physicalDigest:string;ownershipDigest:string;sourceDigest:string;
}
export const RECHARGE_REFUND_SUBSCRIPTION_FACT_KEYS=['deliveryId','outboxId','eventKey','orderId','rootId','buyerUid','subjectDomain','appId',
 'ownershipId','bindingId','observationId','templateMark','operationId','family','totalAttempts','localResultId','localSignature',
 'causeResultId','causeSignature','noticeSignature','physicalDigest','ownershipDigest','sourceDigest']as const;
export interface RoutineSubscriptionRechargeRefundIntent{
 format:10;scope:RoutineSubscriptionScope;actor:{role:string;roleOid:string};deliveryId:number;outboxId:number;eventKey:string;createdAt:number;
 requestSignature:string;source:RoutineSubscriptionRechargeRefundFacts;policy:RoutineSubscriptionAccountJournal;
 request:{touser:string;template_id:string;page:string;data:Record<string,{value:string}>};signature:string;
}
const hex=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v);
const token=(v:unknown,n=100):v is string=>typeof v==='string'&&new RegExp(`^[A-Za-z0-9_-]{1,${n}}$`,'u').test(v);
const role=(v:unknown):v is string=>typeof v==='string'&&/^[a-z_][a-z0-9_]{0,62}$/u.test(v)&&!v.startsWith('pg_')&&v!=='information_schema';
const oid=(v:unknown):v is string=>typeof v==='string'&&/^[1-9]\d{0,9}$/u.test(v)&&BigInt(v)<=4294967295n;
export const rechargeRefundSubscriptionMac=(env:Pick<Env,'APP_KEY'>,domain:string,value:unknown)=>routineEvidenceHmac(env,'subscription-recharge-refund-'+domain,value);
export function captureRoutineSubscriptionRechargeRefundFacts(raw:unknown):Readonly<RoutineSubscriptionRechargeRefundFacts>{
 const r=object(captureRechargeRefundJson(raw),RECHARGE_REFUND_SUBSCRIPTION_FACT_KEYS);
 if(!integer(r.deliveryId)||!integer(r.outboxId)||!integer(r.orderId)||r.rootId!==r.orderId||!integer(r.buyerUid)||r.subjectDomain!=='recharge'
  ||!token(r.appId,32)||!hex(r.ownershipId)||!integer(r.bindingId)||!uuid(r.observationId)||r.templateMark!=='755'||!uuid(r.operationId)
  ||!rechargeRefundSuccessNoticeKey(r.eventKey)||r.eventKey!==RECHARGE_REFUND_SUCCESS_NOTICE_PREFIX+r.operationId
  ||!['first','counted-first','query','callback'].includes(String(r.family))||!integer(r.totalAttempts)||Number(r.totalAttempts)>64
  ||r.family==='first'&&r.totalAttempts!==1||['counted-first','query'].includes(String(r.family))&&Number(r.totalAttempts)<2
  ||!uuid(r.localResultId)||!uuid(r.causeResultId)||r.localResultId===r.causeResultId
  ||['localSignature','causeSignature','noticeSignature','physicalDigest','ownershipDigest','sourceDigest'].some(k=>!hex(r[k])))return fail();
 return freezeSubscription(r)as unknown as Readonly<RoutineSubscriptionRechargeRefundFacts>;
}
export function parseRoutineSubscriptionRechargeRefundIntent(env:Pick<Env,'APP_KEY'>,raw:unknown,expected:RoutineSubscriptionScope):Readonly<RoutineSubscriptionRechargeRefundIntent>{
 const r=object(raw,['format','scope','actor','deliveryId','outboxId','eventKey','createdAt','requestSignature','source','policy','request','signature']);
 const scope=object(r.scope,['database','databaseOid','maintenance','maintenanceOid']),actor=object(r.actor,['role','roleOid']);
 const f=captureRoutineSubscriptionRechargeRefundFacts(r.source),q=object(r.request,['touser','template_id','page','data']);
 if(r.format!==10||routineEvidenceCanonical(scope)!==routineEvidenceCanonical(expected)||!role(scope.database)||!role(scope.maintenance)||!oid(scope.databaseOid)||!oid(scope.maintenanceOid)
  ||!role(actor.role)||!oid(actor.roleOid)||actor.role===scope.maintenance||actor.roleOid===scope.maintenanceOid||!integer(r.createdAt)
  ||r.deliveryId!==f.deliveryId||r.outboxId!==f.outboxId||r.eventKey!==f.eventKey||r.requestSignature!==f.noticeSignature
  ||!token(q.touser)||!token(q.template_id)||q.page!=='/pages/users/user_bill/index?type=2')return fail();
 const rawData=object(q.data,['character_string1','amount3','amount4','date5']),data:Record<string,{value:string}>={};
 for(const [name,value]of Object.entries(rawData)){const d=object(value,['value']);if(typeof d.value!=='string'||!d.value||d.value.length>100||/[\u0000-\u001f\u007f]/u.test(d.value))return fail();data[name]={value:d.value};}
 const policy=parseRoutineSubscriptionAccountJournal(env,r.policy,expected);
 if(policy.payload.data.state!=='active'||policy.payload.data.appId!==f.appId||Number(r.createdAt)<policy.created_at
  ||Number(r.createdAt)<policy.payload.data.validFrom||Number(r.createdAt)>=policy.payload.data.validUntil
  ||!policy.payload.data.templates.some(t=>t.mark==='755'&&t.templateId===q.template_id))return fail();
 const signature=r.signature,unsigned={format:10 as const,scope,actor,deliveryId:r.deliveryId,outboxId:r.outboxId,eventKey:r.eventKey,createdAt:r.createdAt,requestSignature:r.requestSignature,source:f,policy,request:{touser:q.touser,template_id:q.template_id,page:q.page,data}};
 if(Buffer.byteLength(JSON.stringify(unsigned),'utf8')>65536)return fail();
 const mac=rechargeRefundSubscriptionMac(env,'stage',unsigned);
 if(!hex(signature)||!timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(mac,'hex')))return fail();
 return freezeSubscription({...unsigned,signature})as unknown as Readonly<RoutineSubscriptionRechargeRefundIntent>;
}
export function renderRoutineRechargeRefundData(input:{orderNo:string;principalCents:number;postBalanceCents:number;occurredAt:number}){
 if(!token(input.orderNo)||!integer(input.occurredAt)||!Number.isSafeInteger(input.principalCents)||input.principalCents<=0
  ||!Number.isSafeInteger(input.postBalanceCents)||input.postBalanceCents<0)return fail();
 return{character_string1:input.orderNo,amount3:rechargeRefundDecimal(input.principalCents),amount4:rechargeRefundDecimal(input.postBalanceCents),
  date5:new Date((input.occurredAt+8*3600)*1000).toISOString().slice(0,19).replace('T',' ')};
}
