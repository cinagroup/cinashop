import { describe, expect, it } from 'vitest';
import { allocateRefundLineTotal, allocateRefundSplitPayment, partitionRefundCartSnapshot, partitionRefundWriteoff,
  refundSplitDisposition, REFUND_SPLIT_LINE_FIELDS } from '../src/services/order/RefundSplitAllocation';
import cases from './fixtures/refund-split-bcmath.json';
import paymentCases from './fixtures/refund-split-payment.json';

describe('refund cart amount allocation, PHP BCMath contract', () => {
  it.each(cases)('$name', row => {
    if (row.scale !== 0 && row.scale !== 2) throw Error('Invalid fixture scale');
    expect(allocateRefundLineTotal(row.total, row.quantity, row.selectedQuantity, row.scale))
      .toEqual({ selected: row.selected, remaining: row.remaining });
  });

  it.each(REFUND_SPLIT_LINE_FIELDS)('partitions the actual %s snapshot field', field => {
    const source = JSON.stringify({ id: '501', cart_num: 6, [field]: '1.00',
      sku: { price: '9.99', unique: 'unchanged' }, bargainParticipation: { version: 1, participantId: 77 } });
    const result = partitionRefundCartSnapshot(source, 6, 3, false);
    const selected = JSON.parse(result.selected!), remaining = JSON.parse(result.remaining!);
    expect(selected[field]).toBe(field === 'use_integral' ? '0' : '0.49');
    expect(remaining[field]).toBe(field === 'use_integral' ? '1' : '0.51');
    expect(selected).toMatchObject({ id: '501', cart_num: 3, sku: { price: '9.99', unique: 'unchanged' },
      bargainParticipation: { version: 1, participantId: 77 } });
    selected.sku.price = '1.00';
    expect(remaining.sku.price).toBe('9.99');
    expect(JSON.parse(source).sku.price).toBe('9.99');
    expect(result.missingFields).toEqual(REFUND_SPLIT_LINE_FIELDS.filter(key => key !== field));
  });

  it('retains residues across repeated splits rather than recalculating from the original line', () => {
    const first = partitionRefundCartSnapshot('{"cart_num":6,"sum_true_price":"1.00"}', 6, 3, false);
    const second = partitionRefundCartSnapshot(first.remaining!, 3, 1, false);
    expect(JSON.parse(first.selected!).sum_true_price).toBe('0.49');
    expect(JSON.parse(second.selected!).sum_true_price).toBe('0.17');
    expect(JSON.parse(second.remaining!).sum_true_price).toBe('0.34');
  });

  it('preserves whole-line amounts and gives no allocation to an empty side', () => {
    const source = '{"cart_num":3,"sum_true_price":"10.1234","use_integral":7}';
    expect(partitionRefundCartSnapshot(source, 3, 3, false)).toMatchObject({ remaining: null });
    expect(JSON.parse(partitionRefundCartSnapshot(source, 3, 3, false).selected!))
      .toEqual(JSON.parse(source));
    expect(partitionRefundCartSnapshot(source, 3, 0, false)).toMatchObject({ selected: null });
    expect(JSON.parse(partitionRefundCartSnapshot(source, 3, 0, false).remaining!))
      .toEqual(JSON.parse(source));
    expect(allocateRefundLineTotal('1.00', 6, 6)).toEqual({ selected: '1.00', remaining: '0.00' });
    expect(allocateRefundLineTotal('1.00', 6, 0)).toEqual({ selected: '0.00', remaining: '1.00' });
  });

  it('zeroes gift line allocations only on partial lines, matching PHP', () => {
    const source = JSON.stringify({ cart_num: 2, sum_true_price: '12.00', use_integral: '10' });
    const part = partitionRefundCartSnapshot(source, 2, 1, true);
    for (const output of [part.selected, part.remaining]) {
      const snapshot = JSON.parse(output!);
      for (const field of REFUND_SPLIT_LINE_FIELDS) expect(snapshot[field]).toBe(0);
    }
    expect(JSON.parse(partitionRefundCartSnapshot(source, 2, 2, true).selected!).sum_true_price).toBe('12.00');
  });

  it('does not pretend absent modern checkout fields are authoritative zero amounts', () => {
    const source = JSON.stringify({ sum_true_price: '10.00', coupon_price: '1.00',
      integral_price: '2.00', first_order_price: '0.00', sku: { price: '6.50' } });
    const result = partitionRefundCartSnapshot(source, 2, 1, false);
    expect(JSON.parse(result.selected!)).toMatchObject({ cart_num: 1, sum_true_price: '5.00' });
    expect(result.missingFields).toContain('postage_price');
    expect(result.missingFields).toContain('one_brokerage');
    expect(result.missingFields).toContain('use_integral');
    expect(result.missingFields).not.toContain('sum_true_price');
  });

  it.each([null, true, false, '', ' 1.00', '1.00 ', '-0.01', '1e3', 'NaN', Infinity,
    '10000000000', '0.000000001', {}, []].map(value => ({ value })))('rejects malformed or unbounded monetary evidence: $value', ({ value }) => {
    expect(() => allocateRefundLineTotal(value, 3, 1)).toThrow('快照不一致');
    // JSON null denotes missing evidence; JSON.stringify also turns Infinity
    // into null. Those remain explicitly reported as missing, not valid money.
    if (value === null || value === Infinity) {
      expect(partitionRefundCartSnapshot(JSON.stringify({ coupon_price: value }), 3, 1, false).missingFields)
        .toContain('coupon_price');
    } else {
      expect(() => partitionRefundCartSnapshot(JSON.stringify({ coupon_price: value }), 3, 1, false))
        .toThrow('快照不一致');
    }
  });

  it.each([[0, 0], [3, -1], [3, 4], [3, 1.5], [2147483648, 1], [NaN, 1]])
    ('rejects quantity bounds %j/%j', (total, selected) => {
      expect(() => allocateRefundLineTotal('1.00', total, selected)).toThrow('快照不一致');
      expect(() => partitionRefundCartSnapshot('{}', total, selected, false)).toThrow('快照不一致');
    });

  it.each(['null', '[]', '"string"', '{', '{"cart_num":2}', '{"cart_num":"03"}',
    JSON.stringify({ payload: 'x'.repeat(65536) })])('rejects malformed snapshot or conflicting row quantity', source => {
      expect(() => partitionRefundCartSnapshot(source, 3, 1, false)).toThrow('快照不一致');
    });

  it('accepts the exact legacy BCMath quantity string but no alternate numeric spelling', () => {
    expect(JSON.parse(partitionRefundCartSnapshot('{"cart_num":"3"}', 3, 1, false).selected!).cart_num).toBe(1);
  });
});

describe('refund split manual-price allocation', () => {
  it.each(paymentCases)('preserves payment $actual from raw $raw and selected raw $selectedRaw', row => {
    expect(allocateRefundSplitPayment(row.actual, row.raw, row.selectedRaw))
      .toEqual({ selected: row.selected, remaining: row.remaining });
  });
  it.each([
    ['1.00', '0.00', '0.00'], ['1.00', '2.00', '3.00'], ['-1.00', '2.00', '1.00'],
    ['1.001', '2.00', '1.00'], ['1.00', '2.001', '1.00'], ['1.00', '2.00', '1.001'],
  ])('rejects inconsistent or non-cent payment evidence %s/%s/%s', (actual, raw, selected) => {
    expect(() => allocateRefundSplitPayment(actual, raw, selected)).toThrow('快照不一致');
  });
});

describe('refund split write-off entitlements', () => {
  it('assigns unredeemed entitlement to the selected child before the remainder', () => {
    expect(partitionRefundWriteoff({ cartNum: 3, writeTimes: 12, writeSurplusTimes: 5,
      writeoffTime: 1234, isWriteoff: 0 }, 1, 4)).toEqual({
      selected: { cartNum: 1, writeTimes: 4, writeSurplusTimes: 4, writeoffTime: 0, isWriteoff: 0 },
      remaining: { cartNum: 2, writeTimes: 8, writeSurplusTimes: 1, writeoffTime: 1234, isWriteoff: 0 },
    });
  });

  it('handles both empty sides and conserves every entitlement over exhaustive small counters', () => {
    for (let count = 1; count <= 7; count++) for (let unit = 1; unit <= 5; unit++) {
      for (let used = 0; used <= count * unit; used++) for (let selected = 0; selected <= count; selected++) {
        const result = partitionRefundWriteoff({ cartNum: count, writeTimes: count * unit,
          writeSurplusTimes: count * unit - used, writeoffTime: used ? 1234 : 0,
          isWriteoff: used === count * unit ? 1 : 0 }, selected, unit);
        const parts = [result.selected, result.remaining].filter(part => part !== null);
        expect(parts.reduce((sum, part) => sum + part.cartNum, 0)).toBe(count);
        expect(parts.reduce((sum, part) => sum + part.writeTimes, 0)).toBe(count * unit);
        expect(parts.reduce((sum, part) => sum + part.writeSurplusTimes, 0)).toBe(count * unit - used);
        for (const part of parts) {
          expect(part.writeSurplusTimes).toBeGreaterThanOrEqual(0);
          expect(part.writeSurplusTimes).toBeLessThanOrEqual(part.writeTimes);
          expect(part.isWriteoff).toBe(part.writeSurplusTimes === 0 ? 1 : 0);
          expect(part.writeoffTime).toBe(part.writeSurplusTimes === part.writeTimes ? 0 : 1234);
        }
      }
    }
  });

  it.each([
    { writeTimes: 7 }, { writeSurplusTimes: 9 }, { writeSurplusTimes: -1 },
    { writeoffTime: 0 }, { isWriteoff: 1 }, { cartNum: 0 }, { isWriteoff: 2 },
  ])('rejects contradictory source counters %j', change => {
    expect(() => partitionRefundWriteoff({ cartNum: 2, writeTimes: 8, writeSurplusTimes: 3,
      writeoffTime: 1234, isWriteoff: 0, ...change }, 1, 4)).toThrow('快照不一致');
  });
});

describe('refund split whole-order and gift decisions', () => {
  const rows = [{ cartId: '501', cartNum: 2, isGift: 0 }, { cartId: '502', cartNum: 1, isGift: 1 }];
  it('returns whole-order only when every row is entirely selected', () => {
    expect(refundSplitDisposition(0, rows, rows)).toBe('whole-order');
  });
  it('keeps PHP unshipped gift-only remainder separate from ordinary whole-order selection', () => {
    expect(refundSplitDisposition(0, rows, [rows[0]])).toBe('whole-order-gift-remainder');
    expect(refundSplitDisposition(1, rows, [rows[0]])).toBe('split');
    expect(refundSplitDisposition(0, rows, [{ cartId: '501', cartNum: 1 }])).toBe('split');
  });
  it.each([[], [{ cartId: 'unknown', cartNum: 1 }], [{ cartId: '501', cartNum: 3 }],
    [{ cartId: '501', cartNum: 0 }], [rows[0], rows[0]]].map(selected => ({ selected })))('rejects an invalid selector $selected', ({ selected }) => {
      expect(() => refundSplitDisposition(0, rows, selected)).toThrow('快照不一致');
    });
  it('rejects duplicate source identities and unknown status instead of choosing a branch', () => {
    expect(() => refundSplitDisposition(0, [rows[0], rows[0]], [rows[0]])).toThrow('快照不一致');
    expect(() => refundSplitDisposition(-1, rows, rows)).toThrow('快照不一致');
  });
});
