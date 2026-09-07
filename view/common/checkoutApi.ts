import { normalizeCheckoutQuote, type CheckoutQuoteOptions } from "./checkoutQuote";
import { normalizeOrderCouponPage, orderCouponRequest, type OrderCouponScope } from "./orderCoupons";
import { validateCheckoutItems, type CheckoutCartItem, type CheckoutSelection } from "./checkoutSelection";

export interface CheckoutTransport {
  get(url: string, params: Record<string, unknown>): Promise<{ data: unknown; headers: Record<string, string> }>;
  post(url: string, body: Record<string, unknown>): Promise<unknown>;
}

/** Boundary shared by native/H5 adapters. It sends identifiers/options, never client prices. */
export function createCheckoutApi(transport: CheckoutTransport) {
  const quoteBody = (options: CheckoutQuoteOptions) => ({
    addressId: options.addressId, shippingType: options.shippingType, storeId: options.storeId,
    couponId: options.couponId, useIntegral: options.useIntegral, type: options.type,
    ...(options.pinkId === undefined ? {} : { pinkId: options.pinkId }),
    ...(options.combinationId === undefined ? {} : { combinationId: options.combinationId }),
    ...(options.seckillId === undefined ? {} : { seckillId: options.seckillId }),
    ...(options.bargainUserId === undefined ? {} : { bargainUserId: options.bargainUserId }),
  });
  return {
    async items(selection: CheckoutSelection, checkedIds: readonly number[] = []) {
      const ids = [...(selection.mode === "buy" ? selection.ids : checkedIds)];
      if (!ids.length || ids.length > 100 || ids.some((id) => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length) throw new Error("请选择有效的结算商品");
      const params = selection.mode === "buy" ? { scope: "buy", ids: ids.join(",") } : { scope: "cart" };
      const response = await transport.get("/cart/list", params);
      // A normal cart may contain unselected rows; the exact requested selection must still exist and validate.
      if (!Array.isArray(response.data)) throw new Error("购物车响应无效");
      const rows = selection.mode === "buy" ? response.data : response.data.filter((row: unknown) =>
        !!row && typeof row === "object" && "id" in row && ids.includes(row.id as number));
      return validateCheckoutItems(rows, ids, selection.mode === "buy" ? 1 : 0);
    },
    async confirm(items: CheckoutCartItem[], options: CheckoutQuoteOptions) {
      const selected = JSON.parse(JSON.stringify(items)) as CheckoutCartItem[];
      const snapshot = quoteBody(options);
      const result = await transport.post("/order/confirm", { cartIds: selected.map((row) => row.id), ...snapshot });
      return normalizeCheckoutQuote(result, selected, snapshot);
    },
    async computed(key: string, items: CheckoutCartItem[], options: CheckoutQuoteOptions) {
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(key)) throw new Error("订单报价标识无效");
      const selected = JSON.parse(JSON.stringify(items)) as CheckoutCartItem[];
      const snapshot = quoteBody(options);
      const result = await transport.post(`/order/computed/${encodeURIComponent(key)}`, snapshot);
      return normalizeCheckoutQuote(result, selected, snapshot, key);
    },
    async coupons(scope: OrderCouponScope, before?: number) {
      const response = await transport.get("/coupons/order/0", orderCouponRequest(scope, before));
      return normalizeOrderCouponPage(response.data, response.headers["x-coupon-next-cursor"], before);
    },
  };
}
