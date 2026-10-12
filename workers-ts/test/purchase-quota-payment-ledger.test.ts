import { describe, expect, it } from 'vitest';
import { verifyPurchaseQuotaPaymentLedger, verifyPurchaseQuotaPaymentOrigin, type PurchaseQuotaPaymentEvidence } from '@/services/order/PurchaseQuotaPaymentLedger';
import type { PurchaseQuotaRefundReceipt } from '@/services/order/PurchaseQuotaRefundReceipt';
import type { PurchaseOriginEvidence } from '@/services/order/PurchaseOriginEvidence';

const scope = { paymentOrderId: 10, buyerId: 11 }, hash = 'a'.repeat(64), branchA = 'a'.repeat(32), branchB = 'b'.repeat(32);
function fixture(fork = false) {
  const order = (id: number, totalNum: number, done = false) => ({ id, pid: id === 10 ? -1 : 10, uid: 11,
    supplierId: 7, storeId: 0, type: 0, paid: 1, totalNum, refundStatus: done ? 2 : 0, refundType: done ? 6 : 0 });
  const cart = (id: number, oid: number, productId: number, quantity: number, cartId: string, oldCartId: string,
    marker: unknown = null, done = false) => ({ id, oid, uid: 11, productId, cartId, oldCartId, cartNum: quantity,
    refundNum: done ? quantity : 0, splitStatus: done ? 2 : 0, splitSurplusNum: done ? 0 : quantity,
    skuUnique: productId === 70 ? 'sku70' : 'sku71',
    snapshot: { valid: true, marker, version: marker ? 'refund-order-line-finance-v1' : 'checkout-line-finance-v1',
      id: cartId, cartNum: quantity, skuId: productId === 70 ? 1 : 2 } });
  const receipts: PurchaseQuotaRefundReceipt[] = [{ version: 'purchase-quota-refund-receipt-v1', refundId: 5, fingerprint: hash,
    ...scope, supplierId: 7, storeId: 0, sourceOrderId: 10, selectedOrderId: 11, remainingOrderId: 12,
    previousRefundId: 0, baseBranchId: null, disposition: 'split', lines: [
      { productId: 70, sourceRowId: 101, sourceCartId: '1', sourceOldCartId: '', selectedRowId: 200, remainingRowId: 201, selectedNum: 1, remainingNum: 1 },
      { productId: 71, sourceRowId: 102, sourceCartId: '2', sourceOldCartId: '', selectedRowId: null, remainingRowId: 202, selectedNum: 0, remainingNum: 1 },
    ] }];
  const orders = [order(10, 3), order(11, 1, true), order(12, fork ? 1 : 2)];
  const carts = [cart(101, 10, 70, 2, '1', ''), cart(102, 10, 71, 1, '2', ''),
    cart(200, 11, 70, 1, '200', '1', { refundId: 5, role: 'selected' }, true),
    cart(202, 12, 71, 1, '202', '2', fork ? { branchId: branchA, role: 'remaining' } : { refundId: 5, role: 'remaining' }),
  ];
  const branches: unknown[] = [];
  if (fork) {
    orders.push(order(13, 1)); carts.push(cart(203, 13, 70, 1, '203', '1', { branchId: branchB, role: 'remaining' }));
    for (const [id, child, sourceRow, row, covered] of [
      [branchA, 12, 202, 202, [[5, hash]]], [branchB, 13, 201, 203, []],
    ] as const) branches.push({ id, sourceBranchId: null, sourceRefundId: 5, sourceOrderId: 12,
      paymentOrderId: 10, childOrderId: child, uid: 11, supplierId: 7, storeId: 0, covered, materialized: [],
      partitions: [{ sourceRowId: sourceRow, rowId: row, cartId: String(row), quantity: 1 }] });
  } else carts.push(cart(201, 12, 70, 1, '201', '1', { refundId: 5, role: 'remaining' }));
  return { input: { orders, carts, branches, refunds: [] } satisfies PurchaseQuotaPaymentEvidence, receipts };
}
function replace(value: unknown, path: string, replacement: unknown) {
  const keys = path.split('.'); let at: unknown = value;
  for (const key of keys.slice(0, -1)) at = (at as Record<string, unknown>)[key];
  (at as Record<string, unknown>)[keys.at(-1)!] = replacement;
}
describe('purchase quota quantity lineage, not a quota release decision', () => {
  const origin: PurchaseOriginEvidence = { version: 'purchase-origin-v1', orderId: 10, buyerId: 11,
    orderType: 0, totalNum: 3, usedPoints: 0, lines: [
      { rowId: 101, cartId: '1', productId: 70, skuId: 1, skuUnique: 'sku70', quantity: 2, usedPoints: 0 },
      { rowId: 102, cartId: '2', productId: 71, skuId: 2, skuUnique: 'sku71', quantity: 1, usedPoints: 0 },
    ] };
  it('binds the paid root to every immutable original line and rejects a coherent live rewrite', () => {
    const { input } = fixture();
    expect(() => verifyPurchaseQuotaPaymentOrigin(input, origin, scope)).not.toThrow();
    for (const [field, value] of [['productId', 72], ['cartNum', 1], ['skuUnique', 'other'], ['cartId', '9']] as const) {
      const changed = structuredClone(input);
      (changed.carts[0] as Record<string, unknown>)[field] = value;
      expect(() => verifyPurchaseQuotaPaymentOrigin(changed, origin, scope)).toThrow();
    }
    for (const [field, value] of [['skuId', 3], ['version', 'legacy']] as const) {
      const changed = structuredClone(input);
      ((changed.carts[0] as Record<string, unknown>).snapshot as Record<string, unknown>)[field] = value;
      expect(() => verifyPurchaseQuotaPaymentOrigin(changed, origin, scope)).toThrow();
    }
    expect(() => verifyPurchaseQuotaPaymentOrigin(input, { ...origin, orderType: 6 }, scope)).toThrow();
    expect(() => verifyPurchaseQuotaPaymentOrigin(input, { ...origin, lines: origin.lines.slice(0, 1) }, scope)).toThrow();
  });
  it.each([false, true])('proves original product quantities after a refund and optional fork: %s', async fork => {
    const { input, receipts } = fixture(fork), before = structuredClone(input);
    const result = await verifyPurchaseQuotaPaymentLedger(input, receipts, scope);
    expect(result.products).toEqual([{ productId: 70, purchased: 2, refunded: 1, pending: 0, remaining: 1 },
      { productId: 71, purchased: 1, refunded: 0, pending: 0, remaining: 1 }]);
    expect(result.refundIds).toEqual([5]); expect(result.branchIds).toEqual(fork ? [branchA, branchB] : []);
    expect(input).toEqual(before);
  });
  it('does not depend on receipt/fork/current-row array order', async () => {
    const { input, receipts } = fixture(true), original = await verifyPurchaseQuotaPaymentLedger(input, receipts, scope);
    input.orders.reverse(); input.carts.reverse(); input.branches.reverse(); receipts.reverse();
    expect(await verifyPurchaseQuotaPaymentLedger(input, receipts, scope)).toEqual(original);
  });
  it('combines different original lines of the same product without double-counting the root', async () => {
    const { input, receipts } = fixture(true);
    for (const row of input.carts) if (row.productId === 71) row.productId = 70;
    for (const row of receipts[0].lines) if (row.productId === 71) row.productId = 70;
    expect((await verifyPurchaseQuotaPaymentLedger(input, receipts, scope)).products)
      .toEqual([{ productId: 70, purchased: 3, refunded: 1, pending: 0, remaining: 2 }]);
  });
  it.each([
    ['orders.0.uid', 22], ['orders.0.paid', 0], ['orders.0.pid', 0], ['orders.0.totalNum', 4],
    ['orders.1.pid', 99], ['orders.1.refundStatus', 0], ['orders.2.supplierId', 8], ['orders.2.type', 6],
    ['carts.0.productId', 99], ['carts.0.cartNum', 3], ['carts.0.oldCartId', '7'],
    ['carts.2.refundNum', 0], ['carts.2.splitStatus', 0], ['carts.2.snapshot.marker', null],
    ['carts.3.cartNum', 2], ['carts.3.oldCartId', '1'], ['carts.3.snapshot.marker.refundId', 6],
    ['carts.3.snapshot.version', 'unversioned'], ['carts.3.snapshot.id', 'wrong'], ['carts.3.snapshot.cartNum', 999],
    ['carts.3.refundNum', 1], ['carts.3.productId', 70], ['carts.3.oid', 99], ['carts.3.uid', 22],
    ['carts.3.id', 200], ['carts.3.cartId', '201'], ['carts.3.snapshot.valid', false],
  ])('rejects contradictory live %s = %j', async (path, value) => {
    const { input, receipts } = fixture(); replace(input, String(path), value);
    await expect(verifyPurchaseQuotaPaymentLedger(input, receipts, scope)).rejects.toThrow();
  });
  it.each([
    ['0.sourceRefundId', 99], ['0.sourceBranchId', branchB], ['0.paymentOrderId', 99], ['0.uid', 22],
    ['0.childOrderId', 13], ['0.supplierId', 8], ['0.partitions.0.quantity', 2], ['0.partitions.0.sourceRowId', 201],
    ['0.partitions.0.cartId', '999'], ['0.partitions.0.rowId', 999], ['0.covered', []], ['0.materialized', [[5, hash]]],
    ['1.covered', [[5, hash]]], ['1.sourceOrderId', 10], ['1.id', branchA], ['1.partitions.0.rowId', 200],
  ])('rejects missing, inconsistent or double-used fulfillment proof %s', async (path, value) => {
    const { input, receipts } = fixture(true); replace(input.branches, String(path), value);
    await expect(verifyPurchaseQuotaPaymentLedger(input, receipts, scope)).rejects.toThrow();
  });
  it('requires both fork partitions and every original receipt exactly once', async () => {
    const { input, receipts } = fixture(true);
    await expect(verifyPurchaseQuotaPaymentLedger({ ...input, branches: input.branches.slice(0, 1) }, receipts, scope)).rejects.toThrow();
    await expect(verifyPurchaseQuotaPaymentLedger(input, [], scope)).rejects.toThrow();
    await expect(verifyPurchaseQuotaPaymentLedger(input, [...receipts, ...receipts], scope)).rejects.toThrow();
    await expect(verifyPurchaseQuotaPaymentLedger({ ...input, orders: input.orders.slice(0, -1) }, receipts, scope)).rejects.toThrow();
  });
  it('rejects an unreachable predecessor or detached refund branch', async () => {
    for (const override of [{ previousRefundId: 4 }, { baseBranchId: branchA }, { buyerId: 22 }, { paymentOrderId: 99 }]) {
      const { input, receipts } = fixture(); Object.assign(receipts[0], override);
      await expect(verifyPurchaseQuotaPaymentLedger(input, receipts, scope)).rejects.toThrow();
    }
  });
  it('separates pending reservations from completed refunds without releasing any allowance', async () => {
    const { input, receipts } = fixture(); input.carts.find(row => row.id === 201)!.refundNum = 1;
    const pending = { id: 6, storeOrderId: 12, uid: 11, supplierId: 7, storeId: 0, orderId: 'LOCAL-PENDING',
      refundNum: 1, refundPrice: '9.00', refundedPrice: '0.00', refundType: 1, isCancel: 0, isDel: 0,
      cartInfo: JSON.stringify({ cartIds: [{ cartId: 201, cartNum: 1 }], quantityReservation: {
        version: 'refund-quantity-materialization-v2', orderId: 12, uid: 11,
        items: [{ rowId: 201, cartId: 201, cartNum: 1, beforeRefundNum: 0, totalNum: 1 }] } }) };
    expect((await verifyPurchaseQuotaPaymentLedger({ ...input, refunds: [pending] }, receipts, scope)).products[0])
      .toEqual({ productId: 70, purchased: 2, refunded: 1, pending: 1, remaining: 1 });
    await expect(verifyPurchaseQuotaPaymentLedger({ ...input, refunds: [pending, { ...pending, id: 7 }] }, receipts, scope)).rejects.toThrow();
    await expect(verifyPurchaseQuotaPaymentLedger({ ...input, refunds: [{ ...pending, refundType: 6 }] }, receipts, scope)).rejects.toThrow();
  });
  it.each(['orders', 'carts', 'branches', 'refunds'] as const)('rejects an oversized %s family', async key => {
    const { input, receipts } = fixture(true);
    const count = { orders: 203, carts: 40401, branches: 401, refunds: 202 }[key];
    await expect(verifyPurchaseQuotaPaymentLedger({ ...input, [key]: Array(count).fill(input[key][0]) }, receipts, scope)).rejects.toThrow();
  });
});
