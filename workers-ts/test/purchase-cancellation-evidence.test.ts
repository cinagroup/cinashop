import { describe, expect, it } from 'vitest';
import { verifyPurchaseCancellationEvidence } from '@/services/order/PurchaseCancellationEvidence';

const scope = { orderId: 12, buyerId: 11 };
const value = () => ({ version: 'purchase-cancellation-v1', ...scope, orderType: 6, totalNum: 3, restoredPoints: 50,
  cancelledAtMillis: 1700000000000,
  lines: [{ rowId: 21, cartId: '1', productId: 70, skuId: 31, skuUnique: 'sku1', quantity: 1, usedPoints: 50 },
    { rowId: 22, cartId: '2', productId: 70, skuId: 32, skuUnique: 'sku2', quantity: 2, usedPoints: 0 }] });
describe('cancellation receipt bounded projection', () => {
  it('retains original SKU quantities/points without asserting quota release', () => {
    const receipt = verifyPurchaseCancellationEvidence(value(), scope);
    expect(receipt).toEqual({ version: 'purchase-cancellation-v1', cancelledAtMillis: 1700000000000,
      origin: { version: 'purchase-origin-v1', ...scope, orderType: 6, totalNum: 3, usedPoints: 50, lines: value().lines } });
    expect(Object.keys(receipt).sort()).toEqual(['cancelledAtMillis', 'origin', 'version']);
  });
  it.each([null, [], true, 1, 'cancelled'])('rejects non-record %j', input => {
    expect(() => verifyPurchaseCancellationEvidence(input, scope)).toThrow();
  });
  it.each([{ version: 'unknown' }, { orderId: 13 }, { buyerId: 22 }, { orderType: 9 }, { totalNum: 2 },
    { restoredPoints: 49 }, { restoredPoints: '50' }, { cancelledAtMillis: 0 }, { cancelledAtMillis: -1 },
    { cancelledAtMillis: 1.5 }, { cancelledAtMillis: '1700000000000' }, { cancelledAtMillis: Infinity },
    { cancelledAtMillis: Number.MAX_SAFE_INTEGER + 1 }, { lines: [] }, { lines: null }])('rejects drift %j', patch => {
    expect(() => verifyPurchaseCancellationEvidence({ ...value(), ...patch }, scope)).toThrow();
  });
  it('rejects inconsistent line quantity and unexpected private line fields', () => {
    const row = value(); row.lines[0].quantity++;
    expect(() => verifyPurchaseCancellationEvidence(row, scope)).toThrow();
    expect(() => verifyPurchaseCancellationEvidence({ ...value(), lines: value().lines.map(line => ({ ...line, phone: 'not-retained' })) }, scope)).toThrow();
  });
  it('retains guest zero only as an identity, not as a named-member quota', () => {
    expect(verifyPurchaseCancellationEvidence({ ...value(), buyerId: 0 }, { ...scope, buyerId: 0 }).origin.buyerId).toBe(0);
  });
});
