import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { integralBatchActor, integralBatchFixture } from './helpers/integralBatchFixture';
import { outcome } from './helpers/financePeers';
import { storeIntegral, storeProduct, storeProductAttrValue, storeProductAttr,
  storeProductDescription, systemSupplier,
  systemStore, shippingTemplates } from '../src/models/schema';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('native Admin integral multi-product bulk contract', () => {
  let f: Awaited<ReturnType<typeof integralBatchFixture>>;
  beforeEach(async () => { f = await integralBatchFixture(); }, 30_000);
  afterEach(async () => { vi.restoreAllMocks(); await f?.close(); }, 30_000);

  it('creates two complete type-4 graphs in one submission and preserves source stock and metadata', async () => {
    const before = await f.snapshot(), input = await f.input();
    input.products[0].skus[1].image = '/api/assets/41';
    const receipt = await f.serviceFor().create(input, integralBatchActor);
    expect(receipt).toMatchObject({ request_id: input.request_id, count: 2, is_show: 1,
      products: [{ product_id: 70, integral_id: expect.any(Number) }, { product_id: 72, integral_id: expect.any(Number) }] });
    expect(receipt.payload_hash).toMatch(/^[a-f0-9]{64}$/);
    const after = await f.snapshot();
    expect(after.products).toEqual(before.products);
    expect(after.skus.filter(s => s.type === 0)).toEqual(before.skus);
    expect(after.integrals).toHaveLength(2);
    const first = after.integrals.find(s => s.productId === 70)!;
    const second = after.integrals.find(s => s.productId === 72)!;
    expect(first).toMatchObject({ storeName: '批量商品甲', productId: 70, type: 0,
      relationId: 0, productType: 0, unitName: '件', stock: 20, quota: 13, quotaShow: 13,
      integral: 5, price: '9.00', num: 0, onceNum: 0, isShow: 1, status: 1,
      freight: 1, postage: '0.00', tempId: 0, deliveryType: '1',
      customForm: '[]', systemFormId: 0, storeLabelId: '21', ensureId: '31',
      specs: '[{"name":"产地","value":"本地"}]' });
    expect(second).toMatchObject({ productId: 72, stock: 10, quota: 5, quotaShow: 5,
      freight: 2, postage: '3.00', tempId: 0, num: 0, onceNum: 0 });
    const created = after.skus.filter(s => s.type === 4);
    expect(created).toHaveLength(3);
    expect(created.find(s => s.productId === first.id && s.suk === '红')).toMatchObject({
      price: '9.00', integral: 5, stock: 8, sumStock: 8, quota: 5, quotaShow: 5,
      cost: '2.00', settlePrice: '2.50', weight: '0.25', volume: '0.10',
      barCode: 'SOURCE-RED', code: 'SOURCE-70-RED', image: '/images/source-red.png' });
    expect(created.find(s => s.productId === first.id && s.suk === '蓝')).toMatchObject({
      price: '4.25', integral: 10, stock: 12, quota: 8, image: '/api/assets/41', cost: '4.00' });
    expect(new Set(created.map(s => s.unique)).size).toBe(3);
    for (const s of created) {
      expect(s.unique).toMatch(/^[a-zA-Z0-9]{8}$/);
      expect(before.skus.some(base => base.unique === s.unique)).toBe(false);
    }
    expect(after.attrs.filter(a => a.type === 4)).toMatchObject([
      { productId: first.id, attrName: '颜色', attrValues: '红,蓝' },
      { productId: second.id, attrName: '规格', attrValues: '默认' },
    ]);
    for (const root of after.integrals) {
      expect(after.descriptions.find(d => d.type === 4 && d.productId === root.id)?.description)
        .toBe(`<p>源商品${root.productId}详情</p>`);
      const cache = after.results.find(r => r.type === 4 && r.productId === root.id);
      expect(cache).toBeDefined();
      const value = JSON.parse(cache!.result) as { attr: unknown[]; value: unknown[] };
      expect(value.attr).toHaveLength(1);
      expect(value.value).toHaveLength(root.productId === 70 ? 2 : 1);
    }
    expect(after.logs).toHaveLength(3);
    expect(after.logs.every(log => log.adminId === integralBatchActor.id)).toBe(true);
    expect(await f.serviceFor().receipt(input.request_id, integralBatchActor)).toEqual(receipt);
  });

  it('keeps existing active integral graphs intact and creates a separate new graph for the same source', async () => {
    await f.db.insert(storeIntegral).values({ id: 777, productId: 70, storeName: '原积分活动不可覆盖',
      integral: 99, stock: 6, quota: 6, status: 1, isShow: 1, num: -1, onceNum: -1 });
    await f.db.insert(storeProductAttrValue).values({ id: 777, productId: 777, type: 4,
      unique: 'old00777', suk: '红', price: '1.00', integral: 99, stock: 6, quota: 6 });
    await f.exec("SELECT setval(pg_get_serial_sequence('store_integral','id'),777,true)");
    await f.exec("SELECT setval(pg_get_serial_sequence('store_product_attr_value','id'),777,true)");
    const old = (await f.snapshot()).integrals[0], oldSku = (await f.snapshot()).skus.find(s => s.id === 777);
    const result = await f.serviceFor().create(await f.input([70]), integralBatchActor);
    expect(result.products[0].integral_id).not.toBe(777);
    expect((await f.db.select().from(storeIntegral).where(eq(storeIntegral.id, 777)))[0]).toEqual(old);
    expect((await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 777)))[0]).toEqual(oldSku);
    expect((await f.snapshot()).integrals).toHaveLength(2);
  });

  it('replays committed UUIDs after source drift or SKU retirement without creating new graphs', async () => {
    const input = await f.input(), result = await f.serviceFor().create(input, integralBatchActor);
    await f.db.update(storeProduct).set({ storeName: '源名已改变', stock: 1 }).where(eq(storeProduct.id, 70));
    await f.db.update(storeProductAttrValue).set({ isRetired: 1 }).where(eq(storeProductAttrValue.id, 1));
    const before = await f.snapshot();
    expect(await f.serviceFor().create(input, integralBatchActor)).toEqual(result);
    expect(await f.serviceFor().receipt(input.request_id, integralBatchActor)).toEqual(result);
    expect(await f.snapshot()).toEqual(before);
    const changed = structuredClone(input); changed.products[0].skus[0].quota = 4;
    expect((await outcome(f.serviceFor().create(changed, integralBatchActor))).ok).toBe(false);
    expect(await f.snapshot()).toEqual(before);
  });

  it('isolates receipts and request replay from a different Admin actor', async () => {
    const input = await f.input(); await f.serviceFor().create(input, integralBatchActor);
    const before = await f.snapshot();
    for (const action of [() => f.serviceFor().receipt(input.request_id, { id: 8 }),
      () => f.serviceFor().create(input, { id: 8 })]) expect((await outcome(action())).ok).toBe(false);
    expect(await f.snapshot()).toEqual(before);
    expect((await outcome(f.serviceFor().receipt(crypto.randomUUID(), integralBatchActor))).ok).toBe(false);
  });

  it.each(['last-group', 'receipt'] as const)('rolls back every new root, SKU, dimension, description and log after %s SQL failure', async failure => {
    const input = await f.input();
    const condition = failure === 'last-group' ? "TG_TABLE_NAME='store_integral' AND NEW.product_id=72"
      : "TG_TABLE_NAME='system_log' AND NEW.path='/activity/integral-batch/request/" + input.request_id + "'";
    const table = failure === 'last-group' ? 'store_integral' : 'system_log';
    await f.exec(`CREATE FUNCTION integral_batch_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF ${condition} THEN RAISE EXCEPTION 'test-owned integral batch late failure'; END IF; RETURN NEW; END $$`);
    await f.exec(`CREATE TRIGGER integral_batch_failure BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION integral_batch_failure()`);
    const before = await f.snapshot();
    const result = await outcome(f.serviceFor().create(input, integralBatchActor));
    expect(result).toMatchObject({ ok: false });
    const errors: string[] = [];
    for (let error = result.ok ? undefined : result.error; error; error = error.cause) errors.push(String(error));
    expect(errors.join('\n')).toContain('test-owned integral batch late failure');
    expect(await f.snapshot()).toEqual(before);
    await f.exec(`DROP TRIGGER integral_batch_failure ON ${table}`);
    await f.exec('DROP FUNCTION integral_batch_failure()');
    expect((await f.serviceFor().create(input, integralBatchActor)).count).toBe(2);
    expect((await f.snapshot()).integrals).toHaveLength(2);
  });

  it.each(['product-price', 'sku-stock', 'description', 'dimension'] as const)('rejects stale revision after %s changes without partial batch writes', async change => {
    const input = await f.input();
    if (change === 'product-price') await f.db.update(storeProduct).set({ price: '11.00' }).where(eq(storeProduct.id, 72));
    if (change === 'sku-stock') await f.db.update(storeProductAttrValue).set({ stock: 9 }).where(eq(storeProductAttrValue.id, 82));
    if (change === 'description') await f.db.update(storeProductDescription).set({ description: '<p>changed</p>' })
      .where(and(eq(storeProductDescription.productId, 72), eq(storeProductDescription.type, 0)));
    if (change === 'dimension') await f.db.update(storeProductAttr).set({ attrValues: '默认,新规格' })
      .where(and(eq(storeProductAttr.productId, 72), eq(storeProductAttr.type, 0)));
    const before = await f.snapshot();
    expect((await outcome(f.serviceFor().create(input, integralBatchActor))).ok).toBe(false);
    expect(await f.snapshot()).toEqual(before);
  });

  it.each(['hidden', 'deleted', 'unverified', 'vip', 'presale', 'retired', 'unknown-sku', 'sku-quota', 'root-quota'] as const)
    ('refuses %s sources and quantity conflicts atomically', async mutation => {
      const input = await f.input();
      if (mutation === 'hidden') await f.db.update(storeProduct).set({ isShow: 0 }).where(eq(storeProduct.id, 72));
      if (mutation === 'deleted') await f.db.update(storeProduct).set({ isDel: 1 }).where(eq(storeProduct.id, 72));
      if (mutation === 'unverified') await f.db.update(storeProduct).set({ isVerify: 0 }).where(eq(storeProduct.id, 72));
      if (mutation === 'vip') await f.db.update(storeProduct).set({ isVipProduct: 1 }).where(eq(storeProduct.id, 72));
      if (mutation === 'presale') await f.db.update(storeProduct).set({ isPresaleProduct: 1 }).where(eq(storeProduct.id, 72));
      if (mutation === 'retired') await f.db.update(storeProductAttrValue).set({ isRetired: 1 }).where(eq(storeProductAttrValue.id, 82));
      if (mutation === 'unknown-sku') input.products[1].skus[0].base_unique = 'absent00';
      if (mutation === 'sku-quota') input.products[1].skus[0].quota = 11;
      if (mutation === 'root-quota') {
        await f.db.update(storeProduct).set({ stock: 10 }).where(eq(storeProduct.id, 70));
        input.products[0].revision = (await f.serviceFor().source(70)).revision;
      }
      const before = await f.snapshot();
      expect((await outcome(f.serviceFor().create(input, integralBatchActor))).ok).toBe(false);
      expect(await f.snapshot()).toEqual(before);
    });

  it.each([0, 1, 2] as const)('supports lawful source owner %s and inherits exact shipping/product metadata', async type => {
    const relationId = type === 0 ? 0 : type === 1 ? 11 : 7;
    await f.db.update(shippingTemplates).set({ ownerType: type, relationId }).where(eq(shippingTemplates.id, 10));
    await f.db.update(storeProduct).set({ type, relationId, freight: 3, tempId: 10,
      deliveryType: '1,2', postage: '1.25' }).where(eq(storeProduct.id, 72));
    const result = await f.serviceFor().create(await f.input([72]), integralBatchActor);
    expect((await f.db.select().from(storeIntegral).where(eq(storeIntegral.id, result.products[0].integral_id)))[0])
      .toMatchObject({ type, relationId, productId: 72, freight: 3, tempId: 10,
        deliveryType: '1,2', postage: '1.25', num: 0, onceNum: 0 });
  });

  it('creates separate store and supplier replica graphs using their source IDs and lawful owner media', async () => {
    await f.db.update(storeProduct).set({ type: 2, relationId: 7, pid: 70 }).where(eq(storeProduct.id, 72));
    await f.db.update(storeProduct).set({ pid: 70 }).where(eq(storeProduct.id, 73));
    const input = await f.input([72, 73]);
    input.products[0].skus[0].image = '/api/assets/43';
    const result = await f.serviceFor().create(input, integralBatchActor);
    expect(result.products.map(row => row.product_id)).toEqual([72, 73]);
    const after = await f.snapshot();
    expect(after.integrals.find(row => row.productId === 72)).toMatchObject({
      type: 2, relationId: 7, productId: 72, freight: 2, postage: '3.00' });
    expect(after.integrals.find(row => row.productId === 73)).toMatchObject({
      type: 1, relationId: 11, productId: 73, freight: 3, tempId: 11, deliveryType: '1,2' });
    expect(after.skus.find(row => row.type === 4 && row.productId === result.products[0].integral_id)?.image).toBe('/api/assets/43');
  });

  it.each(['platform-foreign', 'store-missing', 'store-hidden', 'supplier-missing', 'supplier-deleted'] as const)
    ('refuses unlawful or unavailable %s owners', async owner => {
      if (owner === 'platform-foreign') await f.db.update(storeProduct).set({ type: 0, relationId: 7 }).where(eq(storeProduct.id, 72));
      if (owner.startsWith('store')) {
        await f.db.update(storeProduct).set({ type: 1, relationId: owner === 'store-missing' ? 999 : 11 }).where(eq(storeProduct.id, 72));
        if (owner === 'store-hidden') await f.db.update(systemStore).set({ isShow: 0 }).where(eq(systemStore.id, 11));
      }
      if (owner.startsWith('supplier')) {
        await f.db.update(storeProduct).set({ type: 2, relationId: owner === 'supplier-missing' ? 999 : 7 }).where(eq(storeProduct.id, 72));
        if (owner === 'supplier-deleted') await f.db.update(systemSupplier).set({ isDel: 1 }).where(eq(systemSupplier.id, 7));
      }
      const before = await f.snapshot();
      const invalid = await f.serviceFor().source(72);
      expect(invalid.product.valid).toBe(false);
      expect((await outcome(f.serviceFor().create({ request_id: crypto.randomUUID(), is_show: 1,
        products: [{ product_id: 72, revision: invalid.revision, skus: [{ base_unique: 'base0072', price: '1.00', integral: 5, quota: 1, image: '/images/source-72.png' }] }] }, integralBatchActor))).ok).toBe(false);
      expect(await f.snapshot()).toEqual(before);
    });

  it('offers bounded searchable multi-product candidates with real category and hidden-label relations', async () => {
    const result = await f.serviceFor().candidates(new URLSearchParams('category_id=20&label_id=22&page=1&limit=15'));
    expect(result.count).toBe(1);
    expect(result.list.map(row => row.id)).toEqual([70]);
    expect(result.categories).toEqual(expect.arrayContaining([{ id: 20, pid: 0, cate_name: '批量根分类' }, { id: 21, pid: 20, cate_name: '批量子分类' }]));
    expect(result.labels).toEqual(expect.arrayContaining([{ id: 22, label_name: '批量隐藏标签', status: 0, is_show: 0 }]));
    expect((await f.serviceFor().candidates(new URLSearchParams('keyword=批量商品乙'))).list.map(row => row.id)).toEqual([72]);
    expect((await f.serviceFor().candidates(new URLSearchParams('page=9'))).list).toEqual([]);
    const source = await f.serviceFor().source(70);
    expect(source.product).toMatchObject({ id: 70, category_name: '批量子分类', stock: 20 });
    expect(source.skus).toHaveLength(2);
    expect(source.revision).toMatch(/^[a-f0-9]{64}$/);
  });

  it('normalizes a legacy short char(8) source unique and retains a zero-price positive-points SKU with positive quota', async () => {
    await f.db.update(storeProductAttrValue).set({ unique: 'q72' }).where(eq(storeProductAttrValue.id, 82));
    const source = await f.serviceFor().source(72);
    expect(source.skus[0].base_unique).toBe('q72');
    const input = await f.input([72]);
    Object.assign(input.products[0].skus[0], { price: '0.00', integral: 5, quota: 1 });
    const created = await f.serviceFor().create(input, integralBatchActor);
    expect((await f.db.select().from(storeProductAttrValue).where(and(eq(storeProductAttrValue.type, 4),
      eq(storeProductAttrValue.productId, created.products[0].integral_id))))[0])
      .toMatchObject({ price: '0.00', integral: 5, quota: 1 });
    expect((await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 82)))[0].unique.trimEnd()).toBe('q72');
  });
});
