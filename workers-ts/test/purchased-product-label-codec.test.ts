import { describe, expect, it } from 'vitest';
import { capturePurchasedLabelIntent, purchasedLabelIds,
  purchasedProductLabelEventIdentity, purchasedProductLabelEventKey } from '../src/services/order/PurchasedProductLabelCodec';

const sourceHash = 'a'.repeat(64);
const cart = () => ({ rowId: 1, cartId: 'cart-1', productId: 70, productType: 0,
  ownerType: 0, ownerId: 0, skuUnique: 'sku-1', quantity: 2, isGift: 0 });
const intent = () => ({ format: 1, paymentEventId: 7, paymentOrderId: 9, paymentOrderNo: 'PAID-ROOT',
  paymentSourceHash: sourceHash, orderId: 9, orderNo: 'PAID-ROOT', userId: 11,
  financialStoreId: 0, supplierId: 0, orderType: 0, activityId: 0, totalNum: 2, occurredAt: 0, carts: [cart()] });

describe('purchased product label task identity', () => {
  it('captures detached immutable identities while leaving current product label selections out of the intent', () => {
    const raw = intent(), captured = capturePurchasedLabelIntent(raw);
    expect(captured).toEqual(raw); raw.carts[0].productId = 99; raw.carts.push(cart());
    expect(captured.carts).toHaveLength(1); expect(captured.carts[0].productId).toBe(70);
    expect(Object.isFrozen(captured)).toBe(true); expect(Object.isFrozen(captured.carts)).toBe(true);
    expect(Object.isFrozen(captured.carts[0])).toBe(true); expect(captured).not.toHaveProperty('labelIds');
  });
  it('retains platform, actual financial store, supplier and legacy supplier ownership without replacing it with a fulfillment target', () => {
    for (const [ownerType, ownerId, financialStoreId, supplierId] of [[0, 0, 0, 0], [1, 5, 5, 0], [2, 44, 0, 44], [0, 44, 0, 44], [1, 5, 0, 0]]) {
      const raw = { ...intent(), financialStoreId, supplierId, carts: [{ ...cart(), ownerType, ownerId }] };
      expect(capturePurchasedLabelIntent(raw)).toEqual(raw);
    }
    expect(() => capturePurchasedLabelIntent({ ...intent(), fulfillmentStoreId: 5 })).toThrow();
  });
  it('accepts all smallint business/product kinds, gift lines, old empty SKU evidence and actual 255-character SKU columns', () => {
    const raw = { ...intent(), orderType: 5, activityId: 90, totalNum: 3, carts: [cart(),
      { ...cart(), rowId: 2, cartId: 'gift-2', quantity: 1, isGift: 1, productType: 32767, skuUnique: '' }] };
    expect(capturePurchasedLabelIntent(raw)).toEqual(raw);
    expect(capturePurchasedLabelIntent({ ...intent(), carts: [{ ...cart(), skuUnique: 'x'.repeat(255) }] }).carts[0].skuUnique).toHaveLength(255);
    expect(() => capturePurchasedLabelIntent({ ...intent(), carts: [{ ...cart(), skuUnique: 'x'.repeat(256) }] })).toThrow();
  });
  it('checks root and child order identities rather than inventing a different payment root', () => {
    expect(capturePurchasedLabelIntent({ ...intent(), orderId: 10, orderNo: 'PAID-CHILD' }).orderId).toBe(10);
    for (const extra of [{ orderId: 10 }, { orderNo: 'OTHER' }, { paymentOrderId: 0 }, { userId: 0 },
      { financialStoreId: -1 }, { orderType: 32768 }, { totalNum: 1 }, { occurredAt: -1 }, { paymentSourceHash: '' }])
      expect(() => capturePurchasedLabelIntent({ ...intent(), ...extra })).toThrow();
  });
  it('rejects extra, missing, inherited, symbolic and accessor fields without evaluating a supplied getter', () => {
    let read = false;
    const accessor = Object.defineProperty({ ...intent() }, 'userId', { enumerable: true, get() { read = true; return 11; } });
    for (const raw of [{ ...intent(), labelIds: [9] }, { ...intent(), [Symbol('extra')]: 1 },
      Object.assign(Object.create({ inherited: true }), intent()), accessor,
      { ...intent(), carts: [{ ...cart(), extra: 1 }] }]) expect(() => capturePurchasedLabelIntent(raw)).toThrow();
    const missing: Partial<ReturnType<typeof intent>> = intent(); delete missing.userId;
    expect(() => capturePurchasedLabelIntent(missing)).toThrow(); expect(read).toBe(false);
  });
  it('refuses sparse, augmented, accessor, duplicate and oversized cart sets without truncation', () => {
    const sparse = [cart(), , cart()], extra = Object.assign([cart()], { extra: true });
    let read = false; const accessor = [cart()];
    Object.defineProperty(accessor, '0', { enumerable: true, get() { read = true; return cart(); } });
    const duplicateRow = [cart(), { ...cart(), cartId: 'different' }], duplicateCart = [cart(), { ...cart(), rowId: 2 }];
    const large = Array.from({ length: 201 }, (_, i) => ({ ...cart(), rowId: i + 1, cartId: String(i) }));
    for (const carts of [[], sparse, extra, accessor, duplicateRow, duplicateCart, large])
      expect(() => capturePurchasedLabelIntent({ ...intent(), carts })).toThrow();
    expect(read).toBe(false);
  });
  it('bounds the complete UTF8 task instead of accepting 200 individually valid oversized rows', () => {
    const carts = Array.from({ length: 200 }, (_, i) => ({ ...cart(), rowId: i + 1, cartId: String(i), skuUnique: '汉'.repeat(255) }));
    expect(() => capturePurchasedLabelIntent({ ...intent(), totalNum: 400, carts })).toThrow();
    expect(capturePurchasedLabelIntent({ ...intent(), totalNum: 400, carts: carts.map(row => ({ ...row, skuUnique: 'old' })) }).carts).toHaveLength(200);
  });
  it('requires a closed version and exact canonical payment-source digest without treating a hash as authority', () => {
    for (const raw of [{ ...intent(), format: 2 }, { ...intent(), signature: 'x' },
      { ...intent(), paymentSourceHash: 'A'.repeat(64) }, { ...intent(), paymentSourceHash: 'a'.repeat(63) }])
      expect(() => capturePurchasedLabelIntent(raw)).toThrow();
  });
  it('uses canonical independent root/fulfillment keys with bounded integer identities', () => {
    expect(purchasedProductLabelEventKey(9, 10)).toBe('order.product.labels:9:10');
    expect(purchasedProductLabelEventIdentity('order.product.labels:9:10')).toEqual({ paymentOrderId: 9, orderId: 10 });
    for (const value of ['order.product.labels:09:10', 'order.product.labels:9:0', 'order.product.labels:9:2147483648',
      'order.product.labels:9:10:extra', 'order.paid:9', 9]) expect(purchasedProductLabelEventIdentity(value)).toBeNull();
    expect(() => purchasedProductLabelEventKey(0, 9)).toThrow();
  });
  it('preserves legacy empty/zero sentinels and deduplicates valid product and bundle label IDs', () => {
    expect(purchasedLabelIds(null)).toEqual([]); expect(purchasedLabelIds('')).toEqual([]);
    expect(purchasedLabelIds('32,0,,31,32')).toEqual([31, 32]);
    for (const raw of [undefined, [31], '01', ' 31', '31.0', '-1', '2147483648', 'x'.repeat(256)])
      expect(() => purchasedLabelIds(raw)).toThrow('维护');
  });
});
