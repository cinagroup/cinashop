import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse, compileScript } from '@vue/compiler-sfc';
import { createRenderer, h, nextTick } from 'vue';
import { createRouter, createMemoryHistory, RouterView } from 'vue-router';
const moduleId = '/src/pages/goods/GoodsDetail.test-script.ts';
export function productDetailComponentPlugin(root) {
  const resolved = `${root.replaceAll('\\', '/').replace(/\/$/, '')}${moduleId}`;
  return { name: 'actual-product-detail-setup', resolveId(id, importer) {
    if (id === moduleId) return resolved;
    if (id === 'element-plus' && importer?.replaceAll('\\', '/') === resolved) return '/@test/product-messages';
  }, async load(id) {
    if (id === '/@test/product-messages') return 'export const messages=[]; export const ElMessage={error:v=>messages.push(v),success:v=>messages.push(v)};';
    if (id.replaceAll('\\', '/') !== resolved) return;
    const filename = `${root}/src/pages/goods/GoodsDetail.vue`;
    // Only replace toast DOM I/O; all application logic, Axios and router remain real.
    return compileScript(parse(await readFile(filename, 'utf8'), { filename }).descriptor, { id: 'actual-product-detail' }).content
      .replace(/from (["'])element-plus\1/g, 'from "/@test/product-messages"');
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
const goods = (id = 70, price = '8.00') => ({ id, price: '10.00', stock: 8, isVip: 1, isShow: 1, isDel: 0,
  productType: 0, isPresaleProduct: 0, systemFormId: 0, storeName: `商品${id}`, attr_value: [
    { unique: 'red001', price: '10.00', vip_price: '8.00', stock: 8, member_price: price, price_type: price === '10.00' ? '' : 'member', level_name: '' },
    { unique: 'blue001', price: '20.00', stock: 2 },
  ] });
export function registerProductDetailLifecycleTests(getContext) {
  async function mount(override = () => undefined) {
    const { server, api, location, response } = getContext();
    const component = (await server.ssrLoadModule(moduleId)).default, calls = [];
    const messages = (await server.ssrLoadModule('/@test/product-messages')).messages; messages.length = 0;
    let view;
    const page = { setup(props, ctx) { view = component.setup(props, ctx); return () => null; } };
    const router = createRouter({ history: createMemoryHistory(), routes: [
      { path: '/goods/:id', name: 'goods-detail', component: page },
      ...['login', 'checkout', 'elsewhere'].map(name => ({ path: `/${name}`, name, component: { render: () => null } })),
    ] });
    const unbind = router.afterEach(to => { const url = new URL(to.fullPath, location.origin); Object.assign(location, { pathname: url.pathname, search: url.search, hash: url.hash }); });
    api.defaults.adapter = async config => {
      calls.push(config); const custom = await override(config); if (custom !== undefined) return response(config, custom);
      const data = config.url.startsWith('/product/detail/') ? goods(Number(config.url.split('/').at(-1))) :
        config.url.startsWith('/reply/config/') ? { total: 0, avgScore: '0.0', goodRate: 100 } :
        config.url === '/cart/add' ? { id: 91, cartIds: [91, 92] } : [];
      return response(config, { status: 200, data });
    };
    const app = renderer.createApp({ render: () => h(RouterView) }); app.use(router);
    await router.push('/goods/70'); app.mount({ children: [] }); await flush();
    let closed = false;
    return { router, calls, messages, get view() { return view; }, close() { if (!closed) { app.unmount(); unbind(); closed = true; } } };
  }
  for (const mode of ['ordinary', 'package']) it(`${mode} known cart survives failed checkout navigation without another write`, async () => {
    const bundle = { id: 5, type: 0, title: '本地套餐', products: [1, 2].map(id => ({ id, product_id: 70 + id, productValue: [{ unique: 'red001', stock: 8, price: '1.00' }] })) };
    const f = await mount(config => config.url.includes('/store_discounts/list/') ? {status:200,data:[bundle]} : undefined);
    let refuse = true; const unbind = f.router.beforeEach(to => to.path === '/checkout' && refuse ? false : undefined);
    try {
      if (mode === 'package') f.view.openPackage(f.view.discountPackages.value[0]);
      const buy = () => mode === 'package' ? f.view.buyPackage() : f.view.buyNow();
      await buy(); await flush(); assert.equal(f.router.currentRoute.value.path, '/goods/70');
      refuse = false; await buy(); await flush();
      assert.equal(f.calls.filter(c => c.url === '/cart/add').length, 1);
      assert.equal(f.router.currentRoute.value.path, '/checkout');
      assert.equal(f.router.currentRoute.value.query.cartIds, mode === 'package' ? '91,92' : '91');
    } finally { unbind(); f.close(); }
  });
  it('prepared ordinary retry locks out new ordinary/package writes and duplicate pending navigation', async () => {
    const f = await mount(); let first = true; const wait = gate();
    const unbind = f.router.beforeEach(to => { if (to.path === '/checkout') { if (first) { first = false; return false; } return wait.promise; } });
    try {
      await f.view.buyNow(); const retry = f.view.resumeCheckout(); await flush();
      await f.view.buyNow(); await f.view.addToCart(); await f.view.buyPackage(); f.view.restartPurchase();
      assert.equal(f.calls.filter(c => c.url === '/cart/add').length,1); assert.equal(f.view.checkoutNavigating.value,true);
      wait.release(false); await retry; assert.ok(f.view.preparedCart.value); assert.equal(f.view.checkoutNavigating.value,false);
    } finally { wait.release(false); unbind(); f.close(); }
  });
  for (const ending of ['identity','route','unmount','reload']) it(`prepared ordinary recovery is discarded after ${ending}`, async () => {
    const f = await mount(); const unbind=f.router.beforeEach(to=>to.path==='/checkout'?false:undefined);
    try {
      await f.view.buyNow(); assert.ok(f.view.preparedCart.value);
      if(ending==='identity') getContext().authUtils.setAuth('replacement',22);
      if(ending==='route') await f.router.push('/goods/71');
      if(ending==='unmount') f.close();
      if(ending==='reload') f.view.restartPurchase();
      await flush(); assert.equal(f.view.preparedCart.value,null); const count=f.calls.length;
      await f.view.resumeCheckout(); assert.equal(f.calls.length,count); assert.notEqual(f.router.currentRoute.value.path,'/checkout');
    } finally {unbind();f.close();}
  });
  for(const bad of [{id:0},null]) it(`unconfirmed ordinary response ${JSON.stringify(bad)} cannot navigate or silently retry`,async()=>{
    const f=await mount(c=>c.url==='/cart/add'?{status:200,data:bad}:undefined);
    try{await f.view.buyNow(); assert.equal(f.view.preparedCart.value,null); assert.equal(f.view.purchaseNeedsRefresh.value,true);
      await f.view.buyNow(); await f.view.addToCart(); assert.equal(f.calls.filter(c=>c.url==='/cart/add').length,1);
      assert.equal(f.router.currentRoute.value.path,'/goods/70');
    }finally{f.close();}
  });
  it('pending ordinary purchase prevents an overlapping package submission',async()=>{
    const wait=gate();const bundle={id:5,type:0,products:[1,2].map(id=>({id,product_id:70+id,productValue:[{unique:'red001',stock:8,price:'1'}]}))};
    const f=await mount(c=>c.url.includes('/store_discounts/list/')?{status:200,data:[bundle]}:c.url==='/cart/add'?wait.promise:undefined);
    const unbind=f.router.beforeEach(to=>to.path==='/checkout'?false:undefined);
    try{f.view.openPackage(f.view.discountPackages.value[0]); const first=f.view.buyNow();await flush();await f.view.buyPackage();
      assert.equal(f.calls.filter(c=>c.url==='/cart/add').length,1);wait.release({status:200,data:{id:91}});await first;
    }finally{wait.release({status:200,data:{id:91}});unbind();f.close();}
  });
  for (const identical of [false, true]) it(`ordinary detail clears loaded user quote synchronously on login (identical=${identical})`, async () => {
    const { authUtils } = getContext(); let slow = false; const wait = gate();
    const f = await mount(config => slow && config.url.startsWith('/product/detail/') ? wait.promise : undefined);
    try { assert.equal(f.view.displayPrice.value, '8.00'); f.view.packageVisible.value = true; slow = true;
      authUtils.setAuth(identical ? 'session-a' : 'session-b', identical ? 11 : 22);
      assert.equal(f.view.detail.value, null); assert.equal(f.view.packageVisible.value, false);
      assert.equal(f.view.selectedUnique.value, ''); assert.equal(f.view.canPurchase.value, false);
      wait.release({ status: 200, data: goods(70, '10.00') }); await flush();
      assert.equal(f.view.displayPrice.value, '10.00');
    } finally { wait.release({ status: 200, data: goods() }); f.close(); }
  });
  it('ordinary detail reloads query-only selection changes in a reused route', async () => {
    const f = await mount(); try { await f.router.push('/goods/70?sku=blue001&qty=2'); await flush();
      assert.equal(f.view.selectedUnique.value, 'blue001'); assert.equal(f.view.displayPrice.value, '20.00');
    } finally { f.close(); }
  });
  it('ordinary detail removes all old state on failed identity refresh and allows explicit retry', async () => {
    const { authUtils } = getContext(); let fail = false;
    const f = await mount(config => fail && config.url.startsWith('/product/detail/') ? { status: 400, msg: 'fixture offline' } : undefined);
    try { fail = true; authUtils.setAuth('session-b', 22); await flush();
      assert.equal(f.view.detail.value, null); assert.match(f.view.loadError.value, /offline/); assert.equal(f.view.canPurchase.value, false);
      fail = false; await f.view.load(); assert.ok(f.view.detail.value);
    } finally { f.close(); }
  });
  for (const action of ['buyNow', 'toggleCollect']) for (const ending of ['identity', 'route', 'unmount']) {
    it(`ordinary detail ${action} late completion is ignored after ${ending}`, async () => {
      const { authUtils } = getContext(), wait = gate(); let writing = false;
      const f = await mount(config => writing && config.method === 'post' ? wait.promise : undefined);
      try { writing = true; const p = f.view[action](); await flush();
        if (ending === 'identity') authUtils.setAuth('new-session', 22);
        if (ending === 'route') { await f.router.push('/goods/71'); await flush(); }
        if (ending === 'unmount') f.close();
        wait.release({ status: 200, data: { id: 91 } }); await p; await flush();
        assert.notEqual(f.router.currentRoute.value.path, '/checkout'); assert.equal(f.view.collected.value, false); assert.deepEqual(f.messages, []);
      } finally { wait.release({ status: 200, data: { id: 91 } }); f.close(); }
    });
  }
  it('ordinary detail old review data cannot cross product navigation', async () => {
    const wait = gate(); const f = await mount(config => config.url === '/reply/config/70' ? wait.promise : undefined);
    try { await f.router.push('/goods/71'); await flush(); wait.release({ status: 200, data: { total: 99 } }); await flush();
      assert.equal(f.view.replyStats.value.total, 0);
    } finally { wait.release({ status: 200, data: { total: 99 } }); f.close(); }
  });
  it('ordinary detail discards a late product response after route replacement', async () => {
    const wait = gate(); const f = await mount(config => config.url === '/product/detail/70' ? wait.promise : undefined);
    try { await f.router.push('/goods/71'); await flush();
      wait.release({ status: 200, data: goods(70) }); await flush();
      assert.equal(f.view.detail.value.id, 71);
    } finally { wait.release({ status: 200, data: goods() }); f.close(); }
  });
  it('ordinary detail rejects invalid route IDs and a mismatched returned product', async () => {
    const f = await mount(config => config.url === '/product/detail/71' ? { status: 200, data: goods(70) } : undefined);
    try { const count = f.calls.length;
      for (const id of ['1e2', '01', '70.0', '0', '2147483648']) {
        await f.router.push(`/goods/${id}`); await flush();
        assert.equal(f.view.detail.value, null); assert.equal(f.calls.length, count); assert.match(f.view.loadError.value, /标识/);
      }
      await f.router.push('/goods/71'); await flush();
      assert.equal(f.view.detail.value, null); assert.match(f.view.loadError.value, /不匹配/);
    } finally { f.close(); }
  });
  it('ordinary detail unload clears state and removes the authentication subscription', async () => {
    const { authUtils } = getContext(), f = await mount(); const p = f.view;
    f.close(); const count = f.calls.length; authUtils.setAuth('another', 22); await flush();
    assert.equal(p.detail.value, null); assert.equal(f.calls.length, count);
  });
}
