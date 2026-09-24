const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');

const row = (id, presale = 0) => ({ id, store_name: `商品${id}`, image: '/rank.png',
  price: '12.50', sales: 100 - id, star: '4.8', brand_name: '品牌', is_presale_product: presale,
  activity: '0,1,2,3', recommendation_target: { version: 1, product_id: id,
    kind: presale ? 'presale' : 'product', id, ends_at: null } });
const list = page => page === 1 ? Array.from({ length: 10 }, (_, i) => row(i + 1)) : [row(11), row(12, 1)];
const setup = (send = call => ({ data: list(call.data.page) })) =>
  runtime({ component: 'pages/columnGoods/rank/index.vue', send });

test('legacy ranking route loads the selected authoritative Worker tab and paginates once', async () => {
  const r = setup();
  try {
    await r.start({ type: '3' });
    assert.equal(r.checkout.type.value, 3);
    assert.deepEqual(r.calls[0], { url: '/api/product/rank/3', data: { page: 1, limit: 10, selectId: 0 } });
    assert.equal(r.checkout.products.value.length, 10);
    r.hooks.onReachBottom(); r.hooks.onReachBottom(); await tick();
    assert.deepEqual(r.calls.map(call => call.data.page), [1, 2]);
    assert.equal(r.checkout.products.value.length, 12);
    assert.equal(r.checkout.hasMore.value, false);
    r.hooks.onReachBottom(); await tick(); assert.equal(r.calls.length, 2);
    r.checkout.select(2); await tick();
    assert.equal(r.checkout.type.value, 2); assert.equal(r.checkout.products.value.length, 10);
    assert.deepEqual(r.calls.at(-1), { url: '/api/product/rank/2', data: { page: 1, limit: 10, selectId: 0 } });
  } finally { r.stop(); }
});

test('ranking cards only open loaded product IDs with exact presale or base-product projections', async () => {
  const r = setup();
  try {
    await r.start(); await r.checkout.load(true);
    r.checkout.openProduct(999); assert.deepEqual(r.navigations, []);
    r.checkout.openProduct(12); assert.deepEqual(r.navigations, ['/pages/activity/presaleDetail?id=12']);
    r.checkout.openProduct(1); assert.equal(r.navigations.length, 1);
    r.hooks.onHide(); r.checkout.openProduct(1); assert.equal(r.navigations.length, 1);
    r.hooks.onShow(); await tick(); r.checkout.openProduct(1);
    assert.equal(r.navigations.at(-1), '/pages/goods/detail?id=1');
  } finally { r.stop(); }
});

test('ranking activity targets require an exact product match, declared type, and valid deadline', async () => {
  const r = setup(() => ({ data: [
    { ...row(31), activity: '1,2,3,0', recommendation_target: { version: 1, product_id: 31, kind: 'seckill', id: 901, ends_at: '2099-09-24T01:00:00.000Z' } },
    { ...row(32), activity: '2,3,0', recommendation_target: { version: 1, product_id: 32, kind: 'bargain', id: 902, ends_at: null } },
    { ...row(33), activity: '3,0', recommendation_target: { version: 1, product_id: 33, kind: 'combination', id: 903, ends_at: null } },
    { ...row(34), activity: '1', recommendation_target: { version: 1, product_id: 999, kind: 'seckill', id: 904, ends_at: '2099-09-24T01:00:00.000Z' } },
    { ...row(35), activity: '1', recommendation_target: { version: 1, product_id: 35, kind: 'seckill', id: 905, ends_at: '2000-09-24T01:00:00.000Z' } },
  ] }));
  try {
    await r.start();
    const byId = id => r.checkout.products.value.find(item => item.id === id);
    assert.equal(byId(31).destination, '/pages/activity/seckillDetail?id=901');
    assert.equal(byId(32).destination, '/pages/activity/bargainDetail?id=902');
    assert.equal(byId(33).destination, '/pages/activity/detail?id=903');
    assert.equal(byId(34).destination, null);
    r.checkout.openProduct(34); r.checkout.openProduct(35);
    assert.deepEqual(r.navigations, []);
    r.checkout.openProduct(31);
    assert.deepEqual(r.navigations, ['/pages/activity/seckillDetail?id=901']);
    r.hooks.onHide(); r.hooks.onShow(); await tick();
    r.checkout.openProduct(32);
    assert.equal(r.navigations.at(-1), '/pages/activity/bargainDetail?id=902');
    r.hooks.onHide(); r.hooks.onShow(); await tick();
    r.checkout.openProduct(33);
    assert.equal(r.navigations.at(-1), '/pages/activity/detail?id=903');
  } finally { r.stop(); }
});

test('tab switch and hidden page reject late responses from an older rank', async () => {
  const first = deferred();
  const r = setup(call => call.url.endsWith('/1') ? first.promise : { data: [row(20)] });
  try {
    await r.start(); r.checkout.select(2); await tick();
    first.resolve({ data: [row(1)] }); await tick();
    assert.deepEqual(r.checkout.products.value.map(item => item.id), [20]);
    assert.equal(r.checkout.type.value, 2);
    r.hooks.onHide(); assert.deepEqual(r.checkout.products.value, []);
    r.checkout.openProduct(20); assert.deepEqual(r.navigations, []);
  } finally { first.resolve({ data: [row(1)] }); r.stop(); }
});

test('failed append keeps committed page and retries without duplicating rows', async () => {
  let fail = true;
  const r = setup(call => call.data.page === 2 && fail ? { transport: '网络断开' } : { data: list(call.data.page) });
  try {
    await r.start(); await r.checkout.load(true);
    assert.equal(r.checkout.page.value, 1); assert.equal(r.checkout.products.value.length, 10);
    assert.match(r.checkout.error.value, /网络断开/);
    r.hooks.onReachBottom(); await tick(); assert.equal(r.calls.length, 2);
    fail = false; await r.checkout.load(true);
    assert.equal(r.checkout.page.value, 2); assert.equal(r.checkout.products.value.length, 12);
    assert.deepEqual(r.calls.map(call => call.data.page), [1, 2, 2]);
  } finally { r.stop(); }
});

test('parser rejects malformed rank identities and prices; image URLs are sanitized', async () => {
  const r = setup();
  try {
    const api = r.load(path.resolve(__dirname, '../src/api/productRank.ts'));
    assert.equal(api.parseProductRankType('3'), 3);
    assert.equal(api.parseProductRankType('3&x=1'), 1);
    assert.throws(() => api.parseProductRankRows([row(1), row(1)]));
    assert.throws(() => api.parseProductRankRows([{ ...row(1), price: '12.50<script>' }]));
    assert.throws(() => api.parseProductRankRows([{ ...row(1), is_presale_product: '1' }]));
    assert.equal(api.parseProductRankRows([{ ...row(1), image: 'javascript:alert(1)' }])[0].image, '');
    for (const change of [
      { recommendation_target: undefined },
      { recommendation_target: { ...row(1).recommendation_target, id: 2 } },
      { recommendation_target: { ...row(1).recommendation_target, ends_at: 'invalid' } },
      { activity: '1,1' },
      { activity: '1', recommendation_target: { version: 1, product_id: 1, kind: 'seckill', id: 900, ends_at: null } },
      { activity: '0,1', recommendation_target: { version: 1, product_id: 1, kind: 'seckill', id: 900, ends_at: '2099-09-24T01:00:00.000Z' } },
      { activity: '2', recommendation_target: { version: 1, product_id: 1, kind: 'combination', id: 900, ends_at: null } },
      { is_presale_product: 1, recommendation_target: { version: 1, product_id: 1, kind: 'product', id: 1, ends_at: null } },
    ]) assert.equal(api.parseProductRankRows([{ ...row(1), ...change }])[0].destination, null);
    await assert.rejects(api.apiProductRank(4, 1));
  } finally { r.stop(); }
});

test('DIY and native route resolver recognize the exact old ranking path', () => {
  const r = setup();
  try {
    const navigation = r.load(path.resolve(__dirname, '../src/config/navigation.ts'));
    const diy = r.load(path.resolve(__dirname, '../src/utils/diy.ts'));
    assert.equal(navigation.resolveRegisteredPageRoute('/pages/columnGoods/rank/index', 'type=2'), '/pages/columnGoods/rank/index?type=2');
    assert.equal(diy.normalizeDiyLink('/pages/columnGoods/rank/index'), '/pages/columnGoods/rank/index');
    diy.openDiyLink('/pages/columnGoods/rank/index');
    assert.deepEqual(r.navigations, ['/pages/columnGoods/rank/index']);
  } finally { r.stop(); }
});
