import { asc, inArray, sql } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { storeOrderCartInfo } from '@/models/schema';
import { ValidateException } from '@/utils/errors';

export function supplierReadIdentity(id: number) {
  if (!Number.isSafeInteger(id) || id <= 0 || id > 2_147_483_647) throw new ValidateException('订单查询身份错误');
}
export function supplierSingleQuery(query: Record<string, string[]>): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = Object.create(null);
  for (const [key, values] of Object.entries(query)) {
    if (values.length !== 1) throw new ValidateException('查询参数不能重复');
    result[key] = values[0];
  }
  return result;
}
export function supplierReadSnapshot<T>(container: Container, read: (db: DbClient) => Promise<T>) {
  return withTx(container, async db => {
    await db.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    await db.execute(sql`SELECT set_config('statement_timeout',
      LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true)`);
    return read(db);
  });
}
export function supplierSnapshotObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
export function parseSupplierSnapshot(raw: string | null, maximumBytes: number) {
  if (raw === null || raw === '') return null;
  if (new TextEncoder().encode(raw).length > maximumBytes) throw new ValidateException('订单商品快照过大');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new ValidateException('订单商品快照无法读取'); }
  const record = supplierSnapshotObject(parsed);
  if (!record) throw new ValidateException('订单商品快照无法读取');
  return record;
}

/** Call inside the caller's read snapshot. Validate the complete order/cart
 * collection before filtering deliverable rows or projecting printable prices. */
export async function readSupplierCarts(db: DbClient, supplierId: number,
  orders: ReadonlyArray<{ id: number; uid: number }>, maximumBytes = 65536, maximumRows = 200) {
  if (!Number.isInteger(maximumRows) || maximumRows < 1 || maximumRows > 2000) throw new ValidateException('商品读取范围错误');
  const bytes = sql`COALESCE(octet_length(${storeOrderCartInfo.cartInfo})::bigint,0)`;
  // Window budget is evaluated before LIMIT, so a large family cannot transfer
  // an unbounded aggregate even when every individual snapshot is permitted.
  const oversized = sql`${bytes}>${maximumBytes} OR SUM(${bytes}) OVER ()>8388608`;
  const carts = await db.select({
    id: storeOrderCartInfo.id, oid: storeOrderCartInfo.oid, uid: storeOrderCartInfo.uid,
    type: storeOrderCartInfo.type, relationId: storeOrderCartInfo.relationId,
    cartId: storeOrderCartInfo.cartId, productId: storeOrderCartInfo.productId,
    skuUnique: storeOrderCartInfo.skuUnique, cartNum: storeOrderCartInfo.cartNum,
    refundNum: storeOrderCartInfo.refundNum, splitSurplusNum: storeOrderCartInfo.splitSurplusNum,
    splitStatus: storeOrderCartInfo.splitStatus, settlePrice: storeOrderCartInfo.settlePrice,
    cartInfo: sql<string | null>`CASE WHEN NOT (${oversized}) THEN ${storeOrderCartInfo.cartInfo} ELSE NULL END`,
    oversized: sql<boolean>`${oversized}`,
  }).from(storeOrderCartInfo).where(inArray(storeOrderCartInfo.oid, orders.map(order => order.id)))
    .orderBy(asc(storeOrderCartInfo.id)).limit(maximumRows + 1);
  if (carts.length > maximumRows) throw new ValidateException('订单商品明细过多，请缩小范围');
  const counts = new Map<number, number>();
  for (const cart of carts) {
    const count = (counts.get(cart.oid) ?? 0) + 1; counts.set(cart.oid, count);
    if (count > 200) throw new ValidateException('单个订单商品明细过多，请核对');
  }
  const owners = new Map(orders.map(order => [order.id, order.uid]));
  const legacy = new Set(orders.map(order => order.id));
  for (const cart of carts) if (cart.type !== 0 || cart.relationId !== 0) legacy.delete(cart.oid);
  return carts.map(cart => {
    if (cart.uid !== owners.get(cart.oid) || cart.oversized || (!legacy.has(cart.oid)
      && (cart.relationId !== supplierId || ![0, 2].includes(cart.type)))) {
      throw new ValidateException('订单商品归属不一致或明细过大，请核对');
    }
    const { oversized: _oversized, ...row } = cart;
    return { ...row, snapshot: parseSupplierSnapshot(row.cartInfo, maximumBytes) };
  });
}

export function supplierDisplayCart(row: Awaited<ReturnType<typeof readSupplierCarts>>[number]) {
  const record = row.snapshot, product = supplierSnapshotObject(record?.product), productInfo = supplierSnapshotObject(record?.productInfo);
  const sku = supplierSnapshotObject(record?.sku), attrInfo = supplierSnapshotObject(productInfo?.attrInfo);
  return {
    id: row.id, cart_id: row.cartId, product_id: row.productId, sku_unique: row.skuUnique,
    cart_num: row.cartNum, refund_num: row.refundNum, surplus_num: row.splitSurplusNum,
    product_name: String(product?.storeName ?? productInfo?.store_name ?? '商品快照'),
    image: String(product?.image ?? productInfo?.image ?? ''),
    sku: String(sku?.suk ?? attrInfo?.suk ?? row.skuUnique), cart_info: record,
  };
}
