import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeOrder, storeOrderCartInfo, storeOrderRefund, storeOrderRefundSplit, supplierFlowingWater,
  supplierTransactions, user } from '@/models/schema';
import { refundOrderSplitFingerprint } from '@/services/order/RefundOrderSplitIdentity';

type Flow = typeof supplierFlowingWater.$inferSelect;
type Transaction = typeof supplierTransactions.$inferSelect;
const MAX_RECEIPTS = 201, MAX_FLOWS = MAX_RECEIPTS * 5 + 2;
const invalid = () => Error('预售退款供应商付款恢复凭据不一致');
const integer = (value: unknown, min = 0): value is number => typeof value === 'number'
  && Number.isSafeInteger(value) && value >= min && value <= 2147483647;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function minor(value: unknown): bigint {
  if (typeof value !== 'string' || !/^\d{1,10}\.\d{2}$/.test(value)) throw invalid();
  return BigInt(value.replace('.', ''));
}
function same(actual: object, expected: object, ignored: readonly string[] = []) {
  const left = object(actual), right = object(expected);
  const keys = Object.keys(right).filter(key => !ignored.includes(key));
  if (Object.keys(left).filter(key => !ignored.includes(key)).length !== keys.length
    || keys.some(key => left[key] !== right[key])) throw invalid();
}
const transactionKeys = ['id', 'supplierId', 'uid', 'orderId', 'linkId', 'pm', 'type', 'payType',
  'payPrice', 'totalPrice', 'payPostage', 'remark', 'mark', 'isDel', 'tradeTime', 'addTime'] as const;
const flowKeys = [...transactionKeys, 'number', 'finishTime', 'status'] as const;
function int(value: unknown, min = 0): number { if (!integer(value, min)) throw invalid(); return value; }
function text(value: unknown, max: number, required = false): string {
  if (typeof value !== 'string' || value.length > max || (required && !value)) throw invalid();
  return value;
}
function money(value: unknown): string { const result = text(value, 13, true); minor(result); return result; }
function financialRow(value: unknown, flow: true): Flow;
function financialRow(value: unknown, flow: false): Transaction;
function financialRow(value: unknown, flow: boolean): Flow | Transaction {
  const row = object(value), keys = flow ? flowKeys : transactionKeys;
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) throw invalid();
  if (row.isDel !== 0 || (row.pm !== 0 && row.pm !== 1) || (row.type !== 1 && row.type !== 2)) throw invalid();
  const common: Transaction = { id: int(row.id, 1), supplierId: int(row.supplierId, 1), uid: int(row.uid, 1),
    orderId: text(row.orderId, 50, true), linkId: text(row.linkId, 50, true), pm: row.pm, type: row.type,
    payType: text(row.payType, 20, true), payPrice: money(row.payPrice), totalPrice: money(row.totalPrice),
    payPostage: money(row.payPostage), remark: text(row.remark, 512), mark: text(row.mark, 255),
    isDel: 0, tradeTime: int(row.tradeTime), addTime: int(row.addTime) };
  if (!flow) return common;
  if (row.status !== 0 && row.status !== 1) throw invalid();
  if (row.status === 0 ? row.finishTime !== 0 : !integer(row.finishTime, 1)) throw invalid();
  return { ...common, number: money(row.number), finishTime: int(row.finishTime), status: row.status };
}

function lookupKeys(orderNos: string[]): string[] {
  if (!orderNos.length || orderNos.length > MAX_RECEIPTS + 2 || new Set(orderNos).size !== orderNos.length
    || orderNos.some(value => typeof value !== 'string' || !value || value.length > 50)) throw invalid();
  return orderNos;
}

/** Shared with the native capacity test: inspect the exact locking proof
 * query, including retired/deleted evidence, without replacing its planner. */
export function presaleSupplierFlowQuery(tx: Pick<DbClient, 'select'>, orderNos: string[]) {
  return tx.select().from(supplierFlowingWater).where(inArray(supplierFlowingWater.linkId, lookupKeys(orderNos)))
    .orderBy(asc(supplierFlowingWater.id)).limit(MAX_FLOWS + 1).for('share', { noWait: true });
}
export function presaleSupplierTransactionQuery(tx: Pick<DbClient, 'select'>, orderNos: string[]) {
  return tx.select().from(supplierTransactions).where(inArray(supplierTransactions.linkId, lookupKeys(orderNos)))
    .orderBy(asc(supplierTransactions.id)).limit(MAX_RECEIPTS * 2 + 3).for('share', { noWait: true });
}

/** Financial proof only, NOT authority to skip a refunded order or finish paid
 * effects. The caller must also validate the refund quantity/fulfillment graph.
 * No writes: lock root -> orders -> carts -> buyer -> supplier mutex -> ledger.
 * NOWAIT/try-lock keeps this safe when composed with already-owned paid locks.
 * No new order/user locks or external I/O may follow the supplier mutex. */
export async function assertPresaleSupplierRefundProof(tx: DbClient, paymentOrderId: number) {
  if (Object.hasOwn(tx, '$client') || !integer(paymentOrderId, 1)) throw invalid();
  await tx.execute(sql`SELECT set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
    set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1000)::text || 'ms',true),
    set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true)`);
  const [root] = await tx.select().from(storeOrder).where(eq(storeOrder.id, paymentOrderId)).limit(1).for('share', { noWait: true });
  if (!root || root.type !== 6 || ![0, 1, 2, 3, 4].includes(root.productType) || root.paid !== 1 || ![0, -1].includes(root.pid)
    || root.isDel || root.isSystemDel || root.supplierAllocationStatus !== 2) throw invalid();
  const children = await tx.select().from(storeOrder).where(eq(storeOrder.pid, root.id)).orderBy(asc(storeOrder.id))
    .limit(MAX_RECEIPTS + 2).for('share', { noWait: true });
  if (children.length > MAX_RECEIPTS + 1 || (root.pid === 0 ? children.length !== 0 : children.length === 0)) throw invalid();
  const orders = [root, ...children], byOrder = new Map(orders.map(order => [order.id, order]));
  const receipts = await tx.select({ refundId: storeOrderRefundSplit.refundId, sourceOrderId: storeOrderRefundSplit.sourceOrderId,
    paymentOrderId: storeOrderRefundSplit.paymentOrderId, selectedOrderId: storeOrderRefundSplit.selectedOrderId,
    remainingOrderId: storeOrderRefundSplit.remainingOrderId, supplierId: storeOrderRefundSplit.supplierId,
    storeId: storeOrderRefundSplit.storeId, uid: storeOrderRefundSplit.uid, fingerprint: storeOrderRefundSplit.fingerprint,
    disposition: storeOrderRefundSplit.disposition, baseBranchId: storeOrderRefundSplit.baseBranchId, addTime: storeOrderRefundSplit.addTime,
    ledger: sql<unknown>`CASE WHEN octet_length(${storeOrderRefundSplit.sourceSnapshot}) <= 16777216
      THEN CASE WHEN octet_length((${storeOrderRefundSplit.sourceSnapshot}::jsonb->'supplierLedger')::text) <= 32768
      THEN ${storeOrderRefundSplit.sourceSnapshot}::jsonb->'supplierLedger' END END`,
  }).from(storeOrderRefundSplit).where(eq(storeOrderRefundSplit.paymentOrderId, root.id))
    .orderBy(asc(storeOrderRefundSplit.refundId)).limit(MAX_RECEIPTS + 1);
  if (receipts.length > MAX_RECEIPTS) throw invalid();
  if (!receipts.length) return { coveredOrderIds: new Set<number>(), refundIds: new Set<number>() };
  const coveredOrderIds = new Set<number>(), supplierIds = new Set<number>();
  for (const receipt of receipts) {
    const source = byOrder.get(receipt.sourceOrderId), selected = byOrder.get(receipt.selectedOrderId);
    const remaining = receipt.remainingOrderId === null ? null : byOrder.get(receipt.remainingOrderId);
    if (!source || !selected || receipt.uid !== root.uid || receipt.baseBranchId !== null
      || !integer(receipt.supplierId) || !integer(receipt.storeId)
      || (receipt.disposition === 'whole' ? remaining !== null || selected.id !== source.id
        : receipt.disposition !== 'split' || !remaining || selected.id === remaining.id || selected.id === source.id)) throw invalid();
    for (const order of [source, selected, ...(remaining ? [remaining] : [])]) {
      if (order.uid !== root.uid || order.supplierId !== receipt.supplierId || order.storeId !== receipt.storeId
        || order.type !== 6 || order.productType !== root.productType || order.paid !== 1 || order.payType !== root.payType
        || order.supplierAllocationStatus !== 2 || order.isDel || order.isSystemDel) throw invalid();
      coveredOrderIds.add(order.id);
    }
    if (receipt.supplierId > 0) supplierIds.add(receipt.supplierId);
  }
  const carts = await tx.select({ id: storeOrderCartInfo.id, oid: storeOrderCartInfo.oid, uid: storeOrderCartInfo.uid,
    cartNum: storeOrderCartInfo.cartNum, settlePrice: storeOrderCartInfo.settlePrice }).from(storeOrderCartInfo)
    .where(inArray(storeOrderCartInfo.oid, [...coveredOrderIds])).orderBy(asc(storeOrderCartInfo.id))
    .limit((MAX_RECEIPTS + 2) * 200 + 1).for('share', { noWait: true });
  if (carts.length > (MAX_RECEIPTS + 2) * 200) throw invalid();
  const [buyer] = await tx.select({ uid: user.uid }).from(user).where(eq(user.uid, root.uid)).limit(1).for('update', { noWait: true });
  if (!buyer) throw invalid();
  for (const id of [...supplierIds].sort((a, b) => a - b)) {
    const [lock] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${id}::bigint) AS acquired`);
    if (lock.acquired !== true) throw Error('预售供应商财务正在处理，请重试');
  }
  const scopedOrders = orders.filter(order => coveredOrderIds.has(order.id));
  const orderNos = scopedOrders.map(order => order.orderId);
  const flows = await presaleSupplierFlowQuery(tx, orderNos);
  const transactions = await presaleSupplierTransactionQuery(tx, orderNos);
  if (flows.length > MAX_FLOWS || transactions.length > MAX_RECEIPTS * 2 + 2) throw invalid();
  const byFlow = new Map(flows.map(flow => [flow.id, flow])), byTransaction = new Map(transactions.map(row => [row.id, row]));
  const expectedFlows = new Set<number>(), expectedTransactions = new Set<number>(), consumedIncome = new Map<number, number>();
  const derivedChecks: Array<{ receipt: typeof receipts[number]; income: Flow; expense: Flow; ids: number[] }> = [];
  for (const receipt of receipts) {
    const [refund] = await tx.select({ id: storeOrderRefund.id, uid: storeOrderRefund.uid, storeOrderId: storeOrderRefund.storeOrderId,
      supplierId: storeOrderRefund.supplierId, storeId: storeOrderRefund.storeId, orderId: storeOrderRefund.orderId,
      refundType: storeOrderRefund.refundType, isCancel: storeOrderRefund.isCancel, refundPrice: storeOrderRefund.refundPrice,
      refundedPrice: storeOrderRefund.refundedPrice, refundNum: storeOrderRefund.refundNum,
      cartInfo: sql<string | null>`CASE WHEN octet_length(${storeOrderRefund.cartInfo}) <= 65536 THEN ${storeOrderRefund.cartInfo} END`,
    }).from(storeOrderRefund).where(eq(storeOrderRefund.id, receipt.refundId)).limit(1).for('share', { noWait: true });
    if (!refund || refund.uid !== root.uid || refund.storeOrderId !== receipt.sourceOrderId || refund.supplierId !== receipt.supplierId
      || refund.storeId !== receipt.storeId || refund.refundType !== 6 || refund.isCancel
      || refund.refundPrice !== refund.refundedPrice || await refundOrderSplitFingerprint(refund) !== receipt.fingerprint) throw invalid();
    if (receipt.supplierId === 0) { if (receipt.ledger !== null) throw invalid(); continue; }
    const ledger = object(receipt.ledger);
    if (Object.keys(ledger).length !== 5 || ledger.version !== 'supplier-refund-ledger-v1'
      || !Array.isArray(ledger.derivedFlowIds) || ledger.derivedFlowIds.some(id => !integer(id, 1))) throw invalid();
    const income = financialRow(ledger.income, true), expense = financialRow(ledger.expense, true), transaction = financialRow(ledger.transaction, false);
    const source = byOrder.get(receipt.sourceOrderId)!;
    for (const row of [income, expense, transaction]) if (row.supplierId !== source.supplierId || row.uid !== source.uid
      || row.linkId !== source.orderId || row.payType !== source.payType) throw invalid();
    if (income.pm !== 1 || income.type !== 1 || expense.pm !== 0 || expense.type !== 2
      || income.status !== expense.status || expense.orderId !== `R${receipt.refundId}-${source.orderId}`
      || expense.payPrice !== refund.refundedPrice || expense.payPostage !== '0.00'
      || expense.totalPrice !== income.totalPrice || transaction.orderId !== expense.orderId || transaction.pm !== 0 || transaction.type !== 2
      || transaction.payPrice !== expense.payPrice || transaction.totalPrice !== expense.totalPrice || transaction.payPostage !== expense.payPostage
      || consumedIncome.has(income.id) || expectedFlows.has(expense.id) || expectedTransactions.has(transaction.id)) throw invalid();
    consumedIncome.set(income.id, source.id);
    const actualIncome = byFlow.get(income.id), actualExpense = byFlow.get(expense.id), actualTransaction = byTransaction.get(transaction.id);
    if (!actualIncome || !actualExpense || !actualTransaction) throw invalid();
    same(actualTransaction, transaction);
    const whole = receipt.disposition === 'whole';
    same(actualIncome, { ...income, status: whole ? income.status : -1 });
    same(actualExpense, { ...expense, status: whole ? expense.status : -1 });
    if (whole && (income.status !== 1 || minor(income.number) !== minor(expense.number))) throw invalid();
    const ids: number[] = ledger.derivedFlowIds.filter((id): id is number => integer(id, 1));
    if (ids.length !== (whole ? 0 : 3) || new Set(ids).size !== ids.length) throw invalid();
    expectedFlows.add(income.id); expectedFlows.add(expense.id); expectedTransactions.add(transaction.id);
    derivedChecks.push({ receipt, income, expense, ids });
  }
  const declaredDerived = new Set<number>();
  for (const { receipt, income, expense, ids } of derivedChecks) {
    if (!ids.length) continue;
    for (const id of ids) { if (declaredDerived.has(id)) throw invalid(); declaredDerived.add(id); }
    const derived = ids.map(id => { const flow = byFlow.get(id); if (!flow) throw invalid(); return flow; });
    const selected = byOrder.get(receipt.selectedOrderId)!, remaining = byOrder.get(receipt.remainingOrderId!)!;
    const selectedIncome = derived.find(row => row.orderId === `S${income.id}-${selected.id}`);
    const remainingIncome = derived.find(row => row.orderId === `S${income.id}-${remaining.id}`);
    const selectedExpense = derived.find(row => row.orderId === `D${expense.id}-${selected.id}`);
    if (!selectedIncome || !remainingIncome || !selectedExpense || new Set([selectedIncome.id, remainingIncome.id, selectedExpense.id]).size !== 3
      || minor(selectedIncome.number) !== minor(expense.number)
      || minor(selectedIncome.number) + minor(remainingIncome.number) !== minor(income.number)) throw invalid();
    for (const key of ['payPrice', 'totalPrice', 'payPostage'] as const)
      if (minor(selectedIncome[key]) + minor(remainingIncome[key]) !== minor(income[key])) throw invalid();
    for (const [row, base, child, role] of [[selectedIncome, income, selected, 'selected'],
      [remainingIncome, income, remaining, 'remaining'], [selectedExpense, expense, selected, 'selected']] as const) {
      const lineage = JSON.stringify({ version: 'supplier-refund-split-v1', refundId: receipt.refundId,
        sourceFlowId: base.id, sourceOrderId: receipt.sourceOrderId, role });
      same(row, { ...base, id: row.id, orderId: row.orderId, linkId: child.orderId, number: row.number,
        payPrice: row.payPrice, totalPrice: row.totalPrice, payPostage: row.payPostage, remark: lineage }, ['status', 'finishTime']);
      if (row === selectedExpense && (row.number !== expense.number || row.payPrice !== expense.payPrice
        || row.totalPrice !== selectedIncome.totalPrice || row.payPostage !== '0.00')) throw invalid();
      if (role === 'selected' && (row.status !== 1 || row.finishTime !== (base.status === 1 ? base.finishTime : receipt.addTime))) throw invalid();
      if (role === 'remaining' && consumedIncome.has(row.id)) {
        if (consumedIncome.get(row.id) !== child.id) throw invalid();
      } else {
        if (![0, 1].includes(row.status) || (role === 'remaining' && row.status !== (child.status >= 2 || child.refundStatus === 2 ? 1 : 0))) throw invalid();
        if (row.status === 0 ? row.finishTime !== 0 : !integer(row.finishTime, 1)) throw invalid();
        if (row.pm === 1) for (const key of ['payPrice', 'totalPrice', 'payPostage'] as const) if (row[key] !== child[key]) throw invalid();
      }
      expectedFlows.add(row.id);
    }
  }
  for (const { income } of derivedChecks) {
    if (declaredDerived.has(income.id)) continue;
    if (income.orderId !== `P${income.linkId}` || !transactions.some(row => row.orderId === income.orderId)) throw invalid();
  }
  // Only genuine initial P transactions may remain in addition to the exact
  // refund transactions. A new P for an S-derived child is duplicate income.
  for (const row of transactions.filter(row => !expectedTransactions.has(row.id))) {
    const matching = flows.find(flow => flow.orderId === row.orderId && expectedFlows.has(flow.id));
    if (!matching || row.orderId !== `P${row.linkId}` || matching.pm !== 1 || matching.type !== 1) throw invalid();
    const { number: _number, finishTime: _finish, status: _status, ...common } = matching;
    same(row, { ...common, id: row.id }); expectedTransactions.add(row.id);
  }
  if (flows.some(flow => !expectedFlows.has(flow.id)) || transactions.some(row => !expectedTransactions.has(row.id))) throw invalid();
  for (const order of scopedOrders.filter(order => order.supplierId > 0 && order.pid >= 0)) {
    const live = flows.filter(flow => flow.linkId === order.orderId && flow.status >= 0);
    const income = live.find(flow => flow.pm === 1 && flow.type === 1), expense = live.find(flow => flow.pm === 0 && flow.type === 2);
    const lines = carts.filter(cart => cart.oid === order.id);
    if (!income || live.length !== (order.refundStatus === 2 ? 2 : 1) || (order.refundStatus === 2 && !expense)
      || !lines.length || lines.length > 200 || lines.some(cart => cart.uid !== root.uid || !integer(cart.cartNum, 1))
      || lines.reduce((sum, cart) => sum + cart.cartNum, 0) !== order.totalNum) throw invalid();
    const settlement = lines.reduce((sum, cart) => sum + minor(cart.settlePrice) * BigInt(cart.cartNum),
      [2, 4].includes(order.shippingType) ? 0n : minor(order.payPostage));
    if (minor(income.number) !== settlement || (expense && minor(expense.number) !== settlement)) throw invalid();
    for (const key of ['payPrice', 'totalPrice', 'payPostage'] as const) if (income[key] !== order[key]) throw invalid();
    if (expense && (expense.payPrice !== order.refundPrice || expense.totalPrice !== order.totalPrice || expense.payPostage !== '0.00')) throw invalid();
  }
  return { coveredOrderIds, refundIds: new Set(receipts.map(receipt => receipt.refundId)) };
}
