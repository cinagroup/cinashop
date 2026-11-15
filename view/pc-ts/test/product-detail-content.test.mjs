import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse, compileScript } from '@vue/compiler-sfc';
import { createRenderer, createSSRApp, h, nextTick, reactive, proxyRefs } from 'vue';
import * as Vue from 'vue';
import { createRouter, createMemoryHistory, RouterView } from 'vue-router';
import { renderToString } from '@vue/server-renderer';

const moduleId = '/src/components/ProductDetailContent.test-script.ts';
export function productDetailContentPlugin(root) {
  const resolved = root.replaceAll('\\', '/').replace(/\/$/, '') + moduleId;
  return { name: 'actual-product-detail-content-setup', resolveId(id) { if (id === moduleId) return resolved; }, async load(id) {
    if (id.replaceAll('\\', '/') !== resolved) return;
    const filename = root + '/src/components/ProductDetailContent.vue';
    return compileScript(parse(await readFile(filename, 'utf8'), { filename }).descriptor, { id: 'product-detail-content-fixture' }).content;
  } };
}
const renderer = createRenderer({ createElement: () => ({ children: [] }), createText: text => ({ text }), createComment: text => ({ text }),
  insert(n, p) { n.parent = p; (p.children ??= []).push(n); }, remove(n) { if (n.parent) n.parent.children = n.parent.children.filter(c => c !== n); },
  parentNode: n => n.parent, nextSibling: () => null, patchProp() {}, setText() {}, setElementText() {} });
const flush = async () => { for (let i = 0; i < 24; i++) { await Promise.resolve(); await nextTick(); } };
const gate = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
let sequence = 0;
const card = (id = 80) => ({ id, store_name: '推荐商品' + id, image: 'https://cdn.example.test/product.png', price: '20.00', sales: 12 });
const coupon = (id = 100, change = {}) => ({ id, title: '商品优惠券' + id, scopeType: (id - 100) % 4, benefitType: id % 2 ? 2 : 1,
  benefitValue: id % 2 ? '85.00' : '5.00', minimum: '20.00', validity: id % 2 ? { kind: 'fixed', days: 0, startTime: 1794700800, endTime: 1799971200 } : { kind: 'relative', days: 7, startTime: null, endTime: null },
  receivedCount: 0, receiveLimit: 3, claimable: true, claimReason: '', isMember: id === 102, ...change });
function page(productId = 70, uid = 11, current = 1, total = 21, changes = {}) {
  return { version: 1, uid, productId, page: current, limit: 10, total,
    items: Array.from({ length: Math.min(10, Math.max(0, total - (current - 1) * 10)) }, (_, i) => coupon(100 + (current - 1) * 10 + i)), ...changes };
}

export function registerProductDetailContentTests(context) {
  async function mount(override = () => undefined, options = {}) {
    const { server, authUtils, api, response } = context(), calls = [], listeners = new Map(), prior = Object.getOwnPropertyDescriptor(globalThis, 'document');
    if (options.token !== false) authUtils.setAuth(options.token || 'pc-detail-content-' + (++sequence), 11);
    if (options.anonymous) authUtils.clearAuth();
    const doc = { visibilityState: 'visible', addEventListener: (key, listener) => listeners.set(key, listener), removeEventListener: key => listeners.delete(key) };
    Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
    const props = reactive({ productId: 70, description: '<p>真实商品正文</p><img src="https://cdn.example.test/body.png">', recommendations: [card()] });
    const component = (await server.ssrLoadModule(moduleId)).default;
    const dto = await server.ssrLoadModule('/src/api/productDetailContent.ts');
    props.description = dto.normalizeProductDescription(props.description); props.recommendations = dto.normalizeDetailRecommendations(props.recommendations);
    const received = new Set(), uid = () => authUtils.getToken() ? authUtils.getUid() : 0;
    api.defaults.adapter = async config => {
      calls.push(config); const custom = await override(config); if (custom !== undefined) return response(config, custom);
      let data;
      if (/\/coupons\/\d+\/receipt$/.test(config.url)) { const id = Number(config.url.split('/').at(-2)); data = { version: 1, uid: uid(), productId: Number(config.url.split('/')[3]), couponId: id, receivedCount: received.has(id) ? 1 : 0, latestCouponUserId: received.has(id) ? id + 800 : null }; }
      else if (config.url.endsWith('/coupons')) { data = page(Number(config.url.split('/')[3]), uid(), config.params.page); data.items.forEach(item => { if (received.has(item.id)) { item.receivedCount = 1; item.claimable = false; item.claimReason = 'received'; } }); }
      else if (config.url === '/coupon/receive') { const id = JSON.parse(config.data).id; received.add(id); data = { couponUserId: id + 800 }; }
      else if (config.url.startsWith('/product/detail_content/')) data = { description: '<p>重新读取的商品正文</p><img src="https://cdn.example.test/body-new.png">' };
      else if (config.url.startsWith('/product/detail/recommend/')) data = [card(81)];
      else throw Error('Unexpected fixture request ' + config.url);
      return response(config, { status: 200, data });
    };
    let view;
    const shell = { setup() { view = component.setup(props, { expose() {} }); return () => null; } };
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/goods/:id', component: shell }, { path: '/away', component: { render: () => null } }, { path: '/login', component: { render: () => null } }] });
    const app = renderer.createApp({ render: () => h(RouterView) }); app.use(router);
    await router.push(options.path || '/goods/70'); app.mount({ children: [] }); await flush(); let closed = false;
    return { props, get view() { return view; }, calls, router, doc, listeners, received, dto,
      close() { if (closed) return; closed = true; app.unmount(); if (prior) Object.defineProperty(globalThis, 'document', prior); else delete globalThis.document; } };
  }
  const posts = f => f.calls.filter(c => c.method === 'post');
  it('PC actual content SFC reads all 21 coupons in 10/10/1 pages and preserves the PHP five-card limit', async () => {
    const f = await mount(); try { assert.equal(f.view.state.items.length, 10); await f.view.load(true); await f.view.load(true);
      assert.equal(f.view.state.items.length, 21); assert.deepEqual(f.calls.map(c => c.params?.page), [1, 2, 3]); assert.equal(f.view.hasMore.value, false);
      assert.equal(f.view.state.description, '<p>真实商品正文</p><img src="https://cdn.example.test/body.png" width="100%">');
      assert.equal(f.dto.normalizeDetailRecommendations(Array.from({ length: 8 }, (_, i) => card(80 + i))).length, 5); assert.equal(posts(f).length, 0);
    } finally { f.close(); }
  });
  it('PC coupon page failure keeps the previous ten and retries the same second page', async () => {
    let fail = true; const f = await mount(c => { if (c.params?.page === 2 && fail) { fail = false; return { status: 503, msg: '第二页暂不可用' }; } });
    try { await f.view.load(true); assert.equal(f.view.state.items.length, 10); assert.equal(f.view.state.page.page, 1); assert.match(f.view.state.error, /第二页/);
      await f.view.load(true); assert.equal(f.view.state.items.length, 20); assert.deepEqual(f.calls.map(c => c.params?.page), [1, 2, 2]);
    } finally { f.close(); }
  });
  for (const fault of ['total', 'duplicate']) it('PC coupon continuation rejects ' + fault + ' changes until an explicit full refresh', async () => {
    const f = await mount(c => c.params?.page === 2 ? { status: 200, data: page(70, 11, 2, fault === 'total' ? 22 : 21, fault === 'duplicate' ? { items: page().items } : {}) } : undefined);
    try { await f.view.load(true); assert.equal(f.view.state.items.length, 10); assert.equal(f.view.state.page.total, 21); assert.equal(f.view.state.invalidPagination, true);
      const count = f.calls.length; await f.view.load(true); assert.equal(f.calls.length, count); await f.view.load(); assert.equal(f.view.state.invalidPagination, false); assert.equal(f.view.state.items.length, 10);
    } finally { f.close(); }
  });
  for (const change of [{ version: 2 }, { uid: 22 }, { productId: 71 }, { page: 2 }, { limit: 20 }, { total: 10001 }, { items: [] }, { items: [coupon(100), coupon(100)] }])
    it('PC coupon response rejects mismatched or incomplete DTO ' + JSON.stringify(change), async () => {
      const f = await mount(() => ({ status: 200, data: page(70, 11, 1, 21, change) }));
      try { assert.equal(f.view.state.page, null); assert.equal(f.view.state.items.length, 0); assert.match(f.view.state.error, /资料/); assert.equal(posts(f).length, 0); }
      finally { f.close(); }
    });
  it('PC successful claim sends one explicit issue id and rereads the directory without spending the receive limit again', async () => {
    const f = await mount(); try { await f.view.claim(100); assert.deepEqual(posts(f).map(c => JSON.parse(c.data)), [{ id: 100 }]);
      assert.equal(f.view.received(f.view.state.items[0]), true); assert.equal(f.view.state.items[0].receiveLimit, 3); assert.equal(f.view.canClaim(f.view.state.items[0]), false);
      await f.view.claim(100); assert.equal(posts(f).length, 1); assert.equal(f.calls.at(-1).params.page, 1);
    } finally { f.close(); }
  });
  it('PC confirmed claim remains blocked when the acknowledgement is known but the directory refresh fails', async () => {
    let claimed = false; const f = await mount(c => c.url === '/coupon/receive' ? (claimed = true, { status: 200, data: { couponUserId: 900 } }) : claimed && c.url.endsWith('/coupons') ? { status: 503, msg: '读回暂不可用' } : undefined);
    try { await f.view.claim(100); assert.equal(f.view.pending(100).phase, 'confirmed'); assert.equal(f.view.state.page, null); await f.view.claim(100); assert.equal(posts(f).length, 1); }
    finally { f.close(); }
  });
  it('PC unknown claim survives same-bearer reconstruction and is recovered only through an explicit read', async () => {
    const token = 'pc-content-rebuild-' + (++sequence); let f = await mount(c => c.url === '/coupon/receive' ? { status: 503, msg: '提交后回执丢失' } : undefined, { token });
    try { await f.view.claim(100); await f.view.claim(100); assert.equal(posts(f).length, 1); assert.equal(f.view.pending(100).phase, 'uncertain'); } finally { f.close(); }
    f = await mount(c => c.url.endsWith('/100/receipt') ? { status: 200, data: { version: 1, uid: 11, productId: 70, couponId: 100, receivedCount: 1, latestCouponUserId: 900 } } : undefined, { token: false });
    try { assert.equal(f.view.pending(100).phase, 'uncertain'); await f.view.claim(100); assert.equal(posts(f).length, 0); await f.view.check(100);
      assert.equal(f.view.pending(100).phase, 'confirmed'); assert.equal(f.view.received(f.view.state.items[0]), true); assert.equal(posts(f).length, 0);
    } finally { f.close(); }
  });
  it('PC an unknown claim remains explicitly recoverable after its exhausted issuer leaves the directory', async () => {
    const token = 'pc-content-exhausted-' + (++sequence); let f = await mount(c => c.url === '/coupon/receive' ? { status: 503, msg: '提交后回执丢失' } : undefined, { token });
    try { await f.view.claim(100); assert.equal(posts(f).length, 1); } finally { f.close(); }
    f = await mount(c => c.url.endsWith('/coupons') ? { status: 200, data: page(70, 11, 1, 0) } : c.url.endsWith('/100/receipt') ? { status: 200, data: { version: 1, uid: 11, productId: 70, couponId: 100, receivedCount: 1, latestCouponUserId: 900 } } : undefined, { token: false });
    try { assert.equal(f.view.state.items.length, 0); assert.equal(f.view.unlistedPending.value.length, 1); assert.equal(f.view.unlistedPending.value[0].couponId, 100); assert.equal(f.view.unlistedPending.value[0].title, '商品优惠券100');
      await f.view.check(100); assert.equal(f.view.pending(100).phase, 'confirmed'); assert.equal(f.view.unlistedPending.value.length, 0); assert.equal(posts(f).length, 0);
    } finally { f.close(); }
  });
  it('PC a zero-record read requires explicit completion before a newly requested claim', async () => {
    const f = await mount(c => c.url === '/coupon/receive' ? { status: 503, msg: '未知结果' } : undefined);
    try { await f.view.claim(100); f.view.finish(100); assert.equal(f.view.pending(100).checked, false); await f.view.claim(100); assert.equal(posts(f).length, 1);
      await f.view.check(100); assert.equal(f.view.pending(100).checked, true); await f.view.claim(100); assert.equal(posts(f).length, 1);
      f.view.finish(100); assert.equal(f.view.pending(100), undefined); assert.match(f.view.state.notice, /原请求结果仍未确认/); assert.equal(posts(f).length, 1);
      await f.view.claim(100); assert.equal(posts(f).length, 2);
    } finally { f.close(); }
  });
  it('PC surviving issuance evidence confirms a prior claim without inventing an owned coupon id', async () => {
    const f = await mount(c => c.url === '/coupon/receive' ? { status: 503, msg: '未知结果' } : c.url.endsWith('/100/receipt') ? { status: 200, data: { version: 1, uid: 11, productId: 70, couponId: 100, receivedCount: 1, latestCouponUserId: null } } : undefined);
    try { await f.view.claim(100); await f.view.check(100); assert.equal(f.view.pending(100).phase, 'confirmed'); assert.equal(f.view.pending(100).couponUserId, null); await f.view.claim(100); assert.equal(posts(f).length, 1); }
    finally { f.close(); }
  });
  it('PC a malformed claim acknowledgement becomes uncertain and cannot be repeated automatically', async () => {
    const f = await mount(c => c.url === '/coupon/receive' ? { status: 200, data: {} } : undefined);
    try { await f.view.claim(100); await f.view.claim(100); assert.equal(f.view.pending(100).phase, 'uncertain'); assert.equal(posts(f).length, 1); }
    finally { f.close(); }
  });
  for (const ending of ['identity', 'same-token-generation', 'route', 'query', 'hidden', 'unmount']) it('PC late coupon acknowledgement cannot repopulate content after ' + ending, async () => {
    const wait = gate(), f = await mount(c => c.url === '/coupon/receive' ? wait.promise : undefined);
    try { const operation = f.view.claim(100); await flush();
      if (ending === 'identity') context().authUtils.setAuth('new-content-owner', 22);
      else if (ending === 'same-token-generation') context().authUtils.setAuth(context().authUtils.getToken(), 11);
      else if (ending === 'route') await f.router.push('/away');
      else if (ending === 'query') await f.router.push('/goods/70?sku=blue001');
      else if (ending === 'hidden') { f.doc.visibilityState = 'hidden'; f.listeners.get('visibilitychange')(); }
      else f.close();
      await flush(); const stateBefore = { notice: f.view.state.notice, actionError: f.view.state.actionError, items: f.view.state.items.map(item => item.id), description: f.view.state.description };
      wait.resolve({ status: 200, data: { couponUserId: 900 } }); await operation; await flush();
      assert.deepEqual({ notice: f.view.state.notice, actionError: f.view.state.actionError, items: f.view.state.items.map(item => item.id), description: f.view.state.description }, stateBefore);
      assert.equal(posts(f).length, 1); assert.equal(f.view.state.notice.includes('领取已确认'), false);
    } finally { wait.resolve({ status: 503 }); f.close(); }
  });
  it('PC hidden content is cleared and resume uses only read-only content, recommendation and coupon paths', async () => {
    const f = await mount(); try { f.doc.visibilityState = 'hidden'; f.listeners.get('visibilitychange')(); assert.equal(f.view.state.description, ''); assert.equal(f.view.state.recommendations.length, 0); assert.equal(f.view.state.items.length, 0);
      f.doc.visibilityState = 'visible'; f.listeners.get('visibilitychange')(); await flush(); assert.match(f.view.state.description, /重新读取/); assert.equal(f.view.state.recommendations[0].id, 81); assert.equal(f.view.state.items.length, 10);
      assert.equal(f.calls.some(c => /^\/product\/detail\/\d+$/.test(c.url)), false); assert.equal(posts(f).length, 0);
    } finally { f.close(); }
  });
  it('PC product changes reject an old directory response and keep the new product identity', async () => {
    const wait = gate(), f = await mount(c => c.url === '/product/detail/70/coupons' ? wait.promise : undefined);
    try { f.props.productId = 71; await flush(); assert.equal(f.view.state.page.productId, 71); wait.resolve({ status: 200, data: page(70) }); await flush(); assert.equal(f.view.state.page.productId, 71); }
    finally { wait.resolve({ status: 503 }); f.close(); }
  });
  it('PC failed description images are replaced in the actual SFC and only an explicit refresh creates a new image attempt', async () => {
    const f = await mount(); try {
      const image = { tagName: 'IMG', getAttribute: () => 'https://cdn.example.test/body.png' };
      f.view.descriptionBody.value = { contains: value => value === image };
      f.view.imageFailed({ target: { ...image } }); assert.equal(f.view.failedImages.value.length, 0);
      f.view.imageFailed({ target: image }); assert.equal(f.view.failedImages.value.length, 1); assert.match(f.view.descriptionHtml.value, /图片暂不可用/); assert.doesNotMatch(f.view.descriptionHtml.value, /<img/);
      const before = f.calls.length; await flush(); assert.equal(f.calls.length, before); await f.view.refreshDescription(); await flush(); assert.equal(f.view.failedImages.value.length, 0); assert.match(f.view.descriptionHtml.value, /body-new/);
    } finally { f.close(); }
  });
  it('PC description and recommendation normalization strips active HTML and invalid media, and rejects duplicate recommendation identities', async () => {
    const f = await mount(); try { const safe = f.dto.normalizeProductDescription('<p onclick="attack()">介绍</p><script>attack()</script><img src="javascript:attack()"><iframe src="https://evil.test"></iframe>');
      assert.doesNotMatch(safe, /onclick|<script|javascript:|<iframe/); assert.match(safe, /介绍/);
      assert.equal(f.dto.normalizeDetailRecommendations([card(80), { ...card(81), image: 'data:image/png;base64,AA' }])[1].image, '');
      assert.throws(() => f.dto.normalizeDetailRecommendations([card(80), card(80)]), /重复/);
      assert.throws(() => f.dto.normalizeDetailRecommendations(Array.from({ length: 25 }, (_, i) => card(80 + i))), /无效/);
    } finally { f.close(); }
  });
  it('PC anonymous coupons offer an exact login return and never issue a claim before login', async () => {
    const f = await mount(() => undefined, { anonymous: true, path: '/goods/70?sku=red001' });
    try { assert.equal(f.view.state.page.uid, 0); assert.equal(f.view.loginPath.value, '/login?redirect=%2Fgoods%2F70%3Fsku%3Dred001'); await f.view.claim(100); assert.equal(posts(f).length, 0); }
    finally { f.close(); }
  });
  it('PC actual template renders scope, discount, validity, canonical recommendations, full directory controls and explicit uncertainty recovery', async () => {
    const f = await mount(c => c.url === '/coupon/receive' ? { status: 503, msg: '未知结果' } : undefined);
    try { await f.view.claim(100); await f.view.check(100);
      const source = parse(await readFile(new URL('../src/components/ProductDetailContent.vue', import.meta.url), 'utf8')).descriptor.template.content;
      const render = Vue.compile(source, { mode: 'function', prefixIdentifiers: true }); const ctx = proxyRefs(f.view);
      const app = createSSRApp({ render() { return render(ctx, []); } }); app.config.warnHandler = () => {};
      app.component('RouterLink', { props: ['to'], render() { return h('a', { href: this.to }, this.$slots.default?.()); } });
      app.component('ProductImage', { props: ['src', 'alt'], render() { return h('img', { src: this.src, alt: this.alt }); } });
      const html = await renderToString(app);
      for (const label of ['通用券', '品类券', '商品券', '品牌券', '8.5 折', '领取后 7 天内可用', '会员专享', '加载更多优惠券', '核对领取状态', '已核对，结束本次操作', '/goods/80', '/user/coupon', '商品详情', '真实商品正文']) assert.ok(html.includes(label), label);
      assert.equal(f.view.reason('仅付费会员可领取'), '仅付费会员可领取');
      assert.equal(posts(f).length, 1);
    } finally { f.close(); }
  });
}
