import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createContainerFromDb } from '@/lib/di';
import { storeProduct, storeProductAttrValue, storeProductVirtual, systemAdmin, systemRole, systemMenus, systemAttachment } from '@/models/schema';
import { AdminLegacyProductGenerateService } from '@/services/admin/AdminLegacyProductGenerateService';
import { legacySaveFixture, legacySaveActor, legacySaveBody, legacySaveSku } from './helpers/adminLegacyProductSave';
const dimensions = [{ value: '颜色', detail: ['白', '黑'] }, { value: '尺码', detail: ['S', 'M'] }];
const dimension = [{ value: '规格', detail: ['默认'] }];
const generatorMenu = { id: 191, authType: 2, apiUrl: 'product/generate_attr/<id>/<type>', methods: 'POST',
  menuPath: '/adminproduct/generate_attr/<id>', uniqueAuth: '' };
describe('source legacy generate_attr read-only SKU projection', () => {
  let f: Awaited<ReturnType<typeof legacySaveFixture>>, service: AdminLegacyProductGenerateService;
  beforeAll(async () => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Generator forbids provider I/O'));
    f = await legacySaveFixture(); service = new AdminLegacyProductGenerateService(createContainerFromDb(f.db), 'generator-fixture-key'); }, 30000);
  beforeEach(async () => { await f.seed(); await f.db.insert(systemMenus).values(generatorMenu); });
  afterAll(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); } });
  const generate = (id = 0, mode: 0 | 1 | 2 = 1, body: unknown = { attrs: dimensions }) => service.generate(id, mode, body, legacySaveActor());
  const seedProduct = (type = 0) => f.service.save(0, legacySaveBody({ product_type: type }), legacySaveActor());

  it('generates source-ordered Cartesian templates and headers without identities, business writes or client-supplied SKU values', async () => {
    const before = await f.snapshot(), result = await generate(0, 1, { attrs: dimensions, items: [{ price: 999, stock: 99 }], type: 2, relation_id: 50 });
    expect(result.info).toMatchObject({ attr: dimensions, product_type: 0 });
    expect(result.info.value.map(row => row.values)).toEqual(['白,S', '白,M', '黑,S', '黑,M']);
    expect(result.info.value[0]).toMatchObject({ detail: { 颜色: '白', 尺码: 'S' }, value1: '白', value2: 'S', pic: '', price: 0, stock: 0 });
    for (const row of result.info.value) for (const key of ['id', 'unique', 'suk']) expect(row).not.toHaveProperty(key);
    expect(result.info.header.map(row => row.slot)).toEqual(['value1', 'value2', 'pic', 'price', 'cost', 'ot_price', 'stock', 'bar_code', 'code', 'weight', 'volume', 'action']);
    expect(await f.snapshot()).toEqual(before);
  });

  it('keeps empty attrs as an explicit empty projection and fixed headers for the old single-spec automatic call', async () => {
    const before = await f.snapshot();
    for (const mode of [0, 1, 2] as const) {
      expect((await generate(0, mode, { attrs: [] })).info).toMatchObject({ attr: [], value: [], product_type: 0 });
      expect((await generate(0, mode, {})).info.header[0]).toMatchObject({ slot: 'pic' });
    }
    expect(await f.snapshot()).toEqual(before);
  });

  it('uses authoritative parent type and owner, returns current matched fields, and skips missing combinations only in mode0', async () => {
    await seedProduct();
    await f.db.update(storeProduct).set({ type: 2, relationId: 55, isDel: 1, customForm: 'unused text' }).where(eq(storeProduct.id, 1));
    await f.db.update(storeProductAttrValue).set({ suk: '白,S', price: '15.25', settlePrice: '7.00', stock: 9, barCode: 'SKU-BAR' });
    const before = await f.snapshot(), edit = (await generate(1, 0, { attrs: dimensions, product_type: 1 })).info;
    expect(edit.product_type).toBe(0); expect(edit.value).toHaveLength(1);
    expect(edit.value[0]).toMatchObject({ values: '白,S', price: 15.25, settle_price: 7, stock: 9, bar_code: 'SKU-BAR' });
    expect(edit.header.map(row => row.slot)).toContain('settle_price'); expect(edit.header.map(row => row.slot)).toContain('weight');
    for (const mode of [1, 2] as const) {
      const info = (await generate(1, mode, { attrs: dimensions, product_type: 3 })).info;
      expect(info.value).toHaveLength(4); expect(info.value[0].price).toBe(15.25); expect(info.value[1]).toMatchObject({ price: 0, stock: 0 });
    }
    expect(await f.snapshot()).toEqual(before);
  });

  it('omits dimension headers when mode0 matches no SKU and never resurrects a retired or activity SKU', async () => {
    await seedProduct(); await f.db.update(storeProductAttrValue).set({ isRetired: 1 });
    await f.db.insert(storeProductAttrValue).values({ productId: 1, type: 1, unique: 'activity', suk: '白,S', price: '999.00' });
    const before = await f.snapshot(), info = (await generate(1, 0)).info;
    expect(info.value).toEqual([]); expect(info.header[0].slot).toBe('pic');
    expect((await generate(1, 1)).info.value.every(row => row.price === 0)).toBe(true);
    expect(await f.snapshot()).toEqual(before);
  });

  it('excludes card credentials, retains fixed delivery only for edit mode, and treats mode1/2 as generation rather than trusted copies', async () => {
    await f.service.save(0, legacySaveBody({ product_type: 1, attrs: [legacySaveSku({ stock: 4, disk_info: 'FIXED-ORIGINAL' })] }), legacySaveActor());
    const [sku] = await f.db.select().from(storeProductAttrValue);
    await f.db.insert(storeProductVirtual).values([{ productId: 1, attrUnique: sku.unique, uid: 0, cardNo: 'CARD-NO-FIXTURE', cardPwd: 'CARD-SECRET-FIXTURE' },
      { productId: 1, attrUnique: sku.unique, uid: 88, cardNo: 'ASSIGNED-CARD-FIXTURE', cardPwd: 'ASSIGNED-SECRET-FIXTURE' }]);
    const before = await f.snapshot(), edit = (await generate(1, 0, { attrs: dimension })).info;
    expect(edit.value[0]).toMatchObject({ disk_info: 'FIXED-ORIGINAL', virtual_list: [], virtual_available: 1, virtual_total: 2 });
    for (const mode of [1, 2] as const) {
      const info = (await generate(1, mode, { attrs: dimension })).info;
      expect(info.value[0]).not.toHaveProperty('disk_info'); expect(info.value[0]).not.toHaveProperty('virtual_list');
      expect(JSON.stringify(info)).not.toContain('FIXED-ORIGINAL');
    }
    expect(JSON.stringify(edit)).not.toMatch(/CARD-NO-FIXTURE|CARD-SECRET-FIXTURE|ASSIGNED-CARD-FIXTURE|ASSIGNED-SECRET-FIXTURE/);
    expect(await f.snapshot()).toEqual(before);
  });

  it('preserves actual second-card columns and Shanghai day boundaries instead of copying the source omitted-select reset', async () => {
    await f.service.save(0, legacySaveBody({ product_type: 4, attrs: [legacySaveSku({ write_times: 8, write_valid: 3,
      section_time: ['2030-01-01', '2030-02-01'] })] }), legacySaveActor());
    const before = await f.snapshot();
    for (const mode of [0, 1, 2] as const) expect((await generate(1, mode, { attrs: dimension })).info.value[0])
      .toMatchObject({ write_times: 8, write_valid: 3, days: 0, section_time: ['2030-01-01', '2030-02-01'] });
    expect((await generate(0, 1, { attrs: dimension, product_type: 4 })).info.value[0])
      .toMatchObject({ write_times: 1, write_valid: 1, days: 0, section_time: ['', ''] });
    await expect(generate(1, 1, { attrs: dimensions })).rejects.toThrow('单规格'); expect(await f.snapshot()).toEqual(before);
  });

  it('signs only SKU images authorized by the actual parent owner', async () => {
    await seedProduct();
    await f.db.insert(systemAttachment).values([{ attId: 81, attDir: '/api/assets/81', name: 'attachments/admin/1/own.png', type: 1,
      relationId: 0, moduleType: 1, fileType: 1, imageType: 8, attType: 'image/png' },
      { attId: 82, attDir: '/api/assets/82', name: 'attachments/supplier/99/foreign.png', type: 4,
        relationId: 99, moduleType: 1, fileType: 1, imageType: 8, attType: 'image/png' }]);
    await f.db.update(storeProductAttrValue).set({ image: '/api/assets/81' });
    expect((await generate(1, 0, { attrs: dimension })).info.value[0].pic).toMatch(/^\/api\/assets\/81\?expires=/);
    await f.db.update(storeProductAttrValue).set({ image: '/api/assets/82' });
    expect((await generate(1, 0, { attrs: dimension })).info.value[0].pic).toBe('');
  });

  it('rejects ambiguous active rows and oversized raw SKU text before a partial projection', async () => {
    await seedProduct(); await f.db.insert(storeProductAttrValue).values({ productId: 1, unique: 'other000', suk: '默认' });
    let before = await f.snapshot(); await expect(generate(1, 0, { attrs: dimension })).rejects.toThrow('歧义'); expect(await f.snapshot()).toEqual(before);
    await f.db.delete(storeProductAttrValue).where(eq(storeProductAttrValue.unique, 'other000'));
    await f.exec("UPDATE store_product_attr_value SET disk_info=repeat('x',1048577)");
    before = await f.snapshot(); await expect(generate(1, 0, { attrs: dimension })).rejects.toThrow('容量'); expect(await f.snapshot()).toEqual(before);
  });

  it('rejects malformed dimensions and checks combination capacity before expansion', async () => {
    const before = await f.snapshot();
    const bodies: unknown[] = [null, [], { attrs: {} }, { attrs: [{ value: 'a', detail: [] }] },
      { attrs: [{ value: 'a', detail: ['x,x'] }] }, { attrs: [{ value: '__proto__', detail: ['x'] }] },
      { attrs: [{ value: 'a', detail: ['x', ' x '] }] }, { product_type: 2 },
      { attrs: Array.from({ length: 4 }, (_v, index) => ({ value: String(index), detail: ['x'] })) },
      { attrs: Array.from({ length: 3 }, (_v, index) => ({ value: String(index), detail: Array.from({ length: 6 }, (_w, part) => String(part)) })) }];
    for (const body of bodies) await expect(generate(0, 1, body)).rejects.toThrow();
    expect(await f.snapshot()).toEqual(before);
  });

  it('requires live narrow generator permission and refuses disabled, password-stale and revoked actors without mutation', async () => {
    await f.db.update(systemRole).set({ rules: '191' }); const before = await f.snapshot();
    expect((await generate()).info.value).toHaveLength(4); expect(await f.snapshot()).toEqual(before);
    for (const rules of ['620', 'product.view', 'order.view', '']) {
      await f.db.update(systemRole).set({ rules }); await expect(generate()).rejects.toThrow('权限');
    }
    await f.db.update(systemRole).set({ rules: '191' }); await f.db.update(systemAdmin).set({ status: 0 }); await expect(generate()).rejects.toThrow('身份');
    await f.db.update(systemAdmin).set({ status: 1, pwd: 'changed' }); await expect(generate()).rejects.toThrow('凭据');
  });

  it('does not require irrelevant main text fields for generation, but refuses missing products and invalid paths', async () => {
    await seedProduct(); await f.exec("UPDATE store_product SET custom_form=repeat('x',1048577)");
    const before = await f.snapshot(); expect((await generate(1, 0, { attrs: dimension })).info.value).toHaveLength(1);
    await expect(generate(999)).rejects.toThrow('不存在'); await expect(generate(-1)).rejects.toThrow('ID');
    expect(await f.snapshot()).toEqual(before);
  });
});
