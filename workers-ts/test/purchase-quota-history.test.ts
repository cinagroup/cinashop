import { describe, expect, it } from 'vitest';
import { assertPresalePurchaseLimit } from '@/services/activity/PresalePurchaseLimits';
import { projectPurchaseQuotaHistory, type PurchaseQuotaHistoryEntry } from '@/services/order/PurchaseQuotaHistory';
import type { PurchaseOriginEvidence } from '@/services/order/PurchaseOriginEvidence';

const buyerId = 11;
function origin(orderId: number, quantity: number, skuId: number, productId = 70): PurchaseOriginEvidence {
  return { version: 'purchase-origin-v1', orderId, buyerId, orderType: orderId === 12 ? 0 : 6,
    totalNum: quantity, usedPoints: 0, lines: [{ rowId: orderId + 100, cartId: String(orderId + 200),
      productId, skuId, skuUnique: `sku${skuId}`, quantity, usedPoints: 0 }] };
}
function root(orderId: number, quantity: number, paid: number, status = 0, isDel = 0) {
  return { id: orderId, uid: buyerId, pid: paid ? -1 : 0, type: orderId === 12 ? 0 : 6,
    paid, status, isDel, totalNum: quantity };
}
function entries(): PurchaseQuotaHistoryEntry[] {
  const active = origin(10, 2, 1), cancelled = origin(11, 1, 2), paid = origin(12, 3, 3);
  return [
    { root: root(10, 2, 0), origin: active, cancellation: null, payment: null },
    { root: root(11, 1, 0, -2, 1), origin: cancelled,
      cancellation: { version: 'purchase-cancellation-v1', origin: cancelled, cancelledAtMillis: 1 }, payment: null },
    { root: root(12, 3, 1), origin: paid, cancellation: null,
      payment: { version: 'purchase-quota-payment-ledger-v1', paymentOrderId: 12, buyerId,
        products: [{ productId: 70, purchased: 3, refunded: 1, pending: 1, remaining: 2 }],
        refundIds: [50], branchIds: [], evidenceRows: 5 } },
  ];
}
describe('read-only quota history classification', () => {
  it('aggregates base products across original roots, SKU identities and order types without granting allowance', () => {
    const input = entries(), before = structuredClone(input);
    const result = projectPurchaseQuotaHistory(input, buyerId);
    expect(result).toEqual({ version: 'purchase-quota-history-v1', buyerId,
      status: 'verified_retained_roots', incomplete: true, reason: 'preactivation_history_unproven',
      verifiedRootCount: 3, products: [{ productId: 70, activeUnpaid: 2, cancelledUnpaid: 1,
        paidPurchased: 3, completedRefund: 1, pendingRefund: 1 }] });
    expect('allowance' in result).toBe(false);
    expect(input).toEqual(before);
    expect(projectPurchaseQuotaHistory([...input].reverse(), buyerId)).toEqual(result);
  });
  it('never presents an unsupported transition as complete or zero purchases', () => {
    const input = entries(); input[0].root.status = -2;
    expect(projectPurchaseQuotaHistory(input, buyerId)).toEqual({ version: 'purchase-quota-history-v1', buyerId,
      status: 'incomplete', incomplete: true, reason: 'unsupported_root_state', products: null });
    expect(projectPurchaseQuotaHistory([], buyerId)).toMatchObject({ incomplete: true,
      reason: 'preactivation_history_unproven', products: [] });
  });
  it.each(['duplicate', 'buyer', 'origin', 'cancel', 'payment', 'quantity'] as const)(
    'rejects contradictory %s evidence', change => {
      const input = entries();
      if (change === 'duplicate') input.push(input[0]);
      if (change === 'buyer') input[0].root.uid = 22;
      if (change === 'origin') input[0].origin.lines[0].quantity = 3;
      if (change === 'cancel') input[1].cancellation!.origin = origin(11, 1, 2, 99);
      if (change === 'payment') input[2].payment!.products[0].purchased = 4;
      if (change === 'quantity') input[2].root.totalNum = 4;
      expect(() => projectPurchaseQuotaHistory(input, buyerId)).toThrow();
    });
  it('keeps cumulative presale admission closed regardless of verified read facts', () => {
    expect(() => assertPresalePurchaseLimit({ mode: 'cumulative', quantity: 5 }, 1))
      .toThrow('累计限购预售暂未开放');
  });
});
