import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { AppVariables, Env } from '../src/env';
import { createContainerFromDb, type Container } from '../src/lib/di';
import {
  storeBrand, storeOrder, storeOrderCartInfo, storeOrderPromotions,
  storeProduct, storeProductAttrValue, storeProductCategory, storeProductLabel, storeProductRelation,
  storePromotions, storePromotionsAuxiliary, systemLog, userLabel,
} from '../src/models/schema';
import * as controller from '../src/controllers/api/v1/AdminNthDiscountController';
import { AdminNthDiscountService } from '../src/services/admin/AdminNthDiscountService';
import { financePostgres } from './helpers/financePostgres';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';

const future = (hours: number) => {
  const date = new Date(Date.now() + (hours + 8) * 3_600_000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
};
const requestId = () => crypto.randomUUID();
const base = () => ({ name: '春日第N件N折', section_time: [future(-1), future(24)],
  n_piece_n_discount: 3, threshold: 3, discount: 90,
  label_id: [31], overlay: [1, 5],
  product_partake_type: 2, product_id: [{ product_id: 1, unique: ['abc11111'] }],
  brand_id: [], store_label_id: [], status: 1, sort: 5, request_id: requestId() });

describe('Admin platform nth discount type=2 contract', () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>;
  let container: Container;
  let service: AdminNthDiscountService;
  beforeAll(async () => {
    fixture = await financePostgres([storePromotions, storePromotionsAuxiliary, storeProduct,
      storeProductAttrValue, storeProductRelation, storeProductCategory, storeBrand,
      storeProductLabel, userLabel, storeOrder, storeOrderCartInfo, storeOrderPromotions, systemLog]);
    container = createContainerFromDb(fixture.db);
    service = new AdminNthDiscountService(container);
  }, 30_000);
  afterAll(async () => { await fixture?.close(); });
  beforeEach(async () => {
    await fixture.reset();
    await fixture.db.insert(storeProductCategory).values({ id: 10, cateName: '花卉' });
    await fixture.db.insert(storeProduct).values([
      { id: 1, storeName: '玫瑰', isShow: 1, isDel: 0, isVerify: 1, cateId: '10' },
      { id: 2, storeName: '百合', isShow: 1, isDel: 0, isVerify: 1, cateId: '10' },
      { id: 3, storeName: '茉莉', isShow: 1, isDel: 0, isVerify: 1, cateId: '10' },
      { id: 4, pid: 1, storeName: '玫瑰子商品', isShow: 1, isDel: 0, isVerify: 1 },
      { id: 5, storeName: '待审核', isShow: 1, isDel: 0, isVerify: 0 },
      { id: 6, storeName: '已下架', isShow: 0, isDel: 0, isVerify: 1 },
    ]);
    await fixture.db.insert(storeProductAttrValue).values([
      { id: 11, productId: 1, type: 0, unique: 'abc11111', suk: '红色', price: '19.99' },
      { id: 12, productId: 1, type: 0, unique: 'abc22222', suk: '粉色', price: '20.00' },
      { id: 13, productId: 2, type: 0, unique: 'def11111', suk: '白色', price: '29.00' },
      { id: 14, productId: 3, type: 0, unique: 'ghi11111', suk: '黄色', price: '39.00' },
      { id: 15, productId: 4, type: 0, unique: 'kid11111', suk: '子商品规格' },
      { id: 16, productId: 5, type: 0, unique: 'bad11111', suk: '待审核规格' },
      { id: 17, productId: 6, type: 0, unique: 'off11111', suk: '下架规格' },
      { id: 18, productId: 1, type: 0, unique: 'old11111', suk: '退役规格', isRetired: 1 },
    ]);
    await fixture.db.insert(storeProductRelation).values([
      { productId: 1, type: 1, relationId: 10 },
      { productId: 1, type: 2, relationId: 11 }, { productId: 2, type: 2, relationId: 11 },
      { productId: 1, type: 3, relationId: 21 }, { productId: 3, type: 3, relationId: 21 },
    ]);
    await fixture.db.insert(storeBrand).values([
      { id: 11, brandName: '花园', isShow: 1, isDel: 0 },
      { id: 12, brandName: '停用品牌', isShow: 0, isDel: 0 },
    ]);
    await fixture.db.insert(storeProductLabel).values([
      { id: 21, labelName: '热销', type: 0, relationId: 0, status: 1, isShow: 1 },
      { id: 22, labelName: '停用商品标签', type: 0, relationId: 0, status: 0, isShow: 1 },
    ]);
    await fixture.db.insert(userLabel).values([
      { id: 31, name: '新客', type: 0, relationId: 0, status: 1 },
      { id: 32, name: '停用用户标签', type: 0, relationId: 0, status: 0 },
    ]);
    await fixture.db.insert(storePromotions).values([
      { id: 101, promotionsType: 1, type: 1, storeId: 0, pid: 0, name: '限时折扣' },
      { id: 102, promotionsType: 2, type: 2, storeId: 7, pid: 0, name: '门店第N件' },
      { id: 103, promotionsType: 2, type: 1, storeId: 0, pid: 77, name: '第N件子记录' },
      { id: 104, promotionsType: 2, type: 1, storeId: 0, pid: 0, isDel: 1, name: '已删除第N件' },
    ]);
  }, 30_000);

  it('round-trips partial SKU, labels and overlays without broadening selection', async () => {
    const created = await service.mutate('create', 0, base(), { id: 9 });
    const [saved] = await fixture.db.select().from(storePromotions).where(eq(storePromotions.id, created.id));
    expect(saved).toMatchObject({ promotionsType: 2, type: 1, storeId: 0, pid: 0,
      promotionsCate: 1, thresholdType: 2, threshold: '3.00', discountType: 2,
      nPieceNDiscount: 3, discount: '90.00', isLimit: 0, limitNum: 0,
      labelId: '31', overlay: '1,5' });
    const links = await fixture.db.select().from(storePromotionsAuxiliary)
      .where(eq(storePromotionsAuxiliary.promotionsId, created.id));
    expect(links).toMatchObject([{ productPartakeType: 2, productId: 1,
      unique: 'abc11111', isAll: 0 }]);
    const info = (await service.detail(created.id)).info;
    expect(info).toMatchObject({ product_id: [{ product_id: 1, unique: ['abc11111'] }],
      products: [{ id: 1, attrValue: [{ unique: 'abc11111' }] }], label_id: [31],
      user_labels: [{ id: 31, label_name: '新客' }], overlay: [1, 5],
      n_piece_n_discount: 3, threshold: 3, discount: 90,
      promotions: [{ promotions_type: 2, threshold_type: 2, discount_type: 2,
        n_piece_n_discount: 3, threshold: 3, discount: 90 }],
      selection_issues: [], product_count: 1, sum_order: 0 });
    expect(info.products[0].attrValue).toHaveLength(1);
    expect(info.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(await service.list(new URLSearchParams('name=%E6%98%A5%E6%97%A5&status=1&n_piece_n_discount=3&page=1&limit=1')))
      .toMatchObject({ count: 1, page: 1, limit: 1, list: [{ id: created.id, product_count: 1 }] });
    expect(await service.list(new URLSearchParams('page=2&limit=1'))).toMatchObject({ count: 1, list: [] });
    const off = { ...base(), is_label: 0, label_id: [31],
      is_overlay: 0, overlay: [1], product_partake_type: 1, product_id: [],
      revision: info.revision };
    await service.mutate('update', created.id, off, { id: 9 });
    const changed = (await service.detail(created.id)).info;
    expect(changed).toMatchObject({ label_id: [],
      overlay: [], product_id: [], product_count: 3 });
  });

  it('exposes bounded SKU, brand, product-label and user-label choices', async () => {
    expect(await service.choices('products', new URLSearchParams('page=1&limit=2')))
      .toMatchObject({ count: 3, page: 1, limit: 2,
        list: [{ id: 3, attrValue: [{ unique: 'ghi11111' }] },
          { id: 2, attrValue: [{ unique: 'def11111' }] }] });
    expect(await service.choices('products', new URLSearchParams('keyword=%E7%8E%AB%E7%91%B0')))
      .toMatchObject({ count: 1, list: [{ id: 1, cate_name: '花卉',
        attrValue: [{ unique: 'abc11111' }, { unique: 'abc22222' }] }] });
    const choice = (await service.choices('products', new URLSearchParams('keyword=%E7%8E%AB%E7%91%B0'))).list[0];
    expect(choice && 'attrValue' in choice ? choice.attrValue : null).toHaveLength(2);
    expect(await service.choices('brands', new URLSearchParams()))
      .toMatchObject({ count: 1, list: [{ id: 11, brand_name: '花园' }] });
    expect(await service.choices('labels', new URLSearchParams()))
      .toMatchObject({ count: 1, list: [{ id: 21, label_name: '热销' }] });
    expect(await service.choices('user-labels', new URLSearchParams()))
      .toMatchObject({ count: 1, list: [{ id: 31, label_name: '新客' }] });
  });

  it('does not re-enable stale all-SKU semantics after a product gains another SKU', async () => {
    const input = { ...base(), status: 0,
      product_id: [{ product_id: 1, unique: ['abc11111', 'abc22222'] }] };
    const created = await service.mutate('create', 0, input, { id: 9 });
    const before = await fixture.db.select().from(storePromotionsAuxiliary)
      .where(eq(storePromotionsAuxiliary.promotionsId, created.id));
    expect(before[0].isAll).toBe(1);
    await fixture.db.insert(storeProductAttrValue).values({ id: 19, productId: 1,
      type: 0, unique: 'abc33333', suk: '新增规格' });
    let info = (await service.detail(created.id)).info;
    await expect(service.mutate('status', created.id,
      { status: 1, revision: info.revision, request_id: requestId() }, { id: 9 }))
      .rejects.toMatchObject({ code: 400 });
    await service.mutate('update', created.id,
      { ...input, revision: info.revision, request_id: requestId() }, { id: 9 });
    const after = await fixture.db.select().from(storePromotionsAuxiliary)
      .where(eq(storePromotionsAuxiliary.promotionsId, created.id));
    expect(after[0].isAll).toBe(0);
    info = (await service.detail(created.id)).info;
    await expect(service.mutate('status', created.id,
      { status: 1, revision: info.revision, request_id: requestId() }, { id: 9 }))
      .resolves.toEqual(created);
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

  it('stores canonical presets, accepts custom zero percent and refuses malformed historical rules on enable', async () => {
    const half = await service.mutate('create', 0,
      { ...base(), n_piece_n_discount: 1, threshold: 2, discount: 50 }, { id: 9 });
    expect((await service.detail(half.id)).info).toMatchObject({ title: '第二件半价',
      n_piece_n_discount: 1, threshold: 2, discount: 50 });
    const free = await service.mutate('create', 0,
      { ...base(), n_piece_n_discount: 2, threshold: 2, discount: 0 }, { id: 9 });
    expect((await service.detail(free.id)).info).toMatchObject({ title: '买1送1',
      n_piece_n_discount: 2, threshold: 2, discount: 0 });
    const custom = await service.mutate('create', 0,
      { ...base(), n_piece_n_discount: 3, threshold: 99_999_999, discount: 0 }, { id: 9 });
    expect((await service.detail(custom.id)).info).toMatchObject({
      n_piece_n_discount: 3, threshold: 99_999_999, discount: 0 });
    await fixture.db.update(storePromotions).set({ status: 0, thresholdType: 1,
      discount: '10.00' }).where(eq(storePromotions.id, free.id));
    const historical = (await service.detail(free.id)).info;
    expect(historical.selection_issues).toContain('活动优惠规则异常，请编辑核对');
    await expect(service.mutate('status', free.id,
      { status: 1, revision: historical.revision, request_id: requestId() }, { id: 9 }))
      .rejects.toThrow('配置不完整');
    await service.mutate('update', free.id,
      { ...base(), n_piece_n_discount: 2, threshold: 2, discount: 0,
        revision: historical.revision }, { id: 9 });
    expect((await service.detail(free.id)).info.selection_issues).toEqual([]);
    await fixture.db.update(storePromotions).set({ status: 0, isLimit: 1, limitNum: 3 })
      .where(eq(storePromotions.id, free.id));
    const legacyLimit = (await service.detail(free.id)).info;
    expect(legacyLimit.selection_issues).toContain('历史限购配置对此活动无效，请编辑核对');
    await expect(service.mutate('status', free.id,
      { status: 1, revision: legacyLimit.revision, request_id: requestId() }, { id: 9 }))
      .rejects.toThrow('配置不完整');
    await service.mutate('update', free.id,
      { ...base(), n_piece_n_discount: 2, threshold: 2, discount: 0,
        revision: legacyLimit.revision }, { id: 9 });
    const [normalized] = await fixture.db.select().from(storePromotions)
      .where(eq(storePromotions.id, free.id));
    expect(normalized).toMatchObject({ isLimit: 0, limitNum: 0 });
  });

  it('supports all five scopes and blocks stale or retired materials', async () => {
    const created = await service.mutate('create', 0, base(), { id: 9 });
    let info = (await service.detail(created.id)).info;
    const change = async (scope: number, selected: Record<string, unknown>) => {
      await service.mutate('update', created.id,
        { ...base(), ...selected, product_partake_type: scope, revision: info.revision }, { id: 9 });
      info = (await service.detail(created.id)).info;
      return info;
    };
    expect((await change(3, { product_id: [{ product_id: 1, unique: ['abc11111'] }] })).product_count).toBe(3);
    expect((await change(3, { product_id: [{ product_id: 1, unique: ['abc11111', 'abc22222'] }] })).product_count).toBe(2);
    expect((await change(4, { product_id: [], brand_id: [11] })).product_count).toBe(2);
    expect((await change(5, { product_id: [], store_label_id: [21] })).product_count).toBe(2);
    expect((await change(1, { product_id: [] })).product_count).toBe(3);
    const invalid = [
      { product_id: [{ product_id: 1, unique: ['old11111'] }] },
      { product_id: [{ product_id: 4, unique: ['kid11111'] }] },
      { product_id: [{ product_id: 5, unique: ['bad11111'] }] },
      { product_id: [{ product_id: 6, unique: ['off11111'] }] },
      { product_id: [{ product_id: 1, unique: ['notfound'] }] },
      { product_id: [{ product_id: 1, unique: [] }] },
    ];
    for (const item of invalid) await expect(service.mutate('update', created.id,
      { ...base(), ...item, revision: info.revision }, { id: 9 })).rejects.toMatchObject({ code: 400 });
    for (const body of [{ ...base(), label_id: [32] }, { ...base(), product_partake_type: 4, brand_id: [12] },
      { ...base(), product_partake_type: 5, store_label_id: [22] }, { ...base(), overlay: [4] },
      { ...base(), section_time: [future(20), future(10)] }, { ...base(), promotions_type: 2 },
      { ...base(), n_piece_n_discount: 1, threshold: 3, discount: 50 },
      { ...base(), n_piece_n_discount: 2, threshold: 2, discount: 50 },
      { ...base(), n_piece_n_discount: 3, threshold: 100_000_000 },
      { ...base(), n_piece_n_discount: 3, discount: 101 },
      { ...base(), is_limit: 1 }, { ...base(), limit_num: 3 }]) {
      await expect(service.mutate('create', 0, body, { id: 9 })).rejects.toMatchObject({ code: 400 });
    }
  });

  it('aggregates paid root and child sales once per order, with snapshot fallback', async () => {
    const created = await service.mutate('create', 0, base(), { id: 9 });
    await fixture.db.insert(storePromotions).values([
      { id: 301, pid: created.id, promotionsType: 2, type: 2, storeId: 7, name: '历史派生第N件' },
      { id: 302, pid: created.id, promotionsType: 1, type: 2, storeId: 7, name: '异类型子活动' },
    ]);
    await fixture.db.insert(storeOrder).values([
      { id: 401, orderId: 'time-discount-401', unique: 'time-401', uid: 7, paid: 1, payPrice: '100.00' },
      { id: 402, orderId: 'time-discount-402', unique: 'time-402', uid: 7, paid: 1, payPrice: '50.00' },
      { id: 403, orderId: 'time-discount-403', unique: 'time-403', uid: 8, paid: 0, payPrice: '999.00' },
      { id: 404, orderId: 'time-discount-404', unique: 'time-404', uid: 8, paid: 1, payPrice: '30.00' },
    ]);
    await fixture.db.insert(storeOrderPromotions).values([
      { oid: 401, uid: 7, promotionsId: created.id, productId: 1, promotionsPrice: '10.00' },
      { oid: 401, uid: 7, promotionsId: 301, productId: 2, promotionsPrice: '2.00' },
      { oid: 401, uid: 7, promotionsId: 302, productId: 3, promotionsPrice: '90.00' },
      { oid: 402, uid: 7, promotionsId: 301, productId: 1, promotionsPrice: '5.00' },
      { oid: 403, uid: 8, promotionsId: created.id, productId: 1, promotionsPrice: '99.00' },
    ]);
    await fixture.db.insert(storeOrderCartInfo).values([
      { oid: 401, uid: 7, unique: 'cart401', promotionsId: String(created.id), cartNum: 1,
        cartInfo: JSON.stringify({ promotions_true_price: '500.00' }) },
      { oid: 404, uid: 8, unique: 'cart404', promotionsId: `301,${created.id}`, cartNum: 1,
        cartInfo: JSON.stringify({ promotions_true_price: '2.50', cart_num: 2 }) },
    ]);
    const { info } = await service.detail(created.id);
    expect(info).toMatchObject({ sum_pay_price: '180.00', sum_promotions_price: '22.00',
      sum_order: 3, sum_user: 2, old_user: 1, new_user: 1 });
    const listed = (await service.list(new URLSearchParams())).list.find(row => row.id === created.id)!;
    expect(listed.sum_promotions_price).toBe('22.00');
    await service.mutate('delete', created.id, { revision: info.revision, request_id: requestId() }, { id: 9 });
    const rows = await fixture.db.select().from(storePromotions);
    expect(rows.find(row => row.id === 301)?.isDel).toBe(1);
    expect(rows.find(row => row.id === 302)?.isDel).toBe(0);
    expect(rows.find(row => row.id === 101)?.isDel).toBe(0);
  });

  it('counts a split paid original once and attributes verified snapshot cents only to this promotion', async () => {
    const created = await service.mutate('create', 0, base(), { id: 9 });
    const allocation = { promotionId: created.id, rootId: created.id, type: 2,
      savingsCents: 50, discountQuantity: 1, labelIds: [], name: '第N件半价' };
    const evidence = { cart_num: 2, sum_price: '0.67', vip_truePrice: '0.07',
      promotions_true_price: '0.24', coupon_price: '0.05', integral_price: '0.00',
      first_order_price: '0.00', sum_true_price: '1.30',
      promotion_quote_version: 'order-promotion-quote-v1', promotion_line_price: '1.35',
      promotion_line_savings: '0.50', promotion_line_member_savings: '0.15',
      promotion_discount_quantity: 0, promotion_allocations: [allocation],
      promotion_segments: [
        { quantity: 1, rawGrossCents: 100, totalPriceCents: 50, unitPriceCents: 50,
          membershipSavingsCents: 0, promotionIds: [created.id], promotionAllocations: [allocation], couponEligibleGrossCents: 0 },
        { quantity: 1, rawGrossCents: 100, totalPriceCents: 85, unitPriceCents: 85,
          membershipSavingsCents: 15, promotionIds: [], promotionAllocations: [], couponEligibleGrossCents: 85 },
      ] };
    await fixture.db.insert(storeOrder).values([
      { id: 501, orderId: 'split-original', unique: 'split-original', uid: 7, pid: -1, paid: 1, payPrice: '1.30' },
      { id: 502, orderId: 'split-child', unique: 'split-child', uid: 7, pid: 501, paid: 1, payPrice: '1.30' },
    ]);
    await fixture.db.insert(storeOrderCartInfo).values([
      { oid: 501, uid: 7, unique: 'original-cart', cartNum: 2,
        promotionsId: String(created.id), cartInfo: JSON.stringify(evidence) },
      { oid: 502, uid: 7, unique: 'child-cart', cartNum: 2,
        promotionsId: String(created.id), cartInfo: JSON.stringify(evidence) },
    ]);
    expect((await service.detail(created.id)).info).toMatchObject({ sum_pay_price: '1.30',
      sum_promotions_price: '0.50', sum_order: 1, sum_user: 1 });
    await fixture.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify({ ...evidence,
      promotion_line_member_savings: '0.14' }) }).where(eq(storeOrderCartInfo.oid, 501));
    await expect(service.detail(created.id)).rejects.toThrow('快照');
    await fixture.db.insert(storeOrderPromotions).values({ oid: 501, uid: 7,
      promotionsId: created.id, productId: 1, promotionsPrice: '0.45' });
    expect((await service.detail(created.id)).info).toMatchObject({ sum_pay_price: '1.30',
      sum_promotions_price: '0.45', sum_order: 1 });
  });

  it('counts repeat buyers and orders in SQL across snapshot cursor batches', async () => {
    const created = await service.mutate('create', 0, base(), { id: 9 });
    await fixture.db.insert(storeOrder).values([
      { id: 601, orderId: 'batch-one', unique: 'batch-one', uid: 7, pid: -1, paid: 1, payPrice: '1.00' },
      { id: 602, orderId: 'batch-two', unique: 'batch-two', uid: 7, paid: 1, payPrice: '2.00' },
      { id: 603, orderId: 'batch-child', unique: 'batch-child', uid: 7, pid: 601, paid: 1, payPrice: '1.00' },
    ]);
    const cart = (oid: number, index: number) => ({ oid, uid: 7, unique: `batch-cart-${oid}-${index}`,
      cartNum: 1, promotionsId: String(created.id),
      cartInfo: JSON.stringify({ promotions_true_price: '0.01', cart_num: 1 }) });
    await fixture.db.insert(storeOrderCartInfo).values([
      ...Array.from({ length: 33 }, (_, index) => cart(601, index)), cart(602, 0), cart(603, 0),
    ]);
    expect((await service.detail(created.id)).info).toMatchObject({
      sum_pay_price: '3.00', sum_promotions_price: '0.34', sum_order: 2,
      sum_user: 1, old_user: 1, new_user: 0,
    });
  });

  it('keeps type=2 writes isolated and enforces UUID replay and CAS', async () => {
    expect((await service.list(new URLSearchParams())).count).toBe(0);
    for (const id of [101, 102, 103, 104]) {
      await expect(service.detail(id)).rejects.toMatchObject({ code: 404 });
      await expect(service.mutate('status', id,
        { status: 1, revision: '0'.repeat(64), request_id: requestId() }, { id: 9 }))
        .rejects.toMatchObject({ code: 404 });
    }
    const input = base(), created = await service.mutate('create', 0, input, { id: 9 });
    expect(await service.mutate('create', 0, input, { id: 9 })).toEqual(created);
    await expect(service.mutate('create', 0, { ...input, name: '修改内容' }, { id: 9 }))
      .rejects.toMatchObject({ code: 409 });
    let info = (await service.detail(created.id)).info;
    const off = { status: 0, revision: info.revision, request_id: requestId() };
    expect(await service.mutate('status', created.id, off, { id: 9 })).toEqual(created);
    expect(await service.mutate('status', created.id, off, { id: 9 })).toEqual(created);
    await expect(service.mutate('status', created.id,
      { ...off, status: 1, request_id: requestId() }, { id: 9 })).rejects.toMatchObject({ code: 409 });
    info = (await service.detail(created.id)).info;
    expect(await service.mutate('status', created.id,
      { status: 1, revision: info.revision, request_id: requestId() }, { id: 9 })).toEqual(created);
    const logs = await fixture.db.select().from(systemLog).where(eq(systemLog.type, 'nth_discount'));
    expect(logs).toHaveLength(3);
    expect(logs[0].path).toContain('/marketing/nth-discounts/request/');
  });

  it('serves all ten controller exports with private no-store responses', async () => {
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use('*', async (c, next) => {
      c.set('container', container);
      c.set('adminInfo', { id: 9, account: 'admin', realName: 'admin', level: 1, roles: '', divisionId: 0 });
      await next();
    });
    const path = '/marketing/nth-discounts';
    app.get(path, controller.list);
    app.get(`${path}/products`, controller.products);
    app.get(`${path}/brands`, controller.brands);
    app.get(`${path}/labels`, controller.labels);
    app.get(`${path}/user-labels`, controller.userLabels);
    app.get(`${path}/:id`, controller.detail);
    app.post(path, controller.create);
    app.put(`${path}/:id`, controller.update);
    app.patch(`${path}/:id/status`, controller.status);
    app.delete(`${path}/:id`, controller.remove);
    const get = async (suffix: string) => {
      const response = await app.request(`http://localhost${path}${suffix}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toContain('no-store');
      return (await response.json() as { status: number; data: any }).data;
    };
    for (const suffix of ['', '/products', '/brands', '/labels', '/user-labels']) {
      expect(await get(suffix)).toHaveProperty('list');
    }
    const write = async (method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', suffix: string, body: object) => {
      const response = await app.request(`http://localhost${path}${suffix}`, {
        method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      expect(response.headers.get('Cache-Control')).toContain('no-store');
      return (await response.json() as { data: { id: number } }).data;
    };
    const created = await write('POST', '', base());
    let info = (await get(`/${created.id}`)).info;
    await write('PUT', `/${created.id}`, { ...base(), revision: info.revision });
    info = (await get(`/${created.id}`)).info;
    await write('PATCH', `/${created.id}/status`,
      { status: 0, revision: info.revision, request_id: requestId() });
    info = (await get(`/${created.id}`)).info;
    await write('DELETE', `/${created.id}`, { revision: info.revision, request_id: requestId() });
    expect((await get('')).count).toBe(0);
  });

  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('deduplicates the same UUID across PG16 peers', async () => {
    const input = base(), path = `/marketing/nth-discounts/request/${input.request_id.toLowerCase()}`;
    await withFinancePeers(fixture.db, async ([blocker, first, second]) => {
      await blocker.exec("BEGIN; SELECT pg_advisory_xact_lock(hashtext('time_discount_catalog'),hashtext('platform_type_1'))");
      try {
        const firstWrite = outcome(new AdminNthDiscountService(createContainerFromDb(first.db))
          .mutate('create', 0, input, { id: 9 }));
        await waitForFinanceBlock(fixture.db, first.pid, blocker.pid);
        const secondWrite = outcome(new AdminNthDiscountService(createContainerFromDb(second.db))
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
