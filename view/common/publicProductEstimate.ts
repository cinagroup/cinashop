/** Advisory quantity-one merchandise estimate. This is never a checkout receipt. */
export interface PublicProductEstimate {
  version: 1;
  view: 'uni_product_estimate_v1';
  ownerUid: number;
  productId: number;
  skuUnique: string;
  quantity: 1;
  evaluatedAt: number;
  firstOrderEligible: boolean;
  computed: {
    promotions: Array<{ id: number; type: 1 | 2 | 3; name: string; savings: string; quantity: number }>;
    coupon: null | { source: 'owned' | 'issue'; issueId: number; ownedId: number | null; requiresClaim: boolean;
      isMember: boolean; title: string; benefitType: 1 | 2; benefitValue: string; minimum: string; savings: string };
    deduction: { sum_price: string; vip_price: string; promotions_price: string; first_order_price: string;
      coupon_price: string; pay_price: string };
  };
  excludes: ['shipping', 'integral', 'payment'];
  requiresCheckoutRequote: true;
}
export interface PublicProductEstimateIdentity { ownerUid: number; productId: number; skuUnique: string }
const positiveId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value)
  && value > 0 && value <= 2_147_483_647;
const ownerId = (value: unknown): value is number => value === 0 || positiveId(value);
export const validPublicEstimateSku = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 8 && !/[\s\u0000-\u001f\u007f]/u.test(value);
function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('商品单件预估资料无效，请重试');
  const row = value as Record<string, unknown>, keys = Object.keys(row);
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key))) throw Error('商品单件预估资料不完整，请重试');
  return row;
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 255 && !/[\u0000-\u001f\u007f]/u.test(value);
}
function money(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,13})\.\d{2}$/u.test(value)
    || BigInt(value.replace('.', '')) > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('商品单件预估金额无效，请重试');
  return value;
}
const cents = (value: string) => BigInt(value.replace('.', ''));

/** Strict identity and financial reconciliation rejects malformed or mixed
 * actor/SKU responses; no field falls back to zero or a catalogue face value. */
export function decodePublicProductEstimate(value: unknown, expected: PublicProductEstimateIdentity): PublicProductEstimate {
  if (!ownerId(expected.ownerUid) || !positiveId(expected.productId) || !validPublicEstimateSku(expected.skuUnique))
    throw Error('商品单件预估目标无效');
  const row = record(value, ['version', 'view', 'ownerUid', 'productId', 'skuUnique', 'quantity', 'evaluatedAt',
    'firstOrderEligible', 'computed', 'excludes', 'requiresCheckoutRequote']);
  if (row.version !== 1 || row.view !== 'uni_product_estimate_v1' || row.ownerUid !== expected.ownerUid
    || row.productId !== expected.productId || row.skuUnique !== expected.skuUnique || row.quantity !== 1
    || typeof row.evaluatedAt !== 'number' || !Number.isSafeInteger(row.evaluatedAt) || row.evaluatedAt <= 0
    || !Number.isFinite(new Date(row.evaluatedAt * 1_000).getTime()) || typeof row.firstOrderEligible !== 'boolean'
    || row.requiresCheckoutRequote !== true || !Array.isArray(row.excludes)
    || row.excludes.length !== 3 || row.excludes[0] !== 'shipping' || row.excludes[1] !== 'integral' || row.excludes[2] !== 'payment')
    throw Error('商品单件预估与当前账号或规格不一致，请重试');
  const computed = record(row.computed, ['promotions', 'coupon', 'deduction']);
  const deduction = record(computed.deduction, ['sum_price', 'vip_price', 'promotions_price', 'first_order_price', 'coupon_price', 'pay_price']);
  const prices = { sum_price: money(deduction.sum_price), vip_price: money(deduction.vip_price),
    promotions_price: money(deduction.promotions_price), first_order_price: money(deduction.first_order_price),
    coupon_price: money(deduction.coupon_price), pay_price: money(deduction.pay_price) };
  if (cents(prices.sum_price) - cents(prices.vip_price) - cents(prices.promotions_price)
    - cents(prices.first_order_price) - cents(prices.coupon_price) !== cents(prices.pay_price))
    throw Error('商品单件预估金额不一致，请重试');
  if (!Array.isArray(computed.promotions) || computed.promotions.length > 100) throw Error('商品单件预估活动资料无效');
  const promotions: PublicProductEstimate['computed']['promotions'] = computed.promotions.map(value => {
    const item = record(value, ['id', 'type', 'name', 'savings', 'quantity']);
    if (!positiveId(item.id) || ![1, 2, 3].includes(Number(item.type)) || typeof item.type !== 'number'
      || !text(item.name) || typeof item.quantity !== 'number' || !Number.isSafeInteger(item.quantity)
      || item.quantity <= 0 || item.quantity > 32_767) throw Error('商品单件预估活动资料无效');
    return { id: item.id, type: item.type as 1 | 2 | 3, name: item.name, savings: money(item.savings), quantity: item.quantity };
  });
  if (new Set(promotions.map(item => item.id)).size !== promotions.length
    || promotions.reduce((sum, item) => sum + cents(item.savings), 0n) !== cents(prices.promotions_price))
    throw Error('商品单件预估活动金额不一致');
  let coupon: PublicProductEstimate['computed']['coupon'] = null;
  if (computed.coupon !== null) {
    const item = record(computed.coupon, ['source', 'issueId', 'ownedId', 'requiresClaim', 'isMember', 'title',
      'benefitType', 'benefitValue', 'minimum', 'savings']);
    if (!positiveId(item.issueId) || typeof item.source !== 'string' || !['owned', 'issue'].includes(item.source) || !text(item.title)
      || typeof item.isMember !== 'boolean' || ![1, 2].includes(Number(item.benefitType)) || typeof item.benefitType !== 'number'
      || item.source === 'owned' && (!positiveId(item.ownedId) || item.requiresClaim !== false || expected.ownerUid === 0)
      || item.source === 'issue' && (item.ownedId !== null || item.requiresClaim !== true)
      || expected.ownerUid === 0 && item.isMember) throw Error('商品单件预估优惠券身份无效');
    const benefitValue = money(item.benefitValue), minimum = money(item.minimum), savings = money(item.savings);
    if (cents(savings) <= 0n || savings !== prices.coupon_price
      || item.benefitType === 1 && cents(savings) > cents(benefitValue)
      || item.benefitType === 2 && (cents(benefitValue) <= 0n || cents(benefitValue) > 10_000n))
      throw Error('商品单件预估优惠券金额无效');
    coupon = { source: item.source as 'owned' | 'issue', issueId: item.issueId, ownedId: item.ownedId as number | null,
      requiresClaim: item.requiresClaim as boolean, isMember: item.isMember, title: item.title,
      benefitType: item.benefitType as 1 | 2, benefitValue, minimum, savings };
  } else if (cents(prices.coupon_price) !== 0n) throw Error('商品单件预估优惠券资料不完整');
  if (row.firstOrderEligible ? coupon !== null || promotions.length > 0 || cents(prices.promotions_price) !== 0n
    || cents(prices.coupon_price) !== 0n : cents(prices.first_order_price) !== 0n)
    throw Error('商品单件预估首单优惠资料不一致');
  return { version: 1, view: 'uni_product_estimate_v1', ownerUid: expected.ownerUid, productId: expected.productId,
    skuUnique: expected.skuUnique, quantity: 1, evaluatedAt: row.evaluatedAt, firstOrderEligible: row.firstOrderEligible,
    computed: { promotions, coupon, deduction: prices }, excludes: ['shipping', 'integral', 'payment'], requiresCheckoutRequote: true };
}
