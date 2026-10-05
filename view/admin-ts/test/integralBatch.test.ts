import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import request from '../src/utils/request.ts';
import { apiIntegralBatchProducts, apiIntegralBatchProduct, apiIntegralBatchCreate, apiIntegralBatchReceipt,
  normalizeIntegralBatch, parseIntegralBatchPage, parseIntegralBatchDetail, parseIntegralBatchReceipt,
  integralBatchMoney, integralBatchImage, type IntegralBatchInput } from '../src/api/integralBatch.ts';

const revision = 'a'.repeat(64), requestId = '123e4567-e89b-42d3-a456-426614174000';
const sku = { base_unique: 'blue0070', price: '4.25', integral: 10, quota: 2, image: '/images/blue.png' };
const input: IntegralBatchInput = { is_show: 0, products: [{ product_id: 70, revision, skus: [sku] }] };
const source = { id: 70, store_name: '多规格商品', stock: 20, price: '12.00', product_type: 0,
  image: '/images/source.png', image_preview: '', category_name: '服饰', owner_type: 0, relation_id: 0,
  owner_name: '平台', valid: true, issues: [] };
const sourceSku = { ...sku, suk: '蓝', image_preview: '', stock: 12, cost: '4.00', weight: '0.5',
  volume: '0.2', bar_code: 'BLUE', code: 'SOURCE-BLUE', valid: true, issues: [] };
const detail = { product: source, revision, skus: [sourceSku] };
const page = { list: [source], count: 1, page: 1, limit: 15, categories: [{ id: 20, pid: 0, cate_name: '服饰' }],
  labels: [{ id: 21, label_name: '新品', status: 1, is_show: 1 }],
  limits: { max_products: 100, max_total_skus: 1000, max_skus_per_product: 500 } };
const receipt = { request_id: requestId, payload_hash: 'b'.repeat(64), count: 1, is_show: 0,
  products: [{ product_id: 70, integral_id: 101 }] };

test('canonical hash preserves SKU prices and sorts product/SKU identities without mutating a draft', () => {
  const draft: IntegralBatchInput = { is_show: 1, products: [
    { product_id: 72, revision, skus: [{ ...sku, base_unique: 'b', price: '4.2' }, { ...sku, base_unique: 'A', price: '0', integral: 5 }] },
    { product_id: 70, revision, skus: [sku] } ] };
  const before = JSON.stringify(draft), normalized = normalizeIntegralBatch(draft);
  assert.deepEqual(normalized.products.map(row => row.product_id), [70, 72]);
  assert.deepEqual(normalized.products[1].skus.map(row => [row.base_unique, row.price]), [['A', '0.00'], ['b', '4.20']]);
  assert.equal(JSON.stringify(draft), before);
  const reordered = { ...draft, products: [...draft.products].reverse().map(row => ({ ...row, skus: [...row.skus].reverse() })) };
  assert.equal(createHash('sha256').update(JSON.stringify(normalized)).digest('hex'),
    createHash('sha256').update(JSON.stringify(normalizeIntegralBatch(reordered))).digest('hex'));
});

test('keeps cash-only and points-only SKUs but forbids a free SKU and fractional counts', () => {
  const replace = (change: Partial<typeof sku>) => ({ ...input, products: [{ ...input.products[0], skus: [{ ...sku, ...change }] }] });
  assert.equal(normalizeIntegralBatch(replace({ integral: 0 })).products[0].skus[0].price, '4.25');
  assert.equal(normalizeIntegralBatch(replace({ price: '0', integral: 1 })).products[0].skus[0].integral, 1);
  assert.throws(() => normalizeIntegralBatch(replace({ price: '0.00', integral: 0 })), /不能同时/);
  for (const invalid of [0, -1, 0.5, NaN, 2_147_483_648]) assert.throws(() => normalizeIntegralBatch(replace({ quota: invalid })));
  for (const invalid of [-1, 0.5, NaN, 2_147_483_648]) assert.throws(() => normalizeIntegralBatch(replace({ integral: invalid })));
});

test('rejects duplicate or noncanonical source identities and stale source revisions', () => {
  assert.throws(() => normalizeIntegralBatch({ ...input, products: [input.products[0], input.products[0]] }));
  assert.throws(() => normalizeIntegralBatch({ ...input, products: [{ ...input.products[0], skus: [sku, sku] }] }));
  for (const unique of ['', '123456789', 'abc ', 'a\nb']) assert.throws(() => normalizeIntegralBatch({ ...input,
    products: [{ ...input.products[0], skus: [{ ...sku, base_unique: unique }] }] }));
  assert.throws(() => normalizeIntegralBatch({ ...input, products: [{ ...input.products[0], revision: 'outdated' }] }));
});

test('enforces all three batch capacity limits independently', () => {
  const products = Array.from({ length: 100 }, (_, index) => ({ product_id: index + 1, revision, skus: [sku] }));
  assert.equal(normalizeIntegralBatch({ is_show: 0, products }).products.length, 100);
  assert.throws(() => normalizeIntegralBatch({ is_show: 0, products: [...products, { ...products[0], product_id: 101 }] }));
  const skus = Array.from({ length: 500 }, (_, index) => ({ ...sku, base_unique: String(index) }));
  assert.equal(normalizeIntegralBatch({ is_show: 0, products: [{ product_id: 1, revision, skus }, { product_id: 2, revision, skus }] }).products.length, 2);
  assert.throws(() => normalizeIntegralBatch({ is_show: 0, products: [{ product_id: 1, revision, skus: [...skus, { ...sku, base_unique: 'x' }] }] }));
  assert.throws(() => normalizeIntegralBatch({ is_show: 0, products: [{ product_id: 1, revision, skus }, { product_id: 2, revision, skus }, { product_id: 3, revision, skus: [sku] }] }));
});

test('normalizes cents exactly and rejects ambiguous decimal syntax', () => {
  assert.equal(integralBatchMoney('9999999999.99'), '9999999999.99');
  assert.equal(integralBatchMoney('1.2'), '1.20');
  for (const bad of ['01', '-1', '1.001', '1e2', 'NaN', ' 1', '1.', '10000000000']) assert.throws(() => integralBatchMoney(bad));
});

test('keeps stable gallery references, refuses signed URLs as persistent references and caps real varchar length', () => {
  const replace = (image: string) => ({ ...input, products: [{ ...input.products[0], skus: [{ ...sku, image }] }] });
  assert.equal(normalizeIntegralBatch(replace('/api/assets/91')).products[0].skus[0].image, '/api/assets/91');
  assert.equal(integralBatchImage('/api/assets/91'), '');
  assert.equal(integralBatchImage('/api/assets/91', '/api/assets/91?token=valid'), '/api/assets/91?token=valid');
  for (const image of ['http://example.com/a', '//example.com/a', 'javascript:alert(1)', '/images/a\\b', 'https://user:secret@example.com/a', 'https://example.com/a#x', '/' + 'a'.repeat(128)]) assert.throws(() => normalizeIntegralBatch(replace(image)));
  assert.equal(normalizeIntegralBatch(replace('')).products[0].skus[0].image, '');
});

test('validates complete selector metadata, pagination identities and capacity bounds', () => {
  assert.deepEqual(parseIntegralBatchPage(page, 15), page);
  for (const changed of [{ ...page, list: [source, source], count: 2 }, { ...page, count: 0 },
    { ...page, limits: { ...page.limits, max_products: 101 } }, { ...page, list: [{ ...source, valid: 'yes' }] },
    { ...page, categories: [{ id: 20, pid: '0', cate_name: '服饰' }] }]) assert.throws(() => parseIntegralBatchPage(changed, 15));
});

test('detail parsing binds the requested product and refuses duplicate/partial SKU graphs', () => {
  assert.deepEqual(parseIntegralBatchDetail(detail, 70), detail);
  assert.throws(() => parseIntegralBatchDetail(detail, 72));
  for (const changed of [{ ...detail, skus: [] }, { ...detail, skus: [sourceSku, sourceSku] },
    { ...detail, revision: 'bad' }, { ...detail, skus: [{ ...sourceSku, stock: '12' }] },
    { ...detail, skus: [{ ...sourceSku, issues: [7] }] }]) assert.throws(() => parseIntegralBatchDetail(changed, 70));
});

test('receipt parsing binds UUID, count, payload hash and both distinct identity sets', () => {
  assert.deepEqual(parseIntegralBatchReceipt(receipt, requestId), receipt);
  for (const changed of [{ ...receipt, request_id: crypto.randomUUID() }, { ...receipt, count: 2 },
    { ...receipt, payload_hash: '' }, { ...receipt, is_show: '0' }, { ...receipt, products: [] },
    { ...receipt, count: 2, products: [receipt.products[0], receipt.products[0]] },
    { ...receipt, count: 2, products: [receipt.products[0], { product_id: 72, integral_id: 101 }] }]) assert.throws(() => parseIntegralBatchReceipt(changed, requestId));
});

test('four API calls use canonical fixed payloads and retain cancellation signals', async () => {
  const adapter = request.defaults.adapter, storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } });
  const calls: Array<{ method?: string; url?: string; body: unknown; signal: unknown }> = [];
  const signal = new AbortController().signal;
  request.defaults.adapter = async config => {
    calls.push({ method: config.method, url: config.url, body: config.data ? JSON.parse(String(config.data)) : null, signal: config.signal });
    const data = config.url?.endsWith('/products') ? page : config.url?.endsWith('/products/70') ? detail : receipt;
    return { config, data: { status: 200, msg: 'ok', data }, headers: {}, status: 200, statusText: 'OK' };
  };
  try {
    await apiIntegralBatchProducts({ page: 1, limit: 15, keyword: '甲' }, signal);
    await apiIntegralBatchProduct(70, signal);
    await apiIntegralBatchCreate({ ...input, request_id: requestId }, signal);
    await apiIntegralBatchReceipt(requestId, signal);
    assert.deepEqual(calls.map(row => [row.method, row.url]), [['get', '/activity/integral-batch/products'],
      ['get', '/activity/integral-batch/products/70'], ['post', '/activity/integral-batch'], ['get', `/activity/integral-batch/receipts/${requestId}`]]);
    assert.deepEqual(calls[2].body, { ...normalizeIntegralBatch(input), request_id: requestId });
    assert.ok(calls.every(row => row.signal === signal));
  } finally { request.defaults.adapter = adapter; if (storage) Object.defineProperty(globalThis, 'localStorage', storage); else Reflect.deleteProperty(globalThis, 'localStorage'); }
});
