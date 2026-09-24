import { describe, expect, it } from 'vitest';
import { verifyPurchaseQuotaRefundReceipt } from '@/services/order/PurchaseQuotaRefundReceipt';
import { refundOrderSplitFingerprint } from '@/services/order/RefundOrderSplitIdentity';

const expected = { refundId: 5, paymentOrderId: 10, buyerId: 11 };
async function receipt(options: { whole?: boolean; child?: boolean; previous?: number; branch?: string; legacy?: boolean } = {}) {
  const sourceId = options.child ? 11 : 10, selected = options.whole ? 3 : 1;
  const items = [{ rowId: 101, cartId: 1, cartNum: selected, beforeRefundNum: 0, totalNum: 3 }];
  if (options.whole) items.push({ rowId: 102, cartId: 2, cartNum: 1, beforeRefundNum: 0, totalNum: 1 });
  const refund = { id: 5, storeOrderId: sourceId, uid: 11, supplierId: 7, storeId: 0, orderId: 'LOCAL-REFUND',
    refundNum: options.whole ? 4 : 1, refundPrice: '9.00', refundedPrice: '9.00', refundType: 6, isCancel: 0, isDel: 0,
    cartInfo: JSON.stringify({ cartIds: items.map(({ cartId, cartNum }) => ({ cartId, cartNum })), quantityReservation: {
      version: options.legacy ? 'refund-quantity-reservation-v1' : 'refund-quantity-materialization-v2', orderId: sourceId, uid: 11, items } }) };
  return { refundId: 5, paymentOrderId: 10, uid: 11, supplierId: 7, storeId: 0, sourceOrderId: sourceId,
    selectedOrderId: options.whole ? sourceId : 12, remainingOrderId: options.whole ? null : options.child ? sourceId : 13,
    previousRefundId: options.previous ?? 0, baseBranchId: options.branch ?? null,
    disposition: options.whole ? 'whole' : 'split', fingerprint: await refundOrderSplitFingerprint(refund),
    evidence: { version: 'refund-order-materialization-v1', payment: { id: 10 }, refund,
      source: { id: sourceId, pid: options.child ? 10 : 0, uid: 11, supplierId: 7, storeId: 0, paid: 1, refundStatus: 3, refundType: 6 },
      carts: [{ id: 101, oid: sourceId, uid: 11, productId: 70, cartId: '1', oldCartId: '', cartNum: 3, refundNum: selected },
        { id: 102, oid: sourceId, uid: 11, productId: 71, cartId: '2', oldCartId: '', cartNum: 1, refundNum: options.whole ? 1 : 0 }] },
    partitions: [
      { sourceRowId: 101, sourceCartId: '1', selectedRowId: options.whole ? 101 : 201,
        remainingRowId: options.whole ? null : options.child ? 101 : 202, selectedNum: selected, remainingNum: 3 - selected },
      { sourceRowId: 102, sourceCartId: '2', selectedRowId: options.whole ? 102 : null,
        remainingRowId: options.whole ? null : options.child ? 102 : 203, selectedNum: options.whole ? 1 : 0, remainingNum: options.whole ? 0 : 1 },
    ] };
}
// Deliberately malformed unknown input, never a type assertion to a trusted receipt.
function replace(value: unknown, path: string, replacement: unknown) {
  const keys = path.split('.'); let at: unknown = value;
  for (const key of keys.slice(0, -1)) at = (at as Record<string, unknown>)[key];
  (at as Record<string, unknown>)[keys.at(-1)!] = replacement;
}

describe('completed purchase-quota refund quantity evidence (not remaining quota)', () => {
  it.each([
    {}, { legacy: true }, { whole: true }, { child: true }, { child: true, previous: 2 },
    { child: true, previous: 2, whole: true }, { child: true, branch: 'a'.repeat(32) },
    { child: true, previous: 2, branch: 'a'.repeat(32) },
  ])('validates exact whole/split/generation identity: %j', async options => {
    const input = await receipt(options), original = structuredClone(input);
    const result = await verifyPurchaseQuotaRefundReceipt(input, expected);
    expect(result).toMatchObject({ version: 'purchase-quota-refund-receipt-v1', ...expected,
      previousRefundId: options.previous ?? 0, baseBranchId: options.branch ?? null,
      lines: [{ productId: 70, selectedNum: options.whole ? 3 : 1, remainingNum: options.whole ? 0 : 2 },
        { productId: 71, selectedNum: options.whole ? 1 : 0, remainingNum: options.whole ? 0 : 1 }] });
    expect(input).toEqual(original);
    expect(Object.keys(result)).not.toContain('evidence');
    expect(JSON.stringify(result)).not.toMatch(/refundPrice|cartInfo|LOCAL-REFUND/);
  });
  it.each([
    ['refundId', 6], ['uid', 12], ['paymentOrderId', 11], ['sourceOrderId', 0], ['supplierId', -1], ['storeId', 1],
    ['evidence.version', 'legacy'], ['evidence.source.pid', -1], ['evidence.source.uid', 12],
    ['evidence.source.paid', 0], ['evidence.source.refundStatus', 1], ['evidence.source.refundType', 4],
    ['evidence.payment.id', 11], ['previousRefundId', 5], ['previousRefundId', 1], ['baseBranchId', 'a'.repeat(32)],
    ['baseBranchId', 'not-a-branch'], ['selectedOrderId', 10], ['selectedOrderId', 13], ['remainingOrderId', null],
    ['remainingOrderId', 10], ['disposition', 'legacy'], ['fingerprint', 'a'.repeat(64)],
    ['evidence.refund.refundType', 1], ['evidence.refund.isCancel', 1], ['evidence.refund.isDel', 1],
    ['evidence.refund.refundedPrice', '8.99'], ['evidence.refund.refundPrice', '9e0'],
    ['evidence.refund.cartInfo', '{}'], ['evidence.refund.cartInfo', 'x'.repeat(65537)],
    ['evidence.carts', []], ['evidence.carts', null], ['evidence.carts.0.productId', 0],
    ['evidence.carts.0.productId', '70'], ['evidence.carts.0.uid', 12], ['evidence.carts.0.oid', 11],
    ['evidence.carts.0.cartNum', 32768], ['evidence.carts.0.cartId', '01'],
    ['evidence.carts.0.refundNum', 0], ['evidence.carts.1.id', 101], ['evidence.carts.1.cartId', '1'],
    ['partitions', []], ['partitions.0.sourceRowId', 102], ['partitions.0.sourceCartId', '2'],
    ['partitions.0.selectedNum', 2], ['partitions.0.remainingNum', 1], ['partitions.0.selectedRowId', 101],
    ['partitions.0.remainingRowId', 101], ['partitions.1.selectedRowId', 300], ['partitions.1.remainingRowId', 201],
    ['partitions.0.extra', true],
  ])('rejects malformed or contradictory %s = %j', async (path, value) => {
    const input = await receipt(); replace(input, String(path), value);
    await expect(verifyPurchaseQuotaRefundReceipt(input, expected)).rejects.toThrow();
  });
  it('rejects an oversized cart generation before projecting quantity', async () => {
    const input = await receipt(); input.evidence.carts = Array.from({ length: 201 }, () => input.evidence.carts[0]);
    await expect(verifyPurchaseQuotaRefundReceipt(input, expected)).rejects.toThrow();
  });
  it('requires the same remainder order and row identities after a prior split', async () => {
    const input = await receipt({ child: true, previous: 2 }); input.partitions[0].remainingRowId = 999;
    await expect(verifyPurchaseQuotaRefundReceipt(input, expected)).rejects.toThrow();
    input.partitions[0].remainingRowId = 101; input.remainingOrderId = 999;
    await expect(verifyPurchaseQuotaRefundReceipt(input, expected)).rejects.toThrow();
  });
  it('rejects an otherwise fingerprint-matched claim that already reserved unrelated quantities', async () => {
    const input = await receipt();
    const claim = JSON.parse(input.evidence.refund.cartInfo); claim.quantityReservation.items[0].beforeRefundNum = 1;
    input.evidence.refund.cartInfo = JSON.stringify(claim);
    input.fingerprint = await refundOrderSplitFingerprint(input.evidence.refund);
    await expect(verifyPurchaseQuotaRefundReceipt(input, expected)).rejects.toThrow();
  });
  it('rejects a whole refund mapped to newly created rows', async () => {
    const input = await receipt({ whole: true }); input.partitions[0].selectedRowId = 201;
    await expect(verifyPurchaseQuotaRefundReceipt(input, expected)).rejects.toThrow();
  });
  it.each([0, -1, 2147483648, 1.5, NaN])('rejects invalid caller scope %s', async refundId => {
    await expect(verifyPurchaseQuotaRefundReceipt(await receipt(), { ...expected, refundId })).rejects.toThrow();
  });
  it.each([null, undefined, [], 'raw snapshot'])('does not fall back on absent or unrecognized evidence %s', async input => {
    await expect(verifyPurchaseQuotaRefundReceipt(input, expected)).rejects.toThrow();
  });
});
