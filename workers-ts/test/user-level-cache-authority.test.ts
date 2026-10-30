import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { createAdminLevelFixture } from './helpers/adminLevelFixture';
import { md5 } from '../src/utils/jwt';
import { createContainerFromDb } from '../src/lib/di';
import type { AppVariables, Env } from '../src/env';
import { UserLevelService } from '../src/services/user/UserLevelService';
import { StoreProductService } from '../src/services/product/StoreProductService';
import { adminLevelSave, adminLevelDel } from '../src/controllers/api/v1/AdminCrudController';
import { storeProduct, storeProductAttrValue, storeProductRelation, storeProductEnsure,
  systemUserLevel, systemAdmin, user, userRelation, systemConfig, memberRight, storePromotions,
  storePromotionsAuxiliary,storeProductAttr,storeCart,storeBrand,systemStore,systemSupplier,systemAttachment,systemDise,storeProductDescription,storeProductReply,community,communityRelevance,storeDiscounts,storeDiscountsProducts } from '../src/models/schema';

describe('level definitions follow database authority after admin edits', () => {
  let f: Awaited<ReturnType<typeof createAdminLevelFixture>>;
  let container: ReturnType<typeof createContainerFromDb>;
  let levels: UserLevelService;
  let products: StoreProductService;
  let app: Hono<{ Bindings: Env; Variables: AppVariables }>;
  const kv = new Map<string, string>();
  const get = vi.fn(async (key: string) => { const value = kv.get(key); return value === undefined ? null : JSON.parse(value); });
  const put = vi.fn(async (key: string, value: string) => { kv.set(key, value); });
  const remove = vi.fn(async (key: string) => { kv.delete(key); });
  // Test-only subset: only these KV operations are exercised. Plain callable
  // adapters avoid claiming that a platform binding has Vitest Mock members.
  // No host bindings, network caches or production environment are loaded.
  const env = { APP_KEY: 'level-cache-authority-local-key', CONFIG_KV: {
    get: (key: string) => get(key),
    put: (key: string, value: string) => put(key, value),
    delete: (key: string) => remove(key),
  } } as Env;
  beforeAll(async () => {
    f = await createAdminLevelFixture([systemUserLevel, user, userRelation, storeProduct,
      storeProductAttrValue, storeProductRelation, storeProductEnsure, systemConfig, memberRight,
      storePromotions, storePromotionsAuxiliary,storeProductAttr,storeCart,storeBrand,systemStore,systemSupplier,systemAttachment,systemDise,storeProductDescription,storeProductReply,community,communityRelevance,storeDiscounts,storeDiscountsProducts]);
    container = createContainerFromDb(f.db);
    levels = new UserLevelService(container, env);
    products = new StoreProductService(container, env);
    // Real controllers, live actor checks and restricted Admin SQL; this fixture
    // provides authenticated context. Actual JWT admission is a separate suite.
    app = new Hono();
    app.use('*', async (c, next) => { await f.asAdmin(async () => { c.set('container', container); c.set('adminId',1); c.set('socketAuthVersion',md5('level-cache-owner')); c.set('socketTokenExp',Math.floor(Date.now()/1000)+3600); await next(); }); });
    app.post('/adminapi/level/save', adminLevelSave);
    app.post('/api/admin/level/save', adminLevelSave);
    app.delete('/adminapi/level/del/:id', adminLevelDel);
    app.delete('/api/admin/level/del/:id', adminLevelDel);
  }, 60_000);
  afterAll(async () => { await f?.close(); }, 60_000);
  beforeEach(async () => {
    await f.reset(); kv.clear(); vi.clearAllMocks();
    await f.db.insert(systemAdmin).values({id:1,account:'level-cache-owner',pwd:'level-cache-owner',level:0});
    await f.db.insert(memberRight).values({ id: 1, rightType: 'vip_price', status: 1, number: 1 });
    await f.db.insert(systemUserLevel).values([
      { id: 1, name: 'Original level', grade: 1, discount: '80', isShow: 1 },
      { id: 2, name: 'Next level', grade: 2, discount: '70', isShow: 1, expNum: 100 },
    ]);
    await f.db.insert(user).values({ uid: 11, account: 'level-cache-fixture', level: 1, levelStatus: 1 });
    await f.db.insert(storeProduct).values({ id: 70, storeName: 'Level definition fixture', price: '100.00',
      vipPrice: '90.00', isVip: 1, isShow: 1, isVerify: 1, stock: 8 });
    await f.db.insert(storeProductAttrValue).values({ id: 1, productId: 70, type: 0,
      unique: 'level001', suk: 'fixture', price: '100.00', stock: 8 });
  });
  afterEach(() => { vi.restoreAllMocks(); });
  async function save(path: string, body: object) {
    const response = await app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, env);
    expect(await response.json()).toMatchObject({ status: 200, data: { id: 1 } });
  }
  async function expectCurrentQuote(priceType: string, price: string, name: string) {
    const detail = await products.getProductDetail(70, 11);
    expect(detail).toMatchObject({ price_type: priceType, vipPrice: price, level_name: name });
    const catalogue = await products.getGoodsList({}, 11);
    expect(catalogue.list).toHaveLength(1);
    expect(catalogue.list[0]).toMatchObject({ price_type: priceType, vip_price: price, level_name: name });
    expect(await products.getRecommendProducts(11)).toMatchObject([{ price_type: priceType, vip_price: price, level_name: name }]);
  }

  it.each(['/adminapi/level/save', '/api/admin/level/save'])('refreshes name and discount after %s without a cache clear', async (path) => {
    await levels.getLevel(1);
    await expectCurrentQuote('level', '80.00', 'Original level');
    await save(path, { id: 1, name: 'Edited level', discount: 70 });
    expect(await levels.getLevel(1)).toMatchObject({ id: 1, name: 'Edited level', discount: 70 });
    await expectCurrentQuote('level', '70.00', 'Edited level');
    expect(await levels.userLevelInfo(11)).toMatchObject({ level: { name: 'Edited level', discount: 70 } });
    expect((await levels.gradeList())[0]).toMatchObject({ name: 'Edited level', discount: 70 });
  });

  it.each(['/adminapi/level/save', '/api/admin/level/save'])('stops and restores a disabled definition after %s', async (path) => {
    await levels.getLevel(1);
    await save(path, { id: 1, is_show: 0 });
    expect(await levels.getLevel(1)).toBeNull();
    await expectCurrentQuote('member', '90.00', '');
    expect((await levels.userLevelInfo(11)).level).toBeNull();
    await save(path, { id: 1, is_show: 1, discount: 75 });
    await expectCurrentQuote('level', '75.00', 'Original level');
  });

  it.each(['/adminapi/level/del/1', '/api/admin/level/del/1'])('rejects an old cached definition after %s', async (path) => {
    await levels.getLevel(1);
    // The cache regression concerns an unreferenced deletion. A separate
    // author suite proves that current user.level references reject deletion.
    await f.db.update(user).set({level:0}).where(eq(user.uid,11));
    const response = await app.request(path, { method: 'DELETE' }, env);
    expect(await response.json()).toMatchObject({ status: 200 });
    expect(await levels.getLevel(1)).toBeNull();
    await expectCurrentQuote('member', '90.00', '');
    expect((await levels.userLevelInfo(11)).level).toBeNull();
  });

  it('does not use a cached definition for a physically missing row', async () => {
    await levels.getLevel(1);
    await f.db.delete(systemUserLevel).where(eq(systemUserLevel.id, 1));
    expect(await levels.getLevel(1)).toBeNull();
  });

  it.each([{ id: 1, discount: 1, name: 'Stale edge' }, { id: 999, discount: 'invalid' }, null])
    ('ignores old or malformed cached payload %j', async (payload) => {
      kv.set('level_1', JSON.stringify(payload));
      expect(await levels.getLevel(1)).toEqual({ id: 1, name: 'Original level', discount: 80, grade: 1 });
      expect(get).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled();
    });

  it('does not mask database errors with an earlier KV value', async () => {
    await levels.getLevel(1);
    vi.spyOn(container.systemUserLevelDao, 'getById').mockRejectedValue(new Error('synthetic level DB failure'));
    await expect(levels.getLevel(1)).rejects.toThrow('synthetic level DB failure');
  });

  it.each([0, -1, 1.5, Number.NaN])('ignores invalid/no-level ID %s without querying SQL or KV', async (id) => {
    const query = vi.spyOn(container.systemUserLevelDao, 'getById');
    expect(await levels.getLevel(id)).toBeNull();
    expect(query).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled();
  });

  it('does not require KV availability to read authoritative level data', async () => {
    get.mockRejectedValueOnce(new Error('synthetic KV outage'));
    expect(await levels.getLevel(1)).toMatchObject({ discount: 80 });
    expect(get).not.toHaveBeenCalled();
    get.mockReset();
  });

  it('limits explicit legacy cleanup to one valid level key without making reads depend on it', async () => {
    kv.set('level_1', JSON.stringify({ id: 1, discount: 1 }));
    kv.set('level_2', JSON.stringify({ id: 2, discount: 2 }));
    kv.set('unrelated', 'preserve');
    for (const id of [0, -1, 1.5, Number.NaN]) await levels.invalidate(id);
    expect(remove).not.toHaveBeenCalled();
    await levels.invalidate(1);
    expect(remove.mock.calls).toEqual([['level_1']]);
    expect([...kv.keys()]).toEqual(['level_2', 'unrelated']);
    expect(await levels.getLevel(1)).toMatchObject({ discount: 80 });
    expect(get).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled();
  });

  it('does not refill a stale key when an older SQL read completes after an edit', async () => {
    const row = await container.systemUserLevelDao.getById(1);
    let release!: () => void;
    let notify!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { notify = resolve; });
    vi.spyOn(container.systemUserLevelDao, 'getById').mockImplementationOnce(async () => { notify(); await gate; return row; });
    const old = levels.getLevel(1);
    try { await started; await save('/adminapi/level/save', { id: 1, discount: 60 }); }
    finally { release(); await old; }
    expect(await levels.getLevel(1)).toMatchObject({ discount: 60 });
    expect(put).not.toHaveBeenCalled();
  });
});
