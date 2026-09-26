import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Env, AppVariables } from '../src/env';
import { createContainerFromDb } from '../src/lib/di';
import { productHot } from '../src/controllers/api/v1/ProductController';
import { storeProduct, storeBrand, storeProductLabel, user, systemConfig, memberRight, storePromotions } from '../src/models/schema';
import { financePostgres } from './helpers/financePostgres';

// Actual Hono controller -> catalogue service -> DAO -> disposable SQL.
// Fixture identities are not evidence of real JWT, Hyperdrive or customer acceptance.
describe('legacy product/hot offset contract', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>;
  let app: Hono<{ Bindings: Env; Variables: AppVariables }>;
  let container: ReturnType<typeof createContainerFromDb>;
  const snapshot = async () => ({ products: await f.db.select().from(storeProduct).orderBy(storeProduct.id),
    users: await f.db.select().from(user), configs: await f.db.select().from(systemConfig),
    brands: await f.db.select().from(storeBrand), labels: await f.db.select().from(storeProductLabel),
    rights: await f.db.select().from(memberRight) });
  beforeAll(async () => {
    f = await financePostgres([storeProduct, storeBrand, storeProductLabel, user, systemConfig, memberRight, storePromotions]);
    container = createContainerFromDb(f.db);
    app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use('*', async (c, next) => { c.set('container', container); c.set('uid', c.req.header('x-fixture-user') === '11' ? 11 : 0); await next(); });
    app.onError((error, c) => c.json({ status: 400, msg: error.message, data: null }));
    app.get('/api/product/hot', productHot);
    await f.db.insert(user).values({ uid: 11, account: 'hot-pagination-local' });
    await f.db.insert(storeProduct).values(Array.from({ length: 111 }, (_, i) => ({
      id: 1000 + i, storeName: `Local hot product ${i}`, price: '12.30', stock: 2,
      isHot: 1, isShow: 1, isVerify: 1, sort: 5,
    })));
    await f.db.insert(storeProduct).values([
      { id: 2000, isHot: 0, isShow: 1, isVerify: 1 },
      { id: 2001, isHot: 1, isShow: 0, isVerify: 1 },
      { id: 2002, isHot: 1, isShow: 1, isVerify: 0 },
      { id: 2003, isHot: 1, isShow: 1, isVerify: 1, isDel: 1 },
      { id: 2004, isHot: 1, isShow: 1, isVerify: 1, isVipProduct: 1 },
    ]);
  }, 60_000);
  afterAll(async () => { vi.restoreAllMocks(); await f?.close(); }, 60_000);
  const request = async (query = '', uid = '') => {
    const response = await app.request(`/api/product/hot${query}`, { headers: { 'x-fixture-user': uid } });
    return response.json() as Promise<{ status: number; msg: string; data: Array<{ id: number; price: string; stock: number; store_name: string }> }>;
  };
  it('defaults to ten and advances past the first page in stable sort/id order', async () => {
    const first = await request(), second = await request('?page=2&limit=10');
    expect(first.status).toBe(200); expect(first.data).toHaveLength(10);
    expect(first.data.map(p => p.id)).toEqual(Array.from({ length: 10 }, (_, i) => 1110 - i));
    expect(second.data.map(p => p.id)).toEqual(Array.from({ length: 10 }, (_, i) => 1100 - i));
    expect(first.data[0]).toMatchObject({ price: '12.30', stock: 2, store_name: 'Local hot product 110' });
    expect(first.data[0]).toMatchObject({ activity: '', is_presale_product: 0, brand_name: '', store_label: [], price_type: '', vip_price: '0', is_vip: 0 });
  });
  it('keeps the legacy array envelope, short final page and empty terminal page', async () => {
    expect((await request('?page=12&limit=10')).data.map(p => p.id)).toEqual([1000]);
    expect((await request('?page=13&limit=10')).data).toEqual([]);
  });
  it('caps page size and excludes non-hot, hidden, unverified, deleted and VIP-only products', async () => {
    const result = await request('?page=1&limit=9999');
    expect(result.status).toBe(200); expect(result.data).toHaveLength(100);
    expect(result.data.every(row => row.id >= 1000 && row.id <= 1110)).toBe(true);
    expect((await request('?page=2&limit=100')).data).toHaveLength(11);
  });
  it('normalizes legacy paging inputs without fractional or zero SQL limits', async () => {
    expect((await request('?page=2.9&limit=8.9')).data.map(p => p.id)).toEqual(Array.from({ length: 8 }, (_, i) => 1102 - i));
    expect((await request('?page=-1&limit=0.1')).data.map(p => p.id)).toEqual([1110]);
    expect((await request('?page=bad&limit=bad')).data).toHaveLength(10);
  });
  it('rejects unrepresentable offsets before reaching the product query', async () => {
    const read = vi.spyOn(container.storeProductDao, 'getSearchList');
    try {
      for (const query of ['?page=9007199254740992', '?page=2147483649&limit=10', '?page=9007199254740991&limit=0.1']) {
        expect((await request(query)).status).toBe(400);
      }
      expect(read).not.toHaveBeenCalled();
    } finally { read.mockRestore(); }
  });
  it('rechecks visibility on later pages and performs no business writes', async () => {
    await f.db.update(storeProduct).set({ isShow: 0 }).where(eq(storeProduct.id, 1100));
    try {
      const before = await snapshot();
      const result = await request('?page=2&limit=10', '11');
      expect(result.status).toBe(200); expect(result.data.map(p => p.id)).toEqual(Array.from({ length: 10 }, (_, i) => 1099 - i));
      expect(await snapshot()).toEqual(before);
    } finally { await f.db.update(storeProduct).set({ isShow: 1 }).where(eq(storeProduct.id, 1100)); }
  });
  it('projects visible branding/labels and advertised member offers but retains unresolved activity priority', async () => {
    await f.db.insert(storeBrand).values({ id: 301, brandName: 'Local brand' });
    await f.db.insert(storeProductLabel).values([
      { id: 401, labelName: 'Visible label', color: '#855224', bgColor: '#fff7ec', borderColor: '#eed7b8', icon: '/api/qa/label.svg' },
      { id: 402, labelName: 'Hidden label', isShow: 0 }, { id: 403, labelName: 'Disabled label', status: 0 },
    ]);
    await f.db.insert(memberRight).values({ id: 501, rightType: 'vip_price', status: 1, number: 1 });
    await f.db.update(storeProduct).set({ brandId: 301, storeLabelId: '401,402,403', activity: '2,1,3,0',
      isPresaleProduct: 1, isVip: 1, vipPrice: '9.90' }).where(eq(storeProduct.id, 1110));
    try {
      const before = await snapshot();
      // Both public and ordinary authenticated visitors see an OFFER, not a paid entitlement.
      for (const uid of ['', '11']) {
        const result = await request('?page=1&limit=1', uid);
        expect(result.status).toBe(200);
        expect(result.data[0]).toMatchObject({ id: 1110, price: '12.30', brand_name: 'Local brand',
          activity: '2,1,3,0', is_presale_product: 1, is_vip: 1, price_type: 'member', vip_price: '9.90',
          store_label: [{ id: 401, label_name: 'Visible label', color: '#855224', bg_color: '#fff7ec', border_color: '#eed7b8', icon: '/api/qa/label.svg' }],
        });
      }
      expect(await snapshot()).toEqual(before);
      await f.db.update(storeBrand).set({ isShow: 0 }).where(eq(storeBrand.id, 301));
      await f.db.update(memberRight).set({ status: 0 }).where(eq(memberRight.id, 501));
      expect((await request('?limit=1')).data[0]).toMatchObject({ brand_name: '', price_type: '', vip_price: '0' });
    } finally {
      await f.db.update(storeProduct).set({ brandId: 0, storeLabelId: null, activity: '', isPresaleProduct: 0,
        isVip: 0, vipPrice: '0.00' }).where(eq(storeProduct.id, 1110));
    }
  });
});
