import { describe, expect, it } from 'vitest';
import { supplierProductEnsureIds, supplierProductEnsureInput, supplierProductEnsureStored } from '@/services/supplier/SupplierProductEnsureBindings';

describe('Supplier complete assurance selection input and bounded historical projection', () => {
  it('distinguishes omission from explicit clear and detaches caller arrays', () => {
    expect(supplierProductEnsureInput({})).toBeUndefined();
    expect(supplierProductEnsureInput({ ensure_id: undefined })).toBeUndefined();
    expect(supplierProductEnsureInput({ ensure_id: [] })).toEqual([]);
    const input = [201, 202], copy = supplierProductEnsureIds(input); input.push(41); expect(copy).toEqual([201, 202]);
  });
  it.each([{ input: [201, 202] }, { input: ['201', '202'] }, { input: [201, '202'] }])('normalizes the actual numeric or PHP string IDs $input', ({ input }) => {
    expect(supplierProductEnsureIds(input)).toEqual([201, 202]);
  });
  it('allows two hundred IDs without applying the unrelated brand CSV width', () => {
    const ids = Array.from({ length: 200 }, (_, index) => 2147483647 - index);
    expect(supplierProductEnsureIds(ids)).toEqual(ids); expect(ids.join(',').length).toBeGreaterThan(64);
    expect(supplierProductEnsureStored(ids.join(','))).toMatchObject({ ids, parsed: true, truncated: false });
  });
  it.each([
    { value: null }, { value: false }, { value: '' }, { value: '201,202' }, { value: 201 }, { value: {} },
    { value: [0] }, { value: [-1] }, { value: [1.5] }, { value: [2147483648] }, { value: ['01'] },
    { value: [' 201'] }, { value: ['201 '] }, { value: ['+201'] }, { value: ['2e2'] }, { value: ['201.0'] },
    { value: [''] }, { value: ['2147483648'] }, { value: [true] }, { value: [null] },
    { value: [201, 201] }, { value: [201, '201'] }, { value: Array.from({ length: 201 }, (_, index) => index + 1) },
  ])('rejects malformed or duplicate normalized IDs $value', ({ value }) => expect(() => supplierProductEnsureIds(value)).toThrow());
  it.each([{ raw: null }, { raw: '' }])('preserves the actual empty historical raw $raw', ({ raw }) => {
    expect(supplierProductEnsureStored(raw)).toEqual({ ids: [], raw, parsed: true, truncated: false });
  });
  it.each([{ raw: '201,201' }, { raw: '01,202' }, { raw: '201,,202' }, { raw: '2147483648' }, { raw: 'foreign,private' }])('keeps malformed historical $raw readable without inventing IDs', ({ raw }) => {
    expect(supplierProductEnsureStored(raw)).toEqual({ ids: [], raw, parsed: false, truncated: false });
  });
  it('bounds a long supplementary-plane history by codepoints without cutting a Unicode character', () => {
    const raw = '😀'.repeat(5000), value = supplierProductEnsureStored(raw);
    expect(value).toEqual({ ids: [], raw: '😀'.repeat(4096), parsed: false, truncated: true });
    expect([...value.raw!]).toHaveLength(4096);
    expect(supplierProductEnsureStored('x'.repeat(4096))).toMatchObject({ raw: 'x'.repeat(4096), truncated: false });
  });
});
