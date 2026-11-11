import { describe, expect, it } from 'vitest';
import { purchasedLabelPaymentImage, verifyPurchasedLabelIntent, type PurchasedLabelIntentRow } from '@/services/order/PurchasedProductLabelSource';
import { capturePurchasedLabelIntent } from '@/services/order/PurchasedProductLabelCodec';
import { outRequestHash } from '@/services/out/OutIdempotency';
import type { storeOrderOutbox } from '@/models/schema';
const event = () => ({ id: 1, eventKey: 'order.paid:9', aggregateType: 'order', aggregateId: 9, eventType: 'order.paid',
  payload: { orderId: 9, orderNo: 'ROOT9', payNoticeAdmission: { format: 1, nonce: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } },
  addTime: 1700000000, status: 'PROCESSING', leaseToken: 'lease', leaseUntil: 1, attemptCount: 1 } as typeof storeOrderOutbox.$inferSelect);
const intent = () => capturePurchasedLabelIntent({ format: 1, paymentEventId: 1, paymentOrderId: 9, paymentOrderNo: 'ROOT9', paymentSourceHash: 'a'.repeat(64),
  orderId: 10, orderNo: 'CHILD10', userId: 11, financialStoreId: 0, supplierId: 44, orderType: 0, activityId: 0, totalNum: 1, occurredAt: 1700000000,
  carts: [{ rowId: 20, cartId: 'cart20', productId: 70, productType: 0, ownerType: 2, ownerId: 44, skuUnique: 'sku', quantity: 1, isGift: 0 }] });
const task = async (): Promise<PurchasedLabelIntentRow> => {
  const source = intent();
  return { taskId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', eventKey: 'order.product.labels:9:10', paymentEventId: 1,
    paymentOrderId: 9, orderId: 10, userId: 11, sourceHash: await outRequestHash(source), source, createdAt: source.occurredAt };
};
describe('purchased label immutable payment source and intent scalar fences', () => {
  it('hashes all immutable paid fields including the optional admitted nonce, never mutable delivery state', async () => {
    const e = event(), image = purchasedLabelPaymentImage(e), hash = await outRequestHash(image);
    expect(await outRequestHash(purchasedLabelPaymentImage({ ...e, status: 'COMPLETED', leaseToken: '', leaseUntil: 0, attemptCount: 8 }))).toBe(hash);
    for (const patch of [{ addTime: e.addTime+1 }, { id: 2 }, { payload: { orderId: 9, orderNo: 'ROOT9' } },
      { payload: { ...e.payload, payNoticeAdmission: { format: 1, nonce: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } } }])
      expect(await outRequestHash(purchasedLabelPaymentImage({ ...e, ...patch } as typeof e))).not.toBe(hash);
    expect(image).not.toHaveProperty('leaseToken');
  });
  it('refuses mismatched or open paid root payloads', () => {
    const e = event();
    for (const patch of [{ aggregateId: 10 }, { aggregateType: 'recharge' }, { eventKey: 'order.paid:10' },
      { eventType: 'order.product.labels' }, { payload: { ...e.payload, labels: [1] } }])
      expect(() => purchasedLabelPaymentImage({ ...e, ...patch } as typeof e)).toThrow();
  });
  it('checks the exact typed intent, digest, root/child keys and scalar columns together', async () => {
    const row = await task(); expect(await verifyPurchasedLabelIntent(row)).toEqual(intent());
    for (const patch of [{ eventKey: 'order.product.labels:9:11' }, { paymentOrderId: 10 }, { paymentEventId: 2 }, { userId: 12 },
      { orderId: 11 }, { createdAt: row.createdAt+1 }, { sourceHash: 'b'.repeat(64) }, { source: { ...intent(), totalNum: 2 } }])
      await expect(verifyPurchasedLabelIntent({ ...row, ...patch })).rejects.toThrow();
  });
});
