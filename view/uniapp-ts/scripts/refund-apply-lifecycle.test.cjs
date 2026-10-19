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
    assert.deepEqual(posts(r)[0].data,{cart_ids:[{cart_id:1,cart_num:2}],applyType:2,refundReason:'其他',refundExplain:''});
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


const uploadedImage = (id = 31) => ({ att_id: id, url: `/api/assets/${id}`, src: `/api/assets/${id}?expires=1700001000&signature=${'a'.repeat(43)}`, size: 68, type: 'image/png' });
function applicationUpload(r, id = 31) {
  r.uni.chooseImage = options => options.success({ tempFilePaths: ['owned-local.png'], tempFiles: [{ size: 68 }] });
  const calls = [];
  r.uni.uploadFile = options => { calls.push(options); options.success({ statusCode: 200, data: JSON.stringify({ status: 200, data: uploadedImage(id) }) }); };
  return calls;
}
test('application images use actual upload API and store only canonical references in the frozen request', async () => {
  const wait = deferred(), r = setup(c => c.url.includes('/refund/apply/') ? wait.promise : undefined), uploads = applicationUpload(r);
  try {
    await r.start({ orderId: 'local_A' }); fill(r); await r.checkout.uploadApplicationImage();
    assert.equal(uploads.length, 1); assert.equal(uploads[0].url, '/api/upload/image'); assert.equal(uploads[0].header['Authori-zation'], 'Bearer synthetic-local-token');
    assert.equal(r.checkout.state.images.length, 1); const pending = r.checkout.submit(); await tick();
    r.checkout.state.images.push(uploadedImage(32));
    assert.equal(posts(r)[0].data.refundImg, '["/api/assets/31"]'); assert.ok(!JSON.stringify(posts(r)[0].data).includes('signature'));
    wait.resolve({ data: { refundId: 91 } }); await pending;
  } finally { wait.resolve({ status: 400 }); r.stop(); }
});
test('application image upload locks repeated picker, submit, refresh and navigation until completion', async () => {
  const r = setup(); let pendingUpload, picks = 0;
  r.uni.chooseImage = options => { picks++; options.success({ tempFilePaths: ['owned.png'], tempFiles: [{ size: 68 }] }); };
  r.uni.uploadFile = options => { pendingUpload = options; };
  try {
    await r.start({ orderId: 'local_A' }); fill(r); const pending = r.checkout.uploadApplicationImage(); await tick();
    await r.checkout.uploadApplicationImage(); await r.checkout.submit(); await r.checkout.load(); r.checkout.goRefund();
    assert.equal(picks, 1); assert.equal(posts(r).length, 0); assert.equal(r.calls.length, 1); assert.equal(r.checkout.editable.value, false);
    pendingUpload.success({ statusCode: 200, data: JSON.stringify({ status: 200, data: uploadedImage() }) }); await pending;
    assert.equal(r.checkout.state.uploading, false); assert.equal(r.checkout.editable.value, true);
  } finally { r.stop(); }
});
for (const ending of ['auth', 'hide', 'unload', 'route']) test(`application image late upload cannot cross ${ending}`, async () => {
  const r = setup(); let pendingUpload;
  applicationUpload(r); r.uni.uploadFile = options => { pendingUpload = options; };
  try {
    await r.start({ orderId: 'local_A' }); const pending = r.checkout.uploadApplicationImage(); await tick();
    if (ending === 'auth') r.auth.setLogin('replacement', 22);
    if (ending === 'hide') r.hooks.onHide();
    if (ending === 'unload') r.hooks.onUnload();
    if (ending === 'route') r.hooks.onLoad({ orderId: 'local_B' });
    pendingUpload.success({ statusCode: 200, data: JSON.stringify({ status: 200, data: uploadedImage() }) }); await pending;
    assert.deepEqual(r.checkout.state.images, []); assert.equal(r.checkout.state.uploading, false); assert.equal(posts(r).length, 0);
  } finally { r.stop(); }
});
for (const invalid of [
  { ...uploadedImage(), url: '/api/assets/32' }, { ...uploadedImage(), att_id: '31' }, { ...uploadedImage(), size: 0 },
  { ...uploadedImage(), src: 'javascript:alert(1)' }, { ...uploadedImage(), type: 'text/html' },
  { ...uploadedImage(), url: 'https://legacy.invalid/img.png', src: 'https://legacy.invalid/img.png' },
]) test(`application image rejects invalid upload receipt ${JSON.stringify(invalid)}`, async () => {
  const r = setup(); applicationUpload(r); r.uni.uploadFile = options => options.success({ statusCode: 200, data: JSON.stringify({ status: 200, data: invalid }) });
  try { await r.start({ orderId: 'local_A' }); await r.checkout.uploadApplicationImage(); assert.deepEqual(r.checkout.state.images, []); assert.ok(r.checkout.state.submitError); assert.equal(r.checkout.state.uploading, false); }
  finally { r.stop(); }
});
test('application upload enforces three distinct images, removal and explicit failure recovery', async () => {
  const r = setup(); const calls = applicationUpload(r);
  try {
    await r.start({ orderId: 'local_A' }); await r.checkout.uploadApplicationImage(); await r.checkout.uploadApplicationImage();
    assert.equal(r.checkout.state.images.length, 1); assert.match(r.checkout.state.submitError, /已添加/);
    for (const id of [32, 33]) { r.uni.uploadFile = options => options.success({ statusCode: 200, data: JSON.stringify({ status: 200, data: uploadedImage(id) }) }); await r.checkout.uploadApplicationImage(); }
    r.uni.chooseImage = () => { throw Error('must not pick fourth'); }; await r.checkout.uploadApplicationImage(); assert.equal(r.checkout.state.images.length, 3);
    r.checkout.imageFailed('/api/assets/31'); assert.deepEqual(r.checkout.failedImages.value, ['/api/assets/31']);
    r.checkout.removeApplicationImage(0); assert.equal(r.checkout.state.images.length, 2); assert.deepEqual(r.checkout.failedImages.value, []);
    r.hooks.onHide(); assert.deepEqual(r.checkout.state.images, []);
  } finally { r.stop(); }
});
test('application picker cancellation, oversized local files and failed transfer preserve retry without claiming submit uncertainty', async () => {
  const r = setup(); let uploads = 0;
  try {
    await r.start({ orderId: 'local_A' }); r.uni.chooseImage = options => options.fail({ errMsg: 'chooseImage:fail cancel' });
    await r.checkout.uploadApplicationImage(); assert.equal(r.checkout.state.submitError, '');
    r.uni.chooseImage = options => options.success({ tempFilePaths: ['large.png'], tempFiles: [{ size: 10485761 }] });
    r.uni.uploadFile = options => { uploads++; options.fail({}); }; await r.checkout.uploadApplicationImage(); assert.equal(uploads, 0);
    r.uni.chooseImage = options => options.success({ tempFilePaths: ['owned.png'], tempFiles: [{ size: 68 }] }); await r.checkout.uploadApplicationImage();
    assert.equal(uploads, 1); assert.equal(r.checkout.state.uncertain, false); assert.deepEqual(r.checkout.state.images, []); assert.equal(r.checkout.state.uploading, false);
  } finally { r.stop(); }
});

const quantityInput = (r, value, item = r.checkout.state.items[0]) => r.checkout.editQuantity(item, { detail: { value } });
const appliedBody = r => posts(r)[0].data;
test('UniApp partial refund distinguishes purchased and remaining counts and sends explicit quantities through the actual HTTP adapter', async () => {
  const r = setup(c => c.url.includes('/refund/apply/') ? undefined : { data: detail('local_A', { cartInfo: [{ ...detail().cartInfo[0], cartNum: 5, refundNum: 2 }] }) });
  try {
    await r.start({ orderId: 'local_A' }); fill(r); const item = r.checkout.state.items[0]; assert.equal(item.quantity, 5); assert.equal(item.remainingQuantity, 3); assert.equal(r.checkout.state.quantities[1], '3');
    quantityInput(r, '1'); await r.checkout.submit(); assert.deepEqual(appliedBody(r), { cart_ids: [{ cart_id: 1, cart_num: 1 }], applyType: 1, refundReason: '其他', refundExplain: '' });
    assert.equal(Object.hasOwn(appliedBody(r), 'cartIds'), false); assert.equal(Object.hasOwn(appliedBody(r), 'cartSelections'), false);
  } finally { r.stop(); }
});
test('UniApp partial refund defaults to the currently read remainder without rewriting purchased quantity', async () => {
  const r = setup(c => c.url.includes('/refund/apply/') ? undefined : { data: detail('local_A', { cartInfo: [{ ...detail().cartInfo[0], cartNum: 3, refundNum: 1 }] }) });
  try { await r.start({ orderId: 'local_A' }); fill(r); await r.checkout.submit(); assert.equal(appliedBody(r).cart_ids[0].cart_num, 2); assert.equal(r.checkout.state.items[0].quantity, 3); }
  finally { r.stop(); }
});
test('UniApp selected lines retain separate integer quantities and unselected rows never enter the request', async () => {
  const rows = [detail().cartInfo[0], { ...detail().cartInfo[0], id: 2, cartNum: 4, refundNum: 1 }, { ...detail().cartInfo[0], id: 3 }];
  const r = setup(c => c.url.includes('/refund/apply/') ? undefined : { data: detail('local_A', { cartInfo: rows }) });
  try {
    await r.start({ orderId: 'local_A' }); fill(r); r.checkout.selectedIds.value = [1, 2]; quantityInput(r, '1'); quantityInput(r, '2', r.checkout.state.items[1]); quantityInput(r, '1', r.checkout.state.items[2]);
    assert.equal(r.checkout.state.quantities[3], '2'); await r.checkout.submit(); assert.deepEqual(appliedBody(r).cart_ids, [{ cart_id: 1, cart_num: 1 }, { cart_id: 2, cart_num: 2 }]);
  } finally { r.stop(); }
});
test('UniApp invalid quantity disables submit while retaining editable controls and a correction can be submitted', async () => {
  const r = setup(); try {
    await r.start({ orderId: 'local_A' }); fill(r);
    for (const value of ['', '0', '-1', '1.5', '1e2', '01', '3', '9007199254740992']) {
      quantityInput(r, value); assert.equal(r.checkout.canSubmit.value, false); assert.equal(r.checkout.editable.value, true); await r.checkout.submit(); assert.equal(posts(r).length, 0); assert.match(r.checkout.state.submitError, /整数件数/);
    }
    quantityInput(r, '1'); assert.equal(r.checkout.canSubmit.value, true); await r.checkout.submit(); assert.equal(appliedBody(r).cart_ids[0].cart_num, 1);
  } finally { r.stop(); }
});
test('UniApp malformed quantity state cannot bypass the ordinary shared author gate', async () => {
  const r = setup(); try {
    await r.start({ orderId: 'local_A' }); fill(r); for (const value of [undefined, null, 1, {}, NaN, Infinity]) { r.checkout.state.quantities[1] = value; await r.checkout.submit(); assert.equal(posts(r).length, 0); }
  } finally { r.stop(); }
});
test('UniApp quantity buttons enforce bounds and ignore foreign or unselected row controls', async () => {
  const r = setup(); try {
    await r.start({ orderId: 'local_A' }); const item = r.checkout.state.items[0]; quantityInput(r, '1'); assert.equal(r.checkout.state.quantities[1], '2'); fill(r);
    r.checkout.adjustQuantity(item, 1); assert.equal(r.checkout.state.quantities[1], '2'); r.checkout.adjustQuantity(item, -1); r.checkout.adjustQuantity(item, -1); assert.equal(r.checkout.state.quantities[1], '1');
    quantityInput(r, '2', { ...item }); r.checkout.adjustQuantity({ ...item }, 1); r.checkout.adjustQuantity(item, 2); assert.equal(r.checkout.state.quantities[1], '1');
    r.checkout.adjustQuantity(item, 1); assert.equal(r.checkout.state.quantities[1], '2');
  } finally { r.stop(); }
});
test('UniApp a fresh read initializes current remaining counts and late events cannot target the new row object', async () => {
  let remaining = 2; const r = setup(c => c.url.includes('/refund/apply/') ? undefined : { data: detail('local_A', { cartInfo: [{ ...detail().cartInfo[0], refundNum: 2 - remaining }] }) });
  try {
    await r.start({ orderId: 'local_A' }); fill(r); quantityInput(r, '1'); const oldItem = r.checkout.state.items[0]; remaining = 1; await r.checkout.load(); fill(r);
    assert.equal(r.checkout.state.quantities[1], '1'); quantityInput(r, '2', oldItem); assert.equal(r.checkout.state.quantities[1], '1'); await r.checkout.submit(); assert.equal(appliedBody(r).cart_ids[0].cart_num, 1);
  } finally { r.stop(); }
});
test('UniApp auth, hide, route and unload discard selected quantities and invalidate former controls', async () => {
  for (const ending of ['auth', 'hide', 'route', 'unload']) {
    const r = setup(); try {
      await r.start({ orderId: 'local_A' }); fill(r); quantityInput(r, '1'); const item = r.checkout.state.items[0];
      if (ending === 'auth') r.auth.setLogin('replacement', 22);
      if (ending === 'hide') r.hooks.onHide();
      if (ending === 'route') { r.hooks.onLoad({ orderId: 'local_B' }); assert.deepEqual(r.checkout.state.quantities, {}); r.hooks.onShow(); await tick(); }
      if (ending === 'unload') r.hooks.onUnload();
      assert.deepEqual(r.checkout.state.selectedIds, []); const fresh = ending === 'route' ? { 1: '2' } : {}; assert.deepEqual(r.checkout.state.quantities, fresh);
      quantityInput(r, '1', item); assert.deepEqual(r.checkout.state.quantities, fresh); assert.equal(posts(r).length, 0);
    } finally { r.stop(); }
  }
});
test('UniApp pending quantity intent is frozen and controls or a second tap cannot alter the request', async () => {
  const wait = deferred(), r = setup(c => c.url.includes('/refund/apply/') ? wait.promise : undefined); try {
    await r.start({ orderId: 'local_A' }); fill(r); quantityInput(r, '1'); const pending = r.checkout.submit(); quantityInput(r, '2'); r.checkout.adjustQuantity(r.checkout.state.items[0], 1); await r.checkout.submit();
    assert.equal(r.checkout.state.quantities[1], '1'); r.checkout.state.quantities[1] = '2'; await tick(); assert.equal(posts(r).length, 1); assert.equal(appliedBody(r).cart_ids[0].cart_num, 1);
    wait.resolve({ data: { refundId: 91 } }); await pending;
  } finally { wait.resolve({ status: 400 }); r.stop(); }
});
test('UniApp an uncertain quantity intent cannot be replaced by another quantity after refresh', async () => {
  const r = setup(c => c.url.includes('/refund/apply/') ? { status: 500, msg: 'lost' } : undefined); try {
    await r.start({ orderId: 'local_A' }); fill(r); quantityInput(r, '1'); await r.checkout.submit(); await r.checkout.load(); fill(r); quantityInput(r, '2'); await r.checkout.submit();
    assert.equal(r.checkout.state.uncertain, true); assert.equal(r.checkout.editable.value, false); assert.equal(posts(r).length, 1); assert.equal(appliedBody(r).cart_ids[0].cart_num, 1);
  } finally { r.stop(); }
});
test('UniApp choosing an image locks the exact selected quantity until its upload completes', async () => {
  const r = setup(); let pendingUpload; applicationUpload(r); r.uni.uploadFile = options => { pendingUpload = options; };
  try {
    await r.start({ orderId: 'local_A' }); fill(r); quantityInput(r, '1'); const pending = r.checkout.uploadApplicationImage(); await tick(); quantityInput(r, '2'); r.checkout.adjustQuantity(r.checkout.state.items[0], 1);
    assert.equal(r.checkout.state.quantities[1], '1'); pendingUpload.success({ statusCode: 200, data: JSON.stringify({ status: 200, data: uploadedImage() }) }); await pending;
    await r.checkout.submit(); assert.equal(appliedBody(r).cart_ids[0].cart_num, 1); assert.equal(appliedBody(r).refundImg, '["/api/assets/31"]');
  } finally { r.stop(); }
});
test('UniApp large safe purchased counts require no quantity-sized array and send the small selected remainder', async () => {
  const r = setup(c => c.url.includes('/refund/apply/') ? undefined : { data: detail('local_A', { cartInfo: [{ ...detail().cartInfo[0], cartNum: Number.MAX_SAFE_INTEGER, refundNum: Number.MAX_SAFE_INTEGER - 2 }] }) });
  try { await r.start({ orderId: 'local_A' }); fill(r); quantityInput(r, '1'); await r.checkout.submit(); assert.equal(r.checkout.state.items[0].remainingQuantity, 2); assert.equal(appliedBody(r).cart_ids[0].cart_num, 1); }
  finally { r.stop(); }
});
