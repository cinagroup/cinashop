const test = require('node:test');
const assert = require('node:assert/strict');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');
const detail = (id = 'result_A', change = {}) => ({ orderId:id, uid:11, paid:0,
  payPrice:'10.00', status:0, refundStatus:0, payType:'weixin', cartInfo:[], ...change });
const setup = (send = c => ({ data:detail(c.url.split('/').at(-1)) })) =>
  runtime({ component:'pages/order/payResult.vue', send });

test('payment result does not accept URL success or amount as payment evidence', async () => {
  const r=setup(); try { await r.start({orderId:'result_A',status:'ok',amount:'99999.00'});
    assert.equal(r.checkout.success.value,false); assert.equal(r.checkout.amount.value,'10.00');
    assert.equal(r.calls.length,1); assert.ok(r.calls[0].url.endsWith('/order/detail/result_A'));
  } finally { r.stop(); }
});
test('payment result without an order cannot show success or issue a request', async () => {
  const r=setup(); try { await r.start({status:'ok',amount:'9.00'});
    assert.equal(r.checkout.success.value,false); assert.equal(r.checkout.amount.value,''); assert.equal(r.calls.length,0);
  } finally { r.stop(); }
});
test('payment result confirms server-paid order even when return URL says failure', async () => {
  const r=setup(c=>({data:detail(c.url.split('/').at(-1),{paid:1})}));
  try { await r.start({orderId:'result_A',status:'fail',amount:'0.01'});
    assert.equal(r.checkout.success.value,true); assert.equal(r.checkout.amount.value,'10.00'); assert.equal(r.calls.length,1);
  } finally { r.stop(); }
});

for (const [change,state] of [[{paid:0,payType:'offline'},'offline'],[{paid:0,status:-2},'cancelled'],
  [{paid:1,refundStatus:1},'refunding'],[{paid:1,refundStatus:2},'refunded'],[{paid:1,refundStatus:4},'refunding']]) {
  test(`payment result preserves server ${state} state ${JSON.stringify(change)}`, async()=>{
    const r=setup(()=>({data:detail('result_A',change)}));try{await r.start({orderId:'result_A',status:'ok'});
      assert.equal(r.checkout.resultState.value,state);assert.equal(r.checkout.success.value,false);
    }finally{r.stop();}
  });
}
for (const change of [{uid:22},{orderId:'foreign'},{paid:2},{payPrice:'oops'},{status:'3'},{refundStatus:7},{payType:false}]) {
  test(`payment result rejects foreign or malformed response ${JSON.stringify(change)}`,async()=>{
    const r=setup(()=>({data:detail('result_A',{paid:1,...change})}));try{await r.start({orderId:'result_A'});
      assert.equal(r.checkout.success.value,false);assert.equal(r.checkout.amount.value,'');
      assert.equal(r.checkout.verified.value,null);assert.ok(r.checkout.loadError.value);
    }finally{r.stop();}
  });
}
for (const id of ['../foreign',['result_A','result_B'],null,'A'.repeat(97)]) {
  test(`payment result rejects invalid route ${JSON.stringify(id)}`,async()=>{
    const r=setup();try{await r.start({orderId:id});assert.equal(r.calls.length,0);assert.ok(r.checkout.routeError.value);
      r.checkout.goOrder();assert.equal(r.navigations.length,0);
    }finally{r.stop();}
  });
}
test('payment result clears confirmed result on failed refresh and retries read only',async()=>{
  let fail=false;const r=setup(()=>fail?{transport:'本地读取中断'}:{data:detail('result_A',{paid:1,realName:'not retained',virtualInfo:['secret']})});
  try{await r.start({orderId:'result_A'});assert.equal(r.checkout.success.value,true);
    assert.deepEqual(Object.keys(r.checkout.verified.value).sort(),['amount','paid','payType','refundStatus','status']);
    fail=true;await r.checkout.load();assert.equal(r.checkout.success.value,false);assert.equal(r.checkout.amount.value,'');
    assert.equal(r.checkout.resultState.value,'unknown');assert.match(r.checkout.loadError.value,/中断/);
    fail=false;await r.checkout.load();assert.equal(r.checkout.success.value,true);
    assert.equal(r.calls.length,3);assert.ok(r.calls.every(c=>c.url.endsWith('/order/detail/result_A')));
  }finally{r.stop();}
});
test('payment result serializes repeated read requests and has no pre-response success',async()=>{
  const waiting=deferred(),r=setup(()=>waiting.promise);
  try{await r.start({orderId:'result_A',status:'ok'});await r.checkout.load();await r.checkout.load();
    assert.equal(r.calls.length,1);assert.equal(r.checkout.loading.value,true);assert.equal(r.checkout.success.value,false);
    waiting.resolve({data:detail('result_A',{paid:1})});await tick();assert.equal(r.checkout.success.value,true);
  }finally{waiting.resolve({status:400});r.stop();}
});
for(const ending of ['identity','onHide','onUnload','route'])test(`payment result discards a late paid response after ${ending}`,async()=>{
  const waiting=deferred(),r=setup(c=>c.url.endsWith('/result_A')?waiting.promise:{data:detail('result_B')});
  try{await r.start({orderId:'result_A'});
    if(ending==='identity')r.auth.setLogin('another-session',22);
    else if(ending==='route')await r.start({orderId:'result_B'});else r.hooks[ending]();
    waiting.resolve({data:detail('result_A',{paid:1})});await tick();assert.equal(r.checkout.success.value,false);
    assert.equal(r.checkout.amount.value,ending==='route'?'10.00':'');assert.equal(r.navigations.length,0);
  }finally{waiting.resolve({status:400});r.stop();}
});
test('payment result clears visible success on identity change and never requests anonymously',async()=>{
  const r=setup(()=>({data:detail('result_A',{paid:1})}));try{await r.start({orderId:'result_A'});r.auth.clear();
    assert.equal(r.checkout.success.value,false);assert.equal(r.checkout.amount.value,'');await r.checkout.load();assert.equal(r.calls.length,1);
    assert.equal(r.checkout.resultState.value,'login');r.checkout.login();assert.deepEqual(r.navigations,['/pages/auth/login']);
    r.hooks.onHide();r.auth.setLogin('returned',11);r.hooks.onShow();await tick();assert.equal(r.checkout.success.value,true);assert.equal(r.calls.length,2);
  }finally{r.stop();}
});
test('payment result onShow rechecks instead of restoring the old paid result',async()=>{
  let paid=1;const r=setup(()=>({data:detail('result_A',{paid})}));try{await r.start({orderId:'result_A'});r.hooks.onHide();
    assert.equal(r.checkout.success.value,false);assert.equal(r.checkout.amount.value,'');paid=0;r.hooks.onShow();await tick();
    assert.equal(r.checkout.success.value,false);assert.equal(r.checkout.resultState.value,'unpaid');assert.equal(r.calls.length,2);
  }finally{r.stop();}
});
test('payment result navigation retry is read-only and late failure belongs to its original view',async()=>{
  const r=setup();let fail;r.uni.redirectTo=opts=>{r.navigations.push(opts.url);fail=opts.fail;};
  try{await r.start({orderId:'result_A'});r.checkout.goOrder();r.checkout.goOrder();assert.equal(r.navigations.length,1);
    fail();assert.ok(r.checkout.navigationError.value);r.checkout.goOrder();assert.equal(r.navigations.length,2);assert.equal(r.calls.length,1);
    r.hooks.onHide();r.hooks.onShow();await tick();fail();assert.equal(r.checkout.navigationError.value,'');
    assert.deepEqual(r.navigations,['/pages/order/detail?orderId=result_A','/pages/order/detail?orderId=result_A']);
  }finally{r.stop();}
});
test('payment result H5 route identity and duplicate IDs are isolated with listener cleanup',async()=>{
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'window'),handlers=new Map();
  Object.defineProperty(globalThis,'window',{configurable:true,value:{location:{hash:'#/pages/order/payResult?orderId=result_A&status=ok&amount=999'},addEventListener:(name,fn)=>handlers.set(name,fn),removeEventListener:name=>handlers.delete(name)}});
  const r=setup(c=>({data:detail(c.url.split('/').at(-1),{paid:1})}));
  try{await r.start({orderId:'result_A'});assert.equal(r.checkout.amount.value,'10.00');
    window.location.hash='#/pages/order/payResult?orderId=result_A&orderId=result_B';handlers.get('hashchange')();await tick();
    assert.equal(r.checkout.success.value,false);assert.equal(r.checkout.amount.value,'');assert.equal(r.calls.length,1);
    window.location.hash='#/pages/order/payResult?orderId=result_B';handlers.get('hashchange')();await tick();
    assert.equal(r.checkout.orderId.value,'result_B');assert.equal(r.checkout.success.value,true);
    window.location.hash='#/pages/order/list';handlers.get('hashchange')();assert.equal(r.checkout.amount.value,'');assert.equal(r.calls.length,2);
  }finally{r.stop();assert.equal(handlers.size,0);if(descriptor)Object.defineProperty(globalThis,'window',descriptor);else delete globalThis.window;}
});
