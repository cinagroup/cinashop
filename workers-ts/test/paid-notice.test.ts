import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { DbClient } from '@/lib/di';
import { capturePaidNoticeAdmission, capturePaidNoticeBusiness, captureOrderPaidSourcePayload, isOrderPaidSourcePayload, paidNoticeBusinessFromPayload, paidNoticeDate, paidNoticeEventKey } from '@/services/order/OrderPaidNoticeCodec';
import { PAID_NOTICE_EVENT, PAID_NOTICE_GENERATIONS, PAID_NOTICE_SQL, PAID_NOTICE_CATALOG_SQL, paidNoticeCommissionedTx,
  paidNoticeEventGeneration, normalizePaidNoticeEventDefinition } from '@/migrations/paidNotice';
import { WRITEOFF_NOTICE_EVENT_GENERATIONS, WRITEOFF_NOTICE_CATALOG_SQL, writeoffNoticeCommissionedTx } from '@/migrations/writeoffNotice';
import { refundSuccessNoticeCommissionedTx } from '@/migrations/refundSuccessNotice';
import { isOrderNotificationOutboxMessage } from '@/services/order/OrderOutboxService';
import { isOrderNotificationDeliveryMessage } from '@/services/order/OrderNotificationDeliveryService';
const nonce='11111111-2222-4333-8444-555555555555';
const body=()=>({format:1,paymentEventId:7,paymentOrderId:9,paymentOrderNo:'paid_root',paymentAdmissionNonce:nonce,
  orderId:10,orderNo:'paid_child',userId:11,payPrice:'7.00',totalNum:2,phone:'13800000011',storeName:'😀实付商品|第二商品',sendName:'付款买家',
  payTime:1793693100,occurredAt:1793693162});
const query=(rows:unknown[])=>({execute:vi.fn(async()=>rows)}) as unknown as Pick<DbClient,'execute'>;
describe('ordinary paid buyer occurrence public codec and exact commissioning',()=>{
  it('copies the exact fulfillment occurrence, root source and admission without account authority',()=>{
    const input=body(),p=capturePaidNoticeBusiness(input);input.orderNo='changed';
    expect(p.orderNo).toBe('paid_child');expect(paidNoticeEventKey(p.orderId)).toBe('order.pay.success.notice:10');
    expect(capturePaidNoticeAdmission({format:1,nonce})).toEqual({format:1,nonce});
    expect(paidNoticeDate(Date.UTC(2026,10,3,18,4,59)/1000)).toBe('2026-11-04 02:04:59');
    expect(paidNoticeBusinessFromPayload({...body(),routineSubscriptionRequest:{format:7,unavailable:true}})).toEqual(body());
  });
  it.each([{format:2},{paymentEventId:0},{paymentOrderId:'9'},{paymentOrderNo:''},{paymentAdmissionNonce:nonce.slice(0,-1)+'A'},
    {orderId:2147483648},{userId:-1},{payPrice:'7'},{payPrice:'-1.00'},{payPrice:'00.00'},{payPrice:'10000000000.00'},
    {totalNum:0},{payTime:0},{occurredAt:NaN},{phone:' x'},{storeName:'x'.repeat(21)},{sendName:'x'.repeat(33)},{storeName:'\ud800'}])('refuses malformed public payment facts %j',patch=>{
      expect(()=>capturePaidNoticeBusiness({...body(),...patch})).toThrow();
    });
  it('keeps guest and zero amount explicit, and rejects unknown fields/getters without reading them',()=>{
    expect(capturePaidNoticeBusiness({...body(),userId:0,payPrice:'0.00',phone:''})).toMatchObject({userId:0,payPrice:'0.00'});
    expect(()=>capturePaidNoticeBusiness({...body(),routineAppId:'current-config-is-not-source'})).toThrow();
    expect(()=>paidNoticeBusinessFromPayload({...body(),unreviewed:true})).toThrow();
    const read=vi.fn(()=>nonce),p=body();Object.defineProperty(p,'paymentAdmissionNonce',{get:read,enumerable:true});
    expect(()=>capturePaidNoticeBusiness(p)).toThrow();expect(read).not.toHaveBeenCalled();
    expect(()=>capturePaidNoticeAdmission({format:1,nonce,originalPayment:true})).toThrow();
  });
  it('has only buyer transport channels and a separate fulfillment occurrence key',()=>{
    expect(isOrderNotificationOutboxMessage({action:'processOrderNotificationOutbox',outboxId:4,eventKey:paidNoticeEventKey(10)})).toBe(true);
    for(const channel of ['sms','wechat_official','wechat_routine','wechat_shipping','wecom_robot'])
      expect(isOrderNotificationDeliveryMessage({action:'processOrderNotificationDelivery',deliveryId:3,eventKey:paidNoticeEventKey(10),channel})).toBe(['sms','wechat_official','wechat_routine'].includes(channel));
    for(const key of ['order.pay.success.notice:0','order.pay.success.notice:2:3','order.pay.success.notice:-1'])
      expect(isOrderNotificationOutboxMessage({action:'processOrderNotificationOutbox',outboxId:4,eventKey:key})).toBe(false);
  });
  it('accepts only exact historical or admitted paid payloads for existing shipping/writeoff/manual-refund/gift readers',()=>{
    const old={orderId:9,orderNo:'paid_root'},admitted={...old,payNoticeAdmission:{format:1,nonce}};
    expect(captureOrderPaidSourcePayload(old)).toEqual(old);expect(captureOrderPaidSourcePayload(admitted)).toEqual(admitted);
    for(const malformed of [{...old,unreviewed:true},{...admitted,payNoticeAdmission:{format:1,nonce:'bad'}},
      {...admitted,payNoticeAdmission:{format:1,nonce,account:true}},{...old,orderId:'9'}])expect(isOrderPaidSourcePayload(malformed)).toBe(false);
  });
  it('adds exactly one explicit tail to the twenty historical independent addon families',()=>{
    expect(PAID_NOTICE_GENERATIONS).toHaveLength(40);expect(new Set(PAID_NOTICE_GENERATIONS.map(g=>g.definition)).size).toBe(40);
    expect(PAID_NOTICE_GENERATIONS.filter(g=>!g.paid).map(g=>g.definition)).toEqual(WRITEOFF_NOTICE_EVENT_GENERATIONS.map(g=>g.definition));
    expect(PAID_NOTICE_CATALOG_SQL).toBe(WRITEOFF_NOTICE_CATALOG_SQL);
    for(const g of PAID_NOTICE_GENERATIONS){
      expect(paidNoticeEventGeneration(g.definition)).toBe(g);
      expect(new Set(g.events).size).toBe(g.events.length);
      expect(g.events.includes(PAID_NOTICE_EVENT)).toBe(g.paid);
      if(g.paid)expect(WRITEOFF_NOTICE_EVENT_GENERATIONS.map(g=>g.definition)).toContain(normalizePaidNoticeEventDefinition(g.definition));
    }
  });
  it.each(PAID_NOTICE_GENERATIONS)('keeps paid, writeoff and refund commissioning independent: $price/$virtual/$addons/$paid',async g=>{
    const db=query([{definition:g.definition,safe:true}]);
    expect(await paidNoticeCommissionedTx(db)).toBe(g.paid);
    expect(await writeoffNoticeCommissionedTx(db)).toBe(g.addons.includes('order.writeoff.notice'));
    expect(await refundSuccessNoticeCommissionedTx(db)).toBe(g.addons.includes('order.refund.success.notice'));
  });
  it('keeps absent and pre0200 input inactive, but rejects unknown or unsafe paid activation',async()=>{
    expect(await paidNoticeCommissionedTx(query([]))).toBe(false);
    const g=PAID_NOTICE_GENERATIONS.find(g=>g.paid)!;
    for(const rows of [[{definition:g.definition,safe:false}],[{definition:g.definition+' OR true',safe:true}],
      [{definition:g.definition,safe:true},{definition:g.definition,safe:true}]])await expect(paidNoticeCommissionedTx(query(rows))).rejects.toMatchObject({httpStatus:503});
    expect(normalizePaidNoticeEventDefinition(g.definition+' OR true')).toBe(g.definition+' OR true');
  });
  it('renders exact explicit owner-only bounded maintenance without business DML or grants',()=>{
    expect(readFileSync('src/migrations/maintenance/0200_paid_notice.sql','utf8')).toBe(PAID_NOTICE_SQL);
    expect(PAID_NOTICE_SQL).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|GRANT|CREATE\s+(?:ROLE|TABLE))\b/iu);
    expect(PAID_NOTICE_SQL).toContain('ACCESS EXCLUSIVE MODE NOWAIT');expect(PAID_NOTICE_SQL).toContain('LIMIT 10001');
  });
});
