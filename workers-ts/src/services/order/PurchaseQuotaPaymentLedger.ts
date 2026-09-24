import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { ValidateException } from '@/utils/errors';
import { readRefundGenerationMarker, type RefundGenerationMarker } from './RefundGenerationMarker';
import { readRefundQuantityReservation } from './RefundQuantityReservation';
import { refundOrderSplitFingerprint } from './RefundOrderSplitIdentity';
import { readPurchaseQuotaRefundFamily, type PurchaseQuotaRefundReceipt } from './PurchaseQuotaRefundReceipt';

type Query = Pick<DbClient, 'execute'>;
export interface PurchaseQuotaPaymentScope { paymentOrderId: number; buyerId: number }
export interface PurchaseQuotaPaymentLedger extends PurchaseQuotaPaymentScope {
  version: 'purchase-quota-payment-ledger-v1';
  products: Array<{ productId: number; purchased: number; refunded: number; pending: number; remaining: number }>;
  refundIds: number[];
  branchIds: string[];
}
interface Order { id: number; pid: number; uid: number; supplierId: number; storeId: number; type: number;
  paid: number; totalNum: number; refundStatus: number; refundType: number }
interface Line { id: number; cartId: string; oldCartId: string; productId: number; quantity: number; origin: number }
interface Cart extends Line { oid: number; refundNum: number; splitStatus: number; splitSurplusNum: number;
  marker: RefundGenerationMarker | null }
interface Node { order: Order; lines: Map<number, Line>; previous: number; branch: string | null;
  marker: RefundGenerationMarker | null; covered: Map<number, string>; materialized: Map<number, string> }
interface Branch { id: string; sourceBranchId: string | null; sourceRefundId: number; sourceOrderId: number;
  childOrderId: number; supplierId: number; storeId: number; covered: Map<number, string>; materialized: Map<number, string>;
  parts: Array<{ sourceRowId: number; rowId: number; cartId: string; quantity: number }> }
export interface PurchaseQuotaPaymentEvidence {
  orders: readonly unknown[]; carts: readonly unknown[]; branches: readonly unknown[]; refunds: readonly unknown[];
}
const invalid = (): never => { throw new ValidateException('累计限购购买与退款归属不一致，请核对订单'); };
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
}
function integer(value: unknown, min = 0, max = 2147483647): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : invalid();
}
function cartId(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value)) return invalid();
  integer(Number(value), 1); return value;
}
function branchId(value: unknown): string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value) ? value : invalid();
}
function array(value: unknown, max: number, min = 0): unknown[] {
  return Array.isArray(value) && value.length >= min && value.length <= max ? value : invalid();
}
function history(value: unknown): Map<number, string> {
  const result = new Map<number, string>();
  for (const raw of array(value, 201)) {
    const item = array(raw, 2, 2), id = integer(item[0], 1), hash = item[1];
    if (result.has(id) || typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) return invalid();
    result.set(id, hash);
  }
  return result;
}
function sameHistory(a: Map<number, string>, b: Map<number, string>) {
  return a.size === b.size && [...a].every(([id, hash]) => b.get(id) === hash);
}
function quantity(lines: Map<number, Line>): number { return [...lines.values()].reduce((sum, row) => sum + row.quantity, 0); }
function sameLine(a: Line | undefined, b: Line): boolean {
  return !!a && a.id === b.id && a.cartId === b.cartId && a.oldCartId === b.oldCartId
    && a.productId === b.productId && a.quantity === b.quantity;
}

/** Server-only structural proof of ONE paid payment family at one snapshot.
 * Receipts must come from readPurchaseQuotaRefundFamily, not HTTP/JSON input.
 * No allowance calculation, quota debit/release, financial approval or locking
 * authority is returned. A future writer still needs user/product serialization.
 * Hidden business rows are intentionally included; visibility is not a refund. */
export async function verifyPurchaseQuotaPaymentLedger(input: PurchaseQuotaPaymentEvidence,
  receipts: readonly PurchaseQuotaRefundReceipt[], expected: PurchaseQuotaPaymentScope): Promise<PurchaseQuotaPaymentLedger> {
  integer(expected.paymentOrderId, 1); integer(expected.buyerId, 1);
  array(receipts, 201); array(input.orders, 202, 1); array(input.carts, 40400, 1);
  array(input.branches, 400); array(input.refunds, 201);
  const orders = new Map<number, Order>();
  for (const value of input.orders) {
    const r = object(value), order: Order = { id: integer(r.id, 1), pid: integer(r.pid, -1), uid: integer(r.uid, 1),
      supplierId: integer(r.supplierId), storeId: integer(r.storeId), type: integer(r.type, 0, 8), paid: integer(r.paid, 0, 1),
      totalNum: integer(r.totalNum, 1), refundStatus: integer(r.refundStatus, 0, 3), refundType: integer(r.refundType, 0, 6) };
    if (orders.has(order.id) || order.uid !== expected.buyerId || order.paid !== 1
      || (order.id === expected.paymentOrderId ? ![0, -1].includes(order.pid) : order.pid !== expected.paymentOrderId)) return invalid();
    orders.set(order.id, order);
  }
  const root = orders.get(expected.paymentOrderId);
  if (!root || [...orders.values()].some(order => order.type !== root.type)
    || (root.pid === 0 ? orders.size !== 1 : orders.size < 2)) return invalid();
  const carts = new Map<number, Cart>(), live = new Map<number, Map<number, Line>>();
  for (const value of input.carts) {
    const r = object(value), info = object(r.snapshot), oid = integer(r.oid, 1), order = orders.get(oid);
    if (!order || r.uid !== expected.buyerId || info.valid !== true) return invalid();
    const marker = info.marker === null ? null : readRefundGenerationMarker(info.marker);
    const line: Cart = { id: integer(r.id, 1), oid, cartId: cartId(r.cartId), oldCartId: r.oldCartId === '' ? '' : cartId(r.oldCartId),
      productId: integer(r.productId, 1), quantity: integer(r.cartNum, 1, 32767), origin: 0,
      refundNum: integer(r.refundNum, 0, 32767), splitStatus: integer(r.splitStatus, 0, 2),
      splitSurplusNum: integer(r.splitSurplusNum, 0, 32767), marker };
    if (carts.has(line.id) || line.refundNum > line.quantity || line.splitSurplusNum > line.quantity
      || (marker ? info.version !== 'refund-order-line-finance-v1' || info.id !== line.cartId || Number(info.cartNum) !== line.quantity
        : info.version === 'refund-order-line-finance-v1')) return invalid();
    const rows = live.get(oid) ?? new Map<number, Line>();
    if ([...rows.values()].some(row => row.cartId === line.cartId) || rows.size >= 200) return invalid();
    rows.set(line.id, line); live.set(oid, rows); carts.set(line.id, line);
  }
  if ([...orders.values()].some(order => !live.has(order.id) || quantity(live.get(order.id)!) !== order.totalNum)) return invalid();
  const rootLines = live.get(root.id)!, rootByCart = new Map([...rootLines.values()].map(row => [row.cartId, row]));
  const byRefund = new Map<number, PurchaseQuotaRefundReceipt>(), outputOrders = new Set<number>();
  for (const receipt of receipts) {
    if (byRefund.has(receipt.refundId) || receipt.buyerId !== expected.buyerId || receipt.paymentOrderId !== root.id
      || !orders.has(receipt.sourceOrderId)) return invalid();
    byRefund.set(receipt.refundId, receipt);
    if (receipt.selectedOrderId !== receipt.sourceOrderId) outputOrders.add(receipt.selectedOrderId);
    if (receipt.remainingOrderId !== null && receipt.remainingOrderId !== receipt.sourceOrderId) outputOrders.add(receipt.remainingOrderId);
  }
  const branches = new Map<string, Branch>(), forks = new Map<string, Branch[]>();
  for (const value of input.branches) {
    const r = object(value), branch: Branch = { id: branchId(r.id), sourceBranchId: r.sourceBranchId === null ? null : branchId(r.sourceBranchId),
      sourceRefundId: integer(r.sourceRefundId), sourceOrderId: integer(r.sourceOrderId, 1), childOrderId: integer(r.childOrderId, 1),
      supplierId: integer(r.supplierId), storeId: integer(r.storeId), covered: history(r.covered), materialized: history(r.materialized),
      parts: array(r.partitions, 200, 1).map(value => { const part = object(value);
        if (Object.keys(part).length !== 4) return invalid();
        return { sourceRowId: integer(part.sourceRowId, 1), rowId: integer(part.rowId, 1),
          cartId: cartId(part.cartId), quantity: integer(part.quantity, 1, 32767) }; }) };
    if (branches.has(branch.id) || r.uid !== expected.buyerId || r.paymentOrderId !== root.id || branch.sourceOrderId === root.id
      || !orders.has(branch.sourceOrderId) || !orders.has(branch.childOrderId) || (!branch.sourceRefundId && !branch.sourceBranchId)
      || branch.id === branch.sourceBranchId) return invalid();
    branches.set(branch.id, branch);
    const key = JSON.stringify([branch.sourceOrderId, branch.sourceRefundId, branch.sourceBranchId]);
    const group = forks.get(key) ?? []; group.push(branch); forks.set(key, group);
    if (branch.childOrderId !== branch.sourceOrderId) outputOrders.add(branch.childOrderId);
  }
  for (const group of forks.values()) if (group.length !== 2 || group[0].childOrderId === group[1].childOrderId
    || group.filter(branch => branch.childOrderId === branch.sourceOrderId).length !== 1) return invalid();
  const rootFirst = receipts.some(r => r.sourceOrderId === root.id && !r.previousRefundId && !r.baseBranchId);
  const initial = rootFirst || root.pid === 0 ? [root] : [...orders.values()].filter(r => r.id !== root.id && !outputOrders.has(r.id));
  const nodes = new Map<number, Node>(), terminal = new Map<number, { node: Node; whole: boolean }>();
  const usedRows = new Set(rootLines.keys()), usedOrders = new Set<number>([root.id]), originals = new Map<number, number>();
  for (const order of initial) {
    const first = receipts.filter(r => r.sourceOrderId === order.id && !r.previousRefundId && !r.baseBranchId);
    if (first.length > 1) return invalid();
    const source: Line[] = first.length ? first[0].lines.map(row => ({ id: row.sourceRowId, cartId: row.sourceCartId,
      oldCartId: row.sourceOldCartId, productId: row.productId, quantity: row.selectedNum + row.remainingNum, origin: 0 }))
      : [...live.get(order.id)!.values()];
    const lines = new Map<number, Line>();
    for (const line of source) {
      const origin = rootByCart.get(order.id === root.id ? line.cartId : line.oldCartId || line.cartId);
      if (!origin || origin.productId !== line.productId || lines.has(line.id)
        || (order.id === root.id ? !sameLine(origin, line) : usedRows.has(line.id))) return invalid();
      originals.set(origin.id, (originals.get(origin.id) ?? 0) + line.quantity);
      usedRows.add(line.id); lines.set(line.id, { ...line, origin: origin.id });
    }
    usedOrders.add(order.id);
    nodes.set(order.id, { order, lines, previous: 0, branch: null, marker: null, covered: new Map(), materialized: new Map() });
  }
  if (!nodes.size || originals.size !== rootLines.size || [...rootLines].some(([id, row]) => originals.get(id) !== row.quantity)) return invalid();
  const pendingRefunds = new Map(byRefund), pendingForks = new Map(forks), consumed = new Set<number>(), consumedBranches = new Set<string>();
  const refunded = new Map<number, number>();
  const sameScope = (node: Node, record: { supplierId: number; storeId: number }) =>
    node.order.supplierId === record.supplierId && node.order.storeId === record.storeId;
  const destination = (source: Node, id: number, reused: boolean): Order => {
    const order = orders.get(id);
    if (!order || !sameScope(source, order) || (reused ? id !== source.order.id : usedOrders.has(id))
      || (!reused && id === root.id)) return invalid();
    usedOrders.add(id); return order;
  };
  const clone = (line: Line, id: number, count: number, reused: boolean): Line => {
    if (reused ? id !== line.id : usedRows.has(id)) return invalid();
    usedRows.add(id);
    return { ...line, id, quantity: count, cartId: reused ? line.cartId : String(id),
      oldCartId: reused ? line.oldCartId : line.oldCartId || line.cartId };
  };
  // Explicit dependency traversal. IDs/timestamps never substitute for lineage.
  while (pendingRefunds.size || pendingForks.size) {
    let progressed = false;
    for (const node of [...nodes.values()]) {
      const eligible = [...pendingRefunds.values()].filter(r => r.sourceOrderId === node.order.id
        && r.previousRefundId === node.previous && r.baseBranchId === node.branch);
      const forkKey = JSON.stringify([node.order.id, node.previous, node.branch]), fork = pendingForks.get(forkKey);
      if (eligible.length + (fork ? 1 : 0) > 1) return invalid();
      if (eligible.length) {
        const receipt = eligible[0], selected = new Map<number, Line>(), remaining = new Map<number, Line>();
        if (!sameScope(node, receipt) || receipt.lines.length !== node.lines.size) return invalid();
        const seen = new Set<number>();
        for (const part of receipt.lines) {
          const line = node.lines.get(part.sourceRowId);
          if (!line || seen.has(line.id) || line.productId !== part.productId || line.cartId !== part.sourceCartId
            || line.oldCartId !== part.sourceOldCartId || line.quantity !== part.selectedNum + part.remainingNum) return invalid();
          seen.add(line.id);
          if (part.selectedNum) {
            if (part.selectedRowId === null) return invalid();
            selected.set(part.selectedRowId, clone(line, part.selectedRowId, part.selectedNum, receipt.disposition === 'whole'));
            refunded.set(line.origin, (refunded.get(line.origin) ?? 0) + part.selectedNum);
          }
          if (part.remainingNum) {
            if (part.remainingRowId === null) return invalid();
            remaining.set(part.remainingRowId, clone(line, part.remainingRowId, part.remainingNum, receipt.remainingOrderId === node.order.id));
          }
        }
        const whole = receipt.disposition === 'whole', selectedOrder = destination(node, receipt.selectedOrderId, whole);
        if (!selected.size || terminal.has(selectedOrder.id) || selectedOrder.refundStatus !== 2 || selectedOrder.refundType !== 6) return invalid();
        nodes.delete(node.order.id);
        terminal.set(selectedOrder.id, { whole, node: { ...node, order: selectedOrder, lines: selected,
          marker: whole ? node.marker : { refundId: receipt.refundId, role: 'selected' } } });
        if (whole) { if (remaining.size || receipt.remainingOrderId !== null) return invalid(); }
        else {
          if (!remaining.size || receipt.remainingOrderId === null) return invalid();
          const remainder = destination(node, receipt.remainingOrderId, receipt.remainingOrderId === node.order.id);
          const covered = new Map(node.covered), materialized = new Map(node.materialized);
          covered.set(receipt.refundId, receipt.fingerprint);
          if (receipt.sourceOrderId === remainder.id) materialized.set(receipt.refundId, receipt.fingerprint);
          nodes.set(remainder.id, { ...node, order: remainder, lines: remaining, previous: receipt.refundId,
            marker: { refundId: receipt.refundId, role: 'remaining' }, covered, materialized });
        }
        pendingRefunds.delete(receipt.refundId); consumed.add(receipt.refundId); progressed = true;
      } else if (fork) {
        const totals = new Map<number, number>(); nodes.delete(node.order.id);
        for (const branch of fork) {
          const retained = branch.childOrderId === node.order.id;
          if (!sameScope(node, branch) || !sameHistory(branch.covered, retained ? node.covered : new Map())
            || !sameHistory(branch.materialized, retained ? node.materialized : new Map())) return invalid();
          const order = destination(node, branch.childOrderId, retained), lines = new Map<number, Line>(), sourceIds = new Set<number>();
          for (const part of branch.parts) {
            const line = node.lines.get(part.sourceRowId);
            if (!line || sourceIds.has(line.id) || lines.has(part.rowId)) return invalid();
            sourceIds.add(line.id);
            const next = clone(line, part.rowId, part.quantity, retained);
            // The fulfillment writer also normalizes oldCartId on retained rows.
            next.oldCartId = line.oldCartId || line.cartId;
            if (next.cartId !== part.cartId) return invalid();
            totals.set(line.id, (totals.get(line.id) ?? 0) + part.quantity); lines.set(next.id, next);
          }
          nodes.set(order.id, { order, lines, previous: 0, branch: branch.id, marker: { branchId: branch.id, role: 'remaining' },
            covered: new Map(branch.covered), materialized: new Map(branch.materialized) });
          consumedBranches.add(branch.id);
        }
        if (totals.size !== node.lines.size || [...node.lines].some(([id, row]) => totals.get(id) !== row.quantity)) return invalid();
        pendingForks.delete(forkKey); progressed = true;
      }
    }
    if (!progressed) return invalid();
  }
  const leaves = new Map([...nodes, ...[...terminal].map(([id, value]) => [id, value.node] as const)]);
  const expectedOrders = root.pid === -1 ? [...orders.values()].filter(r => r.id !== root.id) : [root];
  if (leaves.size !== expectedOrders.length || expectedOrders.some(order => !leaves.has(order.id))) return invalid();
  const reserved = new Map<number, number>(), pendingOrders = new Set<number>(), seenBusiness = new Set<number>();
  for (const value of input.refunds) {
    const r = object(value), id = integer(r.id, 1), orderId = integer(r.storeOrderId, 1), order = orders.get(orderId);
    if (seenBusiness.has(id) || !order || r.uid !== expected.buyerId || r.supplierId !== order.supplierId || r.storeId !== order.storeId) return invalid();
    seenBusiness.add(id);
    const receipt = byRefund.get(id);
    const identity = { id, storeOrderId: orderId, uid: expected.buyerId, supplierId: order.supplierId, storeId: order.storeId,
      orderId: typeof r.orderId === 'string' ? r.orderId : invalid(), refundNum: integer(r.refundNum, 1),
      refundPrice: typeof r.refundPrice === 'string' ? r.refundPrice : invalid(), cartInfo: typeof r.cartInfo === 'string' ? r.cartInfo : invalid() };
    if (receipt) {
      if (receipt.sourceOrderId !== orderId || r.refundType !== 6 || r.isCancel !== 0 || r.refundedPrice !== r.refundPrice
        || await refundOrderSplitFingerprint(identity) !== receipt.fingerprint) return invalid();
    } else if (r.refundType === 6) return invalid();
    else if (r.isCancel === 0 && r.isDel === 0 && [0, 1, 2, 4, 5].includes(integer(r.refundType, 0, 6))) {
      const node = nodes.get(orderId), claim = readRefundQuantityReservation(identity);
      if (!node || !claim || pendingOrders.has(orderId)) return invalid();
      pendingOrders.add(orderId);
      for (const item of claim.items) {
        const line = node.lines.get(item.rowId);
        if (!line || item.beforeRefundNum !== 0 || line.cartId !== String(item.cartId) || line.quantity !== item.totalNum) return invalid();
        reserved.set(line.id, item.cartNum);
      }
    }
  }
  const remaining = new Map<number, number>(), pending = new Map<number, number>();
  for (const node of leaves.values()) {
    const rows = live.get(node.order.id)!;
    if (rows.size !== node.lines.size || quantity(node.lines) !== node.order.totalNum
      || (nodes.has(node.order.id) && ![0, 1].includes(node.order.refundStatus))) return invalid();
    for (const line of node.lines.values()) {
      const row = carts.get(line.id), done = terminal.get(node.order.id);
      if (!sameLine(rows.get(line.id), line) || !row || JSON.stringify(row.marker) !== JSON.stringify(node.marker)) return invalid();
      if (done) {
        if (row.refundNum !== (done.whole ? 0 : row.quantity) || row.splitStatus !== 2 || row.splitSurplusNum !== 0) return invalid();
      } else {
        if (row.refundNum !== (reserved.get(row.id) ?? 0)) return invalid();
        remaining.set(line.origin, (remaining.get(line.origin) ?? 0) + line.quantity);
        pending.set(line.origin, (pending.get(line.origin) ?? 0) + (reserved.get(row.id) ?? 0));
      }
    }
  }
  const products = new Map<number, PurchaseQuotaPaymentLedger['products'][number]>();
  for (const row of rootLines.values()) {
    const returned = refunded.get(row.id) ?? 0, left = remaining.get(row.id) ?? 0, held = pending.get(row.id) ?? 0;
    if (returned + left !== row.quantity || held > left) return invalid();
    const product = products.get(row.productId) ?? { productId: row.productId, purchased: 0, refunded: 0, pending: 0, remaining: 0 };
    product.purchased += row.quantity; product.refunded += returned; product.pending += held; product.remaining += left;
    products.set(row.productId, product);
  }
  return { version: 'purchase-quota-payment-ledger-v1', ...expected, products: [...products.values()].sort((a, b) => a.productId - b.productId),
    refundIds: [...consumed].sort((a, b) => a - b), branchIds: [...consumedBranches].sort() };
}

/** Uses a caller-owned repeatable/serializable snapshot. Neither this result nor
 * an MVCC snapshot reserves quota against concurrent purchases. No visibility
 * filters, full customer snapshots, new privileges, external I/O or writes. */
export async function readPurchaseQuotaPaymentLedger(tx: Query, expected: PurchaseQuotaPaymentScope): Promise<PurchaseQuotaPaymentLedger> {
  integer(expected.paymentOrderId, 1); integer(expected.buyerId, 1);
  if (Object.hasOwn(tx, '$client')) return invalid();
  const [mode] = await tx.execute(sql`SELECT current_setting('transaction_isolation') AS isolation`);
  if (!['repeatable read', 'serializable'].includes(String(mode?.isolation))) return invalid();
  const orders = await tx.execute(sql`SELECT id, pid, uid, supplier_id AS "supplierId", store_id AS "storeId", type, paid,
    total_num AS "totalNum", refund_status AS "refundStatus", refund_type AS "refundType" FROM store_order
    WHERE id = ${expected.paymentOrderId} OR pid = ${expected.paymentOrderId} ORDER BY id LIMIT 203`);
  const root = orders.find(r => r.id === expected.paymentOrderId);
  if (!root || root.uid !== expected.buyerId || root.paid !== 1 || orders.length > 202) return invalid();
  const ids = sql.join(orders.map(row => sql`${integer(row.id, 1)}`), sql`, `);
  const carts = await tx.execute(sql`WITH candidates AS MATERIALIZED (
    SELECT id, oid, uid, product_id AS "productId", cart_id AS "cartId", old_cart_id AS "oldCartId", cart_num AS "cartNum",
      refund_num AS "refundNum", split_status AS "splitStatus", split_surplus_num AS "splitSurplusNum", cart_info
    FROM store_order_cart_info WHERE oid IN (${ids}) ORDER BY id LIMIT 40401
  ), parsed AS MATERIALIZED (
    SELECT *, CASE WHEN octet_length(cart_info) <= 65536 AND SUM(octet_length(cart_info)::bigint) OVER () <= 8388608
      THEN cart_info::jsonb ELSE NULL END AS info FROM candidates
  ) SELECT id, oid, uid, "productId", "cartId", "oldCartId", "cartNum", "refundNum", "splitStatus", "splitSurplusNum",
    jsonb_build_object('valid', jsonb_typeof(info) = 'object', 'marker', info->'refund_order_generation',
      'version', info->'financial_version', 'id', info->'id', 'cartNum', info->'cart_num') AS snapshot FROM parsed`);
  const branches = await tx.execute(sql`WITH candidates AS MATERIALIZED (
    SELECT id, source_branch_id AS "sourceBranchId", source_refund_id AS "sourceRefundId",
    source_order_id AS "sourceOrderId", payment_order_id AS "paymentOrderId", child_order_id AS "childOrderId", uid,
    supplier_id AS "supplierId", store_id AS "storeId", covered_refunds, materialized_refunds, partitions
    FROM store_order_fulfillment_branch WHERE child_order_id IN (${ids}) ORDER BY id LIMIT 401
  ), bounded AS MATERIALIZED (SELECT *, SUM(octet_length(covered_refunds)::bigint + octet_length(materialized_refunds)
    + octet_length(partitions)) OVER () <= 8388608 AS fits FROM candidates)
  SELECT id, "sourceBranchId", "sourceRefundId", "sourceOrderId", "paymentOrderId", "childOrderId", uid, "supplierId", "storeId",
    CASE WHEN fits AND octet_length(covered_refunds) <= 32768 THEN covered_refunds::jsonb ELSE NULL END AS covered,
    CASE WHEN fits AND octet_length(materialized_refunds) <= 32768 THEN materialized_refunds::jsonb ELSE NULL END AS materialized,
    CASE WHEN fits AND octet_length(partitions) <= 32768 THEN partitions::jsonb ELSE NULL END AS partitions FROM bounded`);
  const refunds = await tx.execute(sql`WITH candidates AS MATERIALIZED (
    SELECT id, store_order_id AS "storeOrderId", uid, supplier_id AS "supplierId", store_id AS "storeId", order_id AS "orderId",
      refund_num AS "refundNum", refund_price AS "refundPrice", refunded_price AS "refundedPrice", refund_type AS "refundType",
      is_cancel AS "isCancel", is_del AS "isDel", cart_info FROM store_order_refund
    WHERE store_order_id IN (${ids}) ORDER BY id LIMIT 202
  ) SELECT id, "storeOrderId", uid, "supplierId", "storeId", "orderId", "refundNum", "refundPrice", "refundedPrice", "refundType",
    "isCancel", "isDel", CASE WHEN octet_length(cart_info) <= 65536 AND SUM(octet_length(cart_info)::bigint) OVER () <= 8388608
      THEN cart_info ELSE NULL END AS "cartInfo" FROM candidates`);
  const receipts = await readPurchaseQuotaRefundFamily(tx, expected);
  return verifyPurchaseQuotaPaymentLedger({ orders, carts, branches, refunds }, receipts, expected);
}
