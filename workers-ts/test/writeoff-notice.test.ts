import { describe, expect, it, vi } from 'vitest';
import { captureWriteoffNoticePayload, captureWriteoffRecordIds, writeoffNoticeEventKey,
  writeoffNoticeValues, assertWriteoffSmsPayload, MAX_WRITEOFF_NOTICE_RECORDS } from '@/services/order/OrderWriteoffNoticeCodec';
import { isOrderNotificationOutboxMessage } from '@/services/order/OrderOutboxService';
import { isOrderNotificationDeliveryMessage } from '@/services/order/OrderNotificationDeliveryService';

const payload = () => ({ format: 1, orderId: 8, orderNo: 'owned_writeoff_order', userId: 11,
  occurredAt: Date.UTC(2026, 10, 3, 18, 4, 59) / 1000, recordIds: [7, 9], recordsDigest: 'a'.repeat(64),
  selection: 'explicit', phone: '13800000011', storeName: '实时商品 另一商品' });

describe('writeoff occurrence public payload and SMS-only transport contract', () => {
  it('keeps a batch distinct from an order or timestamp and retains minute rendering after delay', () => {
    const p = captureWriteoffNoticePayload(payload());
    expect(writeoffNoticeEventKey(p.recordIds[0])).toBe('order.writeoff.notice:7');
    expect(writeoffNoticeEventKey(10)).not.toBe(writeoffNoticeEventKey(7));
    expect(writeoffNoticeValues(p)).toEqual({ store_name: '实时商品 另一商品', write_time: '2026-11-04 02:04' });
  });
  it('accepts empty all-items titles and guest recipient identity without inventing a shared buyer', () => {
    const p = captureWriteoffNoticePayload({ ...payload(), selection: 'all', storeName: '', userId: 0, phone: '' });
    expect(writeoffNoticeValues(p)).toEqual({ store_name: '', write_time: '2026-11-04 02:04' });
    expect(p.userId).toBe(0);
  });
  it('copies the record IDs instead of retaining mutable input array identity', () => {
    const input = payload(), p = captureWriteoffNoticePayload(input);
    input.recordIds.push(12);
    expect(p.recordIds).toEqual([7, 9]);
  });
  it.each([
    { format: 2 }, { userId: -1 }, { userId: '11' }, { orderId: 0 }, { orderNo: '' },
    { occurredAt: 0 }, { occurredAt: Number.MAX_SAFE_INTEGER }, { selection: 'remaining' },
    { selection: 'all', storeName: '不能替代空选项标题' }, { phone: ' 13800000011' },
    { phone: 'x'.repeat(33) }, { storeName: 'x'.repeat(5500) }, { recordsDigest: 'A'.repeat(64) },
    { recordIds: [] }, { recordIds: [9, 7] }, { recordIds: [7, 7] }, { recordIds: ['7'] },
    { recordIds: [2147483648] }, { recordIds: [NaN] },
  ])('refuses malformed persisted occurrence facts: %j', patch => {
    expect(() => captureWriteoffNoticePayload({ ...payload(), ...patch })).toThrow();
  });
  it.each(['routineAppId', 'routineSubscriptionRequest', 'payerOpenid', 'unreviewed'])('closes the public field set against %s', key => {
    expect(() => captureWriteoffNoticePayload({ ...payload(), [key]: 'not-notification-authority' })).toThrow();
  });
  it('refuses getters, sparse arrays, inherited wrappers and unpaired UTF16 without evaluating them', () => {
    const read = vi.fn(() => '13800000011'), getter = payload();
    Object.defineProperty(getter, 'phone', { get: read, enumerable: true });
    expect(() => captureWriteoffNoticePayload(getter)).toThrow(); expect(read).not.toHaveBeenCalled();
    expect(() => captureWriteoffNoticePayload({ ...payload(), recordIds: new Array(2) })).toThrow();
    expect(() => captureWriteoffNoticePayload(Object.create(payload()))).toThrow();
    expect(() => captureWriteoffNoticePayload({ ...payload(), storeName: '\ud800' })).toThrow();
  });
  it('bounds every source record without silently slicing a larger batch', () => {
    expect(captureWriteoffRecordIds(Array.from({ length: MAX_WRITEOFF_NOTICE_RECORDS }, (_, i) => i + 1))).toHaveLength(500);
    expect(() => captureWriteoffRecordIds(Array.from({ length: 501 }, (_, i) => i + 1))).toThrow();
  });
  it('allows the full bounded batch SMS title while retaining exactly the PHP two variables', () => {
    const params = { store_name: '😀'.repeat(5499), write_time: '2026-11-04 02:04' };
    expect(() => assertWriteoffSmsPayload({ kind: 'sms', params })).not.toThrow();
    expect(() => assertWriteoffSmsPayload({ kind: 'sms', params: { ...params, store_name: '😀'.repeat(5500) } })).toThrow();
    expect(() => assertWriteoffSmsPayload({ kind: 'sms', params: { ...params, uid: '11' } })).toThrow();
    expect(() => assertWriteoffSmsPayload({ kind: 'sms', params: { ...params, write_time: 'later' } })).toThrow();
    expect(() => assertWriteoffSmsPayload({ kind: 'wechat_routine', params })).toThrow();
  });
  it('routes actual batch keys through the existing Outbox and only the SMS delivery channel', () => {
    expect(isOrderNotificationOutboxMessage({ action: 'processOrderNotificationOutbox', outboxId: 8, eventKey: 'order.writeoff.notice:7' })).toBe(true);
    for (const channel of ['sms', 'wechat_routine', 'wechat_official', 'wechat_shipping', 'wecom_robot']) {
      expect(isOrderNotificationDeliveryMessage({ action: 'processOrderNotificationDelivery', deliveryId: 8,
        eventKey: 'order.writeoff.notice:7', channel })).toBe(channel === 'sms');
    }
    for (const eventKey of ['order.writeoff.notice:0', 'order.writeoff.notice:7:8', 'order.writeoff.notice:7.5', 'order.writeoff.notice:-7']) {
      expect(isOrderNotificationOutboxMessage({ action: 'processOrderNotificationOutbox', outboxId: 8, eventKey })).toBe(false);
      expect(isOrderNotificationDeliveryMessage({ action: 'processOrderNotificationDelivery', deliveryId: 8, eventKey, channel: 'sms' })).toBe(false);
    }
    expect(isOrderNotificationDeliveryMessage({ action: 'processOrderNotificationDelivery', deliveryId: 8,
      eventKey: 'order.refund.success.notice:7', channel: 'wechat_routine' })).toBe(true);
  });
});
