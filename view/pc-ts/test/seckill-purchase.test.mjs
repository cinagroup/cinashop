import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse, compileScript } from '@vue/compiler-sfc';
import { createRenderer, h, nextTick } from 'vue';
import { createRouter, createMemoryHistory, RouterView } from 'vue-router';

// Compile the real SFC setup with its real imports. Only the template is omitted:
// the custom renderer mounts/unmounts its lifecycle without a browser or API listener.
const moduleId = '/src/pages/activity/SeckillDetail.test-script.ts';
export function seckillComponentPlugin(root) {
  const resolved = `${root.replaceAll('\\', '/').replace(/\/$/, '')}${moduleId}`;
  return { name: 'test-actual-seckill-setup', resolveId(id) { if (id === moduleId) return resolved; }, async load(id) {
    if (id.replaceAll('\\', '/') !== resolved) return;
    const filename = `${root}/src/pages/activity/SeckillDetail.vue`;
    const { descriptor } = parse(await readFile(filename, 'utf8'), { filename });
    return compileScript(descriptor, { id: 'actual-seckill-setup' }).content;
  } };
}
const renderer = createRenderer({
  createElement: () => ({ children: [] }), createText: text => ({ text }), createComment: text => ({ text }),
  insert(node, parent) { node.parent = parent; (parent.children ??= []).push(node); },
  remove(node) { if (node.parent) node.parent.children = node.parent.children.filter(item => item !== node); },
  parentNode: node => node.parent, nextSibling: () => null, patchProp() {},
  setText(node, text) { node.text = text; }, setElementText(node, text) { node.text = text; },
});
const flush = async () => { for (let index = 0; index < 15; index++) { await Promise.resolve(); await nextTick(); } };
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
const detail = () => ({ selection_only: true, type: 1, seckill_id: 20, product_id: 70, title: 'Isolated seckill', image: '', once_limit: 3, total_limit: 6,
  skus: [{ unique: 'actred20', base_unique: 'qared001', suk: 'Red', stock: 3, max_quantity: 3, catalog_price: '6.25', ot_price: '10.00', image: '' },
    { unique: 'actblu20', base_unique: 'qablue01', suk: 'Blue', stock: 2, max_quantity: 2, catalog_price: '8.75', ot_price: '20.00', image: '' }],
  schedule: { timezone: 'Asia/Shanghai', state: 'active', message: 'Active fixture', starts_at: new Date(Date.now() - 60000).toISOString(), ends_at: new Date(Date.now() + 600000).toISOString() },
});
const oldPath = '/seckill/20?sku=actred20&quantity=1';
const selectedPath = '/seckill/20?sku=actblu20&quantity=2';

export function registerSeckillPurchaseTests(getContext) {
  async function mount({ expired = false } = {}) {
    const { server, api, location, response } = getContext(), calls = [];
    const originalLocation = { pathname: location.pathname, search: location.search, hash: location.hash };
    const component = (await server.ssrLoadModule(moduleId)).default;
    let view;
    const selection = { setup(props, context) { view = component.setup(props, context); return () => null; } };
    const router = createRouter({ history: createMemoryHistory(), routes: [
      { path: '/seckill/:id', component: selection }, { path: '/login', component: { render: () => null } },
      { path: '/checkout', component: { render: () => null } }, { path: '/elsewhere', component: { render: () => null } },
    ] });
    const unbindLocation = router.afterEach(to => { const url = new URL(to.fullPath, location.origin); Object.assign(location, { pathname: url.pathname, search: url.search, hash: url.hash }); });
    api.defaults.adapter = async config => {
      if (config.url.startsWith('/seckill/detail/')) return response(config, { status: 200, data: detail() });
      assert.equal(config.url, '/cart/add'); calls.push(JSON.parse(config.data));
      return response(config, expired ? { status: 410002, msg: 'isolated expiry' } : { status: 200, data: { id: 91, cartNum: 2 } });
    };
    const app = renderer.createApp({ render: () => h(RouterView) }); app.use(router);
    let mounted = false;
    const close = () => { if (mounted) { app.unmount(); mounted = false; } unbindLocation(); Object.assign(location, originalLocation); };
    try {
      await router.push(oldPath); app.mount({ children: [] }); mounted = true; await flush();
      assert.equal(view.selected.value, 'actred20');
      view.choose('actblu20'); view.quantity.value = 2;
      return { router, calls, get view() { return view; }, close };
    } catch (error) { close(); throw error; }
  }
  it('seckill expiry returns to the latest validated SKU/quantity, not stale deep-link values', async () => {
    const { authUtils, location, navigation } = getContext(), f = await mount({ expired: true });
    try {
      await f.view.buy();
      assert.equal(f.calls.length, 1); assert.equal(f.calls[0].unique, 'actblu20'); assert.equal(f.calls[0].cartNum, 2);
      const redirect = new URL(navigation.at(-1), location.origin).searchParams.get('redirect');
      assert.equal(redirect, selectedPath);
      await f.router.push('/login'); authUtils.setAuth('renewed-session', 11);
      await f.router.push(redirect); await flush();
      assert.equal(f.view.selected.value, 'actblu20'); assert.equal(f.view.quantity.value, 2);
    } finally { f.close(); }
  });
  it('seckill anonymous login retains the actual selection and blocks duplicate clicks while replacing the URL', async () => {
    const { authUtils } = getContext(); authUtils.clearAuth();
    const f = await mount(), waiting = gate(), started = gate();
    const unbind = f.router.beforeEach(async to => { if (to.fullPath === selectedPath) { started.release(); await waiting.promise; } });
    try {
      const buying = f.view.buy(); await started.promise;
      assert.equal(f.view.buying.value, true); await f.view.buy(); assert.equal(f.calls.length, 0);
      waiting.release(); await buying;
      assert.equal(f.router.currentRoute.value.path, '/login');
      assert.equal(f.router.currentRoute.value.query.redirect, selectedPath); assert.equal(f.calls.length, 0);
    } finally { waiting.release(); unbind(); f.close(); }
  });
  for (const mutation of ['identity', 'route', 'query-only-route', 'refresh', 'cancelled-navigation', 'unmount']) {
    it(`seckill does not write after ${mutation} changes during pending intent navigation`, async () => {
      const { authUtils } = getContext(), f = await mount(), waiting = gate(), started = gate();
      const unbind = f.router.beforeEach(async to => {
        if (to.fullPath !== selectedPath) return;
        started.release(); await waiting.promise;
        if (mutation === 'cancelled-navigation') return false;
      });
      let closed = false;
      try {
        const buying = f.view.buy(); await started.promise;
        if (mutation === 'identity') authUtils.setAuth('replacement-session', 22);
        if (mutation === 'route') await f.router.push('/elsewhere');
        if (mutation === 'query-only-route') await f.router.push('/seckill/20?sku=actred20&quantity=2');
        if (mutation === 'refresh') await f.view.load();
        if (mutation === 'unmount') { f.close(); closed = true; }
        waiting.release(); await buying; await flush();
        assert.equal(f.calls.length, 0);
        assert.notEqual(f.router.currentRoute.value.path, '/checkout');
      } finally { waiting.release(); unbind(); if (!closed) f.close(); }
    });
  }
  it('seckill rechecks the activity deadline after intent navigation and never sends the expired write', async () => {
    const f = await mount(), waiting = gate(), started = gate();
    const unbind = f.router.beforeEach(async to => { if (to.fullPath === selectedPath) { started.release(); await waiting.promise; } });
    try {
      const buying = f.view.buy(); await started.promise;
      f.view.detail.value.schedule.ends_at = new Date(Date.now() - 1).toISOString();
      waiting.release(); await buying;
      assert.equal(f.calls.length, 0); assert.match(f.view.error.value, /不可购买/);
    } finally { waiting.release(); unbind(); f.close(); }
  });
  it('seckill current-token purchase updates the return URL once, rejects duplicate clicks and preserves checkout identity', async () => {
    const f = await mount(), waiting = gate(), started = gate();
    const unbind = f.router.beforeEach(async to => { if (to.fullPath === selectedPath) { started.release(); await waiting.promise; } });
    try {
      const buying = f.view.buy(); await started.promise; await f.view.buy(); waiting.release(); await buying;
      assert.deepEqual(f.calls, [{ productId: 70, activityId: 20, type: 1, unique: 'actblu20', cartNum: 2, new: 1 }]);
      assert.equal(f.router.currentRoute.value.path, '/checkout');
      assert.deepEqual({ ...f.router.currentRoute.value.query }, { mode: 'buy', cartId: '91', type: '1', seckillId: '20' });
    } finally { waiting.release(); unbind(); f.close(); }
  });
  it('seckill does not let a late cart response navigate a changed same-activity URL to the old checkout', async () => {
    const { api, response } = getContext(), f = await mount(), waiting = gate(), started = gate();
    api.defaults.adapter = async config => {
      assert.equal(config.url, '/cart/add'); started.release(); await waiting.promise;
      return response(config, { status: 200, data: { id: 91, cartNum: 2 } });
    };
    try {
      const buying = f.view.buy(); await started.promise;
      await f.router.push('/seckill/20?sku=actred20&quantity=2');
      waiting.release(); await buying;
      assert.equal(f.router.currentRoute.value.fullPath, '/seckill/20?sku=actred20&quantity=2');
      assert.equal(f.view.error.value, '');
    } finally { waiting.release(); f.close(); }
  });
}
