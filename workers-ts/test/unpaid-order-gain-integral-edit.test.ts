import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { storeOrder, storeOrderCartInfo } from '../src/models/schema';
import { planUnpaidOrderGainIntegralEdit, UNPAID_GAIN_EDIT_POLICY } from '../src/services/order/UnpaidOrderGainIntegralEdit';
import { planOrderFinancialSplit, planCompletedRefundLineCompensation, quoteOrderRefundLineFinance } from '../src/services/order/OrderSplitFinance';
import { legacyGainIntegralState } from '../src/services/order/UnpaidOrderGainIntegralProof';

type Order = typeof storeOrder.$inferSelect;
type Cart = typeof storeOrderCartInfo.$inferSelect;
const operationId = '2a934148-6f97-4bfc-a649-fbfe12a68b61';
function fixture(gifts = ['0.80', '2.00'], quantities = [2, 1], withGift = false) {
  const rows = gifts.map((give, index) => {
    const quantity = quantities[index], price = '10.00', productId = 70 + index;
    return { id: (index + 1) * 10, oid: 9, uid: 11, cartId: String(index + 1), productId, isGift: 0,
      type: 2, relationId: 7, skuUnique: `sku-${index}`, settlePrice: '0.00',
      cartNum: quantity, refundNum: 0, splitStatus: 0, splitSurplusNum: quantity,
      writeTimes: quantity, writeSurplusTimes: quantity, writeoffTime: 0, isWriteoff: 0,
      cartInfo: JSON.stringify({ financial_version: 'checkout-line-finance-v1', id: String(index + 1), cart_num: quantity,
        sum_price: price, sum_true_price: `${quantity * 10}.00`, raw_postage_price: '0.00', postage_price: '0.00',
        coupon_price: '0.00', integral_price: '0.00', first_order_price: '0.00', use_integral: '0', integral: 0,
        one_brokerage: '0.00', two_brokerage: '0.00', division_staff_brokerage: '0.00',
        division_agent_brokerage: '0.00', division_brokerage: '0.00', costPrice: '0.00', promotions_true_price: '0.00',
        product: { id: productId, giveIntegral: give, storeName: '原购买商品' }, sku: { id: 100 + index, unique: `sku-${index}`, write_times: 1 },
        unrelated: { nested: ['unchanged', { id: index }] } }) } as Cart;
  });
  if (withGift) {
    const original = JSON.parse(rows[0].cartInfo!) as Record<string, unknown>;
    rows.push({ ...rows[0], id: 90, cartId: 'gift', productId: 99, cartNum: 1, splitSurplusNum: 1,
      writeTimes: 1, writeSurplusTimes: 1, isGift: 1,
      cartInfo: JSON.stringify({ ...original, id: 'gift', cart_num: 1, sum_price: '0.00', sum_true_price: '0.00',
        gain_integral: '0', product: { id: 99, giveIntegral: '0.00' } }) });
  }
  const originalGain = gifts.reduce((sum, give, index) => sum + Math.floor(Number(give) * quantities[index]), 0);
  const total = quantities.reduce((sum, quantity) => sum + quantity, 0);
  const order = { id: 9, uid: 11, supplierId: 7, paid: 0, status: 0, pid: 0, isDel: 0, isSystemDel: 0,
    totalNum: total + Number(withGift), totalPrice: `${total * 10}.00`, payPrice: `${total * 10}.00`, changePrice: '0.00',
    cost: '0.00', promotionsPrice: '0.00', couponPrice: '0.00', deductionPrice: '0.00', firstOrderPrice: '0.00',
    payPostage: '0.00', totalPostage: '0.00', oneBrokerage: '0.00', twoBrokerage: '0.00',
    divisionStaffBrokerage: '0.00', divisionAgentBrokerage: '0.00', divisionBrokerage: '0.00',
    useIntegral: '0.00', gainIntegral: `${originalGain}.00`, payIntegral: 0, refundPrice: '0.00', backIntegral: '0.00',
    giveIntegral: 0, giveCoupon: null, promotionsGive: null } as Order;
  return { order, rows };
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const afterRows = (rows: Cart[], plan: Awaited<ReturnType<typeof planUnpaidOrderGainIntegralEdit>>) => rows.map(row => ({
  ...row, cartInfo: plan.lines.find(line => line.rowId === row.id)!.afterCartInfo,
}));

describe('unpaid order effective gift integral editing', () => {
  it('uses immutable purchase gift weights in SQL identity order, preserves complete facts and records exact byte hashes', async () => {
    const { order, rows } = fixture(), original = structuredClone({ order, rows });
    const plan = await planUnpaidOrderGainIntegralEdit(order, [...rows].reverse(), { operationId, gainIntegral: 10 });
    expect(plan.gainIntegral).toBe('10.00');
    expect(plan.lines.map(line => [line.rowId, line.beforeGainIntegral, line.afterGainIntegral])).toEqual([[10, 1, 3], [20, 2, 7]]);
    expect(plan.evidence).toMatchObject({ version: 'supplier-unpaid-gain-edit-v1', operation_id: operationId,
      policy: UNPAID_GAIN_EDIT_POLICY, weight_basis: 'purchase-gift', before_total: 3, after_total: 10, changed: true });
    for (const [index, line] of plan.lines.entries()) {
      expect(JSON.parse(line.afterCartInfo)).toEqual({ ...JSON.parse(line.beforeCartInfo), gain_integral: String(line.afterGainIntegral) });
      expect(plan.evidence.lines[index]).toMatchObject({ row_id: line.rowId, before_sha256: hash(line.beforeCartInfo),
        after_sha256: hash(line.afterCartInfo), before_origin_hash: hash(JSON.stringify(line.beforeCartInfo)),
        after_origin_hash: hash(JSON.stringify(line.afterCartInfo)), weight: index + 1 });
      expect(plan.evidence.lines[index].before_origin_hash).not.toBe(plan.evidence.lines[index].before_sha256);
    }
    expect({ order, rows }).toEqual(original);
  });

  it('binds immutable checkout validity while accepting only the actual paid activation window', async () => {
    const {order,rows}=fixture(['0.00'],[2]);
    const info=JSON.parse(rows[0].cartInfo!);info.sku={...info.sku,write_valid:2,write_days:10,write_start:0,write_end:0};
    const row={...rows[0],productType:4,writeStart:0,writeEnd:0,cartInfo:JSON.stringify(info)};
    const initial=await legacyGainIntegralState({...order,payTime:0},[row]),paid={...order,paid:1,payTime:1_800_000_000};
    expect((await legacyGainIntegralState(paid,[{...row,writeStart:paid.payTime,writeEnd:paid.payTime+10*86400}])).hash).toBe(initial.hash);
    await expect(legacyGainIntegralState(paid,[{...row,writeStart:paid.payTime+1,writeEnd:paid.payTime+10*86400}])).rejects.toThrow();
    await expect(legacyGainIntegralState({...order,payTime:0},[{...row,writeStart:paid.payTime,writeEnd:paid.payTime+10*86400}])).rejects.toThrow();
  });

  it('does not make repeated edits path dependent or overwrite original per-unit purchase gifts', async () => {
    const { order, rows } = fixture();
    const first = await planUnpaidOrderGainIntegralEdit(order, rows, { operationId, gainIntegral: 10 });
    const second = await planUnpaidOrderGainIntegralEdit({ ...order, gainIntegral: first.gainIntegral }, afterRows(rows, first),
      { operationId: 'de1d1a53-bdef-470d-8d48-3c8acc05b15a', gainIntegral: 7 });
    const direct = await planUnpaidOrderGainIntegralEdit(order, rows, { operationId, gainIntegral: 7 });
    expect(second.lines.map(line => line.afterCartInfo)).toEqual(direct.lines.map(line => line.afterCartInfo));
    expect(second.lines.map(line => JSON.parse(line.afterCartInfo).product.giveIntegral)).toEqual(['0.80', '2.00']);
  });

  it('keeps a no-op byte-identical rather than materializing or normalizing purchase JSON', async () => {
    const { order, rows } = fixture();
    const plan = await planUnpaidOrderGainIntegralEdit(order, rows, { operationId, gainIntegral: 3 });
    expect(plan.evidence.changed).toBe(false);
    expect(plan.lines.every(line => line.afterCartInfo === line.beforeCartInfo)).toBe(true);
    expect(plan.evidence.lines.every(line => line.before_sha256 === line.after_sha256)).toBe(true);
  });

  it('allocates a newly positive gift by purchased quantities only and never assigns any to a promotional gift row', async () => {
    const { order, rows } = fixture(['0.00', '0.00'], [2, 1], true);
    const plan = await planUnpaidOrderGainIntegralEdit(order, rows, { operationId, gainIntegral: 5 });
    expect(plan.evidence.weight_basis).toBe('quantity');
    expect(plan.lines.map(line => line.afterGainIntegral)).toEqual([3, 2, 0]);
    expect(plan.evidence.lines.map(line => line.weight)).toEqual([2, 1, 0]);
  });

  it.each([0, 9_999_999_999])('conserves admitted integer boundary %s without floating point loss', async gainIntegral => {
    const { order, rows } = fixture(['0.00', '0.00'], [7, 3]);
    const plan = await planUnpaidOrderGainIntegralEdit(order, rows, { operationId, gainIntegral });
    expect(plan.lines.reduce((sum, line) => sum + line.afterGainIntegral, 0)).toBe(gainIntegral);
    expect(plan.lines.every(line => Number.isSafeInteger(line.afterGainIntegral))).toBe(true);
  });

  it('feeds the same edited gift and cash concession into quantity split, refund quotation and earned-income fractions', async () => {
    const { order, rows } = fixture(['0.80'], [7]);
    const plan = await planUnpaidOrderGainIntegralEdit(order, rows, { operationId, gainIntegral: 11 });
    const current = { ...order, gainIntegral: plan.gainIntegral, payPrice: '31.25', changePrice: '38.75' };
    const edited = afterRows(rows, plan), selected = new Map([['1', 3]]);
    const split = planOrderFinancialSplit(current, edited, selected)!;
    expect(split.selected).toMatchObject({ gainIntegral: '4.00' });
    expect(split.remaining).toMatchObject({ gainIntegral: '7.00' });
    expect(quoteOrderRefundLineFinance(current, edited, [], selected)).toBe(split.selected.payPrice);
    expect(planCompletedRefundLineCompensation(current, edited, [])?.productIntegral).toEqual({ total: 11, refunded: 0 });
    expect(JSON.parse(split.carts.get('1')!.selected!).product.giveIntegral).toBe('0.80');
    expect(Number(split.selected.payPrice) + Number(split.remaining.payPrice)).toBe(31.25);
  });

  it.each([-1, 0.5, 10_000_000_000, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid target %s without changing facts', async gainIntegral => {
    const { order, rows } = fixture(), before = structuredClone({ order, rows });
    await expect(planUnpaidOrderGainIntegralEdit(order, rows, { operationId, gainIntegral })).rejects.toThrow('赠送积分');
    expect({ order, rows }).toEqual(before);
  });

  it.each(['missing-money', 'wrong-root-gain', 'unknown-version', 'mixed-version', 'duplicate-row', 'gift-positive', 'oversized'])
    ('fails closed on %s instead of downgrading modern finance', async kind => {
      const { order, rows } = fixture(['0.80', '2.00'], [2, 1], true);
      const info: Record<string, unknown> = JSON.parse(rows[0].cartInfo!);
      if (kind === 'missing-money') delete info.sum_true_price;
      if (kind === 'wrong-root-gain') order.gainIntegral = '9.00';
      if (kind === 'unknown-version') info.financial_version = 'future';
      if (kind === 'mixed-version') delete info.financial_version;
      if (kind === 'duplicate-row') rows[1].id = rows[0].id;
      if (kind === 'gift-positive') {
        const gift = JSON.parse(rows[2].cartInfo!); gift.gain_integral = '1'; rows[2].cartInfo = JSON.stringify(gift);
      }
      if (kind === 'oversized') info.extra = 'x'.repeat(65_536);
      rows[0].cartInfo = JSON.stringify(info);
      await expect(planUnpaidOrderGainIntegralEdit(order, rows, { operationId, gainIntegral: 10 })).rejects.toThrow();
    });

  it.each([{ paid: 1 }, { pid: 2 }, { status: 1 }, { isDel: 1 }, { isSystemDel: 1 }])('rejects an ineligible order %j', async patch => {
    const { order, rows } = fixture();
    await expect(planUnpaidOrderGainIntegralEdit({ ...order, ...patch }, rows, { operationId, gainIntegral: 10 })).rejects.toThrow();
  });

  it('does not promote incomplete versionless evidence or accept a non-v4 operation identity', async () => {
    const { order, rows } = fixture();
    rows[0].cartInfo = JSON.stringify({ product: { giveIntegral: '0.80' }, sku: { write_times: 1 } });
    await expect(planUnpaidOrderGainIntegralEdit(order, rows, { operationId, gainIntegral: 10 })).rejects.toThrow();
    await expect(planUnpaidOrderGainIntegralEdit(order, fixture().rows, { operationId: 'unknown', gainIntegral: 10 })).rejects.toThrow();
  });

  it('edits a fully reconciled original PHP source without labelling raw purchase facts as checkout', async () => {
    const { order, rows } = fixture();
    for (const row of rows) {
      const info = JSON.parse(row.cartInfo!), product = info.product, sku = info.sku;
      delete info.financial_version; delete info.product; delete info.sku;
      info.productInfo = { id: row.productId, store_name: product.storeName, give_integral: product.giveIntegral, attrInfo: sku };
      row.cartInfo = JSON.stringify(info);
    }
    expect(planOrderFinancialSplit(order, rows, new Map(rows.map(row => [row.cartId, row.cartNum])))?.legacyPhpProjection).toBe('original-purchase');
    const plan = await planUnpaidOrderGainIntegralEdit(order, rows, { operationId, gainIntegral: 10 });
    expect(plan.evidence.source_format).toBe('legacy-php');
    expect(plan.lines.map(line => line.afterGainIntegral)).toEqual([3, 7]);
    for (const line of plan.lines) {
      expect(JSON.parse(line.afterCartInfo)).toEqual({ ...JSON.parse(line.beforeCartInfo), gain_integral: String(line.afterGainIntegral),
        unpaid_gain_integral_edit: { version: 'supplier-unpaid-gain-edit-v1', operation_id: operationId } });
      expect(JSON.parse(line.afterCartInfo)).not.toHaveProperty('financial_version');
    }
    // A valid-looking operation marker in JSON is NOT the durable SQL proof.
    expect(() => planOrderFinancialSplit({ ...order, gainIntegral: plan.gainIntegral }, afterRows(rows, plan),
      new Map(rows.map(row => [row.cartId, row.cartNum])))).toThrow('受保护来源');
  });
});
