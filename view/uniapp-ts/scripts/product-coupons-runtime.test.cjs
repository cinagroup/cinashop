const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vue = require('vue');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');
const dir = path.resolve(__dirname, '../src');
const key = uid => 'cinashop-product-coupon-claim-v1-' + uid;
function issue(id, extra = {}) { return { id, title: '完整商品券' + id, scopeType: id % 4, benefitType: id % 2 ? 1 : 2,
  benefitValue: id % 2 ? '5.00' : '85.00', minimum: id % 2 ? '0.00' : '20.00', validity: id % 2
    ? { kind: 'relative', days: 7, startTime: null, endTime: null } : { kind: 'fixed', days: 0, startTime: 1770000000, endTime: 1999999999 },
  receivedCount: 0, receiveLimit: 1, claimable: true, claimReason: '', isMember: false,
  rule: '<p><strong>完整规则' + id + '</strong></p><p>不可折现<br>第二行</p>', ...extra }; }
function goods(id = 70) { return { id, price: '10.00', stock: 8, cart_button: 1, storeName: '真实商品' + id,
  attr_value: [{ unique: 'red001', suk: '红色', price: '10.00', vip_price: '8.00', stock: 8, member_price: '8.00', price_type: 'member', level_name: '' }] }; }
function pending(extra = {}) { return JSON.stringify({ version: 1, uid: 11, productId: 70, couponId: 130001, title: '原商品券', attempt: '1770000000000:1', ...extra }); }
function setup(options = {}) {
  const traces = [], records = options.records ?? new Map(); let sequence = 5000, r;
  const issues = options.issues ?? Array.from({ length: 23 }, (_, i) => issue(130001 + i));
  r = runtime({ component: 'pages/goods/detail.vue', storage: options.storage ?? new Map(), authenticated: options.authenticated ?? true, platform: options.platform ?? 'H5', send: call => {
    const url = call.url.replace(/^https?:\/\/[^/]+/u, ''), uid = call.header['Authori-zation'] === 'Bearer new-owner-22' ? 22 : call.header['Authori-zation'] ? 11 : 0;
    traces.push({ url, method: call.method, data: structuredClone(call.data), uid });
    if (/^\/api\/product\/detail\/\d+\/coupons$/u.test(url)) {
      assert.equal(call.method, 'GET'); assert.deepEqual(Object.keys(call.data).sort(), ['limit', 'page', 'view']);
      assert.equal(call.data.view, 'uni_product_coupons'); assert.equal(call.data.limit, 10);
      const productId = Number(url.split('/')[4]), page = call.data.page;
      const items = issues.slice((page - 1) * 10, page * 10).map(item => ({ ...structuredClone(item), ...(records.has(uid + ':' + item.id)
        ? { receivedCount: records.get(uid + ':' + item.id).count, claimable: false, claimReason: '已领取' } : {}) }));
      const data = { version: 1, view: 'uni_product_coupons', uid, productId, page, limit: 10, total: issues.length, items };
      return options.list?.(call, data) ?? { data };
    }
    if (/^\/api\/product\/detail\/\d+\/coupons\/\d+\/receipt$/u.test(url)) {
      assert.equal(call.method, 'GET'); assert.deepEqual(call.data, {});
      const parts = url.split('/'), productId = Number(parts[4]), couponId = Number(parts[6]), old = records.get(uid + ':' + couponId);
      const data = { version: 1, uid, productId, couponId, receivedCount: old?.count ?? 0, latestCouponUserId: old?.id ?? null };
      return options.receipt?.(call, data) ?? { data };
    }
    if (url === '/api/coupon/receive') {
      assert.equal(call.method, 'POST'); assert.deepEqual(Object.keys(call.data), ['id']);
      const row = JSON.parse(r.storage.get(key(uid))); assert.equal(row.couponId, call.data.id, 'persisted original issue precedes dispatch');
      assert.equal(row.productId, r.checkout.detail.value.id);
      const commit = () => { const old = records.get(uid + ':' + call.data.id), id = old?.id ?? ++sequence;
        records.set(uid + ':' + call.data.id, { count: (old?.count ?? 0) + 1, id }); return { data: { couponUserId: id } }; };
      return options.claim?.(call, commit) ?? commit();
    }
    if (/^\/api\/product\/detail\/\d+$/u.test(url)) return { data: goods(Number(url.split('/').at(-1))) };
    if (url.includes('/store_discounts/list/')) return { data: [] };
    if (url.includes('/product/detail/activity/')) return { data: { coupons: [{ id: 8, coupon_title: '旧营销三张样本不可领取', coupon_price: '1.00', use_min_price: '0.00' }], promotions: [] } };
    if (url.includes('/reply/config/')) return { data: { total: 0, avgScore: '0.0', goodRate: 100 } };
    if (url.includes('/reply/list/')) return { data: [] };
    if (url === '/api/cart/count') return { data: { count: 0 } };
    if (url === '/api/cart/add') return { data: { id: 91 } };
    throw Error('Unexpected product coupon I/O ' + call.method + ' ' + url);
  } });
  return { ...r, traces, records, async open(id = 70) { await r.start({ id: String(id) }); r.checkout.marketingVisible.value = true; await tick(); }, get c() { return r.checkout.productCoupons; } };
}
const writes = r => r.traces.filter(call => call.method === 'POST' && call.url === '/api/coupon/receive');
const lists = r => r.traces.filter(call => /\/coupons$/u.test(call.url));
const receipts = r => r.traces.filter(call => /\/receipt$/u.test(call.url));
async function render(r) {
  const sfc = require('@vue/compiler-sfc'), compiler = require('@vue/compiler-dom');
  const file = path.join(dir, 'components/productDetail/ProductCoupons.vue'), descriptor = sfc.parse(fs.readFileSync(file, 'utf8'), { filename: file }).descriptor;
  const bindings = sfc.compileScript(descriptor, { id: 'product-coupons-real-sfc' }).bindings;
  const fn = new Function('Vue', compiler.compile(descriptor.template.content, { mode: 'function', prefixIdentifiers: true, bindingMetadata: bindings,
    isCustomElement: tag => ['view', 'text'].includes(tag) }).code)(vue);
  const component = r.load(file).default; component.render = fn;
  const app = vue.createSSRApp({ render: () => vue.h(component, { coupons: r.c, ownerUid: r.auth.uid, productId: r.checkout.detail.value.id }) });
  // Probe the actual SFC prop boundary. Uni's text renderer consumes object
  // nodes; a string would reintroduce its signed-attribute entity bug.
  const nodeView = node => node.type === 'text' ? node.text : vue.h(node.name, node.attrs, node.children.map(nodeView));
  app.component('rich-text', { props: ['nodes'], setup: props => () => {
    assert.ok(Array.isArray(props.nodes), 'the real coupon SFC must pass structured native rich-text nodes');
    return vue.h('section', { 'data-native-rule-probe': '' }, props.nodes.map(nodeView));
  } });
  app.use(require('pinia').getActivePinia());
  return (await require('@vue/server-renderer').renderToString(app)).replace(/<!--[\s\S]*?-->/gu, '');
}

test('actual goods SFC loads a complete10/10/3 directory only after opening its promotion drawer', async () => {
  const r = setup(); try {
    await r.start({ id: '70' }); assert.equal(lists(r).length, 0); assert.deepEqual(r.c.state.items, []);
    r.checkout.marketingVisible.value = true; await tick(); assert.equal(r.c.state.items.length, 10); assert.equal(r.c.state.page.total, 23);
    await r.c.load(true); await r.c.load(true); await r.c.load(true); assert.equal(r.c.state.items.length, 23); assert.equal(r.c.hasMore, false);
    assert.deepEqual(lists(r).map(call => call.data.page), [1, 2, 3]); assert.equal(writes(r).length, 0);
    assert.ok(!r.c.state.items.some(row => row.id === 8), 'marketing sample cannot become an authoritative claim row');
  } finally { r.stop(); }
});
test('the real coupon SFC renders all four scopes, both benefits, both validity modes and full expandable rules', async () => {
  const rule = '<p>头部规则</p>' + '<p>完整长规则，不可折现；</p>'.repeat(800) + '<p>规则尾部</p>';
  const r = setup({ issues: [issue(130001, { rule }), issue(130002), issue(130003), issue(130004, { isMember: true, claimable: false, claimReason: '请先开通会员' })] });
  try {
    await r.open(); let html = await render(r); for (const text of ['通用券', '品类券', '商品券', '品牌券', '¥5.00', '8.5 折', '领取后 7 天内可用', '2033-05-18', '会员专享', '请先开通会员']) assert.ok(html.includes(text), text);
    assert.ok(!html.includes('头部规则')); r.c.toggleRule(130001); html = await render(r); assert.ok(html.includes('头部规则')); assert.ok(html.includes('规则尾部'));
    assert.equal(r.c.state.items[0].rule, rule); assert.match(html, /aria-expanded="true"/u); r.c.toggleRule(130001); assert.ok(!(await render(r)).includes('头部规则'));
    assert.equal(writes(r).length, 0);
  } finally { r.stop(); }
});
test('guest reads owner0 public rules but only explicitly navigates to login', async () => {
  const r = setup({ authenticated: false }); try { await r.open(); assert.equal(r.c.state.page.uid, 0); await r.c.claim(130001); await r.c.check(); r.c.login();
    assert.equal(writes(r).length, 0); assert.equal(receipts(r).length, 0); assert.deepEqual(r.navigations, ['/pages/auth/login']); assert.match(await render(r), /登录后领取/u);
  } finally { r.stop(); }
});
test('one explicit grant uses only the original issueID and refreshes the authoritative directory', async () => {
  const r = setup(); try { await r.open(); await r.c.claim(130001); assert.deepEqual(writes(r).map(call => call.data), [{ id: 130001 }]);
    assert.equal(r.c.state.items[0].receivedCount, 1); assert.equal(r.c.received(r.c.state.items[0]), true); assert.equal(r.storage.get(key(11)), undefined);
    assert.equal(r.c.state.confirmedOwnedId, 5001); assert.equal(r.c.state.confirmedIssue, 130001); assert.match(await render(r), /data-product-coupon-confirmed-owned="5001"/u);
    await r.c.claim(130001); assert.equal(writes(r).length, 1); r.c.wallet(); assert.deepEqual(r.navigations, ['/pages/user/coupon']);
  } finally { r.stop(); }
});
test('pending write suppresses repeat taps, other issues and page reads', async () => {
  const gate = deferred(), r = setup({ claim: (call, commit) => { const result = commit(); return gate.promise.then(() => result); } });
  try { await r.open(); const first = r.c.claim(130001); await tick(); await r.c.claim(130001); await r.c.claim(130002); await r.c.load(true); await r.c.check();
    assert.equal(writes(r).length, 1); assert.equal(lists(r).length, 1); assert.equal(r.c.state.writingId, 130001); gate.resolve(); await first; assert.equal(r.c.state.writingId, 0);
  } finally { gate.resolve(); r.stop(); }
});
test('success for X cannot become confirmation identity for a later uncertain Y grant', async () => {
  const r = setup({ claim: (call, commit) => {
    const result = commit(); return call.data.id === 130002 ? { transport: 'Y committed response lost' } : result;
  } });
  try {
    await r.open(); await r.c.claim(130001);
    assert.equal(r.c.state.confirmedIssue, 130001); assert.equal(r.c.state.confirmedOwnedId, 5001);
    await r.c.claim(130002);
    assert.equal(r.c.state.pending.couponId, 130002); assert.equal(r.c.state.confirmedIssue, 0); assert.equal(r.c.state.confirmedOwnedId, 0);
    assert.equal(r.c.received(r.c.state.items.find(item => item.id === 130001)), true);
    const html = await render(r);
    assert.match(html, /data-product-coupon-phase="uncertain"/u);
    assert.match(html, /data-product-coupon-confirmed-issue="0"/u); assert.match(html, /data-product-coupon-confirmed-owned="0"/u);
    await r.c.claim(130002); assert.equal(writes(r).length, 2);
    await r.c.check(); assert.equal(receipts(r).length, 1); assert.match(receipts(r)[0].url, /\/130002\/receipt$/u);
    assert.equal(r.c.state.confirmedIssue, 130002); assert.equal(r.c.state.confirmedOwnedId, 5002); assert.equal(writes(r).length, 2);
  } finally { r.stop(); }
});
test('committed lost response uses receipt GET and never a second grant', async () => {
  const r = setup({ claim: (call, commit) => { commit(); return { transport: 'committed reply lost' }; } });
  try { await r.open(); await r.c.claim(130001); assert.ok(r.c.state.pending); assert.match(r.c.state.actionError, /尚未确认/u);
    await r.c.load(); await r.c.claim(130002); await r.c.check(); assert.equal(writes(r).length, 1); assert.equal(receipts(r).length, 1);
    assert.equal(r.c.state.pending, null); assert.equal(r.storage.get(key(11)), undefined); assert.match(r.c.state.notice, /已领取/u);
  } finally { r.stop(); }
});
test('zero receipt is never permission to release or replay an uncertain original grant', async () => {
  const r = setup({ claim: () => ({ transport: 'request outcome unknown' }) });
  try { await r.open(); await r.c.claim(130001); const saved = r.storage.get(key(11)); for (let i = 0; i < 2; i++) { await r.c.check(); await r.c.load(); await r.c.claim(130001); await r.c.claim(130002); }
    assert.equal(writes(r).length, 1); assert.equal(receipts(r).length, 2); assert.equal(r.storage.get(key(11)), saved); assert.match(r.c.state.notice, /仍可能处理中/u);
    assert.ok(!(await render(r)).includes('结束本次操作')); assert.equal(typeof r.c.finish, 'undefined');
  } finally { r.stop(); }
});
test('full page recreation, sameUID token reuse and another product preserve the original journal without any automatic grant', async () => {
  const storage = new Map(), r = setup({ storage, claim: () => ({ transport: 'unknown' }) }); await r.open(); await r.c.claim(130001); const saved = storage.get(key(11)); r.stop();
  const next = setup({ storage }); try { await next.open(71); assert.equal(next.c.state.pending.productId, 70); assert.equal(writes(next).length, 0);
    await next.c.check(); assert.match(receipts(next)[0].url, /\/detail\/70\/coupons\/130001\/receipt$/u); assert.equal(writes(next).length, 0);
    next.auth.setLogin(next.auth.token, 11); await tick(); next.checkout.marketingVisible.value = true; await tick(); assert.equal(next.c.state.pending.couponId, 130001);
    await next.c.claim(130002); assert.equal(storage.get(key(11)), saved); assert.equal(writes(next).length, 0);
  } finally { next.stop(); }
});
for (const ending of ['hide', 'unload', 'owner', 'renew', 'product', 'drawer']) test('late grant after ' + ending + ' cannot enter the replacement view or erase its durable evidence', async () => {
  const gate = deferred(), r = setup({ claim: (call, commit) => { const result = commit(); return gate.promise.then(() => result); } });
  try { await r.open(); const first = r.c.claim(130001); await tick();
    if (ending === 'hide') r.hooks.onHide(); else if (ending === 'unload') r.hooks.onUnload(); else if (ending === 'owner') r.auth.setLogin('new-owner-22', 22);
    else if (ending === 'renew') r.auth.setLogin(r.auth.token, 11); else if (ending === 'product') r.hooks.onLoad({ id: '71' }); else r.checkout.marketingVisible.value = false;
    gate.resolve(); await first; await tick(); assert.equal(writes(r).length, 1); assert.ok(r.storage.get(key(11))); assert.equal(r.c.state.notice, '');
    assert.equal(r.c.state.writingId, 0); assert.deepEqual(r.toasts, []); assert.deepEqual(r.navigations, []);
  } finally { gate.resolve(); r.stop(); }
});
for (const ending of ['hide', 'owner', 'renew', 'product', 'drawer']) test('late directory after ' + ending + ' cannot republish old coupon rows', async () => {
  const gate = deferred(), r = setup({ list: (call, data) => gate.promise.then(() => ({ data })) });
  try { await r.open(); if (ending === 'hide') r.hooks.onHide(); else if (ending === 'owner') r.auth.setLogin('new-owner-22', 22);
    else if (ending === 'renew') r.auth.setLogin(r.auth.token, 11); else if (ending === 'product') r.hooks.onLoad({ id: '71' }); else r.checkout.marketingVisible.value = false;
    gate.resolve(); await tick(); assert.deepEqual(r.c.state.items, []); assert.equal(r.c.state.page, null);
  } finally { gate.resolve(); r.stop(); }
});
test('late positive receipt after account replacement cannot consume the former owner journal', async () => {
  const gate = deferred(), storage = new Map([[key(11), pending()]]), r = setup({ storage, receipt: (call, data) => gate.promise.then(() => ({ data: { ...data, receivedCount: 1, latestCouponUserId: 5001 } })) });
  try { await r.open(); const checking = r.c.check(); await tick(); r.auth.setLogin('new-owner-22', 22); gate.resolve(); await checking; await tick();
    assert.ok(storage.get(key(11))); assert.equal(r.c.state.notice, ''); assert.equal(r.c.state.pending, null); assert.equal(writes(r).length, 0);
  } finally { gate.resolve(); r.stop(); }
});
test('a positive receipt without a surviving ownedID confirms history without inventing a use destination', async () => {
  const storage = new Map([[key(11), pending()]]), r = setup({ storage, receipt: (call, data) => ({ data: { ...data, receivedCount: 1, latestCouponUserId: null } }) });
  try { await r.open(); await r.c.check(); assert.equal(r.c.state.pending, null); assert.match(r.c.state.notice, /已领取/u); r.c.wallet();
    assert.deepEqual(r.navigations, ['/pages/user/coupon']); assert.equal(writes(r).length, 0); assert.equal(storage.get(key(11)), undefined); assert.equal(r.c.state.confirmedOwnedId, 0);
  } finally { r.stop(); }
});
test('an issue removed from the directory remains independently readable in recovery', async () => {
  const storage = new Map([[key(11), pending()]]), r = setup({ storage, issues: [] }); try { await r.open(); assert.equal(r.c.state.page.total, 0); assert.ok((await render(r)).includes('原商品券'));
    await r.c.check(); assert.equal(receipts(r).length, 1); assert.ok(storage.get(key(11))); assert.equal(writes(r).length, 0);
  } finally { r.stop(); }
});
for (const response of [{ status: 409, msg: 'qualification changed' }, { httpStatus: 503, status: 500, msg: 'gateway' }, { httpStatus: 503, status: 400, msg: 'invalid gateway response' }, { data: null }, { data: { couponUserId: 0 } }, { data: { couponUserId: '5001' } }]) test('uncertain grant keeps durable evidence: ' + JSON.stringify(response), async () => {
  const r = setup({ claim: () => response }); try { await r.open(); await r.c.claim(130001); assert.ok(r.storage.get(key(11))); assert.ok(r.c.state.pending);
    await r.c.claim(130002); assert.equal(writes(r).length, 1);
  } finally { r.stop(); }
});
test('a definitive controller business400 frees an initial rolled-back intent', async () => {
  const r = setup({ claim: () => ({ status: 400, msg: '优惠券已领完' }) }); try { await r.open(); await r.c.claim(130001); assert.equal(r.storage.get(key(11)), undefined);
    assert.equal(r.c.state.pending, null); assert.match(r.c.state.actionError, /已领完/u); assert.equal(writes(r).length, 1);
  } finally { r.stop(); }
});
for (const malformed of ['invalid', pending({ uid: 22 }), pending({ couponId: 0 }), pending({ unexpected: true })]) test('malformed journal remains untouched and blocks all grants: ' + malformed, async () => {
  const storage = new Map([[key(11), malformed]]), r = setup({ storage }); try { await r.open(); assert.equal(r.c.state.journalBlocked, true); await r.c.claim(130001); await r.c.check();
    assert.equal(storage.get(key(11)), malformed); assert.equal(writes(r).length, 0); r.c.wallet(); assert.deepEqual(r.navigations, ['/pages/user/coupon']);
  } finally { r.stop(); }
});
test('storage failure before dispatch sends no grant', async () => {
  const r = setup(); try { await r.open(); r.uni.setStorageSync = () => { throw Error('storage unavailable'); }; await r.c.claim(130001); assert.equal(writes(r).length, 0); assert.equal(r.storage.get(key(11)), undefined);
  } finally { r.stop(); }
});
test('post-confirmation storage cleanup failure does not erase successful grant evidence', async () => {
  const r = setup(); try { await r.open(); r.uni.removeStorageSync = () => { throw Error('storage unavailable'); }; await r.c.claim(130001);
    assert.ok(r.storage.get(key(11))); assert.equal(r.c.received(r.c.state.items[0]), true); assert.match(r.c.state.notice, /已领取/u); await r.c.claim(130002); assert.equal(writes(r).length, 1);
  } finally { r.stop(); }
});
for (const mutate of [data => ({ ...data, uid: 22 }), data => ({ ...data, productId: 71 }), data => ({ ...data, view: undefined }),
  data => ({ ...data, items: data.items.map((item, i) => i ? item : { ...item, rule: undefined }) }), data => ({ ...data, items: data.items.map((item, i) => i ? item : { ...item, rule: 'x'.repeat(64001) }) })])
  test('invalid owner/product/view/full-rule projection never makes a partial page actionable: ' + mutate.toString(), async () => {
    const r = setup({ list: (call, data) => ({ data: mutate(data) }) }); try { await r.open(); assert.deepEqual(r.c.state.items, []); assert.ok(r.c.state.error); await r.c.claim(130001); assert.equal(writes(r).length, 0);
    } finally { r.stop(); }
  });
test('response UTF8 budget rejects a complete oversized page and never truncates a long rule', async () => {
  const r = setup({ issues: Array.from({ length: 10 }, (_, i) => issue(130001 + i, { rule: '长'.repeat(64000) })) }); try { await r.open(); assert.deepEqual(r.c.state.items, []); assert.match(r.c.state.error, /完整资料/u); assert.equal(writes(r).length, 0);
  } finally { r.stop(); }
});
test('client allowlist removes executable attributes while retaining readable complete formatting and safe signed-media URLs', async () => {
  const r = setup({ issues: [issue(130001, { rule: '<p>规则正文</p><img src="/api/media/image.png?signature=complete" onerror="bad()"><script>bad()</script><a href="javascript:bad()">文字链接</a><p>尾部</p>' })] });
  try { await r.open(); const rule = r.c.state.items[0].rule; assert.match(rule, /规则正文/u); assert.match(rule, /尾部/u); assert.match(rule, /signature=complete/u); assert.doesNotMatch(rule, /<script|onerror|javascript:/u);
  } finally { r.stop(); }
});
test('append network failure retries only the missing page and preserves already visible rows', async () => {
  let failed = false; const r = setup({ list: (call, data) => call.data.page === 2 && !failed ? (failed = true, { transport: 'page lost' }) : { data } });
  try { await r.open(); await r.c.load(true); assert.equal(r.c.state.items.length, 10); assert.equal(r.c.state.page.page, 1); assert.ok(r.c.state.error);
    await r.c.retry(); assert.equal(r.c.state.items.length, 20); assert.deepEqual(lists(r).map(call => call.data.page), [1, 2, 2]); assert.equal(writes(r).length, 0);
  } finally { r.stop(); }
});
for (const change of ['total', 'duplicate']) test('pagination ' + change + ' drift requires an explicit full refresh', async () => {
  const r = setup({ list: (call, data) => call.data.page === 2 ? { data: change === 'total' ? { ...data, total: 24 } : { ...data, items: [issue(130001), ...data.items.slice(1)] } } : { data } });
  try { await r.open(); await r.c.load(true); assert.equal(r.c.state.items.length, 10); assert.equal(r.c.state.invalidPagination, true); assert.match(r.c.state.error, /目录已变化/u);
    await r.c.retry(); assert.equal(lists(r).at(-1).data.page, 1); assert.equal(r.c.state.invalidPagination, false); assert.equal(writes(r).length, 0);
  } finally { r.stop(); }
});
test('server membership and received flags block writes without client inference', async () => {
  const r = setup({ issues: [issue(130001, { isMember: true, claimable: false, claimReason: '请先开通会员' }), issue(130002, { receivedCount: 1, claimable: false, claimReason: '已领取' })] });
  try { await r.open(); await r.c.claim(130001); await r.c.claim(130002); assert.equal(writes(r).length, 0); r.c.membership(); assert.deepEqual(r.navigations, ['/pages/user/vipOpen']);
  } finally { r.stop(); }
});
test('storage owner drift prevents actions even before its event callback', async () => {
  const r = setup(); try { await r.open(); r.storage.set('uni_uid', 22); r.storage.set('uni_token', 'new-owner-22'); await r.c.claim(130001); await r.c.load(true); r.c.wallet(); assert.equal(writes(r).length, 0); assert.deepEqual(r.navigations, []);
  } finally { r.stop(); }
});
for (const change of [data => ({ ...data, uid: 22 }), data => ({ ...data, productId: 71 }), data => ({ ...data, couponId: 130002 }), data => ({ ...data, receivedCount: 0, latestCouponUserId: 5001 })])
  test('untrusted recovery receipt never consumes the original journal: ' + change.toString(), async () => {
    const storage = new Map([[key(11), pending()]]), r = setup({ storage, receipt: (call, data) => ({ data: change(data) }) });
    try { await r.open(); await r.c.check(); assert.ok(r.c.state.pending); assert.ok(storage.get(key(11))); assert.ok(r.c.state.actionError); assert.equal(r.c.state.confirmedOwnedId, 0); assert.equal(writes(r).length, 0);
    } finally { r.stop(); }
  });
test('H5 same-origin exclusive lock denial creates no journal and no grant', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'window'), events = new Map(), locks = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { hash: '' }, navigator: { locks: { request: async (name, options, action) => { locks.push([name, options]); return action(null); } } },
    addEventListener: (name, fn) => events.set(name, fn), removeEventListener: (name, fn) => { if (events.get(name) === fn) events.delete(name); } } });
  const r = setup(); try { await r.open(); await r.c.claim(130001); assert.deepEqual(locks, [['cinashop-product-coupons-11', { mode: 'exclusive', ifAvailable: true }]]);
    assert.equal(writes(r).length, 0); assert.equal(r.storage.get(key(11)), undefined); assert.match(r.c.state.actionError, /另一页面/u);
  } finally { r.stop(); assert.equal(events.size, 0); if (saved) Object.defineProperty(globalThis, 'window', saved); else delete globalThis.window; }
});
// A browser dispatches every listener. Independent estimate and coupon hooks
// share these events; a one-function Map would silently replace the first hook.
function listenerRegistry() {
  const entries = new Map();
  return { get size() { return entries.size; },
    add(name, fn) { const list = entries.get(name) ?? new Set(); list.add(fn); entries.set(name, list); },
    remove(name, fn) { const list = entries.get(name); list?.delete(fn); if (!list?.size) entries.delete(name); },
    get(name) { return () => { for (const fn of [...(entries.get(name) ?? [])]) fn(); }; },
  };
}
test('H5 lock, browser visibility, storage and disposal fence the actual pending native request', async () => {
  const saved = Object.fromEntries(['window', 'document'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)])), events = listenerRegistry(), documentEvents = listenerRegistry(), locks = [], gate = deferred();
  const doc = { visibilityState: 'visible', addEventListener: (name, fn) => documentEvents.add(name, fn), removeEventListener: (name, fn) => { documentEvents.remove(name, fn); } };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { hash: '' }, navigator: { locks: { request: async (name, options, action) => { locks.push([name, options]); return action({}); } } },
    addEventListener: (name, fn) => events.add(name, fn), removeEventListener: (name, fn) => { events.remove(name, fn); } } });
  const r = setup({ claim: (call, commit) => { const result = commit(); return gate.promise.then(() => result); } });
  try { await r.open(); const claim = r.c.claim(130001); await tick(); assert.equal(writes(r).length, 1); assert.equal(locks.length, 1);
    doc.visibilityState = 'hidden'; documentEvents.get('visibilitychange')(); assert.deepEqual(r.c.state.items, []); gate.resolve(); await claim;
    assert.ok(r.storage.get(key(11))); assert.equal(r.c.state.notice, ''); doc.visibilityState = 'visible'; documentEvents.get('visibilitychange')(); await tick();
    assert.equal(r.c.state.pending.couponId, 130001); assert.equal(writes(r).length, 1); await r.c.check(); assert.equal(r.c.state.confirmedOwnedId, 5001); assert.equal(writes(r).length, 1);
    r.storage.set('uni_uid', 22); r.storage.set('uni_token', 'new-owner-22'); events.get('storage')(); await tick(); assert.equal(r.auth.uid, 22); assert.deepEqual(r.c.state.items, []);
  } finally { gate.resolve(); r.stop(); assert.equal(events.size, 0); assert.equal(documentEvents.size, 0); for (const name of ['window', 'document']) if (saved[name]) Object.defineProperty(globalThis, name, saved[name]); else delete globalThis[name]; }
});
for (const platform of ['MP-WEIXIN', 'APP-PLUS']) test(platform + ' actual source guards use native request and retain unknown journal on show', async () => {
  const encoder = Object.getOwnPropertyDescriptor(globalThis, 'TextEncoder');
  Object.defineProperty(globalThis, 'TextEncoder', { configurable: true, value: undefined });
  const r = setup({ platform, claim: () => ({ transport: 'native request unknown' }) }); try { await r.open(); await r.c.claim(130001); r.hooks.onHide(); r.hooks.onShow(); await tick(); r.checkout.marketingVisible.value = true; await tick();
    await r.c.claim(130001); assert.equal(writes(r).length, 1); assert.equal(r.c.state.pending.couponId, 130001); await r.c.check(); assert.equal(receipts(r).length, 1);
  } finally { r.stop(); if (encoder) Object.defineProperty(globalThis, 'TextEncoder', encoder); else delete globalThis.TextEncoder; }
});

const flattenRuleNodes = nodes => {
  const result = [], pending = [...nodes].reverse();
  while (pending.length) { const node = pending.pop(); result.push(node); if (node.children) pending.push(...[...node.children].reverse()); }
  return result;
};
for (const platform of ['H5', 'MP-WEIXIN', 'APP-PLUS']) test(platform + ' real coupon SFC passes safe native nodes with an exact signed-image query without TextEncoder', async () => {
  const encoder = Object.getOwnPropertyDescriptor(globalThis, 'TextEncoder');
  Object.defineProperty(globalThis, 'TextEncoder', { configurable: true, value: undefined });
  const signed = '/api/assets/990101?expires=1999999999&signature=' + 'A'.repeat(43);
  const rule = '<h3>完整规则标题</h3><p>文字 &lt;img src=x onerror=bad()&gt; &amp;lt;script&amp;gt;</p>'
    + '<ol start="10000" type="I"><li>完整列表</li></ol><table><colgroup span="100"><col width="20%"></colgroup><tr><td colspan="100">完整表格</td></tr></table>'
    + '<img src="' + signed.replaceAll('&', '&amp;') + '" alt="图 &quot; onerror=&quot;bad()" onerror="bad()">'
    + '<img src="https://images.example.invalid/rule.png?q=%252F&amp;v=2"><p>完整尾段</p>';
  const r = setup({ platform, issues: [issue(130001, { rule })] });
  try {
    await r.open(); const item = r.c.state.items[0]; assert.ok(item, r.c.state.error);
    const all = flattenRuleNodes(item.ruleNodes), images = all.filter(node => node.name === 'img');
    assert.equal(images.length, 2, 'encoded markup stays a text node');
    const expected = (platform === 'H5' ? '' : 'https://cinashop-api.cinagroup.workers.dev') + signed;
    assert.equal(images[0].attrs.src, expected); assert.ok(!images[0].attrs.src.includes('&amp;'));
    const url = new (require('node:url').URL)(images[0].attrs.src, 'https://local.invalid');
    assert.deepEqual([...url.searchParams.keys()], ['expires', 'signature']); assert.equal(url.searchParams.get('signature'), 'A'.repeat(43));
    assert.equal(images[0].attrs.alt, '图 " onerror="bad()'); assert.ok(!Object.hasOwn(images[0].attrs, 'onerror'));
    assert.equal(images[1].attrs.src, 'https://images.example.invalid/rule.png?q=%252F&v=2');
    assert.equal(all.find(node => node.name === 'ol').attrs.start, '10000');
    assert.equal(all.find(node => node.name === 'td').attrs.colspan, '100');
    assert.equal(all.find(node => node.name === 'colgroup').attrs.span, '100');
    assert.ok(all.some(node => node.type === 'text' && node.text.includes('&lt;img')));
    assert.ok(!all.some(node => node.name === 'script' || Object.hasOwn(node.attrs ?? {}, 'onerror')));
    r.c.toggleRule(130001); const html = await render(r); for (const text of ['完整规则标题', '完整列表', '完整表格', '完整尾段', 'data-native-rule-probe']) assert.ok(html.includes(text), text);
    assert.equal(writes(r).length, 0);
  } finally { r.stop(); if (encoder) Object.defineProperty(globalThis, 'TextEncoder', encoder); else delete globalThis.TextEncoder; }
});
test('article node projection retains the complete64000-character rule and the existing quote-aware sanitizer grammar', async () => {
  const r = setup(); try {
    const { sanitizeArticleRichText, articleRichTextNodes } = r.load(path.resolve(dir, '../../common/articleRichText.ts'));
    for (const [input, expected] of [
      ['前<!--未闭合', '前'],
      ['前<img title="a > b" src=/api/assets/1?x=a=b&y=c>后', '前<img title="a &gt; b" src="/api/assets/1?x=a=b&amp;y=c" width="100%">后'],
      ['前<img title="未闭合', '前&lt;img title="未闭合'],
      ['<ol start="10000" type="I"><li>正文</li></ol>', '<ol start="10000" type="I"><li>正文</li></ol>'],
    ]) assert.equal(sanitizeArticleRichText(input), expected);
    const tail = '尾部规则</p>', rule = '<p>' + '汉😀'.repeat(21000) + 'x'.repeat(64000 - 3 - 21000 * 3 - tail.length) + tail;
    assert.equal(rule.length, 64000); const all = flattenRuleNodes(articleRichTextNodes(rule));
    assert.equal(all.filter(node => node.type === 'text').map(node => node.text).join(''), rule.slice(3, -4));
    const closed = articleRichTextNodes('<div><p>甲</div>乙'); assert.equal(closed[0].children[0].children[0].text, '甲'); assert.equal(closed[1].text, '乙');
  } finally { r.stop(); }
});
