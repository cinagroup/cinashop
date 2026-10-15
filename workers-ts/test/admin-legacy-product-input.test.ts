import { describe, expect, it } from 'vitest';
import {
  ADMIN_LEGACY_PRODUCT_FIELDS, ADMIN_LEGACY_PRODUCT_MAX_BODY_BYTES,
  normalizeAdminLegacyProductInput, readAdminLegacyProductBody, resolveAdminLegacyProductOwner,
} from '../src/services/admin/AdminLegacyProductInput';

const NOW = 1_792_022_400; // 2026-10-15T00:00:00Z
const sku = (changes: Record<string, unknown> = {}) => ({
  pic: '/uploads/sku.png', price: 29.5, settle_price: 0, cost: 8.1, ot_price: 39, stock: 7,
  bar_code: 'SKU123', code: 'CODE123', weight: 0.5, volume: 1.2, brokerage: 2,
  brokerage_two: 1, vip_price: 19, virtual_list: [], write_times: 0, write_valid: 1, days: 1, ...changes,
});
/** Actual old six-step form shape, including non-write UI/read DTO echoes. */
const body = (changes: Record<string, unknown> = {}) => ({
  product_type: 0, supplier_id: 0, cate_id: ['10'], store_name: '完整商品', store_info: '简介', keyword: '冬季', unit_name: '件',
  recommend_image: '/uploads/recommend.png', slider_image: ['/uploads/first.png', '/uploads/second.png'], is_sub: [0, 1],
  sort: 20, ficti: 15, give_integral: 2.5, is_show: 1, is_hot: 1, is_benefit: 1, is_best: 1, is_new: 1,
  mer_use: 1, is_postage: 1, is_good: 1, description: '<p>完整详情</p>\n<p>第二段</p>', spec_type: 0,
  video_open: true, video_link: 'https://assets.example/video.mp4', items: [], attrs: [sku()], recommend: [],
  activity: ['默认', '秒杀', '砍价', '拼团'], coupon_ids: [12], label_id: [13], command_word: '口令', tao_words: '淘口令',
  type: 0, delivery_type: ['1', '2'], freight: 1, postage: 12, temp_id: '', recommend_list: [100, 101],
  brand_id: ['14', '15'], soure_link: 'https://source.example/item', bar_code: 'MAIN123', code: 'MAINCODE',
  is_support_refund: 1, is_presale_product: 0, presale_time: [], presale_day: 1, is_vip_product: 1,
  auto_on_time: '', auto_off_time: '', custom_form: [{ title: '留言', label: 'text', value: '', status: 0 }],
  system_form_id: 16, store_label_id: [17], ensure_id: [18], specs: [{ id: 90, temp_id: 19, name: '材质', value: '棉', sort: 2 }],
  specs_id: 19, is_limit: 1, limit_type: 2, limit_num: 3,
  // PHP postMore ignores these even when the edit DTO echoed real table values.
  id: 777, image: '/ignored.png', header: [], couponName: [], selectRule: '', attr: {}, coupons: [],
  custom_form_info: [], sales: 999, pid: 909, relation_id: 901, is_verify: 1, is_del: 1,
  ...changes,
});
const normalize = (changes: Record<string, unknown> = {}) => normalizeAdminLegacyProductInput(body(changes), { now: NOW });

describe('Complete bounded old Admin product body adapter', () => {
  it('covers every active controller field and normalizes all six form groups without accepting row echoes as writes', () => {
    expect(ADMIN_LEGACY_PRODUCT_FIELDS).toHaveLength(59);
    const result = normalize();
    expect(ADMIN_LEGACY_PRODUCT_FIELDS.every(field => Object.hasOwn(result.normalized, field))).toBe(true);
    expect(result.normalized).toMatchObject({ cate_id: [10], brand_id: [14, 15], store_label_id: [17], ensure_id: [18],
      coupon_ids: [12], label_id: [13], recommend_list: [100, 101], activity: [0, 1, 2, 3], specs_id: 19,
      specs: [{ name: '材质', value: '棉', sort: 2, status: 1 }], tao_words: '淘口令' });
    expect(result.productValues).toMatchObject({ productType: 0, image: '/uploads/first.png', storeName: '完整商品', storeInfo: '简介',
      keyword: '冬季', unitName: '件', sliderImage: '["/uploads/first.png","/uploads/second.png"]', recommendImage: '/uploads/recommend.png',
      sort: 20, ficti: 15, giveIntegral: '2.50', isShow: 1, isHot: 1, isBenefit: 1, isBest: 1, isNew: 1, merUse: 1,
      isPostage: 1, isGood: 1, isSub: 1, isVip: 1, videoOpen: 1, videoLink: 'https://assets.example/video.mp4',
      activity: '0,1,2,3', commandWord: '口令', recommendList: '100,101', soureLink: 'https://source.example/item',
      barCode: 'MAIN123', code: 'MAINCODE', isSupportRefund: 1, isPresaleProduct: 0, presaleDay: 1, isVipProduct: 1,
      autoOnTime: 0, autoOffTime: 0, customForm: '[{"title":"留言","label":"text","value":"","status":0}]',
      systemFormId: 16, isLimit: 1, limitType: 2, limitNum: 3, deliveryType: '1,2', freight: 1, postage: '0.00', tempId: 0 });
    expect(result.description).toBe('<p>完整详情</p>\n<p>第二段</p>');
    for (const field of ['sales', 'id', 'pid', 'relationId', 'isVerify', 'isDel', 'type', 'taoWords', 'labelId']) expect(result.productValues).not.toHaveProperty(field);
  });
  it('forces the canonical single dimension and reads pic as image without trusting value1 or request image', () => {
    const result = normalize({ attrs: [sku({ value1: 'injected', detail: { other: 'injected' }, unique: 'ABCD1234' })] });
    expect(result.skuPayload).toMatchObject({ specType: 0, dimensions: [{ value: '规格', detail: ['默认'] }], skus: [{
      suk: '默认', detail: { 规格: '默认' }, image: '/uploads/sku.png', unique: 'ABCD1234', price: '29.50', cost: '8.10',
      stock: 7, vipPrice: '19.00', brokerage: '2.00', brokerageTwo: '1.00',
    }] });
  });
  it('matches the old single-spec GET DTO to real handleSubmit transition instead of guessing from an attr read echo', () => {
    const getDto = body({ is_limit: true, spec_type: 0, items: [], attrs: [], attr: sku({ disk_info: [], stock: 12 }),
      brand_id: [14, 15], store_label_id: [{ id: 17, label_name: '商品标签' }], label_id: [{ id: 13, label_name: '会员' }],
      coupons: [{ id: 12, title: '赠券' }], recommend_list: [{ product_id: 100, image: '/recommended.png' }] });
    // getInfo deliberately returns attrs=[] for one SKU. The Vue form moves
    // productInfo.attr into oneFormValidate and only then submits attrs=[attr].
    expect(() => normalizeAdminLegacyProductInput(getDto)).toThrow();
    const post = { ...getDto, attrs: [getDto.attr], type: 0, brand_id: [14, 15].map(String),
      label_id: [13], store_label_id: [17], coupon_ids: [12], recommend_list: [100] };
    const result = normalizeAdminLegacyProductInput(JSON.parse(JSON.stringify(post)));
    expect(result.skuPayload.skus[0]).toMatchObject({ stock: 12, diskInfo: '', suk: '默认' });
    expect(result.normalized).toMatchObject({ brand_id: [14, 15], label_id: [13], store_label_id: [17], coupon_ids: [12], recommend_list: [100] });
  });
  it('adapts reordered multi SKU rows by actual detail identity instead of array position', () => {
    const result = normalize({ spec_type: 1, items: [{ value: '颜色', detail: ['红', '蓝'] }, { value: '尺寸', detail: ['大'] }],
      attrs: [sku({ detail: { 尺寸: '大', 颜色: '蓝' }, value1: '蓝', value2: '大', unique: 'BLUE0001', stock: 8 }),
        sku({ value1: '红', value2: '大', unique: 'RED00001', stock: 6 })] });
    expect(result.skuPayload.skus.map(item => [item.suk, item.unique, item.stock])).toEqual([
      ['蓝,大', 'BLUE0001', 8], ['红,大', 'RED00001', 6],
    ]);
  });
  it.each([
    { detail: { 颜色: '红' }, value1: '蓝' }, { detail: { 颜色: '红', injected: '蓝' } },
    { detail: { 颜色: '红' }, suk: '蓝' }, { detail: { 颜色: 'missing' } },
  ])('rejects ambiguous or out-of-dimension legacy SKU descriptions %j', changes => {
    expect(() => normalize({ spec_type: 1, items: [{ value: '颜色', detail: ['红'] }], attrs: [sku(changes)] })).toThrow();
  });
  it('zeros commission whenever the old selection does not include 1, while preserving independent VIP choice', () => {
    expect(normalize({ is_sub: [0], attrs: [sku({ brokerage: 'invalid', brokerage_two: null })] }).skuPayload.skus[0])
      .toMatchObject({ vipPrice: '19.00', brokerage: '0.00', brokerageTwo: '0.00' });
    expect(normalize({ is_sub: [1] }).productValues).toMatchObject({ isVip: 0, isSub: 1 });
    expect(() => normalize({ is_sub: [0], attrs: [sku({ vip_price: 0 })] })).toThrow('会员价格不能为0');
    expect(() => normalize({ attrs: [sku({ brokerage: 29, brokerage_two: 1 })] })).toThrow();
  });
  it('uses positive supplier settlement as source SKU cost without losing its separate settlement meaning', () => {
    const { cost: _removedCost, ...withoutCost } = sku({ settle_price: 12.3 });
    expect(normalize({ attrs: [withoutCost] }).skuPayload.skus[0]).toMatchObject({ settlePrice: '12.30', cost: '12.30' });
  });
  it('keeps copy mode and owner authority separate and preserves established non-platform owners', () => {
    const result = normalize({ type: -1, supplier_id: '40', relation_id: 999 });
    expect(result.copyMode).toBe(-1);
    expect(resolveAdminLegacyProductOwner(result)).toEqual({ type: 2, relationId: 40 });
    expect(resolveAdminLegacyProductOwner(result, { type: 0, relationId: 0 })).toEqual({ type: 2, relationId: 40 });
    expect(resolveAdminLegacyProductOwner(result, { type: 1, relationId: 51 })).toEqual({ type: 1, relationId: 51 });
    expect(resolveAdminLegacyProductOwner(result, { type: 2, relationId: 52 })).toEqual({ type: 2, relationId: 52 });
    expect(resolveAdminLegacyProductOwner(normalize())).toEqual({ type: 0, relationId: 0 });
  });
  it('preserves the ORM omission of array-valued label_id while retaining original relation intent', () => {
    expect(normalize({ label_id: [13, 14] }).productValues).not.toHaveProperty('labelId');
    const originalObjectForm = normalize({ label_id: [{ id: 13, label_name: '会员' }] });
    expect(originalObjectForm.normalized.label_id).toEqual([13]);
    expect(originalObjectForm.productValues).not.toHaveProperty('labelId');
  });
  it('normalizes precise Shanghai/UTC/date-only ranges and hides an auto-on product', () => {
    const result = normalize({ is_presale_product: 1, presale_time: ['2026-10-16 08:00:00', '2026-10-17T00:00:00Z'],
      auto_on_time: '2026-10-16 08:00', auto_off_time: '2026-10-18T00:00:00.000Z', is_show: 2 });
    expect(result.productValues).toMatchObject({ isShow: 0, presaleStartTime: 1_792_108_800, presaleEndTime: 1_792_195_200,
      autoOnTime: 1_792_108_800, autoOffTime: 1_792_281_600 });
    expect(normalize({ auto_off_time: '2020-01-01 00:00:00', is_show: 2 }).productValues.isShow).toBe(2);
  });
  it('retains the source difference that presale endpoints are each future-checked without an ordering check', () => {
    const result = normalize({ is_presale_product: 1, presale_time: ['2026-10-18', '2026-10-17'] });
    expect(result.productValues.presaleStartTime).toBeGreaterThan(result.productValues.presaleEndTime!);
  });
  it.each([
    { is_presale_product: 1, presale_time: ['2020-01-01', '2026-10-17'] },
    { is_presale_product: 1, presale_time: ['2026-02-30', '2026-10-17'] },
    { is_presale_product: 1, presale_time: ['2026-10-17'] }, { auto_on_time: 'next Tuesday' },
    { auto_on_time: '2026-10-17T00:00:00+08:00' }, { auto_on_time: 1_792_108_800 },
    { is_limit: 1, limit_type: 0 }, { is_limit: 1, limit_num: 0 },
  ])('rejects unsupported or ambiguous schedule/limit definitions %j', changes => expect(() => normalize(changes)).toThrow());
  it('clears limits and presale endpoints when their source switches are off', () => {
    expect(normalize({ is_limit: false, limit_type: 99, limit_num: -1, presale_time: ['garbage'], is_presale_product: 0 }).productValues)
      .toMatchObject({ isLimit: 0, limitType: 0, limitNum: 0, presaleStartTime: 0, presaleEndTime: 0 });
  });
  it('keeps complete schema-driven custom forms and validates bounded parameter snapshots', () => {
    const schema = [{ type: 'input', field: 'message', props: { placeholder: '请输入' }, validate: [{ required: true }] }];
    expect(normalize({ custom_form: schema }).normalized.custom_form).toEqual(schema);
    // Actual system-form builder defaultArray is an object keyed by component ID.
    const systemSchema = { id1660613246032: { id: 'id1660613246032', name: 'texts', titleConfig: { value: '留言' }, titleShow: { val: true }, value: '' } };
    const roundTrip = JSON.parse(JSON.stringify(body({ custom_form: systemSchema })));
    expect(normalizeAdminLegacyProductInput(roundTrip).normalized.custom_form).toEqual(systemSchema);
    expect(normalizeAdminLegacyProductInput(roundTrip).productValues.customForm).toBe(JSON.stringify(systemSchema));
    for (const empty of [[], {}]) expect(normalize({ custom_form: empty }).productValues.customForm).toBe('');
    expect(() => normalize({ specs: [{ name: '材质', value: '' }] })).toThrow();
    expect(() => normalize({ specs: [{ name: '材质', value: '棉' }, { name: '材质', value: '毛' }] })).toThrow();
  });
  it('handles all physical freight modes and forcibly normalizes manual virtual/card freight', () => {
    expect(normalize({ freight: 2, postage: 4.2, temp_id: 99 }).productValues).toMatchObject({ freight: 2, postage: '4.20', tempId: 0 });
    expect(normalize({ freight: 3, postage: 99, temp_id: 40 }).productValues).toMatchObject({ freight: 3, postage: '0.00', tempId: 40 });
    for (const product_type of [1, 3]) expect(normalize({ product_type, freight: 1, postage: 99, temp_id: 40 }).productValues)
      .toMatchObject({ freight: 2, postage: '0.00', tempId: 0, deliveryType: '' });
    expect(() => normalize({ delivery_type: [] })).toThrow();
    expect(() => normalize({ freight: 2, postage: 0 })).toThrow();
    expect(() => normalize({ freight: 3, temp_id: 0 })).toThrow();
  });
  it('keeps source second-card freight distinct from the existing modern writer forced pickup policy', () => {
    const attrs = [sku({ write_times: 8, write_valid: 1 })];
    expect(normalize({ product_type: 4, delivery_type: 2, attrs, freight: 2, postage: 4 }).productValues)
      .toMatchObject({ deliveryType: '2', freight: 2, postage: '4.00', tempId: 0 });
    expect(normalize({ product_type: 4, delivery_type: 2, attrs, freight: 3, temp_id: 40 }).productValues)
      .toMatchObject({ deliveryType: '2', freight: 3, postage: '0.00', tempId: 40 });
  });
  it('expands relative video against a configured source origin and never invents that origin', () => {
    expect(() => normalize({ video_link: '/uploads/video.mp4' })).toThrow('站点地址');
    expect(normalizeAdminLegacyProductInput(body({ video_link: '/uploads/video.mp4' }), { siteUrl: 'https://shop.example' }).productValues.videoLink)
      .toBe('https://shop.example/uploads/video.mp4');
  });
  it('validates ERP main and SKU codes independently only when the transaction supplies its current ERP setting', () => {
    for (const changes of [{ code: '' }, { attrs: [sku({ code: '' })] }]) {
      expect(() => normalizeAdminLegacyProductInput(body(changes), { erpOpen: true })).toThrow();
      expect(() => normalize(changes)).not.toThrow();
    }
  });
  it.each([
    { cate_id: [] }, { slider_image: [] }, { attrs: [] }, { attrs: [sku(), sku()] },
    { product_type: 2 }, { spec_type: 2 }, { supplier_id: true }, { store_name: ' ' }, { give_integral: '1e3' },
    { give_integral: '1.001' }, { cate_id: [2_147_483_648] }, { cate_id: [10, 10] }, { brand_id: ['1'.repeat(65)] },
    { attrs: [sku({ pic: '' })] }, { attrs: [sku({ price: '1e2' })] }, { attrs: [sku({ stock: true })] },
    { attrs: [sku({ price: 0 })] }, { is_sub: [0, 0] }, { custom_form: 'invalid' }, { description: '\u0000' },
  ])('rejects invalid fields before any DB access %j', changes => expect(() => normalize(changes)).toThrow());
  it('rejects a multi-SKU stock sum above the real PostgreSQL integer column capacity', () => {
    expect(() => normalize({ spec_type: 1, items: [{ value: '颜色', detail: ['红', '蓝'] }],
      attrs: [sku({ detail: { 颜色: '红' }, stock: 2_147_483_647 }), sku({ detail: { 颜色: '蓝' }, stock: 1 })] })).toThrow('总库存');
  });
  it('requires a submitted numeric SKU stock and cost unless settlement itself supplies source cost', () => {
    const { stock: _stock, ...withoutStock } = sku();
    const { cost: _cost, ...withoutCost } = sku();
    expect(() => normalize({ attrs: [withoutStock] })).toThrow();
    expect(() => normalize({ attrs: [withoutCost] })).toThrow();
  });
});

describe('Card and second-card old wire safety', () => {
  it('isolates explicit new card inputs from normalized SKU data and leaves importing to the atomic caller', () => {
    const result = normalize({ product_type: 1, attrs: [sku({ virtual_list: [{ key: 'card', value: 'secret' }, { key: 'card', value: 'secret' }], stock: 2 })] });
    expect(result.cardImports).toEqual([{ suk: '默认', cards: [{ cardNo: 'card', cardPwd: 'secret' }], requestDuplicates: 1 }]);
    expect(result.skuPayload.skus[0].diskInfo).toBe('');
    expect(JSON.stringify(result.normalized.attrs)).not.toContain('secret');
    expect(result.skuPayload.skus[0].stock).toBe(2); // Caller must rebase inventory against locked actual counts.
  });
  it('preserves explicitly configured fixed content but rejects mixed delivery and non-card secrets', () => {
    expect(normalize({ product_type: 1, attrs: [sku({ disk_info: '交付内容' })] }).skuPayload.skus[0].diskInfo).toBe('交付内容');
    expect(() => normalize({ product_type: 1, attrs: [sku({ disk_info: '内容', virtual_list: [{ key: '', value: 'secret' }] })] })).toThrow();
    expect(() => normalize({ product_type: 0, attrs: [sku({ virtual_list: [{ key: '', value: 'secret' }] })] })).toThrow();
  });
  it('strips all fixed/card secrets, imported card rows, inventory and identity in trusted local-copy context', () => {
    const original = body({ product_type: 1, attrs: [sku({ unique: 'OLD00001', disk_info: 'copied-secret', stock: 88,
      virtual_list: [{ key: 'old', value: 'old-password' }] })] });
    const result = normalizeAdminLegacyProductInput(original, { localCopy: true });
    expect(result.cardImports).toEqual([]);
    expect(result.skuPayload.skus[0]).toMatchObject({ stock: 0, diskInfo: '' });
    expect(result.skuPayload.skus[0].unique).toBeUndefined();
    expect(result.productValues.soureLink).toBe('');
    expect(JSON.stringify(result)).not.toContain('copied-secret');
    expect(JSON.stringify(result)).not.toContain('old-password');
    expect((original.attrs[0] as Record<string, unknown>).unique).toBe('OLD00001');
    expect(normalizeAdminLegacyProductInput(body({ attrs: [sku({ unique: 'OLD00001', stock: 9 })] }), { localCopy: true }).skuPayload.skus[0])
      .toMatchObject({ stock: 9, unique: undefined });
  });
  it('bounds aggregate card imports across all SKU combinations, not just each list', () => {
    const cards = Array.from({ length: 501 }, (_, i) => ({ key: String(i), value: 'secret' }));
    expect(() => normalize({ product_type: 1, spec_type: 1, items: [{ value: '版本', detail: ['甲', '乙'] }],
      attrs: [sku({ detail: { 版本: '甲' }, virtual_list: cards }), sku({ detail: { 版本: '乙' }, virtual_list: cards })] })).toThrow('1000');
  });
  it.each([
    [1, { days: 900, section_time: ['garbage'] }, { writeValid: 1, writeDays: 0, writeStart: 0, writeEnd: 0 }],
    [2, { days: 31, section_time: ['garbage'] }, { writeValid: 2, writeDays: 31, writeStart: 0, writeEnd: 0 }],
    [3, { days: 900, section_time: ['2026-10-16', '2026-10-18'] }, { writeValid: 3, writeDays: 0, writeStart: 1_792_080_000, writeEnd: 1_792_252_800 }],
  ] as const)('adapts old second-card validity mode %i', (write_valid, changes, expected) => {
    const result = normalize({ product_type: 4, delivery_type: 2, attrs: [sku({ write_times: 8, write_valid, ...changes })] });
    expect(result.skuPayload.skus[0]).toMatchObject({ writeTimes: 8, ...expected });
    expect(result.productValues.deliveryType).toBe('2');
  });
  it.each([
    { write_times: 0 }, { write_times: 1, write_valid: 2, days: 0 },
    { write_times: 1, write_valid: 3, section_time: ['2026-10-18', '2026-10-16'] },
    { write_times: 1, write_valid: 3, section_time: ['2026-02-30', '2026-10-16'] },
  ])('rejects invalid second-card rules %j', changes => expect(() => normalize({ product_type: 4, attrs: [sku(changes)] })).toThrow());
});

describe('Strict bounded old body JSON reader', () => {
  it('rejects decoded duplicate keys at every level before normalization, including escaped aliases', async () => {
    for (const input of ['{"store_name":"a","store_name":"b"}', '{"attrs":[{"stock":1,"st\\u006fck":2}]}']) {
      await expect(readAdminLegacyProductBody(new Request('https://shop.test', { method: 'POST', body: input }))).rejects.toThrow('重复');
    }
  });
  it('enforces actual UTF-8 byte limits even without Content-Length and rejects invalid UTF-8', async () => {
    const oversized = '中'.repeat(Math.ceil(ADMIN_LEGACY_PRODUCT_MAX_BODY_BYTES / 3));
    await expect(readAdminLegacyProductBody(new Request('https://shop.test', { method: 'POST', body: `{"description":"${oversized}"}` }))).rejects.toThrow('1024 KiB');
    await expect(readAdminLegacyProductBody(new Request('https://shop.test', { method: 'POST', body: new Uint8Array([0xff]) }))).rejects.toThrow('UTF-8');
  });
  it('bounds nested form depth, node counts and non-JSON direct adapter calls', () => {
    let nested: unknown = 'value';
    for (let i = 0; i < 25; i++) nested = [nested];
    expect(() => normalize({ custom_form: [nested] })).toThrow('结构');
    expect(() => normalize({ custom_form: [new Date()] })).toThrow('JSON对象');
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    expect(() => normalize({ custom_form: [cycle] })).toThrow('有限JSON');
    expect(() => normalize(JSON.parse('{"custom_form":[{"__proto__":{}}]}'))).toThrow('字段');
  });
  it('reads actual old whole-form JSON and safely ignores a future read-only echo', async () => {
    const input = await readAdminLegacyProductBody(new Request('https://shop.test', { method: 'POST', body: JSON.stringify(body({ future_read_only_echo: 'read only' })) }));
    expect(normalizeAdminLegacyProductInput(input).normalized).not.toHaveProperty('future_read_only_echo');
  });
});
