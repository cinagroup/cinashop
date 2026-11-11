import { describe, expect, it } from 'vitest';
import { normalizeOutPhysicalProductInput } from '../src/services/out/OutProductService';
import { outProductCustomFormInput, outProductSystemFormInput } from '../src/services/out/OutProductFormBindings';
import { outRequestHash } from '../src/services/out/OutIdempotency';
const product = { product_type: 0, supplier_id: 0, cate_id: [10], store_name: '表单商品', slider_image: ['/test.png'],
  delivery_type: [1], freight: 1, spec_type: 0, attrs: [{ suk: '默认', price: '10.00', stock: 8, bar_code: 'FORM-1' }] };
describe('Out product form intents', () => {
  it('separately binds omission, explicit clear, snapshot and active template into replay hashes', async () => {
    const omitted = normalizeOutPhysicalProductInput(product);
    expect(omitted).not.toHaveProperty('customForm'); expect(omitted).not.toHaveProperty('systemFormId');
    expect(normalizeOutPhysicalProductInput({ ...product, custom_form: undefined, system_form_id: undefined })).toEqual(omitted);
    const cleared = normalizeOutPhysicalProductInput({ ...product, custom_form: [], system_form_id: 0 });
    expect(cleared).toMatchObject({ customForm: '', systemFormId: 0 });
    expect(await outRequestHash(cleared)).not.toBe(await outRequestHash(omitted));
    expect(await outRequestHash(normalizeOutPhysicalProductInput({ ...product, custom_form: [] })))
      .not.toBe(await outRequestHash(normalizeOutPhysicalProductInput({ ...product, system_form_id: 0 })));
    const input = normalizeOutPhysicalProductInput({ ...product, custom_form: [{ z: 1.5, a: { y: 2, x: true } }], system_form_id: '401' });
    expect(input).toMatchObject({ customForm: '[{"a":{"x":true,"y":2},"z":1.5}]', systemFormId: 401 });
    expect(input).toEqual(normalizeOutPhysicalProductInput({ ...product, custom_form: [{ a: { x: true, y: 2 }, z: 1.5 }], system_form_id: 401 }));
    expect(await outRequestHash(input)).not.toBe(await outRequestHash(cleared));
  });
  it.each([null, '', false, 5, Array(101).fill({}), { x: NaN }, { x: undefined }, { x: 'x'.repeat(262145) }, JSON.parse('{"__proto__":1}')])
    ('rejects unsafe or over-capacity legacy form input', value => expect(() => outProductCustomFormInput({ custom_form: value })).toThrow('表单'));
  it('limits nesting and accepts an explicit empty object as clear', () => {
    let deep: unknown = 'leaf'; for (let i = 0; i < 26; i++) deep = { child: deep };
    expect(() => outProductCustomFormInput({ custom_form: deep })).toThrow('层级');
    expect(outProductCustomFormInput({ custom_form: {} })).toBe('');
  });
  it.each([null, false, -1, -0, '0401', 1.2, 2147483648, '401e0', {}])
    ('rejects invalid system template ID %j', value => expect(() => outProductSystemFormInput({ system_form_id: value })).toThrow('表单'));
});
