import { and, asc, desc, eq, getTableColumns, gte, ilike, or, sql, type SQL } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { storeOrder, storeOrderCartInfo } from '@/models/schema';
import { NotFoundException, ValidateException } from '@/utils/errors';

const maximumId = 2_147_483_647;
export type SupplierOrderQuery = Record<string, string | string[]>;
function parameter(query: SupplierOrderQuery, name: string) {
  const value = query[name];
  if (Array.isArray(value)) {
    if (value.length !== 1) throw new ValidateException('订单查询参数重复');
    return value[0];
  }
  return value;
}
function integer(value: string | undefined, fallback: number, min: number, max: number) {
  if (value === undefined || value === '') return fallback;
  if (!/^\d{1,10}$/.test(value)) throw new ValidateException('订单查询参数错误');
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new ValidateException('订单查询参数错误');
  return n;
}
function identity(id: number) {
  if (!Number.isSafeInteger(id) || id <= 0 || id > maximumId) throw new ValidateException('订单查询身份错误');
}
function text(value: string | undefined, maximum: number) {
  if (value === undefined) return '';
  if (value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) throw new ValidateException('订单查询参数错误');
  return value.trim();
}

// Preserve the established Supplier snake-case DTO. Only bounded scalar header
// fields cross the wire; no SELECT * of unrelated private/TEXT order columns.
const header = {
  id: storeOrder.id, pid: storeOrder.pid, order_id: storeOrder.orderId,
  real_name: storeOrder.realName, user_phone: storeOrder.userPhone,
  total_num: storeOrder.totalNum, pay_price: storeOrder.payPrice,
  paid: storeOrder.paid, status: storeOrder.status, pay_type: storeOrder.payType,
  refund_status: storeOrder.refundStatus, shipping_type: storeOrder.shippingType,
  product_type: storeOrder.productType, delivery_type: storeOrder.deliveryType,
  delivery_name: storeOrder.deliveryName, delivery_code: storeOrder.deliveryCode,
  delivery_id: storeOrder.deliveryId, fictitious_content: storeOrder.fictitiousContent,
  remark: storeOrder.remark, add_time: storeOrder.addTime, pay_time: storeOrder.payTime,
};
const visible = (supplierId: number) => and(eq(storeOrder.supplierId, supplierId), eq(storeOrder.isSystemDel, 0));

/** Existing flat Supplier list/info contracts, not PHP's full grouped lst,
 * picking sheets, split shipments or reporting. Authenticated route middleware
 * supplies the tenant. Customer-side deletion does not erase staff history. */
export class SupplierOrderReadService {
  constructor(private readonly container: Container) {}

  private snapshot<T>(read: (db: DbClient) => Promise<T>) {
    return withTx(this.container, async db => {
      await db.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await db.execute(sql`SELECT set_config('statement_timeout',
        LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true)`);
      return read(db);
    });
  }

  async list(supplierId: number, query: SupplierOrderQuery) {
    identity(supplierId);
    const page = integer(parameter(query, 'page'), 1, 1, 10000);
    const limit = integer(parameter(query, 'limit'), 20, 1, 100);
    const name = text(parameter(query, 'real_name'), 256), order = text(parameter(query, 'order'), 256);
    const paid = parameter(query, 'paid'), status = parameter(query, 'status');
    const payType = text(parameter(query, 'pay_type'), 32);
    const conditions: SQL[] = [visible(supplierId)!, gte(storeOrder.pid, 0)];
    // Keep the existing keyword precedence and wildcard search contract.
    const keyword = name || order;
    if (keyword) conditions.push(or(ilike(storeOrder.orderId, `%${keyword}%`),
      ilike(storeOrder.realName, `%${keyword}%`), ilike(storeOrder.userPhone, `%${keyword}%`))!);
    if (paid !== undefined && paid !== '') conditions.push(eq(storeOrder.paid, integer(paid, 0, 0, 1)));
    if (status !== undefined && status !== '') conditions.push(eq(storeOrder.status, integer(status, 0, 0, 5)));
    if (payType) conditions.push(eq(storeOrder.payType, payType));
    return this.snapshot(async db => {
      const where = and(...conditions);
      const list = await db.select(header).from(storeOrder).where(where)
        .orderBy(desc(storeOrder.id)).limit(limit).offset((page - 1) * limit);
      const [count] = await db.select({ count: sql<number>`COUNT(*)::integer` }).from(storeOrder).where(where);
      return { list, count: count.count, page, limit };
    });
  }

  async detail(supplierId: number, orderId: number) {
    identity(supplierId); identity(orderId);
    return this.snapshot(async db => {
      const [source] = await db.select({ ...header, ownerUid: storeOrder.uid }).from(storeOrder)
        .where(and(eq(storeOrder.id, orderId), visible(supplierId))).limit(1);
      if (!source) throw new NotFoundException('订单不存在或不属于当前供应商');
      const { ownerUid, ...order } = source;
      // Guard both variable-width fields before SQL sends them to the Worker.
      const bytes = sql`COALESCE(octet_length(${storeOrderCartInfo.cartInfo})::bigint,0)
        +COALESCE(octet_length(${storeOrderCartInfo.promotionsId}),0)`;
      const carts = await db.select({ ...getTableColumns(storeOrderCartInfo),
        cartInfo: sql<string | null>`CASE WHEN ${bytes}<=65536 THEN ${storeOrderCartInfo.cartInfo} ELSE NULL END`,
        promotionsId: sql<string | null>`CASE WHEN ${bytes}<=65536 THEN ${storeOrderCartInfo.promotionsId} ELSE NULL END`,
        oversized: sql<boolean>`${bytes}>65536`,
      }).from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, order.id)).orderBy(asc(storeOrderCartInfo.id)).limit(201);
      const legacyOwnership = carts.every(cart => cart.type === 0 && cart.relationId === 0);
      if (carts.length > 200 || carts.some(cart => cart.uid !== ownerUid || cart.oversized
        || (!legacyOwnership && (cart.relationId !== supplierId || ![0, 2].includes(cart.type))))) {
        throw new ValidateException('订单商品归属不一致或明细过大，请核对');
      }
      const cartInfo = carts.map(cart => {
        const { oversized: _oversized, ...row } = cart;
        // Preserve the old string/null wire format, but never silently replace
        // corrupt JSON with an empty object or a current product lookup.
        if (row.cartInfo !== null && row.cartInfo !== '') {
          let parsed: unknown;
          try { parsed = JSON.parse(row.cartInfo); } catch { throw new ValidateException('订单商品快照无法读取'); }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ValidateException('订单商品快照无法读取');
        }
        return row;
      });
      return { ...order, cart_info: cartInfo };
    });
  }
}
