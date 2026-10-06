import { describe, expect, it } from 'vitest';
import type { storeOrder, storeOrderCartInfo, storeOrderRefund } from '../src/models/schema';
import { planCompletedRefundLineCompensation, planOrderFinancialSplit,
  quoteOrderRefundLineFinance } from '../src/services/order/OrderSplitFinance';
import { partitionRefundCartSnapshot, readPromotionLineEvidence } from '../src/services/order/RefundSplitAllocation';

type Order = typeof storeOrder.$inferSelect;
type Cart = typeof storeOrderCartInfo.$inferSelect;
type Refund = typeof storeOrderRefund.$inferSelect;

const allocation = (quantity: number, savingsCents: number) => ({ promotionId: 101, rootId: 101,
  type: 1, savingsCents, discountQuantity: quantity, labelIds: [31], name: '限时九折' });
const source = () => ({
  financial_version: 'checkout-line-finance-v1', id: '1', cart_num: 3,
  sum_price: '18.33', vip_truePrice: '0.00', price_type: 'promotions',
  costPrice: '1.00', integral: 0, promotions_true_price: '1.32',
  raw_postage_price: '0.00', postage_price: '0.00', use_integral: '0',
  one_brokerage: '0.00', two_brokerage: '0.00', division_staff_brokerage: '0.00',
  division_agent_brokerage: '0.00', division_brokerage: '0.00',
  coupon_price: '0.00', integral_price: '0.00', first_order_price: '0.00',
  sum_true_price: '55.00', gain_integral: '0',
  product: { giveIntegral: '0.00' }, sku: { write_times: '1' },
  promotion_quote_version: 'order-promotion-quote-v1',
  promotion_line_price: '55.00', promotion_line_savings: '3.98',
  promotion_line_member_savings: '0.99', promotion_discount_quantity: 2,
  promotion_allocations: [allocation(2, 398)],
  promotion_segments: [
    { quantity: 2, rawGrossCents: 3998, totalPriceCents: 3600, unitPriceCents: 1800 as number | null,
      membershipSavingsCents: 0, promotionIds: [101], promotionAllocations: [allocation(2, 398)],
      couponEligibleGrossCents: 0 },
    { quantity: 1, rawGrossCents: 1999, totalPriceCents: 1900, unitPriceCents: 1900,
      membershipSavingsCents: 99, promotionIds: [], promotionAllocations: [],
      couponEligibleGrossCents: 1900 },
  ],
});
const cart = (info = source()) => ({ id: 1, oid: 9, uid: 7, cartId: '1', cartNum: info.cart_num,
  promotionsId: '101', isGift: 0, refundNum: 0, splitStatus: 0, splitSurplusNum: info.cart_num,
  writeTimes: info.cart_num, writeSurplusTimes: info.cart_num, writeoffTime: 0, isWriteoff: 0,
  cartInfo: JSON.stringify(info) }) as unknown as Cart;
const order = () => ({ id: 9, uid: 7, totalNum: 3, totalPrice: '55.00', payPrice: '55.00',
  changePrice: '0.00', cost: '3.00', promotionsPrice: '3.98', couponPrice: '0.00',
  deductionPrice: '0.00', firstOrderPrice: '0.00', payPostage: '0.00', totalPostage: '0.00',
  oneBrokerage: '0.00', twoBrokerage: '0.00', divisionStaffBrokerage: '0.00',
  divisionAgentBrokerage: '0.00', divisionBrokerage: '0.00', useIntegral: '0.00',
  gainIntegral: '0.00', payIntegral: 0, refundPrice: '0.00', backIntegral: '0.00',
  giveIntegral: 0, giveCoupon: null, promotionsGive: null }) as unknown as Order;
const parsed = (value: string | null) => JSON.parse(value ?? '') as ReturnType<typeof source>;
const claim = (id: number, beforeRefundNum: number, price: string, applyType = 1): Refund => ({
  id, storeOrderId: 9, uid: 7, refundNum: 1, refundType: 6, applyType,
  isCancel: 0, isDel: 0, refundPrice: price, refundedPrice: price,
  cartInfo: JSON.stringify({ cartIds: [{ cartId: 1, cartNum: 1 }],
    quantityReservation: { version: 'refund-quantity-reservation-v1', orderId: 9, uid: 7,
      items: [{ rowId: 1, cartId: 1, cartNum: 1, beforeRefundNum, totalNum: 3 }] } }),
}) as unknown as Refund;
const fullCutSource = () => {
  const info = source();
  const fullCut = { promotionId: 101, rootId: 101, type: 3,
    savingsCents: 400, discountQuantity: 3, labelIds: [31], name: '满减阶梯' };
  info.sum_price = '18.65'; info.sum_true_price = '55.97';
  info.promotions_true_price = '1.33'; info.promotion_line_price = '55.97';
  info.promotion_line_savings = '4.00'; info.promotion_line_member_savings = '0.00';
  info.promotion_discount_quantity = 0; info.promotion_allocations = [fullCut];
  info.promotion_segments = [{ quantity: 3, rawGrossCents: 5997,
    totalPriceCents: 5597, unitPriceCents: null, membershipSavingsCents: 0,
    promotionIds: [101], promotionAllocations: [fullCut], couponEligibleGrossCents: 5597 }];
  return info;
};

describe('exact promotion line finance through partial splits', () => {
  it('partitions discounted first units and member-priced remainder without averaging away cents', () => {
    const row = cart();
    const plan = planOrderFinancialSplit(order(), [row], new Map([['1', 1]]));
    expect(plan).not.toBeNull();
    expect(plan!.selected).toMatchObject({ totalPrice: '18.00', promotionsPrice: '1.99', payPrice: '18.00' });
    expect(plan!.remaining).toMatchObject({ totalPrice: '37.00', promotionsPrice: '1.99', payPrice: '37.00' });
    const pair = plan!.carts.get('1')!;
    expect(parsed(pair.selected)).toMatchObject({ promotion_line_price: '18.00',
      promotion_line_savings: '1.99', promotion_line_member_savings: '0.00', promotion_discount_quantity: 1 });
    expect(parsed(pair.remaining)).toMatchObject({ promotion_line_price: '37.00',
      promotion_line_savings: '1.99', promotion_line_member_savings: '0.99', promotion_discount_quantity: 1 });
    const second = partitionRefundCartSnapshot(pair.remaining!, 2, 1, false);
    expect(parsed(second.selected)).toMatchObject({ promotion_line_price: '18.00', promotion_discount_quantity: 1 });
    expect(parsed(second.remaining)).toMatchObject({ promotion_line_price: '19.00', promotion_discount_quantity: 0 });
  });

  it('quotes a partial refund from the same exact promotion segment as its physical split', () => {
    const selection = new Map([['1', 1]]);
    const expected = planOrderFinancialSplit(order(), [cart()], selection);
    expect(expected?.selected.payPrice).toBe('18.00');
    expect(quoteOrderRefundLineFinance(order(), [cart()], [], selection))
      .toBe(expected?.selected.payPrice);
  });

  it('replays completed refunds through remaining discounted then member-priced segments', () => {
    const claim = (id: number, beforeRefundNum: number): Refund => ({ id, storeOrderId: 9,
      uid: 7, refundNum: 1, refundType: 6, applyType: 1,
      isCancel: 0, isDel: 0, refundPrice: '18.00', refundedPrice: '18.00',
      cartInfo: JSON.stringify({ cartIds: [{ cartId: 1, cartNum: 1 }],
        quantityReservation: { version: 'refund-quantity-reservation-v1', orderId: 9, uid: 7,
          items: [{ rowId: 1, cartId: 1, cartNum: 1, beforeRefundNum, totalNum: 3 }] } }),
    }) as unknown as Refund;
    const selection = new Map([['1', 1]]);
    expect(quoteOrderRefundLineFinance({ ...order(), refundPrice: '18.00' },
      [{ ...cart(), refundNum: 1 }], [claim(1, 0)], selection)).toBe('18.00');
    expect(quoteOrderRefundLineFinance({ ...order(), refundPrice: '36.00' },
      [{ ...cart(), refundNum: 2 }], [claim(1, 0), claim(2, 1)], selection)).toBe('19.00');
  });

  it('compensates the exact 18.66 full-cut piece rather than averaging 55.97 into 18.65', () => {
    const info = fullCutSource(), row = cart(info);
    const sourceOrder = { ...order(), totalPrice: '55.97', payPrice: '55.97', promotionsPrice: '4.00' };
    const selection = new Map([['1', 1]]);
    expect(quoteOrderRefundLineFinance(sourceOrder, [row], [], selection)).toBe('18.66');
    expect(parsed(partitionRefundCartSnapshot(row.cartInfo!, 3, 1, false).selected))
      .toMatchObject({ sum_true_price: '18.66', promotion_line_savings: '1.33' });
    const completed = claim(1, 0, '18.66');
    expect(planCompletedRefundLineCompensation({ ...sourceOrder, refundPrice: '18.66' },
      [{ ...row, refundNum: 1 }], [completed])?.payment)
      .toEqual({ total: 5597, refunded: 1866 });
    const second = claim(2, 1, '18.66'), third = claim(3, 2, '18.65');
    expect(quoteOrderRefundLineFinance({ ...sourceOrder, refundPrice: '18.66' },
      [{ ...row, refundNum: 1 }], [completed], selection)).toBe('18.66');
    expect(planCompletedRefundLineCompensation({ ...sourceOrder, refundPrice: '37.32' },
      [{ ...row, refundNum: 2 }], [completed, second])?.payment)
      .toEqual({ total: 5597, refunded: 3732 });
    expect(quoteOrderRefundLineFinance({ ...sourceOrder, refundPrice: '37.32' },
      [{ ...row, refundNum: 2 }], [completed, second], selection)).toBe('18.65');
    expect(planCompletedRefundLineCompensation({ ...sourceOrder, refundPrice: '55.97' },
      [{ ...row, refundNum: 3 }], [completed, second, third])?.payment)
      .toEqual({ total: 5597, refunded: 5597 });
    const concession = [claim(1, 0, '5.00', 4), second,
      claim(3, 2, '32.31')];
    expect(quoteOrderRefundLineFinance({ ...sourceOrder, refundPrice: '5.00' },
      [{ ...row, refundNum: 1 }], concession.slice(0, 1), selection)).toBe('18.66');
    expect(planCompletedRefundLineCompensation({ ...sourceOrder, refundPrice: '23.66' },
      [{ ...row, refundNum: 2 }], concession.slice(0, 2))?.payment)
      .toEqual({ total: 5597, refunded: 3732 });
    expect(planCompletedRefundLineCompensation({ ...sourceOrder, refundPrice: '55.97' },
      [{ ...row, refundNum: 3 }], concession)?.payment)
      .toEqual({ total: 5597, refunded: 5597 });
    expect(() => planCompletedRefundLineCompensation({ ...sourceOrder, refundPrice: '18.65' },
      [{ ...row, refundNum: 1 }], [{ ...completed, refundPrice: '18.65', refundedPrice: '18.65' }]))
      .toThrow('快照');
  });

  it('replays three exact 18/18/19 type-1 pieces and keeps an Admin cash concession separate', () => {
    const row = cart(), selection = new Map([['1', 1]]), sourceOrder = order();
    const claims = [claim(1, 0, '18.00'), claim(2, 1, '18.00'), claim(3, 2, '19.00')];
    for (let count = 1; count <= 3; count++) {
      const paid = ['18.00', '36.00', '55.00'][count - 1];
      const completed = claims.slice(0, count);
      expect(planCompletedRefundLineCompensation({ ...sourceOrder, refundPrice: paid },
        [{ ...row, refundNum: count }], completed)?.payment)
        .toEqual({ total: 5500, refunded: Number(paid.replace('.', '')) });
      if (count < 3) expect(quoteOrderRefundLineFinance({ ...sourceOrder, refundPrice: paid },
        [{ ...row, refundNum: count }], completed, selection))
        .toBe(count === 1 ? '18.00' : '19.00');
    }
    const concession = [claim(1, 0, '5.00', 4), claim(2, 1, '18.00'), claim(3, 2, '32.00')];
    expect(planCompletedRefundLineCompensation({ ...sourceOrder, refundPrice: '5.00' },
      [{ ...row, refundNum: 1 }], concession.slice(0, 1))?.payment.refunded).toBe(1800);
    expect(planCompletedRefundLineCompensation({ ...sourceOrder, refundPrice: '23.00' },
      [{ ...row, refundNum: 2 }], concession.slice(0, 2))?.payment.refunded).toBe(3600);
    expect(planCompletedRefundLineCompensation({ ...sourceOrder, refundPrice: '55.00' },
      [{ ...row, refundNum: 3 }], concession)?.payment.refunded).toBe(5500);
  });

  it('tracks the exact coupon-adjusted type-3 net while keeping frozen points and commissions unchanged', () => {
    const info = fullCutSource();
    info.coupon_price = '1.00'; info.sum_true_price = '54.97';
    const row = cart(info), sourceOrder = { ...order(), totalPrice: '55.97',
      payPrice: '54.97', promotionsPrice: '4.00', couponPrice: '1.00' };
    const first = claim(1, 0, '18.33'), second = claim(2, 1, '18.33'),
      third = claim(3, 2, '18.31'), selection = new Map([['1', 1]]);
    expect(quoteOrderRefundLineFinance(sourceOrder, [row], [], selection)).toBe('18.33');
    expect(planCompletedRefundLineCompensation({ ...sourceOrder, refundPrice: '18.33' },
      [{ ...row, refundNum: 1 }], [first])).toMatchObject({
        payment: { total: 5497, refunded: 1833 }, usedIntegral: 0,
        productIntegral: { total: 0, refunded: 0 },
        brokerage: { one_brokerage: { total: 0, refunded: 0 } },
      });
    expect(quoteOrderRefundLineFinance({ ...sourceOrder, refundPrice: '18.33' },
      [{ ...row, refundNum: 1 }], [first], selection)).toBe('18.33');
    expect(planCompletedRefundLineCompensation({ ...sourceOrder, refundPrice: '36.66' },
      [{ ...row, refundNum: 2 }], [first, second])?.payment.refunded).toBe(3666);
    expect(quoteOrderRefundLineFinance({ ...sourceOrder, refundPrice: '36.66' },
      [{ ...row, refundNum: 2 }], [first, second], selection)).toBe('18.31');
    expect(planCompletedRefundLineCompensation({ ...sourceOrder, refundPrice: '54.97' },
      [{ ...row, refundNum: 3 }], [first, second, third])?.payment.refunded).toBe(5497);
  });

  it('fails closed on malformed full-cut segment evidence during compensation', () => {
    const info = fullCutSource(); info.promotion_line_savings = '3.99';
    const sourceOrder = { ...order(), totalPrice: '55.97', payPrice: '55.97', promotionsPrice: '4.00',
      refundPrice: '18.66' };
    expect(() => planCompletedRefundLineCompensation(sourceOrder,
      [{ ...cart(info), refundNum: 1 }], [claim(1, 0, '18.66')])).toThrow('快照');
  });

  it('routes coupon to eligible member units while preserving exact net and original total', () => {
    const info = source();
    info.coupon_price = '1.00'; info.sum_true_price = '54.00';
    const evidence = readPromotionLineEvidence(info, 3);
    expect(evidence?.priceCents).toBe(5500);
    const pair = partitionRefundCartSnapshot(JSON.stringify(info), 3, 2, false);
    expect(parsed(pair.selected)).toMatchObject({ promotion_line_price: '36.00', coupon_price: '0.00',
      sum_true_price: '36.00' });
    expect(parsed(pair.remaining)).toMatchObject({ promotion_line_price: '19.00', coupon_price: '1.00',
      sum_true_price: '18.00' });
  });

  it('keeps both partial children nonnegative when stacked one-cent savings exhaust a two-cent segment', () => {
    const info = source();
    const tinyAllocations = [2, 3].map(type => ({ promotionId: 100 + type,
      rootId: 100 + type, type, savingsCents: 1, discountQuantity: 2,
      labelIds: [], name: `stack-${type}` }));
    Object.assign(info, {
      cart_num: 2, sum_price: '0.00', sum_true_price: '0.00',
      promotion_line_price: '0.00', promotion_line_savings: '0.02',
      promotion_line_member_savings: '0.00', promotion_discount_quantity: 0,
      promotion_allocations: tinyAllocations,
      promotion_segments: [{ quantity: 2, rawGrossCents: 2, totalPriceCents: 0,
        unitPriceCents: 0, membershipSavingsCents: 0, promotionIds: [102, 103],
        promotionAllocations: tinyAllocations, couponEligibleGrossCents: 0 }],
    });
    const pair = partitionRefundCartSnapshot(JSON.stringify(info), 2, 1, false);
    const selected = parsed(pair.selected), remaining = parsed(pair.remaining);
    expect(selected.promotion_line_price).toBe('0.00');
    expect(remaining.promotion_line_price).toBe('0.00');
    expect(Number(selected.promotion_line_savings.slice(-2))
      + Number(remaining.promotion_line_savings.slice(-2))).toBe(2);
    expect(readPromotionLineEvidence(selected, 1)).not.toBeNull();
    expect(readPromotionLineEvidence(remaining, 1)).not.toBeNull();
  });

  it.each(['missing-price', 'bad-savings', 'wrong-cap', 'wrong-segment', 'net-mismatch'])(
    'rejects inconsistent promotion evidence %s', (kind) => {
      const info = source();
      if (kind === 'missing-price') delete (info as Record<string, unknown>).promotion_line_price;
      if (kind === 'bad-savings') info.promotion_line_savings = '3.97';
      if (kind === 'wrong-cap') info.promotion_discount_quantity = 3;
      if (kind === 'wrong-segment') info.promotion_segments[0].totalPriceCents = 3599;
      if (kind === 'net-mismatch') info.sum_true_price = '54.99';
      expect(() => planOrderFinancialSplit(order(), [cart(info)], new Map([['1', 1]]))).toThrow('快照');
    },
  );
});
