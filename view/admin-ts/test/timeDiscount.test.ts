import assert from 'node:assert/strict';
import { test } from 'node:test';
import request from '../src/utils/request.ts';
import {
  apiTimeDiscountList, apiTimeDiscountDetail, apiTimeDiscountProducts, apiTimeDiscountBrands,
  apiTimeDiscountLabels, apiTimeDiscountUserLabels, apiTimeDiscountSave,
  apiTimeDiscountStatus, apiTimeDiscountDelete, normalizeTimeDiscount, timeDiscountDate,
  type TimeDiscountInput,
} from '../src/api/timeDiscount.ts';

const revision = 'a'.repeat(64);
const request_id = '123e4567-e89b-42d3-a456-426614174000';
const form: TimeDiscountInput = {
  name: ' 秋季九折 ', section_time: ['2026-10-01 00:00:00', '2026-10-10 23:59:59'],
  discount: 90, is_limit: 1, limit_num: 2, label_id: [8], overlay: [2, 3, 5],
  product_partake_type: 2, product_id: [{ product_id: 3, unique: ['sku-a'] }],
  brand_id: [], store_label_id: [], status: 1, sort: 0,
};
const sku = { id: 31, unique: 'sku-a', suk: '红色', price: '100.00', stock: 5, is_retired: 0 };
const product = { id: 3, store_name: '秋装', image: '/uploads/product.png', price: '100.00', stock: 5,
  cate_name: '服饰', is_show: 1, is_del: 0, is_verify: 1, pid: 0, attrValue: [sku] };
const row = { id: 7, name: '秋季九折', product_count: 1, sum_pay_price: '90.00',
  sum_promotions_price: '10.00', sum_order: 1, sum_user: 1, old_user: 0,
  new_user: 1, status: 1, revision };
const detail = { ...row, start_time: form.section_time[0], stop_time: form.section_time[1], discount: 90,
  is_limit: 1, limit_num: 2, label_id: [8], overlay: [2, 3, 5], product_partake_type: 2,
  product_id: [{ product_id: 3, unique: ['sku-a'] }], brand_id: [], store_label_id: [], sort: 0,
  products: [product], brands: [], labels: [], user_labels: [{ id: 8, label_name: '会员关怀' }], selection_issues: [] };

function mockAdapter(resolve: (method: string, url: string) => unknown) {
  const previousAdapter = request.defaults.adapter;
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } });
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  request.defaults.adapter = async config => {
    const method = config.method?.toUpperCase() ?? '', url = config.url ?? '';
    calls.push({ method, url, body: config.data ? JSON.parse(String(config.data)) : null });
    return { config, data: { status: 200, msg: 'ok', data: resolve(method, url) }, headers: {}, status: 200, statusText: 'OK' };
  };
  return { calls, restore() { request.defaults.adapter = previousAdapter;
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage'); } };
}

test('uses Shanghai seconds and keeps 90% as a nine-tenths price ratio', () => {
  assert.equal(timeDiscountDate('2026-02-29 12:00:00'), false);
  assert.equal(timeDiscountDate('2028-02-29 12:00:00'), true);
  const normalized = normalizeTimeDiscount(form);
  assert.equal(normalized.discount, 90);
  assert.deepEqual(normalized.product_id, [{ product_id: 3, unique: ['sku-a'] }]);
  assert.equal((100 * normalized.discount / 100).toFixed(2), '90.00');
  assert.throws(() => normalizeTimeDiscount({ ...form, discount: 90.5 }), /整数百分比/);
  assert.throws(() => normalizeTimeDiscount({ ...form, section_time: ['2026-10-10 00:00:00', '2026-10-01 00:00:00'] }), /开始时间/);
});

test('never expands partial SKU selection and drops only inactive scope arrays', () => {
  const hundred = Array.from({ length: 100 }, (_, index) => index + 1);
  assert.equal(normalizeTimeDiscount({ ...form, label_id: hundred }).label_id.length, 100);
  assert.throws(() => normalizeTimeDiscount({ ...form, label_id: [...hundred, 101] }), /用户标签最多选择100个/);
  assert.throws(() => normalizeTimeDiscount({ ...form, product_id: [{ product_id: 3, unique: [] }] }), /规格/);
  assert.throws(() => normalizeTimeDiscount({ ...form, product_id: [{ product_id: 3, unique: ['sku-a', 'sku-a'] }] }), /重复/);
  assert.throws(() => normalizeTimeDiscount({ ...form, overlay: [2, 2] }), /叠加/);
  assert.deepEqual(normalizeTimeDiscount({ ...form, product_partake_type: 4, brand_id: [11] }).product_id, []);
  assert.deepEqual(normalizeTimeDiscount({ ...form, product_partake_type: 4, brand_id: [11] }).brand_id, [11]);
  assert.equal(normalizeTimeDiscount({ ...form, product_partake_type: 4, brand_id: [...hundred, 101] }).brand_id.length, 101);
  assert.deepEqual(normalizeTimeDiscount({ ...form, product_partake_type: 5, store_label_id: [12] }).store_label_id, [12]);
  assert.deepEqual(normalizeTimeDiscount({ ...form, is_limit: 0, limit_num: 22 }).limit_num, 0);
});

test('blocks missing, retired, or unidentifiable selected SKU detail', async () => {
  let active: typeof detail = detail;
  const mock = mockAdapter(() => ({ info: active }));
  try {
    assert.deepEqual((await apiTimeDiscountDetail(7)).product_id, [{ product_id: 3, unique: ['sku-a'] }]);
    const hundred = Array.from({ length: 100 }, (_, index) => index + 1);
    active = { ...detail, label_id: hundred, user_labels: hundred.map(id => ({ id, label_name: `标签${id}` })) };
    assert.equal((await apiTimeDiscountDetail(7)).label_id.length, 100);
    active = { ...detail, label_id: [...hundred, 101], user_labels: [...hundred, 101].map(id => ({ id, label_name: `标签${id}` })) };
    await assert.rejects(apiTimeDiscountDetail(7), /用户标签最多选择100个/);
    active = { ...detail, product_id: [{ product_id: 3, unique: ['sku-b'] }] };
    await assert.rejects(apiTimeDiscountDetail(7), /回显不完整/);
    active = { ...detail, products: [{ ...product, attrValue: [{ ...sku, is_retired: 1 }] }] };
    await assert.rejects(apiTimeDiscountDetail(7), /已退役/);
    active = { ...detail, selection_issues: ['商品 #3 已下架'] };
    await assert.rejects(apiTimeDiscountDetail(7), /禁止直接保存/);
    active = { ...detail, user_labels: [] };
    await assert.rejects(apiTimeDiscountDetail(7), /标签已失效/);
  } finally { mock.restore(); }
});

test('uses all ten REST operations with revision and one exact SKU identity', async () => {
  const prefix = '/marketing/time-discounts';
  const mock = mockAdapter((method, url) => url === prefix && method === 'GET'
    ? { list: [row], count: 1, page: 1, limit: 15 }
    : url === `${prefix}/7` && method === 'GET' ? { info: detail }
      : url === `${prefix}/products` ? { list: [product], count: 1, page: 1, limit: 15 }
        : url === `${prefix}/brands` ? { list: [{ id: 11, brand_name: '秋装' }], count: 1, page: 1, limit: 15 }
          : url === `${prefix}/labels` || url === `${prefix}/user-labels`
            ? { list: [{ id: 8, label_name: '会员关怀' }], count: 1, page: 1, limit: 15 }
            : { id: 7 });
  try {
    assert.equal((await apiTimeDiscountList({ page: 1, limit: 15, name: '', status: 1 })).list[0].sum_pay_price, '90.00');
    assert.equal((await apiTimeDiscountDetail(7)).discount, 90);
    const query = { page: 1, limit: 15, keyword: '' };
    assert.equal((await apiTimeDiscountProducts(query)).list[0].attrValue[0].unique, 'sku-a');
    assert.equal((await apiTimeDiscountBrands(query)).list[0].brand_name, '秋装');
    assert.equal((await apiTimeDiscountLabels(query)).list[0].label_name, '会员关怀');
    assert.equal((await apiTimeDiscountUserLabels(query)).list[0].label_name, '会员关怀');
    assert.equal((await apiTimeDiscountSave(0, { ...form, request_id })).id, 7);
    assert.equal((await apiTimeDiscountSave(7, { ...form, request_id, revision })).id, 7);
    assert.equal((await apiTimeDiscountStatus(7, { request_id, revision, status: 0 })).id, 7);
    assert.equal((await apiTimeDiscountDelete(7, { request_id, revision })).id, 7);
    assert.deepEqual(mock.calls.map(({ method, url }) => `${method} ${url}`), [
      `GET ${prefix}`, `GET ${prefix}/7`, `GET ${prefix}/products`, `GET ${prefix}/brands`,
      `GET ${prefix}/labels`, `GET ${prefix}/user-labels`, `POST ${prefix}`, `PUT ${prefix}/7`,
      `PATCH ${prefix}/7/status`, `DELETE ${prefix}/7`,
    ]);
    assert.deepEqual((mock.calls[6].body as typeof form).product_id, [{ product_id: 3, unique: ['sku-a'] }]);
    assert.equal((mock.calls[6].body as { revision?: string }).revision, undefined);
    assert.equal((mock.calls[7].body as { revision: string }).revision, revision);
    assert.equal((mock.calls[8].body as { status: number }).status, 0);
  } finally { mock.restore(); }
});
