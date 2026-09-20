import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { financePostgres } from './helpers/financePostgres';
import { createContainerFromDb } from '../src/lib/di';
import { StoreProductService } from '../src/services/product/StoreProductService';
import type { Env } from '../src/env';
import { storeProduct, storeProductAttrValue, storeProductRelation, storeProductEnsure,
  user, userRelation, systemUserLevel, systemConfig, memberRight } from '../src/models/schema';

// Stateful Redis substitute reproduces cross-request hits from the old code.
// SQL and DAOs are real; no production credentials or network cache are used.
const redis = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../src/utils/cache', () => ({
  cacheGet: vi.fn(async (key: string) => structuredClone(redis.get(key) ?? null)),
  cacheSet: vi.fn(async (key: string, value: unknown) => { redis.set(key, structuredClone(value)); return true; }),
  cacheDelete: vi.fn(async (key: string) => redis.delete(key)),
}));

describe('product detail request isolation with SQL authority', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>;
  let service: StoreProductService;
  const levels = new Map<string, string>();
  // Only the typed get/put paths exercised by UserLevelService are substituted.
  const env = { CONFIG_KV: {
    get: async (key: string, format?: string) => {
      const value = levels.get(key); return value === undefined ? null : format === 'json' ? JSON.parse(value) : value;
    },
    put: async (key: string, value: string) => { levels.set(key, value); },
  } } as Env;
  beforeAll(async () => {
    f = await financePostgres([storeProduct, storeProductAttrValue, storeProductRelation,
      storeProductEnsure, user, userRelation, systemUserLevel, systemConfig, memberRight]);
    service = new StoreProductService(createContainerFromDb(f.db), env);
  }, 60_000);
  afterAll(async () => { await f?.close(); }, 60_000);
  beforeEach(async () => {
    await f.reset(); redis.clear(); levels.clear(); vi.clearAllMocks();
    await f.db.insert(memberRight).values({ id: 1, rightType: 'vip_price', status: 1, number: 1 });
    await f.db.insert(storeProduct).values({ id: 70, storeName: 'Cache isolation fixture', isShow: 1,
      isVerify: 1, price: '100.00', vipPrice: '90.00', otPrice: '120.00', isVip: 1, stock: 8, image: '/old.svg' });
    await f.db.insert(storeProductAttrValue).values(Array.from({ length: 8 }, (_, type) => ({
      id: type + 1, productId: 70, type, unique: `type000${type}`, suk: `type-${type}`,
      price: '100.00', vipPrice: '90.00', otPrice: '120.00', stock: 8, image: '/sku-old.svg',
    })));
    await f.db.insert(systemUserLevel).values([
      { id: 1, name: 'Gold fixture', discount: '80', grade: 1, isShow: 1 },
      { id: 2, name: 'Silver fixture', discount: '95', grade: 2, isShow: 1 },
    ]);
    await f.db.insert(user).values([
      { uid: 11, account: 'cache-gold', level: 1, levelStatus: 1 }, { uid: 22, account: 'cache-silver', level: 2, levelStatus: 1 },
    ]);
    await f.db.insert(userRelation).values({ uid: 11, relationId: 70, type: 'collect', category: 'product' });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it.each([[11, 22, 0], [0, 22, 11], [22, 11, 0]])('recomputes identity and price in visit order %j → %j → %j', async (...uids) => {
    const expected = {
      0: { uid: 0, level_name: '', price_type: 'member', vipPrice: '90.00', userCollect: false },
      11: { uid: 11, level_name: 'Gold fixture', price_type: 'level', vipPrice: '80.00', userCollect: true },
      22: { uid: 22, level_name: 'Silver fixture', price_type: 'member', vipPrice: '90.00', userCollect: false },
    };
    for (const uid of uids) expect(await service.getProductDetail(70, uid)).toMatchObject(expected[uid as 0 | 11 | 22]);
  });

  it('returns a level-only discount rather than zero when the product is not SVIP', async () => {
    await f.db.update(storeProduct).set({ isVip: 0 }).where(eq(storeProduct.id, 70));
    expect(await service.getProductDetail(70, 11)).toMatchObject({ price_type: 'level', vipPrice: '80.00', level_price: '80.00' });
  });

  it('recomputes a changed user level and collection without carrying previous enrichment', async () => {
    await service.getProductDetail(70, 11);
    await f.db.update(user).set({ level: 0 }).where(eq(user.uid, 11));
    await f.db.delete(userRelation).where(eq(userRelation.uid, 11));
    expect(await service.getProductDetail(70, 11)).toMatchObject({ level_name: '', price_type: 'member', vipPrice: '90.00', userCollect: false });
  });

  it.each(Array.from({ length: 8 }, (_, type) => type))('reads updated product and SKU state for type %i without an invalidation call', async (type) => {
    await service.getProductDetail(70, 0, type);
    await f.db.update(storeProduct).set({ image: '/new.svg', price: '110.00', vipPrice: '99.00', stock: 0 }).where(eq(storeProduct.id, 70));
    await f.db.update(storeProductAttrValue).set({ price: '110.00', stock: 0, image: '/sku-new.svg' }).where(eq(storeProductAttrValue.type, type));
    const detail = await service.getProductDetail(70, 0, type);
    expect(detail).toMatchObject({ image: '/new.svg', price: '110.00', stock: 0, vipPrice: '99.00',
      attr_value: [{ unique: `type000${type}`, price: '110.00', stock: 0, image: '/sku-new.svg' }] });
    expect(detail.attr_value).toHaveLength(1);
  });

  it.each(['hidden', 'deleted', 'missing'])('rejects a previously cached product that is now %s', async (state) => {
    await service.getProductDetail(70, 0);
    if (state === 'missing') await f.db.delete(storeProduct).where(eq(storeProduct.id, 70));
    else await f.db.update(storeProduct).set(state === 'hidden' ? { isShow: 0 } : { isDel: 1 }).where(eq(storeProduct.id, 70));
    await expect(service.getProductDetail(70, 0)).rejects.toThrow(/商品不存在|商品已下架/);
  });

  it('does not reuse a retired SKU or its old price range', async () => {
    await f.db.update(storeProduct).set({ specType: 1 }).where(eq(storeProduct.id, 70));
    await f.db.insert(storeProductAttrValue).values({ id: 99, productId: 70, type: 0,
      unique: 'fresh099', suk: 'replacement', price: '120.00', stock: 5 });
    expect((await service.getProductDetail(70, 0)).attr_value).toHaveLength(2);
    await f.db.update(storeProductAttrValue).set({ isRetired: 1 }).where(eq(storeProductAttrValue.id, 1));
    expect(await service.getProductDetail(70, 0)).toMatchObject({ min_price: 120, max_price: 120,
      attr_value: [{ unique: 'fresh099', stock: 5 }] });
  });

  it('ignores poisoned legacy cache and performs no shared detail cache I/O', async () => {
    redis.set('product_info_70', { id: 70, image: '/poison.svg', uid: 999, price_type: 'level', level_name: 'wrong' });
    expect(await service.getProductDetail(70, 0)).toMatchObject({ image: '/old.svg', uid: 0, level_name: '' });
    const { cacheGet, cacheSet } = await import('../src/utils/cache');
    expect(cacheGet).not.toHaveBeenCalled(); expect(cacheSet).not.toHaveBeenCalled();
  });

  it('never serves stale detail when the authoritative read fails', async () => {
    await service.getProductDetail(70, 0);
    const container = createContainerFromDb(f.db);
    vi.spyOn(container.storeProductDao, 'getById').mockRejectedValue(new Error('synthetic database outage'));
    await expect(new StoreProductService(container, env).getProductDetail(70, 0)).rejects.toThrow('synthetic database outage');
  });

  it('cleans only all eight exact legacy keys when explicitly requested', async () => {
    const keys = Array.from({ length: 8 }, (_, type) => type ? `product_info_70_${type}` : 'product_info_70');
    for (const key of [...keys, 'product_info_71', 'tb_fixture']) redis.set(key, {});
    await service.invalidateProductCache(70);
    expect([...redis.keys()]).toEqual(['product_info_71', 'tb_fixture']);
  });

  it('cannot repopulate a stale shared response when an older reader finishes after an update', async () => {
    const container = createContainerFromDb(f.db);
    const oldProduct = await container.storeProductDao.getById(70);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    vi.spyOn(container.storeProductDao, 'getById').mockImplementationOnce(async () => {
      notifyStarted(); await gate; return oldProduct;
    });
    const slowRead = new StoreProductService(container, env).getProductDetail(70, 0);
    try {
      await started;
      await f.db.update(storeProduct).set({ image: '/committed.svg' }).where(eq(storeProduct.id, 70));
      expect(await service.getProductDetail(70, 0)).toMatchObject({ image: '/committed.svg' });
    } finally { release(); await slowRead; }
    expect(await service.getProductDetail(70, 0)).toMatchObject({ image: '/committed.svg' });
    expect(redis.size).toBe(0);
  });

  it('does not mutate any product, SKU, user, relation or level rows while reading', async () => {
    const snapshot = async () => Promise.all([
      f.db.select().from(storeProduct), f.db.select().from(storeProductAttrValue),
      f.db.select().from(user), f.db.select().from(userRelation), f.db.select().from(systemUserLevel),
      f.db.select().from(storeProductRelation), f.db.select().from(storeProductEnsure),
    ]);
    const before = await snapshot();
    await Promise.all([0, 11, 22].map(uid => service.getProductDetail(70, uid)));
    expect(await snapshot()).toEqual(before);
  });

  it('resolves current assurance definitions and current product associations on every read', async () => {
    await f.db.insert(storeProductEnsure).values([
      { id: 1, name: 'Old assurance', status: 1 }, { id: 2, name: 'New assurance', status: 1 },
    ]);
    await f.db.update(storeProduct).set({ ensureId: '1' }).where(eq(storeProduct.id, 70));
    expect((await service.getProductDetail(70, 0)).ensure).toMatchObject([{ id: 1, name: 'Old assurance' }]);
    await f.db.update(storeProduct).set({ ensureId: '2' }).where(eq(storeProduct.id, 70));
    expect((await service.getProductDetail(70, 0)).ensure).toMatchObject([{ id: 2, name: 'New assurance' }]);
    await f.db.update(storeProductEnsure).set({ status: 0 }).where(eq(storeProductEnsure.id, 2));
    expect((await service.getProductDetail(70, 0)).ensure).toEqual([]);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects invalid product ID %s before data/cache access', async (id) => {
    await expect(service.getProductDetail(id, 0)).rejects.toThrow('商品不存在');
    await expect(service.invalidateProductCache(id)).rejects.toThrow('商品不存在');
    const { cacheGet, cacheDelete } = await import('../src/utils/cache');
    expect(cacheGet).not.toHaveBeenCalled(); expect(cacheDelete).not.toHaveBeenCalled();
  });
});
