import assert from 'node:assert/strict';
import { test } from 'node:test';
import request from '../src/utils/request.ts';
import {
  apiFullGiftList, apiFullGiftDetail, apiFullGiftProducts, apiFullGiftBrands,
  apiFullGiftLabels, apiFullGiftUserLabels, apiFullGiftCoupons, apiFullGiftSave,
  apiFullGiftStatus, apiFullGiftDelete, normalizeFullGift, fullGiftDate, fullGiftAvailablePool,
  type FullGiftInput,
} from '../src/api/fullGift.ts';

const revision = 'a'.repeat(64), request_id = '123e4567-e89b-42d3-a456-426614174000';
const firstRule = { threshold: 100, give_integral: 20,
  give_coupon_id: [{ give_coupon_id: 21, give_coupon_num: 10 }],
  give_product_id: [{ give_product_id: 4, unique: 'gift-a', give_product_num: 5 }] };
const secondRule = { threshold: 200, give_integral: 30, give_coupon_id: [], give_product_id: [] };
const form: FullGiftInput = { name: ' 秋季满送 ', section_time: ['2026-10-01 00:00:00', '2026-10-10 23:59:59'],
  promotions_cate: 1, threshold_type: 1, promotions: [firstRule, secondRule], is_label: 1, label_id: [8],
  product_partake_type: 2, product_id: [{ product_id: 3, unique: ['sku-a'] }],
  brand_id: [], store_label_id: [], status: 1, sort: 0 };
const sku = { id: 31, unique: 'sku-a', suk: '红色', price: '100.00', stock: 5, is_retired: 0 };
const product = { id: 3, store_name: '秋装', image: '/uploads/product.png', price: '100.00', stock: 5,
  cate_name: '服饰', is_show: 1, is_del: 0, is_verify: 1, pid: 0, gift_eligible: 1, attrValue: [sku] };
const coupon = { id: 21, coupon_title: '满送券', coupon_type: 1, type: 0, coupon_price: '10.00',
  use_min_price: '100.00', remain_count: 100, is_permanent: 1, receive_type: 1, status: 1, is_del: 0 };
const giftProduct = { id: 91, product_id: 4, unique: 'gift-a', limit_num: 5, surplus_num: 5,
  store_name: '赠品杯', image: '/uploads/gift.png', stock: 20,
  sku: { id: 41, unique: 'gift-a', suk: '蓝色', stock: 20, is_retired: 0 } };
const row = { id: 7, name: '秋季满送', product_count: 1, threshold_type: 1, promotions_cate: 1,
  desc: '满100元送积分,满100元送优惠券,满100元送赠品', sum_pay_price: '200.00',
  sum_order: 1, sum_user: 1, old_user: 0, new_user: 1, status: 1, revision };
const detail = { ...row, start_time: form.section_time[0], stop_time: form.section_time[1],
  promotions: [{ id: 7, pid: 0, ...firstRule, giveCoupon: [{ ...coupon, id: 81, coupon_id: 21, limit_num: 10, surplus_num: 10 }],
    giveProducts: [giftProduct] },
  { id: 8, pid: 7, ...secondRule, giveCoupon: [], giveProducts: [] }],
  is_label: 1, label_id: [8], product_partake_type: 2, product_id: [{ product_id: 3, unique: ['sku-a'] }],
  brand_id: [], store_label_id: [], sort: 0, products: [product], brands: [], labels: [],
  user_labels: [{ id: 8, label_name: '会员关怀' }], selection_issues: [] };

function mockAdapter(resolve: (method: string, url: string) => unknown) {
  const previousAdapter = request.defaults.adapter;
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } });
  const calls: Array<{ method: string; url: string; body: unknown; params: unknown }> = [];
  request.defaults.adapter = async config => {
    const method = config.method?.toUpperCase() ?? '', url = config.url ?? '';
    calls.push({ method, url, body: config.data ? JSON.parse(String(config.data)) : null, params: config.params });
    return { config, data: { status: 200, msg: 'ok', data: resolve(method, url) }, headers: {}, status: 200, statusText: 'OK' };
  };
  return { calls, restore() { request.defaults.adapter = previousAdapter;
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage'); } };
}

test('normalizes real gift tiers, keeps cents and pool identities, and forbids empty gifts', () => {
  assert.equal(fullGiftDate('2026-02-29 12:00:00'), false);
  assert.equal(fullGiftDate('2028-02-29 12:00:00'), true);
  assert.deepEqual(normalizeFullGift(form).promotions, form.promotions);
  assert.throws(() => normalizeFullGift({ ...form, promotions: [{ ...firstRule, threshold: 100.001 }] }), /两位小数/);
  assert.throws(() => normalizeFullGift({ ...form, promotions: [firstRule, { ...secondRule, threshold: 100 }] }), /递增/);
  assert.throws(() => normalizeFullGift({ ...form, threshold_type: 2, promotions: [{ ...firstRule, threshold: 2.5 }] }), /件数须为整数/);
  assert.throws(() => normalizeFullGift({ ...form, promotions_cate: 2 }), /循环规则只能有1级/);
  assert.equal(normalizeFullGift({ ...form, promotions_cate: 2, promotions: [firstRule] }).promotions.length, 1);
  assert.throws(() => normalizeFullGift({ ...form, promotions: [{ ...firstRule, give_integral: 0, give_coupon_id: [], give_product_id: [] }] }), /至少配置/);
  assert.throws(() => normalizeFullGift({ ...form, promotions: [{ ...firstRule, give_coupon_id: [{ give_coupon_id: 21, give_coupon_num: 0 }] }] }), /活动池数量/);
  assert.equal(normalizeFullGift({ ...form, promotions: [{ ...firstRule, give_product_id: [{ give_product_id: 4, unique: 'gift-a', give_product_num: 99_999_999 }] }] }).promotions[0].give_product_id[0].give_product_num, 99_999_999);
  assert.throws(() => normalizeFullGift({ ...form, promotions: [{ ...firstRule, give_product_id: [{ give_product_id: 4, unique: 'gift-a', give_product_num: 100_000_000 }] }] }), /活动池数量/);
  assert.throws(() => normalizeFullGift({ ...form, promotions: [{ ...firstRule, give_product_id: [firstRule.give_product_id[0], firstRule.give_product_id[0]] }] }), /重复/);
  const hundred = Array.from({ length: 100 }, (_, index) => ({ threshold: index + 1, give_integral: 1, give_coupon_id: [], give_product_id: [] }));
  assert.equal(normalizeFullGift({ ...form, promotions: hundred }).promotions.length, 100);
  assert.throws(() => normalizeFullGift({ ...form, promotions: [...hundred, { threshold: 101, give_integral: 1, give_coupon_id: [], give_product_id: [] }] }), /1–100级/);
});

test('preserves specific participating SKUs and caps only post-pay labels at 100', () => {
  const hundred = Array.from({ length: 100 }, (_, index) => index + 1);
  assert.equal(normalizeFullGift({ ...form, label_id: hundred }).label_id.length, 100);
  assert.throws(() => normalizeFullGift({ ...form, label_id: [...hundred, 101] }), /用户标签最多选择100个/);
  assert.throws(() => normalizeFullGift({ ...form, product_id: [{ product_id: 3, unique: [] }] }), /规格/);
  assert.throws(() => normalizeFullGift({ ...form, product_id: [{ product_id: 3, unique: ['sku-a', 'sku-a'] }] }), /重复/);
  assert.throws(() => normalizeFullGift({ ...form, is_label: 0 }), /关闭用户标签/);
  assert.deepEqual(normalizeFullGift({ ...form, product_partake_type: 4, brand_id: [11] }).product_id, []);
  assert.equal(normalizeFullGift({ ...form, product_partake_type: 4, brand_id: [...hundred, 101] }).brand_id.length, 101);
});

test('editing a consumed gift pool compares only newly available quantity with live stock', () => {
  assert.equal(fullGiftAvailablePool(10, 10, 2), 2);
  assert.equal(fullGiftAvailablePool(11, 10, 2), 3);
  assert.equal(fullGiftAvailablePool(8, 10, 2), 0);
  assert.throws(() => fullGiftAvailablePool(7, 10, 2), /已经赠出/);
  assert.equal(fullGiftAvailablePool(2), 2);
  assert.throws(() => fullGiftAvailablePool(0), /活动池数量/);
});

test('requires complete tier, voucher and gift SKU identities on edit', async () => {
  let active: typeof detail = detail;
  const mock = mockAdapter(() => ({ info: active }));
  try {
    const loaded = await apiFullGiftDetail(7);
    assert.deepEqual(loaded.promotions.map(rule => rule.id), [7, 8]);
    assert.equal(loaded.promotions[0].giveProducts[0].sku.unique, 'gift-a');
    active = { ...detail, promotions: [{ ...detail.promotions[0], giveCoupon: [] }, detail.promotions[1]] };
    await assert.rejects(apiFullGiftDetail(7), /赠券或赠品回显/);
    active = { ...detail, promotions: [{ ...detail.promotions[0], giveProducts: [{ ...giftProduct, sku: { ...giftProduct.sku, is_retired: 1 } }] }, detail.promotions[1]] };
    await assert.rejects(apiFullGiftDetail(7), /赠品规格/);
    active = { ...detail, promotions: [{ ...detail.promotions[0], id: 99 }, detail.promotions[1]] };
    await assert.rejects(apiFullGiftDetail(7), /层级身份/);
    active = { ...detail, selection_issues: ['赠品规格已缺失'] };
    await assert.rejects(apiFullGiftDetail(7), /禁止直接保存/);
    active = { ...detail, product_id: [{ product_id: 3, unique: ['sku-b'] }] };
    await assert.rejects(apiFullGiftDetail(7), /回显不完整/);
  } finally { mock.restore(); }
});

test('uses all 11 REST operations, preserves existing tier IDs, and sends no legacy overlay', async () => {
  const prefix = '/marketing/full-gifts';
  const mock = mockAdapter((method, url) => url === prefix && method === 'GET'
    ? { list: [row], count: 1, page: 1, limit: 15 }
    : url === `${prefix}/7` && method === 'GET' ? { info: detail }
      : url === `${prefix}/products` ? { list: [product], count: 1, page: 1, limit: 15 }
        : url === `${prefix}/coupons` ? { list: [coupon], count: 1, page: 1, limit: 15 }
          : url === `${prefix}/brands` ? { list: [{ id: 11, brand_name: '秋装' }], count: 1, page: 1, limit: 15 }
            : url === `${prefix}/labels` || url === `${prefix}/user-labels`
              ? { list: [{ id: 8, label_name: '会员关怀' }], count: 1, page: 1, limit: 15 }
              : { id: 7 });
  try {
    assert.equal((await apiFullGiftList({ page: 1, limit: 15, threshold_type: 1 })).list[0].desc, row.desc);
    assert.equal((await apiFullGiftDetail(7)).promotions_cate, 1);
    const query = { page: 1, limit: 15, keyword: '' };
    const productOptions = await apiFullGiftProducts(query);
    assert.equal(productOptions.list[0].attrValue[0].unique, 'sku-a');
    assert.equal(productOptions.list[0].gift_eligible, 1);
    assert.equal((await apiFullGiftCoupons(query)).list[0].coupon_title, '满送券');
    assert.equal((await apiFullGiftBrands(query)).list[0].brand_name, '秋装');
    assert.equal((await apiFullGiftLabels(query)).list[0].label_name, '会员关怀');
    assert.equal((await apiFullGiftUserLabels(query)).list[0].label_name, '会员关怀');
    assert.equal((await apiFullGiftSave(0, { ...form, request_id })).id, 7);
    const update = { ...form, promotions: [{ id: 7, ...firstRule }, { id: 8, ...secondRule }] };
    assert.equal((await apiFullGiftSave(7, { ...update, request_id, revision })).id, 7);
    assert.equal((await apiFullGiftStatus(7, { request_id, revision, status: 0 })).id, 7);
    assert.equal((await apiFullGiftDelete(7, { request_id, revision })).id, 7);
    assert.deepEqual(mock.calls.map(({ method, url }) => `${method} ${url}`), [
      `GET ${prefix}`, `GET ${prefix}/7`, `GET ${prefix}/products`, `GET ${prefix}/coupons`,
      `GET ${prefix}/brands`, `GET ${prefix}/labels`, `GET ${prefix}/user-labels`, `POST ${prefix}`,
      `PUT ${prefix}/7`, `PATCH ${prefix}/7/status`, `DELETE ${prefix}/7`,
    ]);
    assert.deepEqual((mock.calls[7].body as typeof form).promotions, form.promotions);
    assert.deepEqual((mock.calls[8].body as typeof update).promotions.map(rule => rule.id), [7, 8]);
    assert.equal('is_overlay' in (mock.calls[8].body as object), false);
    assert.equal('overlay' in (mock.calls[8].body as object), false);
    assert.equal((mock.calls[8].body as { revision: string }).revision, revision);
    assert.equal((mock.calls[9].body as { status: number }).status, 0);
  } finally { mock.restore(); }
});
