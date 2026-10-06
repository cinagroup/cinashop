import { and, asc, desc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import { createContainerFromDb, type Container, type DbClient } from '@/lib/di';
import type { Env } from '@/env';
import { storeOrder, storeOrderCartInfo, storeOrderRefund, storeOrderStatus, storeOrderWriteoff, storePink, user } from '@/models/schema';
import { ValidateException, NotFoundException } from '@/utils/errors';
import { StoreOrderWriteoffService, calculateWriteoffLinePrice, normalizePickupVerifyCode } from '@/services/order/StoreOrderWriteoffService';
import { assertPresaleDispatchReady, readPresaleDispatchReadiness } from '@/services/activity/PresaleFulfillmentSnapshot';
import { publicProductPictures, renderProductPictures } from '@/services/activity/ProductAssetPolicy';
import { cartProjection } from '@/services/kefu/KefuOrderService';
import { outRequestHash } from '@/services/out/OutIdempotency';
import { decimalToCents, lockOrderSettlementUsers } from '@/services/order/OrderBrokerageService';
import { loadRefundLineCompensation } from '@/services/order/RefundLineCompensation';
import { deliveryOperationReadiness } from '@/migrations/runDeliveryOrderOperation';
import { deliveryActor, deliveryId, deliveryOrderRevision, requireDeliveryScope, type DeliveryActor, type DeliverySelection, type DeliveryScope } from './DeliveryPrincipalScope';
import { normalizeMobileDeliveryPage } from './StoreMobileDeliveryService';
import { DeliveryOrderOperationRequest, appendDeliveryOperation, readDeliveryOperationHistory, authorizeLockedDeliveryOperation, lockDeliveryOrder, type DeliveryOperationContext } from './DeliveryOrderOperationRequest';
import { DELIVERY_WORKBENCH_VERSION, type DeliveryOrderActions, type DeliveryPaged, type DeliveryWorkbenchEnvelope } from '../../../../view/common/deliveryWorkbench';
import type { DeliveryWriteoffPayload, DeliveryWriteoffPreview, DeliveryWriteoffPreviews, DeliveryWriteoffRecord } from '../../../../view/common/deliveryWriteoff';

type Order = typeof storeOrder.$inferSelect;
type Cart = typeof storeOrderCartInfo.$inferSelect;
const OPEN_REFUNDS = [0, 1, 2, 4, 5];
const MAX_CARTS = 500, MAX_CART_BYTES = 262144;
function plain(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new ValidateException('配送内容格式无效');
  return value as Record<string, unknown>;
}
function keys(body: Record<string, unknown>, required: readonly string[]) {
  if (Object.keys(body).sort().join(',') !== [...required].sort().join(',')) throw new ValidateException('配送字段缺失或含不支持的字段');
}
export function parseDeliveryWriteoffPayload(value: unknown): DeliveryWriteoffPayload {
  const body = plain(value); keys(body, ['code', 'items']);
  if (typeof body.code !== 'string' || !/^\d{12}$/.test(body.code)) throw new ValidateException('配送原意图须包含12位订单核销码');
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 200) throw new ValidateException('请选择1至200项核销商品');
  const seen = new Set<number>(), items = body.items.map(value => {
    const row = plain(value); keys(row, ['order_cart_id', 'quantity']);
    if (typeof row.order_cart_id !== 'number' || typeof row.quantity !== 'number') throw new ValidateException('配送商品和数量须为严格整数');
    const order_cart_id = deliveryId(row.order_cart_id, '订单商品'), quantity = deliveryId(row.quantity, '核销数量');
    if (seen.has(order_cart_id)) throw new ValidateException('同一配送商品不能重复选择'); seen.add(order_cart_id); return { order_cart_id, quantity };
  });
  return { code: body.code, items };
}
function ownsOrder(scope: DeliveryScope, order: Order) { return order.deliveryUid === scope.actor_uid && order.deliveryType === 'send' && order.pid >= 0 && !order.isDel && !order.isSystemDel && order.supplierAllocationStatus !== 1 && (scope.kind === 'platform' || order.storeId === scope.store_id); }
function validCarts(order: Order, carts: Cart[]) {
  if (!carts.length || carts.length > MAX_CARTS || carts.some(c => c.oid !== order.id || c.uid !== order.uid || !Number.isSafeInteger(c.writeTimes) || !Number.isSafeInteger(c.writeSurplusTimes) || c.writeTimes < 0 || c.writeSurplusTimes < 0 || c.writeSurplusTimes > c.writeTimes)
    || new Set(carts.map(c => c.cartId)).size !== carts.length || new Set(carts.map(c => c.id)).size !== carts.length) throw new ValidateException('配送商品归属或剩余次数异常');
}
/** Read capability uses the real catalog/ordinary LOGIN and business state.
 * The write path re-evaluates under the actual resource and role locks. */
export async function deliveryWriteoffActions(db: DbClient, scope: DeliveryScope, order: Order, carts: Cart[], locked = false): Promise<DeliveryOrderActions> {
  let reason = '';
  if (!ownsOrder(scope, order)) reason = '订单不属于当前有效配送范围';
  else if (order.paid !== 1 || ![1, 5].includes(order.status) || ![0, 3].includes(order.refundStatus) || ![1, 3].includes(order.shippingType)) reason = '当前订单状态或配送方式不能送达核销';
  else if (!/^\d{12}$/.test(order.verifyCode)) reason = '当前核销码缺失或失效，请重新核对订单';
  if (!reason) { try { validCarts(order, carts); } catch (error) { if (!(error instanceof ValidateException)) throw error; reason = error.message; } }
  const now = Math.floor(Date.now() / 1000);
  if (!reason && !carts.some(c => c.writeSurplusTimes > 0 && (!c.writeStart || c.writeStart <= now) && (!c.writeEnd || c.writeEnd >= now))) reason = '商品没有当前可核销的剩余次数';
  if (!reason) { try { for (const cart of carts) calculateWriteoffLinePrice(cart.cartInfo, 1, true); } catch { reason = '订单成交价格快照缺失或无效，不能送达核销'; } }
  if (!reason) { const state = await deliveryOperationReadiness(db); if (!state.ready) reason = state.reason; }
  if (!reason) {
    const refunds = await db.select({ id: storeOrderRefund.id }).from(storeOrderRefund).where(and(eq(storeOrderRefund.storeOrderId, order.id), inArray(storeOrderRefund.refundType, OPEN_REFUNDS), eq(storeOrderRefund.isCancel, 0), eq(storeOrderRefund.isDel, 0))).limit(1);
    if (refunds.length) reason = '订单存在待处理售后';
  }
  if (!reason && order.type === 3) { const [pink] = await db.select({ status: storePink.status }).from(storePink).where(eq(storePink.id, order.pinkId)).limit(1); if (pink?.status !== 2) reason = '拼团尚未成功'; }
  if (!reason) { try { await (locked ? assertPresaleDispatchReady : readPresaleDispatchReadiness)(db, order, '核销'); } catch (error) { if (!(error instanceof ValidateException)) throw error; reason = error.message; } }
  return { writeoff: { available: !reason, reason } };
}
const orderColumns = getTableColumns(storeOrder), orderTexts = ['cartId', 'virtualInfo', 'customForm', 'promotionsGive', 'giveCoupon', 'expressDump', 'refundReasonWapImg'] as const;
const orderBytes = sql`(${sql.join(orderTexts.map(key => sql`COALESCE(octet_length(${orderColumns[key]})::bigint,0)`), sql`+`)})`;
const boundedOrder = { ...orderColumns, ...Object.fromEntries(orderTexts.map(key => [key, sql<string | null>`CASE WHEN ${orderBytes}<=262144 THEN ${orderColumns[key]} ELSE NULL END`])), oversized: sql<boolean>`${orderBytes}>262144` };
async function orderUsing(db: DbClient, scope: DeliveryScope, id: number): Promise<Order> {
  const [row] = await db.select(boundedOrder).from(storeOrder).where(and(eq(storeOrder.id, id), eq(storeOrder.deliveryUid, scope.actor_uid), eq(storeOrder.deliveryType, 'send'), eq(storeOrder.isDel, 0), eq(storeOrder.isSystemDel, 0), scope.kind === 'store' ? eq(storeOrder.storeId, scope.store_id) : undefined)).limit(1);
  if (!row || row.oversized) throw new NotFoundException('配送订单不存在或数据须先核对');
  const { oversized: _oversized, ...rest } = row, order = rest as Order; if (!ownsOrder(scope, order)) throw new NotFoundException('配送订单不属于当前范围'); return order;
}
async function cartsUsing(db: DbClient, order: Order, lock = false): Promise<Cart[]> {
  const cols = getTableColumns(storeOrderCartInfo), query = db.select({ ...cols, cartInfo: sql<string | null>`CASE WHEN octet_length(${storeOrderCartInfo.cartInfo})<=${MAX_CART_BYTES} THEN ${storeOrderCartInfo.cartInfo} ELSE NULL END`, oversized: sql<boolean>`COALESCE(octet_length(${storeOrderCartInfo.cartInfo}),0)>${MAX_CART_BYTES}` }).from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, order.id)).orderBy(asc(storeOrderCartInfo.id)).limit(MAX_CARTS + 1);
  const rows = await (lock ? query.for('update') : query); if (rows.some(c => c.oversized) || rows.reduce((n, c) => n + new TextEncoder().encode(c.cartInfo ?? '').length, 0) > MAX_CART_BYTES) throw new ValidateException('配送商品快照超过完整读取容量');
  const carts = rows.map(({ oversized: _oversized, ...cart }) => cart); validCarts(order, carts); return carts;
}
function selection(value: Record<string, unknown>): DeliverySelection {
  if (value.scope_kind !== 'platform' && value.scope_kind !== 'store' || typeof value.delivery_id !== 'number' || typeof value.store_id !== 'number') throw new ValidateException('请明确选择当前配送身份');
  return { kind: value.scope_kind, delivery_id: deliveryId(value.delivery_id), store_id: value.store_id };
}
function lookup(value: unknown) {
  const body = plain(value), hasCode = Object.hasOwn(body, 'code'); keys(body, ['version', 'scope_kind', 'delivery_id', 'store_id', 'scope_key', hasCode ? 'code' : 'order_id']);
  if (body.version !== DELIVERY_WORKBENCH_VERSION || typeof body.scope_key !== 'string' || !/^[a-f0-9]{64}$/.test(body.scope_key)) throw new ValidateException('配送查询合同无效');
  const selected = selection(body);
  if (!hasCode) { if (typeof body.order_id !== 'number') throw new ValidateException('订单须为严格整数'); return { selected, scopeKey: body.scope_key, orderId: deliveryId(body.order_id), code: null }; }
  if (typeof body.code !== 'string' || body.code.length < 1 || body.code.length > 32 || body.code.trim() !== body.code || /[\u0000-\u0020\u007f]/u.test(body.code)) throw new ValidateException('请输入有效订单码或会员码');
  return { selected, scopeKey: body.scope_key, orderId: null, code: body.code };
}
function shanghaiTime(epoch: number) { return new Date((epoch + 8 * 3600) * 1000).toISOString().slice(0, 19).replace('T', ' '); }
export class DeliveryOrderWriteoffService {
  constructor(readonly container: Container, readonly env: Env) {}
  async execute(ctx: DeliveryOperationContext, value: unknown) {
    return new DeliveryOrderOperationRequest(this.container).execute(ctx, value, async (tx, p) => {
      const payload = parseDeliveryWriteoffPayload(p.input.payload), order = await lockDeliveryOrder(tx, p);
      // Absent refund rows and rotating-code generation are authorities too.
      // Protect them before taking user/role locks; preserve NOWAIT ambiguity.
      // Serialize rotating-code authority before taking share locks on tables
      // we subsequently mutate; concurrent couriers cannot deadlock upgrading.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(63843::int,0::int)`);
      await tx.execute(sql`LOCK TABLE public.store_order_cart_info,public.store_order_refund,public.store_pink IN SHARE MODE NOWAIT`);
      const carts = await cartsUsing(tx, order, true);
      const compensation = decimalToCents(order.refundPrice) > 0 ? await loadRefundLineCompensation(tx, order.id) : null;
      // One ascending set includes buyer, current/historical commission
      // recipients and the actor before any identity FOR SHARE lock.
      await lockOrderSettlementUsers(tx, order, compensation?.earnedIncome?.orderId, [p.actor.uid]);
      const scope = await authorizeLockedDeliveryOperation(tx, p, order, carts), actions = await deliveryWriteoffActions(tx, scope, order, carts, true);
      if (!actions.writeoff.available) throw new ValidateException(actions.writeoff.reason);
      if (order.verifyCode !== payload.code) throw new ValidateException('原核销码已变化，请核对原请求');
      const result = await new StoreOrderWriteoffService(createContainerFromDb(tx), this.env).execute({ kind: 'scoped-delivery', uid: p.actor.uid, actor: p.actor,
        selection: { kind: scope.kind, store_id: scope.store_id, delivery_id: scope.delivery_id }, scopeKey: scope.scope_key }, { code: payload.code, items: payload.items.map(row => ({ orderCartId: row.order_cart_id, quantity: row.quantity })) });
      if (!Array.isArray(result.record_ids) || result.record_ids.length !== payload.items.length) throw Error('配送核销记录与原选中商品不一致');
      const selectedCarts = carts.filter(cart => payload.items.some(item => item.order_cart_id === cart.id)), byCart = new Map(selectedCarts.map((cart, index) => [cart.id, result.record_ids![index]]));
      const orderedRecordIds = payload.items.map(item => { const id = byCart.get(item.order_cart_id); if (!id) throw Error('配送记录缺少原商品对应行'); return id; });
      await tx.insert(storeOrderStatus).values({ oid: order.id, changeType: 'delivery_scope_writeoff', changeMessage: `配送用户 ${scope.actor_uid}，配送身份 ${scope.delivery_id}，${scope.kind === 'platform' ? '平台' : `门店 ${scope.store_id}`} 完成${result.completed ? '全部' : '部分'}送达核销`, changeTime: Math.floor(Date.now() / 1000) });
      return appendDeliveryOperation(tx, p, scope.delivery_id, result.completed ? 'delivered' : 'partial-delivered', { completed: result.completed, status: result.status, writeoff_row_ids: orderedRecordIds, quantities: payload.items.map(row => ({ ...row })) });
    });
  }
  private async read<T>(actorInput: DeliveryActor, selected: DeliverySelection, scopeKey: string, callback: (db: DbClient, scope: DeliveryScope) => Promise<{ data: T; facts: unknown }>): Promise<DeliveryWorkbenchEnvelope<T>> {
    const actor = deliveryActor(actorInput);
    return this.container.db.transaction(async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ,READ ONLY`);
      await tx.execute(sql`SET LOCAL search_path=public,pg_temp`);
      const db = tx as unknown as DbClient, scope = await requireDeliveryScope(db, actor, selected, { expectedScopeKey: scopeKey }), result = await callback(db, scope);
      return { version: DELIVERY_WORKBENCH_VERSION, actor_uid: actor.uid, scope_key: scope.scope_key, scope: selected, consistency_key: await outRequestHash({ version: 'delivery-writeoff-read-v1', scope: selected, scope_key: scope.scope_key, facts: result.facts }), data: result.data, issues: scope.issues };
    });
  }
  async info(actor: DeliveryActor, value: unknown): Promise<DeliveryWorkbenchEnvelope<DeliveryWriteoffPreviews>> {
    const request = lookup(value), result = await this.read(actor, request.selected, request.scopeKey, async (db, scope) => {
      let ids: number[], lookupKind: DeliveryWriteoffPreviews['lookup_kind'];
      if (request.orderId !== null) { ids = [request.orderId]; lookupKind = 'order-id'; }
      else if (/^\d{12}$/.test(request.code!)) {
        lookupKind = 'order-code'; const rows = await db.select({ id: storeOrder.id }).from(storeOrder).where(and(eq(storeOrder.verifyCode, normalizePickupVerifyCode(request.code)), eq(storeOrder.deliveryUid, actor.uid), eq(storeOrder.deliveryType, 'send'), eq(storeOrder.isDel, 0), eq(storeOrder.isSystemDel, 0), scope.kind === 'store' ? eq(storeOrder.storeId, scope.store_id) : undefined)).limit(2);
        if (rows.length !== 1) throw new NotFoundException('当前配送订单不存在或核销码不唯一'); ids = rows.map(r => r.id);
      } else {
        lookupKind = 'member-barcode'; const customers = await db.select({ uid: user.uid }).from(user).where(and(eq(user.barCode, request.code!), eq(user.status, 1), eq(user.isDel, 0), sql`${user.deleteTime} IS NULL`)).orderBy(asc(user.uid)).limit(2);
        if (customers.length !== 1) throw new NotFoundException('会员码不存在或对应多个有效用户');
        const rows = await db.select({ id: storeOrder.id }).from(storeOrder).where(and(eq(storeOrder.uid, customers[0].uid), eq(storeOrder.deliveryUid, actor.uid), eq(storeOrder.deliveryType, 'send'), eq(storeOrder.paid, 1), inArray(storeOrder.status, [1, 5]), inArray(storeOrder.refundStatus, [0, 3]), eq(storeOrder.isDel, 0), eq(storeOrder.isSystemDel, 0), sql`${storeOrder.pid}>=0`, scope.kind === 'store' ? eq(storeOrder.storeId, scope.store_id) : undefined)).orderBy(desc(storeOrder.payTime), desc(storeOrder.id)).limit(101);
        if (rows.length > 100) throw new ValidateException('会员待送达订单过多，请使用具体12位订单核销码'); ids = rows.map(row => row.id);
      }
      const list: DeliveryWriteoffPreview[] = [], facts: unknown[] = [];
      for (const id of ids) {
        const order = await orderUsing(db, scope, id), carts = await cartsUsing(db, order), projected = carts.map(cart => cartProjection(cart));
        const images = await publicProductPictures(db, projected.map(cart => ({ image: cart.productInfo.image, type: order.supplierId > 0 ? 2 : 0, relationId: order.supplierId > 0 ? order.supplierId : 0 })));
        const actions = await deliveryWriteoffActions(db, scope, order, carts), revision = await deliveryOrderRevision(order, carts);
        list.push({ id: order.id, order_id: order.orderId, store_id: order.storeId, revision, verify_code: /^\d{12}$/.test(order.verifyCode) ? order.verifyCode : '', status: order.status,
          total_num: order.totalNum, product_type: order.productType, writeoff_count: carts.reduce((n, c) => n + c.writeTimes - c.writeSurplusTimes, 0), actions,
          cart_info: carts.map((cart, index) => ({ id: cart.id, cart_id: cart.cartId, cart_num: cart.cartNum, product_id: cart.productId, product_type: cart.productType, is_gift: cart.isGift,
            write_times: cart.writeTimes, write_surplus_times: cart.writeSurplusTimes, write_start: cart.writeStart, write_end: cart.writeEnd,
            cart_info: { productInfo: { id: cart.productId, store_name: projected[index].productInfo.store_name, image: images[index], attrInfo: { suk: projected[index].productInfo.attrInfo.suk, image: images[index], price: projected[index].productInfo.attrInfo.price } } } })) });
        facts.push({ order, carts, actions, images });
      }
      return { data: { list, lookup_kind: lookupKind }, facts };
    });
    const refs = result.data.list.flatMap(row => row.cart_info.map(c => c.cart_info.productInfo.image)), signed = await renderProductPictures(this.env.APP_KEY, refs); let index = 0;
    for (const row of result.data.list) for (const cart of row.cart_info) { cart.cart_info.productInfo.image = signed[index]; cart.cart_info.productInfo.attrInfo.image = signed[index++]; } return result;
  }
  async records(actor: DeliveryActor, query: Record<string, string>): Promise<DeliveryWorkbenchEnvelope<DeliveryPaged<DeliveryWriteoffRecord>>> {
    const allowed = ['scope_kind', 'delivery_id', 'store_id', 'scope_key', 'order_id', 'page', 'limit']; if (Object.keys(query).some(k => !allowed.includes(k))) throw new ValidateException('核销记录查询包含不支持的字段');
    const selected = selection({ scope_kind: query.scope_kind, delivery_id: deliveryId(query.delivery_id), store_id: query.store_id === '0' ? 0 : deliveryId(query.store_id, '门店') }), orderId = deliveryId(query.order_id, '订单'), paging = normalizeMobileDeliveryPage(query.page, query.limit);
    if (!/^[a-f0-9]{64}$/.test(query.scope_key ?? '')) throw new ValidateException('请先选择当前配送身份');
    const result = await this.read(actor, selected, query.scope_key, async (db, scope) => {
      const order = await orderUsing(db, scope, orderId), carts = await cartsUsing(db, order), byId = new Map(carts.map(c => [c.id, c]));
      const valid = and(eq(storeOrderWriteoff.oid, orderId), eq(storeOrderWriteoff.uid, order.uid));
      const [total] = await db.select({ count: sql<number>`count(*)::int` }).from(storeOrderWriteoff).where(valid);
      const rows = await db.select().from(storeOrderWriteoff).where(valid).orderBy(desc(storeOrderWriteoff.addTime), desc(storeOrderWriteoff.id)).offset(paging.offset).limit(paging.limit), list: DeliveryWriteoffRecord[] = [];
      const state = await deliveryOperationReadiness(db), admitted = state.catalog.complete ? await readDeliveryOperationHistory(db, scope.actor_uid, orderId) : [];
      if (admitted.length > 1000) throw new ValidateException('配送回执历史超过完整读取容量');
      for (const row of rows) {
        const cart = byId.get(row.orderCartId); if (!cart || row.productId !== cart.productId || row.productType !== cart.productType || row.writeoffNum <= 0) throw new ValidateException('核销记录与当前订单商品归属不一致');
        const projected = cartProjection(cart), [image] = await publicProductPictures(db, [{ image: projected.productInfo.image, type: order.supplierId > 0 ? 2 : 0, relationId: order.supplierId > 0 ? order.supplierId : 0 }]);
        const identities = admitted.filter(p => Array.isArray(p.evidence.writeoff_row_ids) && p.evidence.writeoff_row_ids.includes(row.id)); if (identities.length > 1) throw new ValidateException('核销记录操作者证据存在冲突');
        if (identities.length === 1) {
          const proof = identities[0], ids = proof.evidence.writeoff_row_ids as number[], quantities = proof.evidence.quantities as Array<{ order_cart_id: number; quantity: number }>, index = ids.indexOf(row.id), quantity = quantities[index];
          if (proof.actor_uid !== scope.actor_uid || proof.order_id !== order.id || !((proof.scope_kind === 'platform' && proof.store_id === 0) || (proof.scope_kind === 'store' && proof.store_id === order.storeId)) || !quantity || quantity.order_cart_id !== row.orderCartId || quantity.quantity !== row.writeoffNum || row.isAdmin || row.staffId > 0) throw new ValidateException('核销记录与原配送回执数量或身份不一致');
        }
        list.push({ id: row.id, order_cart_id: row.orderCartId, writeoff_num: row.writeoffNum, writeoff_price: row.writeoffPrice, add_time: row.addTime, time: shanghaiTime(row.addTime),
          cart_info: { productInfo: { id: cart.productId, store_name: projected.productInfo.store_name, image, attrInfo: { suk: projected.productInfo.attrInfo.suk, image, price: projected.productInfo.attrInfo.price } } },
          operator: { kind: identities.length === 1 ? 'delivery' : row.isAdmin ? 'admin' : row.staffId > 0 ? 'staff' : 'unknown', delivery_id: identities[0]?.delivery_id ?? null } });
      }
      return { data: { list, count: total.count, page: paging.page, limit: paging.limit, has_more: paging.offset + rows.length < total.count }, facts: { order, carts, rows, admitted, list } };
    });
    const signed = await renderProductPictures(this.env.APP_KEY, result.data.list.map(r => r.cart_info.productInfo.image)); result.data.list.forEach((row, i) => { row.cart_info.productInfo.image = signed[i]; row.cart_info.productInfo.attrInfo.image = signed[i]; }); return result;
  }
}
