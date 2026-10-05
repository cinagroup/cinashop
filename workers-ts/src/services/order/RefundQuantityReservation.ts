import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeOrderCartInfo, storeOrderRefund } from '@/models/schema';
import { ValidateException } from '@/utils/errors';

const VERSION = 'refund-quantity-reservation-v1';
/** Durable server-selected execution contract. Never inferred from current
 * config during a callback/retry, and never accepted from an HTTP body. */
export const MATERIALIZED_REFUND_VERSION = 'refund-quantity-materialization-v2';
/** Customer HTTP selects physical row PKs. The immutable opaque catalogue key
 * is retained separately, so numeric alias collisions never select a peer. */
export const CUSTOMER_ROW_REFUND_VERSION = 'refund-quantity-customer-row-v3';
interface Selection { cartId: number; cartNum: number; sourceCartId?: string }
interface Claim extends Selection { rowId: number; beforeRefundNum: number; totalNum: number }
interface Reservation { version: typeof VERSION | typeof MATERIALIZED_REFUND_VERSION | typeof CUSTOMER_ROW_REFUND_VERSION; orderId: number; uid: number; items: Claim[] }
export function refundClaimCartKey(item:Claim):string{return item.sourceCartId??String(item.cartId);}
export function isMaterializedRefundClaim(claim:Reservation|null|undefined):claim is Reservation{return claim?.version===MATERIALIZED_REFUND_VERSION||claim?.version===CUSTOMER_ROW_REFUND_VERSION;}
type Refund = Pick<typeof storeOrderRefund.$inferSelect, 'storeOrderId' | 'uid' | 'refundNum' | 'cartInfo'>;
const invalid = () => new ValidateException('退款商品数量预占记录不一致，请人工核对');
function integer(value: unknown, zero = false): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (zero ? 0 : 1) || value > 2147483647) throw invalid();
  return value;
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw invalid();
  return value as Record<string, unknown>;
}
function selections(value: unknown,rowNamespace=false): Selection[] {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw invalid();
  const result = value.map(value => { const r = object(value, rowNamespace?['cartId','cartNum','sourceCartId']:['cartId', 'cartNum']);if(rowNamespace&&(typeof r.sourceCartId!=='string'||!r.sourceCartId||r.sourceCartId!==r.sourceCartId.trim()||Array.from(r.sourceCartId).length>128||/[\u0000-\u001f\u007f]/.test(r.sourceCartId)))throw invalid();return { cartId: integer(r.cartId), cartNum: integer(r.cartNum),...(rowNamespace?{sourceCartId:r.sourceCartId as string}:{}) }; });
  if (new Set(result.map(row => row.cartId)).size !== result.length) throw invalid();
  return result.sort((a, b) => a.cartId - b.cartId);
}
/** Absence is a pre-reservation application, not permission to manufacture a
 * claim. Once the marker is present every field/selector must validate exactly. */
export function readRefundQuantityReservation(refund: Refund): Reservation | null {
  if (!refund.cartInfo) return null;
  if (new TextEncoder().encode(refund.cartInfo).length > 65536) throw invalid();
  let value: unknown;
  try { value = JSON.parse(refund.cartInfo); }
  catch { if (refund.cartInfo.includes('quantityReservation')) throw invalid(); return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'quantityReservation')) return null;
  const snapshot = object(value, ['cartIds', 'quantityReservation']);
  const r = object(snapshot.quantityReservation, ['version', 'orderId', 'uid', 'items']);
  if ((r.version !== VERSION && r.version !== MATERIALIZED_REFUND_VERSION&&r.version!==CUSTOMER_ROW_REFUND_VERSION) || r.orderId !== refund.storeOrderId || r.uid !== refund.uid) throw invalid();
  const rowNamespace=r.version===CUSTOMER_ROW_REFUND_VERSION,orderId = integer(r.orderId), uid = integer(r.uid), selected = selections(snapshot.cartIds,rowNamespace);
  if (!Array.isArray(r.items) || r.items.length !== selected.length) throw invalid();
  const items = r.items.map(value => {
    const c = object(value, ['rowId', 'cartId', 'cartNum', 'beforeRefundNum', 'totalNum',...(rowNamespace?['sourceCartId']:[])]);
    const claim = { rowId: integer(c.rowId), cartId: integer(c.cartId), cartNum: integer(c.cartNum),
      beforeRefundNum: integer(c.beforeRefundNum, true), totalNum: integer(c.totalNum),...(rowNamespace?{sourceCartId:c.sourceCartId as string}:{}) };
    if(rowNamespace&&(claim.cartId!==claim.rowId||claim.sourceCartId!==selected.find(x=>x.cartId===claim.cartId)?.sourceCartId))throw invalid();
    if (claim.beforeRefundNum + claim.cartNum > claim.totalNum) throw invalid();
    return claim;
  }).sort((a, b) => a.cartId - b.cartId);
  if (new Set(items.map(row => row.rowId)).size !== items.length || items.reduce((sum, row) => sum + row.cartNum, 0) !== integer(refund.refundNum)
    || items.some((row, index) => row.cartId !== selected[index].cartId || row.cartNum !== selected[index].cartNum)) throw invalid();
  return { version: r.version, orderId, uid, items };
}
function transaction(tx: DbClient) {
  if (Object.hasOwn(tx, '$client')) throw Error('Refund quantity reservation requires the locked application transaction');
}
/** Called only after the shared order lock and final quote authorization. The
 * counter update and snapshot/application insert commit (or roll back) together. */
export async function reserveRefundQuantities(tx: DbClient, order: { id: number; uid: number }, input: readonly Selection[],
  version: Reservation['version'] = VERSION): Promise<string> {
  transaction(tx); integer(order.id); integer(order.uid);
  const rowNamespace=version===CUSTOMER_ROW_REFUND_VERSION,selected = selections(input,rowNamespace);
  const rows = await tx.select().from(storeOrderCartInfo)
    .where(and(eq(storeOrderCartInfo.oid, order.id), rowNamespace?inArray(storeOrderCartInfo.id,selected.map(row=>row.cartId)):inArray(storeOrderCartInfo.cartId, selected.map(row => String(row.cartId)))))
    .orderBy(asc(storeOrderCartInfo.id)).for('update');
  if (rows.length !== selected.length) throw invalid();
  const claims: Claim[] = [];
  for (const row of rows) {
    const selection = selected.find(item => rowNamespace?item.cartId===row.id&&item.sourceCartId===row.cartId:String(item.cartId) === row.cartId);
    if (!selection || row.uid !== order.uid) throw invalid();
    const claim = { rowId: integer(row.id), cartId: selection.cartId, cartNum: selection.cartNum,
      beforeRefundNum: integer(row.refundNum, true), totalNum: integer(row.cartNum),...(rowNamespace?{sourceCartId:row.cartId}:{}) };
    if (claim.beforeRefundNum + claim.cartNum > claim.totalNum) throw new ValidateException('退款数量超过尚未预占的商品数量');
    const changed = await tx.update(storeOrderCartInfo).set({ refundNum: claim.beforeRefundNum + claim.cartNum })
      .where(and(eq(storeOrderCartInfo.id, row.id), eq(storeOrderCartInfo.refundNum, claim.beforeRefundNum), eq(storeOrderCartInfo.cartNum, claim.totalNum)))
      .returning({ id: storeOrderCartInfo.id });
    if (changed.length !== 1) throw invalid();
    claims.push(claim);
  }
  const snapshot = JSON.stringify({ cartIds: selected, quantityReservation: { version, orderId: order.id, uid: order.uid, items: claims } });
  // Reuse the same strict parser as cancellation and settlement before insert.
  readRefundQuantityReservation({ storeOrderId: order.id, uid: order.uid, refundNum: selected.reduce((sum, row) => sum + row.cartNum, 0), cartInfo: snapshot });
  return snapshot;
}
/** Current rows must still hold exactly this claim. Never subtract another
 * request's reservation or silently repair counters after a conflicting edit. */
export async function assertRefundQuantitiesHeld(tx: DbClient, refund: Refund): Promise<boolean> {
  transaction(tx);
  const claim = readRefundQuantityReservation(refund); if (!claim) return false;
  const rows = await tx.select().from(storeOrderCartInfo).where(inArray(storeOrderCartInfo.id, claim.items.map(item => item.rowId)))
    .orderBy(asc(storeOrderCartInfo.id)).for('update');
  if (rows.length !== claim.items.length) throw invalid();
  for (const item of claim.items) {
    const row = rows.find(row => row.id === item.rowId);
    if (!row || row.oid !== claim.orderId || row.uid !== claim.uid || row.cartId !== refundClaimCartKey(item)
      || row.cartNum !== item.totalNum || row.refundNum !== item.beforeRefundNum + item.cartNum) throw invalid();
  }
  return true;
}
/** Caller guards one active -> cancelled/refused transition under refund/order
 * locks. Legacy applications have no claim and must never decrement counters. */
export async function releaseRefundQuantities(tx: DbClient, refund: Refund): Promise<void> {
  if (!await assertRefundQuantitiesHeld(tx, refund)) return;
  const claim = readRefundQuantityReservation(refund)!;
  for (const item of [...claim.items].sort((a, b) => a.rowId - b.rowId)) {
    const updated = await tx.update(storeOrderCartInfo).set({ refundNum: sql`${storeOrderCartInfo.refundNum} - ${item.cartNum}` })
      .where(and(eq(storeOrderCartInfo.id, item.rowId), eq(storeOrderCartInfo.oid, claim.orderId), eq(storeOrderCartInfo.uid, claim.uid),
        eq(storeOrderCartInfo.refundNum, item.beforeRefundNum + item.cartNum), eq(storeOrderCartInfo.cartNum, item.totalNum)))
      .returning({ id: storeOrderCartInfo.id });
    if (updated.length !== 1) throw invalid();
  }
}
