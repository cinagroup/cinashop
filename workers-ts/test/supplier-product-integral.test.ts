import { describe, expect, it } from 'vitest';
import { supplierProductIntegralInput } from '@/services/supplier/SupplierProductIntegral';
import { calculateProductIntegralSnapshot } from '@/services/order/OrderRewardService';
import { productIntegralEditor, productIntegralPayload } from '../../view/supplier-ts/src/utils/productIntegral';

describe('Supplier product integral author and explicit editor intent', () => {
  it('distinguishes an omitted or undefined field from explicit zero', () => {
    expect(supplierProductIntegralInput({})).toBeUndefined();
    expect(supplierProductIntegralInput({ give_integral: undefined })).toBeUndefined();
    expect(supplierProductIntegralInput(Object.create({ give_integral: 9 }))).toBeUndefined();
    expect(supplierProductIntegralInput({ give_integral: 0 })).toBe('0.00');
  });
  it.each([[2.75, '2.75'], [' 00002.7 ', '2.70'], ['9999999999.99', '9999999999.99'], ['000', '0.00']])
  ('normalizes schema-bounded decimal %j without rounding', (value, expected) => {
    expect(supplierProductIntegralInput({ give_integral: value })).toBe(expected);
  });
  it.each([null, false, true, [], {}, '', ' ', -1, '-0.00', '1.001', '1e3', '1,000', '10000000000', Infinity, NaN])
  ('rejects invalid or lossy explicit input %j', value => expect(() => supplierProductIntegralInput({ give_integral: value })).toThrow('赠送积分'));
  it('keeps fractional points until the actual per-line quantity snapshot', () => {
    const giveIntegral = supplierProductIntegralInput({ give_integral: '2.75' })!;
    expect(calculateProductIntegralSnapshot([{ giveIntegral, quantity: 3 }])).toBe(8);
    expect(calculateProductIntegralSnapshot([{ giveIntegral, quantity: 1 }, { giveIntegral, quantity: 2 }])).toBe(7);
  });
  it('reads versioned state without resending it, emits a deliberate decimal or clear', () => {
    const editor = productIntegralEditor({ version: 1, give_integral: '2.75' });
    expect(editor).toEqual({ ready: true, changed: false, value: '2.75' });
    expect(productIntegralPayload(editor)).toEqual({});
    expect(productIntegralPayload({ ...editor, changed: true, value: '0003.5' })).toEqual({ give_integral: '3.50' });
    expect(productIntegralPayload({ ...editor, changed: true, value: '0' })).toEqual({ give_integral: '0.00' });
    expect(() => productIntegralPayload({ ...editor, changed: true, value: '1.234' })).toThrow('赠送积分');
  });
  it('keeps old unknown state inert and new products explicitly editable', () => {
    const editor = productIntegralEditor();
    expect(editor.ready).toBe(false);
    expect(productIntegralPayload({ ...editor, changed: true, value: '7' })).toEqual({});
    expect(productIntegralEditor(undefined, true)).toEqual({ ready: true, changed: false, value: '0.00' });
  });
  it.each([null, [], {}, { version: 2, give_integral: '1' }, { version: 1, give_integral: 1 },
    { version: 1, give_integral: '1', extra: true }, { version: 1, give_integral: '1.234' }])
  ('rejects a corrupt read contract %j', value => expect(() => productIntegralEditor(value)).toThrow());
});
