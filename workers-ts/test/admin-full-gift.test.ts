import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createContainerFromDb, type Container } from '../src/lib/di';
import { AdminFullGiftService } from '../src/services/admin/AdminFullGiftService';
import { storeBrand, storeCouponIssue, storeOrder, storeOrderCartInfo, storeProduct,
  storeProductAttrValue, storeProductCategory, storeProductLabel, storeProductRelation,
  storePromotions, storePromotionsAuxiliary, systemLog, userLabel } from '../src/models/schema';
import { financePostgres } from './helpers/financePostgres';

const shanghai = (hours: number) => {
  const d = new Date(Date.now() + (hours + 8) * 3_600_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} `
    + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};
const uuid = () => crypto.randomUUID();
const base = () => ({ name: '秋日满送', section_time: [shanghai(-1), shanghai(24)],
  promotions_cate: 1, threshold_type: 1,
  promotions: [
    { threshold: 100, give_integral: 5, give_coupon_id: [{ give_coupon_id: 41, give_coupon_num: 10 }],
      give_product_id: [{ give_product_id: 2, unique: 'gift1111', give_product_num: 10 }] },
    { threshold: 200, give_integral: 10, give_coupon_id: [], give_product_id: [] } ],
  is_label: 1, label_id: [31], product_partake_type: 2,
  product_id: [{ product_id: 1, unique: ['buy11111'] }], brand_id: [], store_label_id: [],
  status: 1, sort: 5, request_id: uuid() });

describe('Admin full gift type-4 rules, pools, sales and isolation', () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>;
  let container: Container;
  let service: AdminFullGiftService;
  beforeAll(async () => {
    fixture = await financePostgres([storePromotions, storePromotionsAuxiliary, storeCouponIssue,
      storeProduct, storeProductAttrValue, storeProductRelation, storeProductCategory,
      storeBrand, storeProductLabel, userLabel, storeOrder, storeOrderCartInfo, systemLog]);
    container = createContainerFromDb(fixture.db);
    service = new AdminFullGiftService(container);
  }, 30_000);
  afterAll(async () => { await fixture?.close(); });
  beforeEach(async () => {
    await fixture.reset();
    await fixture.db.insert(storeProductCategory).values({ id: 10, cateName: '花卉' });
    await fixture.db.insert(storeProduct).values([
      { id: 1, storeName: '购买商品', stock: 50, isShow: 1, isVerify: 1 },
      { id: 2, storeName: '赠品', stock: 20, isShow: 1, isVerify: 1 },
      { id: 3, storeName: '待审核赠品', stock: 20, isShow: 1, isVerify: 0 },
      { id: 4, pid: 1, storeName: '子商品', stock: 20, isShow: 1, isVerify: 1 },
      { id: 5, storeName: '虚拟赠品', productType: 1, stock: 20, isShow: 1, isVerify: 1 },
    ]);
    await fixture.db.insert(storeProductAttrValue).values([
      { id: 11, productId: 1, type: 0, unique: 'buy11111', stock: 50 },
      { id: 12, productId: 1, type: 0, unique: 'buy22222', stock: 50 },
      { id: 21, productId: 2, type: 0, unique: 'gift1111', suk: '赠品规格', stock: 20 },
      { id: 22, productId: 2, type: 0, unique: 'old11111', stock: 20, isRetired: 1 },
      { id: 31, productId: 3, type: 0, unique: 'bad11111', stock: 20 },
      { id: 41, productId: 4, type: 0, unique: 'kid11111', stock: 20 },
      { id: 51, productId: 5, type: 0, unique: 'virtual1', stock: 20 },
    ]);
    await fixture.db.insert(storeProductRelation).values([
      { productId: 1, type: 1, relationId: 10 },
      { productId: 1, type: 2, relationId: 11 }, { productId: 2, type: 2, relationId: 11 },
      { productId: 1, type: 3, relationId: 21 },
    ]);
    await fixture.db.insert(storeBrand).values({ id: 11, brandName: '花园', isShow: 1 });
    await fixture.db.insert(storeProductLabel).values({ id: 21, labelName: '热销', type: 0,
      relationId: 0, status: 1, isShow: 1 });
    await fixture.db.insert(userLabel).values({ id: 31, name: '常客', type: 0, relationId: 0, status: 1 });
    await fixture.db.insert(storeCouponIssue).values({ id: 41, couponTitle: '满送券',
      receiveType: 3, status: 1, remainCount: 20, day: 1 });
    await fixture.db.insert(storePromotions).values([
      { id: 101, promotionsType: 1, type: 1, storeId: 0, pid: 0, name: '相邻限时折扣' },
      { id: 102, promotionsType: 4, type: 2, storeId: 7, pid: 0, name: '门店满送' },
      { id: 103, promotionsType: 4, type: 1, storeId: 0, pid: 77, name: '非根子行' },
      { id: 104, promotionsType: 4, type: 1, storeId: 0, pid: 0, isDel: 1, name: '已删满送' },
    ]);
  }, 30_000);

  it('creates tiers and pools, shows complete identity and pages all option types', async () => {
    const created = await service.mutate('create', 0, base(), { id: 9 });
    const [root] = await fixture.db.select().from(storePromotions).where(eq(storePromotions.id, created.id));
    expect(root).toMatchObject({ promotionsType: 4, type: 1, storeId: 0, pid: 0,
      giveIntegral: 5, giveCouponId: '41', giveProductId: '2', giveProductUnique: 'gift1111',
      overlay: '', isLimit: 0, limitNum: 0 });
    const [tier] = await fixture.db.select().from(storePromotions).where(eq(storePromotions.pid, created.id));
    expect(tier).toMatchObject({ threshold: '200.00', giveIntegral: 10, promotionsType: 4 });
    const pool = await fixture.db.select().from(storePromotionsAuxiliary)
      .where(eq(storePromotionsAuxiliary.promotionsId, created.id));
    expect(pool).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 2, couponId: 41, limitNum: 10, surplusNum: 10, isAll: 1 }),
      expect.objectContaining({ type: 3, productId: 2, unique: 'gift1111', limitNum: 10,
        surplusNum: 10, isAll: 1 }),
    ]));
    const { info } = await service.detail(created.id);
    expect(info).toMatchObject({ promotions_type: 4, product_count: 1,
      promotions: [{ id: created.id, threshold: 100, give_integral: 5,
        give_coupon_id: [{ give_coupon_id: 41, give_coupon_num: 10 }],
        give_product_id: [{ give_product_id: 2, unique: 'gift1111', give_product_num: 10 }],
        giveCoupon: [{ id: expect.any(Number), coupon_title: '满送券' }],
        giveProducts: [{ id: expect.any(Number), store_name: '赠品',
          sku: { unique: 'gift1111', is_retired: 0 } }] }, { id: tier.id, give_integral: 10 }],
      product_id: [{ product_id: 1, unique: ['buy11111'] }],
      products: [{ id: 1, attrValue: [{ unique: 'buy11111' }] }],
      user_labels: [{ id: 31, label_name: '常客' }], selection_issues: [],
      sum_order: 0, sum_pay_price: '0.00' });
    for (const kind of ['products', 'brands', 'labels', 'user-labels', 'coupons'] as const) {
      expect(await service.choices(kind, new URLSearchParams('limit=1')))
        .toMatchObject({ page: 1, limit: 1, list: [expect.any(Object)] });
    }
    expect((await service.list(new URLSearchParams('threshold_type=1&status=1&name=%E7%A7%8B%E6%97%A5')))
      .count).toBe(1);
  });

  it('preserves consumed pool balance and IDs through edits and retires removed tier/pools', async () => {
    const created = await service.mutate('create', 0, base(), { id: 9 });
    const pool = await fixture.db.select().from(storePromotionsAuxiliary)
      .where(eq(storePromotionsAuxiliary.promotionsId, created.id));
    const couponId = pool.find(row => row.type === 2)!.id;
    const giftId = pool.find(row => row.type === 3)!.id;
    for (const id of [couponId, giftId]) await fixture.db.update(storePromotionsAuxiliary)
      .set({ surplusNum: 2 }).where(eq(storePromotionsAuxiliary.id, id));
    await fixture.db.update(storeCouponIssue).set({ remainCount: 2 }).where(eq(storeCouponIssue.id, 41));
    await fixture.db.update(storeProduct).set({ stock: 2 }).where(eq(storeProduct.id, 2));
    await fixture.db.update(storeProductAttrValue).set({ stock: 2 })
      .where(eq(storeProductAttrValue.id, 21));
    let info = (await service.detail(created.id)).info;
    const oldTierId = Number(info.promotions[1].id);
    const rules = info.promotions.map(rule => ({ id: rule.id, threshold: rule.threshold,
      give_integral: rule.give_integral, give_coupon_id: rule.give_coupon_id,
      give_product_id: rule.give_product_id }));
    await service.mutate('update', created.id, { ...base(), name: '只改名称',
      promotions: rules, revision: info.revision }, { id: 9 });
    let after = await fixture.db.select().from(storePromotionsAuxiliary);
    expect(after.find(row => row.id === couponId)).toMatchObject({ limitNum: 10, surplusNum: 2, isAll: 1 });
    expect(after.find(row => row.id === giftId)).toMatchObject({ limitNum: 10, surplusNum: 2, isAll: 1 });
    info = (await service.detail(created.id)).info;
    await expect(service.mutate('update', created.id, { ...base(), revision: info.revision,
      promotions: [{ ...rules[0], give_coupon_id: [{ give_coupon_id: 41, give_coupon_num: 7 }] }],
    }, { id: 9 })).rejects.toThrow('不能低于已使用');
    await service.mutate('update', created.id, { ...base(), revision: info.revision,
      promotions: [{ id: created.id, threshold: 100, give_integral: 5,
        give_coupon_id: [], give_product_id: [] }] }, { id: 9 });
    after = await fixture.db.select().from(storePromotionsAuxiliary);
    expect(after.find(row => row.id === couponId)?.isAll).toBe(0);
    expect(after.find(row => row.id === giftId)?.isAll).toBe(0);
    const [oldTier] = await fixture.db.select().from(storePromotions).where(eq(storePromotions.id, oldTierId));
    expect(oldTier.isDel).toBe(1);
  });

  it('rejects unsupported scope/overlay/quota and retired materials; isolates CAS and derived deletion', async () => {
    for (const id of [101, 102, 103, 104]) await expect(service.detail(id)).rejects.toMatchObject({ code: 404 });
    await fixture.db.insert(storeCouponIssue).values({ id: 42, couponTitle: '券'.repeat(65),
      receiveType: 3, status: 1, remainCount: 10, day: 1 });
    for (const invalid of [
      { ...base(), promotions_cate: 2 },
      { ...base(), promotions: [{ threshold: 100, give_integral: 0,
        give_coupon_id: [], give_product_id: [] }] },
      { ...base(), product_partake_type: 3 }, { ...base(), overlay: [1] },
      { ...base(), is_limit: 1 },
      { ...base(), product_id: [{ product_id: 4, unique: ['kid11111'] }] },
      { ...base(), promotions: [{ threshold: 100, give_integral: 0,
        give_coupon_id: [{ give_coupon_id: 42, give_coupon_num: 1 }], give_product_id: [] }] },
      { ...base(), promotions: [{ threshold: 100, give_integral: 0, give_coupon_id: [],
        give_product_id: [{ give_product_id: 3, unique: 'bad11111', give_product_num: 1 }] }] },
      { ...base(), promotions: [{ threshold: 100, give_integral: 0, give_coupon_id: [],
        give_product_id: [{ give_product_id: 5, unique: 'virtual1', give_product_num: 1 }] }] },
      { ...base(), promotions: [{ threshold: 100, give_integral: 0, give_coupon_id: [],
        give_product_id: [{ give_product_id: 2, unique: 'old11111', give_product_num: 1 }] }] },
      { ...base(), label_id: Array.from({ length: 101 }, (_, i) => i + 1) },
    ]) await expect(service.mutate('create', 0, invalid, { id: 9 })).rejects.toMatchObject({ code: 400 });
    expect((await service.choices('coupons', new URLSearchParams())).count).toBe(1);
    const input = base(), created = await service.mutate('create', 0, input, { id: 9 });
    expect(await service.mutate('create', 0, input, { id: 9 })).toEqual(created);
    await expect(service.mutate('create', 0, { ...input, name: '重用UUID' }, { id: 9 }))
      .rejects.toMatchObject({ code: 409 });
    await fixture.db.insert(storePromotions).values([
      { id: 301, pid: created.id, promotionsType: 4, type: 2, storeId: 7, name: '门店派生' },
      { id: 302, pid: created.id, promotionsType: 2, type: 1, storeId: 0, name: '异类型子行' },
    ]);
    const info = (await service.detail(created.id)).info;
    await expect(service.mutate('status', created.id, { status: 0,
      revision: '0'.repeat(64), request_id: uuid() }, { id: 9 })).rejects.toMatchObject({ code: 409 });
    await service.mutate('delete', created.id, { revision: info.revision, request_id: uuid() }, { id: 9 });
    const rows = await fixture.db.select().from(storePromotions);
    expect(rows.find(row => row.id === 301)?.isDel).toBe(1);
    expect(rows.find(row => row.id === 302)?.isDel).toBe(0);
    expect(rows.find(row => row.id === 101)?.isDel).toBe(0);
    expect(await fixture.db.select().from(systemLog).where(eq(systemLog.type, 'full_gift'))).toHaveLength(2);
  });

  it('counts paid original roots once from purchased type-4 cart evidence', async () => {
    const created = await service.mutate('create', 0, base(), { id: 9 });
    await fixture.db.insert(storeOrder).values([
      { id: 501, orderId: 'gift-root', unique: 'gift-root', uid: 7, pid: -1,
        paid: 1, payPrice: '55.97' },
      { id: 502, orderId: 'gift-child', unique: 'gift-child', uid: 7, pid: 501,
        paid: 1, payPrice: '55.97' },
      { id: 503, orderId: 'gift-second', unique: 'gift-second', uid: 7, pid: 0,
        paid: 1, payPrice: '20.00' },
      { id: 504, orderId: 'gift-unpaid', unique: 'gift-unpaid', uid: 8, pid: 0,
        paid: 0, payPrice: '99.00' },
    ]);
    await fixture.db.insert(storeOrderCartInfo).values([
      { oid: 501, uid: 7, unique: 'gift-cart-root', cartNum: 1,
        promotionsId: `${created.id},101`, cartInfo: '{}' },
      { oid: 502, uid: 7, unique: 'gift-cart-child', cartNum: 1,
        promotionsId: String(created.id), cartInfo: '{}' },
      { oid: 503, uid: 7, unique: 'gift-cart-second', cartNum: 1,
        promotionsId: String(created.id), cartInfo: '{}' },
      { oid: 504, uid: 8, unique: 'gift-cart-unpaid', cartNum: 1,
        promotionsId: String(created.id), cartInfo: '{}' },
    ]);
    expect((await service.detail(created.id)).info).toMatchObject({ sum_pay_price: '75.97',
      sum_order: 2, sum_user: 1, old_user: 1, new_user: 0 });
    expect((await service.list(new URLSearchParams())).list[0]).not.toHaveProperty('sum_promotions_price');
  });
});
