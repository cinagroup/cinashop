import { and, asc, eq, inArray } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeOrder, storeOrderCartInfo, supplierFlowingWater } from '@/models/schema';
import { ValidateException } from '@/utils/errors';

type Order = typeof storeOrder.$inferSelect;
const invalid = (): never => { throw new ValidateException('供应商拆单结算账本不一致，请先完成核对'); };
function minor(value: string): bigint {
  if (!/^\d{1,10}\.\d{2}$/.test(value)) return invalid();
  return BigInt(value.replace('.', ''));
}
function decimal(value: bigint): string {
  if (value < 0n || value > 999999999999n) return invalid();
  return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
}

/** Called only inside fulfillment's order/cart transaction, after both children
 * exist. Replace a pending entitlement, never the immutable payment transaction.
 * Retired rows retain all original amounts; derived IDs and remarks retain the
 * source-flow chain, including when the remaining order keeps its identity. */
export async function splitSupplierPendingPayment(
  tx: DbClient, source: Order, childIds: readonly [number, number], now: number,
): Promise<void> {
  if (source.supplierId === 0) return;
  if (source.supplierId < 0 || source.paid !== 1 || source.status !== 0 || minor(source.refundPrice) !== 0n
    || childIds[0] === childIds[1] || childIds.some(id => !Number.isSafeInteger(id) || id <= 0)) invalid();
  const children = await tx.select().from(storeOrder).where(inArray(storeOrder.id, [...childIds])).orderBy(asc(storeOrder.id));
  if (children.length !== 2) invalid();
  for (const child of children) {
    if (child.supplierId !== source.supplierId || child.uid !== source.uid || child.paid !== 1
      || child.pid !== (source.pid > 0 ? source.pid : source.id) || child.payType !== source.payType
      || child.shippingType !== source.shippingType || minor(child.refundPrice) !== 0n) invalid();
  }
  for (const field of ['payPrice', 'totalPrice', 'payPostage'] as const) {
    if (children.reduce((sum, child) => sum + minor(child[field]), 0n) !== minor(source[field])) invalid();
  }
  const rows = await tx.select().from(supplierFlowingWater).where(and(
    eq(supplierFlowingWater.supplierId, source.supplierId),
    inArray(supplierFlowingWater.linkId, [...new Set([source.orderId, ...children.map(child => child.orderId)])]),
    eq(supplierFlowingWater.type, 1), eq(supplierFlowingWater.pm, 1), eq(supplierFlowingWater.isDel, 0),
    inArray(supplierFlowingWater.status, [0, 1]),
  )).orderBy(asc(supplierFlowingWater.id)).limit(3).for('update');
  const original = rows[0];
  if (rows.length !== 1 || !original || original.status !== 0 || original.linkId !== source.orderId
    || original.uid !== source.uid || original.payType !== source.payType) invalid();
  for (const field of ['payPrice', 'totalPrice', 'payPostage'] as const) {
    if (minor(original[field]) !== minor(source[field])) invalid();
  }
  const carts = await tx.select().from(storeOrderCartInfo).where(inArray(storeOrderCartInfo.oid, [...childIds]))
    .orderBy(asc(storeOrderCartInfo.id)).limit(401);
  if (!carts.length || carts.length > 400) invalid();
  const amounts = new Map<number, bigint>();
  for (const child of children) {
    const lines = carts.filter(row => row.oid === child.id);
    let goods = 0n, quantity = 0;
    for (const row of lines) {
      if (row.uid !== source.uid || !Number.isSafeInteger(row.cartNum) || row.cartNum <= 0 || row.refundNum !== 0) invalid();
      goods += minor(row.settlePrice) * BigInt(row.cartNum);
      quantity += row.cartNum;
    }
    if (!lines.length || quantity !== child.totalNum) invalid();
    amounts.set(child.id, goods + ([2, 4].includes(child.shippingType) ? 0n : minor(child.payPostage)));
  }
  if ([...amounts.values()].reduce((sum, value) => sum + value, 0n) !== minor(original.number)) invalid();
  // No ON CONFLICT suppression: a colliding derived identity is inconsistent
  // evidence and must roll back the orders, carts, ledger and notice together.
  await tx.update(supplierFlowingWater).set({ status: -1, finishTime: now }).where(eq(supplierFlowingWater.id, original.id));
  await tx.insert(supplierFlowingWater).values(childIds.map(id => {
    const child = children.find(row => row.id === id)!;
    return {
      supplierId: child.supplierId, uid: child.uid, orderId: `S${original.id}-${child.id}`, linkId: child.orderId,
      pm: 1, type: 1, number: decimal(amounts.get(id)!), status: 0,
      payType: original.payType, payPrice: child.payPrice, totalPrice: child.totalPrice, payPostage: child.payPostage,
      tradeTime: original.tradeTime, addTime: now,
      remark: JSON.stringify({ version: 'supplier-split-income-v1', sourceFlowId: original.id, sourceOrderId: source.id }),
    };
  }));
}
