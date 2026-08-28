import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Env } from "@/env";
import type { Container } from "@/lib/di";
import {
  storeOrder,
  storeOrderCartInfo,
  storeOrderRefund,
  storeOrderWriteoff,
  storeProduct,
  systemStore,
} from "@/models/schema";
import { CheckoutCashierService } from "@/services/payment/CheckoutCashierService";
import { getPaymentReadiness } from "@/services/payment/PaymentReadinessService";
import { StoreCartService } from "@/services/order/StoreCartService";
import { SystemConfigService } from "@/services/system/SystemConfigService";
import { NotFoundException, ValidateException } from "@/utils/errors";

const CHECKOUT_TTL_SECONDS = 30 * 60;
const LEGACY_ALIPAY_TTL_SECONDS = 5 * 60;
const MAX_CHECKOUT_ITEMS = 200;

type LegacyCartSelection = { cartId: number; cartNum?: number };

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseJson(value: string | null | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function decimal(value: unknown): string {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) ? amount.toFixed(2) : "0.00";
}

export function parseLegacyCartIds(value: unknown): number[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : typeof value === "number"
        ? [value]
        : [];
  const ids = values.map((item) => Number(item));
  if (
    !ids.length || ids.length > MAX_CHECKOUT_ITEMS ||
    ids.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
    new Set(ids).size !== ids.length
  ) {
    throw new ValidateException("请提交有效的购物车商品");
  }
  return ids;
}

export function parseLegacyRefundSelections(value: unknown): LegacyCartSelection[] {
  if (!Array.isArray(value)) return [];
  if (value.length > MAX_CHECKOUT_ITEMS) throw new ValidateException("退款商品数量过多");
  const selections = value.map((item) => {
    const row = record(item);
    const cartId = Number(row.cart_id ?? row.cartId ?? row.id ?? item);
    const rawNum = row.cart_num ?? row.cartNum;
    const cartNum = rawNum === undefined ? undefined : Number(rawNum);
    if (!Number.isSafeInteger(cartId) || cartId <= 0) {
      throw new ValidateException("退款商品参数错误");
    }
    if (cartNum !== undefined && (!Number.isSafeInteger(cartNum) || cartNum <= 0)) {
      throw new ValidateException("退款商品件数错误");
    }
    return { cartId, cartNum };
  });
  if (new Set(selections.map((item) => item.cartId)).size !== selections.length) {
    throw new ValidateException("退款商品不能重复选择");
  }
  return selections;
}

function checkoutCacheKey(uid: number, key: string): string {
  return `order:confirm:${uid}:${key}`;
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

function legacyCartRow(item: Record<string, unknown>): Record<string, unknown> {
  const product = record(item.productInfo);
  const price = decimal(product.price);
  return {
    ...item,
    product_id: Number(item.productId ?? 0),
    cart_num: Number(item.cartNum ?? 0),
    activity_id: Number(item.activityId ?? 0),
    truePrice: price,
    productInfo: {
      ...product,
      id: Number(item.productId ?? 0),
      store_name: String(product.storeName ?? ""),
      unit_name: String(product.unitName ?? ""),
      price,
      attrInfo: {
        product_id: Number(item.productId ?? 0),
        suk: String(product.suk ?? ""),
        price,
        image: String(product.image ?? ""),
      },
    },
  };
}

function legacyRefundCartSnapshot(
  snapshot: Record<string, unknown>,
  cart: typeof storeOrderCartInfo.$inferSelect,
): Record<string, unknown> {
  const existingProduct = record(snapshot.productInfo);
  if (Object.keys(existingProduct).length) return snapshot;
  const product = record(snapshot.product);
  const sku = record(snapshot.sku);
  const lineTotal = Number(snapshot.sum_true_price ?? snapshot.sumTruePrice ?? 0);
  const unitPrice = cart.cartNum > 0 && Number.isFinite(lineTotal)
    ? lineTotal / cart.cartNum
    : Number(sku.price ?? 0);
  const price = Number.isFinite(unitPrice) ? unitPrice.toFixed(2) : "0.00";
  return {
    ...snapshot,
    truePrice: price,
    sum_true_price: Number.isFinite(lineTotal) ? lineTotal.toFixed(2) : "0.00",
    product_id: Number(product.id ?? cart.productId),
    type: cart.type,
    activity_id: Number(product.activityId ?? 0),
    productInfo: {
      id: Number(product.id ?? cart.productId),
      image: String(product.image ?? ""),
      store_name: String(product.storeName ?? product.store_name ?? ""),
      price,
      attrInfo: {
        product_id: Number(product.id ?? cart.productId),
        suk: String(sku.suk ?? ""),
        price: decimal(sku.price ?? price),
        image: String(sku.image ?? product.image ?? ""),
      },
    },
  };
}

export class LegacyOrderCompatibilityService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  private async checkoutRows(uid: number, cartIds: number[]) {
    const selected = new Set(cartIds);
    const rows = (await new StoreCartService(this.container, this.env).list(uid))
      .map((item) => record(item))
      .filter((item) => selected.has(Number(item.id)))
      .map(legacyCartRow);
    if (rows.length !== cartIds.length || rows.some((item) => item.isValid !== true)) {
      throw new ValidateException("购物车商品已失效或不属于当前用户");
    }
    const byId = new Map(rows.map((item) => [Number(item.id), item]));
    return cartIds.map((id) => byId.get(id)!);
  }

  async rememberCheckout(uid: number, cartIds: number[]): Promise<string> {
    const key = crypto.randomUUID().replaceAll("-", "");
    await this.env.CONFIG_KV.put(
      checkoutCacheKey(uid, key),
      JSON.stringify({ cartIds }),
      { expirationTtl: CHECKOUT_TTL_SECONDS },
    );
    return key;
  }

  async checkoutCartIds(uid: number, key: string): Promise<number[]> {
    if (!/^[a-zA-Z0-9_-]{8,64}$/.test(key)) throw new ValidateException("订单确认标识无效");
    const value = await this.env.CONFIG_KV.get(checkoutCacheKey(uid, key));
    if (!value) throw new ValidateException("订单已过期,请刷新当前页面");
    try {
      return parseLegacyCartIds(record(JSON.parse(value)).cartIds);
    } catch (error) {
      if (error instanceof ValidateException) throw error;
      throw new ValidateException("订单确认标识已失效");
    }
  }

  async createAlipayKey(uid: number, orderId: string): Promise<string> {
    const key = crypto.randomUUID().replaceAll("-", "");
    await this.env.CONFIG_KV.put(
      `pay:alipay:${key}`,
      JSON.stringify({ uid, orderId }),
      { expirationTtl: LEGACY_ALIPAY_TTL_SECONDS },
    );
    return key;
  }

  async consumeAlipayKey(key: string): Promise<{ uid: number; orderId: string }> {
    if (!/^[a-f0-9]{32}$/.test(key)) throw new ValidateException("该订单无法支付");
    const cacheKey = `pay:alipay:${key}`;
    const value = await this.env.CONFIG_KV.get(cacheKey);
    if (!value) throw new ValidateException("该订单无法支付");
    let data: Record<string, unknown>;
    try {
      data = record(JSON.parse(value));
    } catch {
      throw new ValidateException("该订单无法支付");
    }
    const uid = Number(data.uid);
    const orderId = String(data.orderId ?? "").trim();
    if (!Number.isSafeInteger(uid) || uid <= 0 || !orderId) {
      throw new ValidateException("该订单无法支付");
    }
    await this.env.CONFIG_KV.delete(cacheKey);
    return { uid, orderId };
  }

  async checkShipping(uid: number, cartIds: number[]) {
    const carts = await this.container.storeCartDao.getByIds(cartIds);
    if (
      carts.length !== cartIds.length ||
      carts.some((cart) => cart.uid !== uid || cart.isPay !== 0 || cart.isDel !== 0 || cart.status !== 1)
    ) {
      throw new ValidateException("获取购物车信息失败");
    }
    const productIds = [...new Set(carts.map((cart) => cart.productId))];
    const products = await this.container.db
      .select({ id: storeProduct.id, deliveryType: storeProduct.deliveryType })
      .from(storeProduct)
      .where(inArray(storeProduct.id, productIds));
    if (products.length !== productIds.length) throw new ValidateException("获取商品配送方式失败");
    const available = new Set<number>();
    for (const product of products) {
      const methods = product.deliveryType
        .split(",")
        .map(Number)
        .filter((item) => [1, 2, 3].includes(item));
      for (const method of methods.length ? methods : [1, 2, 3]) available.add(method);
    }
    const config = await new SystemConfigService(this.container, this.env).get("store_self_mention");
    if (config === "0") available.delete(2);
    if (available.has(2)) {
      const stores = await this.container.db
        .select({ id: systemStore.id })
        .from(systemStore)
        .where(and(eq(systemStore.isShow, 1), eq(systemStore.isDel, 0)))
        .limit(1);
      if (!stores.length) available.delete(2);
    }
    const methods = [...available].sort();
    const type = methods.length === 1 ? (methods[0] === 2 ? 2 : 1) :
      methods.length === 2 && !methods.includes(2) ? 1 : 0;
    return { type, methods };
  }

  async checkoutPreview(
    uid: number,
    cartIds: number[],
    addressId = 0,
    existingKey?: string,
  ) {
    const rows = await this.checkoutRows(uid, cartIds);
    const subtotal = rows.reduce((sum, item) => sum + Number(item.sumPrice ?? 0), 0);
    if (!Number.isFinite(subtotal) || subtotal < 0) throw new ValidateException("商品金额无效");
    const [account, readiness, requestedAddress] = await Promise.all([
      this.container.userDao.findForAuth(uid),
      getPaymentReadiness(this.container, this.env),
      addressId > 0 ? this.container.userAddressDao.get(addressId) : this.container.userAddressDao.getDefault(uid),
    ]);
    if (!account) throw new NotFoundException("用户不存在");
    const address = requestedAddress && requestedAddress.uid === uid && requestedAddress.isDel === 0
      ? requestedAddress
      : null;
    const key = existingKey ?? await this.rememberCheckout(uid, cartIds);
    const sumPrice = subtotal.toFixed(2);
    const priceGroup = {
      sumPrice,
      totalPrice: sumPrice,
      pay_price: sumPrice,
      pay_postage: "0.00",
      storePostage: "0.00",
      storePostageDiscount: "0.00",
      vipPrice: "0.00",
      couponPrice: "0.00",
      coupon_price: "0.00",
      deduction_price: "0.00",
      firstOrderPrice: "0.00",
    };
    return {
      addressInfo: legacyAddress(address ? address as unknown as Record<string, unknown> : null),
      upgrade_addr: false,
      cartInfo: rows,
      custom_form: [],
      product_type: Math.max(0, ...rows.map((item) => Number(record(item.productInfo).productType ?? 0))),
      userInfo: {
        uid: account.uid,
        now_money: decimal(account.nowMoney),
        integral: account.integral,
        vip: account.level > 0 || account.isMoneyLevel === 1,
      },
      deduction: { coupon_price: "0.00", deduction_price: "0.00" },
      orderKey: key,
      priceGroup,
      give_coupon: [],
      give_integral: 0,
      promotions_detail: [],
      seckill_id: 0,
      methods: readiness,
      yue_pay_status: readiness.yue.enabled ? 1 : 2,
      pay_weixin_open: readiness.weixin.enabled ? 1 : 0,
      ali_pay_status: readiness.alipay.enabled,
    };
  }

  async orderData(uid: number) {
    const [orders, refunds, readiness] = await Promise.all([
      this.container.db.execute(sql`
        SELECT
          count(*) FILTER (WHERE pid = 0)::text AS order_count,
          COALESCE(sum(pay_price) FILTER (WHERE pid = 0 AND paid = 1), 0)::text AS sum_price,
          count(*) FILTER (WHERE pid = 0 AND paid = 0 AND status = 0 AND refund_status = 0)::text AS unpaid_count,
          count(*) FILTER (WHERE pid = 0 AND paid = 1 AND status IN (0, 4) AND refund_status IN (0, 3) AND shipping_type IN (1, 3))::text AS unshipped_count,
          count(*) FILTER (WHERE pid = 0 AND paid = 1 AND ((status IN (1, 5) AND shipping_type = 1) OR (status IN (0, 5) AND shipping_type = 2)) AND refund_status IN (0, 3))::text AS received_count,
          count(*) FILTER (WHERE pid = 0 AND paid = 1 AND status = 2 AND refund_status IN (0, 3))::text AS evaluated_count,
          count(*) FILTER (WHERE paid = 1 AND status IN (0, 1, 5) AND shipping_type = 2 AND refund_status IN (0, 3))::text AS unwritoff_count,
          count(*) FILTER (WHERE pid = 0 AND paid = 1 AND status = 3 AND refund_status IN (0, 3))::text AS complete_count
        FROM store_order
        WHERE uid = ${uid} AND is_del = 0 AND is_system_del = 0
      `),
      this.container.db.execute(sql`
        SELECT
          count(*) FILTER (WHERE refund_type IN (0, 1, 2, 4, 5))::text AS refunding_count,
          count(*) FILTER (WHERE refund_type IN (3, 6))::text AS refunded_count
        FROM store_order_refund
        WHERE uid = ${uid} AND is_cancel = 0 AND is_del = 0
      `),
      getPaymentReadiness(this.container, this.env),
    ]);
    const order = record(orders[0]);
    const refund = record(refunds[0]);
    const refunding = String(refund.refunding_count ?? "0");
    const refunded = String(refund.refunded_count ?? "0");
    return {
      ...order,
      refunding_count: refunding,
      refunded_count: refunded,
      refund_count: String(Number(refunding) + Number(refunded)),
      yue_pay_status: readiness.yue.enabled ? 1 : 2,
      pay_weixin_open: readiness.weixin.enabled ? 1 : 0,
      ali_pay_status: readiness.alipay.enabled,
    };
  }

  async refundReasons(): Promise<string[]> {
    const value = await new SystemConfigService(this.container, this.env).get("stor_reason");
    return value.replaceAll("\r\n", "\n").split("\n").map((item) => item.trim()).filter(Boolean);
  }

  private async ownedOrder(uid: number, id: number) {
    const rows = await this.container.db
      .select()
      .from(storeOrder)
      .where(and(eq(storeOrder.id, id), eq(storeOrder.uid, uid), eq(storeOrder.isSystemDel, 0)))
      .limit(1);
    if (!rows[0]) throw new NotFoundException("订单不存在");
    return rows[0];
  }

  async refundCartInfo(uid: number, orderId: number, selections: LegacyCartSelection[] = []) {
    const order = await this.ownedOrder(uid, orderId);
    const carts = await this.container.db
      .select()
      .from(storeOrderCartInfo)
      .where(eq(storeOrderCartInfo.oid, order.id))
      .orderBy(storeOrderCartInfo.id);
    const selected = new Map(selections.map((item) => [item.cartId, item]));
    const rows = carts
      .filter((cart) => !selected.size || selected.has(cart.id) || selected.has(Number(cart.cartId)))
      .map((cart) => {
        const choice = selected.get(cart.id) ?? selected.get(Number(cart.cartId));
        const available = Math.max(0, cart.cartNum - cart.refundNum);
        const cartInfo = record(parseJson(cart.cartInfo));
        const legacySnapshot = legacyRefundCartSnapshot(cartInfo, cart);
        return {
          ...cart,
          cart_id: cart.cartId,
          cart_num: choice?.cartNum ?? available,
          surplus_num: available,
          cart_info: cartInfo,
          ...legacySnapshot,
        };
      })
      .filter((cart) => cart.surplus_num > 0);
    if (selected.size && rows.length !== selected.size) {
      throw new ValidateException("退款商品不属于当前订单或已无可退数量");
    }
    return rows;
  }

  async refundCartInfoSummary(uid: number, orderId: number, selections: LegacyCartSelection[]) {
    const [order, cartInfo, pending] = await Promise.all([
      this.ownedOrder(uid, orderId),
      this.refundCartInfo(uid, orderId, selections),
      this.container.db
        .select({ total: sql<number>`COALESCE(sum(${storeOrderRefund.refundNum}), 0)::int` })
        .from(storeOrderRefund)
        .where(and(
          eq(storeOrderRefund.storeOrderId, orderId),
          eq(storeOrderRefund.uid, uid),
          eq(storeOrderRefund.isCancel, 0),
          eq(storeOrderRefund.isDel, 0),
          inArray(storeOrderRefund.refundType, [0, 1, 2, 4, 5]),
        )),
    ]);
    return {
      _status: { _type: order.status },
      cartInfo,
      refund_num: pending[0]?.total ?? 0,
    };
  }

  async orderProduct(uid: number, unique: string) {
    const rows = await this.container.db
      .select({ cart: storeOrderCartInfo, orderId: storeOrder.orderId })
      .from(storeOrderCartInfo)
      .innerJoin(storeOrder, eq(storeOrder.id, storeOrderCartInfo.oid))
      .where(and(eq(storeOrderCartInfo.unique, unique), eq(storeOrderCartInfo.uid, uid)))
      .limit(2);
    if (rows.length !== 1) throw new NotFoundException("评价商品不存在");
    const snapshot = record(parseJson(rows[0].cart.cartInfo));
    const product = record(snapshot.productInfo ?? snapshot.product);
    const attr = record(product.attrInfo ?? snapshot.sku);
    return {
      cart_num: Number(snapshot.cart_num ?? rows[0].cart.cartNum),
      productInfo: {
        image: String(product.image ?? ""),
        price: decimal(product.price ?? snapshot.truePrice),
        store_name: String(product.store_name ?? product.storeName ?? ""),
        ...(Object.keys(attr).length ? {
          attrInfo: {
            product_id: Number(attr.product_id ?? attr.productId ?? rows[0].cart.productId),
            suk: String(attr.suk ?? ""),
            price: decimal(attr.price),
            image: String(attr.image ?? product.image ?? ""),
          },
        } : {}),
      },
      product_id: Number(snapshot.product_id ?? rows[0].cart.productId),
      type: Number(snapshot.type ?? rows[0].cart.type),
      activity_id: Number(snapshot.activity_id ?? 0),
      order_id: rows[0].orderId,
    };
  }

  async writeoffRecords(uid: number, orderId: number, page = 1, limit = 10) {
    await this.ownedOrder(uid, orderId);
    const boundedPage = Math.max(1, Math.trunc(page));
    const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 100));
    const [rows, totals] = await Promise.all([
      this.container.db
        .select({ writeoff: storeOrderWriteoff, cartInfo: storeOrderCartInfo.cartInfo })
        .from(storeOrderWriteoff)
        .leftJoin(storeOrderCartInfo, eq(storeOrderCartInfo.id, storeOrderWriteoff.orderCartId))
        .where(and(eq(storeOrderWriteoff.oid, orderId), eq(storeOrderWriteoff.uid, uid)))
        .orderBy(desc(storeOrderWriteoff.addTime), desc(storeOrderWriteoff.id))
        .limit(boundedLimit)
        .offset((boundedPage - 1) * boundedLimit),
      this.container.db
        .select({ total: sql<number>`count(*)::int` })
        .from(storeOrderWriteoff)
        .where(and(eq(storeOrderWriteoff.oid, orderId), eq(storeOrderWriteoff.uid, uid))),
    ]);
    const list = rows.map(({ writeoff, cartInfo }) => {
      const snapshot = record(parseJson(cartInfo));
      const time = writeoff.addTime > 0 ? new Date(writeoff.addTime * 1000).toISOString().slice(0, 16).replace("T", " ") : "";
      return { ...writeoff, cartInfo: snapshot, add_time: time, time, time_key: time };
    });
    return { count: totals[0]?.total ?? 0, list, time: [...new Set(list.map((item) => item.time_key))] };
  }

  async orderPrize(uid: number, orderNumber: string) {
    const order = await this.container.storeOrderDao.findByOrderId(orderNumber);
    if (!order || order.uid !== uid) throw new NotFoundException("订单不存在");
    const giftRows = await this.container.db
      .select()
      .from(storeOrderCartInfo)
      .where(and(eq(storeOrderCartInfo.oid, order.id), eq(storeOrderCartInfo.isGift, 1)))
      .orderBy(storeOrderCartInfo.id);
    const gift = giftRows.map((item) => {
      const snapshot = record(parseJson(item.cartInfo));
      const product = record(snapshot.productInfo ?? snapshot.product);
      return {
        product_id: Number(product.id ?? item.productId),
        store_name: String(product.store_name ?? product.storeName ?? ""),
      };
    });
    const coupons = parseJson(order.giveCoupon);
    return {
      coupons: Array.isArray(coupons) ? coupons : [],
      integral: Number(order.giveIntegral ?? 0),
      exp: 0,
      gift,
    };
  }

  async payCashierOrder(uid: number, storeId = 0) {
    const conditions = [
      eq(storeOrder.uid, uid),
      eq(storeOrder.paid, 0),
      eq(storeOrder.isDel, 0),
      eq(storeOrder.isSystemDel, 0),
      eq(storeOrder.shippingType, 4),
    ];
    if (storeId > 0) conditions.push(eq(storeOrder.storeId, storeId));
    const rows = await this.container.db
      .select()
      .from(storeOrder)
      .where(and(...conditions))
      .orderBy(desc(storeOrder.addTime), desc(storeOrder.id))
      .limit(1);
    const order = rows[0];
    if (!order) throw new NotFoundException("订单不存在");
    const cashier = await new CheckoutCashierService(this.container, this.env).get(uid, order.orderId, "order");
    return { ...order, ...cashier };
  }
}
