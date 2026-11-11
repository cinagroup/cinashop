import { describe, expect, it } from 'vitest';
import { capturePurchasedLabelIntent } from '@/services/order/PurchasedProductLabelCodec';
import { capturePurchasedLabelResult } from '@/services/order/PurchasedProductLabelResult';
const taskId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sourceHash = 'a'.repeat(64);
const intent = capturePurchasedLabelIntent({ format: 1, paymentEventId: 1, paymentOrderId: 9, paymentOrderNo: 'root9', paymentSourceHash: 'b'.repeat(64),
  orderId: 10, orderNo: 'child10', userId: 11, financialStoreId: 5, supplierId: 44, orderType: 5, activityId: 3, totalNum: 2, occurredAt: 1700000000,
  carts: [{ rowId: 20, cartId: 'cart20', productId: 70, productType: 0, ownerType: 2, ownerId: 44, skuUnique: '', quantity: 2, isGift: 0 }] });
const receipt = () => ({ format: 1, taskId, sourceHash, userId: 11, financialStoreId: 5,
  products: [{ productId: 70, found: true, labelIds: '31,32,33,34' }], bundle: { activityId: 3, found: true, linkIds: '31,35' },
  targets: [{ labelId: 31, type: 0, relationId: 0, added: false }, { labelId: 32, type: 1, relationId: 5, added: true },
    { labelId: 35, type: 0, relationId: 0, added: true }], skipped: [{ labelId: 33, reason: 'retired' }, { labelId: 34, reason: 'missing' }], completedAt: 1700000001 });
const capture = (value: unknown, source = intent) => capturePurchasedLabelResult(value, source, taskId, sourceHash);
describe('purchased label closed success receipt', () => {
  it('captures the actual evaluated configs, original source and approved distinct scopes without aliases', () => {
    const input = receipt(), result = capture(input);
    input.products[0]!.labelIds = '99'; input.targets[0]!.added = true;
    expect(result.products[0]?.labelIds).toBe('31,32,33,34'); expect(result.targets[0]?.added).toBe(false);
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.products[0])).toBe(true);
    expect(Object.isFrozen(result.targets)).toBe(true);
  });
  it('requires complete, unique config coverage and all requested labels classified once', () => {
    const r = receipt();
    for (const bad of [{ ...r, products: [] }, { ...r, products: [r.products[0], r.products[0]] },
      { ...r, targets: r.targets.slice(1) }, { ...r, skipped: [] }, { ...r, skipped: [...r.skipped, { labelId: 31, reason: 'missing' }] },
      { ...r, targets: [...r.targets, { labelId: 99, type: 0, relationId: 0, added: true }] },
      { ...r, bundle: null }, { ...r, bundle: { ...r.bundle, activityId: 9 } }]) expect(() => capture(bad)).toThrow();
  });
  it('rejects foreign stores, identity changes, ambiguous order, versions and extra fields', () => {
    const r = receipt();
    for (const bad of [{ ...r, targets: [r.targets[0], { ...r.targets[1], relationId: 6 }, r.targets[2]] },
      { ...r, taskId: 'not-uuid' }, { ...r, sourceHash: 'b'.repeat(64) }, { ...r, userId: 99 },
      { ...r, financialStoreId: 6 }, { ...r, format: 2 }, { ...r, completedAt: 0 }, { ...r, extra: true },
      { ...r, targets: [...r.targets].reverse() }]) expect(() => capture(bad)).toThrow();
  });
  it('records physically missing config rows and genuine no-op occurrences', () => {
    const r = receipt();
    expect(capture({ ...r, products: [{ productId: 70, found: false, labelIds: null }], bundle: { activityId: 3, found: false, linkIds: null }, targets: [], skipped: [] }).targets).toEqual([]);
    expect(() => capture({ ...r, products: [{ productId: 70, found: false, labelIds: '31' }] })).toThrow();
    const source = capturePurchasedLabelIntent({ ...intent, orderType: 0, activityId: 0 });
    expect(capture({ ...r, products: [{ productId: 70, found: true, labelIds: '0,,' }], bundle: null, targets: [], skipped: [] }, source).targets).toEqual([]);
  });
  it('never invokes receipt accessors or coercion hooks', () => {
    let calls = 0; const r = receipt();
    expect(() => capture({ ...r, get completedAt() { calls++; return 1700000001; } })).toThrow();
    expect(() => capture({ ...r, skipped: [{ labelId: 33, reason: { toString() { calls++; return 'retired'; } } }, r.skipped[1]] })).toThrow();
    expect(() => capture({ ...r, products: [{ ...r.products[0], get labelIds() { calls++; return '31'; } }] })).toThrow();
    expect(calls).toBe(0);
    expect(() => capture({ ...r, targets: Array(3) })).toThrow();
  });
});
