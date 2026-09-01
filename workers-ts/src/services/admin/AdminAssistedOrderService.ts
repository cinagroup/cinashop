import { and, asc, desc, eq, ilike, inArray, or, type SQL } from "drizzle-orm";
import type { Env } from "@/env";
import type { Container, DbClient } from "@/lib/di";
import {
  storeBrand,
  storeCart,
  storeCouponIssue,
  storeCouponProduct,
  storeCouponUser,
  storeOrder,
  storeOrderCartInfo,
  storeOrderRefund,
  storeProduct,
  storeProductCategory,
  systemStore,
} from "@/models/schema";
import {
  calculateCouponDiscountCents,
  calculateCouponEligibleSubtotalCents,
  parseCouponScopeIds,
  reconcileCouponProductScopeIds,
} from "@/services/activity/ProductCouponService";
import { decimalToCents } from "@/services/order/OrderBrokerageService";
import { StoreCartService } from "@/services/order/StoreCartService";
import {
  StoreOrderCreateService,
  type OrderPricingQuote,
} from "@/services/order/StoreOrderCreateService";
import { StoreOrderPayService } from "@/services/order/StoreOrderPayService";
import { getPaymentReadiness } from "@/services/payment/PaymentReadinessService";
import { NotFoundException, ValidateException } from "@/utils/errors";

const ASSISTED_CHECKOUT_TTL_SECONDS = 30 * 60;
const MAX_CART_ITEMS = 200;
const MAX_LIST_LIMIT = 100;

interface AssistedCheckoutSnapshot {
  version: 1;
  adminId: number;
  uid: number;
  touristUid: string;
  cartIds: number[];
  isNew: number;
  createdAt: number;
}

interface AssistedSelection {
  uid: number;
  touristUid: string;
  cartIds: number[];
  isNew: number;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseJson(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    return record(JSON.parse(value));
  } catch {
    return {};
  }
}

function integer(
  value: unknown,
  label: string,
  options: { min?: number; max?: number; fallback?: number } = {},
): number {
  const source = value === undefined || value === null || value === "" ? options.fallback : value;
  if (source === undefined) throw new ValidateException(`${label}无效`);
  const raw = Number(source);
  if (!Number.isSafeInteger(raw)) throw new ValidateException(`${label}无效`);
  const min = options.min ?? Number.MIN_SAFE_INTEGER;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  if (raw < min || raw > max) throw new ValidateException(`${label}无效`);
  return raw;
}

function boundedText(value: unknown, label: string, max: number): string {
  const text = String(value ?? "").trim();
  if (text.length > max) throw new ValidateException(`${label}过长`);
  return text;
}

export function parseAssistedUid(value: unknown): number {
  return integer(value, "用户参数", { min: 0 });
}

export function parseAssistedTouristUid(value: unknown, uid: number, required = true): string {
  const touristUid = boundedText(value, "游客标识", 50);
  if (uid > 0) return "";
  if (!touristUid && !required) return "";
  if (!touristUid || !/^[A-Za-z0-9_-]+$/.test(touristUid)) {
    throw new ValidateException("游客标识无效");
  }
  return touristUid;
}

export function parseAssistedCartIds(value: unknown): number[] {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : value === undefined || value === null
        ? []
        : [value];
  const ids = source.map((item) => Number(item));
  if (
    !ids.length || ids.length > MAX_CART_ITEMS || new Set(ids).size !== ids.length ||
    ids.some((id) => !Number.isSafeInteger(id) || id <= 0)
  ) throw new ValidateException("请提交有效的购物车商品");
  return ids;
}

function parseBooleanSwitch(value: unknown): boolean {
  if (value === true || value === 1 || value === "1" || value === "true") return true;
  if (value === false || value === 0 || value === "0" || value === "false" || value === "") return false;
  throw new ValidateException("开关参数无效");
}

function checkoutKey(adminId: number, uid: number, key: string): string {
  return `admin:assisted:checkout:${adminId}:${uid}:${key}`;
}

function money(cents: number): string {
  return (cents / 100).toFixed(2);
}

function priceGroup(quote: OrderPricingQuote) {
  return {
    sumPrice: money(quote.rawTotalCents),
    totalPrice: money(quote.totalCents),
    total_price: money(quote.totalCents),
    pay_price: money(quote.payCents),
    total_postage: money(quote.totalPostageCents),
    pay_postage: money(quote.payPostageCents),
    storePostage: money(quote.totalPostageCents),
    storePostageDiscount: money(quote.postageDiscountCents),
    vipPrice: money(quote.memberDiscountCents),
    levelPrice: money(quote.levelDiscountCents),
    memberPrice: money(quote.paidMemberDiscountCents),
    couponPrice: money(quote.couponPriceCents),
    coupon_price: money(quote.couponPriceCents),
    deduction_price: money(quote.deductionCents),
    pay_integral: 0,
    usedIntegral: quote.usedIntegralPoints,
    SurplusIntegral: quote.surplusIntegralPoints,
    firstOrderPrice: money(quote.firstOrderPriceCents),
    first_order_price: money(quote.firstOrderPriceCents),
    storeFreePostage: money(quote.storeFreePostageCents),
    isStoreFreePostage: quote.isStoreFreePostage,
    promotions_detail: [],
  };
}

function legacyAddress(address: Record<string, unknown> | null) {
  if (!address) return null;
  return {
    ...address,
    real_name: address.realName ?? "",
    city_id: address.cityId ?? 0,
    post_code: address.postCode ?? 0,
    is_default: address.isDefault ?? 0,
    add_time: address.addTime ?? 0,
  };
}

function normalizePayType(value: unknown): "weixin" | "alipay" | "cash" {
  const payType = String(value ?? "weixin").trim().toLowerCase();
  if (payType !== "weixin" && payType !== "alipay" && payType !== "cash") {
    throw new ValidateException("支付方式错误");
  }
  return payType;
}

function normalizeOrderId(value: unknown): string {
  const input = boundedText(value, "订单号", 64);
  if (!input) throw new ValidateException("订单号无效");
  const orderId = input.replace(/^\d{3}_/, "");
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(orderId)) throw new ValidateException("订单号无效");
  return orderId;
}

function statusTitle(order: typeof storeOrder.$inferSelect): string {
  if (order.isDel || order.isSystemDel) return "已取消";
  if (!order.paid) return "待付款";
  if ([1, 4].includes(order.refundStatus)) return "退款中";
  if (order.refundStatus === 2) return "已退款";
  if (order.status === 0) return order.shippingType === 2 ? "待核销" : "待发货";
  if (order.status === 1) return "待收货";
  if (order.status === 2) return "待评价";
  if (order.status === 3) return "已完成";
  if (order.status === 4) return "部分发货";
  if (order.status === 5) return "部分核销";
  return "处理中";
}

const ASSISTED_ORDER_STATUSES = new Set([-4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

function appendOrderStatusConditions(conditions: SQL[], status: number): void {
  switch (status) {
    case 0:
      conditions.push(
        eq(storeOrder.paid, 0),
        eq(storeOrder.status, 0),
        eq(storeOrder.refundStatus, 0),
        eq(storeOrder.isDel, 0),
      );
      break;
    case 1:
      conditions.push(
        eq(storeOrder.paid, 1),
        inArray(storeOrder.status, [0, 4]),
        inArray(storeOrder.refundStatus, [0, 3]),
        inArray(storeOrder.shippingType, [1, 3]),
        eq(storeOrder.isDel, 0),
      );
      break;
    case 2:
      conditions.push(
        eq(storeOrder.paid, 1),
        or(
          and(inArray(storeOrder.status, [1, 5]), eq(storeOrder.shippingType, 1)),
          and(inArray(storeOrder.status, [0, 5]), eq(storeOrder.shippingType, 2)),
        )!,
        inArray(storeOrder.refundStatus, [0, 3]),
        eq(storeOrder.isDel, 0),
      );
      break;
    case 3:
      conditions.push(
        eq(storeOrder.paid, 1),
        eq(storeOrder.status, 2),
        inArray(storeOrder.refundStatus, [0, 3]),
        eq(storeOrder.isDel, 0),
      );
      break;
    case 4:
      conditions.push(
        eq(storeOrder.paid, 1),
        eq(storeOrder.status, 3),
        inArray(storeOrder.refundStatus, [0, 3]),
        eq(storeOrder.isDel, 0),
      );
      break;
    case 5:
      conditions.push(
        eq(storeOrder.paid, 1),
        inArray(storeOrder.status, [0, 1, 5]),
        inArray(storeOrder.refundStatus, [0, 3]),
        eq(storeOrder.shippingType, 2),
        eq(storeOrder.isDel, 0),
      );
      break;
    case 6:
      conditions.push(
        eq(storeOrder.paid, 1),
        eq(storeOrder.status, 2),
        inArray(storeOrder.refundStatus, [0, 3]),
        eq(storeOrder.shippingType, 2),
        eq(storeOrder.isDel, 0),
      );
      break;
    case 7:
      conditions.push(
        eq(storeOrder.paid, 1),
        eq(storeOrder.status, 4),
        inArray(storeOrder.refundStatus, [0, 3]),
        eq(storeOrder.isDel, 0),
      );
      break;
    case 8:
      conditions.push(
        eq(storeOrder.paid, 1),
        inArray(storeOrder.status, [0, 1, 2, 5]),
        inArray(storeOrder.refundStatus, [0, 3]),
        eq(storeOrder.shippingType, 2),
        eq(storeOrder.isDel, 0),
      );
      break;
    case 9:
      conditions.push(
        eq(storeOrder.paid, 1),
        inArray(storeOrder.status, [2, 3]),
        inArray(storeOrder.refundStatus, [0, 3]),
        eq(storeOrder.isDel, 0),
      );
      break;
    case -1:
      conditions.push(
        eq(storeOrder.paid, 1),
        inArray(storeOrder.refundStatus, [1, 4]),
        eq(storeOrder.isDel, 0),
      );
      break;
    case -2:
      conditions.push(
        eq(storeOrder.paid, 1),
        eq(storeOrder.refundStatus, 2),
        eq(storeOrder.isDel, 0),
      );
      break;
    case -3:
      conditions.push(
        eq(storeOrder.paid, 1),
        inArray(storeOrder.refundStatus, [1, 2, 4]),
        eq(storeOrder.isDel, 0),
      );
      break;
    case -4:
      conditions.push(eq(storeOrder.isDel, 1));
      break;
  }
}

function appendOrderTypeConditions(conditions: SQL[], type: number): void {
  if (type >= 0 && type <= 8) {
    conditions.push(eq(storeOrder.type, type));
    return;
  }
  if (type === 105) conditions.push(eq(storeOrder.shippingType, 2));
  else if (type === 106) conditions.push(eq(storeOrder.shippingType, 4));
  else if (type === 107) conditions.push(inArray(storeOrder.shippingType, [1, 3]));
  else throw new ValidateException("订单类型无效");
}

function assistedListPayType(value: unknown): string {
  const input = boundedText(value, "支付方式", 32).toLowerCase();
  const legacy: Record<string, string> = {
    "1": "weixin",
    "2": "yue",
    "3": "offline",
    "4": "alipay",
    "5": "integral",
  };
  return legacy[input] ?? input;
}

function legacyCartSnapshot(row: typeof storeOrderCartInfo.$inferSelect) {
  const snapshot = parseJson(row.cartInfo);
  const product = record(snapshot.productInfo ?? snapshot.product);
  const sku = record(snapshot.sku ?? record(product.attrInfo));
  const price = String(sku.price ?? (row.cartNum > 0
    ? (Number(snapshot.sum_true_price ?? 0) / row.cartNum).toFixed(2)
    : "0.00"));
  return {
    id: row.id,
    oid: row.oid,
    cart_id: row.cartId,
    cart_num: row.cartNum,
    product_id: row.productId,
    product_type: row.productType,
    type: row.type,
    is_gift: row.isGift,
    refund_num: row.refundNum,
    surplus_num: row.surplusNum,
    unique: row.unique,
    add_time: row.addTime,
    productInfo: {
      id: Number(product.id ?? row.productId),
      image: String(product.image ?? sku.image ?? ""),
      store_name: String(product.store_name ?? product.storeName ?? ""),
      price,
      attrInfo: {
        product_id: row.productId,
        suk: String(sku.suk ?? ""),
        price,
        image: String(sku.image ?? product.image ?? ""),
      },
    },
  };
}

export class AdminAssistedOrderService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  private cartService(): StoreCartService {
    return new StoreCartService(this.container, this.env);
  }

  async cartList(adminId: number, uid: number, query: Record<string, string>) {
    const touristUid = parseAssistedTouristUid(query.tourist_uid, uid);
    const isNew = integer(query.new, "购物车类型", { min: 0, max: 1, fallback: 0 });
    const ids = query.cart_ids ? parseAssistedCartIds(query.cart_ids) : undefined;
    return this.cartService().listAssistedLegacyV2({ adminId, uid, touristUid, isNew, ids });
  }

  async cartAdd(adminId: number, uid: number, body: Record<string, unknown>) {
    const touristUid = parseAssistedTouristUid(body.tourist_uid, uid);
    const result = await this.cartService().addAssisted({
      adminId,
      uid,
      touristUid,
      productId: integer(body.productId, "商品参数", { min: 1 }),
      unique: boundedText(body.uniqueId, "商品规格", 16),
      cartNum: integer(body.cartNum, "购买数量", { min: 1, max: 32767, fallback: 1 }),
      isNew: integer(body.new, "购物车类型", { min: 0, max: 1, fallback: 1 }),
    });
    return { cartId: result.cartId };
  }

  async cartNum(adminId: number, uid: number, body: Record<string, unknown>): Promise<void> {
    const id = integer(body.id, "购物车参数", { min: 1 });
    const touristUid = await this.resolveTouristUid(adminId, uid, [id], body.tourist_uid);
    await this.cartService().setAssistedNum({
      adminId,
      uid,
      touristUid,
      id,
      cartNum: integer(body.number, "购买数量", { min: 1, max: 32767 }),
    });
  }

  async cartDel(adminId: number, uid: number, body: Record<string, unknown>): Promise<void> {
    const ids = parseAssistedCartIds(body.ids);
    const touristUid = await this.resolveTouristUid(adminId, uid, ids, body.tourist_uid);
    await this.cartService().delAssisted({
      adminId,
      uid,
      touristUid,
      ids,
    });
  }

  private async resolveTouristUid(
    adminId: number,
    uid: number,
    cartIds: number[],
    touristValue: unknown,
  ): Promise<string> {
    let touristUid = parseAssistedTouristUid(touristValue, uid, false);
    if (uid > 0 || touristUid) return touristUid;
    const rows = await this.container.db.select({ touristUid: storeCart.touristUid })
      .from(storeCart)
      .where(and(
        inArray(storeCart.id, cartIds),
        eq(storeCart.uid, 0),
        eq(storeCart.staffId, adminId),
        eq(storeCart.isPay, 0),
        eq(storeCart.isDel, 0),
      ));
    const labels = new Set(rows.map((row) => row.touristUid).filter(Boolean));
    if (rows.length !== cartIds.length || labels.size !== 1) {
      throw new ValidateException("游客购物车不属于同一代客会话");
    }
    touristUid = parseAssistedTouristUid([...labels][0], uid);
    return touristUid;
  }

  private async selection(
    adminId: number,
    uid: number,
    cartValue: unknown,
    touristValue: unknown,
    isNewValue: unknown,
  ): Promise<AssistedSelection> {
    const cartIds = parseAssistedCartIds(cartValue);
    const isNew = integer(isNewValue, "购物车类型", { min: 0, max: 1, fallback: 0 });
    const touristUid = await this.resolveTouristUid(adminId, uid, cartIds, touristValue);
    await this.cartService().listAssistedLegacyV2({ adminId, uid, touristUid, isNew, ids: cartIds });
    return { uid, touristUid, cartIds, isNew };
  }

  private async remember(adminId: number, selection: AssistedSelection): Promise<string> {
    const key = crypto.randomUUID().replaceAll("-", "");
    const snapshot: AssistedCheckoutSnapshot = {
      version: 1,
      adminId,
      uid: selection.uid,
      touristUid: selection.touristUid,
      cartIds: selection.cartIds,
      isNew: selection.isNew,
      createdAt: Math.floor(Date.now() / 1000),
    };
    await this.env.CONFIG_KV.put(checkoutKey(adminId, selection.uid, key), JSON.stringify(snapshot), {
      expirationTtl: ASSISTED_CHECKOUT_TTL_SECONDS,
    });
    return key;
  }

  private async snapshot(adminId: number, uid: number, key: string): Promise<AssistedCheckoutSnapshot> {
    if (!/^[a-f0-9]{32}$/.test(key)) throw new ValidateException("订单确认标识无效");
    const value = await this.env.CONFIG_KV.get(checkoutKey(adminId, uid, key));
    if (!value) throw new ValidateException("订单已过期,请刷新当前页面");
    let snapshot: AssistedCheckoutSnapshot;
    try {
      snapshot = JSON.parse(value) as AssistedCheckoutSnapshot;
    } catch {
      throw new ValidateException("订单确认标识已失效");
    }
    if (
      snapshot.version !== 1 || snapshot.adminId !== adminId || snapshot.uid !== uid ||
      !Number.isSafeInteger(snapshot.createdAt) || snapshot.createdAt <= 0
    ) throw new ValidateException("订单确认标识与当前代客会话不匹配");
    snapshot.cartIds = parseAssistedCartIds(snapshot.cartIds);
    snapshot.touristUid = parseAssistedTouristUid(snapshot.touristUid, uid);
    snapshot.isNew = integer(snapshot.isNew, "购物车类型", { min: 0, max: 1 });
    await this.cartService().listAssistedLegacyV2({
      adminId,
      uid,
      touristUid: snapshot.touristUid,
      isNew: snapshot.isNew,
      ids: snapshot.cartIds,
    });
    return snapshot;
  }

  private async address(uid: number, addressId: number) {
    if (uid === 0) return null;
    const address = addressId > 0
      ? await this.container.userAddressDao.get(addressId)
      : await this.container.userAddressDao.getDefault(uid);
    return address && address.uid === uid && address.isDel === 0 ? address : null;
  }

  private async pickupStoreId(shippingType: number, requestedStoreId: number): Promise<number> {
    if (shippingType !== 2) return 0;
    if (requestedStoreId > 0) return requestedStoreId;
    const stores = await this.container.db.select({ id: systemStore.id }).from(systemStore)
      .where(and(
        eq(systemStore.isStore, 1),
        eq(systemStore.isShow, 1),
        eq(systemStore.isDel, 0),
      ))
      .orderBy(asc(systemStore.id))
      .limit(2);
    if (stores.length !== 1) throw new ValidateException("请选择明确的自提门店");
    return stores[0].id;
  }

  private async preview(
    adminId: number,
    selection: AssistedSelection,
    options: Record<string, unknown>,
    key?: string,
  ) {
    const shippingType = integer(options.shipping_type, "配送方式", { min: 1, max: 2, fallback: 1 });
    const addressId = integer(options.addressId, "地址参数", { min: 0, fallback: 0 });
    const requestedStoreId = integer(options.store_id, "自提门店", { min: 0, fallback: 0 });
    const storeId = await this.pickupStoreId(shippingType, requestedStoreId);
    const couponId = integer(options.couponId, "优惠券", { min: 0, fallback: 0 });
    const useIntegral = parseBooleanSwitch(options.useIntegral ?? 0);
    const [cartInfo, account, address, readiness] = await Promise.all([
      this.cartService().listAssistedLegacyV2({
        adminId,
        uid: selection.uid,
        touristUid: selection.touristUid,
        isNew: selection.isNew,
        ids: selection.cartIds,
      }),
      selection.uid > 0 ? this.container.userDao.findForAuth(selection.uid) : Promise.resolve(null),
      this.address(selection.uid, addressId),
      getPaymentReadiness(this.container, this.env),
    ]);
    if (selection.uid > 0 && !account) throw new NotFoundException("用户不存在");
    const quote = await new StoreOrderCreateService(this.container, this.env).quoteOrder({
      uid: selection.uid,
      cartIds: selection.cartIds,
      realName: address?.realName,
      userPhone: address?.phone,
      province: address?.province,
      cityId: address?.cityId,
      userAddress: address
        ? [address.province, address.city, address.district, address.street, address.detail].filter(Boolean).join(" ")
        : undefined,
      shippingType,
      storeId,
      couponId: couponId || undefined,
      useIntegral,
      payType: boundedText(options.payType ?? "weixin", "支付方式", 16),
      type: 0,
      assisted: { adminId, touristUid: selection.touristUid },
    });
    const orderKey = key ?? await this.remember(adminId, selection);
    const quoted = new Map(quote.items.map((item) => [item.cartId, item]));
    for (const row of cartInfo) {
      const item = quoted.get(Number(row.id));
      if (!item) throw new ValidateException("结算商品报价不完整");
      row.truePrice = item.unitPriceCents / 100;
      row.vip_truePrice = item.discountCents / 100;
      row.price_type = item.priceType;
    }
    return {
      result: priceGroup(quote),
      quote,
      response: {
        addressInfo: legacyAddress(address as unknown as Record<string, unknown> | null),
        upgrade_addr: false,
        cartInfo,
        custom_form: [],
        product_type: Math.max(0, ...cartInfo.map((item) => Number(record(item.productInfo).product_type ?? 0))),
        userInfo: account
          ? {
              uid: account.uid,
              phone: account.phone,
              real_name: account.realName,
              now_money: String(account.nowMoney),
              integral: account.integral,
              vip: account.level > 0 || account.isMoneyLevel === 1,
            }
          : { uid: 0, phone: "", now_money: "0.00", integral: 0, vip: false },
        orderKey,
        priceGroup: priceGroup(quote),
        valid_count: cartInfo.length,
        type: 0,
        activityId: 0,
        seckill_id: 0,
        bargain_id: 0,
        combination_id: 0,
        discount_id: 0,
        give_coupon: [],
        give_integral: 0,
        promotions_detail: [],
        integralRatio: 0,
        integral_ratio_status: 0,
        store_self_mention: 1,
        svip_status: account?.isMoneyLevel ?? 0,
        svip_price: money(quote.memberDiscountCents),
        methods: readiness,
        yue_pay_status: 2,
        pay_weixin_open: readiness.weixin.enabled ? 1 : 0,
        ali_pay_status: readiness.alipay.enabled,
      },
    };
  }

  async confirm(adminId: number, uid: number, body: Record<string, unknown>) {
    const selection = await this.selection(adminId, uid, body.cartId, body.tourist_uid, body.new);
    return (await this.preview(adminId, selection, body)).response;
  }

  private async existing(adminId: number, uid: number, key: string) {
    const rows = await this.container.db.select().from(storeOrder).where(and(
      eq(storeOrder.uid, uid),
      eq(storeOrder.unique, key),
      eq(storeOrder.staffId, adminId),
      eq(storeOrder.isChannel, 2),
      eq(storeOrder.isDel, 0),
      eq(storeOrder.isSystemDel, 0),
    )).limit(1);
    return rows[0] ?? null;
  }

  async computed(adminId: number, uid: number, key: string, body: Record<string, unknown>) {
    const existing = await this.existing(adminId, uid, key);
    if (existing) return { extended: true, orderId: existing.orderId, key };
    const snapshot = await this.snapshot(adminId, uid, key);
    const preview = await this.preview(adminId, snapshot, body, key);
    return { extended: false, result: preview.result };
  }

  async coupons(adminId: number, uid: number, query: Record<string, string>) {
    if (uid === 0) return [];
    const selection = await this.selection(
      adminId,
      uid,
      query.cartId,
      query.tourist_uid,
      query.new,
    );
    const preview = await this.preview(adminId, selection, {
      shipping_type: query.shipping_type,
      store_id: query.store_id,
      couponId: 0,
      useIntegral: 0,
    });
    return this.availableCoupons(uid, selection.cartIds, preview.quote);
  }

  private async availableCoupons(uid: number, cartIds: number[], quote: OrderPricingQuote) {
    const now = new Date();
    const [candidateRows, itemRows] = await Promise.all([
      this.container.db
        .select({ coupon: storeCouponUser, issue: storeCouponIssue })
        .from(storeCouponUser)
        .innerJoin(storeCouponIssue, eq(storeCouponIssue.id, storeCouponUser.issueCouponId))
        .where(and(
          eq(storeCouponUser.uid, uid),
          eq(storeCouponUser.status, 0),
          eq(storeCouponUser.isFail, 0),
          eq(storeCouponIssue.status, 1),
          eq(storeCouponIssue.isDel, 0),
        ))
        .orderBy(desc(storeCouponUser.id))
        .limit(100),
      this.container.db
        .select({ cart: storeCart, product: storeProduct })
        .from(storeCart)
        .innerJoin(storeProduct, eq(storeProduct.id, storeCart.productId))
        .where(inArray(storeCart.id, cartIds)),
    ]);
    const candidates = candidateRows.filter(({ coupon }) =>
      (!coupon.startTime || coupon.startTime <= now) && (!coupon.endTime || coupon.endTime >= now)
    );
    if (!candidates.length) return [];
    const issueIds = [...new Set(candidates.filter(({ issue }) => issue.couponType === 2).map(({ issue }) => issue.id))];
    const directCategoryIds = [...new Set(itemRows.flatMap(({ product }) => parseCouponScopeIds(product.cateId)))];
    const directBrandIds = [...new Set(itemRows.map(({ product }) => product.brandId).filter((id) => id > 0))];
    const [productScopes, categories, brands] = await Promise.all([
      issueIds.length
        ? this.container.db.select().from(storeCouponProduct).where(inArray(storeCouponProduct.couponId, issueIds))
        : Promise.resolve([]),
      directCategoryIds.length
        ? this.container.db.select({ id: storeProductCategory.id, pid: storeProductCategory.pid, path: storeProductCategory.path })
          .from(storeProductCategory).where(inArray(storeProductCategory.id, directCategoryIds))
        : Promise.resolve([]),
      directBrandIds.length
        ? this.container.db.select({ id: storeBrand.id, pid: storeBrand.pid, fid: storeBrand.fid })
          .from(storeBrand).where(inArray(storeBrand.id, directBrandIds))
        : Promise.resolve([]),
    ]);
    const productsByIssue = new Map<number, number[]>();
    for (const row of productScopes) {
      const list = productsByIssue.get(row.couponId) ?? [];
      list.push(row.productId);
      productsByIssue.set(row.couponId, list);
    }
    const categoriesById = new Map(categories.map((row) => [row.id, row]));
    const brandsById = new Map(brands.map((row) => [row.id, row]));
    const quoteByCart = new Map(quote.items.map((item) => [item.cartId, item]));
    const applicable = [] as Array<Record<string, unknown> & { discount_cents: number }>;
    for (const { coupon, issue } of candidates) {
      const eligibleSubtotalCents = calculateCouponEligibleSubtotalCents({
        scopeType: issue.couponType,
        productIds: reconcileCouponProductScopeIds(
          [issue.legacyProductIds, issue.productId],
          productsByIssue.get(issue.id) ?? [],
        ),
        categoryIds: parseCouponScopeIds(issue.legacyCategoryId, issue.category_id),
        brandIds: parseCouponScopeIds(issue.legacyBrandId, issue.brandId),
        items: itemRows.map(({ cart, product }) => {
          const categoryIds = parseCouponScopeIds(product.cateId);
          const brand = brandsById.get(product.brandId);
          return {
            productId: product.id,
            parentProductId: product.pid || product.id,
            categoryIds,
            categoryAncestorIds: categoryIds.flatMap((id) => {
              const category = categoriesById.get(id);
              return category ? parseCouponScopeIds(category.pid, category.path) : [];
            }),
            brandId: product.brandId,
            brandAncestorIds: brand ? parseCouponScopeIds(brand.pid, brand.fid) : [],
            subtotalCents: (quoteByCart.get(cart.id)?.unitPriceCents ?? 0) * cart.cartNum,
          };
        }),
      });
      let minimumCents: number;
      try {
        minimumCents = decimalToCents(coupon.useMinPrice);
      } catch {
        continue;
      }
      if (eligibleSubtotalCents <= 0 || eligibleSubtotalCents < minimumCents) continue;
      let discountCents: number;
      try {
        discountCents = calculateCouponDiscountCents({
          discountType: issue.type,
          couponPrice: coupon.couponPrice,
          eligibleSubtotalCents,
        });
      } catch {
        continue;
      }
      applicable.push({
        id: coupon.id,
        cid: coupon.issueCouponId,
        type: coupon.type,
        applicable_type: issue.type,
        receive_type: issue.receiveType,
        start_time: coupon.startTime ? Math.floor(coupon.startTime.getTime() / 1000) : 0,
        add_time: coupon.receiveTime,
        end_time: coupon.endTime ? Math.floor(coupon.endTime.getTime() / 1000) : 0,
        title: coupon.couponTitle || issue.title || issue.couponTitle,
        coupon_title: coupon.couponTitle,
        use_min_price: coupon.useMinPrice,
        coupon_type: issue.couponType,
        coupon_price: coupon.couponPrice,
        true_coupon_price: money(discountCents),
        discount_cents: discountCents,
      });
    }
    return applicable.sort((a, b) => b.discount_cents - a.discount_cents || Number(b.id) - Number(a.id))
      .map(({ discount_cents: _discount, ...coupon }) => coupon);
  }

  async create(
    adminId: number,
    uid: number,
    key: string,
    body: Record<string, unknown>,
    userIp: string,
  ) {
    const existing = await this.existing(adminId, uid, key);
    if (existing) return { order_id: existing.orderId, key, pay_price: existing.payPrice, extended: true };
    const snapshot = await this.snapshot(adminId, uid, key);
    const addressId = integer(body.addressId, "地址参数", { min: 0, fallback: 0 });
    const shippingType = integer(body.shipping_type, "配送方式", { min: 1, max: 2, fallback: 1 });
    const requestedStoreId = integer(body.store_id, "自提门店", { min: 0, fallback: 0 });
    const storeId = await this.pickupStoreId(shippingType, requestedStoreId);
    const address = await this.address(uid, addressId);
    const realName = boundedText(body.real_name ?? address?.realName, "收货人", 32);
    const phone = boundedText(body.phone ?? address?.phone, "手机号", 18);
    const customAddress = boundedText(body.address, "收货地址", 100);
    const userAddress = customAddress || (address
      ? [address.province, address.city, address.district, address.street, address.detail].filter(Boolean).join(" ")
      : "");
    if (!realName || !phone) throw new ValidateException("请填写姓名和电话");
    if (shippingType === 1 && !userAddress) throw new ValidateException("请选择或填写收货地址");
    const result = await new StoreOrderCreateService(this.container, this.env).createOrder({
      uid,
      key,
      cartIds: snapshot.cartIds,
      realName,
      userPhone: phone,
      province: address?.province ?? "",
      cityId: address?.cityId,
      userAddress,
      mark: boundedText(body.mark, "订单备注", 512),
      shippingType,
      storeId,
      useIntegral: parseBooleanSwitch(body.useIntegral ?? 0),
      payType: normalizePayType(body.payType),
      from: boundedText(body.from ?? "pc", "下单渠道", 32),
      userIp,
      type: 0,
      couponId: integer(body.couponId, "优惠券", { min: 0, fallback: 0 }) || undefined,
      assisted: { adminId, touristUid: snapshot.touristUid },
    });
    const order = await this.existing(adminId, uid, result.key);
    if (!order || order.orderId !== result.orderId) throw new Error("代客订单创建结果无法核验");
    return { order_id: order.orderId, key: result.key, pay_price: order.payPrice, extended: false };
  }

  private async assistedOrder(adminId: number, uid: number, orderValue: unknown) {
    const orderId = normalizeOrderId(orderValue);
    const rows = await this.container.db.select().from(storeOrder).where(and(
      eq(storeOrder.orderId, orderId),
      eq(storeOrder.uid, uid),
      eq(storeOrder.staffId, adminId),
      eq(storeOrder.isChannel, 2),
      eq(storeOrder.isDel, 0),
      eq(storeOrder.isSystemDel, 0),
    )).limit(1);
    if (!rows[0]) throw new NotFoundException("订单不存在");
    return rows[0];
  }

  private authorizePayment(adminId: number, uid: number) {
    return async (_tx: DbClient, order: typeof storeOrder.$inferSelect) => {
      if (
        order.uid !== uid || order.staffId !== adminId || order.isChannel !== 2 ||
        order.isDel !== 0 || order.isSystemDel !== 0
      ) throw new ValidateException("订单不属于当前代客会话");
    };
  }

  async pay(adminId: number, uid: number, body: Record<string, unknown>, userIp: string) {
    const order = await this.assistedOrder(adminId, uid, body.uni);
    const payType = normalizePayType(body.paytype);
    if (order.paid === 1) return { status: "SUCCESS", result: { order_id: order.orderId } };
    if (order.status !== 0) throw new ValidateException("订单状态不允许支付");
    const service = new StoreOrderPayService(this.container, this.env);
    if (payType === "cash" || decimalToCents(order.payPrice) === 0) {
      const result = await service.applyPayment({
        orderId: order.id,
        payType,
        authorizeBeforePayment: this.authorizePayment(adminId, uid),
        allowAlreadyPaid: (locked) =>
          locked.uid === uid && locked.staffId === adminId && locked.isChannel === 2,
        audit: {
          changeType: "admin_assisted_pay",
          changeMessage: `管理员 ${adminId} 确认代客订单 ${order.orderId} 收款`,
        },
      });
      if (result.outcome === "missing") throw new NotFoundException("订单不存在");
      if (result.outcome === "not-payable") throw new ValidateException("订单状态不允许支付");
      return { status: "SUCCESS", result: { order_id: order.orderId } };
    }
    const provider = await service.pay(uid, order.orderId, payType, "pc", userIp);
    const invalid = Math.floor(Date.now() / 1000) + 60;
    if (payType === "weixin") {
      const jsConfig = { ...record(provider.jsConfig), invalid };
      return {
        status: "WECHAT_PC_PAY",
        result: { jsConfig, order_id: order.orderId, pay_price: order.payPrice },
      };
    }
    return {
      status: "ALIPAY_PAY",
      result: {
        jsConfig: { qrCode: String(provider.payUrl ?? ""), invalid },
        order_id: order.orderId,
        pay_key: crypto.randomUUID().replaceAll("-", ""),
        pay_price: order.payPrice,
      },
    };
  }

  async payStatus(adminId: number, query: Record<string, string>) {
    const orderId = normalizeOrderId(query.order_id);
    const rows = await this.container.db.select({ paid: storeOrder.paid }).from(storeOrder).where(and(
      eq(storeOrder.orderId, orderId),
      eq(storeOrder.staffId, adminId),
      eq(storeOrder.isChannel, 2),
      eq(storeOrder.isDel, 0),
      eq(storeOrder.isSystemDel, 0),
    )).limit(1);
    if (!rows[0]) throw new NotFoundException("订单不存在");
    const endTime = integer(query.end_time, "支付截止时间", { min: 0, fallback: 0 });
    return {
      status: rows[0].paid === 1,
      time: endTime > 0 ? Math.max(0, endTime - Math.floor(Date.now() / 1000)) : 0,
    };
  }

  async placeList(adminId: number, query: Record<string, string>) {
    const page = integer(query.page, "页码", { min: 1, max: 100_000, fallback: 1 });
    const limit = integer(query.limit, "每页数量", { min: 1, max: MAX_LIST_LIMIT, fallback: 10 });
    const keyword = boundedText(query.keyword ?? query.field_value, "搜索条件", 100);
    const status = query.status === undefined || query.status === ""
      ? null
      : integer(query.status, "订单状态", { min: -4, max: 9 });
    if (status !== null && !ASSISTED_ORDER_STATUSES.has(status)) {
      throw new ValidateException("订单状态无效");
    }
    const conditions: SQL[] = [
      eq(storeOrder.staffId, adminId),
      eq(storeOrder.isChannel, 2),
      eq(storeOrder.isSystemDel, 0),
    ];
    if (status === null || ![-3, -2, -1].includes(status)) conditions.push(eq(storeOrder.pid, 0));
    if (query.is_del !== undefined && query.is_del !== "") {
      conditions.push(eq(storeOrder.isDel, integer(query.is_del, "删除状态", { min: 0, max: 1 })));
    } else if (status !== -4) {
      conditions.push(eq(storeOrder.isDel, 0));
    }
    if (status !== null) appendOrderStatusConditions(conditions, status);
    if (query.pay_type) conditions.push(eq(storeOrder.payType, assistedListPayType(query.pay_type)));
    if (query.type !== undefined && query.type !== "") {
      appendOrderTypeConditions(conditions, integer(query.type, "订单类型", { min: 0, max: 107 }));
    }
    if (keyword) {
      const pattern = `%${keyword}%`;
      conditions.push(or(
        ilike(storeOrder.orderId, pattern),
        ilike(storeOrder.realName, pattern),
        ilike(storeOrder.userPhone, pattern),
      )!);
    }
    const orders = await this.container.db.select().from(storeOrder)
      .where(and(...conditions))
      .orderBy(desc(storeOrder.addTime), desc(storeOrder.id))
      .limit(limit)
      .offset((page - 1) * limit);
    if (!orders.length) return [];
    const orderIds = orders.map((order) => order.id);
    const [cartRows, refundRows] = await Promise.all([
      this.container.db.select().from(storeOrderCartInfo)
        .where(inArray(storeOrderCartInfo.oid, orderIds)).orderBy(asc(storeOrderCartInfo.id)),
      this.container.db.select().from(storeOrderRefund)
        .where(and(inArray(storeOrderRefund.storeOrderId, orderIds), eq(storeOrderRefund.isDel, 0)))
        .orderBy(asc(storeOrderRefund.id)),
    ]);
    const cartsByOrder = new Map<number, ReturnType<typeof legacyCartSnapshot>[]>();
    const refundableCartNumByOrder = new Map<number, number>();
    for (const cart of cartRows) {
      const list = cartsByOrder.get(cart.oid) ?? [];
      list.push(legacyCartSnapshot(cart));
      cartsByOrder.set(cart.oid, list);
      if (cart.isGift !== 1) {
        refundableCartNumByOrder.set(
          cart.oid,
          (refundableCartNumByOrder.get(cart.oid) ?? 0) + cart.cartNum,
        );
      }
    }
    const refundsByOrder = new Map<number, Array<typeof storeOrderRefund.$inferSelect>>();
    for (const refund of refundRows) {
      const list = refundsByOrder.get(refund.storeOrderId) ?? [];
      list.push(refund);
      refundsByOrder.set(refund.storeOrderId, list);
    }
    return orders.map((order) => {
      const refunds = refundsByOrder.get(order.id) ?? [];
      const refundableCartNum = refundableCartNumByOrder.get(order.id) ?? 0;
      const refundedNum = refunds.reduce((total, refund) => total + refund.refundNum, 0);
      return {
        ...order,
        order_id: order.orderId,
        total_num: order.totalNum,
        pay_price: order.payPrice,
        add_time: order.addTime,
        pay_type: order.payType,
        refund_status: order.refundStatus,
        _status: { _title: statusTitle(order), _type: order.status },
        cartInfo: cartsByOrder.get(order.id) ?? [],
        refund: refunds,
        is_all_refund: refunds.length > 0 && refundedNum === refundableCartNum,
      };
    });
  }
}
