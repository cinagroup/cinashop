import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { Container, DbClient } from "@/lib/di";
import { withTx } from "@/lib/di";
import type { SystemConfigEnv } from "@/services/system/SystemConfigService";
import {
  storeOrder,
  storeOrderCartInfo,
  storeOrderRefund,
  storeOrderStatus,
  storeOrderWriteoff,
  storePink,
  deliveryService,
  systemStore,
  systemStoreStaff,
  user,
} from "@/models/schema";
import {
  assertKefuConversationOwnership,
  lockKefuConversationOwnership,
} from "@/services/kefu/KefuOwnership";
import {
  decimalToCents,
  loadOrderReceiptSettlementContext,
  lockOrderSettlement,
  settleCompletedOrderInTx,
} from "@/services/order/OrderBrokerageService";
import { NotFoundException, ValidateException } from "@/utils/errors";

const VERIFY_CODE_LOCK_NAMESPACE = 63_843;
const OPEN_REFUND_TYPES = [0, 1, 2, 4, 5];
const MAX_LEGACY_BARCODE_LENGTH = 32;
const MAX_LEGACY_SEARCH_RESULTS = 100;
const MAX_JSON_SNAPSHOT_BYTES = 256 * 1024;
const MAX_ORDER_CART_ROWS = 500;

export type WriteoffActor =
  | { kind: "staff"; uid: number }
  | { kind: "delivery"; uid: number }
  | { kind: "admin"; adminId: number }
  | { kind: "kefu"; kefuId: number; kefuUid: number };

export interface WriteoffLineInput {
  /** store_order_cart_info.id. */
  orderCartId?: number;
  /** PHP-compatible store_order_cart_info.cart_id. */
  cartId?: string;
  quantity: number;
}

export interface ExecuteWriteoffInput {
  code: string;
  items?: WriteoffLineInput[];
}

interface WriteoffOperator {
  staffId: number;
  deliveryId: number;
  clerkUid: number;
  isAdmin: number;
  adminId: number;
}

type WriteoffMode = "pickup" | "delivery";

export function normalizePickupVerifyCode(value: unknown): string {
  const code = String(value ?? "").trim();
  if (!/^\d{12}$/.test(code)) throw new ValidateException("请输入12位核销码");
  return code;
}

function randomVerifyCode(): string {
  const digits: number[] = [];
  while (digits.length < 12) {
    const values = crypto.getRandomValues(new Uint8Array(16));
    for (const value of values) {
      if (value >= 250) continue;
      digits.push(value % 10);
      if (digits.length === 12) break;
    }
  }
  return digits.join("");
}

/** Serialized generation is required because the inherited schema has no unique verify_code constraint. */
export async function generatePickupVerifyCode(
  tx: DbClient,
  excludeOrderId = 0,
): Promise<string> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${VERIFY_CODE_LOCK_NAMESPACE}, 0)`);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = randomVerifyCode();
    const matches = await tx
      .select({ id: storeOrder.id })
      .from(storeOrder)
      .where(and(
        eq(storeOrder.verifyCode, candidate),
        eq(storeOrder.isDel, 0),
        eq(storeOrder.isSystemDel, 0),
        sql`${storeOrder.id} <> ${excludeOrderId}`,
      ))
      .limit(1);
    if (!matches[0]) return candidate;
  }
  throw new Error("无法生成唯一核销码");
}

function maskPhone(phone: string): string {
  const normalized = phone.trim();
  if (normalized.length < 7) return normalized ? "****" : "";
  return `${normalized.slice(0, 3)}****${normalized.slice(-4)}`;
}

function parseSnapshot(value: string | null): unknown {
  if (!value || value.length > MAX_JSON_SNAPSHOT_BYTES) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function positiveOrderId(value: unknown): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0 || id > 2_147_483_647) {
    throw new ValidateException("订单ID错误");
  }
  return id;
}

function legacyLookupValue(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new ValidateException("缺少核销码");
  }
  const normalized = String(value).trim();
  if (!normalized || normalized === "undefined") throw new ValidateException("缺少核销码");
  if (normalized.length > MAX_LEGACY_BARCODE_LENGTH) throw new ValidateException("核销码格式错误");
  return normalized;
}

export function calculateWriteoffLinePrice(value: string | null, quantity: number): string {
  const snapshot = parseSnapshot(value);
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("订单商品价格快照缺失，不能安全核销");
  }
  const source = snapshot as Record<string, unknown>;
  const sku = source.sku && typeof source.sku === "object" && !Array.isArray(source.sku)
    ? source.sku as Record<string, unknown>
    : null;
  const legacy = source.productInfo && typeof source.productInfo === "object" && !Array.isArray(source.productInfo)
    ? source.productInfo as Record<string, unknown>
    : null;
  const raw = sku?.price ?? legacy?.truePrice ?? legacy?.price;
  if (typeof raw !== "string" && typeof raw !== "number") {
    throw new Error("订单商品价格快照无效，不能安全核销");
  }
  const cents = decimalToCents(String(raw));
  const total = cents * quantity;
  if (!Number.isSafeInteger(total) || total < 0) throw new Error("核销金额超出安全范围");
  return (total / 100).toFixed(2);
}

function validateRequestedLines(
  items: WriteoffLineInput[] | undefined,
  rows: Array<typeof storeOrderCartInfo.$inferSelect>,
): Map<number, number> {
  if (!items?.length) {
    return new Map(rows.filter((row) => row.writeSurplusTimes > 0).map((row) => [row.id, row.writeSurplusTimes]));
  }
  if (items.length > 200) throw new ValidateException("单次核销商品不能超过200项");
  const byId = new Map(rows.map((row) => [row.id, row]));
  const byLegacyId = new Map<string, Array<typeof storeOrderCartInfo.$inferSelect>>();
  for (const row of rows) {
    const list = byLegacyId.get(row.cartId) ?? [];
    list.push(row);
    byLegacyId.set(row.cartId, list);
  }
  const requested = new Map<number, number>();
  for (const item of items) {
    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
      throw new ValidateException("核销数量必须是正整数");
    }
    let row: typeof storeOrderCartInfo.$inferSelect | undefined;
    if (item.orderCartId !== undefined) {
      if (!Number.isSafeInteger(item.orderCartId) || item.orderCartId <= 0) {
        throw new ValidateException("订单商品ID错误");
      }
      row = byId.get(item.orderCartId);
    } else if (item.cartId !== undefined) {
      const matches = byLegacyId.get(String(item.cartId)) ?? [];
      if (matches.length !== 1) throw new ValidateException("核销商品标识不存在或不唯一");
      row = matches[0];
    }
    if (!row) throw new ValidateException("核销商品不属于当前订单");
    if (requested.has(row.id)) throw new ValidateException("核销商品包含重复项");
    if (item.quantity > row.writeSurplusTimes) throw new ValidateException("核销数量超过剩余可用次数");
    requested.set(row.id, item.quantity);
  }
  return requested;
}

export class StoreOrderWriteoffService {
  constructor(
    private readonly container: Container,
    private readonly env: SystemConfigEnv,
  ) {}

  async operatorProfile(uid: number) {
    if (!Number.isSafeInteger(uid) || uid <= 0) throw new ValidateException("用户身份无效");
    const [staffRows, deliveryRows] = await Promise.all([
      this.container.db
        .select({
          id: systemStoreStaff.id,
          store_id: systemStore.id,
          store_name: systemStore.name,
        })
        .from(systemStoreStaff)
        .innerJoin(systemStore, eq(systemStore.id, systemStoreStaff.storeId))
        .innerJoin(user, eq(user.uid, systemStoreStaff.uid))
        .where(and(
          eq(systemStoreStaff.uid, uid),
          eq(systemStoreStaff.status, 1),
          eq(systemStoreStaff.verifyStatus, 1),
          eq(systemStoreStaff.isDel, 0),
          eq(systemStore.isStore, 1),
          eq(systemStore.isShow, 1),
          eq(systemStore.isDel, 0),
          eq(user.status, 1),
          eq(user.isDel, 0),
        ))
        .orderBy(asc(systemStore.id), asc(systemStoreStaff.id))
        .limit(100),
      this.container.db
        .select({
          id: deliveryService.id,
          nickname: deliveryService.nickname,
        })
        .from(deliveryService)
        .innerJoin(user, eq(user.uid, deliveryService.uid))
        .where(and(
          eq(deliveryService.uid, uid),
          eq(deliveryService.type, 0),
          eq(deliveryService.relationId, 0),
          eq(deliveryService.status, 1),
          eq(deliveryService.isDel, 0),
          eq(user.status, 1),
          eq(user.isDel, 0),
        ))
        .orderBy(asc(deliveryService.id))
        .limit(2),
    ]);
    const staffByStore = new Map<number, { id: number; store_id: number; store_name: string; identity_conflict: boolean }>();
    for (const row of staffRows) {
      const existing = staffByStore.get(row.store_id);
      if (existing) {
        existing.identity_conflict = true;
      } else {
        staffByStore.set(row.store_id, { ...row, identity_conflict: false });
      }
    }
    return {
      can_writeoff: staffRows.length > 0 || deliveryRows.length === 1,
      staff_stores: [...staffByStore.values()],
      delivery: deliveryRows.length === 1
        ? { id: deliveryRows[0].id, nickname: deliveryRows[0].nickname }
        : null,
      delivery_identity_conflict: deliveryRows.length > 1,
    };
  }

  async info(actor: WriteoffActor, rawCode: unknown) {
    const code = normalizePickupVerifyCode(rawCode);
    return withTx(this.container, async (tx) => {
      return this.infoUsing(tx, actor, { code });
    });
  }

  /** Legacy mobile route compatibility without trusting a caller-provided auth=0 bypass. */
  async infoByOrderId(actor: WriteoffActor, rawOrderId: unknown) {
    const orderId = positiveOrderId(rawOrderId);
    return withTx(this.container, (tx) => this.infoUsing(tx, actor, { orderId }));
  }

  /** PHP accepted either a 12-digit order code or a user's barcode. */
  async legacySearch(actor: WriteoffActor, rawLookup: unknown) {
    const lookup = legacyLookupValue(rawLookup);
    if (/^\d{12}$/.test(lookup)) return [await this.info(actor, lookup)];
    return withTx(this.container, async (tx) => {
      const users = await tx
        .select({ uid: user.uid })
        .from(user)
        .where(and(
          eq(user.barCode, lookup),
          eq(user.status, 1),
          eq(user.isDel, 0),
        ))
        .orderBy(asc(user.uid))
        .limit(2);
      if (users.length !== 1) throw new NotFoundException("用户不存在或用户码不唯一");
      const orders = await tx
        .select({ id: storeOrder.id })
        .from(storeOrder)
        .where(and(
          eq(storeOrder.uid, users[0].uid),
          this.actorLookupCondition(actor),
          eq(storeOrder.paid, 1),
          inArray(storeOrder.status, [0, 1, 5]),
          inArray(storeOrder.refundStatus, [0, 3]),
          eq(storeOrder.isDel, 0),
          eq(storeOrder.isSystemDel, 0),
        ))
        .orderBy(desc(storeOrder.payTime), desc(storeOrder.id))
        .limit(MAX_LEGACY_SEARCH_RESULTS + 1);
      if (orders.length > MAX_LEGACY_SEARCH_RESULTS) {
        throw new ValidateException("待核销订单过多，请使用12位核销码查询");
      }
      const result = [];
      for (const order of orders) {
        result.push(await this.infoUsing(tx, actor, { orderId: order.id }));
      }
      return result;
    });
  }

  async execute(actor: WriteoffActor, input: ExecuteWriteoffInput) {
    const code = normalizePickupVerifyCode(input.code);
    const settlement = await loadOrderReceiptSettlementContext(this.container, this.env);
    return withTx(this.container, async (tx) => {
      await tx.execute(sql.raw("SET LOCAL lock_timeout = '2s'"));
      await tx.execute(sql.raw("SET LOCAL statement_timeout = '10s'"));
      const candidates = await tx
        .select({ id: storeOrder.id, uid: storeOrder.uid })
        .from(storeOrder)
        .where(and(
          eq(storeOrder.verifyCode, code),
          this.actorLookupCondition(actor),
          eq(storeOrder.isDel, 0),
          eq(storeOrder.isSystemDel, 0),
        ))
        .limit(2);
      if (candidates.length !== 1) throw new NotFoundException("核销订单不存在或核销码不唯一");

      if (actor.kind === "kefu") {
        await lockKefuConversationOwnership(tx, actor.kefuUid, candidates[0].uid);
      }

      await lockOrderSettlement(tx, candidates[0].id);
      const orderRows = await tx
        .select()
        .from(storeOrder)
        .where(and(
          eq(storeOrder.id, candidates[0].id),
          eq(storeOrder.uid, candidates[0].uid),
          eq(storeOrder.verifyCode, code),
        ))
        .limit(1)
        .for("update");
      const order = orderRows[0];
      if (!order) throw new ValidateException("核销码已失效，请重新读取订单");
      const mode = this.writeoffMode(order);
      const operator = await this.requireOperator(tx, actor, order, mode);
      await this.assertOrderState(tx, order, mode);

      const carts = await tx
        .select()
        .from(storeOrderCartInfo)
        .where(eq(storeOrderCartInfo.oid, order.id))
        .orderBy(asc(storeOrderCartInfo.id))
        .for("update");
      if (!carts.length) throw new Error("订单缺少商品快照，不能安全核销");
      const requested = validateRequestedLines(input.items, carts);
      if (!requested.size) throw new ValidateException("订单没有剩余可核销商品");
      const now = Math.floor(Date.now() / 1000);

      for (const cart of carts) {
        const quantity = requested.get(cart.id);
        if (!quantity) continue;
        if (cart.writeStart > 0 && now < cart.writeStart) throw new ValidateException("商品尚未到可核销时间");
        if (cart.writeEnd > 0 && now > cart.writeEnd) throw new ValidateException("商品已超过可核销时间");
        const remaining = cart.writeSurplusTimes - quantity;
        const updated = await tx
          .update(storeOrderCartInfo)
          .set({
            writeSurplusTimes: remaining,
            isWriteoff: remaining === 0 ? 1 : 0,
            writeoffTime: now,
            staffId: operator.staffId,
            deliveryId: operator.deliveryId,
          })
          .where(and(
            eq(storeOrderCartInfo.id, cart.id),
            eq(storeOrderCartInfo.oid, order.id),
            eq(storeOrderCartInfo.writeSurplusTimes, cart.writeSurplusTimes),
          ))
          .returning({ id: storeOrderCartInfo.id });
        if (!updated[0]) throw new ValidateException("核销商品已被处理，请刷新后重试");
        await tx.insert(storeOrderWriteoff).values({
          uid: order.uid,
          oid: order.id,
          orderCartId: cart.id,
          type: cart.type,
          relationId: cart.relationId,
          staffId: operator.staffId,
          productId: cart.productId,
          productType: cart.productType,
          writeoffNum: quantity,
          writeoffPrice: calculateWriteoffLinePrice(cart.cartInfo, quantity),
          writeoffCode: code,
          isAdmin: operator.isAdmin,
          adminId: operator.adminId,
          addTime: now,
        });
      }

      const completed = carts.every((cart) => {
        const quantity = requested.get(cart.id) ?? 0;
        return cart.writeSurplusTimes - quantity === 0;
      });
      if (!completed) {
        const nextCode = await generatePickupVerifyCode(tx, order.id);
        const allowedStatuses = mode === "pickup" ? [0, 5] : [1, 5];
        const updated = await tx
          .update(storeOrder)
          .set({ status: 5, verifyCode: nextCode, clerkId: operator.clerkUid })
          .where(and(eq(storeOrder.id, order.id), inArray(storeOrder.status, allowedStatuses)))
          .returning({ id: storeOrder.id });
        if (!updated[0]) throw new ValidateException("订单核销状态已变化，请刷新后重试");
        if (actor.kind === "kefu") {
          await tx.insert(storeOrderStatus).values({
            oid: order.id,
            changeType: "kefu_order_writeoff",
            changeMessage: `客服 ${actor.kefuUid} 完成部分核销`,
            changeTime: now,
          });
        }
        return { order_id: order.orderId, completed: false, status: 5 };
      }

      const allowedStatuses = mode === "pickup" ? [0, 5] : [1, 5];
      const completedRows = await tx
        .update(storeOrder)
        .set({ status: 2, verifyCode: "", clerkId: operator.clerkUid })
        .where(and(eq(storeOrder.id, order.id), inArray(storeOrder.status, allowedStatuses)))
        .returning();
      const completedOrder = completedRows[0];
      if (!completedOrder) throw new ValidateException("订单核销状态已变化，请刷新后重试");
      await settleCompletedOrderInTx(
        tx,
        completedOrder,
        settlement,
        now,
        actor.kind === "admin"
          ? "管理员完成订单核销"
          : actor.kind === "delivery"
            ? "配送员完成送达核销"
            : actor.kind === "kefu"
              ? "客服完成订单核销"
              : "门店店员完成订单核销",
      );
      if (actor.kind === "kefu") {
        await tx.insert(storeOrderStatus).values({
          oid: order.id,
          changeType: "kefu_order_writeoff",
          changeMessage: `客服 ${actor.kefuUid} 完成全部核销`,
          changeTime: now,
        });
      }
      return { order_id: order.orderId, completed: true, status: 2 };
    });
  }

  private async infoUsing(
    tx: DbClient,
    actor: WriteoffActor,
    lookup: { code: string } | { orderId: number },
  ) {
    const orders = await tx
      .select()
      .from(storeOrder)
      .where(and(
        "code" in lookup
          ? eq(storeOrder.verifyCode, lookup.code)
          : eq(storeOrder.id, lookup.orderId),
        this.actorLookupCondition(actor),
        eq(storeOrder.isDel, 0),
        eq(storeOrder.isSystemDel, 0),
      ))
      .limit(2);
    if (orders.length !== 1) {
      throw new NotFoundException(
        "code" in lookup ? "核销订单不存在或核销码不唯一" : "核销订单不存在",
      );
    }
    const order = orders[0];
    const mode = this.writeoffMode(order);
    await this.requireOperator(tx, actor, order, mode);
    await this.assertOrderState(tx, order, mode);
    const carts = await tx
      .select()
      .from(storeOrderCartInfo)
      .where(eq(storeOrderCartInfo.oid, order.id))
      .orderBy(asc(storeOrderCartInfo.id))
      .limit(MAX_ORDER_CART_ROWS + 1);
    if (carts.length > MAX_ORDER_CART_ROWS) {
      throw new ValidateException("订单商品行数异常，请先完成数据核对");
    }
    const writeoffCount = carts.reduce(
      (total, cart) => total + Math.max(cart.writeTimes - cart.writeSurplusTimes, 0),
      0,
    );
    const first = carts[0];
    const writeDay = !first || (!first.writeStart && !first.writeEnd)
      ? "不限时"
      : `${first.writeStart ? new Date((first.writeStart + 8 * 60 * 60) * 1_000).toISOString().slice(0, 10) : ""}/${first.writeEnd ? new Date((first.writeEnd + 8 * 60 * 60) * 1_000).toISOString().slice(0, 10) : ""}`;
    const projected = carts.map((cart) => ({
      id: cart.id,
      cart_id: cart.cartId,
      cart_num: cart.cartNum,
      product_id: cart.productId,
      product_type: cart.productType,
      write_times: cart.writeTimes,
      write_surplus_times: cart.writeSurplusTimes,
      surplus_num: cart.writeSurplusTimes,
      is_writeoff: cart.isWriteoff,
      write_start: cart.writeStart,
      write_end: cart.writeEnd,
      cart_info: parseSnapshot(cart.cartInfo),
    }));
    const firstSnapshot = projected[0]?.cart_info;
    const firstRecord = firstSnapshot && typeof firstSnapshot === "object" && !Array.isArray(firstSnapshot)
      ? firstSnapshot as Record<string, unknown>
      : undefined;
    const firstProduct = firstRecord?.productInfo && typeof firstRecord.productInfo === "object" && !Array.isArray(firstRecord.productInfo)
      ? firstRecord.productInfo as Record<string, unknown>
      : undefined;
    return {
      id: order.id,
      order_id: order.orderId,
      store_id: order.storeId,
      uid: order.uid,
      shipping_type: order.shippingType,
      delivery_type: order.deliveryType,
      actor_kind: actor.kind,
      real_name: order.realName,
      user_phone: maskPhone(order.userPhone),
      status: order.status,
      total_num: order.totalNum,
      product_type: order.productType,
      write_off: writeoffCount,
      write_times: first?.writeTimes ?? 0,
      write_day: writeDay,
      cart_count: projected.length,
      writeoff_count: writeoffCount,
      image: typeof firstProduct?.image === "string" ? firstProduct.image : "",
      cart_info: projected,
    };
  }

  private actorLookupCondition(actor: WriteoffActor) {
    if (actor.kind === "staff") return eq(storeOrder.shippingType, 2);
    if (actor.kind === "delivery") {
      return and(eq(storeOrder.deliveryType, "send"), eq(storeOrder.deliveryUid, actor.uid));
    }
    if (actor.kind === "kefu") {
      return or(eq(storeOrder.shippingType, 2), eq(storeOrder.deliveryType, "send"));
    }
    return or(eq(storeOrder.shippingType, 2), eq(storeOrder.deliveryType, "send"));
  }

  private writeoffMode(order: typeof storeOrder.$inferSelect): WriteoffMode {
    if (order.shippingType === 2 && order.storeId > 0) return "pickup";
    if ([1, 3].includes(order.shippingType) && order.deliveryType === "send" && order.deliveryUid > 0) {
      return "delivery";
    }
    throw new ValidateException("该订单不是可核销的自提或配送订单");
  }

  private async assertOrderState(
    tx: DbClient,
    order: typeof storeOrder.$inferSelect,
    mode: WriteoffMode,
  ): Promise<void> {
    if (!order.paid) throw new ValidateException("订单尚未支付");
    const allowedStatuses = mode === "pickup" ? [0, 5] : [1, 5];
    if (!allowedStatuses.includes(order.status)) throw new ValidateException("订单状态不允许核销");
    if (![0, 3].includes(order.refundStatus)) throw new ValidateException("订单退款状态不允许核销");
    if (order.pid === -1 || order.supplierAllocationStatus === 1) {
      throw new ValidateException("订单正在拆分或分配，不能核销");
    }
    if (mode === "pickup") {
      const stores = await tx
        .select({ id: systemStore.id })
        .from(systemStore)
        .where(eq(systemStore.id, order.storeId))
        .limit(1);
      if (!stores[0]) throw new ValidateException("订单关联门店不存在");
    }
    const openRefunds = await tx
      .select({ id: storeOrderRefund.id })
      .from(storeOrderRefund)
      .where(and(
        eq(storeOrderRefund.storeOrderId, order.id),
        inArray(storeOrderRefund.refundType, OPEN_REFUND_TYPES),
        eq(storeOrderRefund.isCancel, 0),
        eq(storeOrderRefund.isDel, 0),
      ))
      .limit(1);
    if (openRefunds[0]) throw new ValidateException("订单有待处理售后，不能核销");
    if (order.type === 3) {
      const pinkRows = await tx
        .select({ status: storePink.status })
        .from(storePink)
        .where(eq(storePink.id, order.pinkId))
        .limit(1);
      if (!pinkRows[0] || pinkRows[0].status !== 2) throw new ValidateException("拼团尚未成功，不能核销");
    }
  }

  private async requireOperator(
    tx: DbClient,
    actor: WriteoffActor,
    order: typeof storeOrder.$inferSelect,
    mode: WriteoffMode,
  ): Promise<WriteoffOperator> {
    if (actor.kind === "kefu") {
      if (!Number.isSafeInteger(actor.kefuId) || actor.kefuId <= 0) {
        throw new ValidateException("客服账号身份无效");
      }
      await assertKefuConversationOwnership(tx, actor.kefuUid, order.uid);
      return { staffId: 0, deliveryId: 0, clerkUid: 0, isAdmin: 0, adminId: 0 };
    }
    if (actor.kind === "admin") {
      if (!Number.isSafeInteger(actor.adminId) || actor.adminId <= 0) throw new ValidateException("管理员身份无效");
      return { staffId: 0, deliveryId: 0, clerkUid: 0, isAdmin: 1, adminId: actor.adminId };
    }
    if (!Number.isSafeInteger(actor.uid) || actor.uid <= 0) throw new ValidateException("核销员身份无效");
    if (actor.kind === "delivery") {
      if (mode !== "delivery" || order.deliveryUid !== actor.uid) {
        throw new ValidateException("当前账号不是该订单的配送员");
      }
      const rows = await tx
        .select({ id: deliveryService.id })
        .from(deliveryService)
        .innerJoin(user, eq(user.uid, deliveryService.uid))
        .where(and(
          eq(deliveryService.uid, actor.uid),
          eq(deliveryService.type, 0),
          eq(deliveryService.relationId, 0),
          eq(deliveryService.status, 1),
          eq(deliveryService.isDel, 0),
          eq(user.status, 1),
          eq(user.isDel, 0),
        ))
        .orderBy(asc(deliveryService.id))
        .limit(2);
      if (rows.length !== 1) throw new ValidateException("当前账号不是有效平台配送员或身份存在重复");
      return { staffId: 0, deliveryId: rows[0].id, clerkUid: actor.uid, isAdmin: 0, adminId: 0 };
    }
    if (mode !== "pickup") throw new ValidateException("门店店员不能核销配送订单");
    const rows = await tx
      .select({ id: systemStoreStaff.id })
      .from(systemStoreStaff)
      .innerJoin(systemStore, eq(systemStore.id, systemStoreStaff.storeId))
      .innerJoin(user, eq(user.uid, systemStoreStaff.uid))
      .where(and(
        eq(systemStoreStaff.uid, actor.uid),
        eq(systemStoreStaff.storeId, order.storeId),
        eq(systemStoreStaff.status, 1),
        eq(systemStoreStaff.verifyStatus, 1),
        eq(systemStoreStaff.isDel, 0),
        eq(systemStore.isStore, 1),
        eq(systemStore.isShow, 1),
        eq(systemStore.isDel, 0),
        eq(user.status, 1),
        eq(user.isDel, 0),
      ))
      .limit(2);
    if (rows.length !== 1) throw new ValidateException("当前账号不是该门店的有效核销员");
    return { staffId: rows[0].id, deliveryId: 0, clerkUid: actor.uid, isAdmin: 0, adminId: 0 };
  }
}
