import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { storeProduct, storeProductAttrValue, storeProductRelation, systemAdmin, systemRole, systemMenus,
  systemAttachment, systemSupplier } from '@/models/schema';
import { AdminPermissionService } from '@/services/admin/AdminPermissionService';
import { AdminProductCatalogReadService } from '@/services/admin/AdminProductCatalogReadService';
import { catalogReadFixture, seedCatalogReads, catalogReadActor, catalogReadMenus,
  catalogReadDefaultIds, catalogReadStateIds, catalogReadHeaderNames, catalogReadHeaderTypes, catalogReadPageMenu,
  catalogReadSnapshot, seedCatalogPrivatePictures } from './helpers/adminProductCatalogReads';

type Data = { count: number; list: Array<Record<string, unknown> & { id: number }> };
const query = (value = '') => new URLSearchParams(value);
const ids = (data: Data) => data.list.map(row => row.id).sort((a, b) => a - b);

describe('source Admin main catalogue index/type_header complete SQL read contracts', () => {
  let f: Awaited<ReturnType<typeof catalogReadFixture>>;
  beforeAll(async () => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Catalogue contracts forbid remote I/O'));
    f = await catalogReadFixture('catalog-contract-key'); }, 30000);
  beforeEach(async () => { await f.reset(); await seedCatalogReads(f.db); }, 30000);
  afterAll(async () => { try { expect(fetch).not.toHaveBeenCalled(); }
    finally { vi.restoreAllMocks(); await f?.close(); } }, 30000);
  const list = async (value = '', id = 120) => f.service.list(query(value), catalogReadActor(id)) as unknown as Promise<Data>;
  const header = (value = '', id = 120) => f.service.header(query(value), catalogReadActor(id));

  it('defaults to approved shown pid0 products across platform/store/Supplier owners and keeps the selector separate', async () => {
    const before = await catalogReadSnapshot(f.db), data = await list();
    expect(ids(data)).toEqual(catalogReadDefaultIds); expect(data.count).toBe(9);
    expect(data.list.map(row => row.id).slice(0, 2)).toEqual([10, 20]);
    for (const row of data.list) { expect(row).not.toHaveProperty('attrValue'); expect(row).not.toHaveProperty('description'); }
    expect(await catalogReadSnapshot(f.db)).toEqual(before);
  });

  it('remaps source request type to status and preserves every state including textual zero, recycle/deleted rejected and forced-off records', async () => {
    const before = await catalogReadSnapshot(f.db);
    for (const [type, expected] of catalogReadStateIds) {
      const data = await list(`type=${type}&page=1&limit=100`);
      expect(ids(data), `source status ${type}`).toEqual(expected); expect(data.count).toBe(expected.length);
    }
    expect(ids(await list('type='))).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 21, 26, 27, 30]);
    expect(await catalogReadSnapshot(f.db)).toEqual(before);
  });

  it('filters sold-out by original main stock OR marker, but projects all ordinary SKU stock including retired rows and nullable no-SKU sums', async () => {
    const all = await list(), platform = all.list.find(row => row.id === 10)!;
    expect(platform).toMatchObject({ stock: 11, branch_stock: 11, branch_sales: 7, sales: 7, ficti: 900,
      collect: 2, likes: 1, visitor: 2, stock_attr: true });
    expect(all.list.find(row => row.id === 21)).toMatchObject({ stock: null, branch_stock: 0, stock_attr: false });
    const sold = await list('type=4'); expect(ids(sold)).toEqual([12, 13]);
    expect(sold.list.find(row => row.id === 13)).toMatchObject({ stock: 5, stock_attr: true });
    expect(sold.list.find(row => row.id === 12)).toMatchObject({ stock: null, stock_attr: false });
    expect(platform.collect).not.toBe(999); expect(platform.visitor).not.toBe(1001);
  });

  it('retains stock-police products above configured threshold and counts fixed header states in exact source order', async () => {
    expect(ids(await list('type=5'))).toEqual([14]);
    const value = await header();
    expect(value.list.map(row => row.type)).toEqual(catalogReadHeaderTypes);
    expect(value.list.map(row => row.name)).toEqual(catalogReadHeaderNames);
    expect(value.list.map(row => row.count)).toEqual([9, 1, 2, 1, 3, 1, 1, 1]);
    expect(await header('type=0')).toEqual(value);
  });

  it('preserves main list store_id no-op, Supplier includes copies and header conflicting store+Supplier searchers yield zero', async () => {
    expect(await list('store_id=30')).toEqual(await list());
    const supplier = await list('supplier_id=20'); expect(ids(supplier)).toEqual([19, 20]); expect(supplier.count).toBe(2);
    const fallback = await f.db.select({ settlePrice: storeProductAttrValue.settlePrice }).from(storeProductAttrValue)
      .where(and(eq(storeProductAttrValue.productId, 20), eq(storeProductAttrValue.type, 0)));
    expect(fallback).toHaveLength(2);
    expect(supplier.list.find(row => row.id === 20)).toMatchObject({ plate_name: '供应商：源供应商名称', settle_price: fallback.at(-1)!.settlePrice });
    expect((await header('store_id=30')).list.map(row => row.count)).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect((await header('store_id=30&supplier_id=20')).list.map(row => row.count)).toEqual(Array(8).fill(0));
  });

  it('preserves category count/list asymmetry including ignored keyword/pid/Supplier/brand/label and missing verify condition', async () => {
    const filtered = await list('cate_id=2&store_name=missing&supplier_id=20&brand_id=99&store_label_id=99');
    expect(filtered).toMatchObject({ count: 4, list: [] });
    expect(await list('cate_id=2')).toMatchObject({ count: 4 });
    expect(ids(await list('cate_id=2'))).toEqual([10, 20]);
    const states = await header('cate_id=2&store_name=missing&store_id=30&supplier_id=20');
    expect(states.list.map(row => row.count)).toEqual([4, 0, 0, 0, 0, 1, 0, 0]);
    expect(await list('cate_id=2&type=3')).toMatchObject({ count: 4 });
  });

  it('preserves the category count sold-out AND anomaly rather than replacing the source count with the list predicate', async () => {
    await f.db.insert(storeProductRelation).values([
      { id: 20, productId: 12, type: 1, relationId: 2 }, { id: 21, productId: 13, type: 1, relationId: 2 },
    ]);
    const before = await catalogReadSnapshot(f.db), value = await list('cate_id=2&type=4');
    expect(value.count).toBe(0); expect(ids(value)).toEqual([12, 13]);
    expect((await header('cate_id=2')).list.find(row => row.type === 4)?.count).toBe(0);
    expect(await catalogReadSnapshot(f.db)).toEqual(before);
    await f.db.update(storeProduct).set({ isSold: 1 }).where(eq(storeProduct.id, 13));
    expect((await list('cate_id=2&type=4')).count).toBe(1);
  });

  it('searches source main fields and any exact SKU barcode, retains LIKE wildcards and PHP false string zero', async () => {
    for (const term of ['钢材关键词', '简介搜索', 'main-code', 'activity-code', '10']) {
      const data = await list(`store_name=${encodeURIComponent(term)}`); expect(ids(data)).toEqual([10]); expect(data.count).toBe(1);
    }
    expect(ids(await list('store_name=0'))).toEqual(catalogReadDefaultIds);
    expect((await list('store_name=%25')).count).toBe(9);
    expect((await list('brand_id%5B%5D=5')).list.map(row => row.id)).toEqual([10]);
    expect((await list('store_label_id%5B%5D=6')).list.map(row => row.id)).toEqual([20]);
    expect(ids(await list('cate_id%5B%5D=0&cate_id%5B%5D=2&cate_id%5B%5D=2'))).toEqual([10, 20]);
  });

  it('returns source category parent/child names and current nondeleted owner names without inventing owner labels from IDs', async () => {
    const data = await list();
    expect(data.list.find(row => row.id === 10)).toMatchObject({ cate_name: '根分类/子分类', plate_name: '平台' });
    expect(data.list.find(row => row.id === 20)).toMatchObject({ cate_name: '根分类/子分类', plate_name: '供应商：源供应商名称' });
    expect(data.list.find(row => row.id === 30)).toMatchObject({ cate_name: '隐藏孩子仍可显示', plate_name: '门店：源门店名称' });
    expect(data.list.find(row => row.id === 26)).toMatchObject({ plate_name: '供应商：' });
    expect(data.list.find(row => row.id === 27)).toMatchObject({ plate_name: '门店：' });
    expect(data.list.find(row => row.id === 10)).toMatchObject({ slider_image: ['/uploads/one.png'],
      custom_form: { named: '历史对象表单' }, specs: { parameter: '历史对象参数' } });
  });

  it('uses source sales then sort/id order and resets a requested later page when count is at most limit including the empty result', async () => {
    expect((await list('sales=desc')).list.map(row => row.id).slice(0, 3)).toEqual([10, 30, 20]);
    expect((await list('sales=asc')).list.map(row => row.id).slice(-3)).toEqual([20, 30, 10]);
    expect(await list('page=2&limit=15')).toEqual(await list('page=1&limit=15'));
    expect(await list('page=2&limit=1&store_name=20')).toEqual(await list('page=1&limit=1&store_name=20'));
    expect(await list('page=2&limit=1&store_name=missing')).toEqual({ list: [], count: 0 });
    const page = await list('page=2&limit=2'); expect(page.count).toBe(9); expect(page.list).toHaveLength(2);
    expect(page.list.map(row => row.id)).toEqual([30, 27]);
  });

  it('preserves missing/zero paging as complete reads, a missing limit or page as source unpaged, and the source clamp above 100', async () => {
    const full = await list();
    for (const value of ['page=0&limit=2', 'page=2&limit=0', 'page=2', 'limit=2', 'page=0&limit=0'])
      expect(await list(value)).toEqual(full);
    expect(await list('page=1&limit=101')).toEqual(await list('page=1&limit=100'));
    expect(await header('page=2&limit=0&sales=desc&excel=0')).toEqual(await header());
  });

  it('resolves genuine 108 and 192 to view-only in both single/batch resolution while copied and wildcard claims cannot mint catalogue access', async () => {
    const permissions = new AdminPermissionService(f.container), inputs = ['108', '192', '2', '998', '997', '996', '579', '580'];
    expect(await permissions.resolveManyRulePermissionKeys(inputs)).toEqual([['product.view'], ['product.view'], ['product.view'], [], [], [], [], []]);
    for (const [index, source] of inputs.entries()) expect(await permissions.resolveRulePermissionKeys(source))
      .toEqual(index < 3 ? ['product.view'] : []);
    for (const id of [120, 121, 122, 128, 129]) { expect((await list('', id)).count).toBe(9); expect((await header('', id)).list).toHaveLength(8); }
    for (const id of [123, 124, 125, 126, 127, 130]) {
      await expect(list('', id)).rejects.toThrow('权限'); await expect(header('', id)).rejects.toThrow('权限');
    }
  });

  it('binds every source menu authority field and active/access/type flags rather than trusting numeric seed IDs or a copied path', async () => {
    const permission = new AdminPermissionService(f.container);
    const fields: Array<Record<string, unknown>> = [{ apiUrl: 'product/product/list' }, { methods: 'POST' },
      { menuPath: '/admin*' }, { uniqueAuth: 'product.manage' }, { authType: 1 }, { type: 2 }, { isDel: 1 }, { access: 0 }];
    for (const menu of catalogReadMenus) for (const field of fields) {
      await f.db.update(systemMenus).set(field).where(eq(systemMenus.id, menu.id));
      expect(await permission.resolveRulePermissionKeys(String(menu.id))).toEqual([]);
      expect(await permission.resolveManyRulePermissionKeys([String(menu.id)])).toEqual([[]]);
      await f.db.update(systemMenus).set({ ...menu, isDel: 0, access: 1 }).where(eq(systemMenus.id, menu.id));
    }
  });

  it('binds the true read-only PHP catalogue page tuple in single and batch resolvers and excludes altered source page claims', async () => {
    const permission = new AdminPermissionService(f.container);
    for (const field of [{ menuPath: '/admin/product/product' }, { uniqueAuth: 'product.manage' },
      { apiUrl: 'product/product' }, { methods: 'GET' }, { authType: 2 }, { access: 0 }, { type: 2 }, { isDel: 1 }]) {
      await f.db.update(systemMenus).set(field).where(eq(systemMenus.id, 2));
      expect(await permission.resolveRulePermissionKeys('2')).toEqual([]);
      expect(await permission.resolveManyRulePermissionKeys(['2', '996'])).toEqual([[], []]);
      await f.db.update(systemMenus).set({ ...catalogReadPageMenu, isDel: 0, access: 1 }).where(eq(systemMenus.id, 2));
    }
    expect(await permission.resolveRulePermissionKeys('2')).toEqual(['product.view']);
  });

  it('rejects blank/copied/normalized main/header/selector claims in single and batch resolution while preserving each additional exact selector seed', async () => {
    const permission = new AdminPermissionService(f.container);
    for (const id of [377, 388, 399, 410, 941]) {
      const source = { id, type: 1, authType: 2, apiUrl: 'product/product/list', methods: 'GET', menuPath: '', uniqueAuth: '' };
      await f.db.insert(systemMenus).values(source);
      expect(await permission.resolveRulePermissionKeys(String(id))).toEqual(['product.view']);
      expect(await permission.resolveManyRulePermissionKeys([String(id)])).toEqual([['product.view']]);
      await f.db.update(systemMenus).set({ uniqueAuth: 'product.manage' }).where(eq(systemMenus.id, id));
      expect(await permission.resolveRulePermissionKeys(String(id))).toEqual([]);
      await f.db.update(systemMenus).set(source).where(eq(systemMenus.id, id));
    }
    for (const apiUrl of ['product/product', 'product/product/type_header', 'product/product/list',
      '/adminapi/product/product', 'PRODUCT/PRODUCT', ' product/product ', '/api/admin/product/product'])
      for (const methods of ['GET', 'HEAD', 'get', 'GET,HEAD']) {
        await f.db.update(systemMenus).set({ apiUrl, methods, menuPath: '', uniqueAuth: '', authType: 2 }).where(eq(systemMenus.id, 998));
        expect(await permission.resolveRulePermissionKeys('998')).toEqual([]);
        expect(await permission.resolveManyRulePermissionKeys(['998'])).toEqual([[]]);
      }
    for (const id of [579, 580]) {
      await f.db.update(systemMenus).set({ apiUrl: 'product/product', methods: 'GET', menuPath: '', uniqueAuth: '', authType: 2 }).where(eq(systemMenus.id, id));
      expect(await permission.resolveRulePermissionKeys(String(id))).toEqual([]);
      expect(await permission.resolveManyRulePermissionKeys([String(id)])).toEqual([[]]);
    }
  });

  it('preserves the source distinction between false scalar zero and truthy brand/label arrays containing zero instead of treating either as cleared categories', async () => {
    await f.db.insert(storeProductRelation).values([
      { id: 30, productId: 20, type: 2, relationId: 0 }, { id: 31, productId: 30, type: 3, relationId: 0 },
    ]);
    expect(ids(await list('brand_id=0'))).toEqual(catalogReadDefaultIds);
    expect(ids(await list('store_label_id=0'))).toEqual(catalogReadDefaultIds);
    expect(ids(await list('brand_id%5B%5D=0'))).toEqual([20]);
    expect(ids(await list('store_label_id%5B%5D=0'))).toEqual([30]);
    expect(ids(await list('cate_id%5B%5D=0'))).toEqual(catalogReadDefaultIds);
  });

  it('rejects unknown, duplicate, conflicting array syntax, noncanonical identity and oversized read queries without any fixture business or audit writes', async () => {
    const before = await catalogReadSnapshot(f.db);
    for (const value of ['type=9', 'type=01', 'type=-0', 'page=-1', 'page=01', 'limit=-1', 'supplier_id=020',
      'store_id=-1', 'page=1&page=2', 'type=1&type=0', 'uid=1', 'pid=0', 'relation_id=20', 'status=1',
      'ids=10', 'cate_id=2&cate_id%5B%5D=2', 'cate_id%5B0%5D=2&cate_id%5B0%5D=3',
      'brand_id%5B%5D=-1', 'store_name=%00', `store_name=${'😀'.repeat(257)}`]) {
      await expect(list(value), value).rejects.toThrow(); await expect(header(value), value).rejects.toThrow();
    }
    expect(await catalogReadSnapshot(f.db)).toEqual(before);
  });

  it('checks current Admin password, role assignment and expiry independently for each actual source read, with no audit log insertion', async () => {
    const before = await catalogReadSnapshot(f.db);
    await expect(f.service.list(query(), { ...catalogReadActor(), expiresAt: Math.floor(Date.now() / 1000) - 1 })).rejects.toThrow();
    await f.db.update(systemRole).set({ rules: 'reply.view' }).where(eq(systemRole.id, 20));
    await expect(list()).rejects.toThrow('权限'); await expect(header()).rejects.toThrow('权限');
    await f.db.update(systemRole).set({ rules: 'product.view' }).where(eq(systemRole.id, 20));
    await f.db.update(systemAdmin).set({ pwd: 'current-password-changed' }).where(eq(systemAdmin.id, 120));
    const changed = await catalogReadSnapshot(f.db); await expect(list()).rejects.toThrow(); await expect(header()).rejects.toThrow();
    expect(await catalogReadSnapshot(f.db)).toEqual(changed); expect(changed.systemLog).toEqual(before.systemLog);
  });

  it('signs only scope-approved canonical public pictures, leaves static URLs and complex source JSON intact and never mutates stored catalogue/media rows', async () => {
    await seedCatalogPrivatePictures(f.db); const before = await catalogReadSnapshot(f.db), data = await list();
    for (const id of [10, 20, 30]) expect(data.list.find(row => row.id === id)?.image)
      .toMatch(/^\/api\/assets\/(?:31|41)\?expires=\d+&signature=[a-zA-Z0-9_-]+$/);
    expect(data.list.find(row => row.id === 10)?.slider_image).toEqual([
      data.list.find(row => row.id === 10)?.image, 'https://external.invalid/api/assets/31',
    ]);
    expect(await catalogReadSnapshot(f.db)).toEqual(before);
    const noKey = new AdminProductCatalogReadService(f.container);
    const unsigned = await noKey.list(query(), catalogReadActor());
    expect(unsigned.list.find(row => row.id === 10)?.image).toBe('');
    await f.db.update(systemAttachment).set({ relationId: 20 }).where(eq(systemAttachment.attId, 31));
    await f.db.update(systemSupplier).set({ isShow: 0 }).where(eq(systemSupplier.id, 20));
    const current = await list();
    for (const id of [10, 20, 30]) expect(current.list.find(row => row.id === id)?.image).toBe('');
    await f.db.update(storeProduct).set({ image: 'https://external.invalid/api/assets/31',
      sliderImage: '{"named":"/api/assets/31","raw":"https://fixture.invalid/raw.png"}' }).where(eq(storeProduct.id, 10));
    expect((await list()).list.find(row => row.id === 10)).toMatchObject({ image: 'https://external.invalid/api/assets/31',
      slider_image: { named: '', raw: 'https://fixture.invalid/raw.png' } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('retains source historical malformed-owner catalogue rows while refusing private scope signatures instead of dropping the product', async () => {
    await f.db.insert(storeProduct).values([
      { id: 22, isVerify: 1, relationId: 9, image: '/api/assets/31' },
      { id: 23, isVerify: 1, type: 3, relationId: 20, image: '/api/assets/31' },
      { id: 24, isVerify: 1, type: 1, relationId: 0, image: '/api/assets/31' },
      { id: 25, isVerify: 1, type: 2, relationId: 0, image: '/api/assets/31' },
    ]);
    const before = await catalogReadSnapshot(f.db), data = await list();
    expect(data.count).toBe(13);
    for (const id of [22, 23, 24, 25]) expect(data.list.find(row => row.id === id)).toMatchObject({ id, image: '' });
    expect(await catalogReadSnapshot(f.db)).toEqual(before);
  });
});
