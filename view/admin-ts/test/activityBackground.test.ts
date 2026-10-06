import assert from 'node:assert/strict';
import { test } from 'node:test';
import request from '../src/utils/request.ts';
import {
  activityBackgroundDate, activityBackgroundRangeQuery, normalizeActivityBackground,
  apiActivityBackgroundList, apiActivityBackgroundDetail, apiActivityBackgroundProducts,
  apiActivityBackgroundBrands, apiActivityBackgroundLabels, apiActivityBackgroundSave,
  apiActivityBackgroundStatus, apiActivityBackgroundDelete, type ActivityBackgroundInput,
} from '../src/api/activityBackground.ts';

const base: ActivityBackgroundInput = {
  name: ' 秋季活动背景 ', image: '/api/assets/12', status: 1, product_partake_type: 1,
  product_id: [], brand_id: [], store_label_id: [], section_time: ['2026-10-01 00:00:00', '2026-10-10 23:59:59'], sort: 0,
};

test('validates Shanghai-local range and emits an unambiguous list filter', () => {
  assert.equal(activityBackgroundDate('2026-02-29 10:00:00'), false);
  assert.equal(activityBackgroundDate('2028-02-29 10:00:00'), true);
  assert.equal(activityBackgroundRangeQuery(base.section_time), '2026-10-01 00:00:00 - 2026-10-10 23:59:59');
  assert.equal(activityBackgroundRangeQuery(null), '');
  assert.throws(() => activityBackgroundRangeQuery(['2026-10-10 00:00:00', '2026-10-01 00:00:00']), /开始时间/);
  assert.throws(() => activityBackgroundRangeQuery(['2026-10-01 00:00:00']), /完整/);
});

test('normalizes all, included, excluded, brand and label scopes without stale selections', () => {
  const selected = { ...base, product_id: [3, 4], brand_id: [7], store_label_id: [9] };
  assert.deepEqual(normalizeActivityBackground(selected), { ...base, name: '秋季活动背景' });
  assert.deepEqual(normalizeActivityBackground({ ...selected, product_partake_type: 2 }).product_id, [3, 4]);
  assert.deepEqual(normalizeActivityBackground({ ...selected, product_partake_type: 3 }).product_id, [3, 4]);
  assert.deepEqual(normalizeActivityBackground({ ...selected, product_partake_type: 4 }).brand_id, [7]);
  assert.deepEqual(normalizeActivityBackground({ ...selected, product_partake_type: 5 }).store_label_id, [9]);
  assert.deepEqual(normalizeActivityBackground({ ...selected, product_partake_type: 4 }).product_id, []);
  assert.deepEqual(normalizeActivityBackground({ ...selected, product_partake_type: 5 }).brand_id, []);
});

test('refuses empty or duplicate selected range and malformed image', () => {
  assert.throws(() => normalizeActivityBackground({ ...base, product_partake_type: 2 }), /参与活动的商品/);
  assert.throws(() => normalizeActivityBackground({ ...base, product_partake_type: 3 }), /不参与的商品/);
  assert.throws(() => normalizeActivityBackground({ ...base, product_partake_type: 4 }), /品牌/);
  assert.throws(() => normalizeActivityBackground({ ...base, product_partake_type: 5 }), /标签/);
  assert.throws(() => normalizeActivityBackground({ ...base, product_partake_type: 2, product_id: [1, 1] }), /重复/);
  assert.throws(() => normalizeActivityBackground({ ...base, image: 'javascript:alert(1)' }), /活动图片/);
  assert.throws(() => normalizeActivityBackground({ ...base, image: 'http://example.com/background.png' }), /活动图片/);
  assert.equal(normalizeActivityBackground({ ...base, image: 'https://example.com/background.png' }).image, 'https://example.com/background.png');
  assert.throws(() => normalizeActivityBackground({ ...base, section_time: ['2026-02-30 00:00:00', '2026-10-10 00:00:00'] }), /有效/);
  assert.throws(() => normalizeActivityBackground({ ...base, sort: 32768 }), /排序/);
});

test('uses all nine background endpoints with isolated mutation identities and complete envelopes', async () => {
  const previousAdapter = request.defaults.adapter;
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true, value: { getItem: () => null },
  });
  const prefix = '/marketing/activity-background';
  const revision = 'a'.repeat(64);
  const request_id = '123e4567-e89b-42d3-a456-426614174000';
  const row = { id: 7, name: '秋季活动背景', image: '/uploads/background.png',
    start_time: base.section_time[0], stop_time: base.section_time[1],
    status: 1, start_status: 0, product_count: 2,
    add_time: base.section_time[0], product_partake_type: 1, revision };
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  request.defaults.adapter = async config => {
    const method = config.method?.toUpperCase() ?? '', url = config.url ?? '';
    calls.push({ method, url, body: config.data ? JSON.parse(String(config.data)) : null });
    const data = url === prefix && method === 'GET' ? { list: [row], count: 1, page: 1, limit: 15 }
      : url === `${prefix}/7` && method === 'GET' ? { info: { ...row, sort: 0,
        product_id: [], brand_id: [], store_label_id: [], products: [], brands: [], labels: [] } }
      : url === `${prefix}/products` ? { list: [{ id: 1, store_name: '玫瑰', image: '/rose.png', price: '10.00', stock: 5, cate_name: '鲜花' }], count: 1, page: 1, limit: 15 }
      : url === `${prefix}/brands` ? { list: [{ id: 2, brand_name: '花园' }], count: 1, page: 1, limit: 15 }
      : url === `${prefix}/labels` ? { list: [{ id: 3, label_name: '节日' }], count: 1, page: 1, limit: 15 }
      : { id: 7 };
    return { config, data: { status: 200, msg: 'ok', data }, headers: {}, status: 200, statusText: 'OK' };
  };
  try {
    assert.equal((await apiActivityBackgroundList({ page: 1, limit: 15 })).list[0].id, 7);
    assert.equal((await apiActivityBackgroundDetail(7)).id, 7);
    const options = { page: 1, limit: 15, keyword: '' };
    assert.equal((await apiActivityBackgroundProducts(options)).list[0].store_name, '玫瑰');
    assert.equal((await apiActivityBackgroundBrands(options)).list[0].brand_name, '花园');
    assert.equal((await apiActivityBackgroundLabels(options)).list[0].label_name, '节日');
    assert.equal((await apiActivityBackgroundSave(0, { ...base, request_id })).id, 7);
    assert.equal((await apiActivityBackgroundSave(7, { ...base, request_id, revision })).id, 7);
    assert.equal((await apiActivityBackgroundStatus(7, { request_id, revision, status: 0 })).id, 7);
    assert.equal((await apiActivityBackgroundDelete(7, { request_id, revision })).id, 7);
    assert.deepEqual(calls.map(({ method, url }) => `${method} ${url}`), [
      `GET ${prefix}`, `GET ${prefix}/7`, `GET ${prefix}/products`, `GET ${prefix}/brands`,
      `GET ${prefix}/labels`, `POST ${prefix}`, `PUT ${prefix}/7`,
      `PATCH ${prefix}/7/status`, `DELETE ${prefix}/7`,
    ]);
    assert.deepEqual(calls.slice(5).map(call => (call.body as { request_id: string }).request_id), Array(4).fill(request_id));
    assert.equal((calls[5].body as { revision?: string }).revision, undefined);
    assert.equal((calls[6].body as { revision: string }).revision, revision);
    assert.equal((calls[7].body as { status: number }).status, 0);
  } finally {
    request.defaults.adapter = previousAdapter;
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
