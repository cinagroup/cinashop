import type { CheckoutCartItem as CartItem } from "./checkoutSelection";
import type { CartPromotion } from "./cartPrice";

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
  promotionDiscount: string;
  couponDiscount: string;
  integralDiscount: string;
  firstOrderDiscount: string;
  usedIntegral: number;
  requiredIntegral: number;
  remainingIntegral: number;
}

export interface CheckoutQuote {
  key: string;
  quoteToken: string;
  items: Array<CartItem & { quotedUnitPrice: string; quotedTotalPrice: string; promotion: CartPromotion | null }>;
  gifts: CheckoutGifts;
  prices: CheckoutPrices;
}

export interface CheckoutGiftProduct {
  id: string; productId: number; name: string; image: string; suk: string; unique: string;
  unitName: string; quantity: number; promotionId: number;
}
export interface CheckoutGiftCoupon { id: number; title: string; price: string; minPrice: string }
export interface CheckoutGiftPromotion {
  id: number; tierId: number; name: string; threshold: string; repetitions: number;
}
export interface CheckoutGifts {
  products: CheckoutGiftProduct[]; coupons: CheckoutGiftCoupon[]; integral: number;
  promotions: CheckoutGiftPromotion[];
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
const cents = (value: string): bigint => BigInt(quoteMoney(value).replace('.', ''));
const moneyFromCents = (value: number): string => `${BigInt(value) / 100n}.${String(BigInt(value) % 100n).padStart(2, '0')}`;
const safeCents = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const positiveId = (value: unknown): value is number => safeCents(value) && value > 0 && value <= 2_147_483_647;
const plainText = (value: unknown, max = 255): value is string =>
  typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
function exactFields(value: Record<string, unknown>, fields: readonly string[], label: string) {
  if (Object.keys(value).some(key => !fields.includes(key))) throw Error(`${label}含未知字段，请重新确认`);
}
function giftEvidence(source: Record<string, unknown>, giftRows: Record<string, unknown>[], selectedIds: number[]): CheckoutGifts {
  const giftKeys = ['give_coupon', 'give_integral', 'promotions_detail'] as const;
  const hasEvidence = giftKeys.some(key => Object.hasOwn(source, key));
  if (!hasEvidence && !giftRows.length) return { products: [], coupons: [], integral: 0, promotions: [] };
  if (!giftKeys.every(key => Object.hasOwn(source, key))
    || !Array.isArray(source.give_coupon) || !Array.isArray(source.promotions_detail)
    || !safeCents(source.give_integral)
    || source.give_coupon.length > 1_000 || source.promotions_detail.length > 100 || giftRows.length > 1_000) {
    throw Error('满送奖励报价不完整');
  }
  const promotions = source.promotions_detail.map(value => {
    const row = record(value, '满送活动');
    exactFields(row, ['id', 'tierId', 'name', 'threshold', 'repetitions'], '满送活动');
    if (!positiveId(row.id) || !positiveId(row.tierId) || !plainText(row.name) || !row.name
      || typeof row.threshold !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(row.threshold)
      || !positiveId(row.repetitions)) throw Error('满送活动归属不完整');
    return row as unknown as CheckoutGiftPromotion;
  });
  if (new Set(promotions.map(row => row.id)).size !== promotions.length) throw Error('满送活动归属重复');
  const coupons = source.give_coupon.map(value => {
    const row = record(value, '赠送优惠券');
    exactFields(row, ['id', 'title', 'price', 'minPrice'], '赠送优惠券');
    if (!positiveId(row.id) || !plainText(row.title) || !row.title) throw Error('赠送优惠券身份不完整');
    return { id: row.id, title: row.title, price: quoteMoney(row.price), minPrice: quoteMoney(row.minPrice) };
  });
  if (new Set(coupons.map(coupon => coupon.id)).size !== coupons.length) throw Error('赠送优惠券身份重复');
  const selectedSet = new Set(selectedIds.map(String)), seen = new Set<string>();
  const products = giftRows.map(row => {
    exactFields(row, ['id', 'cartId', 'productId', 'product_id', 'cartNum', 'cart_num',
      'isGift', 'is_gift', 'promotions_id', 'truePrice', 'trueSumPrice', 'sumPrice', 'productInfo'], '赠品行');
    const id = row.id;
    if (row.isGift !== 1 || row.is_gift !== 1 || typeof id !== 'string'
      || !/^[1-9]\d{0,9}$/.test(id) || Number(id) > 2_147_483_647 || row.cartId !== id
      || selectedSet.has(id) || seen.has(id) || !positiveId(row.productId) || row.product_id !== row.productId
      || !positiveId(row.cartNum) || row.cart_num !== row.cartNum || !positiveId(row.promotions_id)
      || !promotions.some(campaign => campaign.id === row.promotions_id)
      || quoteMoney(row.truePrice) !== '0.00' || quoteMoney(row.trueSumPrice) !== '0.00'
      || quoteMoney(row.sumPrice) !== '0.00') throw Error('赠品行身份、归属或零金额不完整');
    seen.add(id);
    const product = record(row.productInfo, '赠品商品');
    exactFields(product, ['id', 'storeName', 'store_name', 'image', 'unitName', 'unit_name',
      'productType', 'price', 'attrInfo'], '赠品商品');
    const attr = record(product.attrInfo, '赠品规格');
    exactFields(attr, ['product_id', 'unique', 'suk', 'price', 'image'], '赠品规格');
    if (product.id !== row.productId || product.productType !== 0
      || !plainText(product.storeName, 256) || !product.storeName || product.store_name !== product.storeName
      || !plainText(product.image, 2_048) || !plainText(product.unitName, 32)
      || product.unit_name !== product.unitName || quoteMoney(product.price) !== '0.00'
      || attr.product_id !== row.productId || !plainText(attr.unique, 8) || !attr.unique
      || !plainText(attr.suk, 512) || !plainText(attr.image, 2_048)
      || attr.image !== product.image || quoteMoney(attr.price) !== '0.00') {
      throw Error('赠品商品或规格回显不完整');
    }
    return { id, productId: row.productId, name: product.storeName, image: product.image,
      suk: attr.suk, unique: attr.unique, unitName: product.unitName,
      quantity: row.cartNum, promotionId: row.promotions_id } as CheckoutGiftProduct;
  });
  if ((products.length || coupons.length || source.give_integral) && !promotions.length) throw Error('满送奖励缺少活动归属');
  return { products, coupons, integral: source.give_integral, promotions };
}
function quotePromotion(value: unknown, item: CartItem, totalPriceCents: number): CartPromotion {
  const source = record(value, '商品活动报价');
  if (String(source.key) !== String(item.id) || source.productId !== item.productId || source.quantity !== item.cartNum
    || source.totalPriceCents !== totalPriceCents || !safeCents(source.promotionSavingsCents)
    || source.unitPriceCents !== null && !safeCents(source.unitPriceCents)
    || !Array.isArray(source.segments) || !source.segments.length || source.segments.length > 100) throw Error('商品活动报价不完整');
  const segments = source.segments.map(value => {
    const segment = record(value, '商品活动分段');
    if (!safeCents(segment.quantity) || segment.quantity < 1 || segment.quantity > item.cartNum
      || !safeCents(segment.totalPriceCents) || segment.unitPriceCents !== null && !safeCents(segment.unitPriceCents)
      || !Array.isArray(segment.promotionIds) || segment.promotionIds.some(id => !safeCents(id) || id < 1)
      || segment.unitPriceCents !== null && BigInt(segment.unitPriceCents) * BigInt(segment.quantity) !== BigInt(segment.totalPriceCents)) throw Error('商品活动分段无效');
    return { quantity: segment.quantity, totalPriceCents: segment.totalPriceCents,
      unitPriceCents: segment.unitPriceCents, promotionIds: [...segment.promotionIds] };
  });
  if (segments.reduce((sum, part) => sum + part.quantity, 0) !== item.cartNum
    || segments.reduce((sum, part) => sum + BigInt(part.totalPriceCents), 0n) !== BigInt(totalPriceCents)
    || source.unitPriceCents !== null && BigInt(source.unitPriceCents) * BigInt(item.cartNum) !== BigInt(totalPriceCents)) throw Error('商品活动分段合计不一致');
  return { unitPriceCents: source.unitPriceCents, totalPriceCents,
    promotionSavingsCents: source.promotionSavingsCents, segments };
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
  const quoteToken = source.quoteToken;
  if (typeof quoteToken !== 'string' || !/^[a-f0-9]{32}$/.test(quoteToken)) throw new Error('订单报价凭据无效，请重新确认');
  if (typeof key !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(key) || (expectedKey && key !== expectedKey)) {
    throw new Error("订单报价标识无效，请重新确认");
  }
  if (!selected.length || selected.length > 100 || new Set(selected.map((item) => item.id)).size !== selected.length) {
    throw new Error("请选择有效的结算商品");
  }
  const nonLogistics = selected.every(item => item.productInfo && [1, 2, 3].includes(item.productInfo.productType));
  if (options.shippingType === 1 && !(nonLogistics && options.addressId === 0 && source.addressInfo === null)
    && record(source.addressInfo, "报价收货地址").id !== options.addressId) {
    throw new Error("报价收货地址不匹配，请重新选择");
  }
  if (!Array.isArray(source.cartInfo) || source.cartInfo.length < selected.length
    || source.cartInfo.length > selected.length + 1_000) throw new Error("报价商品不完整");
  const rows = source.cartInfo.map((row) => record(row, "报价商品"));
  const giftRows = rows.filter(row => row.isGift === 1 || row.is_gift === 1);
  const purchaseRows = rows.filter(row => row.isGift !== 1 && row.is_gift !== 1);
  if (purchaseRows.length !== selected.length
    || purchaseRows.some(row => row.isGift !== undefined && row.isGift !== 0
      || row.is_gift !== undefined && row.is_gift !== 0)
    || new Set(rows.map(row => String(row.id))).size !== rows.length) throw Error('报价商品或赠品重复、不完整');
  const gifts = giftEvidence(source, giftRows, selected.map(item => item.id));
  const items = selected.map((item) => {
    const row = purchaseRows.find((candidate) => candidate.id === item.id);
    if (!row || row.isValid !== true || row.productId !== item.productId || row.unique !== item.unique
      || row.cartNum !== item.cartNum || row.type !== item.type || row.isNew !== item.isNew || !item.productInfo) {
      throw new Error("报价商品或数量已变化，请重新确认商品");
    }
    const product = record(row.productInfo, "报价商品详情");
    if (nonLogistics && product.productType !== item.productInfo.productType) {
      throw new Error("报价商品配送类型已变化，请重新确认商品");
    }
    const sumPrice = quoteMoney(row.sumPrice), quotedUnitPrice = quoteMoney(row.truePrice);
    const totalPriceCents = row.totalPriceCents === undefined ? Number(cents(quotedUnitPrice) * BigInt(item.cartNum)) : row.totalPriceCents;
    if (!safeCents(totalPriceCents) || BigInt(totalPriceCents) > cents(sumPrice)) throw Error('报价商品精确总额无效');
    const promotion = row.promotion === undefined || row.promotion === null ? null : quotePromotion(row.promotion, item, totalPriceCents);
    if (promotion && Number(cents(quotedUnitPrice)) !== (promotion.unitPriceCents ?? Math.floor(totalPriceCents / item.cartNum))) {
      throw Error('报价展示单价与精确总额不一致');
    }
    if (!promotion && cents(quotedUnitPrice) * BigInt(item.cartNum) !== BigInt(totalPriceCents)) throw Error('报价商品单价与总额不一致');
    return { ...item, sumPrice, quotedUnitPrice, quotedTotalPrice: moneyFromCents(totalPriceCents), promotion,
      productInfo: { ...item.productInfo, price: quoteMoney(product.price) } };
  });
  // Confirm uses priceGroup; computed keeps legacy flat fields and adds the matching detail snapshot.
  const price = source.priceGroup === undefined ? source : record(source.priceGroup, "报价明细");
  const promotionDiscount = price.promotionSavingsCents === undefined
    ? quoteMoney(price.promotionsPrice ?? '0.00')
    : safeCents(price.promotionSavingsCents) ? moneyFromCents(price.promotionSavingsCents) : null;
  if (promotionDiscount === null) throw Error('活动优惠总账无效');
  if (items.some(item => item.promotion)
    && items.reduce((sum, item) => sum + BigInt(item.promotion?.promotionSavingsCents ?? 0), 0n) !== cents(promotionDiscount)) {
    throw Error('活动优惠分段与总账不一致');
  }
  if (purchaseRows.every(row => row.totalPriceCents !== undefined)
    && items.reduce((sum, item) => sum + cents(item.quotedTotalPrice), 0n) !== cents(quoteMoney(price.totalPrice))) {
    throw Error('报价商品合计与总账不一致');
  }
  return { key, quoteToken, items, gifts, prices: {
    subtotal: quoteMoney(price.sumPrice), goodsPayable: quoteMoney(price.totalPrice), payable: quoteMoney(price.pay_price),
    postage: quoteMoney(price.total_postage), postageDiscount: quoteMoney(price.storePostageDiscount),
    postagePayable: quoteMoney(price.pay_postage), memberDiscount: quoteMoney(price.vipPrice),
    levelDiscount: quoteMoney(price.levelPrice), paidMemberDiscount: quoteMoney(price.memberPrice), promotionDiscount,
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
