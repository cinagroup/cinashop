import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activityFrameDate, activityFrameRangeQuery, normalizeActivityFrame, type ActivityFrameInput } from '../src/api/activityFrame.ts';

const base: ActivityFrameInput = {
  name: ' 秋季活动边框 ', image: '/api/assets/12', status: 1, product_partake_type: 1,
  product_id: [], brand_id: [], store_label_id: [], section_time: ['2026-10-01 00:00:00', '2026-10-10 23:59:59'], sort: 0,
};

test('validates Shanghai-local range and emits an unambiguous list filter', () => {
  assert.equal(activityFrameDate('2026-02-29 10:00:00'), false);
  assert.equal(activityFrameDate('2028-02-29 10:00:00'), true);
  assert.equal(activityFrameRangeQuery(base.section_time), '2026-10-01 00:00:00 - 2026-10-10 23:59:59');
  assert.equal(activityFrameRangeQuery(null), '');
  assert.throws(() => activityFrameRangeQuery(['2026-10-10 00:00:00', '2026-10-01 00:00:00']), /开始时间/);
  assert.throws(() => activityFrameRangeQuery(['2026-10-01 00:00:00']), /完整/);
});

test('normalizes all, included, excluded, brand and label scopes without stale selections', () => {
  const selected = { ...base, product_id: [3, 4], brand_id: [7], store_label_id: [9] };
  assert.deepEqual(normalizeActivityFrame(selected), { ...base, name: '秋季活动边框' });
  assert.deepEqual(normalizeActivityFrame({ ...selected, product_partake_type: 2 }).product_id, [3, 4]);
  assert.deepEqual(normalizeActivityFrame({ ...selected, product_partake_type: 3 }).product_id, [3, 4]);
  assert.deepEqual(normalizeActivityFrame({ ...selected, product_partake_type: 4 }).brand_id, [7]);
  assert.deepEqual(normalizeActivityFrame({ ...selected, product_partake_type: 5 }).store_label_id, [9]);
  assert.deepEqual(normalizeActivityFrame({ ...selected, product_partake_type: 4 }).product_id, []);
  assert.deepEqual(normalizeActivityFrame({ ...selected, product_partake_type: 5 }).brand_id, []);
});

test('refuses empty or duplicate selected range and malformed image', () => {
  assert.throws(() => normalizeActivityFrame({ ...base, product_partake_type: 2 }), /参与活动的商品/);
  assert.throws(() => normalizeActivityFrame({ ...base, product_partake_type: 3 }), /不参与的商品/);
  assert.throws(() => normalizeActivityFrame({ ...base, product_partake_type: 4 }), /品牌/);
  assert.throws(() => normalizeActivityFrame({ ...base, product_partake_type: 5 }), /标签/);
  assert.throws(() => normalizeActivityFrame({ ...base, product_partake_type: 2, product_id: [1, 1] }), /重复/);
  assert.throws(() => normalizeActivityFrame({ ...base, image: 'javascript:alert(1)' }), /活动图片/);
  assert.throws(() => normalizeActivityFrame({ ...base, image: 'http://example.com/frame.png' }), /活动图片/);
  assert.throws(() => normalizeActivityFrame({ ...base, section_time: ['2026-02-30 00:00:00', '2026-10-10 00:00:00'] }), /有效/);
  assert.throws(() => normalizeActivityFrame({ ...base, sort: 32768 }), /排序/);
});
