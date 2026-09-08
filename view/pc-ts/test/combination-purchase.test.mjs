import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse, compileScript } from '@vue/compiler-sfc';
import { createRenderer, h, nextTick } from 'vue';
import { createRouter, createMemoryHistory, RouterView } from 'vue-router';

// Execute the actual SFC setup, Vue Router lifecycle, Axios adapter and parsers.
// Only native DOM rendering and remote transport are replaced; no HTTP listener.
const moduleId = '/src/pages/activity/CombinationDetail.test-script.ts';
export function combinationComponentPlugin(root) {
  const resolved = `${root.replaceAll('\\', '/').replace(/\/$/, '')}${moduleId}`;
  return { name: 'test-actual-combination-setup', resolveId(id) { if (id === moduleId) return resolved; }, async load(id) {
    if (id.replaceAll('\\', '/') !== resolved) return;
    const filename = `${root}/src/pages/activity/CombinationDetail.vue`;
    const { descriptor } = parse(await readFile(filename, 'utf8'), { filename });
    return compileScript(descriptor, { id: 'actual-combination-setup' }).content;
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
const oldPath = '/combination/20?sku=actred20&quantity=1';
function detail(config = { url: '/combination/detail/20', params: {} }) {
  const id = Number(config.url.split('/').at(-1)), leader = id === 20 ? 300 : 301;
  const group = { id: leader, combination_id: id, required_people: 3, active_people: 1, reserved_people: 1,
    available_places: 1, already_joined: false, has_pending_order: false, stop_time: new Date(Date.now() + 600_000).toISOString() };
  return { selection_only: true, type: 3, combination_id: id, product_id: id === 20 ? 70 : 71,
    title: `Isolated activity ${id}`, image: '', people: 3, once_limit: 3, total_limit: 6,
    start_time: new Date(Date.now() - 60_000).toISOString(), stop_time: new Date(Date.now() + 600_000).toISOString(), date_window: 'active',
    skus: [
      { unique: `actred${id}`, base_unique: 'qared001', suk: 'Red', stock: 3, max_quantity: 3, catalog_price: '6.25', ot_price: '10.00', image: '' },
      { unique: `actblu${id}`, base_unique: 'qablue01', suk: 'Blue', stock: 2, max_quantity: 2, catalog_price: '8.75', ot_price: '20.00', image: '' },
    ], groups: [group], requested_group: config.params?.pink_id === leader ? structuredClone(group) : null,
  };
}
const chooseBlue = (f, pinkId = 0) => { f.view.choose('actblu20'); f.view.chooseGroup(pinkId); f.view.quantity.value = 2; };
const chosenRoute = (to, pinkId = 300) => to.path === '/combination/20' && to.query.sku === 'actblu20' && to.query.quantity === '2'
  && (pinkId ? to.query.pinkId === String(pinkId) : !to.query.pinkId || to.query.pinkId === '0');
const checkoutQuery = (pinkId = 0, activityId = 20) => ({ mode: 'buy', cartId: '91', type: '3', combinationId: String(activityId), ...(pinkId ? { pinkId: String(pinkId) } : {}) });

export function registerCombinationPurchaseTests(getContext) {
  async function mount({ entry = oldPath, read = config => ({ status: 200, data: detail(config) }),
    add = () => ({ status: 200, data: { id: 91, cartNum: 2 } }) } = {}) {
    const { server, api, location, response } = getContext(), calls = [], reads = [];
    const originalLocation = { pathname: location.pathname, search: location.search, hash: location.hash };
    const component = (await server.ssrLoadModule(moduleId)).default;
    let view;
    const selection = { setup(props, context) { view = component.setup(props, context); return () => null; } };
    const router = createRouter({ history: createMemoryHistory(), routes: [
      { path: '/combination/:id', component: selection }, { path: '/login', component: { render: () => null } },
      { path: '/checkout', component: { render: () => null } }, { path: '/elsewhere', component: { render: () => null } },
    ] });
    const unbindLocation = router.afterEach(to => {
      const url = new URL(to.fullPath, location.origin);
      Object.assign(location, { pathname: url.pathname, search: url.search, hash: url.hash });
    });
    api.defaults.adapter = async config => {
      if (config.url.startsWith('/combination/detail/')) {
        reads.push({ url: config.url, params: structuredClone(config.params) });
        return response(config, await read(config));
      }
      assert.equal(config.url, '/cart/add'); calls.push(JSON.parse(config.data));
      return response(config, await add(config));
    };
    const app = renderer.createApp({ render: () => h(RouterView) }); app.use(router);
    let mounted = false;
    const close = () => {
      if (mounted) { app.unmount(); mounted = false; }
      unbindLocation(); Object.assign(location, originalLocation);
    };
    try {
      await router.push(entry); app.mount({ children: [] }); mounted = true; await flush();
      return { router, calls, reads, get view() { return view; }, close };
    } catch (error) { close(); throw error; }
  }

  for (const pinkId of [0, 300]) {
    it(`combination ${pinkId ? 'join' : 'start'} submits the real activity SKU and preserves product/activity/leader identities`, async () => {
      const f = await mount(); try {
        assert.deepEqual(f.reads, [{ url: '/combination/detail/20', params: { view: 'skus' } }]);
        assert.equal(f.view.detail.value.product_id, 70); chooseBlue(f, pinkId);
        await f.view.buy();
        assert.deepEqual(f.calls, [{ productId: 70, activityId: 20, type: 3, unique: 'actblu20', cartNum: 2, new: 1 }]);
        assert.equal(f.router.currentRoute.value.path, '/checkout');
        assert.deepEqual({ ...f.router.currentRoute.value.query }, checkoutQuery(pinkId));
      } finally { f.close(); }
    });
  }

  it('combination token expiry restores the latest SKU, quantity and requested leader through the actual login return', async () => {
    const { authUtils, navigation, location } = getContext();
    const f = await mount({ add: () => ({ status: 410002, msg: 'Isolated token expiry' }) }); try {
      chooseBlue(f, 300); await f.view.buy(); assert.equal(f.calls.length, 1);
      const redirect = new URL(navigation.at(-1), location.origin).searchParams.get('redirect');
      const selected = new URL(redirect, location.origin);
      assert.equal(selected.pathname, '/combination/20'); assert.equal(selected.searchParams.get('sku'), 'actblu20');
      assert.equal(selected.searchParams.get('quantity'), '2'); assert.equal(selected.searchParams.get('pinkId'), '300');
      await f.router.push('/login'); authUtils.setAuth('renewed-combination-session', 11);
      await f.router.push(redirect); await flush();
      assert.equal(f.view.selected.value, 'actblu20'); assert.equal(f.view.quantity.value, 2); assert.equal(f.view.selectedGroup.value, 300);
      assert.deepEqual(f.reads.at(-1), { url: '/combination/detail/20', params: { view: 'skus', pink_id: 300 } });
    } finally { f.close(); }
  });

  it('combination anonymous login preserves the chosen group instead of posting an unauthenticated cart', async () => {
    const { authUtils } = getContext(); authUtils.clearAuth(); const f = await mount(); try {
      chooseBlue(f, 300); await f.view.buy(); assert.equal(f.calls.length, 0);
      assert.equal(f.router.currentRoute.value.path, '/login');
      const redirect = f.router.currentRoute.value.query.redirect;
      assert.equal(new URL(redirect, 'https://fixture.test').searchParams.get('pinkId'), '300');
      authUtils.setAuth('new-combination-login', 11); await f.router.push(redirect); await flush();
      assert.equal(f.view.selectedGroup.value, 300); assert.equal(f.view.selected.value, 'actblu20'); assert.equal(f.view.quantity.value, 2);
    } finally { f.close(); }
  });

  it('an unavailable requested leader never silently becomes a new group after login', async () => {
    let missing = false; const { authUtils } = getContext(); authUtils.clearAuth();
    const f = await mount({ read: config => ({ status: 200, data: { ...detail(config), ...(missing ? { requested_group: null, groups: [] } : {}) } }) }); try {
      chooseBlue(f, 300); await f.view.buy(); const redirect = f.router.currentRoute.value.query.redirect;
      missing = true; authUtils.setAuth('new-combination-login', 11); await f.router.push(redirect); await flush();
      assert.equal(f.view.detail.value, null); assert.ok(f.view.error.value); await f.view.buy();
      assert.equal(f.calls.length, 0); assert.notEqual(f.router.currentRoute.value.path, '/checkout');
    } finally { f.close(); }
  });

  it('explicitly discards an unavailable requested leader, re-reads and requires a fresh SKU selection', async () => {
    const f = await mount({ entry: '/combination/20?sku=actblu20&quantity=2&pinkId=999', read: config =>
      config.params.pink_id ? { status: 400, msg: '指定拼团不存在' } : { status: 200, data: detail(config) } });
    try {
      assert.equal(f.view.detail.value, null); assert.equal(f.view.selectedGroup.value, 999);
      assert.equal(f.view.canBuy.value, false); assert.equal(f.calls.length, 0);
      await f.view.discardGroup(); await flush();
      assert.equal(f.view.selectedGroup.value, 0); assert.equal(f.view.detail.value.combination_id, 20);
      assert.equal(f.view.selected.value, ''); assert.equal(f.view.canBuy.value, false);
      assert.deepEqual(f.reads.at(-1).params, { view: 'skus' });
      chooseBlue(f); await f.view.buy();
      assert.equal(f.calls.length, 1); assert.deepEqual({ ...f.router.currentRoute.value.query }, checkoutQuery());
    } finally { f.close(); }
  });

  it('a requested quantity that now exceeds the activity SKU cap remains blocked rather than reduced', async () => {
    const f = await mount({ entry: '/combination/20?sku=actblu20&quantity=2&pinkId=300', read: config => {
      const row = detail(config); row.skus[1].max_quantity = 1; return { status: 200, data: row };
    } }); try {
      assert.equal(f.view.selected.value, 'actblu20'); assert.equal(f.view.quantity.value, 2); assert.equal(f.view.selectedGroup.value, 300);
      await f.view.buy(); assert.equal(f.calls.length, 0); assert.ok(f.view.error.value);
    } finally { f.close(); }
  });

  it('reused combination routes reload their activity and ignore an older detail response', async () => {
    const waiting = gate(); let delayed = false;
    const f = await mount({ read: config => delayed && config.url.endsWith('/20') ? waiting.promise : { status: 200, data: detail(config) } }); try {
      delayed = true; const oldRead = f.view.load(); await flush();
      assert.equal(f.reads.length, 2); await f.router.push('/combination/21'); await flush();
      assert.equal(f.view.detail.value.combination_id, 21); assert.equal(f.view.detail.value.product_id, 71);
      waiting.release({ status: 200, data: detail() }); await oldRead; await flush();
      assert.equal(f.view.detail.value.combination_id, 21);
      f.view.choose('actblu21'); f.view.quantity.value = 2; f.view.chooseGroup(301); await f.view.buy();
      assert.deepEqual(f.calls, [{ productId: 71, activityId: 21, type: 3, unique: 'actblu21', cartNum: 2, new: 1 }]);
      assert.deepEqual({ ...f.router.currentRoute.value.query }, checkoutQuery(301, 21));
    } finally { waiting.release({ status: 200, data: detail() }); f.close(); }
  });

  for (const mutation of ['identity', 'route', 'query-only-route', 'refresh', 'cancelled-navigation', 'unmount']) {
    it(`combination does not write after ${mutation} changes while purchase-intent navigation waits`, async () => {
      const { authUtils } = getContext(), f = await mount(), waiting = gate(), started = gate(); chooseBlue(f, 300);
      const unbind = f.router.beforeEach(async to => {
        if (!chosenRoute(to)) return; started.release(); await waiting.promise;
        if (mutation === 'cancelled-navigation') return false;
      });
      let closed = false;
      try {
        const buying = f.view.buy(); await started.promise; assert.equal(f.view.buying.value, true);
        await f.view.buy(); assert.equal(f.calls.length, 0);
        if (mutation === 'identity') authUtils.setAuth('replacement-combination-session', 22);
        if (mutation === 'route') await f.router.push('/elsewhere');
        if (mutation === 'query-only-route') await f.router.push('/combination/20?sku=actred20&quantity=2');
        if (mutation === 'refresh') await f.view.load();
        if (mutation === 'unmount') { f.close(); closed = true; }
        waiting.release(); await buying; await flush();
        assert.equal(f.calls.length, 0); assert.notEqual(f.router.currentRoute.value.path, '/checkout');
      } finally { waiting.release(); unbind(); if (!closed) f.close(); }
    });
  }

  for (const deadline of ['activity', 'group']) {
    it(`combination rechecks the ${deadline} deadline after a delayed navigation guard`, async () => {
      const f = await mount(), waiting = gate(), started = gate(); chooseBlue(f, 300);
      const unbind = f.router.beforeEach(async to => { if (chosenRoute(to)) { started.release(); await waiting.promise; } });
      try {
        const buying = f.view.buy(); await started.promise;
        if (deadline === 'activity') f.view.detail.value.stop_time = new Date(Date.now() - 1).toISOString();
        else f.view.detail.value.groups[0].stop_time = new Date(Date.now() - 1).toISOString();
        waiting.release(); await buying; assert.equal(f.calls.length, 0); assert.ok(f.view.error.value);
      } finally { waiting.release(); unbind(); f.close(); }
    });
  }

  for (const mutation of ['activity-route', 'query-only-route', 'identity', 'unmount']) {
    it(`a late combination cart response cannot navigate after ${mutation}`, async () => {
      const { authUtils } = getContext(), waiting = gate(), started = gate();
      const f = await mount({ add: () => { started.release(); return waiting.promise; } }); chooseBlue(f, 300);
      let closed = false;
      try {
        const buying = f.view.buy(); await started.promise; assert.equal(f.calls.length, 1);
        if (mutation === 'activity-route') await f.router.push('/combination/21');
        if (mutation === 'query-only-route') await f.router.push('/combination/20?sku=actred20&quantity=1');
        if (mutation === 'identity') authUtils.setAuth('replacement-combination-session', 22);
        if (mutation === 'unmount') { f.close(); closed = true; }
        waiting.release({ status: 200, data: { id: 91, cartNum: 2 } }); await buying; await flush();
        assert.notEqual(f.router.currentRoute.value.path, '/checkout'); assert.equal(f.calls.length, 1);
      } finally { waiting.release({ status: 200, data: { id: 91, cartNum: 2 } }); if (!closed) f.close(); }
    });
  }

  it('cancelled checkout navigation retains the prepared combination cart for a write-free retry', async () => {
    const f = await mount(); chooseBlue(f, 300);
    const unbind = f.router.beforeEach(to => to.path === '/checkout' ? false : undefined);
    try {
      await f.view.buy(); assert.equal(f.calls.length, 1); assert.ok(f.view.prepared.value); assert.ok(f.view.error.value);
      const readsBefore = f.reads.length; await f.view.load(); assert.equal(f.reads.length, readsBefore);
      unbind(); await f.view.buy();
      assert.equal(f.calls.length, 1); assert.equal(f.router.currentRoute.value.path, '/checkout');
      assert.deepEqual({ ...f.router.currentRoute.value.query }, checkoutQuery(300));
    } finally { unbind(); f.close(); }
  });

  it('pending checkout navigation blocks a second add as well as a second navigation', async () => {
    const f = await mount(), waiting = gate(), started = gate(); chooseBlue(f, 300); let navigations = 0;
    const unbind = f.router.beforeEach(async to => {
      if (to.path !== '/checkout') return; navigations++; started.release(); await waiting.promise;
    });
    try {
      const buying = f.view.buy(); await started.promise; assert.equal(f.view.buying.value, true);
      await f.view.buy(); assert.equal(f.calls.length, 1); assert.equal(navigations, 1);
      waiting.release(); await buying; assert.deepEqual({ ...f.router.currentRoute.value.query }, checkoutQuery(300));
    } finally { waiting.release(); unbind(); f.close(); }
  });
}
