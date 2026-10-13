import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { createContainerFromDb, withTx, type Container, type DbClient } from '@/lib/di';
import { deliveryService, storeOrder, storeOrderRefund, storePink, systemStore, systemStoreStaff, user } from '@/models/schema';
import { themeDeadlines } from '@/services/content/ThemeReadService';
import { readCustomerWorkScope } from '@/services/customer-work/CustomerWorkScope';
import { customerWriteoffCarts, customerWriteoffOrder } from '@/services/customer-work/CustomerWorkWriteoffReadService';
import { writeoffNumber } from '@/services/customer-work/CustomerWorkWriteoffProtocol';
import { readCashierSecondCardOrigin } from '@/services/order/CashierSecondCardOrigin';
import { readPresaleDispatchReadiness } from '@/services/activity/PresaleFulfillmentSnapshot';
import { normalizeMemberWriteoffCode, StoreOrderWriteoffService, type WriteoffActor } from '@/services/order/StoreOrderWriteoffService';
import { requireMemberBarcodeIndex } from '@/services/user/MemberBarcodeService';
import type { SystemConfigEnv } from '@/services/system/SystemConfigService';
import { ApiException, AuthException, ForbiddenException, NotFoundException, ValidateException } from '@/utils/errors';

/** Server-only descriptor. Raw codes never belong in a share URL or a log. */
export type LegacyPrivateScanTarget =
  | { kind: 'member'; code: string; uid: number }
  | { kind: 'order'; code: string; uid: number; physicalOrderId: number; orderNo: string };
export type LegacyPrivateScanRealm = 'owner' | 'customer' | 'staff' | 'delivery';

function actorUid(uid: number): number {
  if (!Number.isSafeInteger(uid) || uid <= 0 || uid > 2147483647) throw new AuthException('请登录后读取本人二维码');
  return uid;
}

async function activeAccount(db: DbClient, uid: number) {
  const rows = await db.select({ uid: user.uid, code: user.barCode }).from(user)
    .where(and(eq(user.uid, uid), eq(user.status, 1), eq(user.isDel, 0), isNull(user.deleteTime))).limit(1);
  if (rows.length !== 1) throw new AuthException('当前账号不可使用二维码');
  return rows[0];
}

async function snapshot<T>(container: Container, read: (db: DbClient) => Promise<T>): Promise<T> {
  return withTx(container, async db => {
    await db.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    await themeDeadlines(db);
    return read(db);
  });
}

function sameTarget(a: LegacyPrivateScanTarget, b: LegacyPrivateScanTarget): boolean {
  return a.kind === b.kind && a.uid === b.uid && a.code === b.code
    && (a.kind !== 'order' || b.kind === 'order' && a.physicalOrderId === b.physicalOrderId && a.orderNo === b.orderNo);
}

async function targetUsing(db: DbClient, uid: number, type: 90 | 91, orderNo?: string): Promise<LegacyPrivateScanTarget> {
  const account = await activeAccount(db, uid);
  if (type === 90) {
    // Allocation is deliberately left to authenticated POST /api/user/bar_code.
    if (!account.code) throw new ValidateException('请先生成会员码后重试');
    const code = normalizeMemberWriteoffCode(account.code);
    await requireMemberBarcodeIndex(db);
    const owners = await db.select({ uid: user.uid }).from(user).where(eq(user.barCode, code)).limit(2);
    if (owners.length !== 1 || owners[0].uid !== uid) throw new ValidateException('会员码绑定不唯一，请联系管理员');
    return { kind: 'member', code, uid };
  }
  const number = writeoffNumber(orderNo);
  if (number === '0') throw new ValidateException('请输入真实订单业务单号');
  const matches = await db.select({ id: storeOrder.id }).from(storeOrder)
    .where(and(eq(storeOrder.orderId, number), eq(storeOrder.uid, uid), eq(storeOrder.isDel, 0), eq(storeOrder.isSystemDel, 0))).limit(2);
  if (matches.length !== 1) throw new NotFoundException('本人订单不存在或不可读取');
  const order = await customerWriteoffOrder(db, matches[0].id, number);
  const code = order.verifyCode;
  if (!/^\d{12}$/.test(code)) throw new ValidateException('订单尚无有效核销码');
  const codes = await db.select({ id: storeOrder.id }).from(storeOrder)
    .where(and(eq(storeOrder.verifyCode, code), eq(storeOrder.isDel, 0), eq(storeOrder.isSystemDel, 0))).limit(2);
  if (codes.length !== 1 || codes[0].id !== order.id) throw new ValidateException('订单核销码绑定不唯一，请联系管理员');
  const pickup = order.shippingType === 2 && order.storeId >= 0;
  const delivery = [1, 3].includes(order.shippingType) && order.deliveryType === 'send' && order.deliveryUid > 0;
  if (!pickup && !delivery) throw new ValidateException('该订单不是可核销的自提或配送订单');
  if (order.paid !== 1 || !(pickup ? [0, 5] : [1, 5]).includes(order.status)
    || ![0, 3].includes(order.refundStatus) || order.pid === -1 || order.supplierAllocationStatus === 1) {
    throw new ValidateException('当前订单状态不允许读取核销码');
  }
  if (pickup && order.storeId > 0) {
    const stores = await db.select({ id: systemStore.id }).from(systemStore)
      .where(and(eq(systemStore.id, order.storeId), eq(systemStore.isStore, 1), eq(systemStore.isShow, 1), eq(systemStore.isDel, 0))).limit(1);
    if (!stores.length) throw new ValidateException('订单门店不可核销');
  }
  const refunds = await db.select({ id: storeOrderRefund.id }).from(storeOrderRefund)
    .where(and(eq(storeOrderRefund.storeOrderId, order.id), inArray(storeOrderRefund.refundType, [0, 1, 2, 4, 5]),
      eq(storeOrderRefund.isCancel, 0), eq(storeOrderRefund.isDel, 0))).limit(1);
  if (refunds.length) throw new ValidateException('订单有待处理售后，不能读取核销码');
  if (order.type === 3) {
    const pink = await db.select({ status: storePink.status }).from(storePink).where(eq(storePink.id, order.pinkId)).limit(1);
    if (pink[0]?.status !== 2) throw new ValidateException('拼团尚未成功，不能读取核销码');
  }
  // Reuse the mature bounded physical-row/cart reader, including real owner and
  // quantity checks. Neither a guessed staff_id nor a store-zero flag is proof.
  const carts = await customerWriteoffCarts(db, order);
  const now = Math.floor(Date.now() / 1000);
  if (!carts.some(cart => !cart.isWriteoff && cart.writeSurplusTimes > 0
    && (!cart.writeStart || cart.writeStart <= now) && (!cart.writeEnd || cart.writeEnd >= now))) {
    throw new ValidateException('订单没有当前可核销商品');
  }
  if (pickup && order.storeId === 0 && !await readCashierSecondCardOrigin(db, order, carts)) {
    throw new ValidateException('订单缺少真实收银次卡来源');
  }
  await readPresaleDispatchReadiness(db, order, '核销');
  return { kind: 'order', code, uid, physicalOrderId: order.id, orderNo: number };
}

/** Owner authority only; every GET is two bounded read-only snapshots. A
 * committed revocation/code replacement after the first snapshot fails closed. */
export async function readLegacyPrivateScanTarget(container: Container, uidValue: number, type: 90 | 91,
  orderNo?: string): Promise<LegacyPrivateScanTarget> {
  const uid = actorUid(uidValue);
  if (type !== 90 && type !== 91) throw new ValidateException('私人二维码类型无效');
  const first = await snapshot(container, db => targetUsing(db, uid, type, orderNo));
  const current = await snapshot(container, db => targetUsing(db, uid, type, orderNo));
  if (!sameTarget(first, current)) throw new ValidateException('二维码对象已变化，请重新生成');
  return current;
}

async function viewerUsing(db: DbClient, viewerUid: number, target: LegacyPrivateScanTarget, env: SystemConfigEnv): Promise<string> {
  await activeAccount(db, viewerUid);
  const fresh = await targetUsing(db, actorUid(target.uid), target.kind === 'member' ? 90 : 91,
    target.kind === 'order' ? target.orderNo : undefined);
  if (!sameTarget(target, fresh)) throw new ForbiddenException('二维码对象已变化，请重新生成');
  if (viewerUid === fresh.uid) return `owner:${viewerUid}`;
  // This is the existing global mobile management READ role, checked from its
  // current unique SQL row. Caller has already verified the actual UserJWT;
  // no Admin, kefu, customer write actor or auth_version is fabricated here.
  const scope = await readCustomerWorkScope(db, viewerUid, false);
  if (scope) return `customer:${scope.scope_key}`;
  const service = new StoreOrderWriteoffService(createContainerFromDb(db), env);
  for (const kind of ['staff', 'delivery'] as const) {
    const actor: WriteoffActor = { kind, uid: viewerUid };
    try {
      if (fresh.kind === 'order') {
        const info = await service.infoByOrderId(actor, fresh.physicalOrderId);
        if (info.id === fresh.physicalOrderId && info.uid === fresh.uid && info.order_id === fresh.orderNo) {
          return await roleIdentity(db, viewerUid, kind, [info.store_id]);
        }
      } else {
        const preview = (await service.memberSummarySearch(actor, fresh.code)).data;
        if (preview.length > 0) {
          // Mature summaries intentionally omit store metadata. Resolve their
          // already-authorized physical rows within this same immutable snapshot.
          const orders = await db.select({ id: storeOrder.id, store: storeOrder.storeId }).from(storeOrder)
            .where(and(eq(storeOrder.uid, fresh.uid), inArray(storeOrder.id, preview.map(row => row.id)))).limit(21);
          if (orders.length !== preview.length) throw new ForbiddenException('核销读取订单集合已变化');
          return await roleIdentity(db, viewerUid, kind, orders.map(row => row.store));
        }
      }
    } catch (error) {
      // An absent mature role/preview is not a grant. Database failures still
      // propagate; only expected business rejection can try another realm.
      if (!(error instanceof ApiException)) throw error;
    }
  }
  throw new ForbiddenException('当前用户无权读取该私人二维码');
}

/** Bind the accepted mature preview to the exact current unique SQL identities,
 * rather than a role label or an arbitrary UID supplied by the client. */
async function roleIdentity(db: DbClient, uid: number, kind: 'staff' | 'delivery', storeIds: number[]): Promise<string> {
  if (kind === 'delivery') {
    const rows = await db.select({ id: deliveryService.id }).from(deliveryService)
      .where(and(eq(deliveryService.uid, uid), eq(deliveryService.type, 0), eq(deliveryService.relationId, 0),
        eq(deliveryService.status, 1), eq(deliveryService.isDel, 0))).limit(2);
    if (rows.length !== 1) throw new ForbiddenException('配送读取身份不唯一');
    return `delivery:${rows[0].id}:${uid}`;
  }
  const stores = [...new Set(storeIds)].sort((a, b) => a - b);
  if (!stores.length || stores.length > 20 || stores.some(id => id <= 0)) throw new ForbiddenException('门店读取范围无效');
  const rows = await db.select({ id: systemStoreStaff.id, store: systemStoreStaff.storeId }).from(systemStoreStaff)
    .where(and(eq(systemStoreStaff.uid, uid), inArray(systemStoreStaff.storeId, stores), eq(systemStoreStaff.status, 1),
      eq(systemStoreStaff.verifyStatus, 1), eq(systemStoreStaff.isDel, 0))).orderBy(systemStoreStaff.storeId, systemStoreStaff.id).limit(41);
  if (rows.length !== stores.length || new Set(rows.map(row => row.store)).size !== stores.length) throw new ForbiddenException('门店读取身份不唯一');
  return `staff:${JSON.stringify(rows)}`;
}

/** The owner or a current genuine matching read operator may decode. This does
 * not authorize a mutation and never accepts a client-supplied actor realm. */
export async function assertLegacyPrivateScanViewer(container: Container, viewerUidValue: number,
  target: LegacyPrivateScanTarget, env: SystemConfigEnv): Promise<LegacyPrivateScanRealm> {
  const uid = actorUid(viewerUidValue);
  if (!target || !['member', 'order'].includes(target.kind)) throw new ForbiddenException('私人二维码对象无效');
  const first = await snapshot(container, db => viewerUsing(db, uid, target, env));
  const current = await snapshot(container, db => viewerUsing(db, uid, target, env));
  if (first !== current) throw new ForbiddenException('二维码读取资格已变化，请重新读取');
  return current.split(':', 1)[0] as LegacyPrivateScanRealm;
}
