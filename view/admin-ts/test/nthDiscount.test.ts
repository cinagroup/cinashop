import assert from 'node:assert/strict';
import { test } from 'node:test';
import request from '../src/utils/request.ts';
import {
  apiNthDiscountList, apiNthDiscountDetail, apiNthDiscountProducts, apiNthDiscountBrands,
  apiNthDiscountLabels, apiNthDiscountUserLabels, apiNthDiscountSave,
  apiNthDiscountStatus, apiNthDiscountDelete, normalizeNthDiscount, nthDiscountDate,
  type NthDiscountInput,
} from '../src/api/nthDiscount.ts';

const revision = 'a'.repeat(64);
const request_id = '123e4567-e89b-42d3-a456-426614174000';
const form: NthDiscountInput = {
  name: ' 第二件半价 ', section_time: ['2026-10-01 00:00:00', '2026-10-10 23:59:59'],
  n_piece_n_discount: 1, threshold: 2, discount: 50,
  is_label: 1, label_id: [8], is_overlay: 1, overlay: [1, 3, 5],
  product_partake_type: 2, product_id: [{ product_id: 3, unique: ['sku-a'] }],
  brand_id: [], store_label_id: [], status: 1, sort: 0,
};
const sku = { id: 31, unique: 'sku-a', suk: '红色', price: '100.00', stock: 5, is_retired: 0 };
const product = { id: 3, store_name: '秋装', image: '/uploads/product.png', price: '100.00', stock: 5,
  cate_name: '服饰', is_show: 1, is_del: 0, is_verify: 1, pid: 0, attrValue: [sku] };
const row = { id: 7, name: '第二件半价', product_count: 1, sum_pay_price: '150.00',
  sum_promotions_price: '50.00', sum_order: 1, sum_user: 1, old_user: 0,
  new_user: 1, status: 1, revision, n_piece_n_discount: 1, threshold: 2, discount: 50 };
const rule = { id: 71, pid: 0, promotions_type: 2, promotions_cate: 1, threshold_type: 2,
  threshold: 2, discount_type: 2, n_piece_n_discount: 1, discount: 50 };
const detail = { ...row, section_time: form.section_time, start_time: form.section_time[0], stop_time: form.section_time[1],
  is_label: 1, label_id: [8], is_overlay: 1, overlay: [1, 3, 5], product_partake_type: 2,
  product_id: [{ product_id: 3, unique: ['sku-a'] }], brand_id: [], store_label_id: [], sort: 0,
  products: [product], brands: [], labels: [], user_labels: [{ id: 8, label_name: '会员关怀' }], selection_issues: [], promotions: [rule] };

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

test('keeps Shanghai seconds, fixed presets, and one non-cycling custom rule', () => {
  assert.equal(nthDiscountDate('2026-02-29 12:00:00'), false);
  assert.equal(nthDiscountDate('2028-02-29 12:00:00'), true);
  const normalized = normalizeNthDiscount(form);
  assert.deepEqual([normalized.n_piece_n_discount, normalized.threshold, normalized.discount], [1, 2, 50]);
  assert.deepEqual(normalized.product_id, [{ product_id: 3, unique: ['sku-a'] }]);
  assert.throws(() => normalizeNthDiscount({ ...form, discount: 60 }), /预设/);
  assert.deepEqual([normalizeNthDiscount({ ...form, n_piece_n_discount: 2, discount: 0 }).threshold,
    normalizeNthDiscount({ ...form, n_piece_n_discount: 2, discount: 0 }).discount], [2, 0]);
  assert.equal(normalizeNthDiscount({ ...form, n_piece_n_discount: 3, threshold: 3, discount: 0 }).discount, 0);
  assert.throws(() => normalizeNthDiscount({ ...form, n_piece_n_discount: 3, threshold: 0 }), /件数/);
  assert.throws(() => normalizeNthDiscount({ ...form, n_piece_n_discount: 3, threshold: 2, discount: 90.5 }), /整数百分比/);
  assert.throws(() => normalizeNthDiscount({ ...form, section_time: ['2026-10-10 00:00:00', '2026-10-01 00:00:00'] }), /开始时间/);
});

test('never expands partial SKU selection and drops only inactive scope arrays', () => {
  const hundred = Array.from({ length: 100 }, (_, index) => index + 1);
  assert.equal(normalizeNthDiscount({ ...form, label_id: hundred }).label_id.length, 100);
  assert.throws(() => normalizeNthDiscount({ ...form, label_id: [...hundred, 101] }), /用户标签最多选择100个/);
  assert.throws(() => normalizeNthDiscount({ ...form, product_id: [{ product_id: 3, unique: [] }] }), /规格/);
  assert.throws(() => normalizeNthDiscount({ ...form, product_id: [{ product_id: 3, unique: ['sku-a', 'sku-a'] }] }), /重复/);
  assert.throws(() => normalizeNthDiscount({ ...form, overlay: [3, 3] }), /叠加/);
  assert.throws(() => normalizeNthDiscount({ ...form, overlay: [2 as 1] }), /叠加/);
  assert.deepEqual(normalizeNthDiscount({ ...form, product_partake_type: 4, brand_id: [11] }).product_id, []);
  assert.deepEqual(normalizeNthDiscount({ ...form, product_partake_type: 4, brand_id: [11] }).brand_id, [11]);
  assert.equal(normalizeNthDiscount({ ...form, product_partake_type: 4, brand_id: [...hundred, 101] }).brand_id.length, 101);
  assert.deepEqual(normalizeNthDiscount({ ...form, product_partake_type: 5, store_label_id: [12] }).store_label_id, [12]);
  assert.throws(() => normalizeNthDiscount({ ...form, is_label: 0 }), /关闭的标签/);
});

test('blocks missing, retired, or unidentifiable selected SKU detail', async () => {
  let active: typeof detail = detail;
  const mock = mockAdapter(() => ({ info: active }));
  try {
    assert.deepEqual((await apiNthDiscountDetail(7)).product_id, [{ product_id: 3, unique: ['sku-a'] }]);
    const hundred = Array.from({ length: 100 }, (_, index) => index + 1);
    active = { ...detail, label_id: hundred, user_labels: hundred.map(id => ({ id, label_name: `标签${id}` })) };
    assert.equal((await apiNthDiscountDetail(7)).label_id.length, 100);
    active = { ...detail, label_id: [...hundred, 101], user_labels: [...hundred, 101].map(id => ({ id, label_name: `标签${id}` })) };
    await assert.rejects(apiNthDiscountDetail(7), /用户标签最多选择100个/);
    active = { ...detail, product_id: [{ product_id: 3, unique: ['sku-b'] }] };
    await assert.rejects(apiNthDiscountDetail(7), /回显不完整/);
    active = { ...detail, products: [{ ...product, attrValue: [{ ...sku, is_retired: 1 }] }] };
    await assert.rejects(apiNthDiscountDetail(7), /已退役/);
    active = { ...detail, selection_issues: ['商品 #3 已下架'] };
    await assert.rejects(apiNthDiscountDetail(7), /禁止直接保存/);
    active = { ...detail, user_labels: [] };
    await assert.rejects(apiNthDiscountDetail(7), /标签已失效/);
    active = { ...detail, promotions: [{ ...rule, discount_type: 1 }] };
    await assert.rejects(apiNthDiscountDetail(7), /规则身份与详情不一致/);
  } finally { mock.restore(); }
});

test('uses all ten REST operations with revision and one exact SKU identity', async () => {
  const prefix = '/marketing/nth-discounts';
  const mock = mockAdapter((method, url) => url === prefix && method === 'GET'
    ? { list: [row], count: 1, page: 1, limit: 15 }
    : url === `${prefix}/7` && method === 'GET' ? { info: detail }
      : url === `${prefix}/products` ? { list: [product], count: 1, page: 1, limit: 15 }
        : url === `${prefix}/brands` ? { list: [{ id: 11, brand_name: '秋装' }], count: 1, page: 1, limit: 15 }
          : url === `${prefix}/labels` || url === `${prefix}/user-labels`
            ? { list: [{ id: 8, label_name: '会员关怀' }], count: 1, page: 1, limit: 15 }
            : { id: 7 });
  try {
    assert.equal((await apiNthDiscountList({ page: 1, limit: 15, name: '', status: 1, n_piece_n_discount: 1 })).list[0].sum_pay_price, '150.00');
    assert.equal((await apiNthDiscountDetail(7)).discount, 50);
    const query = { page: 1, limit: 15, keyword: '' };
    assert.equal((await apiNthDiscountProducts(query)).list[0].attrValue[0].unique, 'sku-a');
    assert.equal((await apiNthDiscountBrands(query)).list[0].brand_name, '秋装');
    assert.equal((await apiNthDiscountLabels(query)).list[0].label_name, '会员关怀');
    assert.equal((await apiNthDiscountUserLabels(query)).list[0].label_name, '会员关怀');
    assert.equal((await apiNthDiscountSave(0, { ...form, request_id })).id, 7);
    assert.equal((await apiNthDiscountSave(7, { ...form, request_id, revision })).id, 7);
    assert.equal((await apiNthDiscountStatus(7, { request_id, revision, status: 0 })).id, 7);
    assert.equal((await apiNthDiscountDelete(7, { request_id, revision })).id, 7);
    assert.deepEqual(mock.calls.map(({ method, url }) => `${method} ${url}`), [
      `GET ${prefix}`, `GET ${prefix}/7`, `GET ${prefix}/products`, `GET ${prefix}/brands`,
      `GET ${prefix}/labels`, `GET ${prefix}/user-labels`, `POST ${prefix}`, `PUT ${prefix}/7`,
      `PATCH ${prefix}/7/status`, `DELETE ${prefix}/7`,
    ]);
    assert.deepEqual((mock.calls[6].body as typeof form).product_id, [{ product_id: 3, unique: ['sku-a'] }]);
    assert.equal((mock.calls[6].body as typeof form).n_piece_n_discount, 1);
    assert.equal((mock.calls[6].body as typeof form).threshold, 2);
    assert.equal((mock.calls[6].body as { promotions?: unknown }).promotions, undefined);
    assert.equal((mock.calls[6].body as { revision?: string }).revision, undefined);
    assert.equal((mock.calls[7].body as { revision: string }).revision, revision);
    assert.equal((mock.calls[8].body as { status: number }).status, 0);
  } finally { mock.restore(); }
});
