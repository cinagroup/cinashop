import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import { withTx, type Container } from '@/lib/di';
import { storeOrder, storeOrderCartInfo } from '@/models/schema';
import { NotFoundException, ValidateException } from '@/utils/errors';

const header = {
  id: storeOrder.id, pid: storeOrder.pid, order_id: storeOrder.orderId,
  total_num: storeOrder.totalNum, pay_price: storeOrder.payPrice,
  paid: storeOrder.paid, status: storeOrder.status, refund_status: storeOrder.refundStatus,
  product_type: storeOrder.productType, delivery_type: storeOrder.deliveryType,
  delivery_name: storeOrder.deliveryName, delivery_code: storeOrder.deliveryCode,
  delivery_id: storeOrder.deliveryId, fictitious_content: storeOrder.fictitiousContent,
};
const scope = { uid: storeOrder.uid, storeId: storeOrder.storeId, supplierId: storeOrder.supplierId };
function identity(id: number) {
  if (!Number.isSafeInteger(id) || id <= 0 || id > 2_147_483_647) throw new ValidateException('订单查询身份错误');
}
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function snapshot(value: string | null) {
  if (value === null || value === '') return null;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new ValidateException('订单商品快照无法读取'); }
  const record = object(parsed);
  if (!record) throw new ValidateException('订单商品快照无法读取');
  return record;
}

/** Historical shipment/refund family, not the pending-delivery selector.
 * Preserve the established snake-case Supplier DTO and customer-deleted history. */
export class SupplierSplitOrderReadService {
  constructor(private readonly container: Container) {}

  async read(supplierId: number, orderId: number) {
    identity(supplierId); identity(orderId);
    return withTx(this.container, async db => {
      await db.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await db.execute(sql`SELECT set_config('statement_timeout',
        LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true)`);
      const [reference] = await db.select({ ...header, ...scope }).from(storeOrder).where(and(
        eq(storeOrder.id, orderId), eq(storeOrder.supplierId, supplierId), eq(storeOrder.isSystemDel, 0),
      )).limit(1);
      if (!reference) throw new NotFoundException('订单不存在或不属于当前供应商');
      const rootId = reference.pid > 0 ? reference.pid : reference.id;
      const [root] = rootId === reference.id ? [reference] : await db.select({ ...header, ...scope }).from(storeOrder).where(and(
        eq(storeOrder.id, rootId), eq(storeOrder.uid, reference.uid), eq(storeOrder.isSystemDel, 0),
        // Completed multi-supplier allocation roots are platform-owned. Only a
        // scoped child may resolve them, never a direct root request.
        or(and(eq(storeOrder.supplierId, supplierId), eq(storeOrder.storeId, reference.storeId)),
          and(eq(storeOrder.supplierId, 0), eq(storeOrder.pid, -1), eq(storeOrder.supplierAllocationStatus, 2))),
      )).limit(1);
      if (!root) throw new NotFoundException('主订单不存在或不属于当前供应商');
      const children = await db.select(header).from(storeOrder).where(and(
        eq(storeOrder.pid, root.id), eq(storeOrder.supplierId, supplierId),
        eq(storeOrder.uid, reference.uid), eq(storeOrder.storeId, reference.storeId), eq(storeOrder.isSystemDel, 0),
      )).orderBy(asc(storeOrder.id)).limit(201);
      if (children.length > 200) throw new ValidateException('拆单明细过多，请核对');
      // Keep PHP/TS's existing no-visible-children historical fallback, but
      // never return a platform-owned root or its mixed-supplier snapshots.
      const { uid: _uid, storeId: _storeId, supplierId: rootSupplier, ...rootHeader } = root;
      const orders = children.length ? children : rootSupplier === supplierId ? [rootHeader] : [];
      if (!orders.length) return [];
      const bytes = sql`COALESCE(octet_length(${storeOrderCartInfo.cartInfo})::bigint,0)`;
      const carts = await db.select({
        id: storeOrderCartInfo.id, oid: storeOrderCartInfo.oid, uid: storeOrderCartInfo.uid,
        type: storeOrderCartInfo.type, relationId: storeOrderCartInfo.relationId,
        cart_id: storeOrderCartInfo.cartId, product_id: storeOrderCartInfo.productId,
        sku_unique: storeOrderCartInfo.skuUnique, cart_num: storeOrderCartInfo.cartNum,
        refund_num: storeOrderCartInfo.refundNum, surplus_num: storeOrderCartInfo.splitSurplusNum,
        raw: sql<string | null>`CASE WHEN ${bytes}<=65536 THEN ${storeOrderCartInfo.cartInfo} ELSE NULL END`,
        oversized: sql<boolean>`${bytes}>65536`,
      }).from(storeOrderCartInfo).where(inArray(storeOrderCartInfo.oid, orders.map(order => order.id)))
        .orderBy(asc(storeOrderCartInfo.id)).limit(201);
      if (carts.length > 200) throw new ValidateException('拆单商品明细过多，请核对');
      const groups = new Map<number, typeof carts>();
      for (const cart of carts) {
        const group = groups.get(cart.oid) ?? []; group.push(cart); groups.set(cart.oid, group);
      }
      return orders.map(order => {
        const group = groups.get(order.id) ?? [];
        const legacyOwnership = group.every(cart => cart.type === 0 && cart.relationId === 0);
        const cartInfo = group.map(cart => {
          if (cart.uid !== reference.uid || cart.oversized || (!legacyOwnership
            && (cart.relationId !== supplierId || ![0, 2].includes(cart.type)))) {
            throw new ValidateException('订单商品归属不一致或明细过大，请核对');
          }
          const { oid: _oid, uid: _cartUid, type: _type, relationId: _relation, raw, oversized: _oversized, ...row } = cart;
          const record = snapshot(raw), product = object(record?.product), productInfo = object(record?.productInfo);
          const sku = object(record?.sku), attrInfo = object(productInfo?.attrInfo);
          return { ...row,
            product_name: String(product?.storeName ?? productInfo?.store_name ?? '商品快照'),
            image: String(product?.image ?? productInfo?.image ?? ''),
            sku: String(sku?.suk ?? attrInfo?.suk ?? row.sku_unique), cart_info: record,
          };
        });
        return { ...order, cart_info: cartInfo };
      });
    });
  }
}
