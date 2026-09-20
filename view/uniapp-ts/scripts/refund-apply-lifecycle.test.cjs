const test=require('node:test');const assert=require('node:assert/strict');
const {runtime,tick,deferred}=require('./uni-store-runtime.cjs');
const detail=(id='local_A',change={})=>({id:100,uid:11,orderId:id,paid:1,payPrice:'10.00',status:0,productType:0,pid:0,supplierAllocationStatus:0,refundStatus:0,
  cartInfo:[{id:1,oid:100,cartId:'500',cartNum:2,refundNum:0,isSupportRefund:1,writeTimes:0,writeSurplusTimes:0,cartInfo:{product:{storeName:'本地商品'},sku:{price:'5.00',suk:'红色'}}}],...change});
const setup=(override=()=>undefined)=>runtime({component:'pages/order/refundApply.vue',send:c=>override(c)??{data:c.url.includes('/refund/apply/')?{refundId:91}:detail(c.url.split('/').at(-1))}});
test('UniApp refund clears the old order, selection and reason on hide',async()=>{
  const r=setup();try{await r.start({orderId:'local_A'});r.checkout.selectedIds.value=[1];r.checkout.reason.value='其他';r.hooks.onHide?.();
    assert.equal(r.checkout.order.value,null);assert.deepEqual(r.checkout.selectedIds.value,[]);assert.equal(r.checkout.reason.value,'');
  }finally{r.stop();}
});
test('UniApp refund repeated submit dispatches one request',async()=>{
  const waiting=deferred(),r=setup(c=>c.url.includes('/refund/apply/')?waiting.promise:undefined);
  try{await r.start({orderId:'local_A'});r.checkout.selectedIds.value=[1];r.checkout.reason.value='其他';
    const first=r.checkout.submit(),second=r.checkout.submit();await tick();assert.equal(r.calls.filter(c=>c.url.includes('/refund/apply/')).length,1);
    waiting.resolve({data:{refundId:91}});await Promise.all([first,second]);
  }finally{waiting.resolve({status:400});r.stop();}
});
test('UniApp refund account replacement cannot retain the previous application form',async()=>{
  const r=setup();try{await r.start({orderId:'local_A'});r.checkout.selectedIds.value=[1];r.auth.setLogin('other',22);
    assert.equal(r.checkout.order.value,null);assert.deepEqual(r.checkout.selectedIds.value,[]);
  }finally{r.stop();}
});
const fill=r=>{r.checkout.selectedIds.value=[1];r.checkout.reason.value='  其他  ';};
const posts=r=>r.calls.filter(c=>c.url.includes('/refund/apply/'));
for(const [name,change] of Object.entries({foreign:{uid:22},wrongOrder:{orderId:'other'},invalidAmount:{payPrice:'NaN'},missingLines:{cartInfo:[]},
  foreignLine:{cartInfo:[{...detail().cartInfo[0],oid:200}]},duplicateLines:{cartInfo:[...detail().cartInfo,...detail().cartInfo]},
  malformedFlag:{cartInfo:[{...detail().cartInfo[0],isSupportRefund:'1'}]}})){
  test(`UniApp refund rejects ${name} responses before editing`,async()=>{
    const r=setup(()=>({data:detail('local_A',change)}));try{await r.start({orderId:'local_A'});fill(r);await r.checkout.submit();
      assert.equal(r.checkout.order.value,null);assert.ok(r.checkout.state.loadError);assert.equal(posts(r).length,0);
    }finally{r.stop();}
  });
}
for(const change of [{paid:0},{pid:-1},{supplierAllocationStatus:1},{status:-2},{productType:1}]){
  test(`UniApp refund blocks ineligible order ${JSON.stringify(change)}`,async()=>{
    const r=setup(()=>({data:detail('local_A',change)}));try{await r.start({orderId:'local_A'});fill(r);await r.checkout.submit();
      assert.ok(r.checkout.refundBlockedReason.value);assert.equal(posts(r).length,0);
    }finally{r.stop();}
  });
}
test('UniApp refund validates selection, type and reason before native I/O',async()=>{
  const r=setup();try{await r.start({orderId:'local_A'});
    for(const ids of [[],[1,1],[999]]){fill(r);r.checkout.selectedIds.value=ids;await r.checkout.submit();}
    fill(r);r.checkout.state.form.applyType=4;await r.checkout.submit();
    r.checkout.state.form.applyType=1;r.checkout.reason.value=' '.repeat(4);await r.checkout.submit();
    r.checkout.reason.value='x'.repeat(256);await r.checkout.submit();
    fill(r);r.checkout.explain.value='x'.repeat(256);await r.checkout.submit();
    assert.equal(posts(r).length,0);
  }finally{r.stop();}
});
test('UniApp refund forbids nonrefundable or already written-off lines',async()=>{
  for(const row of [{isSupportRefund:0},{refundNum:2},{writeTimes:1,writeSurplusTimes:0}]){
    const r=setup(()=>({data:detail('local_A',{cartInfo:[{...detail().cartInfo[0],...row}]})}));try{await r.start({orderId:'local_A'});fill(r);await r.checkout.submit();assert.equal(posts(r).length,0);}finally{r.stop();}
  }
});
test('UniApp refund snapshots the body and preserves the exact receipt for navigation-only recovery',async()=>{
  const waiting=deferred(),r=setup(c=>c.url.includes('/refund/apply/')?waiting.promise:undefined);
  try{await r.start({orderId:'local_A'});fill(r);r.checkout.state.form.applyType=2;
    const pending=r.checkout.submit();r.checkout.selectedIds.value.push(999);r.checkout.reason.value='changed';await tick();
    assert.deepEqual(posts(r)[0].data,{cartIds:[1],applyType:2,refundReason:'其他',refundExplain:''});
    waiting.resolve({data:{refundId:91}});await pending;assert.equal(r.checkout.state.refundId,91);assert.equal(r.navigations.length,0);
    r.uni.navigateTo=opts=>{r.navigations.push(opts.url);opts.fail();};r.checkout.goRefund();assert.match(r.checkout.navigationError.value,/不会重复/);
    r.checkout.goRefund();await r.checkout.load();fill(r);await r.checkout.submit();
    assert.equal(r.checkout.state.refundId,91);assert.equal(posts(r).length,1);assert.deepEqual(r.navigations,['/pages/order/refundDetail?id=91','/pages/order/refundDetail?id=91']);
  }finally{waiting.resolve({status:400});r.stop();}
});
for(const reply of [{transport:'connection lost'},{status:500,msg:'unknown'},{data:{id:91}},{data:{refundId:0}}]){
  test(`UniApp refund uncertain receipt cannot be resubmitted after read refresh ${JSON.stringify(reply)}`,async()=>{
    const r=setup(c=>c.url.includes('/refund/apply/')?reply:undefined);try{await r.start({orderId:'local_A'});fill(r);await r.checkout.submit();
      assert.equal(r.checkout.state.uncertain,true);await r.checkout.load();fill(r);await r.checkout.submit();assert.equal(posts(r).length,1);
      r.checkout.goRefund();assert.deepEqual(r.navigations,['/pages/order/refundList']);
    }finally{r.stop();}
  });
}
test('UniApp refund explicit rejection permits corrected retry; virtual orders reject return type',async()=>{
  const r=setup(c=>c.url.includes('/refund/apply/')?{status:400,msg:'明确拒绝'}:{data:detail('local_A',{productType:3})});
  try{await r.start({orderId:'local_A'});fill(r);r.checkout.state.form.applyType=2;await r.checkout.submit();assert.equal(posts(r).length,0);
    r.checkout.state.form.applyType=1;await r.checkout.submit();assert.equal(r.checkout.state.uncertain,false);await r.checkout.submit();assert.equal(posts(r).length,2);
  }finally{r.stop();}
});
test('UniApp refund hide during submit retains uncertainty and ignores the late success',async()=>{
  const waiting=deferred(),r=setup(c=>c.url.includes('/refund/apply/')?waiting.promise:undefined);
  try{await r.start({orderId:'local_A'});fill(r);const pending=r.checkout.submit();await tick();r.hooks.onHide();
    waiting.resolve({data:{refundId:91}});await pending;r.hooks.onShow();await tick();fill(r);await r.checkout.submit();
    assert.equal(r.checkout.state.uncertain,true);assert.equal(r.checkout.state.refundId,0);assert.equal(posts(r).length,1);
  }finally{waiting.resolve({status:400});r.stop();}
});
test('UniApp refund late read and write cannot restore another identity',async()=>{
  for(const writing of [false,true]){
    const waiting=deferred(),r=setup(c=>(writing?c.url.includes('/refund/apply/'):c.url.includes('/order/detail/'))?waiting.promise:undefined);
    try{await r.start({orderId:'local_A'});let pending;if(writing){fill(r);pending=r.checkout.submit();await tick();}
      r.auth.setLogin('replacement',22);waiting.resolve({data:writing?{refundId:91}:detail()});await pending;await tick();
      assert.equal(r.checkout.order.value,null);assert.equal(r.checkout.state.refundId,0);assert.equal(r.navigations.length,0);
    }finally{waiting.resolve({status:400});r.stop();}
  }
});
test('UniApp refund invalid route never reads; anonymous login is explicit and no auth listener survives unload',async()=>{
  const r=setup();try{await r.start({orderId:'../bad'});assert.equal(r.calls.length,0);
    r.hooks.onLoad({orderId:'local_A'});r.auth.clear();await r.checkout.load();assert.equal(r.calls.length,0);r.checkout.login();assert.deepEqual(r.navigations,['/pages/auth/login']);
    r.hooks.onUnload();r.auth.setLogin('again',11);assert.equal(r.checkout.state.loadError,'');
  }finally{r.stop();}
});
test('UniApp refund H5 hash changes clear the form and reject duplicate order IDs with listener cleanup',async()=>{
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'window'),handlers=new Map();
  Object.defineProperty(globalThis,'window',{configurable:true,value:{location:{hash:'#/pages/order/refundApply?orderId=local_A'},addEventListener:(name,fn)=>handlers.set(name,fn),removeEventListener:name=>handlers.delete(name)}});
  const r=setup();try{await r.start({orderId:'local_A'});fill(r);
    window.location.hash='#/pages/order/refundApply?orderId=local_A&orderId=local_B';handlers.get('hashchange')();await tick();
    assert.equal(r.checkout.order.value,null);assert.equal(r.checkout.reason.value,'');assert.equal(r.calls.length,1);
    window.location.hash='#/pages/order/refundApply?orderId=local_B';handlers.get('hashchange')();await tick();assert.equal(r.checkout.order.value.order_id,'local_B');
    window.location.hash='#/pages/order/list';handlers.get('hashchange')();assert.equal(r.checkout.order.value,null);assert.equal(r.calls.length,2);
  }finally{r.stop();assert.equal(handlers.size,0);if(descriptor)Object.defineProperty(globalThis,'window',descriptor);else delete globalThis.window;}
});
