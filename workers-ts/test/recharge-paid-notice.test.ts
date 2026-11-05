import {readFileSync} from 'node:fs';
import {describe,expect,it,vi} from 'vitest';
import {captureRechargePaidNoticeBusiness,rechargePaidNoticeBusinessFromPayload,rechargePaidNoticeEventKey,rechargePaidNoticeSubjectId} from '@/services/order/RechargePaidNoticeCodec';
import {RECHARGE_PAID_NOTICE_SQL} from '@/migrations/rechargePaidNotice';
import {PAID_NOTICE_SQL,MEMBERSHIP_PAID_NOTICE_GENERATIONS,RECHARGE_PAID_NOTICE_GENERATIONS,paidNoticeEventGeneration,normalizePaidNoticeEventDefinition} from '@/migrations/paidNotice';
import {MEMBERSHIP_PAID_NOTICE_SQL} from '@/migrations/membershipPaidNotice';
import {RECHARGE_PAID_EVENTS} from '@/migrations/rechargePaidNoticeContract';
import {isOrderNotificationOutboxMessage} from '@/services/order/OrderOutboxService';
import {isOrderNotificationDeliveryMessage} from '@/services/order/OrderNotificationDeliveryService';
import {captureRechargeSubscriptionFacts,parseRoutineSubscriptionRechargeRequest,rechargeSubscriptionMac,renderRechargeSubscriptionData,rechargeSubscriptionTransientSqlState} from '@/services/wechat/RoutineSubscriptionRechargeEvidenceCodec';
const body=()=>({format:1,domain:'recharge',settlementNonce:'f78e2645-b266-44a0-8be6-a015ca94b110',orderId:11,orderNo:'cz_recharge_owned',userId:22,payType:'alipay',payPrice:'10.00',giftPrice:'1.50',creditedAmount:'11.50',postBalance:'21.50',billId:31,payTime:1900000000,creationTime:1899999000,tradeNo:'actual_recharge_trade',phone:'13800000022',sendName:'充值$买家',occurredAt:1900000001});
const env={APP_KEY:'recharge-codec-local-authenticator'},scope={database:'recharge_codec',databaseOid:'11',maintenance:'recharge_owner',maintenanceOid:'12'};
const unsigned=()=>({format:9,requestId:'f78e2645-b266-44a0-8be6-a015ca94b111',scope,actor:{role:'recharge_app',roleOid:'13'},eventKey:rechargePaidNoticeEventKey(11),aggregateId:11,eventTime:1900000001,body:body(),selection:{mode:'unique-owner',appId:'wx_recharge_A',ownershipId:'1'.repeat(64),bindingId:41,observationId:'f78e2645-b266-44a0-8be6-a015ca94b112',openid:'owned_recharge_uid22',ownershipDigest:'2'.repeat(64)},settlementDigest:'3'.repeat(64),paymentDigest:'4'.repeat(64),createdAt:1900000001});
const facts=()=>({deliveryId:51,outboxId:61,eventKey:rechargePaidNoticeEventKey(11),orderId:11,rootId:11,buyerUid:22,subjectDomain:'recharge',appId:'wx_recharge_A',ownershipId:'1'.repeat(64),bindingId:41,observationId:'f78e2645-b266-44a0-8be6-a015ca94b112',templateMark:'755',settlementNonce:body().settlementNonce,settlementDigest:'3'.repeat(64),ownershipDigest:'2'.repeat(64),payment:{kind:'unique-identity',payType:'alipay',paymentDigest:'4'.repeat(64)},sourceDigest:'5'.repeat(64)});
describe('fresh recharge buyer notice closed business and Mini755 evidence',()=>{
 it('binds principal, gift and historical post-balance without consulting a later wallet',()=>{
  expect(captureRechargePaidNoticeBusiness(body())).toEqual(body());expect(captureRechargePaidNoticeBusiness({...body(),postBalance:'-1.50'}).postBalance).toBe('-1.50');
  expect(rechargePaidNoticeBusinessFromPayload({...body(),routineSubscriptionRequest:{format:9,unavailable:true}})).toEqual(body());
  expect(renderRechargeSubscriptionData(captureRechargePaidNoticeBusiness(body()))).toEqual({character_string1:body().orderNo,amount3:'10.00',amount4:'21.50',date5:'2030-03-18 01:46:41'});
 });
 it.each([{domain:'membership'},{domain:'store_order'},{payType:'yue'},{payType:'balance'},{payPrice:'0.00'},{payPrice:'00.10'},{giftPrice:'-1.00'},{creditedAmount:'10.00'},{postBalance:'-0.00'},{postBalance:'NaN'},{billId:0},{userId:0},{orderId:2147483648},{creationTime:1900000001},{payTime:1900000002},{tradeNo:''},{phone:' 13800000022'},{sendName:'\ud800'},{orderNo:'hy_recharge_owned'},{settlementNonce:'f78e2645-b266-14a0-8be6-a015ca94b110'}])('rejects invalid domain or financial facts %j',patch=>expect(()=>captureRechargePaidNoticeBusiness({...body(),...patch})).toThrow());
 it('never executes getters or coercion while capturing source facts',()=>{
  const get=vi.fn(()=>11),raw=body();Object.defineProperty(raw,'billId',{enumerable:true,get});expect(()=>captureRechargePaidNoticeBusiness(raw)).toThrow();expect(get).not.toHaveBeenCalled();
  const convert=vi.fn(()=> 'weixin');expect(()=>captureRechargePaidNoticeBusiness({...body(),payType:{toString:convert}})).toThrow();expect(convert).not.toHaveBeenCalled();
  for(const patch of[{payerOpenid:'fake'},{routineAppId:'wxB'},{sourceDomain:'membership'}])expect(()=>captureRechargePaidNoticeBusiness({...body(),...patch})).toThrow();
 });
 it('routes recharge only to the three buyer delivery channels',()=>{
  const eventKey=rechargePaidNoticeEventKey(11);expect(isOrderNotificationOutboxMessage({action:'processOrderNotificationOutbox',outboxId:7,eventKey})).toBe(true);
  for(const channel of['sms','wechat_official','wechat_routine','wechat_shipping','wecom_robot'])expect(isOrderNotificationDeliveryMessage({action:'processOrderNotificationDelivery',deliveryId:7,eventKey,channel})).toBe(['sms','wechat_official','wechat_routine'].includes(channel));
  for(const key of['recharge.settled:11','membership.pay.success.notice:11','recharge.pay.success.notice:0','recharge.pay.success.notice:01','recharge.pay.success.notice:2147483648'])expect(rechargePaidNoticeSubjectId(key)).toBeNull();
 });
 it('signs independent format9 and rejects account, domain, balance and authority substitutions',()=>{
  const u=unsigned(),raw={...u,signature:rechargeSubscriptionMac(env,'recharge-notice-request',u)},parsed=parseRoutineSubscriptionRechargeRequest(env,raw,scope);expect(parsed).toEqual(raw);expect(Object.isFrozen(parsed.body)).toBe(true);
  for(const patch of[{format:8},{eventKey:'membership.pay.success.notice:11'},{body:{...body(),postBalance:'22.00'}},{selection:{...u.selection,appId:'wx_current_B'}},{selection:{...u.selection,mode:'routine-original'}},{paymentDigest:'6'.repeat(64)}])expect(()=>parseRoutineSubscriptionRechargeRequest(env,{...raw,...patch},scope)).toThrow();
  const wx={...u,body:{...body(),payType:'weixin'},selection:{...u.selection,mode:'routine-original'}};expect(parseRoutineSubscriptionRechargeRequest(env,{...wx,signature:rechargeSubscriptionMac(env,'recharge-notice-request',wx)},scope)).toMatchObject({format:9,body:{payType:'weixin'}});
 });
 it('keeps Ali unique identity separate from original-provider references',()=>{
  expect(captureRechargeSubscriptionFacts(facts())).toEqual(facts());
  for(const patch of[{subjectDomain:'membership'},{templateMark:'1927'},{rootId:12},{payment:{kind:'unique-identity',payType:'weixin',paymentDigest:'4'.repeat(64)}},{payment:{...facts().payment,evidenceId:'fake'}}])expect(()=>captureRechargeSubscriptionFacts({...facts(),...patch})).toThrow();
 });
 it.each(['55P03','57014','40001','40P01'])('recognizes only pre-attempt retry SQL state %s',code=>expect(rechargeSubscriptionTransientSqlState({cause:{code}})).toBe(code));
 it.each(['42501','23514','08006','unknown'])('refuses to classify unknown/authority SQL state %s as safe',code=>expect(rechargeSubscriptionTransientSqlState({cause:{code}})).toBeNull());
 it('preserves old SQL bytes and only closes the finite membership successor family',()=>{
  expect(readFileSync('src/migrations/maintenance/0200_paid_notice.sql','utf8')).toBe(PAID_NOTICE_SQL);expect(readFileSync('src/migrations/maintenance/0201_membership_paid_notice.sql','utf8')).toBe(MEMBERSHIP_PAID_NOTICE_SQL);
  expect(readFileSync('src/migrations/maintenance/0202_recharge_paid_notice.sql','utf8')).toBe(RECHARGE_PAID_NOTICE_SQL);expect(RECHARGE_PAID_NOTICE_SQL).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|GRANT|CREATE\s+(?:ROLE|TABLE))\b/iu);
  expect(RECHARGE_PAID_NOTICE_GENERATIONS).toHaveLength(20);for(const g of RECHARGE_PAID_NOTICE_GENERATIONS){expect(g.recharge).toBe(true);expect(g.membership).toBe(true);expect(g.events.slice(-2)).toEqual(RECHARGE_PAID_EVENTS);expect(paidNoticeEventGeneration(g.definition)).toBe(g);expect(paidNoticeEventGeneration(g.definition+' OR true')).toBeNull();const old=MEMBERSHIP_PAID_NOTICE_GENERATIONS.find(o=>o.virtual===g.virtual&&o.price===g.price&&o.paid===g.paid&&JSON.stringify(o.addons)===JSON.stringify(g.addons))!;expect(normalizePaidNoticeEventDefinition(g.definition)).toBe(normalizePaidNoticeEventDefinition(old.definition));}
 });
});
