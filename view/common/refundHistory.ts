export interface RefundHistory {
  version: 1; refundId: number; sourceOrderId: number; physicalOrderId: number | null;
  items: Array<{ id: number; cartId: number; name: string; sku: string; image: string; quantity: number }>;
  itemsError: string;
}
const invalid = () => Error('退款商品快照与当前单据不一致，请刷新核对');
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value)
  && value > 0 && value <= 2147483647;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum = 4096): string {
  if (typeof value !== 'string' || value.length > maximum || new TextEncoder().encode(value).length > maximum) throw invalid();
  return value;
}

/** Absent on older servers/non-materialized records. A present contract is
 * strictly bound to this refund, never reinterpreted as the current order. */
export function parseRefundHistory(value: unknown, scope: {
  id: number; sourceOrderId: number; refundNum: number; refundType: number; isCancel: number;
}): RefundHistory | null {
  if (value === undefined || value === null) return null;
  const row = object(value);
  if (row.version !== 1 || row.refundId !== scope.id || row.sourceOrderId !== scope.sourceOrderId
    || !integer(row.refundId) || !integer(row.sourceOrderId) || scope.refundType !== 6
    || !Array.isArray(row.items) || row.items.length > 100) throw invalid();
  const itemsError = text(row.itemsError, 255), ids = new Set<number>(), cartIds = new Set<number>();
  if (itemsError) {
    if (row.items.length || row.physicalOrderId !== null) throw invalid();
    return { version: 1, refundId: row.refundId, sourceOrderId: row.sourceOrderId, physicalOrderId: null, items: [], itemsError };
  }
  if (scope.isCancel !== 0 || !integer(row.physicalOrderId) || !integer(scope.refundNum) || !row.items.length) throw invalid();
  const items = row.items.map(value => {
    const item = object(value);
    if (!integer(item.id) || !integer(item.cartId) || !integer(item.quantity) || ids.has(item.id) || cartIds.has(item.cartId)) throw invalid();
    ids.add(item.id); cartIds.add(item.cartId);
    return { id: item.id, cartId: item.cartId, quantity: item.quantity,
      name: text(item.name), sku: text(item.sku), image: text(item.image) };
  });
  if (items.reduce((sum, item) => sum + item.quantity, 0) !== scope.refundNum
    || new TextEncoder().encode(JSON.stringify(items)).length > 524288) throw invalid();
  return { version: 1, refundId: row.refundId, sourceOrderId: row.sourceOrderId, physicalOrderId: row.physicalOrderId, items, itemsError };
}
