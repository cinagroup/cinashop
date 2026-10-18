import { describe, expect, it } from 'vitest';
import { supplierProductSystemFormInput } from '@/services/supplier/SupplierProductSystemFormBindings';

describe('Supplier ordinary product system form author intent', () => {
  it('omits absent undefined and inherited fields without inventing a clear', () => {
    expect(supplierProductSystemFormInput({})).toBeUndefined();
    expect(supplierProductSystemFormInput({ system_form_id: undefined })).toBeUndefined();
    expect(supplierProductSystemFormInput(Object.create({ system_form_id: 71 }))).toBeUndefined();
  });
  it.each([0, '0', 1, '1', 2147483647, '2147483647'])('accepts canonical int4 author value %j', value => {
    expect(supplierProductSystemFormInput({ system_form_id: value })).toBe(Number(value));
  });
  it.each([null, '', ' ', true, false, -0, '-0', -1, '-1', 1.5, '1.5', '+1', '01', ' 1', '1 ', '1e2', '0x10', 2147483648, '2147483648', NaN, Infinity, [], {}, [71]])('rejects noncanonical form ID %j', value => {
    expect(() => supplierProductSystemFormInput({ system_form_id: value })).toThrow('自定义留言表单ID');
  });
  it('does not interpret client answer/configuration fields as ordinary author authority', () => {
    expect(supplierProductSystemFormInput({ custom_form: [{ name: 'texts', value: '客户秘密' }], system_form_data: [{ uid: 11 }], systemFormId: 77 })).toBeUndefined();
    expect(supplierProductSystemFormInput({ system_form_id: '71', custom_form: [{ name: 'texts', value: '客户秘密' }] })).toBe(71);
  });
});
