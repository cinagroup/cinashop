import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse, compileScript } from '@vue/compiler-sfc';
import { createRenderer, h, nextTick } from 'vue';
import { createRouter, createMemoryHistory, RouterView } from 'vue-router';

const moduleId = '/src/pages/activity/PresaleDetail.test-script.ts';
export function presaleComponentPlugin(root) {
  const resolved = `${root.replaceAll('\\', '/').replace(/\/$/, '')}${moduleId}`;
  return { name: 'actual-presale-setup', resolveId(id) { if (id === moduleId) return resolved; }, async load(id) {
    if (id.replaceAll('\\', '/') !== resolved) return;
    const filename = `${root}/src/pages/activity/PresaleDetail.vue`;
    return compileScript(parse(await readFile(filename, 'utf8'), { filename }).descriptor, { id: 'actual-presale' }).content;
  } };
}
const renderer = createRenderer({
  createElement: () => ({ children: [] }), createText: text => ({ text }), createComment: text => ({ text }),
  insert(node, parent) { node.parent = parent; (parent.children ??= []).push(node); },
  remove(node) { if (node.parent) node.parent.children = node.parent.children.filter(item => item !== node); },
  parentNode: node => node.parent, nextSibling: () => null, patchProp() {}, setText() {}, setElementText() {},
});
const flush = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); await nextTick(); } };
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
export function presaleFixture(id = 70, stamp = Math.floor(Date.now() / 1000)) {
  return { version: 1, selection_only: true, type: 6, payment_mode: 'full', product_id: id,
    title: '本地预售 <script>literal</script>', subtitle: '全款预售', image: '', images: [], sales: 3, unit_name: '件', product_type: 0, system_form_id: 0,
    purchase_limits: { mode: 'per_order', quantity: 3 }, schedule: { timezone: 'Asia/Shanghai', state: 'active', presale_pay_status: 2,
      start_time: stamp - 60, stop_time: stamp + 600, starts_at: new Date((stamp - 60) * 1000).toISOString(),
      ends_at: new Date((stamp + 601) * 1000).toISOString(), shipping_days_after_end: 7 }, skus: [
      { unique: 'pres0001', base_unique: 'pres0001', suk: '红色', stock: 7, max_quantity: 3, catalog_price: '80.25', ot_price: '100.00', image: '' },
      { unique: 'pres0002', base_unique: 'pres0002', suk: '蓝色', stock: 2, max_quantity: 2, catalog_price: '90.50', ot_price: '120.00', image: '' },
    ] };
}
export function registerPresalePurchaseTests(getContext) {
  async function mount({ entry = '/presale/70', read = config => ({ status: 200, data: presaleFixture(Number(config.url.split('/').at(-1))) }),
    add = () => ({ status: 200, data: { id: 91, cartNum: 2 } }) } = {}) {
    const { server, api, location, response } = getContext(), calls = [], reads = [];
    const component = (await server.ssrLoadModule(moduleId)).default; let view;
    const page = { setup(props, ctx) { view = component.setup(props, ctx); return () => null; } };
    const router = createRouter({ history: createMemoryHistory(), routes: [
      { path: '/presale/:id', name: 'presale-detail', component: page },
      ...['login', 'checkout', 'elsewhere'].map(name => ({ path: `/${name}`, component: { render: () => null } })),
    ] });
    const originalLocation = { pathname: location.pathname, search: location.search, hash: location.hash };
    const unbind = router.afterEach(to => { const url = new URL(to.fullPath, location.origin); Object.assign(location, { pathname: url.pathname, search: url.search, hash: url.hash }); });
    api.defaults.adapter = async config => {
      if (config.url.startsWith('/product/detail/')) { reads.push({ url: config.url, params: structuredClone(config.params) }); return response(config, await read(config)); }
      assert.equal(config.url, '/cart/add'); calls.push(JSON.parse(config.data)); return response(config, await add(config));
    };
    const app = renderer.createApp({ render: () => h(RouterView) }); app.use(router);
    await router.push(entry); app.mount({ children: [] }); await flush();
    return { router, calls, reads, get view() { return view; }, close() { app.unmount(); unbind(); Object.assign(location, originalLocation); } };
  }
  it('presale uses the real base SKU, type6 direct purchase and checkout identity, with no quote/payment from detail', async () => {
    const f = await mount(); try {
      assert.deepEqual(f.reads, [{ url: '/product/detail/70', params: { view: 'presale' } }]);
      assert.equal(f.view.canBuy.value, false); await f.view.buy(); assert.equal(f.calls.length, 0);
      f.view.choose('pres0002'); f.view.quantity.value = 2; await f.view.buy();
      assert.deepEqual(f.calls, [{ productId: 70, activityId: 0, type: 6, unique: 'pres0002', cartNum: 2, new: 1 }]);
      assert.equal(f.router.currentRoute.value.path, '/checkout');
      assert.deepEqual({ ...f.router.currentRoute.value.query }, { mode: 'buy', cartId: '91', type: '6' });
    } finally { f.close(); }
  });
  it('presale shared parser rejects legacy/ambiguous schedules, identities and limit contracts', async () => {
    const { server } = getContext(), { parsePresaleSelection, presaleProductId } = await server.ssrLoadModule('../common/presalePurchase.ts');
    const mutations = [r => { delete r.purchase_limits; }, r => { r.type = 0; }, r => { r.version = 2; }, r => { r.payment_mode = 'deposit'; },
      r => { r.product_id = 71; }, r => { r.selection_only = false; }, r => { r.skus[0].base_unique = 'wrong006'; },
      r => { r.skus[1].unique = 'pres0001'; }, r => { r.skus[0].max_quantity = 4; }, r => { r.skus[0].catalog_price = 80.25; },
      r => { r.purchase_limits.quantity = 0; }, r => { r.purchase_limits.mode = 'unknown'; },
      r => { r.purchase_limits.mode = 'none'; }, r => { r.purchase_limits.mode = 'cumulative'; },
      r => { r.schedule.ends_at = new Date(r.schedule.stop_time * 1000).toISOString(); }, r => { r.schedule.presale_pay_status = 3; },
      r => { r.schedule.timezone = 'UTC'; }, r => { r.skus = Array(501).fill(r.skus[0]); }, r => { r.images = Array(21).fill('/img.svg'); }];
    for (const mutate of mutations) { const row = presaleFixture(); mutate(row); assert.throws(() => parsePresaleSelection(row, 70)); }
    for (const id of [70, '0', '01', ' 70', '70x', '2147483648', undefined]) assert.throws(() => presaleProductId(id));
  });
  it('presale includes the entire final second, rejects stale active flags and requires refresh after a future snapshot', async () => {
    const { server } = getContext(), { parsePresaleSelection, presaleOpen, presaleCartInput } = await server.ssrLoadModule('../common/presalePurchase.ts');
    const row = presaleFixture(70, 1000), data = parsePresaleSelection(row, 70);
    assert.equal(presaleOpen(data, 940000), true); assert.equal(presaleOpen(data, 1600999), true);
    for (const now of [939999, 1601000, NaN]) { assert.equal(presaleOpen(data, now), false); assert.throws(() => presaleCartInput(data, 'pres0001', 1, now)); }
    row.schedule.state = 'future'; row.schedule.presale_pay_status = 1;
    assert.equal(presaleOpen(parsePresaleSelection(row, 70), 1000000), false);
  });
  it('presale cannot buy invalid quantities, unselected SKUs, ended or cumulative-mode products', async () => {
    const f = await mount(); try {
      f.view.choose('pres0001');
      for (const count of ['', '2', 0, -1, 1.5, 4, Infinity, NaN]) { f.view.quantity.value = count; assert.equal(f.view.canBuy.value, false); await f.view.buy(); }
      assert.equal(f.calls.length, 0);
    } finally { f.close(); }
    for (const mode of ['ended', 'cumulative', 'empty']) {
      const f = await mount({ read: () => { const row = presaleFixture();
        if (mode === 'ended') { row.schedule.state = 'ended'; row.schedule.presale_pay_status = 3; }
        if (mode === 'cumulative') { row.purchase_limits.mode = 'cumulative'; row.skus.forEach(sku => sku.max_quantity = 0); }
        if (mode === 'empty') row.skus = [];
        return { status: 200, data: row };
      } }); try { f.view.choose('pres0001'); await f.view.buy(); assert.equal(f.view.canBuy.value, false); assert.equal(f.calls.length, 0); }
      finally { f.close(); }
    }
  });
  for (const expired of [false, true]) it(`presale ${expired ? 'expired' : 'anonymous'} login returns only the selected SKU/quantity intent`, async () => {
    const { authUtils, navigation, location } = getContext(); if (!expired) authUtils.clearAuth();
    const f = await mount({ add: () => ({ status: 410002, msg: 'Synthetic expired session' }) }); try {
      f.view.choose('pres0002'); f.view.quantity.value = 2; await f.view.buy();
      assert.equal(f.calls.length, expired ? 1 : 0);
      const redirect = expired ? new URL(navigation.at(-1), location.origin).searchParams.get('redirect') : f.router.currentRoute.value.query.redirect;
      assert.equal(redirect, '/presale/70?sku=pres0002&quantity=2');
      await f.router.push('/login'); authUtils.setAuth('presale-renewed', 11); await f.router.push(redirect); await flush();
      assert.equal(f.view.selected.value, 'pres0002'); assert.equal(f.view.quantity.value, 2); assert.equal(f.view.prepared.value, null);
    } finally { f.close(); }
  });
  it('presale restored quantity is not silently shrunk to a newer limit', async () => {
    const f = await mount({ entry: '/presale/70?sku=pres0001&quantity=4' }); try {
      assert.equal(f.view.quantity.value, 4); assert.equal(f.view.canBuy.value, false); assert.ok(f.view.error.value);
      await f.view.buy(); assert.equal(f.calls.length, 0);
    } finally { f.close(); }
  });
  it('presale repeats only checkout navigation after a known cart response, including beyond the selection deadline', async () => {
    const f = await mount(); const unbind = f.router.beforeEach(to => to.path === '/checkout' ? false : undefined);
    try {
      f.view.choose('pres0001'); await f.view.buy(); assert.equal(f.view.prepared.value, 91); assert.ok(f.view.error.value);
      f.view.clock.value = Date.now() + 900000; assert.equal(f.view.open.value, false); assert.equal(f.view.canBuy.value, true);
      await f.view.load(); f.view.choose('pres0002'); assert.equal(f.view.selected.value, 'pres0001');
      unbind(); await f.view.buy(); assert.equal(f.calls.length, 1); assert.equal(f.router.currentRoute.value.path, '/checkout');
    } finally { unbind(); f.close(); }
  });
  it('presale serializes clicks and rechecks time after an asynchronous intent-route guard', async () => {
    const waiting = gate(); const f = await mount();
    const unbind = f.router.beforeEach(to => to.path === '/presale/70' && to.query.sku ? waiting.promise : undefined);
    const original = Date.now;
    try {
      f.view.choose('pres0001'); const buy = f.view.buy(); await flush(); await f.view.buy(); assert.equal(f.calls.length, 0);
      const cutoff = (f.view.detail.value.schedule.stop_time + 1) * 1000;
      Date.now = () => cutoff;
      waiting.release(); await buy; assert.equal(f.calls.length, 0); assert.equal(f.view.detail.value, null); assert.ok(f.view.error.value);
    } finally { Date.now = original; unbind(); f.close(); }
  });
  for (const boundary of ['route', 'account']) it(`presale ignores late cart results across ${boundary} replacement`, async () => {
    const pending = gate(), { authUtils } = getContext(); const f = await mount({ add: () => pending.promise });
    try {
      f.view.choose('pres0001'); const work = f.view.buy(); await flush(); assert.equal(f.calls.length, 1);
      if (boundary === 'route') await f.router.push('/presale/71'); else authUtils.setAuth('presale-new-account', 22);
      await flush(); f.view.choose('pres0002');
      pending.release({ status: 200, data: { id: 91 } }); await work;
      assert.equal(f.view.prepared.value, null); assert.notEqual(f.router.currentRoute.value.path, '/checkout'); assert.equal(f.view.selected.value, 'pres0002');
    } finally { f.close(); }
  });
  it('presale newest route read wins and malformed cart responses require a fresh selection', async () => {
    const pending = gate(); let delayed = false;
    const f = await mount({ read: c => delayed && c.url.endsWith('/70') ? pending.promise : { status: 200, data: presaleFixture(Number(c.url.split('/').at(-1))) },
      add: () => ({ status: 200, data: { id: 0 } }) });
    try {
      delayed = true; const work = f.view.load(); await flush(); await f.router.push('/presale/71'); await flush();
      pending.release({ status: 200, data: presaleFixture(70) }); await work; assert.equal(f.view.detail.value.product_id, 71);
      f.view.choose('pres0001'); await f.view.buy(); assert.equal(f.view.detail.value, null); assert.ok(f.view.error.value);
      await f.view.buy(); assert.equal(f.calls.length, 1);
    } finally { f.close(); }
  });
}
