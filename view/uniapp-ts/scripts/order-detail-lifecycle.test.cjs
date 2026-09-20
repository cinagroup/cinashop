const test = require('node:test');
const assert = require('node:assert/strict');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');
const detail = id => ({ orderId: id, uid: 11, paid: 0, payPrice: '10.00', totalPrice: '10.00', status: 0, type: 0,
  pid: 0, supplierAllocationStatus: 0, productType: 0, cartInfo: [], customForm: [], realName: '本地私有联系人' });
const cashier = id => ({ type: 'order', order_id: id, paid: false, payable: true, payable_reason: '', zero_pay: false,
  pay_price: '10.00', now_money: '20.00', integral: 0, pay_integral: 0,
  methods: Object.fromEntries(['yue','weixin','alipay','offline'].map(key => [key, { enabled: key === 'yue', reason: '' }])) });
function setup(override = () => undefined) {
  return runtime({ component: 'pages/order/detail.vue', send: c => override(c) ?? { data: c.url.includes('/order/detail/')
    ? detail(c.url.split('/').at(-1)) : cashier(c.url.split('/').at(-2)) } });
}
test('UniApp detail failed refresh clears old private data and offers an explicit retry', async () => {
  let fail = false; const r = setup(c => fail && c.url.includes('/order/detail/') ? { transport: '读取失败' } : undefined);
  try { await r.start({orderId:'local_A'}); assert.equal(r.checkout.order.value.order_id, 'local_A'); fail = true; await r.checkout.load();
    assert.equal(r.checkout.order.value, null); assert.equal(r.checkout.cashier.value, null); assert.match(r.checkout.loadError.value, /读取失败/);
  } finally { r.stop(); }
});
for (const ending of ['identity','onHide','onUnload']) test(`UniApp detail removes order/cashier on ${ending}`, async () => {
  const r = setup(); try { await r.start({orderId:'local_A'});
    if (ending === 'identity') r.auth.setLogin('new-owner',22); else r.hooks[ending]?.();
    assert.equal(r.checkout.order.value, null); assert.equal(r.checkout.cashier.value, null);
  } finally { r.stop(); }
});
test('UniApp detail late old order response cannot overwrite a new page load', async () => {
  const waiting = deferred(), r = setup(c => c.url.endsWith('/detail/local_A') ? waiting.promise : undefined);
  try { await r.start({orderId:'local_A'}); await r.start({orderId:'local_B'}); waiting.resolve({ data: detail('local_A') }); await tick();
    assert.equal(r.checkout.order.value.order_id, 'local_B'); assert.equal(r.checkout.cashier.value.order_id, 'local_B');
  } finally { waiting.resolve({ status:400 }); r.stop(); }
});
test('UniApp detail cashier failure leaves the fresh order and supports explicit recovery', async () => {
  let fail = true; const r = setup(c => fail && c.url.includes('/cashier/') ? { status:400, msg:'收银故障' } : undefined);
  try { await r.start({orderId:'local_A'}); assert.equal(r.checkout.order.value.order_id,'local_A'); assert.equal(r.checkout.cashier.value,null);
    assert.match(r.checkout.cashierError.value,/收银故障/); await r.checkout.pay(); assert.equal(r.calls.filter(c => c.url.endsWith('/order/pay')).length,0);
    fail = false; await r.checkout.load(); assert.equal(r.checkout.cashier.value.order_id,'local_A');
  } finally { r.stop(); }
});
for (const value of [{ uid:22 }, { orderId:'local_B' }, { payPrice:'oops' }, { paid:2 }]) test(`UniApp detail rejects foreign or malformed detail ${JSON.stringify(value)}`, async () => {
  const r = setup(c => c.url.includes('/detail/') ? { data:{...detail('local_A'),...value} } : undefined);
  try { await r.start({orderId:'local_A'}); assert.equal(r.checkout.order.value,null); assert.ok(r.checkout.loadError.value); await r.checkout.pay();
    assert.equal(r.calls.length,1);
  } finally { r.stop(); }
});
test('UniApp detail invalid route does not dispatch a request', async () => {
  const r = setup(); try { await r.start({orderId:'../foreign'}); assert.ok(r.checkout.loadError.value); assert.equal(r.calls.length,0); } finally { r.stop(); }
});
for (const ending of ['identity','onHide','onUnload','route']) test(`UniApp detail late paid response cannot navigate after ${ending}`, async () => {
  const waiting = deferred(), r = setup(c => c.url.endsWith('/order/pay') ? waiting.promise : undefined);
  try { await r.start({orderId:'local_A'}); const pending = r.checkout.pay(); await tick();
    assert.equal(r.calls.filter(c => c.url.endsWith('/order/pay')).length,1);
    if (ending === 'identity') r.auth.setLogin('new-owner',22);
    else if (ending === 'route') await r.start({orderId:'local_B'});
    else r.hooks[ending]();
    const reads = r.calls.length; waiting.resolve({data:{order_id:'local_A',pay_type:'yue',paid:true}}); await pending;
    assert.equal(r.navigations.length,0); assert.equal(r.toasts.length,0); assert.equal(r.calls.length,reads);
  } finally { waiting.resolve({ status:400 }); r.stop(); }
});
test('UniApp detail duplicate taps send once and success uses the captured order', async () => {
  const waiting = deferred(), r = setup(c => c.url.endsWith('/order/pay') ? waiting.promise : undefined);
  r.uni.redirectTo = opts => r.navigations.push(opts.url);
  try { await r.start({orderId:'local_A'}); const pending = r.checkout.pay(); await r.checkout.pay(); await tick();
    assert.equal(r.calls.filter(c => c.url.endsWith('/order/pay')).length,1);
    waiting.resolve({data:{order_id:'local_A',pay_type:'yue',paid:true}}); await pending;
    assert.deepEqual(r.navigations,['/pages/order/payResult?orderId=local_A']);
  } finally { waiting.resolve({ status:400 }); r.stop(); }
});
test('UniApp detail unknown payment outcome blocks repeated writes until explicit refresh', async () => {
  const r = setup(c => c.url.endsWith('/order/pay') ? {transport:'本地响应丢失'} : undefined);
  try { await r.start({orderId:'local_A'}); await r.checkout.pay(); assert.match(r.checkout.actionError.value,/尚未确认/);
    await r.checkout.pay(); assert.equal(r.calls.filter(c => c.url.endsWith('/order/pay')).length,1);
    await r.checkout.load(); assert.equal(r.checkout.actionError.value,'');
  } finally { r.stop(); }
});
test('UniApp detail hide/show retains in-flight payment lock and requires a later read', async () => {
  const waiting = deferred(), r = setup(c => c.url.endsWith('/order/pay') ? waiting.promise : undefined);
  try { await r.start({orderId:'local_A'}); const pending = r.checkout.pay(); await tick(); r.hooks.onHide(); r.hooks.onShow(); await tick();
    assert.equal(r.checkout.paying.value,true); assert.match(r.checkout.actionError.value,/处理中/); await r.checkout.pay();
    waiting.resolve({data:{order_id:'local_A',pay_type:'yue',paid:true}}); await pending;
    assert.equal(r.checkout.paying.value,false); assert.equal(r.navigations.length,0); await r.checkout.pay();
    assert.equal(r.calls.filter(c => c.url.endsWith('/order/pay')).length,1);
    await r.checkout.load(); assert.equal(r.checkout.actionError.value,'');
  } finally { waiting.resolve({ status:400 }); r.stop(); }
});
test('UniApp detail read started during payment cannot unlock retry if it returns after payment', async () => {
  const payment = deferred(), reading = deferred(); let delayRead = false;
  const r = setup(c => c.url.endsWith('/order/pay') ? payment.promise : delayRead && c.url.includes('/detail/') ? reading.promise : undefined);
  try { await r.start({orderId:'local_A'}); const pending = r.checkout.pay(); await tick(); r.hooks.onHide(); delayRead=true; r.hooks.onShow(); await tick();
    payment.resolve({data:{order_id:'local_A',pay_type:'yue',paid:true}}); await pending; assert.equal(r.checkout.paying.value,false);
    reading.resolve({data:detail('local_A')}); await tick(); assert.match(r.checkout.actionError.value,/处理中/);
    await r.checkout.pay(); assert.equal(r.calls.filter(c=>c.url.endsWith('/order/pay')).length,1);
  } finally { payment.resolve({status:400}); reading.resolve({status:400}); r.stop(); }
});
test('UniApp detail H5 hash reuse clears the old view and rejects ambiguous IDs', async () => {
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'window'), handlers=new Map();
  Object.defineProperty(globalThis,'window',{configurable:true,value:{location:{hash:'#/pages/order/detail?orderId=local_A'},addEventListener:(name,fn)=>handlers.set(name,fn),removeEventListener:name=>handlers.delete(name)}});
  const r=setup();
  try { await r.start({orderId:'local_A'}); window.location.hash='#/pages/order/detail?orderId=local_B'; handlers.get('hashchange')();
    assert.equal(r.checkout.order.value,null); await tick(); assert.equal(r.checkout.order.value.order_id,'local_B');
    window.location.hash='#/pages/order/detail?orderId=local_A&orderId=local_B'; handlers.get('hashchange')();
    assert.equal(r.checkout.order.value,null); assert.ok(r.checkout.loadError.value);
  } finally { r.stop(); assert.equal(handlers.size,0); if(descriptor) Object.defineProperty(globalThis,'window',descriptor); else delete globalThis.window; }
});
