import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer, h, nextTick } from 'vue';
import { createRouter, createMemoryHistory, RouterView } from 'vue-router';

const renderer = createRenderer({
  createElement: () => ({ children: [] }), createText: text => ({ text }), createComment: text => ({ text }),
  insert(node, parent) { node.parent = parent; (parent.children ??= []).push(node); },
  remove(node) { if (node.parent) node.parent.children = node.parent.children.filter(child => child !== node); },
  parentNode: node => node.parent, nextSibling: () => null, patchProp() {}, setText() {}, setElementText() {},
});
const flush = async () => { for (let i = 0; i < 30; i++) { await Promise.resolve(); await nextTick(); } };
const storageKey = 'cinashop_checkout_pending_v1_11';
const key = 'recovery_key_11';
const item = { id: 10, productId: 70, unique: 'red001', cartNum: 2, type: 0, isNew: 1, isValid: true,
  productInfo: { price: '10.00', storeName: '本地恢复样本', image: '', stock: 8, otPrice: '', suk: '红色', systemFormId: 0, productType: 0 }, sumPrice: '20.00' };
const gate = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve }; };

export function registerCheckoutIntentRecoveryTests(getContext) {
  async function mount(create = async () => { throw Error('network uncertainty'); }) {
    const { server, api, response } = getContext();
    const component = (await server.ssrLoadModule('/src/pages/order/Checkout.shipping-test.ts')).default;
    const calls = []; let view;
    api.defaults.adapter = async config => {
      const body = config.method === 'post' ? JSON.parse(config.data) : undefined;
      calls.push({ url: config.url, body, saved: sessionStorage.getItem(storageKey) });
      let data;
      if (config.url.startsWith('/order/create/')) return response(config, await create(body, config));
      if (config.url === '/cart/list') data = [item];
      else if (config.url === '/address/list') data = [{ id: 11, real_name: '本地测试', phone: '00000000000', is_default: 1 }];
      else if (config.url === '/store/list' || config.url === '/coupons/order/0') data = [];
      else if (config.url === '/order/confirm' || config.url.startsWith('/order/computed/')) data = {
        orderKey: key, quoteToken: 'a'.repeat(32), addressInfo: { id: body.addressId }, cartInfo: [{ ...item, truePrice: '10.00' }],
        priceGroup: { sumPrice: '20.00', totalPrice: '20.00', pay_price: '20.00', total_postage: '0.00', pay_postage: '0.00', storePostageDiscount: '0.00',
          vipPrice: '0.00', levelPrice: '0.00', memberPrice: '0.00', couponPrice: '0.00', deduction_price: '0.00', firstOrderPrice: '0.00', usedIntegral: 0, SurplusIntegral: 0, pay_integral: 0 },
      };
      else throw Error('Unexpected request ' + config.url);
      return response(config, { status: 200, data });
    };
    const page = { setup(props, ctx) { view = component.setup(props, ctx); return () => null; } };
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/checkout', component: page },
      { path: '/order/:id', component: { render: () => null } }, { path: '/away', component: { render: () => null } }] });
    const app = renderer.createApp({ render: () => h(RouterView) }); app.use(router);
    await router.push('/checkout?mode=buy&cartIds=10'); app.mount({ children: [] }); await flush();
    let closed = false;
    return { get view() { return view; }, calls, router, writes: () => calls.filter(call => call.url.startsWith('/order/create/')),
      close() { if (!closed) { app.unmount(); closed = true; } } };
  }

  it('PC persists a frozen order before sending and restores it across component recreation without repricing', async () => {
    const first = await mount(); let saved;
    try {
      assert.equal(first.view.canSubmit.value, true, first.view.quoteState.value.error);
      first.view.remark.value = '保留原备注'; await first.view.submitOrder();
      saved = sessionStorage.getItem(storageKey); assert.ok(saved);
      assert.deepEqual(JSON.parse(saved).payload, first.writes()[0].body);
      assert.equal(first.writes()[0].saved, saved, 'the recoverable record must exist before dispatch');
    } finally { first.close(); }
    const second = await mount();
    try {
      assert.equal(second.calls.length, 0, 'a saved intent must be read before fetching claimed carts or a new quote');
      assert.equal(second.view.canSubmit.value, true);
      second.view.remark.value = '不能覆盖原备注'; await second.view.submitOrder();
      assert.deepEqual(second.writes()[0].body, JSON.parse(saved).payload);
      assert.equal(second.writes()[0].url, `/order/create/${key}`);
    } finally { second.close(); }
  });

  it('PC refuses a new order if storage cannot persist the pending record', async () => {
    const f = await mount(), original = sessionStorage.setItem;
    try {
      assert.equal(f.view.canSubmit.value, true, f.view.quoteState.value.error);
      sessionStorage.setItem = (name, value) => { if (name === storageKey) throw Error('storage unavailable'); original(name, value); };
      await f.view.submitOrder(); assert.equal(f.writes().length, 0);
      assert.match(f.view.submissionError.value, /storage unavailable/);
    } finally { sessionStorage.setItem = original; f.close(); }
  });

  it('PC known success survives a resolved navigation failure and only retries viewing the order', async () => {
    const f = await mount(async () => ({ status: 200, data: { key, orderId: 'local_order_11' } }));
    let refuse = true; const unbind = f.router.beforeEach(to => to.path.startsWith('/order/') && refuse ? false : undefined);
    try {
      assert.equal(f.view.canSubmit.value, true, f.view.quoteState.value.error);
      await f.view.submitOrder(); await flush();
      assert.equal(JSON.parse(sessionStorage.getItem(storageKey)).orderId, 'local_order_11');
      assert.match(f.view.submissionError.value, /订单.*未打开/);
      refuse = false; await f.view.submitOrder(); await flush();
      assert.equal(f.router.currentRoute.value.path, '/order/local_order_11');
      assert.equal(f.writes().length, 1); assert.equal(sessionStorage.getItem(storageKey), null);
    } finally { unbind(); f.close(); }
  });

  it('PC explicit checkout reload and query changes retain the original uncertain key and body', async () => {
    const f = await mount();
    try {
      await f.view.submitOrder(); const saved = sessionStorage.getItem(storageKey), count = f.calls.length;
      await f.view.loadCheckout(); await f.router.push('/checkout?mode=buy&cartIds=999&type=5'); await flush();
      assert.equal(f.calls.length, count); assert.equal(f.view.canSubmit.value, true);
      await f.view.submitOrder(); assert.deepEqual(f.writes()[1].body, JSON.parse(saved).payload);
      assert.equal(f.writes()[1].url, `/order/create/${key}`);
    } finally { f.close(); }
  });

  it('PC restored unknown submission is not cleared by a later explicit quote rejection', async () => {
    const first = await mount(); try { await first.view.submitOrder(); } finally { first.close(); }
    const saved = sessionStorage.getItem(storageKey);
    const second = await mount(async () => ({ status: 400, msg: '请重新确认报价', data: { errorCode: 'ORDER_QUOTE_RECONFIRM_REQUIRED', orderKey: key } }));
    try { await second.view.submitOrder(); assert.equal(sessionStorage.getItem(storageKey), saved); assert.ok(second.view.pendingSubmission.value); }
    finally { second.close(); }
  });

  it('PC duplicate clicks and same-page reload cannot overlap an in-flight order creation', async () => {
    const waiting = gate(), f = await mount(() => waiting.promise);
    try {
      const first = f.view.submitOrder(); await flush(); const count = f.calls.length;
      await f.view.submitOrder(); await f.view.loadCheckout(); assert.equal(f.calls.length, count); assert.equal(f.writes().length, 1);
      waiting.resolve({ status: 400, msg: 'temporary failure' }); await first;
      assert.ok(f.view.pendingSubmission.value); assert.equal(f.view.submitting.value, false);
    } finally { waiting.resolve({ status: 400 }); f.close(); }
  });

  for (const raw of ['not-json', '{}']) it(`PC corrupt pending storage blocks all checkout I/O (${raw})`, async () => {
    sessionStorage.setItem(storageKey, raw); const f = await mount();
    try { assert.match(f.view.selectionError.value, /待确认订单记录/); assert.equal(f.view.canSubmit.value, false);
      await f.view.submitOrder(); assert.equal(f.calls.length, 0); assert.equal(sessionStorage.getItem(storageKey), raw);
    } finally { f.close(); }
  });

  it('PC recovers a journal write whose read-back failed before dispatch', async () => {
    const f = await mount(), original = sessionStorage.setItem;
    try {
      sessionStorage.setItem = (name, value) => { original(name, value); if (name === storageKey) throw Error('write completed but acknowledgement failed'); };
      await f.view.submitOrder(); assert.equal(f.writes().length, 0); assert.ok(f.view.pendingSubmission.value);
      const saved = sessionStorage.getItem(storageKey); sessionStorage.setItem = original;
      await f.view.submitOrder(); assert.equal(f.writes().length, 1); assert.deepEqual(f.writes()[0].body, JSON.parse(saved).payload);
    } finally { sessionStorage.setItem = original; f.close(); }
  });

  it('PC never overwrites or submits a different record found before retry', async () => {
    const f = await mount();
    try {
      await f.view.submitOrder(); const changed = { ...JSON.parse(sessionStorage.getItem(storageKey)), key: 'another_key_11' };
      sessionStorage.setItem(storageKey, JSON.stringify(changed)); await f.view.submitOrder();
      assert.equal(f.writes().length, 1); assert.match(f.view.submissionError.value, /已变化/);
      assert.equal(f.view.pendingIntent.value.key, 'another_key_11');
    } finally { f.close(); }
  });

  it('PC account changes synchronously clear private checkout fields without removing the original pending record', async () => {
    const f = await mount();
    try {
      f.view.remark.value = '原用户备注'; await f.view.submitOrder(); const saved = sessionStorage.getItem(storageKey), count = f.calls.length;
      getContext().authUtils.setAuth('second-session', 22);
      assert.equal(f.view.pendingIntent.value, null); assert.deepEqual(f.view.addresses.value, []);
      assert.deepEqual(f.view.customForm.value, []); assert.equal(f.view.remark.value, '');
      assert.deepEqual(f.view.pickupContact.value, { realName: '', phone: '' });
      assert.equal(f.view.canSubmit.value, false); await f.view.submitOrder(); assert.equal(f.calls.length, count);
      assert.equal(sessionStorage.getItem(storageKey), saved);
      getContext().authUtils.setAuth('owner-renewed', 11); await f.view.loadCheckout();
      assert.deepEqual(f.view.pendingSubmission.value, JSON.parse(saved).payload); assert.equal(f.calls.length, count);
    } finally { f.close(); }
  });

  for (const change of ['identity', 'unmount']) it(`PC late create response after ${change} cannot navigate the new view`, async () => {
    const waiting = gate(), f = await mount(() => waiting.promise);
    try {
      const request = f.view.submitOrder(); await flush();
      if (change === 'identity') getContext().authUtils.setAuth('new-owner', 22); else f.close();
      const pathAfterChange = f.router.currentRoute.value.path;
      waiting.resolve({ status: 200, data: { key, orderId: 'local_late_order' } }); await request; await flush();
      assert.equal(f.router.currentRoute.value.path, pathAfterChange); assert.ok(sessionStorage.getItem(storageKey));
      if (change === 'identity') { assert.equal(f.view.pendingIntent.value, null); assert.equal(f.view.submissionError.value, ''); }
      assert.equal(f.writes().length, 1);
    } finally { waiting.resolve({ status: 400 }); f.close(); }
  });

  it('PC settled order restores without cart/quote reads and navigation retries never POST', async () => {
    const first = await mount(async () => ({ status: 200, data: { key, orderId: 'local_saved_order' } }));
    const stop = first.router.beforeEach(to => to.path.startsWith('/order/') ? false : undefined);
    try { await first.view.submitOrder(); } finally { stop(); first.close(); }
    const f = await mount();
    try {
      assert.equal(f.calls.length, 0); assert.equal(f.view.pendingIntent.value.orderId, 'local_saved_order');
      await f.view.submitOrder(); assert.equal(f.writes().length, 0);
      assert.equal(f.router.currentRoute.value.path, '/order/local_saved_order'); assert.equal(sessionStorage.getItem(storageKey), null);
    } finally { f.close(); }
  });

  for (const data of [null, { key: 'wrong_key', orderId: 'order_11' }, { key, orderId: '../pay' }]) {
    it(`PC malformed success stays unresolved and cannot become a navigation target (${JSON.stringify(data)})`, async () => {
      const f = await mount(async () => ({ status: 200, data }));
      try {
        await f.view.submitOrder(); assert.equal(f.router.currentRoute.value.path, '/checkout');
        assert.ok(f.view.pendingIntent.value); assert.equal(f.view.pendingIntent.value.orderId, undefined);
        assert.equal(f.writes().length, 1); assert.match(f.view.submissionError.value, /订单结果无效/);
      } finally { f.close(); }
    });
  }
}
