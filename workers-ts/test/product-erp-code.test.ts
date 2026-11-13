import { describe, expect, it } from 'vitest';
import { checkedProductCode, productCodeInput, productErpCodePresent } from '@/services/product/ProductCodeInput';

describe('Product code author intent and PHP physical ERP emptiness', () => {
  it('preserves omitted and inherited fields and distinguishes explicit clear', () => {
    for (const raw of [{}, { code: undefined }, Object.create({ code: 'inherited' }), { spu: 'SPU', bar_code: 'BAR', attrs: [{ code: 'SKU' }] }])
      expect(productCodeInput(raw)).toBeUndefined();
    expect(productCodeInput({ code: '' })).toBe('');
    expect(productCodeInput({ code: ' ERP-001 ' })).toBe('ERP-001');
    expect(productCodeInput({ code: '0' })).toBe('0');
  });
  it('fits fifty Unicode codepoints and rejects fifty one', () => {
    expect(checkedProductCode('码🛍'.repeat(25))).toBe('码🛍'.repeat(25));
    expect(() => checkedProductCode('码🛍'.repeat(25) + 'x')).toThrow('50');
  });
  it.each([null, 1, false, {}, [], '\nERP', 'ERP\t', '\u0000', '\ud800', '\udfff'])('rejects malformed authored code %j', code => {
    expect(() => productCodeInput({ code })).toThrow();
  });
  it.each(['', ' ', '0', ' 0 '])('requires a nonempty nonzero ERP code %j', code => expect(productErpCodePresent(code)).toBe(false));
  it.each(['00', '0.0', 'SKU-0', '编码', '🛍'])('retains meaningful ERP codes %j', code => expect(productErpCodePresent(code)).toBe(true));
});
