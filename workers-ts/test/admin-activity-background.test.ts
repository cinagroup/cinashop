import { systemStore, systemSupplier } from '../src/models/schema';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { AppVariables, Env } from '../src/env';
import { createContainerFromDb, type Container } from '../src/lib/di';
import {
  storeCouponIssue, storeCouponProduct, storeDiscounts, storeDiscountsProducts,
  storeBrand, storeProduct, storeProductCategory, storeProductLabel, storeProductRelation,
  storePromotions, storePromotionsAuxiliary, systemDise, systemLog,
} from '../src/models/schema';
import * as background from '../src/controllers/api/v1/AdminActivityBackgroundController';
import { AdminActivityBackgroundService } from '../src/services/admin/AdminActivityBackgroundService';
import { AdminActivityFrameService } from '../src/services/admin/AdminActivityFrameService';
import { PublicCatalogService } from '../src/services/product/PublicCatalogService';
import { V2PromotionCompatibilityService } from '../src/services/activity/V2PromotionCompatibilityService';
import { financePostgres } from './helpers/financePostgres';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';

const future = (hours: number) => {
  const date = new Date(Date.now() + (hours + 8) * 3_600_000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
};
const requestId = () => crypto.randomUUID();
const base = () => ({ name: '秋日活动背景', image: '/uploads/background.png', product_partake_type: 2,
  product_id: [1, 2], brand_id: [], store_label_id: [],
  section_time: [future(2), future(26)], status: 1, sort: 5, request_id: requestId() });

describe('Admin activity background store_promotions type=6 contract', () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>;
  let container: Container;
  let service: AdminActivityBackgroundService;

  beforeAll(async () => {
    fixture = await financePostgres([systemStore, systemSupplier, storePromotions, storePromotionsAuxiliary, storeProduct,
      storeProductRelation, storeProductCategory, storeBrand, storeProductLabel, systemLog,
      storeCouponIssue, storeCouponProduct, storeDiscounts, storeDiscountsProducts, systemDise]);
    container = createContainerFromDb(fixture.db);
    service = new AdminActivityBackgroundService(container);
  }, 30_000);
  afterAll(async () => { await fixture?.close(); });
  beforeEach(async () => {
    await fixture.reset();
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
      { id: 101, promotionsType: 5, type: 1, storeId: 0, pid: 0, name: '边框', image: '/frame.png' },
      { id: 102, promotionsType: 6, type: 2, storeId: 7, pid: 0, name: '门店背景', image: '/shop.png' },
      { id: 103, promotionsType: 6, type: 1, storeId: 0, pid: 77, name: '背景子记录', image: '/child.png' },
      { id: 104, promotionsType: 6, type: 1, storeId: 0, pid: 0, isDel: 1, name: '已删除背景', image: '/deleted.png' },
    ]);
  }, 30_000);

  it('lists only platform root type=6 with stage, interval, name and stable count filters', async () => {
    expect(await service.list(new URLSearchParams())).toMatchObject({ count: 0, list: [], page: 1, limit: 15 });
    const body = base(), created = await service.mutate('create', 0, body, { id: 9 });
    const result = await service.list(new URLSearchParams('status=0&name=%E7%A7%8B%E6%97%A5&page=1&limit=1'));
    expect(result).toMatchObject({ count: 1, page: 1, limit: 1,
      list: [{ id: created.id, promotionsType: 6, start_status: 0, product_count: 2 }] });
    expect(result.list[0].revision).toMatch(/^[a-f0-9]{64}$/);
    expect((await service.list(new URLSearchParams('status=1'))).count).toBe(0);
    const [start, end] = body.section_time;
    expect((await service.list(new URLSearchParams({ time: `${start} - ${end}` }))).count).toBe(1);
    expect((await service.list(new URLSearchParams({ time: `${future(48)} - ${future(72)}` }))).count).toBe(0);
    const createdAt = result.list[0].add_time;
    expect((await service.list(new URLSearchParams({ create_time: `${createdAt} - ${createdAt}` }))).count).toBe(1);
    expect(await service.list(new URLSearchParams('page=2&limit=1'))).toMatchObject({ list: [], count: 1 });
    expect((await service.detail(created.id)).info).toMatchObject({ product_id: [1, 2],
      products: [{ id: 1 }, { id: 2 }], brand_id: [], store_label_id: [] });
  });

  it('replaces all five scopes and counts approved parent products only', async () => {
    const created = await service.mutate('create', 0, base(), { id: 9 });
    const detail = async () => (await service.detail(created.id)).info;
    let row = await detail();
    expect(row.product_count).toBe(2);
    const change = async (scope: number, selected: Record<string, number[]>) => {
      await service.mutate('update', created.id,
        { ...base(), ...selected, product_partake_type: scope, revision: row.revision }, { id: 9 });
      row = await detail();
      return row;
    };
    expect((await change(3, { product_id: [1] })).product_count).toBe(2);
    expect(row.product_id).toEqual([1]);
    expect((await change(4, { product_id: [], brand_id: [11] })).product_count).toBe(2);
    expect(row.brands).toEqual([{ id: 11, brand_name: '花园' }]);
    expect((await change(5, { product_id: [], store_label_id: [21] })).product_count).toBe(2);
    expect(row.labels).toEqual([{ id: 21, label_name: '热销' }]);
    expect((await change(1, { product_id: [] })).product_count).toBe(3);
    expect(row.product_id).toEqual([]);
    expect(await fixture.db.select().from(storePromotionsAuxiliary)
      .where(eq(storePromotionsAuxiliary.promotionsId, created.id))).toEqual([]);
    for (const selected of [[4], [5], [6]]) {
      await expect(service.mutate('update', created.id,
        { ...base(), product_id: selected, revision: row.revision }, { id: 9 }))
        .rejects.toMatchObject({ code: 400 });
    }
    expect((await detail()).revision).toBe(row.revision);
  });

  it('rejects invalid background payloads and cannot read or mutate other types or non-root rows', async () => {
    const invalid = [
      { ...base(), product_partake_type: 2, product_id: [] },
      { ...base(), product_partake_type: 3, product_id: [] },
      { ...base(), product_partake_type: 4, brand_id: [12] },
      { ...base(), product_partake_type: 5, store_label_id: [99] },
      { ...base(), promotions_type: 5 },
      { ...base(), section_time: [future(48), future(24)] },
      { ...base(), name: '' },
      { ...base(), image: 'javascript:alert(1)' },
    ];
    for (const body of invalid) await expect(service.mutate('create', 0, body, { id: 9 }))
      .rejects.toMatchObject({ code: 400 });
    for (const id of [101, 102, 103, 104]) {
      await expect(service.detail(id)).rejects.toMatchObject({ code: 404 });
      await expect(service.mutate('status', id,
        { status: 0, revision: '0'.repeat(64), request_id: requestId() }, { id: 9 }))
        .rejects.toMatchObject({ code: 404 });
    }
    for (const query of ['page=0', 'limit=1000', 'status=2', 'status=1&status=0', 'time=bad', 'unknown=1']) {
      await expect(service.list(new URLSearchParams(query))).rejects.toMatchObject({ code: 400 });
    }
    expect((await service.list(new URLSearchParams())).count).toBe(0);
    expect(await fixture.db.select().from(systemLog)).toEqual([]);
  });

  it('exposes all nine background controller operations with exact envelopes and no-store responses', async () => {
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use('*', async (c, next) => {
      c.set('container', container);
      c.set('adminInfo', { id: 9, account: 'admin', realName: 'admin', level: 1, roles: '', divisionId: 0 });
      await next();
    });
    const path = '/marketing/activity-background';
    app.get(path, background.list);
    app.get(`${path}/products`, background.products);
    app.get(`${path}/brands`, background.brands);
    app.get(`${path}/labels`, background.labels);
    app.get(`${path}/:id`, background.detail);
    app.post(path, background.create);
    app.put(`${path}/:id`, background.update);
    app.patch(`${path}/:id/status`, background.status);
    app.delete(`${path}/:id`, background.remove);
    const get = async (suffix: string) => {
      const response = await app.request(`http://localhost${path}${suffix}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toContain('no-store');
      return (await response.json() as { status: number; data: any }).data;
    };
    const write = async (method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', suffix: string, body: object) => {
      const response = await app.request(`http://localhost${path}${suffix}`, {
        method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toContain('no-store');
      const json = await response.json() as { status: number; data: { id: number } };
      expect(json.status).toBe(200);
      return json.data;
    };
    expect(await get('')).toMatchObject({ count: 0, list: [] });
    expect(await get('/products?page=1&limit=2')).toMatchObject({ count: 3, page: 1, limit: 2,
      list: [{ id: 3, store_name: '茉莉' }, { id: 2, store_name: '百合' }] });
    expect(await get('/brands?keyword=%E8%8A%B1')).toMatchObject({ count: 1,
      list: [{ id: 11, brand_name: '花园' }] });
    expect(await get('/labels?page=2&limit=1')).toMatchObject({ count: 2, page: 2, limit: 1,
      list: [{ id: 21, label_name: '热销' }] });
    const created = await write('POST', '', base());
    let info = (await get(`/${created.id}`)).info;
    expect(info).toMatchObject({ id: created.id, promotionsType: 6, product_id: [1, 2] });
    expect(await get('')).toMatchObject({ count: 1, list: [{ id: created.id }] });
    expect(await write('PUT', `/${created.id}`, { ...base(), name: '更新背景', revision: info.revision }))
      .toEqual({ id: created.id });
    info = (await get(`/${created.id}`)).info;
    expect(info.name).toBe('更新背景');
    expect(await write('PATCH', `/${created.id}/status`,
      { status: 0, revision: info.revision, request_id: requestId() })).toEqual({ id: created.id });
    info = (await get(`/${created.id}`)).info;
    expect(info.status).toBe(0);
    expect(await get('?status=-1')).toMatchObject({ count: 1, list: [{ id: created.id, start_status: -1 }] });
    expect(await write('DELETE', `/${created.id}`,
      { revision: info.revision, request_id: requestId() })).toEqual({ id: created.id });
    expect(await get('')).toMatchObject({ count: 0, list: [] });
  });

  it('keeps frame and background UUID logs separate while enforcing background CAS and replay', async () => {
    const request = requestId(), body = { ...base(), request_id: request };
    const created = await service.mutate('create', 0, body, { id: 9 });
    const frames = new AdminActivityFrameService(container);
    const frameCreated = await frames.mutate('create', 0,
      { ...body, name: '同一请求号的边框', image: '/uploads/frame.png' }, { id: 9 });
    expect(frameCreated.id).not.toBe(created.id);
    expect(await service.mutate('create', 0, body, { id: 9 })).toEqual(created);
    await expect(service.mutate('create', 0, { ...body, name: '变更后的背景' }, { id: 9 }))
      .rejects.toMatchObject({ code: 409 });
    const first = (await service.detail(created.id)).info;
    const off = { status: 0, revision: first.revision, request_id: requestId() };
    expect(await service.mutate('status', created.id, off, { id: 9 })).toEqual(created);
    expect(await service.mutate('status', created.id, off, { id: 9 })).toEqual(created);
    await expect(service.mutate('status', created.id,
      { status: 1, revision: first.revision, request_id: requestId() }, { id: 9 }))
      .rejects.toMatchObject({ code: 409 });
    const second = (await service.detail(created.id)).info;
    const remove = { revision: second.revision, request_id: requestId() };
    expect(await service.mutate('delete', created.id, remove, { id: 9 })).toEqual(created);
    expect(await service.mutate('delete', created.id, remove, { id: 9 })).toEqual(created);
    expect((await service.list(new URLSearchParams())).count).toBe(0);
    expect((await frames.detail(frameCreated.id)).info.promotionsType).toBe(5);
    const backgroundLogs = await fixture.db.select().from(systemLog).where(eq(systemLog.type, 'activity_background'));
    const frameLogs = await fixture.db.select().from(systemLog).where(eq(systemLog.type, 'activity_frame'));
    expect(backgroundLogs).toHaveLength(3);
    expect(frameLogs).toHaveLength(1);
    expect(backgroundLogs[0].path).toBe(`/marketing/activity-background/request/${request.toLowerCase()}`);
    expect(frameLogs[0].path).toBe(`/marketing/activity-frame/request/${request.toLowerCase()}`);
  });

  it('soft-deletes same-type store children with a background root but preserves other-type children', async () => {
    const created = await service.mutate('create', 0, base(), { id: 9 });
    await fixture.db.insert(storePromotions).values([
      { id: 201, pid: created.id, type: 2, storeId: 7, promotionsType: 6, name: '门店背景子促销' },
      { id: 202, pid: created.id, type: 2, storeId: 7, promotionsType: 5, name: '门店边框子促销' },
    ]);
    const current = (await service.detail(created.id)).info;
    await service.mutate('delete', created.id, { revision: current.revision, request_id: requestId() }, { id: 9 });
    for (const [id, isDel] of [[created.id, 1], [201, 1], [202, 0]]) {
      const [row] = await fixture.db.select().from(storePromotions).where(eq(storePromotions.id, id));
      expect(row.isDel).toBe(isDel);
    }
    const [unrelatedFrame] = await fixture.db.select().from(storePromotions).where(eq(storePromotions.id, 101));
    expect(unrelatedFrame.isDel).toBe(0);
  });

  it('writes type=6 exclusion rows used by real PublicCatalog and V2 activity_background consumers', async () => {
    const body = { ...base(), product_partake_type: 3, product_id: [1],
      section_time: [future(-1), future(2)] };
    const created = await service.mutate('create', 0, body, { id: 9 });
    const relations = await fixture.db.select().from(storePromotionsAuxiliary)
      .where(eq(storePromotionsAuxiliary.promotionsId, created.id));
    expect(relations).toMatchObject([{ type: 1, productPartakeType: 3, productId: 1, isAll: 1 }]);
    const catalog = new PublicCatalogService(container, {} as Env);
    const excluded = await catalog.productActivity(1, 6);
    const included = await catalog.productActivity(2, 6);
    expect(excluded.activity_background).toEqual([]);
    expect(included.activity_background).toEqual({ id: created.id, name: body.name, image: body.image });
    expect(included.promotions).toEqual([]);
    const v2 = new V2PromotionCompatibilityService(container, {} as Env);
    const decorated = await v2.decorateCatalogProducts([{ id: 1 }, { id: 2 }, { id: 6, pid: 1 }]);
    expect(decorated[0].activity_background).toEqual([]);
    expect(decorated[1].activity_background).toEqual({ id: created.id, name: body.name, image: body.image });
    expect(decorated[2].activity_background).toEqual([]);
  });

  it.each([2, 3, 4, 5] as const)(
    'ignores type=6 auxiliary rows with a mismatched scope for product scope %i', async scope => {
      const target = scope === 4 ? 3 : 2;
      if (scope === 4) {
        await fixture.db.insert(storeBrand).values({ id: 13, brandName: '新品牌', isShow: 1, isDel: 0 });
        await fixture.db.insert(storeProductRelation).values({ productId: 3, type: 2, relationId: 13 });
      }
      if (scope === 5) {
        await fixture.db.insert(storeProductRelation).values({ productId: 2, type: 3, relationId: 22 });
      }
      const body = { ...base(), product_partake_type: scope,
        product_id: scope === 2 || scope === 3 ? [1] : [],
        brand_id: scope === 4 ? [11] : [], store_label_id: scope === 5 ? [21] : [],
        section_time: [future(-1), future(2)] };
      const created = await service.mutate('create', 0, body, { id: 9 });
      const selected = scope === 2 || scope === 3 ? { productId: target }
        : scope === 4 ? { brandId: 13 } : { storeLabelId: 22 };
      const incorrectScope = scope === 2 ? 4 : scope === 3 ? 2 : scope === 4 ? 5 : 4;
      await fixture.db.insert(storePromotionsAuxiliary).values({
        type: 1, promotionsId: created.id, productPartakeType: incorrectScope, isAll: 1, ...selected,
      });
      const catalog = new PublicCatalogService(container, {} as Env);
      const v2 = new V2PromotionCompatibilityService(container, {} as Env);
      const expectConsumers = async (matched: boolean) => {
        const expected = matched ? { id: created.id, name: body.name, image: body.image } : [];
        expect((await catalog.productActivity(target, 6)).activity_background).toEqual(expected);
        const [decorated] = await v2.decorateCatalogProducts([{ id: target }]);
        expect(decorated.activity_background).toEqual(expected);
      };
      const before = scope === 2 ? 1 : 2;
      expect((await service.detail(created.id)).info.product_count).toBe(before);
      await expectConsumers(scope === 3);
      await fixture.db.insert(storePromotionsAuxiliary).values({
        type: 1, promotionsId: created.id, productPartakeType: scope, isAll: 1, ...selected,
      });
      expect((await service.detail(created.id)).info.product_count).toBe(scope === 3 ? before - 1 : before + 1);
      await expectConsumers(scope !== 3);
    },
  );

  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('deduplicates a background UUID across independent PG16 sessions', async () => {
    const body = base(), path = `/marketing/activity-background/request/${body.request_id.toLowerCase()}`;
    await withFinancePeers(fixture.db, async ([blocker, first, second]) => {
      await blocker.exec(`BEGIN; SELECT pg_advisory_xact_lock(hashtext('admin_activity_background'),hashtext('9:${body.request_id}'))`);
      try {
        const firstWrite = outcome(new AdminActivityBackgroundService(createContainerFromDb(first.db))
          .mutate('create', 0, body, { id: 9 }));
        await waitForFinanceBlock(fixture.db, first.pid, blocker.pid);
        const secondWrite = outcome(new AdminActivityBackgroundService(createContainerFromDb(second.db))
          .mutate('create', 0, body, { id: 9 }));
        await waitForFinanceBlock(fixture.db, second.pid, first.pid);
        await blocker.exec('COMMIT');
        const a = await firstWrite, b = await secondWrite;
        expect(a).toMatchObject({ ok: true, value: { id: expect.any(Number) } });
        expect(b).toEqual(a);
      } finally { await blocker.exec('ROLLBACK'); }
    });
    const logs = await fixture.db.select().from(systemLog).where(eq(systemLog.path, path));
    expect(logs).toHaveLength(1);
    expect(logs[0].type).toBe('activity_background');
  }, 30_000);
});
