import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse, compileScript } from '@vue/compiler-sfc';
import { createRenderer, h, nextTick } from 'vue';
import { createRouter, createMemoryHistory, RouterView } from 'vue-router';
const script = '/src/pages/order/OrderDetail.lifecycle-test.ts';
export function orderDetailPlugin(root) {
  const id = root.replaceAll('\\', '/').replace(/\/$/, '') + script;
  return { name: 'actual-order-detail-lifecycle', resolveId(value) { if (value === script) return id; }, async load(value) {
    if (value === '/@test/order-detail-dialog') return `export const state={messages:[],confirm:async()=>{},closed:0};export const ElMessage=Object.fromEntries(['error','success','info','warning'].map(k=>[k,v=>state.messages.push(v)]));export const ElMessageBox={confirm:(...args)=>state.confirm(...args),close:()=>state.closed++};`;
    if (value !== id) return;
    const filename = root + '/src/pages/order/OrderDetail.vue';
    return compileScript(parse(await readFile(filename, 'utf8'), { filename }).descriptor, { id: 'actual-order-detail' }).content
      .replace(/from (["'])element-plus\1/g, 'from "/@test/order-detail-dialog"');
  } };
}
const renderer = createRenderer({ createElement: () => ({ children: [] }), createText: text => ({ text }), createComment: text => ({ text }),
  insert(node, parent) { node.parent = parent; (parent.children ??= []).push(node); },
  remove(node) { if (node.parent) node.parent.children = node.parent.children.filter(child => child !== node); },
  parentNode: node => node.parent, nextSibling: () => null, patchProp() {}, setText() {}, setElementText() {} });
const flush = async () => { for (let i = 0; i < 25; i++) { await Promise.resolve(); await nextTick(); } };
const gate = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve }; };
const detail = id => ({ orderId: id, uid: 11, paid: 0, payPrice: '10.00', totalPrice: '10.00', status: 0, type: 0,
  pid: 0, supplierAllocationStatus: 0, productType: 0, cartInfo: [], customForm: [], realName: '本地私有联系人' });
const cashier = id => ({ type: 'order', order_id: id, paid: false, payable: true, payable_reason: '', zero_pay: false,
  pay_price: '10.00', now_money: '20.00', integral: 0, pay_integral: 0,
  methods: Object.fromEntries(['yue','weixin','alipay','offline'].map(key => [key, { enabled: key === 'yue', reason: '' }])) });

export function registerOrderDetailTests(getContext) {
  async function mount(override = () => undefined) {
    const { server, api, response } = getContext(), calls = [];
    const dialog = (await server.ssrLoadModule('/@test/order-detail-dialog')).state;
    dialog.messages.length = 0; dialog.closed = 0; dialog.confirm = async () => {};
    api.defaults.adapter = async config => {
      calls.push(config); const custom = await override(config);
      const data = config.url.startsWith('/order/detail/') ? detail(config.url.split('/').at(-1)) :
        config.url.startsWith('/order/cashier/') ? cashier(config.url.split('/').at(-2)) : { order_id: JSON.parse(config.data ?? '{}').uni, paid: true, pay_type: 'yue' };
      return response(config, custom ?? { status: 200, data });
    };
    let view; const component = (await server.ssrLoadModule(script)).default;
    const router = createRouter({ history: createMemoryHistory(), routes: [
      { path: '/order/:orderId', component: { setup(props, ctx) { view = component.setup(props, ctx); return () => null; } } },
      { path: '/away', component: { render: () => null } }] });
    const app = renderer.createApp({ render: () => h(RouterView) }); app.use(router);
    await router.push('/order/local_A'); app.mount({ children: [] }); await flush(); let closed = false;
    return { get view() { return view; }, calls, dialog, router, writes: () => calls.filter(c => c.method === 'post'),
      close() { if (!closed) { app.unmount(); closed = true; } } };
  }
  it('PC detail refresh failure removes stale order/cashier and exposes retryable error', async () => {
    let fail = false; const f = await mount(c => fail && c.url.startsWith('/order/detail/') ? { status: 400, msg: '读取失败' } : undefined);
    try { assert.equal(f.view.order.value.order_id, 'local_A'); fail = true; await f.view.load();
      assert.equal(f.view.order.value, null); assert.equal(f.view.cashier.value, null); assert.match(f.view.loadError.value, /读取失败/);
    } finally { f.close(); }
  });
  it('PC detail ignores an older order response after route replacement', async () => {
    const waiting = gate(), f = await mount(c => c.url === '/order/detail/local_A' ? waiting.promise : undefined);
    try { await f.router.push('/order/local_B'); await flush(); waiting.resolve({ status: 200, data: detail('local_A') }); await flush();
      assert.equal(f.view.order.value.order_id, 'local_B'); assert.equal(f.view.cashier.value.order_id, 'local_B');
    } finally { waiting.resolve({ status: 400 }); f.close(); }
  });
  it('PC payment confirmation cannot target a different order after route replacement', async () => {
    const waiting = gate(), f = await mount(); f.dialog.confirm = () => waiting.promise;
    try { const pay = f.view.pay(); await flush(); await f.router.push('/order/local_B'); await flush(); waiting.resolve(); await pay;
      assert.equal(f.writes().length, 0); assert.equal(f.view.order.value.order_id, 'local_B');
    } finally { waiting.resolve(); f.close(); }
  });
  it('PC detail identity renewal clears loaded contact, cashier and dialogs synchronously', async () => {
    const f = await mount();
    try { f.view.qrVisible.value = true; f.view.reviewVisible.value = true; getContext().authUtils.setAuth('new-owner', 22);
      assert.equal(f.view.order.value, null); assert.equal(f.view.cashier.value, null);
      assert.equal(f.view.qrVisible.value, false); assert.equal(f.view.reviewVisible.value, false);
    } finally { f.close(); }
  });
  for (const change of [{ uid: 22 }, { orderId: 'local_B' }, { paid: 2 }, { payPrice: 'oops' }, { cartInfo: {} }]) {
    it(`PC detail rejects malformed or foreign response ${JSON.stringify(change)}`, async () => {
      const f = await mount(c => c.url.includes('/detail/') ? { status: 200, data: { ...detail('local_A'), ...change } } : undefined);
      try { assert.equal(f.view.order.value, null); assert.equal(f.view.cashier.value, null); assert.ok(f.view.loadError.value);
        await f.view.pay(); assert.equal(f.writes().length, 0);
      } finally { f.close(); }
    });
  }
  it('PC detail cashier failure retains only the fresh order and retry fetches both records', async () => {
    let fail = true; const f = await mount(c => fail && c.url.includes('/cashier/') ? { status: 400, msg: '本地收银故障' } : undefined);
    try { assert.equal(f.view.order.value.order_id, 'local_A'); assert.equal(f.view.cashier.value, null); assert.match(f.view.cashierError.value, /本地收银故障/);
      await f.view.pay(); assert.equal(f.writes().length, 0); fail = false; await f.view.load();
      assert.equal(f.view.cashier.value.order_id, 'local_A'); assert.equal(f.view.cashierError.value, '');
    } finally { f.close(); }
  });
  it('PC detail rejects a cashier amount from a different order snapshot', async () => {
    const f = await mount(c => c.url.includes('/cashier/') ? { status: 200, data: { ...cashier('local_A'), pay_price: '0.01' } } : undefined);
    try { assert.equal(f.view.cashier.value, null); assert.match(f.view.cashierError.value, /不一致/); } finally { f.close(); }
  });
  it('PC detail late cashier cannot overwrite a newer route', async () => {
    const waiting = gate(), f = await mount(c => c.url.includes('/cashier/local_A/') ? waiting.promise : undefined);
    try { await f.router.push('/order/local_B'); await flush(); waiting.resolve({ status: 200, data: cashier('local_A') }); await flush();
      assert.equal(f.view.cashier.value.order_id, 'local_B'); assert.equal(f.view.order.value.order_id, 'local_B');
    } finally { waiting.resolve({ status: 400 }); f.close(); }
  });
  it('PC detail double payment click opens one confirmation and sends one captured write', async () => {
    const waiting = gate(), f = await mount(); let confirmations = 0;
    f.dialog.confirm = () => { confirmations++; return waiting.promise; };
    try { const first = f.view.pay(); await f.view.pay(); assert.equal(confirmations, 1); assert.equal(f.writes().length, 0);
      waiting.resolve(); await first; assert.equal(f.writes().length, 1); assert.equal(JSON.parse(f.writes()[0].data).uni, 'local_A');
    } finally { waiting.resolve(); f.close(); }
  });
  for (const ending of ['identity', 'route', 'unmount']) it(`PC detail ignores a late paid response after ${ending}`, async () => {
    const waiting = gate(), f = await mount(c => c.method === 'post' ? waiting.promise : undefined);
    try { const pending = f.view.pay(); await flush(); assert.equal(f.writes().length, 1);
      if (ending === 'identity') getContext().authUtils.setAuth('another-owner',22);
      else if (ending === 'route') { await f.router.push('/order/local_B'); await flush(); }
      else f.close();
      const reads = f.calls.length; waiting.resolve({ status: 200, data: { order_id: 'local_A', pay_type:'yue', paid:true } }); await pending;
      assert.equal(f.calls.length, reads); assert.equal(f.dialog.messages.length, 0);
    } finally { waiting.resolve({ status: 400 }); f.close(); }
  });
  it('PC detail unknown payment result requires a read before another write', async () => {
    const f = await mount(c => c.method === 'post' ? { status: 200, data: { order_id: 'local_B', pay_type:'yue', paid:true } } : undefined);
    try { await f.view.pay(); assert.match(f.view.actionError.value, /尚未确认/); await f.view.pay(); assert.equal(f.writes().length, 1);
      await f.view.load(); assert.equal(f.view.actionError.value, ''); assert.equal(f.view.cashier.value.order_id, 'local_A');
    } finally { f.close(); }
  });
  it('PC detail manual payment check ignores a late status after leaving the QR order', async () => {
    const waiting = gate(); let delayed = false;
    const f = await mount(c => delayed && c.url === '/order/detail/local_A' ? waiting.promise : undefined);
    try { delayed = true; f.view.qrVisible.value = true; const pending = f.view.confirmExternalPayment(); await flush();
      await f.router.push('/order/local_B'); await flush(); waiting.resolve({ status: 200, data: { ...detail('local_A'), paid:1 } }); await pending;
      assert.equal(f.view.order.value.order_id, 'local_B'); assert.equal(f.dialog.messages.length, 0);
    } finally { waiting.resolve({ status: 400 }); f.close(); }
  });
  it('PC detail shared identity validators reject unsafe routes and malformed payment shapes', async () => {
    const module = await getContext().server.ssrLoadModule('/@fs/' + new URL('../../common/orderDetailIdentity.ts', import.meta.url).pathname.replace(/^\//, ''));
    assert.equal(module.orderDetailId('local_A-123'), 'local_A-123');
    assert.equal(module.orderDetailHashId('#/pages/order/detail?orderId=local_A'), 'local_A');
    assert.equal(module.orderDetailHashId('#/pages/order/list'), null);
    for (const value of [undefined, 3, ['local_A'], '', '../a', 'a?b', 'a#b', 'x'.repeat(97)]) assert.throws(() => module.orderDetailId(value));
    for (const hash of ['#/pages/order/detail', '#/pages/order/detail?orderId=a&orderId=b', '#/pages/order/detail?orderId=a?b']) assert.throws(() => module.orderDetailHashId(hash));
    for (const value of [null, [], {}, { order_id:'local_A',pay_type:'yue',paid:1 }, { order_id:'local_B',pay_type:'yue',paid:true }]) assert.throws(() => module.assertOrderPaymentIdentity(value,'local_A','yue'));
    assert.throws(() => module.assertOrderCashierIdentity({...cashier('local_A'),zero_pay:true},'local_A','10.00'));
  });
  it('PC detail confirmation is cancelled even on identical-token session renewal', async () => {
    const waiting = gate(), f = await mount(); f.dialog.confirm = () => waiting.promise;
    try { const pending = f.view.pay(); getContext().authUtils.setAuth('session-a',11); assert.equal(f.dialog.closed,1);
      waiting.resolve(); await pending; assert.equal(f.writes().length,0); assert.equal(f.view.order.value,null);
    } finally { waiting.resolve(); f.close(); }
  });
  it('PC detail receipt writes once and cannot refresh another order after completion', async () => {
    const waiting = gate(), f = await mount(c => c.method === 'post' ? waiting.promise : c.url.includes('/detail/') ? { status:200,data:{...detail(c.url.split('/').at(-1)),paid:1,status:1} } : undefined);
    try { const pending = f.view.take(); await f.view.take(); await flush(); assert.equal(f.writes().length,1);
      await f.router.push('/order/local_B'); await flush(); const reads = f.calls.length;
      waiting.resolve({status:200,data:null}); await pending; assert.equal(f.calls.length,reads); assert.equal(f.dialog.messages.length,0);
    } finally { waiting.resolve({status:400}); f.close(); }
  });
  it('PC detail review loop stops before the next product when its owner changes', async () => {
    const waiting = gate(), f = await mount(c => c.method === 'post' ? waiting.promise : c.url.includes('/detail/') ? {status:200,data:{...detail('local_A'),paid:1,status:2,cartInfo:[{id:1,unique:'row_A'},{id:2,unique:'row_B'}]}} : undefined);
    try { f.view.reviewForm.value.comment='本地测试评价'; const pending = f.view.submitReview(); await flush(); assert.equal(f.writes().length,1);
      getContext().authUtils.setAuth('new-session',22); waiting.resolve({status:200,data:null}); await pending;
      assert.equal(f.writes().length,1); assert.equal(f.view.reviewForm.value.comment,''); assert.equal(f.dialog.messages.length,0);
    } finally { waiting.resolve({status:400}); f.close(); }
  });
}
