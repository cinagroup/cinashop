import { and, desc, eq, ilike, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { createContainerFromDb, withTx, type Container } from '@/lib/di';
import { storeOrder, storeOrderCartInfo, storeOrderRefund } from '@/models/schema';
import { NotFoundException, ValidateException } from '@/utils/errors';
import { resolveRefundReturnContact } from './RefundReturnContactService';
import { previewReturnImages } from './RefundReturnPayload';
import { readMaterializedRefundSnapshot, type RefundReadItem } from './RefundReadSnapshot';

const filters = ['all', 'pending', 'returning', 'transit', 'completed', 'rejected', 'cancelled'] as const;
type Filter = typeof filters[number];
// Explicit public projection: never return admin remarks, raw cart JSON or delivery secrets.
const summaryColumns = {
  id: storeOrderRefund.id, uid: storeOrderRefund.uid, refundNo: storeOrderRefund.orderId,
  storeOrderId: storeOrderRefund.storeOrderId, orderId: storeOrder.orderId,
  applyType: storeOrderRefund.applyType, refundType: storeOrderRefund.refundType,
  isCancel: storeOrderRefund.isCancel, refundNum: storeOrderRefund.refundNum,
  refundPrice: storeOrderRefund.refundPrice, refundedPrice: storeOrderRefund.refundedPrice,
  refundReason: storeOrderRefund.refundReason, addTime: storeOrderRefund.addTime,
  refundedTime: storeOrderRefund.refundedTime,
};
const joinedOrder = and(eq(storeOrder.id, storeOrderRefund.storeOrderId), eq(storeOrder.uid, storeOrderRefund.uid));
function customer(uid: number) {
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new ValidateException('请先登录');
}
function uniqueQuery(params: URLSearchParams, allowed: string[]) {
  for (const key of params.keys()) {
    if (!allowed.includes(key) || params.getAll(key).length !== 1) throw new ValidateException('退款查询参数无效');
  }
  if (params.get('view') !== 'customer') throw new ValidateException('退款查询版本无效');
}
function positive(value: unknown): number {
  const n = typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0) throw new ValidateException('退款商品标识或数量无效');
  return n;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidateException('退款商品快照格式无效');
  return value as Record<string, unknown>;
}
function boundedJson(value: string | null): unknown {
  if (!value || value.length > 65536) throw new ValidateException('退款商品快照缺失或过大');
  try { return JSON.parse(value); } catch { throw new ValidateException('退款商品快照无法读取'); }
}

/** Strict read projection; malformed or ambiguous legacy selections are not silently dropped. */
export function projectCustomerRefundItems(snapshot: string | null, total: number, carts: Array<{
  id: number; cartId: string; cartNum: number; cartInfo: string | null;
}>): RefundReadItem[] {
  const parsed = boundedJson(snapshot), selections = Array.isArray(parsed) ? parsed : record(parsed).cartIds;
  if (!Array.isArray(selections) || !selections.length || selections.length > 200 || carts.length > 200) throw new ValidateException('退款商品快照数量无效');
  positive(total);
  const seen = new Set<number>();
  const lines = selections.map(value => {
    const selection: Record<string, unknown> = typeof value === 'object' && value !== null ? record(value) : { cartId: value };
    const id = positive(selection.cartId ?? selection.cart_id ?? selection.id);
    const matches = carts.filter(cart => cart.id === id || Number(cart.cartId) === id);
    if (matches.length !== 1 || seen.has(matches[0].id)) throw new ValidateException('退款商品无法唯一对应当前订单');
    const cart = matches[0]; seen.add(cart.id); positive(cart.cartNum);
    const rawQuantity = selection.cartNum ?? selection.cart_num;
    const quantity = rawQuantity === undefined ? null : positive(rawQuantity);
    if (quantity !== null && quantity > cart.cartNum) throw new ValidateException('退款商品数量超过订单快照');
    const info = record(boundedJson(cart.cartInfo));
    const product = record(info.product ?? info.productInfo ?? {}), sku = record(info.sku ?? product.attrInfo ?? {});
    const name = product.storeName ?? product.store_name, image = sku.image ?? product.image;
    return { id: cart.id, cartId: positive(cart.cartId), name: typeof name === 'string' ? name : '订单商品',
      sku: typeof sku.suk === 'string' ? sku.suk : '', image: typeof image === 'string' ? image : '', quantity,
      ordered: cart.cartNum };
  });
  const explicit = lines.reduce((sum, line) => sum + (line.quantity ?? 0), 0);
  const unknown = lines.filter(line => line.quantity === null);
  if (explicit > total || (!unknown.length && explicit !== total)) throw new ValidateException('退款件数与商品快照不一致');
  if (unknown.length === 1 && total - explicit > 0 && total - explicit <= unknown[0].ordered) {
    unknown[0].quantity = total - explicit;
  } else if (unknown.length && unknown.reduce((sum, line) => sum + line.ordered, explicit) === total) {
    for (const line of unknown) line.quantity = line.ordered;
  } else if (unknown.length && (total - explicit < unknown.length || total - explicit > unknown.reduce((sum, line) => sum + line.ordered, 0))) {
    throw new ValidateException('退款件数与商品快照不一致');
  }
  // Ambiguous old multi-line partial quantities stay null; never allocate them arbitrarily.
  return lines.map(({ ordered: _ordered, ...line }) => line);
}

export class CustomerRefundReadService {
  constructor(private readonly container: Container, private readonly appKey?: string) {}

  async list(uid: number, params: URLSearchParams) {
    customer(uid); uniqueQuery(params, ['view', 'filter', 'q', 'limit', 'cursor']);
    const filter = params.get('filter') ?? 'all', q = (params.get('q') ?? '').trim(), rawLimit = params.get('limit') ?? '20';
    if (!filters.includes(filter as Filter) || q.length > 80 || /[\u0000-\u001f\u007f]/.test(q)
      || !/^[1-9]\d*$/.test(rawLimit) || Number(rawLimit) > 50) throw new ValidateException('退款筛选参数无效');
    const limit = Number(rawLimit), context = { uid, filter, q: encodeURIComponent(q), limit };
    const conditions: SQL[] = [eq(storeOrderRefund.uid, uid), eq(storeOrderRefund.isDel, 0)];
    if (filter === 'cancelled') conditions.push(eq(storeOrderRefund.isCancel, 1));
    else if (filter !== 'all') {
      const states: Record<Exclude<Filter, 'all' | 'cancelled'>, number[]> = { pending: [0, 1, 2], returning: [4], transit: [5], completed: [6], rejected: [3] };
      conditions.push(eq(storeOrderRefund.isCancel, 0), inArray(storeOrderRefund.refundType, states[filter as keyof typeof states]));
    }
    if (q) {
      const literal = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
      conditions.push(or(ilike(storeOrderRefund.orderId, literal), ilike(storeOrder.orderId, literal))!);
    }
    const cursor = params.get('cursor');
    if (cursor) {
      try {
        if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw Error();
        const decoded = record(JSON.parse(atob(cursor.replace(/-/g, '+').replace(/_/g, '/'))));
        if (Object.keys(decoded).sort().join(',') !== 'at,filter,id,limit,q,uid'
          || decoded.uid !== uid || decoded.filter !== filter || decoded.q !== context.q || decoded.limit !== limit
          || typeof decoded.at !== 'number' || !Number.isSafeInteger(decoded.at) || decoded.at < 0) throw Error();
        const id = positive(decoded.id), at = decoded.at;
        conditions.push(or(lt(storeOrderRefund.addTime, at), and(eq(storeOrderRefund.addTime, at), lt(storeOrderRefund.id, id)))!);
      } catch { throw new ValidateException('退款分页凭据无效或筛选条件已变化'); }
    }
    const rows = await this.container.db.select(summaryColumns).from(storeOrderRefund).innerJoin(storeOrder, joinedOrder)
      .where(and(...conditions)).orderBy(desc(storeOrderRefund.addTime), desc(storeOrderRefund.id)).limit(limit + 1);
    const items = rows.slice(0, limit), last = items.at(-1);
    const nextCursor = rows.length > limit && last
      ? btoa(JSON.stringify({ ...context, at: last.addTime, id: last.id })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : null;
    return { version: 1 as const, items, nextCursor, filter, q, limit };
  }

  async detail(uid: number, identifier: string, params: URLSearchParams) {
    customer(uid); uniqueQuery(params, ['view']);
    if (!/^[1-9]\d*$/.test(identifier) || !Number.isSafeInteger(Number(identifier))) throw new ValidateException('退款单链接无效');
    return withTx(this.container, async db => {
      // A finalizer may consume the original cart between two READ COMMITTED
      // statements. Authorization, terminal state, receipt and items must agree.
      await db.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await db.execute(sql`SELECT set_config('statement_timeout',
        LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true)`);
      const container = createContainerFromDb(db);
      const rows = await db.select({ ...summaryColumns, isDel: storeOrderRefund.isDel,
        storeId: storeOrderRefund.storeId, supplierId: storeOrderRefund.supplierId,
        refundExplain: storeOrderRefund.refundExplain, refuseReason: storeOrderRefund.refuseReason,
        refundExpress: storeOrderRefund.refundExpress, refundExpressName: storeOrderRefund.refundExpressName,
        refundPhone: storeOrderRefund.refundPhone, refundGoodsExplain: storeOrderRefund.refundGoodsExplain,
        returnImageJson: sql<string | null>`CASE WHEN octet_length(${storeOrderRefund.refundGoodsImg}) <= 8192 THEN ${storeOrderRefund.refundGoodsImg} ELSE '__invalid__' END`,
        cartInfo: sql<string | null>`CASE WHEN octet_length(${storeOrderRefund.cartInfo}) <= 65536 THEN ${storeOrderRefund.cartInfo} ELSE NULL END`,
      }).from(storeOrderRefund).innerJoin(storeOrder, joinedOrder)
        .where(and(eq(storeOrderRefund.id, Number(identifier)), eq(storeOrderRefund.uid, uid), eq(storeOrderRefund.isDel, 0))).limit(1);
      const row = rows[0]; if (!row) throw new NotFoundException('退款记录不存在');
      let items: RefundReadItem[] = [], itemsError = '', physicalOrderId: number | null = null;
      try {
        const history = await readMaterializedRefundSnapshot(db, { ...row, orderId: row.refundNo });
        if (history) { items = history.items; physicalOrderId = history.physicalOrderId; }
        else {
          const carts = await db.select({ id: storeOrderCartInfo.id, cartId: storeOrderCartInfo.cartId, cartNum: storeOrderCartInfo.cartNum,
            cartInfo: sql<string | null>`CASE WHEN octet_length(${storeOrderCartInfo.cartInfo}) <= 65536 THEN ${storeOrderCartInfo.cartInfo} ELSE NULL END`,
          }).from(storeOrderCartInfo).where(and(eq(storeOrderCartInfo.oid, row.storeOrderId), eq(storeOrderCartInfo.uid, uid)))
            .orderBy(storeOrderCartInfo.id).limit(201);
          items = projectCustomerRefundItems(row.cartInfo, row.refundNum, carts);
        }
      }
      catch (error) { if (!(error instanceof ValidateException)) throw error; itemsError = error.message; }
      const returnContact = !row.isCancel && [4, 5].includes(row.refundType) ? await resolveRefundReturnContact(container, row) : null;
      let returnImages: Array<{ url: string; src: string }> = [], returnImagesError = '';
      try { returnImages = await previewReturnImages(container, uid, row.returnImageJson, this.appKey); }
      catch (error) { if (!(error instanceof ValidateException)) throw error; returnImagesError = '退货凭证暂不可读取，请联系商家核对'; }
      const { cartInfo: _cartInfo, returnImageJson: _returnImageJson, isDel: _isDel, storeId: _storeId, supplierId: _supplierId, ...summary } = row;
      return { version: 1 as const, ...summary, physicalOrderId, items, itemsError, returnContact, returnImages, returnImagesError };
    });
  }
}
