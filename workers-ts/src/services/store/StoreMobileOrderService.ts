import { and, asc, eq, inArray } from "drizzle-orm";
import type { Env } from "@/env";
import type { Container, DbClient } from "@/lib/di";
import {
  deliveryService,
  expressCompany,
  storeConfig,
  storeCouponIssue,
  storeOrder,
  storeOrderCartInfo,
  storeOrderPromotions,
  storeOrderRefund,
  storePink,
  storeService,
  systemStore,
  systemStoreStaff,
  user,
} from "@/models/schema";
import {
  cartProjection,
  orderProjection,
  refundProjection,
} from "@/services/kefu/KefuOrderService";
import {
  StoreOrderWriteoffService,
  type WriteoffActor,
} from "@/services/order/StoreOrderWriteoffService";
import {
  normalizeSupplierSplitCartInput,
  SupplierFulfillmentService,
  type FulfillmentAuthorizationScope,
  type SupplierDeliveryInput,
} from "@/services/supplier/SupplierFulfillmentService";
import { SystemConfigService } from "@/services/system/SystemConfigService";
import { normalizeConfigScalar } from "@/utils/config";
import { NotFoundException, ValidateException } from "@/utils/errors";

const STORE_CONFIG_SCOPE_TYPE = 1;
const MAX_JSON_SNAPSHOT_BYTES = 256 * 1024;
const MAX_ORDER_CART_ROWS = 500;
const MAX_ORDER_REFUND_ROWS = 200;
const MAX_ORDER_PROMOTION_ROWS = 500;
const EXPRESS_CONFIG_KEYS = [
  "store_config_export_open",
  "store_config_export_id",
  "store_config_export_temp_id",
  "store_config_export_to_name",
  "store_config_export_to_tel",
  "store_config_export_to_address",
] as const;

interface StoreStaffScope {
  id: number;
  storeId: number;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) {
    throw new ValidateException(`${label}错误`);
  }
  return parsed;
}

function boundedString(
  value: unknown,
  label: string,
  maxLength: number,
  required = false,
): string {
  if (value === undefined || value === null) {
    if (required) throw new ValidateException(`${label}不能为空`);
    return "";
  }
  if (typeof value !== "string" && typeof value !== "number") {
    throw new ValidateException(`${label}格式错误`);
  }
  const normalized = String(value).trim();
  if (required && !normalized) throw new ValidateException(`${label}不能为空`);
  if ([...normalized].length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new ValidateException(`${label}不能超过${maxLength}个可见字符`);
  }
  return normalized;
}

function enabled(value: unknown): boolean {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

function parseSnapshot(value: string | null): unknown {
  if (!value || value.length > MAX_JSON_SNAPSHOT_BYTES) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function money(value: number): string {
  return Number.isFinite(value) ? Math.max(value, 0).toFixed(2) : "0.00";
}

function couponIds(value: string | null): number[] {
  if (!value) return [];
  const ids = value
    .replace(/[\[\]"]/g, "")
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
  return [...new Set(ids)].slice(0, 100);
}

export function normalizeStoreSplitDeliveryInput(
  body: Record<string, unknown>,
): SupplierDeliveryInput {
  const type = Number(body.type ?? 1);
  if (!Number.isSafeInteger(type) || ![1, 2, 3].includes(type)) {
    throw new ValidateException("发货类型错误");
  }
  if (type === 1) {
    const recordType = Number(body.express_record_type ?? 1);
    if (recordType !== 1) {
      throw new ValidateException("电子面单或商家寄件必须通过可重试面单任务提交");
    }
    return {
      deliveryType: "express",
      deliveryName: boundedString(body.delivery_name, "快递公司", 64, true),
      deliveryCode: boundedString(body.delivery_code, "快递公司编码", 50),
      deliveryId: boundedString(body.delivery_id, "快递单号", 64, true),
      fictitiousContent: "",
      deliveryUid: 0,
    };
  }
  if (type === 2) {
    const deliveryMode = Number(body.delivery_type ?? 1);
    if (deliveryMode !== 1) throw new ValidateException("第三方同城配送尚未接入门店履约链路");
    return {
      deliveryType: "send",
      deliveryName: "",
      deliveryCode: "",
      deliveryId: "",
      fictitiousContent: "",
      deliveryUid: positiveInteger(body.sh_delivery_uid ?? body.delivery_uid, "配送员ID"),
    };
  }
  return {
    deliveryType: "fictitious",
    deliveryName: "",
    deliveryCode: "",
    deliveryId: "",
    fictitiousContent: boundedString(body.fictitious_content, "虚拟发货内容", 500, true),
    deliveryUid: 0,
  };
}

export class StoreMobileOrderService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  private staffQuery(db: DbClient, uid: number) {
    return db
      .select({ id: systemStoreStaff.id, storeId: systemStoreStaff.storeId })
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
      .orderBy(asc(systemStoreStaff.id))
      .limit(2);
  }

  private async requireStaffUsing(db: DbClient, uidValue: unknown, lock = false): Promise<StoreStaffScope> {
    const uid = positiveInteger(uidValue, "用户身份");
    const rows = lock
      ? await this.staffQuery(db, uid).for("key share")
      : await this.staffQuery(db, uid);
    if (!rows.length) throw new NotFoundException("当前账号不是有效门店核销员");
    if (rows.length !== 1) throw new ValidateException("门店店员身份存在重复，请先清理历史数据");
    return rows[0];
  }

  async resolveWriteoffActor(uidValue: unknown, authValue: unknown): Promise<WriteoffActor> {
    const uid = positiveInteger(uidValue, "用户身份");
    const auth = Number(authValue);
    if (auth === 2) return { kind: "delivery", uid };
    if (auth !== 1) throw new ValidateException("核销身份类型仅支持客服或配送员");
    const rows = await this.container.db
      .select({ id: storeService.id })
      .from(storeService)
      .innerJoin(user, eq(user.uid, storeService.uid))
      .where(and(
        eq(storeService.uid, uid),
        eq(storeService.status, 1),
        eq(storeService.accountStatus, 1),
        eq(storeService.customer, 1),
        eq(storeService.isDel, 0),
        eq(user.status, 1),
        eq(user.isDel, 0),
      ))
      .orderBy(asc(storeService.id))
      .limit(2);
    if (!rows.length) throw new NotFoundException("当前账号不是有效客服");
    if (rows.length !== 1) throw new ValidateException("客服身份存在重复，请先清理历史数据");
    return { kind: "kefu", kefuId: rows[0].id, kefuUid: uid };
  }

  async writeoffInfo(uid: unknown, auth: unknown, lookup: unknown) {
    const actor = await this.resolveWriteoffActor(uid, auth);
    return new StoreOrderWriteoffService(this.container, this.env).legacySearch(actor, lookup);
  }

  async writeoffCartInfo(uid: unknown, auth: unknown, orderId: unknown) {
    const actor = await this.resolveWriteoffActor(uid, auth);
    return new StoreOrderWriteoffService(this.container, this.env).infoByOrderId(actor, orderId);
  }

  async orderDetail(uidValue: unknown, idValue: unknown) {
    const staff = await this.requireStaffUsing(this.container.db, uidValue);
    const id = positiveInteger(idValue, "订单ID");
    const rows = await this.container.db
      .select()
      .from(storeOrder)
      .where(and(
        eq(storeOrder.id, id),
        eq(storeOrder.storeId, staff.storeId),
        eq(storeOrder.isSystemDel, 0),
      ))
      .limit(1);
    const order = rows[0];
    if (!order) throw new NotFoundException("订单不存在或不属于当前门店");
    const ids = couponIds(order.giveCoupon);
    const [carts, refunds, stores, users, promotions, coupons, pink] = await Promise.all([
      this.container.db.select().from(storeOrderCartInfo)
        .where(eq(storeOrderCartInfo.oid, order.id)).orderBy(asc(storeOrderCartInfo.id))
        .limit(MAX_ORDER_CART_ROWS + 1),
      this.container.db.select().from(storeOrderRefund).where(and(
        eq(storeOrderRefund.storeOrderId, order.id),
        eq(storeOrderRefund.storeId, staff.storeId),
        eq(storeOrderRefund.isCancel, 0),
        eq(storeOrderRefund.isDel, 0),
      )).orderBy(asc(storeOrderRefund.id)).limit(MAX_ORDER_REFUND_ROWS + 1),
      this.container.db.select({
        id: systemStore.id,
        name: systemStore.name,
        phone: systemStore.phone,
        address: systemStore.address,
        detailed_address: systemStore.detailedAddress,
      }).from(systemStore).where(eq(systemStore.id, staff.storeId)).limit(1),
      this.container.db.select({ nickname: user.nickname }).from(user)
        .where(eq(user.uid, order.uid)).limit(1),
      this.container.db.select({
        promotions_id: storeOrderPromotions.promotionsId,
        product_id: storeOrderPromotions.productId,
        promotions_price: storeOrderPromotions.promotionsPrice,
      }).from(storeOrderPromotions).where(eq(storeOrderPromotions.oid, order.id))
        .orderBy(asc(storeOrderPromotions.id)).limit(MAX_ORDER_PROMOTION_ROWS + 1),
      ids.length
        ? this.container.db.select({ id: storeCouponIssue.id, coupon_title: storeCouponIssue.couponTitle })
            .from(storeCouponIssue).where(inArray(storeCouponIssue.id, ids)).orderBy(asc(storeCouponIssue.id))
        : Promise.resolve([]),
      order.type === 3
        ? this.container.db.select({ status: storePink.status }).from(storePink)
            .where(eq(storePink.id, order.pinkId)).limit(1)
        : Promise.resolve([]),
    ]);
    if (carts.length > MAX_ORDER_CART_ROWS
      || refunds.length > MAX_ORDER_REFUND_ROWS
      || promotions.length > MAX_ORDER_PROMOTION_ROWS) {
      throw new ValidateException("订单关联数据行数异常，请先完成数据核对");
    }
    const projected = orderProjection(order, carts, refunds);
    const vipTruePrice = carts.reduce(
      (total, cart) => total + Number(cartProjection(cart).vip_sum_truePrice),
      0,
    );
    return {
      ...projected,
      split: null,
      total_price: money(Number(projected.total_price) - vipTruePrice),
      vip_true_price: money(vipTruePrice),
      promotions_detail: promotions,
      give_coupon: coupons,
      give_integral: order.giveIntegral,
      pinkStatus: pink[0]?.status ?? null,
      nickname: users[0]?.nickname ?? "",
      store: stores[0] ?? null,
    };
  }

  async refundDetail(uidValue: unknown, idValue: unknown) {
    const staff = await this.requireStaffUsing(this.container.db, uidValue);
    const id = positiveInteger(idValue, "退款ID");
    const rows = await this.container.db
      .select({ refund: storeOrderRefund, order: storeOrder })
      .from(storeOrderRefund)
      .innerJoin(storeOrder, eq(storeOrder.id, storeOrderRefund.storeOrderId))
      .where(and(
        eq(storeOrderRefund.id, id),
        eq(storeOrderRefund.storeId, staff.storeId),
        eq(storeOrderRefund.isCancel, 0),
        eq(storeOrderRefund.isDel, 0),
        eq(storeOrder.storeId, staff.storeId),
        eq(storeOrder.uid, storeOrderRefund.uid),
        eq(storeOrder.isSystemDel, 0),
      ))
      .limit(1);
    if (!rows[0]) throw new NotFoundException("退款订单不存在或不属于当前门店");
    const { refund, order } = rows[0];
    const [carts, users, express] = await Promise.all([
      this.container.db.select().from(storeOrderCartInfo)
        .where(eq(storeOrderCartInfo.oid, order.id)).orderBy(asc(storeOrderCartInfo.id))
        .limit(MAX_ORDER_CART_ROWS + 1),
      this.container.db.select({ nickname: user.nickname }).from(user)
        .where(eq(user.uid, refund.uid)).limit(1),
      refund.refundType === 4
        ? this.container.db.select({ id: expressCompany.id, code: expressCompany.code, name: expressCompany.name })
            .from(expressCompany).where(and(eq(expressCompany.isShow, 1), eq(expressCompany.status, 1)))
            .orderBy(asc(expressCompany.id)).limit(200)
        : Promise.resolve([]),
    ]);
    if (carts.length > MAX_ORDER_CART_ROWS) {
      throw new ValidateException("退款订单商品行数异常，请先完成数据核对");
    }
    const projected = refundProjection(refund, carts);
    return {
      ...projected,
      type: order.type,
      store_order_sn: order.orderId,
      product_type: order.productType,
      store_id: order.storeId,
      supplier_id: order.supplierId,
      shipping_type: order.shippingType,
      real_name: order.realName,
      user_phone: order.userPhone,
      user_address: order.userAddress,
      pay_type: order.payType,
      mark: order.mark,
      custom_form: parseSnapshot(order.customForm),
      first_order_price: order.firstOrderPrice,
      nickname: users[0]?.nickname ?? "",
      cart_info: projected.cartInfo,
      express_list: express,
    };
  }

  async deliveryInfo(uidValue: unknown, orderIdValue: unknown) {
    const staff = await this.requireStaffUsing(this.container.db, uidValue);
    const orderId = boundedString(orderIdValue, "订单编号", 32, true);
    const orders = await this.container.db
      .select({
        id: storeOrder.id,
        store_id: storeOrder.storeId,
        real_name: storeOrder.realName,
        user_phone: storeOrder.userPhone,
        user_address: storeOrder.userAddress,
        order_id: storeOrder.orderId,
        uid: storeOrder.uid,
      })
      .from(storeOrder)
      .where(and(
        eq(storeOrder.orderId, orderId),
        eq(storeOrder.storeId, staff.storeId),
        eq(storeOrder.isDel, 0),
        eq(storeOrder.isSystemDel, 0),
      ))
      .limit(2);
    if (orders.length !== 1) throw new NotFoundException("订单不存在、编号不唯一或不属于当前门店");
    const [configRows, globals, users] = await Promise.all([
      this.container.db.select({ id: storeConfig.id, key: storeConfig.keyName, value: storeConfig.value })
        .from(storeConfig).where(and(
          eq(storeConfig.type, STORE_CONFIG_SCOPE_TYPE),
          eq(storeConfig.relationId, staff.storeId),
          inArray(storeConfig.keyName, [...EXPRESS_CONFIG_KEYS]),
        )).orderBy(asc(storeConfig.id)).limit(EXPRESS_CONFIG_KEYS.length + 1),
      new SystemConfigService(this.container, this.env).getMany([
        "city_delivery_status",
        "self_delivery_status",
        "dada_delivery_status",
        "uu_delivery_status",
      ]),
      this.container.db.select({ nickname: user.nickname }).from(user)
        .where(eq(user.uid, orders[0].uid)).limit(1),
    ]);
    const byKey = new Map<string, string>();
    for (const row of configRows) {
      if (byKey.has(row.key)) throw new ValidateException(`门店配置 ${row.key} 存在重复历史记录`);
      byKey.set(row.key, normalizeConfigScalar(row.value));
    }
    const city = enabled(globals.city_delivery_status);
    const self = city && enabled(globals.self_delivery_status);
    const dada = city && enabled(globals.dada_delivery_status);
    const uu = city && enabled(globals.uu_delivery_status);
    const { uid: _uid, ...order } = orders[0];
    return {
      express_temp_id: byKey.get("store_config_export_temp_id") ?? "",
      to_name: byKey.get("store_config_export_to_name") ?? "",
      config_export_id: byKey.get("store_config_export_id") ?? "",
      to_tel: byKey.get("store_config_export_to_tel") ?? "",
      to_add: byKey.get("store_config_export_to_address") ?? "",
      config_export_open: enabled(byKey.get("store_config_export_open")) ? 1 : 0,
      city_delivery_status: city && (self || dada || uu),
      self_delivery_status: self,
      dada_delivery_status: dada,
      uu_delivery_status: uu,
      ...order,
      nickname: users[0]?.nickname ?? "",
    };
  }

  async splitDelivery(uidValue: unknown, idValue: unknown, body: Record<string, unknown>) {
    const uid = positiveInteger(uidValue, "用户身份");
    const staff = await this.requireStaffUsing(this.container.db, uid);
    const orderId = positiveInteger(idValue, "订单ID");
    const rows = await this.container.db
      .select({ id: storeOrder.id, supplierId: storeOrder.supplierId })
      .from(storeOrder)
      .where(and(
        eq(storeOrder.id, orderId),
        eq(storeOrder.storeId, staff.storeId),
        eq(storeOrder.isSystemDel, 0),
      ))
      .limit(1);
    if (!rows[0]) throw new NotFoundException("订单不存在或不属于当前门店");
    const input = normalizeStoreSplitDeliveryInput(body);
    const selected = normalizeSupplierSplitCartInput(body);
    const authorize = async (tx: DbClient, _scope: FulfillmentAuthorizationScope) => {
      const lockedStaff = await this.requireStaffUsing(tx, uid, true);
      if (lockedStaff.id !== staff.id || lockedStaff.storeId !== staff.storeId) {
        throw new ValidateException("门店店员身份已变化，请重新登录");
      }
      if (input.deliveryType !== "send") return;
      const agents = await tx
        .select({ nickname: deliveryService.nickname, phone: deliveryService.phone })
        .from(deliveryService)
        .innerJoin(user, eq(user.uid, deliveryService.uid))
        .where(and(
          eq(deliveryService.uid, input.deliveryUid),
          eq(deliveryService.type, 1),
          eq(deliveryService.relationId, staff.storeId),
          eq(deliveryService.status, 1),
          eq(deliveryService.isDel, 0),
          eq(user.status, 1),
          eq(user.isDel, 0),
        ))
        .orderBy(asc(deliveryService.id))
        .limit(2)
        .for("key share");
      if (agents.length !== 1) throw new ValidateException("配送员不存在、已停用或身份重复");
      input.deliveryName = agents[0].nickname;
      input.deliveryId = agents[0].phone.trim();
    };
    return new SupplierFulfillmentService(this.container, this.env).splitDelivery(
      rows[0].supplierId,
      orderId,
      input,
      selected,
      {
        expectedStoreId: staff.storeId,
        authorize,
        audit: {
          changeType: "store_staff_split_delivery",
          changeMessage: `门店店员 ${staff.id} 提交拆单发货`,
        },
      },
    );
  }
}
