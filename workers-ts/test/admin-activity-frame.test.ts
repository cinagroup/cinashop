import { systemStore, systemSupplier } from '../src/models/schema';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { AppVariables, Env } from '../src/env';
import { createContainerFromDb, type Container } from '../src/lib/di';
import {
  storeCouponIssue, storeCouponProduct, storeDiscounts, storeDiscountsProducts,
  storeBrand, storeProduct, storeProductCategory, storeProductLabel, storeProductRelation,
  storePromotions, storePromotionsAuxiliary, systemDise, systemLog,
} from '../src/models/schema';
import * as frame from '../src/controllers/api/v1/AdminActivityFrameController';
import { AdminActivityFrameService } from '../src/services/admin/AdminActivityFrameService';
import { PublicCatalogService } from '../src/services/product/PublicCatalogService';
import { V2PromotionCompatibilityService } from '../src/services/activity/V2PromotionCompatibilityService';
import { financePostgres } from './helpers/financePostgres';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';

const future = (hours: number) => {
  const date = new Date(Date.now() + hours * 3_600_000 + 8 * 3_600_000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
};
const requestId = () => crypto.randomUUID();
const base = () => ({ name: '春日活动边框', image: '/uploads/frame.png', product_partake_type: 2,
  product_id: [1, 2], brand_id: [], store_label_id: [],
  section_time: [future(2), future(26)], status: 1, sort: 5, request_id: requestId() });

describe('Admin activity frame store_promotions type=5 contract', () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>;
  let service: AdminActivityFrameService;
  let container: Container;
  beforeAll(async () => {
    fixture = await financePostgres([systemStore, systemSupplier, storePromotions, storePromotionsAuxiliary, storeProduct,
      storeProductRelation, storeProductCategory, storeBrand, storeProductLabel, systemLog,
      storeCouponIssue, storeCouponProduct, storeDiscounts, storeDiscountsProducts, systemDise]);
    container = createContainerFromDb(fixture.db);
    service = new AdminActivityFrameService(container);
    await fixture.db.insert(storeProductCategory).values({ id: 10, cateName: '鲜花' });
    await fixture.db.insert(storeProduct).values([
      { id: 1, storeName: '玫瑰', isShow: 1, isDel: 0, isVerify: 1, cateId: '10' },
      { id: 2, storeName: '百合', isShow: 1, isDel: 0, isVerify: 1, cateId: '10' },
      { id: 3, storeName: '茉莉', isShow: 1, isDel: 0, isVerify: 1, cateId: '10' },
      { id: 4, storeName: '待审核', isShow: 1, isDel: 0, isVerify: 0, cateId: '10' },
      { id: 5, storeName: '已下架', isShow: 0, isDel: 0, isVerify: 1, cateId: '10' },
      { id: 6, pid: 1, storeName: '玫瑰子商品', isShow: 1, isDel: 0, isVerify: 1, cateId: '10' },
    ]);
    await fixture.db.insert(storeBrand).values([
      { id: 11, brandName: '花园', isShow: 1, isDel: 0 },
      { id: 12, brandName: '停用品牌', isShow: 0, isDel: 0 },
    ]);
    await fixture.db.insert(storeProductLabel).values([
      { id: 21, labelName: '热销' }, { id: 22, labelName: '节日' },
    ]);
    await fixture.db.insert(storeProductRelation).values([
      { productId: 1, type: 1, relationId: 10 },
      { productId: 1, type: 2, relationId: 11 }, { productId: 2, type: 2, relationId: 11 },
      { productId: 1, type: 3, relationId: 21 }, { productId: 3, type: 3, relationId: 21 },
    ]);
    await fixture.db.insert(storePromotions).values([
      { id: 101, promotionsType: 6, type: 1, storeId: 0, pid: 0, name: '活动背景', image: '/bg.png' },
      { id: 102, promotionsType: 5, type: 2, storeId: 7, pid: 0, name: '门店边框', image: '/shop.png' },
      { id: 103, promotionsType: 5, type: 1, storeId: 0, pid: 77, name: '边框子记录', image: '/child.png' },
    ]);
  }, 30_000);
  afterAll(async () => { await fixture?.close(); });

  it('reads only platform root type=5 and applies stage, time, name and pagination filters', async () => {
    expect(await service.list(new URLSearchParams())).toMatchObject({ count: 0, list: [], page: 1, limit: 15 });
    const body = base(), created = await service.mutate('create', 0, body, { id: 9 });
    expect(created.id).toBeGreaterThan(0);
    const result = await service.list(new URLSearchParams('status=0&name=%E6%98%A5%E6%97%A5&page=1&limit=1'));
    expect(result).toMatchObject({ count: 1, page: 1, limit: 1,
      list: [{ id: created.id, name: '春日活动边框', promotionsType: 5, start_status: 0, product_count: 2 }] });
    expect(result.list[0].revision).toMatch(/^[a-f0-9]{64}$/);
    expect((await service.list(new URLSearchParams('status=1'))).count).toBe(0);
    const [start, end] = body.section_time;
    expect((await service.list(new URLSearchParams({ time: `${start} - ${end}` }))).count).toBe(1);
    expect((await service.list(new URLSearchParams({ time: `${future(48)} - ${future(72)}` }))).count).toBe(0);
    const createdAt = result.list[0].add_time;
    expect((await service.list(new URLSearchParams({ create_time: `${createdAt} - ${createdAt}` }))).count).toBe(1);
    expect((await service.list(new URLSearchParams('page=2&limit=1'))).list).toEqual([]);
    expect((await service.detail(created.id)).info).toMatchObject({ product_id: [1, 2],
      products: [{ id: 1 }, { id: 2 }], brand_id: [], store_label_id: [] });
  });

  it('transitions all five product scopes transactionally, enforces CAS/replay and preserves other types', async () => {
    const first = (await service.list(new URLSearchParams())).list[0];
    const detail = async () => (await service.detail(first.id)).info;
    let row = await detail();
    const original = await fixture.db.select().from(storePromotionsAuxiliary).where(eq(storePromotionsAuxiliary.promotionsId, first.id));
    expect(original.map(item => item.productId)).toEqual([1, 2]);
    const change = async (scope: number, selected: Record<string, number[]>) => {
      const response = await service.mutate('update', first.id,
        { ...base(), ...selected, product_partake_type: scope, revision: row.revision }, { id: 9 });
      expect(response.id).toBe(first.id);
      row = await detail();
      return (await service.list(new URLSearchParams())).list[0];
    };
    expect((await change(3, { product_id: [1] })).product_count).toBe(2);
    expect(row.product_id).toEqual([1]);
    expect((await change(4, { product_id: [], brand_id: [11] })).product_count).toBe(2);
    expect(row.brands).toEqual([{ id: 11, brand_name: '花园' }]);
    expect((await change(5, { product_id: [], store_label_id: [21] })).product_count).toBe(2);
    expect(row.labels).toEqual([{ id: 21, label_name: '热销' }]);
    expect((await change(1, { product_id: [] })).product_count).toBe(3);
    expect(row.product_id).toEqual([]);
    const stale = row.revision;
    const off = { revision: stale, status: 0, request_id: requestId() };
    expect(await service.mutate('status', first.id, off, { id: 9 })).toEqual({ id: first.id });
    expect(await service.mutate('status', first.id, off, { id: 9 })).toEqual({ id: first.id });
    expect((await service.list(new URLSearchParams('status=-1'))).count).toBe(1);
    await expect(service.mutate('status', first.id, { revision: stale, status: 1, request_id: requestId() }, { id: 9 }))
      .rejects.toMatchObject({ code: 409 });
    row = await detail();
    const deleted = { revision: row.revision, request_id: requestId() };
    expect(await service.mutate('delete', first.id, deleted, { id: 9 })).toEqual({ id: first.id });
    expect(await service.mutate('delete', first.id, deleted, { id: 9 })).toEqual({ id: first.id });
    expect((await service.list(new URLSearchParams())).count).toBe(0);
    await expect(service.detail(first.id)).rejects.toMatchObject({ code: 404 });
    for (const otherId of [101, 102, 103]) {
      const [other] = await fixture.db.select().from(storePromotions).where(eq(storePromotions.id, otherId));
      expect(other.isDel).toBe(0);
      await expect(service.mutate('delete', otherId, { revision: '0'.repeat(64), request_id: requestId() }, { id: 9 }))
        .rejects.toMatchObject({ code: 404 });
    }
    const relations = await fixture.db.select().from(storePromotionsAuxiliary).where(eq(storePromotionsAuxiliary.promotionsId, first.id));
    expect(relations).toEqual([]);
    const logs = await fixture.db.select().from(systemLog).where(eq(systemLog.type, 'activity_frame'));
    expect(logs).toHaveLength(7);
  });

  it('rejects invalid scope, inactive references, forged ownership and malformed read inputs without writes', async () => {
    const invalid = [
      { ...base(), product_partake_type: 2, product_id: [5] },
      { ...base(), product_partake_type: 2, product_id: [4] },
      { ...base(), product_partake_type: 2, product_id: [6] },
      { ...base(), product_partake_type: 3, product_id: [6] },
      { ...base(), product_partake_type: 4, brand_id: [12] },
      { ...base(), product_partake_type: 5, store_label_id: [99] },
      { ...base(), product_partake_type: 2, product_id: [] },
      { ...base(), product_partake_type: 3, product_id: [] },
      { ...base(), promotions_type: 6 },
      { ...base(), section_time: [future(48), future(24)] },
      { ...base(), name: '' },
      { ...base(), image: 'javascript:alert(1)' },
    ];
    for (const body of invalid) await expect(service.mutate('create', 0, body, { id: 9 })).rejects.toMatchObject({ code: 400 });
    expect((await service.list(new URLSearchParams())).count).toBe(0);
    for (const query of ['page=0', 'limit=1000', 'status=2', 'status=1&status=0', 'time=bad', 'unknown=1']) {
      await expect(service.list(new URLSearchParams(query))).rejects.toMatchObject({ code: 400 });
    }
  });

  it('serves paginated product, brand and label pickers with exact API envelopes and no-store', async () => {
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use('*', async (c, next) => {
      c.set('container', container);
      c.set('adminInfo', { id: 9, account: 'admin', realName: 'admin', level: 1, roles: '', divisionId: 0 });
      await next();
    });
    const path = '/marketing/activity-frame';
    app.get(path, frame.list);
    app.get(`${path}/products`, frame.products);
    app.get(`${path}/brands`, frame.brands);
    app.get(`${path}/labels`, frame.labels);
    app.get(`${path}/:id`, frame.detail);
    app.post(path, frame.create);
    app.put(`${path}/:id`, frame.update);
    app.patch(`${path}/:id/status`, frame.status);
    app.delete(`${path}/:id`, frame.remove);
    const get = async (suffix: string) => {
      const response = await app.request(`http://localhost${path}${suffix}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toContain('no-store');
      return (await response.json() as { status: number; data: any }).data;
    };
    expect(await get('/products?page=1&limit=2')).toMatchObject({ count: 3, page: 1, limit: 2,
      list: [{ id: 3, store_name: '茉莉' }, { id: 2, store_name: '百合' }] });
    expect(await get('/products?keyword=%E7%8E%AB%E7%91%B0')).toMatchObject({ count: 1,
      list: [{ id: 1, cate_name: '鲜花' }] });
    expect(await get('/brands?keyword=%E8%8A%B1')).toMatchObject({ count: 1, list: [{ id: 11, brand_name: '花园' }] });
    expect(await get('/labels?page=2&limit=1')).toMatchObject({ count: 2, page: 2, limit: 1,
      list: [{ id: 21, label_name: '热销' }] });
    const created = await app.request(`http://localhost${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(base()) });
    expect(created.headers.get('Cache-Control')).toContain('no-store');
    const json = await created.json() as { status: number; data: { id: number } };
    expect(json.status).toBe(200);
    const read = await get(`/${json.data.id}`);
    expect(read.info).toMatchObject({ id: json.data.id, product_id: [1, 2] });
    const changed = await app.request(`http://localhost${path}/${json.data.id}/status`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 0, revision: read.info.revision, request_id: requestId() }) });
    expect((await changed.json() as { status: number }).status).toBe(200);
  });

  it('writes exclusion rows that both public product and V2 promotion consumers actually honor', async () => {
    const body = { ...base(), name: '排除玫瑰的活动边框', product_partake_type: 3,
      product_id: [1], section_time: [future(-1), future(2)] };
    const created = await service.mutate('create', 0, body, { id: 9 });
    const relations = await fixture.db.select().from(storePromotionsAuxiliary)
      .where(eq(storePromotionsAuxiliary.promotionsId, created.id));
    expect(relations).toMatchObject([{ type: 1, productPartakeType: 3, productId: 1, isAll: 1 }]);
    expect((await service.detail(created.id)).info.product_count).toBe(2);
    const catalog = new PublicCatalogService(container, {} as Env);
    const excluded = await catalog.productActivity(1, 5) as { promotions: Array<{ id: number }> };
    const included = await catalog.productActivity(2, 5) as { promotions: Array<{ id: number }> };
    expect(excluded.promotions).toEqual([]);
    expect(included.promotions.map(item => item.id)).toEqual([created.id]);
    const v2 = new V2PromotionCompatibilityService(container, {} as Env);
    const decorated = await v2.decorateCatalogProducts([{ id: 1 }, { id: 2 }]);
    expect(decorated[0].activity_frame).toEqual([]);
    expect(decorated[1].activity_frame).toMatchObject({ id: created.id, name: body.name });
  });

  it('soft-deletes same-type derived shop promotions without touching a different promotion type', async () => {
    const created = await service.mutate('create', 0, base(), { id: 9 });
    await fixture.db.insert(storePromotions).values([
      { id: 9901, pid: created.id, promotionsType: 5, type: 2, storeId: 7,
        name: '门店派生边框', image: '/shop-frame.png' },
      { id: 9902, pid: created.id, promotionsType: 6, type: 2, storeId: 7,
        name: '不同类型派生背景', image: '/shop-background.png' },
    ]);
    const { info } = await service.detail(created.id);
    await service.mutate('delete', created.id, { revision: info.revision, request_id: requestId() }, { id: 9 });
    const rows = await fixture.db.select().from(storePromotions);
    expect(rows.find(row => row.id === created.id)?.isDel).toBe(1);
    expect(rows.find(row => row.id === 9901)?.isDel).toBe(1);
    expect(rows.find(row => row.id === 9902)?.isDel).toBe(0);
  });

  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('deduplicates the same UUID across independent PG16 sessions', async () => {
    const body = base(), path = `/marketing/activity-frame/request/${body.request_id.toLowerCase()}`;
    await withFinancePeers(fixture.db, async ([blocker, first, second]) => {
      await blocker.exec(`BEGIN; SELECT pg_advisory_xact_lock(hashtext('admin_activity_frame'),hashtext('9:${body.request_id}'))`);
      try {
        const firstWrite = outcome(new AdminActivityFrameService(createContainerFromDb(first.db)).mutate('create', 0, body, { id: 9 }));
        await waitForFinanceBlock(fixture.db, first.pid, blocker.pid);
        const secondWrite = outcome(new AdminActivityFrameService(createContainerFromDb(second.db)).mutate('create', 0, body, { id: 9 }));
        await waitForFinanceBlock(fixture.db, second.pid, first.pid);
        await blocker.exec('COMMIT');
        const a = await firstWrite, b = await secondWrite;
        expect(a).toMatchObject({ ok: true, value: { id: expect.any(Number) } });
        expect(b).toEqual(a);
      } finally { await blocker.exec('ROLLBACK'); }
    });
    const logs = await fixture.db.select().from(systemLog).where(eq(systemLog.path, path));
    expect(logs).toHaveLength(1);
  }, 30_000);
});
