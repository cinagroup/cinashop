import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import { createContainerFromDb, type Container, type DbClient } from '@/lib/di';
import type { Env } from '@/env';
import { storeOrder, storeOrderCartInfo, storeOrderRefund, user } from '@/models/schema';
import { ApiErrorCode, AuthException, NotFoundException, ValidateException } from '@/utils/errors';
import { md5 } from '@/utils/jwt';
import { signAttachmentReferences } from '@/services/system/AttachmentService';
import { ExpressService, type ExpressQueryResult } from './ExpressService';
import { withOrderLifecycleSnapshot } from './OrderLifecycleTimeline';
import { resolveRefundReturnContact } from './RefundReturnContactService';
import { projectCustomerRefundItems } from './CustomerRefundReadService';
import { readMaterializedRefundSnapshot } from './RefundReadSnapshot';
import { readRefundQuantityReservation, refundClaimCartKey } from './RefundQuantityReservation';
import { buyerTrackingIntent, type BuyerTrackingContext, type BuyerTrackingItem, type BuyerTrackingResult } from '../../../../view/common/buyerOrderTracking';

const orderColumns = {
  id: storeOrder.id, pid: storeOrder.pid, orderId: storeOrder.orderId, uid: storeOrder.uid, type: storeOrder.type,
  status: storeOrder.status, deliveryType: storeOrder.deliveryType, deliveryName: storeOrder.deliveryName,
  deliveryCode: storeOrder.deliveryCode, deliveryId: storeOrder.deliveryId,
  isDel: storeOrder.isDel, isSystemDel: storeOrder.isSystemDel, realName: storeOrder.realName,
  userPhone: storeOrder.userPhone, userAddress: storeOrder.userAddress, province: storeOrder.province,
  storeId: storeOrder.storeId, supplierId: storeOrder.supplierId,
};
const refundColumns = {
  id: storeOrderRefund.id, orderId: storeOrderRefund.orderId, uid: storeOrderRefund.uid,
  storeOrderId: storeOrderRefund.storeOrderId, storeId: storeOrderRefund.storeId, supplierId: storeOrderRefund.supplierId,
  refundType: storeOrderRefund.refundType, applyType: storeOrderRefund.applyType, isCancel: storeOrderRefund.isCancel,
  refundNum: storeOrderRefund.refundNum, refundPrice: storeOrderRefund.refundPrice, refundedPrice: storeOrderRefund.refundedPrice,
  cartInfo: sql<string | null>`CASE WHEN octet_length(${storeOrderRefund.cartInfo})<=65536 THEN ${storeOrderRefund.cartInfo} ELSE NULL END`,
  refundExpress: storeOrderRefund.refundExpress, refundExpressName: storeOrderRefund.refundExpressName, refundPhone: storeOrderRefund.refundPhone,
};
type Order = Pick<typeof storeOrder.$inferSelect, keyof typeof orderColumns>;
type Cart = { id: number; uid: number; oid: number; cartId: string; cartNum: number; cartInfo: string | null; bytes: number | null };
type Identity = BuyerTrackingResult['identity'];
interface Snapshot { identity: Identity; orders: Order[]; refund: Awaited<ReturnType<BuyerOrderTrackingService['readRefund']>> | null;
  contexts: BuyerTrackingContext[]; fingerprint: string }
const goodsError = '商品历史快照暂不可读，请返回订单或退款详情核对';

/** Freshness check AFTER the caller has re-run complete UserJWT/bucket auth.
 * The raw password variant is accepted only because that middleware already
 * proved its exact active legacy bucket. It is not a signature verifier. */
export async function assertBuyerTrackingSession(container: Container, actor: { uid: number; authVersion: string; expiresAt: number }) {
  if (!Number.isInteger(actor.uid) || actor.uid <= 0 || !actor.authVersion || !Number.isInteger(actor.expiresAt)
    || actor.expiresAt <= Math.floor(Date.now() / 1000)) throw new AuthException('登录已过期，请重新登录', ApiErrorCode.ERR_EXPIRED);
  await withOrderLifecycleSnapshot(container, async db => {
    const [current] = await db.select({ status: user.status, isDel: user.isDel, deleteTime: user.deleteTime, pwd: user.pwd })
      .from(user).where(eq(user.uid, actor.uid)).limit(1);
    if (!current || current.isDel || current.deleteTime !== null || !current.status
      || ![md5(current.pwd), current.pwd].includes(actor.authVersion))
      throw new AuthException('登录状态已变化，请重新登录', ApiErrorCode.ERR_EXPIRED);
  });
}

function json(value: string | null): Record<string, unknown> {
  if (!value) throw new ValidateException(goodsError);
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new ValidateException(goodsError); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ValidateException(goodsError);
  return parsed as Record<string, unknown>;
}
function string(value: unknown, max: number, fallback = ''): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || value.length > max) throw new ValidateException(goodsError);
  return value;
}
function unitPrice(info: Record<string, unknown>, free: boolean): string | null {
  if (free) return '0.00';
  const product = (info.product ?? info.productInfo ?? {}) as Record<string, unknown>;
  const sku = (info.sku ?? product.attrInfo ?? {}) as Record<string, unknown>;
  const raw = info.truePrice ?? info.true_price ?? sku.price;
  if (raw === undefined || raw === null) return null;
  const value = typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : raw;
  if (typeof value !== 'string' || !/^\d{1,10}(?:\.\d{1,2})?$/.test(value)) throw new ValidateException(goodsError);
  const [whole, decimal = ''] = value.split('.'); return `${whole}.${decimal.padEnd(2, '0')}`;
}
function projectCart(row: Cart, free: boolean): BuyerTrackingItem {
  const info = json(row.cartInfo), product = (info.product ?? info.productInfo ?? {}) as Record<string, unknown>;
  const sku = (info.sku ?? product.attrInfo ?? {}) as Record<string, unknown>;
  if (!product || typeof product !== 'object' || Array.isArray(product) || !sku || typeof sku !== 'object' || Array.isArray(sku)
    || !Number.isInteger(row.cartNum) || row.cartNum <= 0) throw new ValidateException(goodsError);
  return { id: row.id, name: string(product.storeName ?? product.store_name ?? product.title, 4096, '订单商品'),
    sku: string(sku.suk, 4096), image: string(sku.image ?? product.image, 4096), quantity: row.cartNum, unitPrice: unitPrice(info, free) };
}
async function fingerprint(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Buyer-only view over the existing carrier engine. No database transaction is
 * kept open while fetching/caching provider data. The same physical snapshot
 * must still be current after I/O; stale data is rejected, never repaired. */
export class BuyerOrderTrackingService {
  constructor(private readonly container: Container, private readonly env: Env,
    private readonly tracker = new ExpressService(container, env)) {}

  async query(uid: number, reference: string, type: string, options: { buyerView: boolean; authorize(): Promise<void> }): Promise<ExpressQueryResult | BuyerTrackingResult> {
    if (!Number.isInteger(uid) || uid <= 0 || uid > 2147483647 || reference.length > 96 || !reference.trim()
      || /[\u0000-\u001f\u007f]/.test(reference) || (type !== '' && type !== 'refund')) throw new ValidateException('物流查询参数无效');
    reference = reference.trim();
    if (options.buyerView) {
      try { buyerTrackingIntent(reference, type || undefined); }
      catch { throw new ValidateException('物流查询参数无效'); }
    }
    await options.authorize();
    const initial = await this.snapshot(uid, reference, type, options.buyerView);
    const authorize = async () => {
      await options.authorize();
      const current = await this.snapshot(uid, reference, type, options.buyerView);
      if (current.fingerprint !== initial.fingerprint) throw new ValidateException('订单或退件物流已变化，请重新读取');
    };
    const result = initial.refund
      ? await this.tracker.queryScopedRefund({ ...initial.refund, refundPhone: initial.refund.refundPhone || initial.orders[0].userPhone }, authorize)
      : initial.identity.split ? await this.tracker.queryScopedOrders(initial.orders, authorize)
      : await this.tracker.queryScopedOrder(initial.orders[0], authorize);
    if (!options.buyerView) return result;
    const contexts = initial.contexts;
    for (const row of contexts) {
      const images = await signAttachmentReferences(this.env.APP_KEY, row.items.map(item => item.image));
      row.items = row.items.map((item, index) => ({ ...item, image: images[index] }));
    }
    return { ...result, version: 1, identity: initial.identity, contexts };
  }

  async readRefund(db: DbClient, uid: number, reference: string, buyerView: boolean) {
    const id = /^[1-9]\d{0,9}$/.test(reference) && Number(reference) <= 2147483647 ? Number(reference) : 0;
    const rows = await db.select(refundColumns).from(storeOrderRefund).where(and(eq(storeOrderRefund.uid, uid), eq(storeOrderRefund.isDel, 0),
      buyerView ? eq(storeOrderRefund.id, id) : or(eq(storeOrderRefund.orderId, reference), id ? eq(storeOrderRefund.id, id) : sql`FALSE`))).limit(2);
    if (rows.length > 1) throw new ValidateException('退款物流标识存在歧义，请从退款详情重新进入');
    if (!rows[0]) throw new NotFoundException('退款单不存在或不属于当前用户');
    if (!rows[0].refundExpress.trim()) throw new ValidateException('该退款单尚未填写退货运单');
    return rows[0];
  }

  private snapshot(uid: number, reference: string, type: string, buyerView: boolean): Promise<Snapshot> {
    return withOrderLifecycleSnapshot(this.container, async db => {
      const refund = type === 'refund' ? await this.readRefund(db, uid, reference, buyerView) : null;
      const rows = await db.select(orderColumns).from(storeOrder).where(and(eq(storeOrder.uid, uid), refund
        ? eq(storeOrder.id, refund.storeOrderId)
        : and(eq(storeOrder.orderId, reference), eq(storeOrder.isDel, 0), eq(storeOrder.isSystemDel, 0)))).limit(2);
      if (rows.length !== 1) throw new NotFoundException('订单不存在或不属于当前用户');
      const root = rows[0], split = !refund && (root.pid === -1 || root.deliveryType === 'split');
      const orders = split ? [root, ...await db.select(orderColumns).from(storeOrder).where(and(eq(storeOrder.pid, root.id), eq(storeOrder.isDel, 0), eq(storeOrder.isSystemDel, 0))).orderBy(asc(storeOrder.id)).limit(51)] : [root];
      if (orders.length > 51) throw new ValidateException('拆分包裹数量过多，请联系商家核对');
      if (orders.some(row => row.uid !== uid)) throw new ValidateException('订单物流范围无效，请联系商家核对');
      if (!refund && !split && root.deliveryType !== 'express') throw new ValidateException('该订单不是快递发货，无法查询物流信息');
      const identity: Identity = { kind: refund ? 'refund' : 'order', reference, uid,
        entityId: refund?.id ?? root.id, entityNo: refund?.orderId ?? root.orderId, split };
      const physical = refund || !split ? [root] : orders.slice(1).filter(row => row.deliveryType === 'express' && row.deliveryId.trim());
      const contexts: BuyerTrackingContext[] = [];
      let carts: Cart[] = [];
      if (buyerView && physical.length) carts = await db.select({ id: storeOrderCartInfo.id, uid: storeOrderCartInfo.uid, oid: storeOrderCartInfo.oid,
        cartId: storeOrderCartInfo.cartId, cartNum: storeOrderCartInfo.cartNum,
        cartInfo: sql<string | null>`CASE WHEN octet_length(${storeOrderCartInfo.cartInfo})<=65536 THEN ${storeOrderCartInfo.cartInfo} ELSE NULL END`,
        bytes: sql<number | null>`octet_length(${storeOrderCartInfo.cartInfo})` }).from(storeOrderCartInfo)
        .where(inArray(storeOrderCartInfo.oid, physical.map(row => row.id))).orderBy(asc(storeOrderCartInfo.id)).limit(201);
      const boundedCarts = carts.length <= 200 && carts.reduce((sum, row) => sum + (row.bytes ?? 0), 0) <= 1048576;
      if (buyerView) for (const order of physical) {
        const scope = refund ?? order;
        const merchant = await resolveRefundReturnContact(createContainerFromDb(db), { applyType: scope.storeId > 0 ? 3 : 2, storeId: scope.storeId, supplierId: scope.supplierId });
        let items: BuyerTrackingItem[] = [], itemsError = '';
        try {
          const owned = carts.filter(row => row.oid === order.id);
          if (refund) {
            const archived = await readMaterializedRefundSnapshot(db, refund);
            if (archived) items = archived.items.map(item => ({ id: item.id, name: item.name, sku: item.sku, image: item.image, quantity: item.quantity, unitPrice: null }));
            else {
              if (!boundedCarts || owned.some(row => row.uid !== uid)) throw new ValidateException(goodsError);
              const claim = readRefundQuantityReservation(refund);
              if (claim) {
                if (claim.uid !== uid || claim.orderId !== refund.storeOrderId) throw new ValidateException(goodsError);
                items = claim.items.map(selection => {
                  const cart = owned.find(row => row.id === selection.rowId);
                  if (!cart || cart.cartId !== refundClaimCartKey(selection) || selection.cartNum > cart.cartNum) throw new ValidateException(goodsError);
                  return { ...projectCart(cart, order.type === 8), quantity: selection.cartNum };
                });
              } else items = projectCustomerRefundItems(refund.cartInfo, refund.refundNum, owned).map(item => ({ id: item.id, name: item.name, sku: item.sku, image: item.image,
                quantity: item.quantity, unitPrice: unitPrice(json(owned.find(row => row.id === item.id)!.cartInfo), order.type === 8) }));
            }
          } else {
            if (!boundedCarts || owned.some(row => row.uid !== uid)) throw new ValidateException(goodsError);
            items = owned.map(row => projectCart(row, order.type === 8));
          }
        } catch (error) { if (!(error instanceof ValidateException)) throw error; items = []; itemsError = goodsError; }
        // Legacy snapshots may contain relative or unsafe media references. Keep
        // shipment details readable and let the page show its image placeholder.
        items = items.map(item => ({ ...item, image: /^(?:https?:\/\/|\/(?!\/))/.test(item.image) ? item.image : '' }));
        contexts.push({ orderId: refund?.orderId ?? order.orderId, entityId: refund?.id ?? order.id, uid,
          recipientName: order.realName, recipientPhone: order.userPhone,
          recipientAddress: order.province && !order.userAddress.startsWith(order.province) ? `${order.province} ${order.userAddress}` : order.userAddress,
          merchant, items, itemsError });
      }
      return { identity, orders, refund, contexts,
        fingerprint: await fingerprint({ identity, orders, refund, contexts }) };
    });
  }
}
