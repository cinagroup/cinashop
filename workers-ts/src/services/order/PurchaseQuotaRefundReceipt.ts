import { sql, type SQL } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeOrderRefundSplit } from '@/models/schema';
import { ValidateException } from '@/utils/errors';
import { readRefundQuantityReservation } from './RefundQuantityReservation';
import { refundOrderSplitFingerprint } from './RefundOrderSplitIdentity';

export interface PurchaseQuotaRefundScope { refundId: number; paymentOrderId: number; buyerId: number }
export interface PurchaseQuotaRefundReceipt {
  version: 'purchase-quota-refund-receipt-v1';
  refundId: number; fingerprint: string; buyerId: number; paymentOrderId: number;
  supplierId: number; storeId: number;
  sourceOrderId: number; selectedOrderId: number; remainingOrderId: number | null;
  previousRefundId: number; baseBranchId: string | null; disposition: 'whole' | 'split';
  lines: Array<{ productId: number; sourceRowId: number; sourceCartId: string; sourceOldCartId: string;
    selectedRowId: number | null; remainingRowId: number | null; selectedNum: number; remainingNum: number }>;
}
const invalid = (): never => { throw new ValidateException('累计限购退款数量凭据不一致，请核对订单'); };
function integer(value: unknown, minimum = 0, maximum = 2147483647): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : invalid();
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
}
function string(value: unknown, maximum: number): string { return typeof value === 'string' && value.length <= maximum ? value : invalid(); }
function money(value: unknown): string { const result = string(value, 13); return /^\d{1,10}\.\d{2}$/.test(result) ? result : invalid(); }
function cartId(value: unknown): string {
  const result = string(value, 10); if (!/^[1-9]\d{0,9}$/.test(result)) return invalid(); integer(Number(result), 1); return result;
}
function scope(input: PurchaseQuotaRefundScope) {
  integer(input.refundId, 1); integer(input.paymentOrderId, 1); integer(input.buyerId, 1);
}

/** Validate a server-projected immutable materialization receipt. This proves
 * one generation's completed quantity transition, NOT a user's remaining quota.
 * Callers must separately anchor the original purchase, follow predecessor and
 * fulfillment-branch links, deduplicate refunds, and serialize quota mutations.
 * Never accept this projection from HTTP or subtract live cart.refundNum. */
export async function verifyPurchaseQuotaRefundReceipt(value: unknown, expected: PurchaseQuotaRefundScope): Promise<PurchaseQuotaRefundReceipt> {
  scope(expected);
  const receipt = object(value), evidence = object(receipt.evidence), source = object(evidence.source);
  const frozen = object(evidence.refund), payment = object(evidence.payment);
  if (receipt.refundId !== expected.refundId || receipt.paymentOrderId !== expected.paymentOrderId || receipt.uid !== expected.buyerId
    || evidence.version !== 'refund-order-materialization-v1') return invalid();
  const sourceOrderId = integer(receipt.sourceOrderId, 1), supplierId = integer(receipt.supplierId), storeId = integer(receipt.storeId);
  const selectedOrderId = integer(receipt.selectedOrderId, 1), previousRefundId = integer(receipt.previousRefundId, 0, expected.refundId - 1);
  const baseBranchId = receipt.baseBranchId;
  if (baseBranchId !== null && (typeof baseBranchId !== 'string' || !/^[0-9a-f]{32}$/.test(baseBranchId))) return invalid();
  if (source.id !== sourceOrderId || source.uid !== expected.buyerId || source.supplierId !== supplierId || source.storeId !== storeId
    || source.paid !== 1 || ![2, 3].includes(integer(source.refundStatus)) || source.refundType !== 6
    || source.pid !== (sourceOrderId === expected.paymentOrderId ? 0 : expected.paymentOrderId)
    || payment.id !== expected.paymentOrderId || (sourceOrderId === expected.paymentOrderId && (previousRefundId !== 0 || baseBranchId !== null))) return invalid();
  const disposition = receipt.disposition;
  const remainingOrderId = receipt.remainingOrderId === null ? null : integer(receipt.remainingOrderId, 1);
  if (disposition === 'whole') {
    if (selectedOrderId !== sourceOrderId || remainingOrderId !== null) return invalid();
  } else if (disposition === 'split') {
    if (remainingOrderId === null || selectedOrderId === sourceOrderId || selectedOrderId === remainingOrderId
      || selectedOrderId === expected.paymentOrderId || remainingOrderId === expected.paymentOrderId
      || (sourceOrderId !== expected.paymentOrderId && remainingOrderId !== sourceOrderId)) return invalid();
  } else return invalid();
  const refund = { id: integer(frozen.id, 1), storeOrderId: integer(frozen.storeOrderId, 1), uid: integer(frozen.uid, 1),
    supplierId: integer(frozen.supplierId), storeId: integer(frozen.storeId), orderId: string(frozen.orderId, 50),
    refundNum: integer(frozen.refundNum, 1), refundPrice: money(frozen.refundPrice), cartInfo: string(frozen.cartInfo, 65536) };
  if (refund.id !== expected.refundId || refund.storeOrderId !== sourceOrderId || refund.uid !== expected.buyerId
    || refund.supplierId !== supplierId || refund.storeId !== storeId || frozen.refundType !== 6 || frozen.isCancel !== 0 || frozen.isDel !== 0
    || money(frozen.refundedPrice) !== refund.refundPrice) return invalid();
  const fingerprint = string(receipt.fingerprint, 64);
  if (!/^[0-9a-f]{64}$/.test(fingerprint) || await refundOrderSplitFingerprint(refund) !== fingerprint) return invalid();
  const claim = readRefundQuantityReservation(refund); if (!claim) return invalid();
  if (!Array.isArray(evidence.carts) || !evidence.carts.length || evidence.carts.length > 200
    || !Array.isArray(receipt.partitions) || receipt.partitions.length !== evidence.carts.length) return invalid();
  const sourceIds = new Set<number>(), cartIds = new Set<string>();
  const carts = evidence.carts.map(value => {
    const row = object(value), id = integer(row.id, 1), productId = integer(row.productId, 1), identity = cartId(row.cartId);
    const quantity = integer(row.cartNum, 1, 32767), oldCartId = row.oldCartId === '' ? '' : cartId(row.oldCartId);
    if (sourceIds.has(id) || cartIds.has(identity) || row.oid !== sourceOrderId || row.uid !== expected.buyerId) return invalid();
    sourceIds.add(id); cartIds.add(identity);
    return { id, productId, cartId: identity, oldCartId, quantity, refundNum: integer(row.refundNum, 0, quantity) };
  });
  const visited = new Set<number>(), destinationIds = new Set<number>();
  let selectedTotal = 0, remainingTotal = 0;
  const lines = receipt.partitions.map(value => {
    const part = object(value), sourceRowId = integer(part.sourceRowId, 1), sourceCartId = cartId(part.sourceCartId);
    const row = carts.find(row => row.id === sourceRowId);
    const selectedNum = integer(part.selectedNum, 0, 32767), remainingNum = integer(part.remainingNum, 0, 32767);
    if (Object.keys(part).length !== 6 || !row || visited.has(sourceRowId) || row.cartId !== sourceCartId
      || selectedNum + remainingNum !== row.quantity || row.refundNum !== selectedNum) return invalid();
    visited.add(sourceRowId);
    const selectedRowId = selectedNum ? integer(part.selectedRowId, 1) : null;
    const remainingRowId = remainingNum ? integer(part.remainingRowId, 1) : null;
    if ((!selectedNum && part.selectedRowId !== null) || (!remainingNum && part.remainingRowId !== null)) return invalid();
    for (const id of [selectedRowId, remainingRowId]) {
      if (id !== null) { if (destinationIds.has(id)) return invalid(); destinationIds.add(id); }
    }
    if (disposition === 'whole') {
      if (selectedNum !== row.quantity || selectedRowId !== row.id || remainingNum !== 0 || remainingRowId !== null) return invalid();
    } else {
      if (selectedRowId !== null && sourceIds.has(selectedRowId)) return invalid();
      if (remainingRowId !== null && (sourceOrderId === expected.paymentOrderId ? sourceIds.has(remainingRowId) : remainingRowId !== row.id)) return invalid();
    }
    const selection = claim.items.find(item => item.rowId === row.id);
    if (selectedNum ? !selection || selection.cartId !== Number(row.cartId) || selection.cartNum !== selectedNum
      || selection.totalNum !== row.quantity || selection.beforeRefundNum !== 0 : selection !== undefined) return invalid();
    selectedTotal += selectedNum; remainingTotal += remainingNum;
    return { productId: row.productId, sourceRowId, sourceCartId, sourceOldCartId: row.oldCartId,
      selectedRowId, remainingRowId, selectedNum, remainingNum };
  }).sort((a, b) => a.sourceRowId - b.sourceRowId);
  if (selectedTotal !== refund.refundNum || !selectedTotal || (disposition === 'split' ? !remainingTotal : remainingTotal !== 0)
    || claim.items.length !== lines.filter(line => line.selectedNum > 0).length) return invalid();
  return { version: 'purchase-quota-refund-receipt-v1', refundId: expected.refundId, fingerprint, buyerId: expected.buyerId,
    paymentOrderId: expected.paymentOrderId, supplierId, storeId,
    sourceOrderId, selectedOrderId, remainingOrderId, previousRefundId, baseBranchId, disposition, lines };
}

async function projections(tx: Pick<DbClient, 'execute'>, predicate: SQL, limit: number) {
  if (Object.hasOwn(tx, '$client')) throw new Error('Quota receipt inspection requires a caller-owned transaction');
  // Bound the indexed candidate set BEFORE window aggregation. Parse each JSON
  // only once and reject more than 32 MiB of total frozen source evidence.
  return tx.execute(sql`WITH candidates AS MATERIALIZED (
    SELECT refund_id AS "refundId", fingerprint, uid, supplier_id AS "supplierId", store_id AS "storeId",
      source_order_id AS "sourceOrderId", payment_order_id AS "paymentOrderId", selected_order_id AS "selectedOrderId",
      remaining_order_id AS "remainingOrderId", previous_refund_id AS "previousRefundId", base_branch_id AS "baseBranchId", disposition,
      source_snapshot, partitions AS raw_partitions
    FROM ${storeOrderRefundSplit} WHERE ${predicate} ORDER BY refund_id LIMIT ${limit}
  ), receipt AS MATERIALIZED (
    SELECT *, CASE WHEN octet_length(source_snapshot) <= 16777216
      AND SUM(octet_length(source_snapshot)::bigint) OVER () <= 33554432 THEN source_snapshot::jsonb ELSE NULL END AS frozen,
      CASE WHEN octet_length(raw_partitions) <= 131072
      AND SUM(octet_length(raw_partitions)::bigint) OVER () <= 8388608 THEN raw_partitions::jsonb ELSE NULL END AS partitions
    FROM candidates
  ), projected AS MATERIALIZED (SELECT "refundId", fingerprint, uid, "supplierId", "storeId", "sourceOrderId", "paymentOrderId",
    "selectedOrderId", "remainingOrderId", "previousRefundId", "baseBranchId", disposition, partitions,
    jsonb_build_object(
      'version', frozen->'version',
      'source', jsonb_build_object('id', frozen#>'{source,id}', 'pid', frozen#>'{source,pid}',
        'uid', frozen#>'{source,uid}', 'supplierId', frozen#>'{source,supplierId}', 'storeId', frozen#>'{source,storeId}',
        'paid', frozen#>'{source,paid}', 'refundStatus', frozen#>'{source,refundStatus}', 'refundType', frozen#>'{source,refundType}'),
      'payment', jsonb_build_object('id', frozen#>'{payment,id}'),
      'refund', jsonb_build_object('id', frozen#>'{refund,id}', 'storeOrderId', frozen#>'{refund,storeOrderId}',
        'uid', frozen#>'{refund,uid}', 'supplierId', frozen#>'{refund,supplierId}', 'storeId', frozen#>'{refund,storeId}',
        'orderId', frozen#>'{refund,orderId}', 'refundNum', frozen#>'{refund,refundNum}', 'refundPrice', frozen#>'{refund,refundPrice}',
        'refundedPrice', frozen#>'{refund,refundedPrice}', 'refundType', frozen#>'{refund,refundType}',
        'isCancel', frozen#>'{refund,isCancel}', 'isDel', frozen#>'{refund,isDel}',
        'cartInfo', CASE WHEN octet_length(frozen#>>'{refund,cartInfo}') <= 65536 THEN frozen#>'{refund,cartInfo}' ELSE NULL END),
      'carts', CASE WHEN jsonb_typeof(frozen->'carts') = 'array' THEN
        CASE WHEN jsonb_array_length(frozen->'carts') BETWEEN 1 AND 200 THEN
          (SELECT jsonb_agg(jsonb_build_object('id', cart->'id', 'oid', cart->'oid', 'uid', cart->'uid', 'productId', cart->'productId',
            'cartId', cart->'cartId', 'oldCartId', cart->'oldCartId', 'cartNum', cart->'cartNum', 'refundNum', cart->'refundNum'))
            FROM jsonb_array_elements(frozen->'carts') cart) ELSE NULL END ELSE NULL END) AS evidence
    FROM receipt)
  SELECT "refundId", fingerprint, uid, "supplierId", "storeId", "sourceOrderId", "paymentOrderId",
    "selectedOrderId", "remainingOrderId", "previousRefundId", "baseBranchId", disposition, partitions,
    CASE WHEN SUM(octet_length(evidence::text)::bigint) OVER () <= 8388608 THEN evidence ELSE NULL END AS evidence
    FROM projected`);
}

/** One PK lookup; missing/pending receipts fail closed, never zero. No live
 * quantities, contact data, amounts or whole source snapshots are returned. */
export async function readPurchaseQuotaRefundReceipt(tx: Pick<DbClient, 'execute'>, expected: PurchaseQuotaRefundScope): Promise<PurchaseQuotaRefundReceipt> {
  scope(expected);
  const [row] = await projections(tx, sql`refund_id = ${expected.refundId} AND uid = ${expected.buyerId}
    AND payment_order_id = ${expected.paymentOrderId}`, 1);
  if (!row) return invalid();
  return verifyPurchaseQuotaRefundReceipt(row, expected);
}

/** Indexed payment-root batch for a caller's consistent snapshot. A missing
 * family receipt is detected by the lineage verifier, not inferred as zero. */
export async function readPurchaseQuotaRefundFamily(tx: Pick<DbClient, 'execute'>,
  expected: Omit<PurchaseQuotaRefundScope, 'refundId'>): Promise<PurchaseQuotaRefundReceipt[]> {
  scope({ ...expected, refundId: 1 });
  const rows = await projections(tx, sql`payment_order_id = ${expected.paymentOrderId}`, 202);
  if (rows.length > 201) return invalid();
  const result: PurchaseQuotaRefundReceipt[] = [];
  for (const row of rows) result.push(await verifyPurchaseQuotaRefundReceipt(row, { ...expected, refundId: integer(row.refundId, 1) }));
  return result;
}
