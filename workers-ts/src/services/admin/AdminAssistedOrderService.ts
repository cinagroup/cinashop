import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import type { Env } from "@/env";
import { createContainerFromDb, withTx, type Container, type DbClient } from "@/lib/di";
import {
  storeBrand,
  storeCart,
  storeCouponIssue,
  storeCouponProduct,
  storeCouponUser,
  storeOrder,
  storeOrderCartInfo,
  storeProduct,
  storeProductCategory,
  systemStore,
  systemAttachment,
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
import { getPaymentReadiness, getPaymentReadinessSnapshot } from "@/services/payment/PaymentReadinessService";
import { claimAssistedProviderPayment, hasInitiatedAssistedProviderPayment } from "@/services/payment/AssistedProviderPaymentClaim";
import { ApiException, NotFoundException, ValidateException } from "@/utils/errors";
import { assistedDeliveryAddress, checkoutAddressId } from '@/services/order/OrderDeliveryAddress';
import { issueCheckoutConfirmation, OrderQuoteReconfirmRequired } from '@/services/order/CheckoutConfirmation';
import { loadActiveOrderSystemForm, OrderFormRejectedException, readOrderSystemFormForOrder } from '@/services/order/OrderSystemFormService';
import { loadFirstOrderDiscountConfig, type FirstOrderDiscountConfig } from '@/services/activity/StoreNewcomerService';
import { AttachmentService, canonicalAttachmentPath, R2_IMAGE_TYPE } from '@/services/system/AttachmentService';
import { assistedFormAttachmentScope, belongsToAssistedFormScope } from '@/services/system/AssistedFormAttachmentScope';

const ASSISTED_CHECKOUT_TTL_SECONDS = 30 * 60;
const MAX_CART_ITEMS = 200;
const MAX_LIST_LIMIT = 100;
const MAX_LEGACY_LIST_OFFSET = 10_000;

/** An untrusted position, not an authorization token; every page repeats actor filters. */
function assistedListCursor(value: unknown): { addTime: number; id: number } | null {
  if (value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > 32 || !/^(?:0|-[1-9]\d{0,9}|[1-9]\d{0,9}):[1-9]\d{0,9}$/.test(value)) {
    throw new ValidateException("订单游标无效");
  }
  const [addTime, id] = value.split(":").map(Number);
  if (!Number.isSafeInteger(addTime) || addTime < -2_147_483_648 || addTime > 2_147_483_647
    || !Number.isSafeInteger(id) || id > 2_147_483_647) throw new ValidateException("订单游标无效");
  return { addTime, id };
}

/** Raised only around the core create call, never its post-commit readback. */
export class AssistedOrderCreateRejected extends ApiException {
  constructor(message: string, key: string, errorCode: 'ORDER_FORM_REJECTED' | 'ORDER_QUOTE_RECONFIRM_REQUIRED') {
    super(message, 400, { errorCode, orderKey: key });
  }
}

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

export function parseExpectedAssistedPayPriceCents(value: unknown): number {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,9})\.\d{2}$/.test(value)) {
    throw new ValidateException("请刷新订单并提交预期应付金额");
  }
  return decimalToCents(value);
}

function exactOrderId(value: unknown): string {
  const orderId = boundedText(value, "订单号", 32);
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(orderId)) throw new ValidateException("订单号无效");
  return orderId;
}

function pollingOrderIds(value: unknown): { exactId: string | null; aliasId: string | null } {
  const input = boundedText(value, "订单号", 36);
  const exactId = /^[A-Za-z0-9_-]{1,32}$/.test(input) ? input : null;
  // The legacy payment provider prefixes three digits and an underscore to
  // the original (up to 32-byte) store_order.order_id for status polling.
  const prefixed = /^\d{3}_([A-Za-z0-9_-]{1,32})$/.exec(input);
  if (!exactId && !prefixed) throw new ValidateException("订单号无效");
  return { exactId, aliasId: prefixed?.[1] ?? null };
}

function statusTitle(order: Pick<typeof storeOrder.$inferSelect,
  "isDel" | "isSystemDel" | "paid" | "refundStatus" | "status" | "shippingType">): string {
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
    const stores = await this.container.db.select({ id: systemStore.id }).from(systemStore)
      .where(and(
        requestedStoreId > 0 ? eq(systemStore.id, requestedStoreId) : undefined,
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
    // Remote config/payment reads precede the SQL transaction; immutable receipts
    // are issued only after it has committed. No KV/Sequence/provider I/O under RR.
    // First-order config retains its existing KV authority, unlike SQL pricing.
    const [readiness, firstOrderConfig] = await Promise.all([
      getPaymentReadiness(this.container, this.env),
      selection.uid > 0 ? loadFirstOrderDiscountConfig(this.container, this.env) : undefined,
    ]);
    const preview = await withTx(this.container, async db => {
      await db.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await db.execute(sql`SELECT set_config('statement_timeout',
        LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
        set_config('idle_in_transaction_session_timeout',
        LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true)`);
      return new AdminAssistedOrderService(createContainerFromDb(db), this.env)
        .readPreview(adminId, selection, options, firstOrderConfig);
    });
    const orderKey = key ?? await this.remember(adminId, selection);
    const quoteToken = await issueCheckoutConfirmation(this.env.CONFIG_KV,
      { uid: selection.uid, key: orderKey, adminId, touristUid: selection.touristUid }, preview.quote.confirmationFingerprint);
    const response = { ...preview.response, orderKey, quoteToken, methods: readiness,
      pay_weixin_open: readiness.weixin.enabled ? 1 : 0, ali_pay_status: readiness.alipay.enabled };
    // Preserve computed's legacy flat amounts while returning the complete fresh
    // confirmation projection. Clients must replace, not merge, quote state.
    return { quote: preview.quote, response, result: { ...response, ...response.priceGroup } };
  }

  private async readPreview(
    adminId: number,
    selection: AssistedSelection,
    options: Record<string, unknown>,
    firstOrderConfig: FirstOrderDiscountConfig | undefined,
  ) {
    const shippingType = integer(options.shipping_type, "配送方式", { min: 1, max: 2, fallback: 1 });
    const addressId = checkoutAddressId(options.addressId, options.address_id);
    const manualAddress = assistedDeliveryAddress(options);
    const requestedStoreId = integer(options.store_id, "自提门店", { min: 0, fallback: 0 });
    const storeId = await this.pickupStoreId(shippingType, requestedStoreId);
    const couponId = integer(options.couponId, "优惠券", { min: 0, fallback: 0 });
    const useIntegral = parseBooleanSwitch(options.useIntegral ?? 0);
    const [cartInfo, account, address] = await Promise.all([
      this.cartService().listAssistedLegacyV2({
        adminId,
        uid: selection.uid,
        touristUid: selection.touristUid,
        isNew: selection.isNew,
        ids: selection.cartIds,
      }),
      selection.uid > 0 ? this.container.userDao.findForAuth(selection.uid) : Promise.resolve(null),
      manualAddress ? Promise.resolve(null) : this.address(selection.uid, addressId),
    ]);
    if (selection.uid > 0 && !account) throw new NotFoundException("用户不存在");
    const quote = await new StoreOrderCreateService(this.container, this.env).quoteOrder({
      uid: selection.uid,
      cartIds: selection.cartIds,
      addressId: address?.id ?? addressId,
      manualAddress,
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
      payType: normalizePayType(options.payType),
      type: 0,
      assisted: { adminId, touristUid: selection.touristUid },
    }, undefined, firstOrderConfig);
    const quoted = new Map(quote.items.map((item) => [item.cartId, item]));
    for (const row of cartInfo) {
      const item = quoted.get(Number(row.id));
      if (!item) throw new ValidateException("结算商品报价不完整");
      row.truePrice = item.unitPriceCents / 100;
      row.vip_truePrice = item.discountCents / 100;
      row.price_type = item.priceType;
    }
    const systemForm = quote.systemFormId > 0 ? await loadActiveOrderSystemForm(this.container.db, quote.systemFormId) : null;
    return {
      quote,
      response: {
        addressInfo: quote.deliveryAddress ? legacyAddress(quote.deliveryAddress)
          : quote.deliveryAddressFields ? { ...quote.deliveryAddressFields, id: 0, uid: selection.uid,
              real_name: quote.deliveryAddressFields.realName, city_id: quote.deliveryAddressFields.cityId }
          : null,
        checkout: { version: 1, adminId, uid: selection.uid, touristUid: selection.touristUid,
          cartIds: selection.cartIds, isNew: selection.isNew, shippingType, storeId,
          addressSource: quote.deliveryAddress ? 'saved' : quote.deliveryAddressFields ? 'manual' : 'none',
          addressRequired: shippingType === 1 && cartInfo.some(item => ![1, 2, 3].includes(Number(record(item.productInfo).product_type))),
          useIntegral, couponId, payType: normalizePayType(options.payType), systemFormId: quote.systemFormId },
        upgrade_addr: false,
        cartInfo,
        systemForm: systemForm ? { version: 1, ...systemForm } : null,
        custom_form: systemForm?.value ?? [],
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
        integralRatio: quote.integralPolicy.ratio,
        integral_ratio_status: quote.integralPolicy.enabled ? 1 : 0,
        store_self_mention: 1,
        svip_status: account?.isMoneyLevel ?? 0,
        svip_price: money(quote.memberDiscountCents),
        yue_pay_status: 2,
      },
    };
  }

  async confirm(adminId: number, uid: number, body: Record<string, unknown>) {
    const selection = await this.selection(adminId, uid, body.cartId, body.tourist_uid, body.new);
    return (await this.preview(adminId, selection, body)).response;
  }

  /** Authorize before buffering the multipart body, then recheck and pin the
   * SQL source inside the metadata transaction after R2 finishes. No KV/R2 I/O
   * occurs while holding SQL locks. No client form ID or guest identity is used. */
  async prepareFormImageUpload(adminId: number, uid: number, key: string) {
    const snapshot = await this.snapshot(adminId, uid, key);
    const scope = await withTx(this.container, async db => {
      await db.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      return this.formImageScope(db, snapshot, key, false);
    });
    return (file: File) => new AttachmentService(this.container, this.env).uploadAssistedFormImage(scope, file, async db => {
      const current = await this.formImageScope(db, snapshot, key, true);
      if (current.digest !== scope.digest) throw new ValidateException('结算表单已变更，请重新上传');
    });
  }

  async previewFormImages(adminId: number, uid: number, key: string, value: unknown) {
    if (!Array.isArray(value) || !value.length || value.length > 900
      || value.some(id => !Number.isSafeInteger(id) || id <= 0 || id > 2_147_483_647)
      || new Set(value).size !== value.length) throw new ValidateException('表单图片列表无效');
    const snapshot = await this.snapshot(adminId, uid, key);
    return withTx(this.container, async db => {
      await db.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      const scope = await this.formImageScope(db, snapshot, key, false);
      const rows = await db.select({ id: systemAttachment.attId, name: systemAttachment.name }).from(systemAttachment)
        .where(and(inArray(systemAttachment.attId, value), eq(systemAttachment.type, scope.type),
          eq(systemAttachment.relationId, scope.relationId), eq(systemAttachment.moduleType, scope.moduleType),
          eq(systemAttachment.fileType, 1), eq(systemAttachment.imageType, R2_IMAGE_TYPE)));
      if (rows.length !== value.length || rows.some(row => !belongsToAssistedFormScope(row.name, scope))) {
        throw new ValidateException('自定义表单包含无权使用的图片');
      }
      const paths = value.map(id => canonicalAttachmentPath(id));
      const signed = await new AttachmentService(this.container, this.env).signReferences(paths);
      return value.map((id, index) => ({ att_id: id, reference: paths[index], url: signed[index] }));
    });
  }

  private async formImageScope(db: DbClient, snapshot: AssistedCheckoutSnapshot, key: string, pin: boolean) {
    await db.execute(sql`SELECT set_config('statement_timeout',
      LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
      set_config('idle_in_transaction_session_timeout',
      LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true)`);
    const { adminId, uid, touristUid, cartIds, isNew, createdAt } = snapshot;
    const now = Math.floor(Date.now() / 1000);
    if (createdAt > now || now - createdAt >= ASSISTED_CHECKOUT_TTL_SECONDS) throw new ValidateException('订单已过期,请刷新当前页面');
    const [used] = await db.select({ id: storeOrder.id }).from(storeOrder)
      .where(and(eq(storeOrder.uid, uid), eq(storeOrder.unique, key))).limit(1);
    if (used) throw new ValidateException('订单已经创建，不能继续上传表单图片');
    const query = db.select().from(storeCart).where(inArray(storeCart.id, cartIds)).orderBy(asc(storeCart.id));
    const carts = await (pin ? query.for('share', { noWait: true }) : query);
    if (carts.length !== cartIds.length || carts.some(cart => cart.uid !== uid || cart.staffId !== adminId
      || cart.touristUid !== touristUid || cart.isNew !== isNew || cart.type !== 0 || cart.activityId !== 0
      || cart.storeId !== 0 || cart.isDel !== 0 || cart.isPay !== 0 || cart.status !== 1 || cart.cartNum <= 0)) {
      throw new ValidateException('购物车商品已失效或不属于当前代客会话');
    }
    const productIds = [...new Set(carts.map(cart => cart.productId))];
    const productsQuery = db.select({ id: storeProduct.id, formId: storeProduct.systemFormId, isShow: storeProduct.isShow,
      isDel: storeProduct.isDel, isVerify: storeProduct.isVerify, isPresale: storeProduct.isPresaleProduct })
      .from(storeProduct).where(inArray(storeProduct.id, productIds)).orderBy(asc(storeProduct.id));
    const products = await (pin ? productsQuery.for('share', { noWait: true }) : productsQuery);
    if (products.length !== productIds.length || products.some(product => product.isDel !== 0 || product.isShow !== 1
      || product.isVerify !== 1 || product.isPresale !== 0)) throw new ValidateException('结算商品已失效');
    const formIds = [...new Set(products.map(product => product.formId).filter(id => id > 0))];
    if (formIds.length !== 1) throw new ValidateException('结算商品没有唯一可用表单');
    const definition = await loadActiveOrderSystemForm(db, formIds[0], pin);
    if (!definition.value.some(component => component.name === 'uploadPicture')) throw new ValidateException('当前表单不需要上传图片');
    return assistedFormAttachmentScope({ adminId, uid, touristUid, key, systemFormId: definition.id });
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
    const addressId = checkoutAddressId(body.addressId, body.address_id);
    const manualAddress = assistedDeliveryAddress(body);
    const shippingType = integer(body.shipping_type, "配送方式", { min: 1, max: 2, fallback: 1 });
    const requestedStoreId = integer(body.store_id, "自提门店", { min: 0, fallback: 0 });
    const storeId = await this.pickupStoreId(shippingType, requestedStoreId);
    const address = manualAddress ? null : await this.address(uid, addressId);
    const realName = boundedText(body.real_name ?? address?.realName, "收货人", 32);
    const phone = boundedText(body.phone ?? address?.phone, "手机号", 18);
    if (shippingType === 2 && (!realName || !phone)) throw new ValidateException("请填写姓名和电话");
    let result: { orderId: string; key: string };
    try {
      if (body.customForm !== undefined && body.custom_form !== undefined) throw new OrderFormRejectedException("自定义表单参数重复");
      result = await new StoreOrderCreateService(this.container, this.env).createOrder({
        uid,
        key,
        cartIds: snapshot.cartIds,
        quoteToken: body.quoteToken,
        addressId: address?.id ?? addressId,
        manualAddress,
        realName,
        userPhone: phone,
        province: address?.province ?? "",
        cityId: address?.cityId,
        mark: boundedText(body.mark, "订单备注", 512),
        customForm: body.customForm ?? body.custom_form,
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
    } catch (error) {
      if (error instanceof OrderFormRejectedException) throw new AssistedOrderCreateRejected(error.message, key, 'ORDER_FORM_REJECTED');
      if (error instanceof OrderQuoteReconfirmRequired) throw new AssistedOrderCreateRejected(error.message, key, 'ORDER_QUOTE_RECONFIRM_REQUIRED');
      throw error;
    }
    const order = await this.existing(adminId, uid, result.key);
    if (!order || order.orderId !== result.orderId) throw new Error("代客订单创建结果无法核验");
    return { order_id: order.orderId, key: result.key, pay_price: order.payPrice, extended: false };
  }

  async orderForm(adminId: number, uid: number, orderValue: unknown) {
    return withTx(this.container, async db => {
      await db.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await db.execute(sql`SELECT set_config('statement_timeout',
        LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true)`);
      const [order] = await db.select({ id: storeOrder.id, uid: storeOrder.uid, staffId: storeOrder.staffId,
        isChannel: storeOrder.isChannel, unique: storeOrder.unique, pid: storeOrder.pid,
        customForm: sql<string | null>`CASE WHEN octet_length(${storeOrder.customForm}) <= 1000000 THEN ${storeOrder.customForm} ELSE NULL END`,
      }).from(storeOrder).where(and(eq(storeOrder.orderId, exactOrderId(orderValue)),
        eq(storeOrder.uid, uid), eq(storeOrder.staffId, adminId), eq(storeOrder.isChannel, 2),
        eq(storeOrder.isDel, 0), eq(storeOrder.isSystemDel, 0))).limit(1);
      if (!order) throw new NotFoundException('订单不存在');
      return readOrderSystemFormForOrder(db, new AttachmentService(this.container, this.env), order);
    });
  }

  private async assistedOrder(adminId: number, uid: number, orderValue: unknown) {
    const orderId = exactOrderId(orderValue);
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

  private authorizePayment(adminId: number, uid: number, expectedPayCents: number) {
    return async (tx: DbClient, order: typeof storeOrder.$inferSelect) => {
      if (
        order.uid !== uid || order.staffId !== adminId || order.isChannel !== 2 ||
        order.isDel !== 0 || order.isSystemDel !== 0
      ) throw new ValidateException("订单不属于当前代客会话");
      if (decimalToCents(order.payPrice) !== expectedPayCents) {
        throw new ValidateException("订单应付金额已变化，请刷新后重新确认支付");
      }
      if (order.paid === 0 && await hasInitiatedAssistedProviderPayment(tx, order.orderId)) {
        throw new ValidateException("扫码支付已发起，请查询支付状态；结果未知时请先人工对账");
      }
    };
  }

  async pay(adminId: number, uid: number, body: Record<string, unknown>, userIp: string) {
    const order = await this.assistedOrder(adminId, uid, body.uni);
    const payType = normalizePayType(body.paytype);
    const expectedPayCents = parseExpectedAssistedPayPriceCents(body.expected_pay_price);
    if (decimalToCents(order.payPrice) !== expectedPayCents) {
      throw new ValidateException("订单应付金额已变化，请刷新后重新确认支付");
    }
    const service = new StoreOrderPayService(this.container, this.env);
    if (payType === "cash" || decimalToCents(order.payPrice) === 0) {
      const result = await service.applyPayment({
        orderId: order.id,
        payType,
        authorizeBeforePayment: this.authorizePayment(adminId, uid, expectedPayCents),
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
    if (order.paid === 1) return { status: "SUCCESS", result: { order_id: order.orderId } };
    if (order.status !== 0) throw new ValidateException("订单状态不允许支付");
    const readiness = await getPaymentReadinessSnapshot(this.container, this.env);
    const method = readiness.methods[payType];
    if (!method.enabled) throw new ValidateException(method.reason || "支付方式不可用");
    if (payType === "weixin" && !readiness.wechatProfiles.wechat.enabled) {
      throw new ValidateException(readiness.wechatProfiles.wechat.reason || "当前微信支付渠道不可用");
    }
    const provider = await service.pay(uid, order.orderId, payType, "pc", userIp,
      () => claimAssistedProviderPayment(this.container, {
        adminId, uid, orderId: order.id, orderNo: order.orderId,
        provider: payType === "weixin" ? "wechat" : "alipay",
        profile: payType === "weixin" ? "wechat" : "alipay", expectedPayCents,
      }));
    if (provider.paid === true) return { status: "SUCCESS", result: { order_id: order.orderId } };
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
    const { exactId, aliasId } = pollingOrderIds(query.order_id);
    const candidates = [exactId, aliasId].filter((id): id is string => id !== null);
    // The exact ID wins even when it is deleted or belongs to another actor.
    // One statement sees both candidates in one snapshot, so a concurrent
    // ownership change cannot turn an exact hit into a different alias order.
    const rows = await this.container.db.select({
      orderId: storeOrder.orderId,
      paid: storeOrder.paid,
      staffId: storeOrder.staffId,
      isChannel: storeOrder.isChannel,
      isDel: storeOrder.isDel,
      isSystemDel: storeOrder.isSystemDel,
    }).from(storeOrder)
      .where(inArray(storeOrder.orderId, candidates))
      .limit(3);
    if (rows.length > 2 || new Set(rows.map(row => row.orderId)).size !== rows.length) {
      throw new NotFoundException("订单不存在");
    }
    const order = (exactId ? rows.find(row => row.orderId === exactId) : undefined)
      ?? (aliasId ? rows.find(row => row.orderId === aliasId) : undefined);
    if (!order || order.staffId !== adminId || order.isChannel !== 2 || order.isDel !== 0 || order.isSystemDel !== 0) {
      throw new NotFoundException("订单不存在");
    }
    const endTime = integer(query.end_time, "支付截止时间", { min: 0, fallback: 0 });
    return {
      order_id: order.orderId,
      status: order.paid === 1,
      time: endTime > 0 ? Math.max(0, endTime - Math.floor(Date.now() / 1000)) : 0,
    };
  }

  async placeList(adminId: number, query: Record<string, string>) {
    if (query.paging !== undefined && query.paging !== "" && query.paging !== "cursor") {
      throw new ValidateException("分页方式无效");
    }
    const cursorMode = query.paging === "cursor";
    if (cursorMode && query.page !== undefined && query.page !== "") throw new ValidateException("分页参数冲突");
    if (!cursorMode && query.cursor !== undefined) throw new ValidateException("分页参数冲突");
    const page = cursorMode ? 1 : integer(query.page, "页码", { min: 1, max: 100_000, fallback: 1 });
    const limit = integer(query.limit, "每页数量", { min: 1, max: MAX_LIST_LIMIT, fallback: 10 });
    if (!cursorMode && (page - 1) * limit > MAX_LEGACY_LIST_OFFSET) {
      throw new ValidateException("页码过深，请改用游标分页");
    }
    const cursor = cursorMode ? assistedListCursor(query.cursor) : null;
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
    if (status === null || ![-3, -2, -1].includes(status)) conditions.push(inArray(storeOrder.pid, [0, -1]));
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
    // A row comparison is one index range condition on the complete sort key.
    // The equivalent OR predicate scans every earlier row in deep pages on PG16.
    if (cursor) conditions.push(sql<boolean>`(${storeOrder.addTime}, ${storeOrder.id}) < (${cursor.addTime}, ${cursor.id})`);
    const orders = await withTx(this.container, async db => {
      await db.execute(sql`SET TRANSACTION READ ONLY`);
      await db.execute(sql`SELECT set_config('statement_timeout',
        LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
        set_config('idle_in_transaction_session_timeout',
        LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true)`);
      const selection = db.select({
        id: storeOrder.id,
        orderId: storeOrder.orderId,
        uid: storeOrder.uid,
        paid: storeOrder.paid,
        payPrice: storeOrder.payPrice,
        totalNum: storeOrder.totalNum,
        addTime: storeOrder.addTime,
        pid: storeOrder.pid,
        status: storeOrder.status,
        refundStatus: storeOrder.refundStatus,
        shippingType: storeOrder.shippingType,
        isDel: storeOrder.isDel,
        isSystemDel: storeOrder.isSystemDel,
      }).from(storeOrder)
        .where(and(...conditions))
        .orderBy(desc(storeOrder.addTime), desc(storeOrder.id))
        .limit(limit + (cursorMode ? 1 : 0));
      return cursorMode ? selection : selection.offset((page - 1) * limit);
    });
    const visible = cursorMode ? orders.slice(0, limit) : orders;
    const list = visible.map((order) => ({
      id: order.id,
      order_id: order.orderId,
      uid: order.uid,
      paid: order.paid,
      pay_price: order.payPrice,
      total_num: order.totalNum,
      add_time: order.addTime,
      pid: order.pid,
      _status: { _title: order.pid === -1 && ![1, 2, 4].includes(order.refundStatus) ? "已拆分" : statusTitle(order) },
    }));
    if (!cursorMode) return list;
    const hasMore = orders.length > limit;
    const last = visible.at(-1);
    return { list, next_cursor: hasMore && last ? `${last.addTime}:${last.id}` : null, has_more: hasMore };
  }

  /** Minimal actor-scoped mobile detail; never expose the broad admin order projection. */
  async placeDetail(adminId: number, orderValue: unknown) {
    const orderId = exactOrderId(orderValue);
    return withTx(this.container, async db => {
      await db.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await db.execute(sql`SELECT set_config('statement_timeout',
        LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true)`);
      const [order] = await db.select({
        id: storeOrder.id,
        orderId: storeOrder.orderId,
        uid: storeOrder.uid,
        pid: storeOrder.pid,
        paid: storeOrder.paid,
        payPrice: storeOrder.payPrice,
        totalNum: storeOrder.totalNum,
        addTime: storeOrder.addTime,
        payType: storeOrder.payType,
        shippingType: storeOrder.shippingType,
        status: storeOrder.status,
        refundStatus: storeOrder.refundStatus,
        isDel: storeOrder.isDel,
        isSystemDel: storeOrder.isSystemDel,
      }).from(storeOrder).where(and(
        eq(storeOrder.orderId, orderId),
        eq(storeOrder.staffId, adminId),
        eq(storeOrder.isChannel, 2),
        inArray(storeOrder.pid, [0, -1]),
        eq(storeOrder.isDel, 0),
        eq(storeOrder.isSystemDel, 0),
      )).limit(1);
      if (!order) throw new NotFoundException("订单不存在");

      const rows = await db.select({
        id: storeOrderCartInfo.id,
        productId: storeOrderCartInfo.productId,
        cartNum: storeOrderCartInfo.cartNum,
        cartInfo: sql<string | null>`CASE WHEN octet_length(${storeOrderCartInfo.cartInfo}) <= 65536
          THEN ${storeOrderCartInfo.cartInfo} ELSE NULL END`,
      }).from(storeOrderCartInfo)
        .where(eq(storeOrderCartInfo.oid, order.id))
        .orderBy(asc(storeOrderCartInfo.id))
        .limit(MAX_CART_ITEMS + 1);
      if (rows.length > MAX_CART_ITEMS) throw new ValidateException("订单商品超过展示上限");
      const items = rows.map((row) => {
        const snapshot = parseJson(row.cartInfo);
        const product = record(snapshot.productInfo ?? snapshot.product);
        const sku = record(snapshot.sku ?? record(product.attrInfo));
        const storeName = product.store_name ?? product.storeName;
        const unitPrice = typeof sku.price === "string" || typeof sku.price === "number"
          ? Number(sku.price) : NaN;
        const totalPrice = typeof snapshot.sum_true_price === "string" || typeof snapshot.sum_true_price === "number"
          ? Number(snapshot.sum_true_price) : NaN;
        const candidate = Number.isFinite(unitPrice) && unitPrice >= 0
          ? unitPrice
          : Number.isFinite(totalPrice) && totalPrice >= 0 && row.cartNum > 0
            ? totalPrice / row.cartNum
          : 0;
        const price = candidate <= 9_999_999_999.99 ? candidate : 0;
        return {
          id: row.id,
          product_id: row.productId,
          store_name: typeof storeName === "string" ? storeName.slice(0, 255) : "",
          suk: typeof sku.suk === "string" ? sku.suk.slice(0, 255) : "",
          cart_num: row.cartNum,
          price: price.toFixed(2),
        };
      });
      return {
        order_id: order.orderId,
        uid: order.uid,
        paid: order.paid,
        pay_price: order.payPrice,
        total_num: order.totalNum,
        add_time: order.addTime,
        pay_type: order.payType,
        shipping_type: order.shippingType,
        _status: { _title: order.pid === -1 && ![1, 2, 4].includes(order.refundStatus) ? "已拆分" : statusTitle(order) },
        items,
        split: order.pid === -1,
      };
    });
  }
}
