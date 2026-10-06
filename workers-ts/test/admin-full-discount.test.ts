import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { AppVariables, Env } from '../src/env';
import { createContainerFromDb, type Container } from '../src/lib/di';
import {
  storeBrand, storeOrder, storeOrderCartInfo, storeOrderPromotions, storeProduct,
  storeProductAttrValue, storeProductCategory, storeProductLabel, storeProductRelation,
  storePromotions, storePromotionsAuxiliary, systemLog, userLabel,
} from '../src/models/schema';
import * as controller from '../src/controllers/api/v1/AdminFullDiscountController';
import { AdminFullDiscountService } from '../src/services/admin/AdminFullDiscountService';
import { financePostgres } from './helpers/financePostgres';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';

const future = (hours: number) => {
  const date = new Date(Date.now() + (hours + 8) * 3_600_000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
};
const requestId = () => crypto.randomUUID();
const base = () => ({ name: '秋日满减满折', section_time: [future(-1), future(24)],
  promotions_cate: 1, threshold_type: 1,
  promotions: [{ threshold: 100, discount_type: 1, discount: 10 },
    { threshold: 200, discount_type: 2, discount: 80 }],
  is_label: 1, label_id: [31], is_overlay: 1, overlay: [1, 5],
  product_partake_type: 2, product_id: [{ product_id: 1, unique: ['abc11111'] }],
  brand_id: [], store_label_id: [], status: 1, sort: 5, request_id: requestId() });

describe('Admin platform full discount type=3 contract', () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>;
  let container: Container;
  let service: AdminFullDiscountService;
  beforeAll(async () => {
    fixture = await financePostgres([storePromotions, storePromotionsAuxiliary, storeProduct,
      storeProductAttrValue, storeProductRelation, storeProductCategory, storeBrand,
      storeProductLabel, userLabel, storeOrder, storeOrderCartInfo, storeOrderPromotions, systemLog]);
    container = createContainerFromDb(fixture.db);
    service = new AdminFullDiscountService(container);
  }, 30_000);
  afterAll(async () => { await fixture?.close(); });
  beforeEach(async () => {
    await fixture.reset();
    await fixture.db.insert(storeProductCategory).values({ id: 10, cateName: '花卉' });
    await fixture.db.insert(storeProduct).values([
      { id: 1, storeName: '玫瑰', isShow: 1, isVerify: 1 },
      { id: 2, storeName: '百合', isShow: 1, isVerify: 1 },
      { id: 3, storeName: '茉莉', isShow: 1, isVerify: 1 },
      { id: 4, pid: 1, storeName: '子商品', isShow: 1, isVerify: 1 },
      { id: 5, storeName: '待审核', isShow: 1, isVerify: 0 },
    ]);
    await fixture.db.insert(storeProductAttrValue).values([
      { id: 11, productId: 1, type: 0, unique: 'abc11111', suk: '红色', price: '19.99' },
      { id: 12, productId: 1, type: 0, unique: 'abc22222', suk: '粉色', price: '20.00' },
      { id: 13, productId: 2, type: 0, unique: 'def11111', suk: '白色', price: '29.00' },
      { id: 14, productId: 3, type: 0, unique: 'ghi11111', suk: '黄色', price: '39.00' },
      { id: 15, productId: 4, type: 0, unique: 'kid11111', suk: '子规格' },
      { id: 16, productId: 5, type: 0, unique: 'bad11111', suk: '待审核规格' },
      { id: 17, productId: 1, type: 0, unique: 'old11111', isRetired: 1 },
    ]);
    await fixture.db.insert(storeProductRelation).values([
      { productId: 1, type: 1, relationId: 10 },
      { productId: 1, type: 2, relationId: 11 }, { productId: 2, type: 2, relationId: 11 },
      { productId: 1, type: 3, relationId: 21 }, { productId: 3, type: 3, relationId: 21 },
    ]);
    await fixture.db.insert(storeBrand).values([{ id: 11, brandName: '花园', isShow: 1 }]);
    await fixture.db.insert(storeProductLabel).values([{ id: 21, labelName: '热销', type: 0,
      relationId: 0, status: 1, isShow: 1 }]);
    await fixture.db.insert(userLabel).values([{ id: 31, name: '常客', type: 0, relationId: 0, status: 1 }]);
    await fixture.db.insert(storePromotions).values([
      { id: 101, promotionsType: 1, type: 1, storeId: 0, pid: 0, name: '限时折扣' },
      { id: 102, promotionsType: 3, type: 2, storeId: 7, pid: 0, name: '门店满减' },
      { id: 103, promotionsType: 3, type: 1, storeId: 0, pid: 77, name: '非根子行' },
      { id: 104, promotionsType: 3, type: 1, storeId: 0, pid: 0, isDel: 1, name: '已删除满减' },
    ]);
  }, 30_000);

  it('persists ascending platform tiers and round-trips exact SKU, labels and sale fields', async () => {
    const created = await service.mutate('create', 0, base(), { id: 9 });
    const [root] = await fixture.db.select().from(storePromotions).where(eq(storePromotions.id, created.id));
    expect(root).toMatchObject({ promotionsType: 3, type: 1, storeId: 0, pid: 0,
      promotionsCate: 1, thresholdType: 1, threshold: '100.00', discountType: 1,
      discount: '10.00', labelId: '31', overlay: '1,5', description: '满100元减10元,满200元打8折' });
    const rows = await fixture.db.select().from(storePromotions).where(eq(storePromotions.pid, created.id));
    expect(rows).toMatchObject([{ promotionsType: 3, type: 1, storeId: 0, threshold: '200.00',
      discountType: 2, discount: '80.00' }]);
    const links = await fixture.db.select().from(storePromotionsAuxiliary)
      .where(eq(storePromotionsAuxiliary.promotionsId, created.id));
    expect(links).toMatchObject([{ productPartakeType: 2, productId: 1, unique: 'abc11111', isAll: 0 }]);
    const { info } = await service.detail(created.id);
    expect(info).toMatchObject({ promotions_type: 3, promotions_cate: 1, threshold_type: 1,
      desc: '满100元减10元,满200元打8折', product_count: 1,
      promotions: [{ threshold: 100, discount_type: 1, discount: 10 },
        { threshold: 200, discount_type: 2, discount: 80 }],
      product_id: [{ product_id: 1, unique: ['abc11111'] }],
      products: [{ id: 1, attrValue: [{ unique: 'abc11111' }] }],
      user_labels: [{ id: 31, label_name: '常客' }], is_label: 1, is_overlay: 1,
      selection_issues: [], sum_order: 0 });
    expect(info.revision).toMatch(/^[a-f\d]{64}$/);
    expect(await service.list(new URLSearchParams('threshold_type=1&status=1&name=%E7%A7%8B%E6%97%A5&limit=1')))
      .toMatchObject({ count: 1, list: [{ id: created.id, threshold_type: 1, product_count: 1 }] });
    expect((await service.list(new URLSearchParams('threshold_type=2'))).count).toBe(0);
  });

  it('updates only platform tiers, preserves historical rows, and deletes same-type derived children', async () => {
    const created = await service.mutate('create', 0, base(), { id: 9 });
    const [oldTier] = await fixture.db.select().from(storePromotions).where(eq(storePromotions.pid, created.id));
    await fixture.db.insert(storePromotions).values([
      { id: 301, pid: created.id, promotionsType: 3, type: 2, storeId: 7, name: '门店派生' },
      { id: 302, pid: created.id, promotionsType: 2, type: 1, storeId: 0, name: '异类型平台子行' },
    ]);
    let info = (await service.detail(created.id)).info;
    expect(info.promotions).toHaveLength(2);
    await service.mutate('update', created.id, { ...base(), revision: info.revision,
      promotions: [{ threshold: 3, discount_type: 1, discount: 0.01 },
        { threshold: 6, discount_type: 2, discount: 0 }], threshold_type: 2 }, { id: 9 });
    const after = await fixture.db.select().from(storePromotions);
    expect(after.find(row => row.id === oldTier.id)?.isDel).toBe(1);
    expect(after.find(row => row.id === 301)?.isDel).toBe(0);
    expect(after.find(row => row.id === 302)?.isDel).toBe(0);
    info = (await service.detail(created.id)).info;
    expect(info.promotions).toMatchObject([{ threshold: 3, discount: 0.01 },
      { threshold: 6, discount_type: 2, discount: 0 }]);
    expect(info.promotions).toHaveLength(2);
    await service.mutate('delete', created.id, { revision: info.revision, request_id: requestId() }, { id: 9 });
    const deleted = await fixture.db.select().from(storePromotions);
    expect(deleted.find(row => row.id === 301)?.isDel).toBe(1);
    expect(deleted.find(row => row.id === 302)?.isDel).toBe(0);
    expect(deleted.find(row => row.id === 101)?.isDel).toBe(0);
  });

  it('validates real staircase/cycle rules, all scopes and current material identity', async () => {
    const cycle = { ...base(), promotions_cate: 2,
      promotions: [{ threshold: 3, discount_type: 1, discount: 1.25 }], threshold_type: 2 };
    const created = await service.mutate('create', 0, cycle, { id: 9 });
    expect((await service.detail(created.id)).info).toMatchObject({ desc: '每满3件减1.25元',
      promotions: [{ threshold: 3, discount_type: 1, discount: 1.25 }] });
    let revision = (await service.detail(created.id)).info.revision;
    const change = async (scope: number, selected: Record<string, unknown>) => {
      await service.mutate('update', created.id, { ...cycle, ...selected,
        product_partake_type: scope, revision, request_id: requestId() }, { id: 9 });
      const info = (await service.detail(created.id)).info; revision = info.revision; return info;
    };
    expect((await change(3, { product_id: [{ product_id: 1, unique: ['abc11111'] }] })).product_count).toBe(3);
    expect((await change(3, { product_id: [{ product_id: 1, unique: ['abc11111', 'abc22222'] }] })).product_count).toBe(2);
    expect((await change(4, { product_id: [], brand_id: [11] })).product_count).toBe(2);
    expect((await change(5, { product_id: [], store_label_id: [21] })).product_count).toBe(2);
    expect((await change(1, { product_id: [] })).product_count).toBe(3);
    for (const invalid of [
      { ...base(), promotions: [{ threshold: 100, discount_type: 1, discount: 10 },
        { threshold: 100, discount_type: 2, discount: 80 }] },
      { ...cycle, promotions: [{ threshold: 3, discount_type: 2, discount: 80 }] },
      { ...cycle, promotions: [{ threshold: 3, discount_type: 1, discount: 1 },
        { threshold: 6, discount_type: 1, discount: 2 }] },
      { ...base(), product_id: [{ product_id: 4, unique: ['kid11111'] }] },
      { ...base(), product_id: [{ product_id: 5, unique: ['bad11111'] }] },
      { ...base(), product_id: [{ product_id: 1, unique: ['old11111'] }] },
      { ...base(), promotions_type: 1 },
      { ...base(), overlay: [3] },
    ]) await expect(service.mutate('create', 0, invalid, { id: 9 })).rejects.toMatchObject({ code: 400 });
  });

  it('attributes only its own verified allocation from a split original paid order', async () => {
    const created = await service.mutate('create', 0, base(), { id: 9 });
    const own = { promotionId: created.id, rootId: created.id, type: 3,
      savingsCents: 30, discountQuantity: 1, labelIds: [], name: '满减满折' };
    const adjacent = { promotionId: 101, rootId: 101, type: 1,
      savingsCents: 20, discountQuantity: 1, labelIds: [], name: '限时折扣' };
    const snapshot = { cart_num: 2, sum_price: '0.67', promotions_true_price: '0.24',
      coupon_price: '0.00', integral_price: '0.00', first_order_price: '0.00', sum_true_price: '1.35',
      promotion_quote_version: 'order-promotion-quote-v1', promotion_line_price: '1.35',
      promotion_line_savings: '0.50', promotion_line_member_savings: '0.15',
      promotion_discount_quantity: 1, promotion_allocations: [own, adjacent],
      promotion_segments: [
        { quantity: 1, rawGrossCents: 100, totalPriceCents: 70, unitPriceCents: 70,
          membershipSavingsCents: 0, promotionIds: [created.id], promotionAllocations: [own], couponEligibleGrossCents: 0 },
        { quantity: 1, rawGrossCents: 100, totalPriceCents: 65, unitPriceCents: 65,
          membershipSavingsCents: 15, promotionIds: [101], promotionAllocations: [adjacent], couponEligibleGrossCents: 0 },
      ] };
    await fixture.db.insert(storeOrder).values([
      { id: 501, orderId: 'full-original', unique: 'full-original', uid: 7, pid: -1, paid: 1, payPrice: '1.35' },
      { id: 502, orderId: 'full-child', unique: 'full-child', uid: 7, pid: 501, paid: 1, payPrice: '1.35' },
    ]);
    await fixture.db.insert(storeOrderCartInfo).values([
      { oid: 501, uid: 7, unique: 'full-root-cart', cartNum: 2,
        promotionsId: `${created.id},101`, cartInfo: JSON.stringify(snapshot) },
      { oid: 502, uid: 7, unique: 'full-child-cart', cartNum: 2,
        promotionsId: `${created.id},101`, cartInfo: JSON.stringify(snapshot) },
    ]);
    expect((await service.detail(created.id)).info).toMatchObject({ sum_pay_price: '1.35',
      sum_promotions_price: '0.30', sum_order: 1, sum_user: 1 });
    expect((await service.list(new URLSearchParams())).list.find(row => row.id === created.id))
      .toMatchObject({ sum_promotions_price: '0.30', sum_order: 1 });
  });

  it('rejects more than 100 paid user labels and flags an oversized historical selection', async () => {
    const labels = Array.from({ length: 101 }, (_, index) => index + 1);
    await expect(service.mutate('create', 0, { ...base(), label_id: labels }, { id: 9 }))
      .rejects.toThrow('最多选择100个');
    const created = await service.mutate('create', 0, base(), { id: 9 });
    await fixture.db.update(storePromotions).set({ labelId: labels.join(','), status: 0 })
      .where(eq(storePromotions.id, created.id));
    const { info } = await service.detail(created.id);
    expect(info.selection_issues).toContain('付后用户标签超过100个，请编辑核对');
    await expect(service.mutate('status', created.id,
      { status: 1, revision: info.revision, request_id: requestId() }, { id: 9 }))
      .rejects.toThrow('最多选择100个');
  });

  it('isolates type=3 roots and UUID/CAS writes, and serves all ten controller endpoints', async () => {
    expect((await service.list(new URLSearchParams())).count).toBe(0);
    for (const id of [101, 102, 103, 104]) await expect(service.detail(id)).rejects.toMatchObject({ code: 404 });
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use('*', async (c, next) => { c.set('container', container);
      c.set('adminInfo', { id: 9, account: 'admin', realName: 'admin', level: 1, roles: '', divisionId: 0 });
      await next(); });
    const path = '/marketing/full-discounts';
    app.get(path, controller.list); app.get(`${path}/products`, controller.products);
    app.get(`${path}/brands`, controller.brands); app.get(`${path}/labels`, controller.labels);
    app.get(`${path}/user-labels`, controller.userLabels); app.get(`${path}/:id`, controller.detail);
    app.post(path, controller.create); app.put(`${path}/:id`, controller.update);
    app.patch(`${path}/:id/status`, controller.status); app.delete(`${path}/:id`, controller.remove);
    const get = async (suffix: string) => {
      const response = await app.request(`http://localhost${path}${suffix}`);
      expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toContain('no-store');
      return (await response.json() as { data: any }).data;
    };
    for (const suffix of ['', '/products', '/brands', '/labels', '/user-labels'])
      expect(await get(suffix)).toHaveProperty('list');
    const write = async (method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', suffix: string, body: object) => {
      const response = await app.request(`http://localhost${path}${suffix}`,
        { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      expect(response.headers.get('Cache-Control')).toContain('no-store');
      return (await response.json() as { data: { id: number } }).data;
    };
    const input = base(), created = await write('POST', '', input);
    expect(await service.mutate('create', 0, input, { id: 9 })).toEqual(created);
    await expect(service.mutate('create', 0, { ...input, name: '不同内容' }, { id: 9 }))
      .rejects.toMatchObject({ code: 409 });
    let info = (await get(`/${created.id}`)).info;
    await write('PUT', `/${created.id}`, { ...base(), revision: info.revision });
    info = (await get(`/${created.id}`)).info;
    await expect(service.mutate('update', created.id,
      { ...base(), revision: '0'.repeat(64) }, { id: 9 })).rejects.toMatchObject({ code: 409 });
    await write('PATCH', `/${created.id}/status`,
      { status: 0, revision: info.revision, request_id: requestId() });
    info = (await get(`/${created.id}`)).info;
    await write('DELETE', `/${created.id}`, { revision: info.revision, request_id: requestId() });
    expect((await get('')).count).toBe(0);
    expect(await fixture.db.select().from(systemLog).where(eq(systemLog.type, 'full_discount'))).toHaveLength(4);
  });

  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('deduplicates a UUID across PG16 peers under the shared catalogue lock', async () => {
    const input = base(), path = `/marketing/full-discounts/request/${input.request_id.toLowerCase()}`;
    await withFinancePeers(fixture.db, async ([blocker, first, second]) => {
      await blocker.exec("BEGIN; SELECT pg_advisory_xact_lock(hashtext('time_discount_catalog'),hashtext('platform_type_1'))");
      try {
        const firstWrite = outcome(new AdminFullDiscountService(createContainerFromDb(first.db))
          .mutate('create', 0, input, { id: 9 }));
        await waitForFinanceBlock(fixture.db, first.pid, blocker.pid);
        const secondWrite = outcome(new AdminFullDiscountService(createContainerFromDb(second.db))
          .mutate('create', 0, input, { id: 9 }));
        await blocker.exec('COMMIT');
        const a = await firstWrite, b = await secondWrite;
        expect(a).toMatchObject({ ok: true, value: { id: expect.any(Number) } });
        expect(b).toEqual(a);
      } finally { await blocker.exec('ROLLBACK'); }
    });
    expect(await fixture.db.select().from(systemLog).where(eq(systemLog.path, path))).toHaveLength(1);
  }, 30_000);
});
