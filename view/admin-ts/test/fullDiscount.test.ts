import assert from 'node:assert/strict';
import { test } from 'node:test';
import request from '../src/utils/request.ts';
import {
  apiFullDiscountList, apiFullDiscountDetail, apiFullDiscountProducts, apiFullDiscountBrands,
  apiFullDiscountLabels, apiFullDiscountUserLabels, apiFullDiscountSave,
  apiFullDiscountStatus, apiFullDiscountDelete, normalizeFullDiscount, fullDiscountDate,
  type FullDiscountInput,
} from '../src/api/fullDiscount.ts';

const revision = 'a'.repeat(64);
const request_id = '123e4567-e89b-42d3-a456-426614174000';
const form: FullDiscountInput = {
  name: ' 满减活动 ', section_time: ['2026-10-01 00:00:00', '2026-10-10 23:59:59'],
  promotions_cate: 1, threshold_type: 1,
  promotions: [{ threshold: 100, discount_type: 1, discount: 10.01 }, { threshold: 200, discount_type: 2, discount: 90 }],
  is_label: 1, label_id: [8], is_overlay: 1, overlay: [1, 2, 5],
  product_partake_type: 2, product_id: [{ product_id: 3, unique: ['sku-a'] }],
  brand_id: [], store_label_id: [], status: 1, sort: 0,
};
const sku = { id: 31, unique: 'sku-a', suk: '红色', label: '红色', price: '100.00', stock: 5, is_retired: 0 };
const product = { id: 3, store_name: '秋装', image: '/uploads/product.png', price: '100.00', stock: 5,
  cate_name: '服饰', is_show: 1, is_del: 0, is_verify: 1, pid: 0, attrValue: [sku] };
const row = { id: 7, name: '满减活动', product_count: 1, threshold_type: 1, desc: '满100元减10.01元,满200元打9折',
  sum_pay_price: '189.99', sum_promotions_price: '10.01', sum_order: 1, sum_user: 1,
  old_user: 0, new_user: 1, status: 1, revision, start_status: '进行中' };
const detail = { ...row, start_time: form.section_time[0], stop_time: form.section_time[1],
  promotions_cate: 1, promotions: form.promotions, is_label: 1, label_id: [8], is_overlay: 1, overlay: [1, 2, 5],
  product_partake_type: 2, product_id: [{ product_id: 3, unique: ['sku-a'] }],
  brand_id: [], store_label_id: [], sort: 0, products: [product], brands: [], labels: [],
  user_labels: [{ id: 8, label_name: '会员关怀' }], selection_issues: [] };

function mockAdapter(resolve: (method: string, url: string, params: unknown) => unknown) {
  const previousAdapter = request.defaults.adapter;
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } });
  const calls: Array<{ method: string; url: string; body: unknown; params: unknown }> = [];
  request.defaults.adapter = async config => {
    const method = config.method?.toUpperCase() ?? '', url = config.url ?? '';
    calls.push({ method, url, body: config.data ? JSON.parse(String(config.data)) : null, params: config.params });
    return { config, data: { status: 200, msg: 'ok', data: resolve(method, url, config.params) }, headers: {}, status: 200, statusText: 'OK' };
  };
  return { calls, restore() { request.defaults.adapter = previousAdapter;
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage'); } };
}

test('keeps all ladder tiers, validates cents and increasing thresholds, and restricts looping to a single money reduction', () => {
  assert.equal(fullDiscountDate('2026-02-29 12:00:00'), false);
  assert.equal(fullDiscountDate('2028-02-29 12:00:00'), true);
  const normalized = normalizeFullDiscount(form);
  assert.deepEqual(normalized.promotions, form.promotions);
  assert.deepEqual(normalized.overlay, [1, 2, 5]);
  assert.throws(() => normalizeFullDiscount({ ...form, promotions: [{ ...form.promotions[0], threshold: 100.001 }] }), /两位小数/);
  assert.throws(() => normalizeFullDiscount({ ...form, promotions: [{ ...form.promotions[0] }, { ...form.promotions[1], threshold: 100 }] }), /逐级递增/);
  assert.throws(() => normalizeFullDiscount({ ...form, threshold_type: 2, promotions: [{ threshold: 2.5, discount_type: 1, discount: 10 }] }), /件数须为整数/);
  assert.throws(() => normalizeFullDiscount({ ...form, promotions_cate: 2 }), /循环规则只能有1级/);
  assert.throws(() => normalizeFullDiscount({ ...form, promotions_cate: 2, promotions: [{ threshold: 100, discount_type: 2, discount: 90 }] }), /循环优惠只能减金额/);
  assert.deepEqual(normalizeFullDiscount({ ...form, promotions_cate: 2, promotions: [{ threshold: 100, discount_type: 1, discount: 10 }] }).promotions,
    [{ threshold: 100, discount_type: 1, discount: 10 }]);
  assert.throws(() => normalizeFullDiscount({ ...form, promotions: [{ threshold: 100, discount_type: 2, discount: 90.5 }] }), /整数百分比/);
  assert.equal(normalizeFullDiscount({ ...form, promotions: [{ threshold: 100, discount_type: 2, discount: 0 }] }).promotions[0].discount, 0);
  const hundred = Array.from({ length: 100 }, (_, index) => ({ threshold: index + 1, discount_type: 1 as const, discount: 0.01 }));
  assert.equal(normalizeFullDiscount({ ...form, promotions: hundred }).promotions.length, 100);
  assert.throws(() => normalizeFullDiscount({ ...form, promotions: [...hundred, { threshold: 101, discount_type: 1, discount: 0.01 }] }), /1–100级/);
});

test('does not widen selected SKU scope or silently turn off label and overlay intent', () => {
  const hundred = Array.from({ length: 100 }, (_, index) => index + 1);
  assert.equal(normalizeFullDiscount({ ...form, label_id: hundred }).label_id.length, 100);
  assert.throws(() => normalizeFullDiscount({ ...form, label_id: [...hundred, 101] }), /用户标签最多选择100个/);
  assert.throws(() => normalizeFullDiscount({ ...form, product_id: [{ product_id: 3, unique: [] }] }), /规格/);
  assert.throws(() => normalizeFullDiscount({ ...form, product_id: [{ product_id: 3, unique: ['sku-a', 'sku-a'] }] }), /重复/);
  assert.throws(() => normalizeFullDiscount({ ...form, overlay: [1, 1] }), /叠加/);
  assert.throws(() => normalizeFullDiscount({ ...form, overlay: [3] as never }), /叠加/);
  assert.throws(() => normalizeFullDiscount({ ...form, is_label: 1, label_id: [] }), /用户标签/);
  assert.throws(() => normalizeFullDiscount({ ...form, is_overlay: 1, overlay: [] }), /叠加/);
  const brand = normalizeFullDiscount({ ...form, product_partake_type: 4, brand_id: [11], is_label: 0, is_overlay: 0 });
  assert.deepEqual(brand.product_id, []); assert.deepEqual(brand.brand_id, [11]);
  assert.deepEqual(brand.label_id, []); assert.deepEqual(brand.overlay, []);
  assert.equal(normalizeFullDiscount({ ...form, product_partake_type: 4, brand_id: [...hundred, 101] }).brand_id.length, 101);
});

test('rejects missing, retired or truncated edit identities and inconsistent switches', async () => {
  let active: typeof detail = detail;
  const mock = mockAdapter(() => ({ info: active }));
  try {
    assert.deepEqual((await apiFullDiscountDetail(7)).promotions, form.promotions);
    const hundred = Array.from({ length: 100 }, (_, index) => index + 1);
    active = { ...detail, label_id: hundred, user_labels: hundred.map(id => ({ id, label_name: `标签${id}` })) };
    assert.equal((await apiFullDiscountDetail(7)).label_id.length, 100);
    active = { ...detail, label_id: [...hundred, 101], user_labels: [...hundred, 101].map(id => ({ id, label_name: `标签${id}` })) };
    await assert.rejects(apiFullDiscountDetail(7), /用户标签最多选择100个/);
    active = { ...detail, promotions: Array.from({ length: 100 }, (_, index) => ({ threshold: index + 1, discount_type: 1, discount: 0.01 })) };
    assert.equal((await apiFullDiscountDetail(7)).promotions.length, 100);
    active = { ...detail, promotions: Array.from({ length: 101 }, (_, index) => ({ threshold: index + 1, discount_type: 1, discount: 0.01 })) };
    await assert.rejects(apiFullDiscountDetail(7), /1–100级/);
    active = { ...detail, product_id: [{ product_id: 3, unique: ['sku-b'] }] };
    await assert.rejects(apiFullDiscountDetail(7), /回显不完整/);
    active = { ...detail, products: [{ ...product, attrValue: [{ ...sku, is_retired: 1 }] }] };
    await assert.rejects(apiFullDiscountDetail(7), /已退役/);
    active = { ...detail, selection_issues: ['商品 #3 已下架'] };
    await assert.rejects(apiFullDiscountDetail(7), /禁止直接保存/);
    active = { ...detail, is_label: 0 };
    await assert.rejects(apiFullDiscountDetail(7), /回显与开关不一致/);
    active = { ...detail, user_labels: [] };
    await assert.rejects(apiFullDiscountDetail(7), /标签已失效/);
  } finally { mock.restore(); }
});

test('uses all ten independent REST operations with type3 rules, filters, UUID and revision', async () => {
  const prefix = '/marketing/full-discounts';
  const mock = mockAdapter((method, url) => url === prefix && method === 'GET'
    ? { list: [row], count: 1, page: 1, limit: 15 }
    : url === `${prefix}/7` && method === 'GET' ? { info: detail }
      : url === `${prefix}/products` ? { list: [product], count: 1, page: 1, limit: 15 }
        : url === `${prefix}/brands` ? { list: [{ id: 11, brand_name: '秋装' }], count: 1, page: 1, limit: 15 }
          : url === `${prefix}/labels` || url === `${prefix}/user-labels`
            ? { list: [{ id: 8, label_name: '会员关怀' }], count: 1, page: 1, limit: 15 }
            : { id: 7 });
  try {
    assert.equal((await apiFullDiscountList({ page: 1, limit: 15, name: '', status: 1, threshold_type: 1 })).list[0].desc, row.desc);
    assert.equal((mock.calls[0].params as { threshold_type: number }).threshold_type, 1);
    assert.equal((await apiFullDiscountDetail(7)).promotions_cate, 1);
    const query = { page: 1, limit: 15, keyword: '' };
    assert.equal((await apiFullDiscountProducts(query)).list[0].attrValue[0].unique, 'sku-a');
    assert.equal((await apiFullDiscountBrands(query)).list[0].brand_name, '秋装');
    assert.equal((await apiFullDiscountLabels(query)).list[0].label_name, '会员关怀');
    assert.equal((await apiFullDiscountUserLabels(query)).list[0].label_name, '会员关怀');
    assert.equal((await apiFullDiscountSave(0, { ...form, request_id })).id, 7);
    assert.equal((await apiFullDiscountSave(7, { ...form, request_id, revision })).id, 7);
    assert.equal((await apiFullDiscountStatus(7, { request_id, revision, status: 0 })).id, 7);
    assert.equal((await apiFullDiscountDelete(7, { request_id, revision })).id, 7);
    assert.deepEqual(mock.calls.map(({ method, url }) => `${method} ${url}`), [
      `GET ${prefix}`, `GET ${prefix}/7`, `GET ${prefix}/products`, `GET ${prefix}/brands`,
      `GET ${prefix}/labels`, `GET ${prefix}/user-labels`, `POST ${prefix}`, `PUT ${prefix}/7`,
      `PATCH ${prefix}/7/status`, `DELETE ${prefix}/7`,
    ]);
    assert.deepEqual((mock.calls[6].body as typeof form).promotions, form.promotions);
    assert.deepEqual((mock.calls[6].body as typeof form).product_id, [{ product_id: 3, unique: ['sku-a'] }]);
    assert.deepEqual((mock.calls[6].body as typeof form).overlay, [1, 2, 5]);
    assert.equal((mock.calls[6].body as { revision?: string }).revision, undefined);
    assert.equal((mock.calls[7].body as { revision: string }).revision, revision);
    assert.equal((mock.calls[8].body as { status: number }).status, 0);
  } finally { mock.restore(); }
});
