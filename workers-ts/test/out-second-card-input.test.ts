import { describe, expect, it } from 'vitest';
import { normalizeOutPhysicalProductInput, normalizeOutProductInput } from '@/services/out/OutProductService';
import { outRequestHash } from '@/services/out/OutIdempotency';

const input = { product_type: 4, cate_id: [9], store_name: '次卡', slider_image: ['/card.png'], spec_type: 0,
  attrs: [{ price: '10.00', stock: 5, bar_code: 'CARD', write_times: 3, write_valid: 1 }] };
const withRule = (rule: Record<string, unknown>) => ({ ...input, attrs: [{ ...input.attrs[0], ...rule }] });

describe('Out second-card editor input', () => {
  it('normalizes all three validity modes and Shanghai date-only and datetime editor values', () => {
    expect(normalizeOutProductInput(input)).toMatchObject({ productType: 4, deliveryType: '2', freight: 1, postage: '0.00', tempId: 0, isPostage: 0,
      skus: [{ writeTimes: 3, writeValid: 1, writeDays: 0, writeStart: 0, writeEnd: 0 }] });
    expect(normalizeOutProductInput(withRule({ write_valid: 2, days: 30 })).skus[0]).toMatchObject({ writeValid: 2, writeDays: 30, writeStart: 0, writeEnd: 0 });
    expect(normalizeOutProductInput(withRule({ write_valid: 3, section_time: ['2030-01-01', '2030-01-02 12:00:00'] })).skus[0])
      .toMatchObject({ writeValid: 3, writeDays: 0, writeStart: 1893427200, writeEnd: 1893556800 });
  });
  it('binds each rule into the idempotency hash and normalizes equivalent aliases', async () => {
    const a = normalizeOutProductInput(withRule({ write_valid: 2, days: 30 }));
    const b = normalizeOutProductInput(withRule({ write_valid: 2, write_days: 30 }));
    expect(a).toEqual(b);
    expect(await outRequestHash(a)).not.toBe(await outRequestHash(normalizeOutProductInput(withRule({ write_valid: 2, days: 31 }))));
  });
  it.each([
    { write_times: 0 }, { write_times: 100_000_000 }, { write_valid: 0 }, { write_valid: 2, days: 0 },
    { write_valid: 2, days: 3651 }, { write_valid: 2, days: 2, write_days: 3 },
    { write_valid: 3, section_time: ['2030-02-30', '2030-03-02'] },
    { write_valid: 3, section_time: ['2030-01-02', '2030-01-01'] },
    { write_valid: 3, section_time: ['2030-01-01'] },
    { write_valid: 3, section_time: ['2030-01-01', '2030-01-02'], write_start: 1 },
    { virtual_list: [{ card_no: 'not-supported' }] }, { disk_info: 'not-supported' },
  ])('rejects invalid or ambiguous rule %j', rule => expect(() => normalizeOutProductInput(withRule(rule))).toThrow());
  it('rejects multiple specs, presale and physical-only access', () => {
    expect(() => normalizeOutProductInput({ ...input, spec_type: 1 })).toThrow();
    expect(() => normalizeOutProductInput({ ...input, is_presale_product: 1 })).toThrow();
    expect(() => normalizeOutPhysicalProductInput(input)).toThrow();
  });
});
