import { describe, expect, it } from 'vitest';
import { verifyPurchasePhysicalOriginEvidence, type PurchasePhysicalOriginEvidence } from '@/services/order/PurchasePhysicalOriginEvidence';
import type { PurchaseOriginEvidence } from '@/services/order/PurchaseOriginEvidence';
import { projectPurchaseQuotaHistory, type PurchaseQuotaHistoryEntry } from '@/services/order/PurchaseQuotaHistory';
import { verifyPurchaseQuotaRootOrigin } from '@/services/order/PurchaseQuotaPaymentLedger';

const charged: PurchaseOriginEvidence = { version: 'purchase-origin-v1', orderId: 10, buyerId: 11,
  orderType: 0, totalNum: 2, usedPoints: 10, lines: [{ rowId: 1, cartId: '20', productId: 70,
    skuId: 71, skuUnique: 'paid0071', quantity: 2, usedPoints: 10 }] };
function physical(): PurchasePhysicalOriginEvidence {
  return { version: 'purchase-physical-origin-v1', orderId: 10, buyerId: 11, orderType: 0, totalNum: 4,
    lines: [{ ...charged.lines[0], kind: 'charged', gift: null },
      { rowId: 2, cartId: '2147483647', productId: 70, skuId: 72, skuUnique: 'gift0072',
        quantity: 2, usedPoints: 0, kind: 'gift', gift: { rootId: 90, tierId: 91, auxId: 92 } }] };
}
function entry(): PurchaseQuotaHistoryEntry {
  return { root: { id: 10, uid: 11, pid: 0, type: 0, paid: 0, status: 0, isDel: 0, totalNum: 4 },
    origin: charged, physical: physical(), cancellation: null, payment: null };
}
function rows() {
  const receipt = physical();
  return { orders: [entry().root], carts: receipt.lines.map(line => ({ id: line.rowId, oid: 10,
    uid: 11, cartId: line.cartId, oldCartId: '', productId: line.productId, skuUnique: line.skuUnique,
    cartNum: line.quantity, isGift: line.kind === 'gift' ? 1 : 0,
    snapshot: { valid: true, version: 'checkout-line-finance-v1', id: line.cartId, cartNum: line.quantity,
      skuId: line.skuId, gift: line.gift ? { version: 'order-promotion-gifts-v1', root_id: line.gift.rootId,
        tier_id: line.gift.tierId, aux_id: line.gift.auxId } : null } })) };
}
describe('final physical purchase origin', () => {
  it('preserves the charged points contract and counts paid plus gifted units of one base product together', () => {
    const receipt = physical(), before = structuredClone(receipt);
    expect(verifyPurchasePhysicalOriginEvidence(receipt, charged)).toEqual(receipt);
    expect(receipt).toEqual(before); expect(charged.totalNum).toBe(2);
    expect(projectPurchaseQuotaHistory([entry()], 11)).toMatchObject({ status: 'verified_retained_roots',
      incomplete: true, reason: 'preactivation_history_unproven', products: [{ productId: 70, activeUnpaid: 4 }] });
  });
  it('keeps gift cancellation quantities separate from charged point compensation', () => {
    const input = entry(); input.root.status = -2; input.root.isDel = 1;
    input.cancellation = { version: 'purchase-cancellation-v1', origin: charged, cancelledAtMillis: 1 };
    expect(projectPurchaseQuotaHistory([input], 11).products).toMatchObject([{ activeUnpaid: 0, cancelledUnpaid: 4 }]);
    expect(input.cancellation.origin.usedPoints).toBe(10);
  });
  it('requires the paid family to conserve every original gift unit', () => {
    const input = entry(); input.root.paid = 1;
    input.payment = { version: 'purchase-quota-payment-ledger-v1', paymentOrderId: 10, buyerId: 11,
      products: [{ productId: 70, purchased: 4, refunded: 1, pending: 2, remaining: 3 }],
      refundIds: [80], branchIds: [], evidenceRows: 5 };
    expect(projectPurchaseQuotaHistory([input], 11).products).toMatchObject([
      { paidPurchased: 4, completedRefund: 1, pendingRefund: 2 }]);
    input.payment.products[0].purchased = 2;
    expect(() => projectPurchaseQuotaHistory([input], 11)).toThrow();
  });
  it.each(['version', 'buyer', 'type', 'total', 'duplicate-row', 'duplicate-cart', 'charged-sku', 'charged-quantity',
    'charged-points', 'gift-points', 'gift-kind', 'gift-marker', 'gift-extra', 'line-extra', 'extra-charged', 'missing-charged'])(
    'rejects contradictory %s in the protected projection', change => {
      const value = physical() as any;
      if (change === 'version') value.version = 'purchase-origin-v1';
      if (change === 'buyer') value.buyerId = 22;
      if (change === 'type') value.orderType = 4;
      if (change === 'total') value.totalNum = 3;
      if (change === 'duplicate-row') value.lines[1].rowId = 1;
      if (change === 'duplicate-cart') value.lines[1].cartId = '20';
      if (change === 'charged-sku') value.lines[0].skuId++;
      if (change === 'charged-quantity') { value.lines[0].quantity++; value.totalNum++; }
      if (change === 'charged-points') value.lines[0].usedPoints--;
      if (change === 'gift-points') value.lines[1].usedPoints = 1;
      if (change === 'gift-kind') value.lines[1].kind = 'charged';
      if (change === 'gift-marker') value.lines[1].gift.rootId = 0;
      if (change === 'gift-extra') value.lines[1].gift.injected = true;
      if (change === 'line-extra') value.lines[1].extra = 0;
      if (change === 'extra-charged') { value.lines[1].kind = 'charged'; value.lines[1].gift = null; }
      if (change === 'missing-charged') { value.lines.shift(); value.totalNum = 2; }
      expect(() => verifyPurchasePhysicalOriginEvidence(value, charged)).toThrow();
    });
  it('binds all final root lines and gift kind/marker to the immutable receipt', () => {
    const input = rows(), scope = { paymentOrderId: 10, buyerId: 11 };
    verifyPurchaseQuotaRootOrigin(input, charged, scope, 0, physical());
    for (const change of ['gift-kind', 'gift-marker', 'sku', 'extra', 'missing']) {
      const edited = structuredClone(input);
      if (change === 'gift-kind') edited.carts[1].isGift = 0;
      if (change === 'gift-marker') edited.carts[1].snapshot.gift!.aux_id++;
      if (change === 'sku') edited.carts[1].snapshot.skuId++;
      if (change === 'extra') edited.carts.push({ ...edited.carts[1], id: 99 });
      if (change === 'missing') edited.carts.pop();
      expect(() => verifyPurchaseQuotaRootOrigin(edited, charged, scope, 0, physical())).toThrow();
    }
    expect(() => verifyPurchaseQuotaRootOrigin(input, charged, scope, 0)).toThrow();
  });
  it('retains exact legacy no-gift origin matching without manufacturing physical provenance', () => {
    const input = rows(); input.orders[0].totalNum = 2; input.carts.pop();
    verifyPurchaseQuotaRootOrigin(input, charged, { paymentOrderId: 10, buyerId: 11 }, 0);
    const old = entry(); old.physical = null; old.root.totalNum = 2;
    expect(projectPurchaseQuotaHistory([old], 11).products).toMatchObject([{ productId: 70, activeUnpaid: 2 }]);
  });
});
