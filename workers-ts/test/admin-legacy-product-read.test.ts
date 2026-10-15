import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { storeProduct, storeProductAttr, storeProductAttrValue, storeProductAttrResult, storeProductDescription, storeProductVirtual,
  storeProductRelation, storeProductLabel, userLabel, systemForm, systemConfig, systemRole, systemAdmin, shippingTemplates,
  storeCouponIssue, storeProductCoupon, systemAttachment, storeCart } from '@/models/schema';
import { AdminLegacyProductReadService } from '@/services/admin/AdminLegacyProductReadService';
import { normalizeAdminLegacyProductInput } from '@/services/admin/AdminLegacyProductInput';
import { legacySaveFixture, legacySaveActor, legacySaveBody, legacySaveSku } from './helpers/adminLegacyProductSave';
import { oldEditorSaveBody } from './helpers/adminLegacyProductRead';
type Row = Record<string, unknown>;
describe('true legacy Admin editor GET without implicit SKU/card mutations', () => {
  let f: Awaited<ReturnType<typeof legacySaveFixture>>, service: AdminLegacyProductReadService;
  beforeAll(async () => { f = await legacySaveFixture(); service = new AdminLegacyProductReadService(f.container, 'owned-editor-read-key');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Editor read forbids provider I/O')); }, 30000);
  beforeEach(async () => { await f.seed(); });
  afterAll(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); } });
  const read = (id = 1, query = new URLSearchParams()) => service.detail(id, query, legacySaveActor());
  const create = (changes: Row = {}) => f.service.save(0, legacySaveBody(changes), legacySaveActor());

  it('returns the actual envelope, main scalar/JSON transforms and ordinary single attr, with no write side effects', async () => {
    await create({ store_info: '描述', is_sub: [1, 0], is_limit: 1, limit_type: 2, limit_num: 4,
      give_integral: '1.25', is_hot: 1, video_open: 1, activity: ['拼团', '默认'],
      attrs: [legacySaveSku({ vip_price: 8, brokerage: 2, brokerage_two: 1 })] });
    const before = await f.snapshot(), result = await read(), info = result.productInfo;
    expect(Object.keys(result)).toEqual(['tempList', 'cateList', 'productInfo', 'editor']);
    expect(result.cateList).toEqual([{ value: 1, label: '平台分类', pid: 0 }]);
    expect(info).toMatchObject({ id: 1, store_name: '完整商品', store_info: '描述', cate_id: ['1'], brand_id: [],
      is_sub: [1, 0], is_limit: true, limit_type: 2, limit_num: 4, give_integral: 1.25, video_open: true,
      slider_image: ['/uploads/main.png'], activity: ['拼团', '默认'], items: [], attrs: [], spec_type: 0,
      description: '<p>完整描述</p>', sku_repair_required: false });
    expect(result.editor.description_preview).toBe('<p>完整描述</p>');
    expect(info.attr).toMatchObject({ unique: expect.any(String), pic: '/uploads/sku.png', price: 12.5, cost: 3,
      ot_price: 20, vip_price: 8, stock: 7, brokerage: 2, brokerage_two: 1, virtual_list: [] });
    expect(await f.snapshot()).toEqual(before);
    const body = oldEditorSaveBody(info);
    expect(normalizeAdminLegacyProductInput(body).productValues).toMatchObject({ isLimit: 1, isVip: 1, isSub: 1, giveIntegral: '1.25' });
    await f.service.save(1, body, legacySaveActor());
    expect((await read()).productInfo.attr).toMatchObject(info.attr as Row);
  });

  it('reconstructs multi-SKU pic/detail/valueN and fresh stock from current rows instead of stale/camel snapshot JSON', async () => {
    await create({ spec_type: 1, items: [{ value: '颜色', detail: ['红', '蓝'] }],
      attrs: [legacySaveSku({ detail: { 颜色: '红' }, stock: 2 }), legacySaveSku({ detail: { 颜色: '蓝' }, stock: 5 })] });
    await f.db.update(storeProductAttrResult).set({ result: '{"value":[{"stock":999,"disk_info":"STALE-SNAPSHOT-SECRET","virtual_list":[{"value":"STALE-CARD"}]}]}' });
    const before = await f.snapshot(), info = (await read()).productInfo;
    expect(info.items).toEqual([{ value: '颜色', detail: ['红', '蓝'] }]);
    expect(info.attrs).toEqual([expect.objectContaining({ detail: { 颜色: '红' }, value1: '红', stock: 2, pic: '/uploads/sku.png', settle_price: 0 }),
      expect.objectContaining({ detail: { 颜色: '蓝' }, value1: '蓝', stock: 5, pic: '/uploads/sku.png' })]);
    expect(JSON.stringify(info)).not.toContain('STALE-');
    expect(await f.snapshot()).toEqual(before);
    await f.service.save(1, oldEditorSaveBody(info), legacySaveActor());
    expect(((await read()).productInfo.attrs as Row[]).map(row => row.unique)).toEqual((info.attrs as Row[]).map(row => row.unique));
  });

  it('does not backfill result, dimensions, identity or parent spec_type when a single legacy product has no SKU', async () => {
    await f.db.insert(storeProduct).values({ id: 1, storeName: '无规格历史商品', specType: 0, price: '11.50', cost: '3.25', stock: 4 });
    const before = await f.snapshot(), info = (await read()).productInfo;
    expect(info).toMatchObject({ spec_type: 0, sku_repair_required: true, items: [], attrs: [], slider_image: null });
    expect(info.attr).toMatchObject({ pic: '', price: 11.5, cost: 3.25, stock: 4 });
    expect(info.attr).not.toHaveProperty('unique'); expect(info.attr).not.toHaveProperty('id');
    expect(await f.snapshot()).toEqual(before);
  });

  it('refuses ambiguous dimensions rather than resetting spec_type or replacing active identities on GET', async () => {
    await create(); await f.db.update(storeProduct).set({ specType: 1 }); await f.db.delete(storeProductAttr);
    const before = await f.snapshot(); await expect(read()).rejects.toMatchObject({ httpStatus: 409 });
    expect(await f.snapshot()).toEqual(before);
    await f.db.insert(storeProductAttr).values({ productId: 1, type: 0, attrName: '颜色', attrValues: Array.from({ length: 51 }, (_, i) => String(i)).join(',') });
    const oversized = await f.snapshot(); await expect(read()).rejects.toMatchObject({ httpStatus: 409 });
    expect(await f.snapshot()).toEqual(oversized);
  });

  it('returns no historical card credentials, including assigned cards, and roundtrips only current inventory counts', async () => {
    await create({ product_type: 1, attrs: [legacySaveSku({ stock: 2, virtual_list: [{ key: 'K1', value: 'CARD-SECRET-1' }, { key: 'K2', value: 'CARD-SECRET-2' }] })] });
    const cards = await f.db.select().from(storeProductVirtual);
    await f.db.update(storeProductVirtual).set({ uid: 88, orderId: 'issued-card' }).where(eq(storeProductVirtual.id, cards[0].id));
    await f.db.update(storeProductAttrValue).set({ stock: 1 }); await f.db.update(storeProduct).set({ stock: 1 });
    const before = await f.snapshot(), info = (await read()).productInfo;
    expect(info.attr).toMatchObject({ virtual_list: [], virtual_total: 2, virtual_available: 1, stock: 1 });
    expect(JSON.stringify(info)).not.toContain('CARD-SECRET'); expect(JSON.stringify(info)).not.toContain('K1');
    expect(await f.snapshot()).toEqual(before);
    const oldCards = await f.db.select().from(storeProductVirtual);
    await f.service.save(1, oldEditorSaveBody(info), legacySaveActor());
    expect(await f.db.select().from(storeProductVirtual)).toEqual(oldCards);
  });

  it('retains actual fixed delivery for authorized editing, so an unchanged whole-form save cannot erase it', async () => {
    await create({ product_type: 1, attrs: [legacySaveSku({ stock: 3, disk_info: 'FIXED-DELIVERY-CONTENT' })] });
    const info = (await read()).productInfo;
    expect(info.attr).toMatchObject({ disk_info: 'FIXED-DELIVERY-CONTENT', virtual_list: [], stock: 3 });
    await f.service.save(1, oldEditorSaveBody(info), legacySaveActor());
    expect((await f.db.select().from(storeProductAttrValue))[0].diskInfo).toBe('FIXED-DELIVERY-CONTENT');
  });

  it('retains PHP live-template custom_form and formatter while separately exposing the persisted snapshot, including >32KiB form JSON', async () => {
    await create();
    const template = [{ id: 'name', name: 'texts', titleConfig: { value: '姓名' }, tipConfig: { value: '请填写' }, titleShow: { val: true }, value: 'x'.repeat(34000) },
      { id: 'choice', name: 'checkboxs', wordsConfig: { list: [{ val: '选项' }] } }];
    await f.db.insert(systemForm).values({ id: 7, value: JSON.stringify(template), status: 0, isDel: 1 });
    await f.db.update(storeProduct).set({ systemFormId: 7, customForm: '[{"saved":"历史快照"}]' });
    const before = await f.snapshot(), result = await read(), info = result.productInfo;
    expect(info.custom_form).toEqual(template); expect(result.editor.stored_custom_form).toEqual([{ saved: '历史快照' }]);
    expect(info.custom_form_info).toEqual([expect.objectContaining({ id: 'name', type: 'texts', name: '文本框', title: '姓名', tip: '请填写', require: true }),
      { id: 'choice', type: 'checkboxs', name: '多选框', title: '', tip: '', list: [{ val: '选项' }], require: false, value: '' }]);
    expect(await f.snapshot()).toEqual(before);
  });

  it('uses main selections rather than resurrecting stale relations, and resolves referenced inactive label/coupon rows', async () => {
    await create();
    await f.db.insert(userLabel).values([{ id: 8, name: '用户标签八', status: 0 }, { id: 9, name: '用户标签九' }]);
    await f.db.insert(storeProductLabel).values({ id: 6, labelName: '商品标签', status: 0, isShow: 0 });
    await f.db.insert(storeCouponIssue).values({ id: 7, title: '已停用赠券', isDel: 1, status: 0 });
    await f.db.insert(storeProductCoupon).values({ productId: 1, issueCouponId: 7, title: '过期关系标题' });
    await f.db.insert(storeProductRelation).values({ productId: 1, type: 2, relationId: 999 });
    await f.db.update(storeProduct).set({ brandCom: '', labelId: '8,9', storeLabelId: '6' });
    const info = (await read()).productInfo;
    expect(info.brand_id).toEqual([]); expect(info.label_id).toEqual([{ id: 9, label_name: '用户标签九' }, { id: 8, label_name: '用户标签八' }]);
    expect(info.store_label_id).toEqual([{ id: 6, label_name: '商品标签' }]);
    expect(info.coupons).toEqual([{ id: 7, title: '已停用赠券' }]);
  });

  it('returns source platform shipping selectors, including inactive/deleted history, without mixing supplier templates', async () => {
    await create();
    await f.db.insert(shippingTemplates).values([{ id: 2, name: '平台二', sort: 2, status: 0, isDel: 1 }, { id: 3, name: '平台三', sort: 2 },
      { id: 4, name: '供应商模板', ownerType: 2, relationId: 20, sort: 9 }]);
    expect((await read()).tempList).toEqual([{ id: 3, name: '平台三' }, { id: 2, name: '平台二' }]);
  });

  it('formats source conditional scheduled and presale values in Shanghai and expands relative video using the snapshot config', async () => {
    await create(); await f.db.insert(systemConfig).values({ menuName: 'site_url', value: '"https://shop.example"' });
    await f.db.update(storeProduct).set({ presaleStartTime: 1893456000, presaleEndTime: 1893542400, autoOnTime: 1893456000,
      autoOffTime: 1893542400, isShow: 0, videoLink: '/video.mp4' });
    expect((await read()).productInfo).toMatchObject({ presale_time: ['2030-01-01 08:00:00', '2030-01-02 08:00:00'],
      auto_on_time: '2030-01-01 08:00:00', auto_off_time: '', video_link: 'https://shop.example/video.mp4' });
    await f.db.update(storeProduct).set({ isShow: 1 });
    expect((await read()).productInfo).toMatchObject({ auto_on_time: '', auto_off_time: '2030-01-02 08:00:00' });
  });

  it('signs only owned private image/description previews and preserves editable HTML while never signing foreign references', async () => {
    await create();
    await f.db.insert(systemAttachment).values([{ attId: 31, attDir: '/api/assets/31', name: 'attachments/admin/1/read.png', type: 1, relationId: 0,
      moduleType: 1, fileType: 1, imageType: 8, attType: 'image/png' }, { attId: 32, attDir: '/api/assets/32', name: 'attachments/supplier/20/foreign.png', type: 4, relationId: 20,
      moduleType: 1, fileType: 1, imageType: 8, attType: 'image/png' }]);
    const html = '<p data-keep="edit">描述<script>forbidden()</script><img src="/api/assets/31"><img src="/api/assets/32"></p>';
    await f.db.update(storeProduct).set({ image: '/api/assets/31', sliderImage: '["/api/assets/31","/api/assets/32"]' });
    await f.db.update(storeProductDescription).set({ description: html });
    const before = await f.snapshot(), result = await read(), info = result.productInfo;
    expect(info.image).toMatch(/^\/api\/assets\/31\?expires=\d+&signature=/);
    expect((info.slider_image as string[])[1]).toBe(''); expect(info.description).toBe(html);
    expect(result.editor.description_preview).toMatch(/src="\/api\/assets\/31\?expires=\d+&amp;signature=/);
    expect(result.editor.description_preview).not.toContain('/api/assets/32'); expect(result.editor.description_preview).not.toContain('script');
    expect(await f.snapshot()).toEqual(before);
  });

  it('reads deleted products, refuses missing/id0/query and rechecks actual password/role with no mutation', async () => {
    await create(); await f.db.update(storeProduct).set({ isDel: 1, isShow: 0 });
    expect((await read()).productInfo).toMatchObject({ is_del: 1, is_show: 0 });
    const before = await f.snapshot();
    for (const id of [0, 999]) await expect(read(id)).rejects.toThrow('商品不存在');
    await expect(read(1, new URLSearchParams('copy=1'))).rejects.toThrow('查询参数');
    expect(await f.snapshot()).toEqual(before);
    await f.db.update(systemRole).set({ rules: 'order.view' }); const revoked = await f.snapshot();
    await expect(read()).rejects.toThrow('权限'); expect(await f.snapshot()).toEqual(revoked);
    await f.db.update(systemRole).set({ rules: 'product.view' }); await f.db.update(systemAdmin).set({ pwd: 'changed' });
    await expect(read()).rejects.toThrow('凭据');
  });

  it('preserves the actual old physical-store supplier echo and pending owner1/cart branch on read-save', async () => {
    await create(); await f.db.update(storeProduct).set({ type: 1, relationId: 30, pid: 0, isVerify: 0 });
    await f.db.insert(storeCart).values({ productId: 1, uid: 4, status: 1 });
    const info = (await read()).productInfo, body = oldEditorSaveBody(info);
    expect(body.supplier_id).toBe(30);
    await f.service.save(1, body, legacySaveActor());
    expect((await f.db.select().from(storeProduct))[0]).toMatchObject({ type: 1, relationId: 30, isVerify: 0 });
    expect((await f.db.select().from(storeCart))[0].status).toBe(0);
  });

  it('refuses text budgets in SQL before loading a large value and bounds form expansion before mapping fields', async () => {
    await create();
    await f.exec("UPDATE store_product_description SET description=repeat('x',1048577) WHERE product_id=1");
    const oversized = await f.snapshot();
    await expect(read()).rejects.toThrow(/预算|容量/); expect(await f.snapshot()).toEqual(oversized);
    await f.db.update(storeProductDescription).set({ description: '<p>正常</p>' });
    await f.db.insert(systemForm).values({ id: 8, value: JSON.stringify(Array.from({ length: 101 }, () => ({ name: 'texts' }))) });
    await f.db.update(storeProduct).set({ systemFormId: 8 });
    const fields = await f.snapshot(); await expect(read()).rejects.toThrow('100项'); expect(await f.snapshot()).toEqual(fields);
  });
});
