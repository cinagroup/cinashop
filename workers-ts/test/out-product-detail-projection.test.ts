import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { storeProduct, storeProductAttr, storeProductAttrValue, storeProductCategory } from '../src/models/schema';
import { outDetailFormInfo, outDetailIds, outDetailJson, outDetailProduct, outDetailSpecs, outDetailTime, outDetailTree } from '../src/services/out/OutProductDetailProjection';
import { outProductLabelIds } from '../src/services/out/OutProductLabelBindings';

const defaults = (table: Parameters<typeof getTableColumns>[0]) => Object.fromEntries(Object.entries(getTableColumns(table)).map(([key, col]) => [key, col.default ?? null]));
const product = (extra: Partial<typeof storeProduct.$inferSelect> = {}) => ({ ...defaults(storeProduct), id: 70, ...extra }) as typeof storeProduct.$inferSelect;
const sku = (extra: Partial<typeof storeProductAttrValue.$inferSelect> = {}) => ({ ...defaults(storeProductAttrValue), id: 1, productId: 70, unique: 'detail01', suk: '默认', ...extra }) as typeof storeProductAttrValue.$inferSelect;
const dimension = (name: string, values: string) => ({ ...defaults(storeProductAttr), attrName: name, attrValues: values }) as typeof storeProductAttr.$inferSelect;
const category = (id: number, pid: number, name = String(id)) => ({ ...defaults(storeProductCategory), id, pid, cateName: name }) as typeof storeProductCategory.$inferSelect;

describe('complete source-shaped Out product detail projection', () => {
  it('projects model getters, numeric amounts, both commission selectors and fixed source field names', () => {
    const value = outDetailProduct(product({ price: '12.30', postage: '2.50', cost: '4.20', giveIntegral: '7.00',
      sliderImage: '["/first.png","/second.png"]', deliveryType: '1,3', cateId: '4,5', isSub: 1, isVip: 1,
      isLimit: 1, videoOpen: 1, isPolices: 1, activity: '3,0,1,2,99', specs: '[{"name":"材质","value":"陶瓷"}]' }));
    expect(value).toMatchObject({ id: 70, price: 12.3, postage: 2.5, cost: 4.2, give_integral: 7,
      slider_image: ['/first.png', '/second.png'], delivery_type: ['1', '3'], cate_id: ['4', '5'],
      is_sub: [1, 0], is_limit: true, video_open: true, is_police: 1, recommend: [],
      activity: ['拼团', '默认', '秒杀', '砍价', '99'], specs: [{ name: '材质', value: '陶瓷' }] });
    expect(value).not.toHaveProperty('is_polices'); expect(value).not.toHaveProperty('storeName');
  });
  it('projects empty getters and source default activity ordering', () => {
    expect(outDetailProduct(product())).toMatchObject({ slider_image: null, delivery_type: [], specs: [],
      activity: ['默认', '秒杀', '砍价', '拼团'], is_sub: [], video_open: false, is_limit: false, presale_time: [], auto_on_time: '', auto_off_time: '' });
    expect(outDetailProduct(product({ sliderImage: '0', deliveryType: '0', activity: '0' }))).toMatchObject({ slider_image: 0,
      delivery_type: [], activity: ['默认', '秒杀', '砍价', '拼团'] });
  });
  it('formats presale, show schedules and verification days in Shanghai regardless of host timezone', () => {
    expect(outDetailTime(1704067200)).toBe('2024-01-01 08:00:00'); expect(outDetailTime(1704067200, true)).toBe('2024-01-01');
    expect(outDetailProduct(product({ isShow: 0, presaleStartTime: 1704067200, presaleEndTime: 1704153600,
      autoOnTime: 1704067200, autoOffTime: 1704153600 }))).toMatchObject({ presale_time: ['2024-01-01 08:00:00', '2024-01-02 08:00:00'], auto_on_time: '2024-01-01 08:00:00', auto_off_time: '' });
    expect(outDetailProduct(product({ isShow: 1, autoOnTime: 1704067200, autoOffTime: 1704153600 }))).toMatchObject({ auto_on_time: '', auto_off_time: '2024-01-02 08:00:00' });
    expect(() => outDetailTime(Number.MAX_SAFE_INTEGER)).toThrow('时间');
  });
  it('keeps complete multi-SKU dimensions, identities, valueN fields and numeric editor values', () => {
    const dims = [dimension('颜色', '红,蓝'), dimension('尺码', '大')];
    const values = [sku({ suk: '红,大', price: '12.30', stock: 7, sales: 2, sumStock: 9 }), sku({ id: 2, unique: 'detail02', suk: '蓝,大' })];
    const projected = outDetailSpecs(product({ specType: 1 }), dims, values, new Map());
    expect(projected.sku_repair_required).toBe(false); expect(projected.items).toEqual([{ value: '颜色', detail: ['红', '蓝'] }, { value: '尺码', detail: ['大'] }]);
    expect(projected.attrs[0]).toMatchObject({ id: 1, unique: 'detail01', detail: { 颜色: '红', 尺码: '大' }, value1: '红', value2: '大', price: 12.3, stock: 7, sales: 2, sum_stock: 9 });
    expect(projected.attr).toMatchObject({ pic: '', price: 0, stock: 0, write_times: 1, write_valid: 1, section_time: [] });
  });
  it('keeps single-SKU disk metadata source-shaped and virtual inventory count-only', () => {
    const value = outDetailSpecs(product(), [], [sku({ diskInfo: 'legacy disk metadata', writeTimes: 3, writeValid: 2,
      writeDays: 5, writeStart: 1704067200, writeEnd: 1704153600 })], new Map([['detail01', { available: 3, total: 5 }]]));
    expect(value).toMatchObject({ items: [], attrs: [], sku_repair_required: false,
      attr: { id: 1, unique: 'detail01', virtual_list: [], virtual_available: 3, virtual_total: 5,
        disk_info: 'legacy disk metadata', write_times: 3, write_valid: 2, days: 5, section_time: ['2024-01-01', '2024-01-02'] } });
  });
  it('reports missing or ambiguous historical SKUs without fabricating identities or default repair writes', () => {
    const value = outDetailSpecs(product({ image: '/source.png', price: '3.25', stock: 7 }), [], [], new Map());
    expect(value).toMatchObject({ sku_repair_required: true, attr: { pic: '/source.png', price: 3.25, stock: 7, virtual_list: [] } });
    expect(value.attr).not.toHaveProperty('id'); expect(value.attr).not.toHaveProperty('unique');
    expect(outDetailSpecs(product({ specType: 1 }), [], [sku({ suk: '红,大' })], new Map()).sku_repair_required).toBe(true);
    expect(outDetailSpecs(product(), [], [sku(), sku({ id: 2 })], new Map()).sku_repair_required).toBe(true);
  });
  it('separates retired SKU identities from editable current rows', () => {
    const value = outDetailSpecs(product(), [], [sku(), sku({ id: 2, unique: 'retire01', isRetired: 1 })], new Map());
    expect(value.sku_repair_required).toBe(false); expect(value.attr.id).toBe(1); expect(value.retired).toMatchObject([{ id: 2, unique: 'retire01', is_retired: 1 }]);
  });
  it('preserves supplied directory order and omits children of missing or hidden parents', () => {
    expect(outDetailTree([category(5, 1, '先'), category(4, 1, '后'), category(1, 0, '根'), category(8, 9)]))
      .toEqual([{ value: 1, pid: 0, label: '根', children: [{ value: 5, pid: 1, label: '先' }, { value: 4, pid: 1, label: '后' }] }]);
  });
  it.each([{ rows: [category(1, 1)] }, { rows: [category(1, 2), category(2, 1)] }, { rows: [category(1, 0), category(1, 0)] },
    { rows: Array.from({ length: 17 }, (_, i) => category(i + 1, i)) }])('rejects cyclic duplicate or excessively deep complete directories', ({ rows }) => {
    expect(() => outDetailTree(rows)).toThrow('分类');
  });
  it('projects every system form field family with exact list and required semantics', () => {
    const names = ['checkboxs', 'citys', 'dates', 'dateranges', 'radios', 'selects', 'texts', 'times', 'timeranges', 'uploadPicture'];
    const form = names.map((name, id) => ({ id, name, titleConfig: { value: name }, tipConfig: { value: '提示' },
      wordsConfig: { list: ['选项'] }, titleShow: { val: true }, value: '回显' }));
    const result = outDetailFormInfo(form); expect(result).toHaveLength(10);
    expect(result.map(row => row.name)).toEqual(['多选框', '城市', '日期', '日期范围', '单选框', '下拉框', '文本框', '时间', '时间范围', '图片']);
    expect(result.map(row => row.list)).toEqual(names.map(name => ['checkboxs', 'radios', 'selects'].includes(name) ? ['选项'] : []));
    expect(result[0]).toMatchObject({ id: 0, type: 'checkboxs', title: 'checkboxs', tip: '提示', require: true, value: '回显' });
    expect(outDetailFormInfo(null)).toEqual([]); expect(() => outDetailFormInfo(Array(101).fill({}))).toThrow('100');
  });
  it('bounds JSON expansion, preserves PHP invalid JSON null and does not coerce CSV IDs', () => {
    expect(outDetailJson('bad historical json')).toBeNull(); expect(outDetailJson('0')).toEqual([]);
    expect(() => outDetailJson(JSON.stringify(Array(1001).fill(1)))).toThrow('容量');
    expect(outDetailIds('3,0,,1,3')).toEqual([3, 1, 3]);
    for (const value of ['01', '1,x', '-1', '2147483648']) expect(() => outDetailIds(value)).toThrow('选集');
  });
  it('uses actual varchar64 metadata and distinguishes the exact 64/65-character user-label boundary', () => {
    const fits = [100000000, 1000000001, 1000000002, 1000000003, 1000000004, 1000000005];
    const exceeds = [1000000000, ...fits.slice(1)];
    expect(storeProduct.labelId.getSQLType()).toBe('varchar(64)'); expect(fits.join(',')).toHaveLength(64); expect(exceeds.join(',')).toHaveLength(65);
    expect(outProductLabelIds(fits, 'user')).toEqual(fits); expect(() => outProductLabelIds(exceeds, 'user')).toThrow('64');
    expect(outProductLabelIds(exceeds, 'product')).toEqual(exceeds);
  });
});
