import type { CheckoutCartItem as CartItem } from "./checkoutSelection";

export interface CheckoutQuoteOptions {
  addressId: number;
  shippingType: 1 | 2;
  storeId: number;
  couponId: number;
  useIntegral: boolean;
  type: number;
  pinkId?: number;
  combinationId?: number;
  seckillId?: number;
  bargainUserId?: number;
}

export interface CheckoutPrices {
  subtotal: string;
  goodsPayable: string;
  payable: string;
  postage: string;
  postageDiscount: string;
  postagePayable: string;
  memberDiscount: string;
  levelDiscount: string;
  paidMemberDiscount: string;
  couponDiscount: string;
  integralDiscount: string;
  firstOrderDiscount: string;
  usedIntegral: number;
  requiredIntegral: number;
  remainingIntegral: number;
}

export interface CheckoutQuote {
  key: string;
  items: Array<CartItem & { quotedUnitPrice: string }>;
  prices: CheckoutPrices;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}无效`);
  return value as Record<string, unknown>;
}

/** Validate decimal strings without floating-point arithmetic or inventing a fallback price. */
export function quoteMoney(value: unknown): string {
  if (typeof value !== "string" || !/^\d{1,14}(?:\.\d{1,2})?$/.test(value)) throw new Error("服务端报价金额无效");
  const [whole, fraction = ""] = value.split(".");
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("服务端报价金额超出安全范围");
  return `${BigInt(whole)}.${fraction.padEnd(2, "0")}`;
}

function points(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("服务端报价积分无效");
  return value;
}

/** Both endpoints must return the same complete, user/selection-bound preview. */
export function normalizeCheckoutQuote(
  value: unknown,
  selected: CartItem[],
  options: CheckoutQuoteOptions,
  expectedKey?: string,
): CheckoutQuote {
  const source = record(value, "订单报价");
  const key = source.orderKey;
  if (typeof key !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(key) || (expectedKey && key !== expectedKey)) {
    throw new Error("订单报价标识无效，请重新确认");
  }
  if (!selected.length || selected.length > 100 || new Set(selected.map((item) => item.id)).size !== selected.length) {
    throw new Error("请选择有效的结算商品");
  }
  if (options.shippingType === 1 && record(source.addressInfo, "报价收货地址").id !== options.addressId) {
    throw new Error("报价收货地址不匹配，请重新选择");
  }
  if (!Array.isArray(source.cartInfo) || source.cartInfo.length !== selected.length) throw new Error("报价商品不完整");
  const rows = source.cartInfo.map((row) => record(row, "报价商品"));
  if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new Error("报价商品重复");
  const items = selected.map((item) => {
    const row = rows.find((candidate) => candidate.id === item.id);
    if (!row || row.isValid !== true || row.productId !== item.productId || row.unique !== item.unique
      || row.cartNum !== item.cartNum || row.type !== item.type || row.isNew !== item.isNew || !item.productInfo) {
      throw new Error("报价商品或数量已变化，请重新确认商品");
    }
    const product = record(row.productInfo, "报价商品详情");
    return { ...item, sumPrice: quoteMoney(row.sumPrice), quotedUnitPrice: quoteMoney(row.truePrice),
      productInfo: { ...item.productInfo, price: quoteMoney(product.price) } };
  });
  // Confirm uses priceGroup; computed keeps legacy flat fields and adds the matching detail snapshot.
  const price = source.priceGroup === undefined ? source : record(source.priceGroup, "报价明细");
  return { key, items, prices: {
    subtotal: quoteMoney(price.sumPrice), goodsPayable: quoteMoney(price.totalPrice), payable: quoteMoney(price.pay_price),
    postage: quoteMoney(price.total_postage), postageDiscount: quoteMoney(price.storePostageDiscount),
    postagePayable: quoteMoney(price.pay_postage), memberDiscount: quoteMoney(price.vipPrice),
    levelDiscount: quoteMoney(price.levelPrice), paidMemberDiscount: quoteMoney(price.memberPrice),
    couponDiscount: quoteMoney(price.couponPrice), integralDiscount: quoteMoney(price.deduction_price),
    firstOrderDiscount: quoteMoney(price.firstOrderPrice), usedIntegral: points(price.usedIntegral),
    remainingIntegral: points(price.SurplusIntegral),
    requiredIntegral: points(price.pay_integral === undefined && options.type !== 4 ? 0 : price.pay_integral),
  } };
}

export function checkoutQuoteFingerprint(items: CartItem[], options: CheckoutQuoteOptions): string {
  return JSON.stringify([items.map(({ id, productId, unique, cartNum, type, isNew }) => [id, productId, unique, cartNum, type, isNew]), options]);
}

export interface CheckoutQuoteState {
  loading: boolean;
  error: string;
  fingerprint: string;
  result: CheckoutQuote | null;
}

export interface CheckoutQuoteTransport {
  confirm(items: CartItem[], options: CheckoutQuoteOptions): Promise<CheckoutQuote>;
  computed(key: string, items: CartItem[], options: CheckoutQuoteOptions): Promise<CheckoutQuote>;
}

/** Latest response wins, including failures; a slow old request cannot restore a stale amount or key. */
export class CheckoutQuoteSession {
  private generation = 0;
  private key = "";
  private selection = "";
  constructor(private readonly transport: CheckoutQuoteTransport, private readonly publish: (state: CheckoutQuoteState) => void) {}
  invalidate() {
    this.generation++;
    this.publish({ loading: false, error: "", fingerprint: "", result: null });
  }
  reset() {
    this.key = "";
    this.selection = "";
    this.invalidate();
  }
  async load(items: CartItem[], options: CheckoutQuoteOptions) {
    const generation = ++this.generation;
    const fingerprint = checkoutQuoteFingerprint(items, options);
    const selection = JSON.stringify(items.map(({ id, unique, cartNum, type, isNew }) => [id, unique, cartNum, type, isNew]));
    if (selection !== this.selection) { this.key = ""; this.selection = selection; }
    const key = this.key;
    this.publish({ loading: true, error: "", fingerprint, result: null });
    try {
      const result = key ? await this.transport.computed(key, items, options) : await this.transport.confirm(items, options);
      if (generation !== this.generation) return;
      this.key = result.key;
      this.publish({ loading: false, error: "", fingerprint, result });
    } catch (error) {
      if (generation !== this.generation) return;
      this.publish({ loading: false, error: error instanceof Error ? error.message : "订单报价失败", fingerprint, result: null });
    }
  }
}
