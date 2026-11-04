import { readFileSync } from 'node:fs';
import { describe,expect,it,vi } from 'vitest';
import { captureMembershipPaidNoticeBusiness, membershipPaidNoticeBusinessFromPayload, membershipPaidNoticeEventKey,
  membershipPaidNoticeSubjectId } from '@/services/order/MembershipPaidNoticeCodec';
import { MEMBERSHIP_PAID_NOTICE_SQL } from '@/migrations/membershipPaidNotice';
import { PAID_NOTICE_GENERATIONS,MEMBERSHIP_PAID_NOTICE_GENERATIONS,PAID_NOTICE_SQL,paidNoticeEventGeneration,
  normalizePaidNoticeEventDefinition } from '@/migrations/paidNotice';
import { MEMBERSHIP_PAID_EVENTS } from '@/migrations/membershipPaidNoticeContract';
import { isOrderNotificationOutboxMessage } from '@/services/order/OrderOutboxService';
import { isOrderNotificationDeliveryMessage } from '@/services/order/OrderNotificationDeliveryService';
const body=()=>({format:1,domain:'membership',settlementNonce:'f78e2645-b266-44a0-8be6-a015ca94b110',orderId:11,orderNo:'hy_membership_owned',userId:22,
  kind:'free-claim',memberType:'31',vipDay:7,isPermanent:0,overdueTime:1900604800,payType:'yue',payPrice:'0.00',payTime:1900000000,
  tradeNo:'',phone:'13800000022',sendName:'会员$买家',storeName:'免费领取会员卡',occurredAt:1900000001});
describe('closed real membership settlement notice contract',()=>{
  it('keeps free and priced variants independent of merchandise IDs and current plans',()=>{
    expect(captureMembershipPaidNoticeBusiness(body())).toEqual(body());
    const paid={...body(),kind:'paid-membership',payPrice:'10.00',storeName:'购买会员卡'};
    expect(captureMembershipPaidNoticeBusiness(paid)).toEqual(paid);
    const permanent={...paid,isPermanent:1,vipDay:0,overdueTime:-1};
    expect(captureMembershipPaidNoticeBusiness(permanent)).toEqual(permanent);
    expect(captureMembershipPaidNoticeBusiness({...paid,payType:'weixin',tradeNo:'real_membership_trade'})).toMatchObject({domain:'membership'});
    expect(membershipPaidNoticeEventKey(11)).toBe('membership.pay.success.notice:11');
    expect(membershipPaidNoticeBusinessFromPayload({...body(),routineSubscriptionRequest:{format:8,unavailable:true}})).toEqual(body());
  });
  it.each([{domain:'store_order'},{kind:'card-redeem'},{kind:'paid-membership'},{payType:'weixin'},{payType:'alipay'},
    {payPrice:'00.00'},{payPrice:'-1.00'},{payPrice:'0'},{payPrice:'1.00'},{isPermanent:1},{isPermanent:'0'},
    {overdueTime:-1},{overdueTime:1900000000},{vipDay:0},{tradeNo:'invented_provider'},
    {settlementNonce:'f78e2645-b266-14a0-8be6-a015ca94b110'},{orderId:2147483648},{userId:0},
    {occurredAt:1899999999},{phone:' 13800000022'},{sendName:'\ud800'},{storeName:'购买会员卡'}])('refuses invalid or cross-domain facts %j',patch=>{
    expect(()=>captureMembershipPaidNoticeBusiness({...body(),...patch})).toThrow();
  });
  it('rejects getters, inherited facts, unknown fields and target/account authority',()=>{
    const input=body(),read=vi.fn(()=>11);Object.defineProperty(input,'orderId',{get:read,enumerable:true});
    expect(()=>captureMembershipPaidNoticeBusiness(input)).toThrow();expect(read).not.toHaveBeenCalled();
    expect(()=>captureMembershipPaidNoticeBusiness(Object.create(body()))).toThrow();
    const conversion=vi.fn(()=>0),active={valueOf:conversion,toString:conversion};
    for(const key of ['isPermanent','payType'])expect(()=>captureMembershipPaidNoticeBusiness({...body(),[key]:active})).toThrow();
    expect(conversion).not.toHaveBeenCalled();
    for(const key of ['payerOpenid','routineAppId','unreviewed'])expect(()=>captureMembershipPaidNoticeBusiness({...body(),[key]:'cannot-authorize'})).toThrow();
  });
  it('routes only the three buyer channels under the membership namespace',()=>{
    const eventKey=membershipPaidNoticeEventKey(11);
    expect(isOrderNotificationOutboxMessage({action:'processOrderNotificationOutbox',outboxId:7,eventKey})).toBe(true);
    for(const channel of ['sms','wechat_official','wechat_routine','wechat_shipping','wecom_robot'])
      expect(isOrderNotificationDeliveryMessage({action:'processOrderNotificationDelivery',deliveryId:7,eventKey,channel}))
        .toBe(['sms','wechat_official','wechat_routine'].includes(channel));
    for(const value of ['membership.pay.success.notice:0','membership.pay.success.notice:01','membership.pay.success.notice:2147483648',
      'membership.settled:11','order.pay.success.notice:11','membership.paid.shipping:11'])expect(membershipPaidNoticeSubjectId(value)).toBeNull();
    for(const value of ['membership.pay.success.notice:0','membership.pay.success.notice:01','membership.pay.success.notice:2147483648']){
      expect(isOrderNotificationOutboxMessage({action:'processOrderNotificationOutbox',outboxId:7,eventKey:value})).toBe(false);
      expect(isOrderNotificationDeliveryMessage({action:'processOrderNotificationDelivery',deliveryId:7,eventKey:value,channel:'sms'})).toBe(false);
    }
  });
  it('renders the paired standalone artifact without changing historical SQL',()=>{
    expect(readFileSync('src/migrations/maintenance/0201_membership_paid_notice.sql','utf8')).toBe(MEMBERSHIP_PAID_NOTICE_SQL);
    expect(readFileSync('src/migrations/maintenance/0200_paid_notice.sql','utf8')).toBe(PAID_NOTICE_SQL);
    expect(MEMBERSHIP_PAID_NOTICE_SQL).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|GRANT|CREATE\s+(?:ROLE|TABLE))\b/iu);
    expect(MEMBERSHIP_PAID_NOTICE_SQL).toContain('ACCESS EXCLUSIVE MODE NOWAIT');
  });
  it('accepts only twenty explicit virtual predecessors plus their exact member tails',()=>{
    expect(PAID_NOTICE_GENERATIONS).toHaveLength(40);expect(MEMBERSHIP_PAID_NOTICE_GENERATIONS).toHaveLength(20);
    for(const g of MEMBERSHIP_PAID_NOTICE_GENERATIONS){
      expect(g.virtual).toBe(true);expect(g.membership).toBe(true);expect(g.events.slice(-2)).toEqual(MEMBERSHIP_PAID_EVENTS);
      expect(paidNoticeEventGeneration(g.definition)).toBe(g);
      expect(normalizePaidNoticeEventDefinition(g.definition)).toBe(normalizePaidNoticeEventDefinition(
        PAID_NOTICE_GENERATIONS.find(old=>old.virtual===g.virtual&&old.price===g.price&&old.paid===g.paid&&JSON.stringify(old.addons)===JSON.stringify(g.addons))!.definition));
      expect(paidNoticeEventGeneration(g.definition+' OR true')).toBeNull();
    }
  });
});
