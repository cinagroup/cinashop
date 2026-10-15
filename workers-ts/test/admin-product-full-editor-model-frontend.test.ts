import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalProductImage, detailIdentity, fromEditorDraft, fromLegacyDetail, makeEditorDraft, mergeGeneratedSkus, newEditorSku, newProductEditor, parseEditorRoute, parsePendingProductSave, parseProductReceipt, PRODUCT_EDITOR_FIELDS, toLegacySave, validateProductSave } from '../../view/admin-ts/src/pages/product/productEditorModel';

const operation = { operation_id: '9d2a99ec-3798-4fbc-822f-33143bdb70e8', actor_id: 20, requested_id: 19 };
function model() { const value = newProductEditor(); value.store_name = '完整商品'; value.cate_id = [11, 12]; value.brand_id = [21, 22]; value.slider_image = ['/api/assets/31']; value.attrs[0]!.price = 12; value.attrs[0]!.stock = 5; return value; }
function detail(value = model()) { const product = toLegacySave(value); return { productInfo: { ...product, type: 2, relation_id: 500, supplier_id: 500,
  cate_id: product.cate_id.map(String), attr: { ...product.attrs[0], id: 190, unique: 'sku19001', suk: '默认', virtual_available: 3, virtual_total: 7 }, attrs: product.attrs,
  label_id: [{ id: 71, label_name: '购买者标签' }], store_label_id: [{ id: 31, label_name: '商品标签' }], coupons: [{ id: 81, title: '赠券' }],
  recommend_list: [{ product_id: '25', image: '/api/assets/32' }], custom_form: [{ template: 'current' }] },
  tempList: [{ id: 101, name: '历史运费' }], cateList: [], editor: { stored_custom_form: [{ stored: true }], description_preview: '<p>已清理</p>', retired_attrs: [] } }; }

describe('full Admin product editor field projection', () => {
  it('covers all 59 actual backend fields exactly and excludes owner/read-only/import context', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/services/admin/AdminLegacyProductInput.ts'), 'utf8');
    const fields = [...source.match(/ADMIN_LEGACY_PRODUCT_FIELDS = \[([\s\S]*?)\] as const/)![1]!.matchAll(/'([^']+)'/g)].map(row => row[1]);
    expect(PRODUCT_EDITOR_FIELDS).toHaveLength(59); expect([...PRODUCT_EDITOR_FIELDS].sort()).toEqual(fields.sort());
    const state = fromLegacyDetail(detail()), payload = toLegacySave(state.model);
    expect(Object.keys(payload).sort()).toEqual([...PRODUCT_EDITOR_FIELDS].sort());
    expect(state.owner).toEqual({ type: 2, relation_id: 500, supplier_id: 500 });
    expect(payload.type).toBe(0); expect(payload.soure_link).toBe(''); expect(payload.tao_words).toBe('');
    expect(payload).not.toHaveProperty('relation_id'); expect(payload).not.toHaveProperty('description_preview'); expect(payload.attrs[0]).not.toHaveProperty('id');
    expect(payload.attrs[0]?.unique).toBe('sku19001'); expect(payload.attrs[0]).not.toHaveProperty('suk');
  });
  it('roundtrips multiple categories/brands, selected associations and the actual stored form snapshot', () => {
    const state = fromLegacyDetail(detail()); expect(state.model.cate_id).toEqual([11, 12]); expect(state.model.brand_id).toEqual([21, 22]);
    expect(state.model.label_id).toEqual([71]); expect(state.model.coupon_ids).toEqual([81]); expect(state.model.recommend_list).toEqual([25]);
    expect(state.model.custom_form).toEqual([{ stored: true }]); expect(state.preview).toBe('<p>已清理</p>');
    state.model.label_id = []; state.model.coupon_ids = []; const payload = toLegacySave(state.model);
    expect(payload.label_id).toEqual([]); expect(payload.coupon_ids).toEqual([]);
  });
  it('keeps canonical edit HTML distinct from a signed sanitized preview and strips signed media from writes', () => {
    const dto = detail(); dto.productInfo.description = '<p><img src="/api/assets/31"></p>';
    dto.productInfo.slider_image = ['/api/assets/31?signature=preview&expires=2000000000']; dto.productInfo.attr.pic = '/api/assets/31?signature=sku';
    const state = fromLegacyDetail(dto), payload = toLegacySave(state.model);
    expect(payload.description).toBe(dto.productInfo.description); expect(payload.description).not.toBe(state.preview);
    expect(payload.slider_image).toEqual(['/api/assets/31']); expect(payload.attrs[0]?.pic).toBe('/api/assets/31');
    expect(canonicalProductImage('https://cdn.example.test/api/assets/9?secret=x')).toBe('/api/assets/9');
    for (const value of ['javascript:alert(1)', '//foreign.test/a.png', '/api/assets/%252f9']) expect(() => canonicalProductImage(value)).toThrow();
  });
  it.each([1, 2, 3] as const)('roundtrips second-card validity mode %s through the same draft/save projection', valid => {
    const value = model(); value.product_type = 4; value.attrs[0]!.write_times = 18; value.attrs[0]!.write_valid = valid; value.attrs[0]!.days = 90;
    value.attrs[0]!.section_time = ['2027-01-01 10:00:00', '2027-12-01 10:00:00'];
    const draft = makeEditorDraft(value, 0, null), restored = fromEditorDraft(draft, 20, 0), payload = toLegacySave(restored.model);
    expect(payload.attrs[0]).toMatchObject({ write_times: 18, write_valid: valid, days: 90, section_time: value.attrs[0]!.section_time });
    expect(payload.delivery_type).toEqual([2]); expect(payload.postage).toBe(0); expect(payload.spec_type).toBe(0);
  });
  it('preserves long Unicode description and fixed-card draft content without client slicing', () => {
    const value = model(); value.description = '😀'.repeat(65000); value.product_type = 1; value.attrs[0]!.delivery_mode = 'fixed'; value.attrs[0]!.disk_info = '仅当前账号可见的合成内容';
    const restored = fromEditorDraft(makeEditorDraft(value, 0, null), 20, 0);
    expect(restored.model.description).toBe(value.description); expect(restored.model.attrs[0]?.disk_info).toBe(value.attrs[0]?.disk_info);
    expect(restored.model.attrs[0]?.delivery_mode).toBe('fixed');
    expect(toLegacySave(restored.model).delivery_type).toEqual([]);
  });
  it('does not project card imports, disabled commissions or UI-only identity fields', () => {
    const value = model(); value.product_type = 1; value.attrs[0]!.virtual_list = [{ card_no: 'synthetic' }]; value.attrs[0]!.brokerage = 9;
    const payload = toLegacySave(value); expect(payload.attrs[0]?.virtual_list).toEqual([]); expect(payload.attrs[0]?.brokerage).toBe(0);
    value.is_sub = [1]; expect(toLegacySave(value).attrs[0]?.brokerage).toBe(9);
  });
  it('projects cleared Element Plus date/select values without omitting any of the 59 fields', () => {
    const value = model(); Object.assign(value, { specs_id: undefined, system_form_id: undefined, auto_on_time: null, auto_off_time: null, presale_time: null });
    Object.assign(value.attrs[0]!, { section_time: null });
    const payload = JSON.parse(JSON.stringify(toLegacySave(value)));
    expect(Object.keys(payload).sort()).toEqual([...PRODUCT_EDITOR_FIELDS].sort());
    expect(payload).toMatchObject({ specs_id: 0, system_form_id: 0, auto_on_time: '', auto_off_time: '', presale_time: [] });
    expect(payload.attrs[0].section_time).toEqual([]);
  });
  it.each([undefined, null])('keeps all main numeric fields explicit when controls clear to %s', cleared => {
    const value = model(), numeric = Object.keys(toLegacySave(value)).filter(key => typeof (toLegacySave(value) as unknown as Record<string, unknown>)[key] === 'number');
    for (const field of numeric) (value as unknown as Record<string, unknown>)[field] = cleared;
    const payload = JSON.parse(JSON.stringify(toLegacySave(value)));
    expect(Object.keys(payload).sort()).toEqual([...PRODUCT_EDITOR_FIELDS].sort());
    expect(numeric.every(field => typeof payload[field] === 'number' && Number.isFinite(payload[field]))).toBe(true);
    expect(payload).toMatchObject({ sort: 0, ficti: 0, give_integral: 0, presale_day: 0, limit_num: 0 });
    expect(() => validateProductSave(payload, false)).not.toThrow();
  });
  it.each([undefined, null, 0, 1.5, 100000000])('refuses invalid second-card write counts %s before sending a request', cleared => {
    const value = model(); value.product_type = 4; Object.assign(value.attrs[0]!, { write_times: cleared });
    expect(() => validateProductSave(toLegacySave(value), false)).toThrow('次卡');
  });
  it.each([undefined, null, 0, 1.5, 3651])('refuses invalid second-card day counts %s before sending a request', cleared => {
    const value = model(); value.product_type = 4; Object.assign(value.attrs[0]!, { write_valid: 2, days: cleared });
    expect(() => validateProductSave(toLegacySave(value), false)).toThrow('次卡');
  });
  it('retains identities and unsaved values when dimensions are reordered, and refuses removal/rename', () => {
    const row = newEditorSku({ 颜色: '红', 尺码: '大' }); Object.assign(row, { unique: 'stable001', id: 19, price: 21, disk_info: 'fixed secret', delivery_mode: 'fixed' });
    const dims = [{ value: '尺码', detail: ['大'] }, { value: '颜色', detail: ['红', '蓝'] }];
    const generated = [{ detail: { 尺码: '大', 颜色: '红' }, pic: '', price: 0 }, { detail: { 尺码: '大', 颜色: '蓝' }, pic: '', price: 0 }];
    const rows = mergeGeneratedSkus(dims, generated, [row]);
    expect(rows[0]).toMatchObject({ id: 19, unique: 'stable001', price: 21, suk: '大,红', disk_info: 'fixed secret' });
    expect(rows[1]?.unique).toBeUndefined(); expect(rows[1]?.price).toBe(0);
    expect(detailIdentity({ a: 'x', b: 'y' })).toBe(detailIdentity({ b: 'y', a: 'x' }));
    expect(() => mergeGeneratedSkus(dims, [generated[1]], [row])).toThrow('历史SKU');
  });
  it('validates exact combinations, free/paid/template freight, VIP price and real bounded payload size', () => {
    const value = model(); expect(() => validateProductSave(toLegacySave(value), false)).not.toThrow();
    value.items = [{ value: '颜色', detail: ['红'] }]; expect(() => validateProductSave(toLegacySave(value), false)).toThrow('生成完整SKU');
    value.items = [{ value: '规格', detail: ['默认'] }]; value.freight = 2; expect(() => validateProductSave(toLegacySave(value), false)).toThrow('运费'); value.postage = 10;
    value.is_sub = [0]; expect(() => validateProductSave(toLegacySave(value), false)).toThrow('会员价'); value.attrs[0]!.vip_price = 10;
    expect(() => validateProductSave(toLegacySave(value), true)).toThrow('编码');
    value.description = 'x'.repeat(1024 * 1024); expect(() => validateProductSave(toLegacySave(value), false)).toThrow('1 MiB');
  });
  it('strictly recognizes omitted/id0/new and canonical positive edit IDs', () => {
    for (const value of [undefined, '', '0']) expect(parseEditorRoute(value)).toBe(0); expect(parseEditorRoute('19')).toBe(19);
    for (const value of ['00', '01', '-1', '1.2', '1e2', ['19'], '2147483648']) expect(() => parseEditorRoute(value)).toThrow();
  });
  it('checks operation actor/target/result and requires null target for an unknown read', () => {
    expect(parsePendingProductSave(operation, 20)).toEqual(operation); expect(() => parsePendingProductSave(operation, 21)).toThrow();
    expect(parseProductReceipt({ ...operation, state: 'committed', result: { id: 19, created: false } }, operation).state).toBe('committed');
    expect(parseProductReceipt({ ...operation, requested_id: null, state: 'unknown', result: null }, operation).state).toBe('unknown');
    for (const patch of [{ actor_id: 21 }, { requested_id: 20 }, { result: { id: 20, created: false } }, { result: { id: 19, created: true } }]) expect(() => parseProductReceipt({ ...operation, state: 'committed', result: { id: 19, created: false }, ...patch }, operation)).toThrow();
    expect(() => parseProductReceipt({ ...operation, state: 'unknown', result: null }, operation)).toThrow();
    expect(() => fromEditorDraft(makeEditorDraft(model(), 19, operation), 21, 19)).toThrow();
    expect(() => fromEditorDraft(makeEditorDraft(model(), 19, operation), 20, 20)).toThrow();
  });
});
