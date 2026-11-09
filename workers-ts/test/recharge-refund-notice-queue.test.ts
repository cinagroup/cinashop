import{describe,expect,it}from'vitest';
import{captureRechargeRefundNoticeMessage as message,captureRechargeRefundNoticeDispatch as dispatch,createRechargeRefundNoticeRoot,isRechargeRefundNoticeMessage,isRechargeRefundNoticeDispatch}from'@/services/payment/RechargeRefundNoticeQueue';
import{isOrderNotificationDeliveryMessage}from'@/services/order/OrderNotificationDeliveryService';
import{prepareOrderQueueDeadLetter}from'@/services/order/OrderQueueDeadLetterService';
const key='recharge.refund.success.notice:00000000-0000-4000-8000-000000000001',m={action:'processRechargeRefundNotice',outboxId:1,eventKey:key};
describe('address-only refund notice Queue contracts',()=>{
 it('accepts only bounded immutable addresses and a root scanner',()=>{expect(message(m)).toEqual(m);expect(isRechargeRefundNoticeMessage(m)).toBe(true);expect(Object.isFrozen(message(m))).toBe(true);const root=createRechargeRefundNoticeRoot();expect(dispatch(root)).toEqual({action:'dispatchRechargeRefundNotices',afterId:0,cutoff:null});expect(isRechargeRefundNoticeDispatch(root)).toBe(true);expect(dispatch({...root,afterId:20,cutoff:1900000000})).toMatchObject({afterId:20});});
 it.each([{outboxId:0},{outboxId:2147483648},{eventKey:'recharge.refund.success.notice:17'},{eventKey:key.toUpperCase()},{payload:{kind:'trusted'}},{action:'processOrderOutbox'}])('rejects forged message %j',patch=>{expect(()=>message({...m,...patch})).toThrow();expect(isRechargeRefundNoticeMessage({...m,...patch})).toBe(false);});
 it.each([{afterId:-1},{cutoff:0},{cutoff:2147483648},{cutoff:NaN},{eventKey:key}])('rejects forged scanner %j',patch=>{expect(()=>dispatch({...createRechargeRefundNoticeRoot(),...patch})).toThrow();});
 it('does not evaluate caller accessors',()=>{let reads=0;const raw={...m};Object.defineProperty(raw,'eventKey',{enumerable:true,get(){reads++;return key;}});expect(()=>message(raw)).toThrow();expect(reads).toBe(0);});
 it('archives and replays only the validated address in the dead-letter owner',()=>{for(const raw of[m,createRechargeRefundNoticeRoot()]){const p=prepareOrderQueueDeadLetter(raw);expect(p.replayPolicy).toBe('ALLOW');expect(p.replayMessage).toEqual(raw);expect(p.body).toEqual(raw);}expect(prepareOrderQueueDeadLetter({...m,token:'invented'}).replayPolicy).not.toBe('ALLOW');});
 it.each(['sms','wechat_routine'])('allows %s address through actual generic delivery routing',channel=>{expect(isOrderNotificationDeliveryMessage({action:'processOrderNotificationDelivery',deliveryId:1,eventKey:key,channel})).toBe(true);});
 it.each(['wechat_official','station','unknown'])('refuses unsupported %s channel for the refund UUID key',channel=>{expect(isOrderNotificationDeliveryMessage({action:'processOrderNotificationDelivery',deliveryId:1,eventKey:key,channel})).toBe(false);});
});
