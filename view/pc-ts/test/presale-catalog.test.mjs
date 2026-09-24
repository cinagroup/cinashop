import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse, compileScript } from '@vue/compiler-sfc';
import { createRenderer, h, nextTick } from 'vue';
import { createRouter, createMemoryHistory, RouterView } from 'vue-router';
const moduleId = '/src/pages/activity/Presale.test-script.ts';
export function presaleCatalogPlugin(root) {
  const resolved = `${root.replaceAll('\\', '/').replace(/\/$/, '')}${moduleId}`;
  return { name: 'actual-presale-catalog', resolveId(id) { if (id === moduleId) return resolved; }, async load(id) {
    if (id.replaceAll('\\', '/') !== resolved) return;
    const filename = `${root}/src/pages/activity/Presale.vue`;
    return compileScript(parse(await readFile(filename, 'utf8'), { filename }).descriptor, { id: 'actual-presale-catalog' }).content;
  } };
}
const renderer = createRenderer({ createElement: () => ({ children: [] }), createText: text => ({ text }), createComment: text => ({ text }),
  insert(node, parent) { node.parent = parent; (parent.children ??= []).push(node); },
  remove(node) { if (node.parent) node.parent.children = node.parent.children.filter(item => item !== node); },
  parentNode: node => node.parent, nextSibling: () => null, patchProp() {}, setText() {}, setElementText() {} });
const flush = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); await nextTick(); } };
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };
function rows(page = 1, type = 2) { return { status: 200, data: { count: 9,
  list: Array.from({ length: page === 1 ? 8 : 1 }, (_, i) => ({ id: 70 + (page - 1) * 8 + i, store_name: '预售', image: '', price: '80.25',
    is_presale_product: 1, presale_pay_status: type, presale_start_time: 1000, presale_end_time: 2000, presale_day: 7 })) } }; }
export function registerPresaleCatalogTests(getContext) {
  async function mount(read = c => rows(c.params.page, c.params.time_type)) {
    const { server, api, response } = getContext(), calls = [];
    const component = (await server.ssrLoadModule(moduleId)).default; let view;
    const router = createRouter({ history: createMemoryHistory(), routes: [
      { path: '/presale', alias: '/goods_presell', component: { setup(props, ctx) { view = component.setup(props, ctx); return () => null; } } },
      { path: '/presale/:id', component: { render: () => null } }, { path: '/away', component: { render: () => null } },
    ] });
    api.defaults.adapter = async c => { assert.equal(c.url, '/presale/list'); calls.push(structuredClone(c.params)); return response(c, await read(c)); };
    const app = renderer.createApp({ render: () => h(RouterView) }); app.use(router); await router.push('/goods_presell'); app.mount({ children: [] }); await flush();
    return { get view() { return view; }, calls, router, close() { app.unmount(); } };
  }
  it('PC actual presale SFC defaults active, appends and routes the true product ID from the legacy alias', async () => {
    const f = await mount(); try { assert.deepEqual(f.calls, [{ time_type: 2, page: 1, limit: 8 }]);
      await f.view.session.load(true); assert.equal(f.view.state.list.length, 9); await f.view.session.load(true); assert.equal(f.calls.length, 2);
      await f.view.openProduct(999); assert.equal(f.router.currentRoute.value.path, '/goods_presell');
      await f.view.openProduct(78); assert.equal(f.router.currentRoute.value.path, '/presale/78'); assert.equal(f.calls.length, 2);
    } finally { f.close(); }
  });
  it('PC failed append keeps its page and retries without skipping results', async () => {
    let fail = true; const f = await mount(c => c.params.page === 2 && fail ? { status: 400, msg: 'synthetic failure' } : rows(c.params.page, c.params.time_type));
    try { await f.view.session.load(true); assert.equal(f.view.state.page, 1); assert.ok(f.view.state.error);
      fail = false; await f.view.session.load(true); assert.equal(f.view.state.page, 2); assert.deepEqual(f.calls.map(c => c.page), [1, 2, 2]);
    } finally { f.close(); }
  });
  for (const boundary of ['account', 'unmount', 'filter']) it(`PC catalogue invalidates pending rows at ${boundary}`, async () => {
    const pending = gate(); let first = true;
    const f = await mount(c => first ? (first = false, pending.promise) : rows(c.params.page, c.params.time_type));
    try {
      if (boundary === 'account') getContext().authUtils.setAuth('another-account', 22);
      else if (boundary === 'unmount') await f.router.push('/away');
      else await f.view.session.select(3);
      pending.resolve(rows()); await flush(); assert.equal(f.view.state.loading, false);
      if (boundary === 'filter') { assert.equal(f.view.state.type, 3); assert.equal(f.view.state.list.length, 8); }
      else { assert.deepEqual(f.view.state.list, []); await f.view.openProduct(70); assert.notEqual(f.router.currentRoute.value.path, '/presale/70'); }
    } finally { pending.resolve(rows()); f.close(); }
  });
  it('PC rejected navigation can retry and account changes synchronously remove visible private rows', async () => {
    const f = await mount(); let blocked = true; const unbind = f.router.beforeEach(to => to.path.startsWith('/presale/') && blocked ? false : undefined);
    try { await f.view.openProduct(70); assert.match(f.view.state.error, /打开失败/); assert.equal(f.view.navigating.value, false);
      getContext().authUtils.clearAuth(); assert.deepEqual(f.view.state.list, []); await f.view.openProduct(70); assert.equal(f.router.currentRoute.value.path, '/goods_presell');
      blocked = false; await f.view.session.load(); await f.view.openProduct(70); assert.equal(f.router.currentRoute.value.path, '/presale/70');
    } finally { unbind(); f.close(); }
  });
}
