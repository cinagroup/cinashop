const test = require('node:test');
const assert = require('node:assert/strict');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');
const detail = id => ({ orderId: id, uid: 11, paid: 0, payPrice: '10.00', totalPrice: '10.00', status: 0, type: 0,
  pid: 0, supplierAllocationStatus: 0, productType: 0, cartInfo: [], customForm: [], realName: '本地私有联系人' });
const repurchaseDetail = (id = 'local_A', change = {}) => ({ ...detail(id), id: 501, paid: 1, status: 2,
  refundStatus: 0, supplierAllocationStatus: 2, cartInfo: [{ id: 701, type: 2, cartNum: 2 }], ...change });
const repurchaseResult = (change = {}) => ({ cartIds: [901, 902], cateId: '901,902', sourceOrderId: 'local_A', sourceRowId: 501, ...change });
function repurchaseSetup(override = () => undefined) {
  return setup(c => {
    if (c.url.endsWith('/order/again')) assert.equal(c.method, 'POST');
    return override(c) ?? (c.url.includes('/order/detail/') ? { data: repurchaseDetail(c.url.split('/').at(-1)) }
      : c.url.endsWith('/order/again') ? { data: repurchaseResult() } : undefined);
  });
}
test('UniApp actual repurchase posts PHP uni and navigates only to its acknowledged direct-buy selection', async () => {
  const r = repurchaseSetup();
  try { await r.start({ orderId: 'local_A' }); assert.equal(r.checkout.canRepurchase.value, true);
    await r.checkout.prepareRepurchase();
    const writes = r.calls.filter(c => c.url.endsWith('/order/again')); assert.equal(writes.length, 1);
    assert.match(writes[0].url, /\/order\/again$/); assert.deepEqual(writes[0].data, { uni: 'local_A' });
    assert.deepEqual(r.navigations, ['/pages/order/confirm?mode=buy&cartIds=901,902']);
  } finally { r.stop(); }
});
test('UniApp duplicate repurchase taps keep one frozen original order request', async () => {
  const waiting = deferred(), r = repurchaseSetup(c => c.url.endsWith('/order/again') ? waiting.promise : undefined);
  try { await r.start({ orderId: 'local_A' }); const pending = r.checkout.prepareRepurchase();
    await r.checkout.prepareRepurchase(); await tick(); assert.equal(r.calls.filter(c => c.url.endsWith('/order/again')).length, 1);
    waiting.resolve({ data: repurchaseResult() }); await pending;
    assert.deepEqual(r.navigations, ['/pages/order/confirm?mode=buy&cartIds=901,902']);
  } finally { waiting.resolve({ status: 400 }); r.stop(); }
});
for (const change of [{ sourceOrderId: 'local_B' }, { sourceRowId: 502 }, { cartIds: [] },
  { cartIds: [901, 901], cateId: '901,901' }, { cartIds: ['901'], cateId: '901' }, { cateId: '902,901' }]) {
  test(`UniApp malformed repurchase result cannot navigate or retry after refresh ${JSON.stringify(change)}`, async () => {
    const r = repurchaseSetup(c => c.url.endsWith('/order/again') ? { data: repurchaseResult(change) } : undefined);
    try { await r.start({ orderId: 'local_A' }); await r.checkout.prepareRepurchase();
      assert.equal(r.checkout.repurchase.uncertain, true); assert.match(r.checkout.repurchase.error, /尚未确认/);
      await r.checkout.load(); await r.checkout.prepareRepurchase();
      assert.equal(r.calls.filter(c => c.url.endsWith('/order/again')).length, 1); assert.deepEqual(r.navigations, []);
    } finally { r.stop(); }
  });
}
test('UniApp definitive repurchase rejection can be retried after correcting current product availability', async () => {
  let reject = true; const r = repurchaseSetup(c => reject && c.url.endsWith('/order/again') ? { status: 400, msg: '商品已下架' } : undefined);
  try { await r.start({ orderId: 'local_A' }); await r.checkout.prepareRepurchase();
    assert.equal(r.checkout.repurchase.uncertain, false); assert.match(r.checkout.repurchase.error, /下架/);
    reject = false; await r.checkout.prepareRepurchase();
    assert.equal(r.calls.filter(c => c.url.endsWith('/order/again')).length, 2); assert.equal(r.navigations.length, 1);
  } finally { r.stop(); }
});
test('UniApp navigation failure retains acknowledged rows and continuation sends no second repurchase', async () => {
  const r = repurchaseSetup(); let fail = true;
  r.uni.navigateTo = options => { r.navigations.push(options.url); if (fail) options.fail?.(); else options.success?.(); };
  try { await r.start({ orderId: 'local_A' }); await r.checkout.prepareRepurchase();
    assert.deepEqual([...r.checkout.repurchase.cartIds], [901, 902]); assert.match(r.checkout.repurchase.error, /结算页未打开/);
    fail = false; await r.checkout.prepareRepurchase();
    assert.equal(r.calls.filter(c => c.url.endsWith('/order/again')).length, 1); assert.equal(r.navigations.length, 2);
  } finally { r.stop(); }
});
for (const ending of ['identity', 'route', 'onUnload']) test(`UniApp late repurchase cannot affect a new context after ${ending}`, async () => {
  const waiting = deferred(), r = repurchaseSetup(c => c.url.endsWith('/order/again') ? waiting.promise : undefined);
  try { await r.start({ orderId: 'local_A' }); const pending = r.checkout.prepareRepurchase(); await tick();
    if (ending === 'identity') r.auth.setLogin('repurchase-owner', 22);
    else if (ending === 'route') await r.start({ orderId: 'local_B' });
    else r.hooks.onUnload();
    waiting.resolve({ data: repurchaseResult() }); await pending;
    assert.deepEqual(r.navigations, []); assert.deepEqual([...r.checkout.repurchase.cartIds], []);
  } finally { waiting.resolve({ status: 400 }); r.stop(); }
});
test('UniApp hide/show during repurchase keeps one request and retains its acknowledged IDs for explicit continuation', async () => {
  const waiting = deferred(), r = repurchaseSetup(c => c.url.endsWith('/order/again') ? waiting.promise : undefined);
  try { await r.start({ orderId: 'local_A' }); const pending = r.checkout.prepareRepurchase(); await tick();
    r.hooks.onHide(); r.hooks.onShow(); await tick(); await r.checkout.prepareRepurchase();
    assert.equal(r.calls.filter(c => c.url.endsWith('/order/again')).length, 1);
    waiting.resolve({ data: repurchaseResult() }); await pending;
    assert.deepEqual(r.navigations, []); assert.deepEqual([...r.checkout.repurchase.cartIds], [901, 902]);
    await r.checkout.prepareRepurchase(); assert.equal(r.calls.filter(c => c.url.endsWith('/order/again')).length, 1);
    assert.deepEqual(r.navigations, ['/pages/order/confirm?mode=buy&cartIds=901,902']);
  } finally { waiting.resolve({ status: 400 }); r.stop(); }
});
test('UniApp pending repurchase cannot attach to a replacement physical source with the same public ID', async () => {
  let rowId = 501; const waiting = deferred(), r = repurchaseSetup(c => c.url.endsWith('/order/again') ? waiting.promise
    : c.url.includes('/detail/') ? { data: repurchaseDetail('local_A', { id: rowId }) } : undefined);
  try { await r.start({ orderId: 'local_A' }); const pending = r.checkout.prepareRepurchase(); await tick(); rowId = 502; await r.checkout.load();
    waiting.resolve({ data: repurchaseResult() }); await pending;
    assert.deepEqual([...r.checkout.repurchase.cartIds], []); assert.deepEqual(r.navigations, []);
  } finally { waiting.resolve({ status: 400 }); r.stop(); }
});
test('UniApp Supplier lines expose repurchase only in the mounted PHP received/completed states', async () => {
  for (const status of [0, 1, 2, 3, 5]) {
    const r = repurchaseSetup(c => c.url.includes('/detail/') ? { data: repurchaseDetail('local_A', { status }) } : undefined);
    try { await r.start({ orderId: 'local_A' }); assert.equal(r.checkout.canRepurchase.value, [2, 3].includes(status));
      if (![2, 3].includes(status)) { await r.checkout.prepareRepurchase(); assert.equal(r.calls.filter(c => c.url.endsWith('/order/again')).length, 0); } }
    finally { r.stop(); }
  }
});
test('UniApp pending allocation, activity, refund and empty source do not expose repurchase', async () => {
  for (const change of [{ type: 1 }, { refundStatus: 1 }, { supplierAllocationStatus: 1 }, { cartInfo: [] }]) {
    const r = repurchaseSetup(c => c.url.includes('/detail/') ? { data: repurchaseDetail('local_A', change) } : undefined);
    try { await r.start({ orderId: 'local_A' }); assert.equal(r.checkout.canRepurchase.value, false);
      await r.checkout.prepareRepurchase(); assert.equal(r.calls.filter(c => c.url.endsWith('/order/again')).length, 0);
    } finally { r.stop(); }
  }
});
test('UniApp lost repurchase acknowledgement stays uncertain after an explicit source read', async () => {
  const r = repurchaseSetup(c => c.url.endsWith('/order/again') ? { transport: 'owned lost acknowledgement' } : undefined);
  try { await r.start({ orderId: 'local_A' }); await r.checkout.prepareRepurchase(); assert.equal(r.checkout.repurchase.uncertain, true);
    await r.checkout.load(); assert.equal(r.checkout.order.value.order_id, 'local_A'); await r.checkout.prepareRepurchase();
    assert.equal(r.calls.filter(c => c.url.endsWith('/order/again')).length, 1); assert.deepEqual(r.navigations, []);
  } finally { r.stop(); }
});
test('UniApp order A to B to A invalidates the first view generation acknowledgement', async () => {
  const waiting = deferred(), r = repurchaseSetup(c => c.url.endsWith('/order/again') ? waiting.promise : undefined);
  try { await r.start({ orderId: 'local_A' }); const pending = r.checkout.prepareRepurchase(); await tick();
    await r.start({ orderId: 'local_B' }); await r.start({ orderId: 'local_A' });
    waiting.resolve({ data: repurchaseResult() }); await pending;
    assert.deepEqual([...r.checkout.repurchase.cartIds], []); assert.deepEqual(r.navigations, []);
  } finally { waiting.resolve({ status: 400 }); r.stop(); }
});
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
