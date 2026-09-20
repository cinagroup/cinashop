const test = require('node:test');
const assert = require('node:assert/strict');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');
const record = (id = 25, changes = {}) => ({ id, uid: 11, refundNo: `refund_${id}`, orderId: `order_${id}`, storeOrderId: id,
  applyType: 2, refundType: 0, isCancel: 0, refundNum: 1, refundPrice: '5.00', refundedPrice: '0.00', refundReason: '测试原因',
  addTime: 1700000000, refundedTime: 0, ...changes });
const detail = (id = 25, changes = {}) => ({ version: 1, ...record(id), refundExplain: '', refuseReason: '', refundExpress: '',
  refundExpressName: '', refundPhone: '', refundGoodsExplain: '', returnContact: null, itemsError: '',
  items: [{ id, cartId: 2000 + id, name: '本地退款商品', sku: '红色', image: '', quantity: 1 }], ...changes });
const setup = (override = () => undefined, component = 'refundDetail') => runtime({ component: `pages/order/${component}.vue`,
  send: call => override(call) ?? { data: detail(Number(call.url.split('/').at(-1))) } });

test('refund detail clears private fields immediately when the account changes', async () => {
  const r = setup(); try { await r.start({ id: '25' }); assert.equal(r.checkout.detail.value.id, 25);
    r.auth.setLogin('replacement', 22); assert.equal(r.checkout.detail.value, null);
  } finally { r.stop(); }
});
test('refund detail does not retain a hidden account record', async () => {
  const r = setup(); try { await r.start({ id: '25' }); r.hooks.onHide?.(); assert.equal(r.checkout.detail.value, null); }
  finally { r.stop(); }
});
test('cancelled refund cannot claim money has been returned', async () => {
  const r = setup(() => ({ data: detail(25, { isCancel: 1, refundType: 6 }) }));
  try { await r.start({ id: '25' }); assert.match(r.checkout.statusSub.value, /撤销|取消/); assert.equal(r.checkout.isDone.value, false); }
  finally { r.stop(); }
});

const page = (query, items = [], nextCursor = null) => ({ version: 1, filter: query.filter ?? 'all', q: query.q ?? '', limit: query.limit ?? 10, items, nextCursor });
const posts = r => r.calls.filter(call => call.url.includes('/cancel/'));
const returnDetail = changes => detail(25,{refundType:4,returnImages:[],returnImagesError:'',...changes});
const returnCalls = r => r.calls.filter(call=>call.url.endsWith('/order/refund/express'));
const setupReturn = (override=()=>undefined) => setup(call=>override(call)??{data:call.url.endsWith('/logistics')?[{id:1,name:'本地快递甲',code:'local-a'}]:returnDetail()});
const fillReturn = r => Object.assign(r.checkout.state.shipment.form,{carrierId:1,tracking:'LOCAL-25',phone:'000000',explain:'备注',acknowledged:true});

test('return logistics validates fields and acknowledgement without posting',async()=>{
  const r=setupReturn();try{await r.start({id:'25'});await r.checkout.submitReturn();assert.equal(returnCalls(r).length,0);
    fillReturn(r);r.checkout.state.shipment.form.tracking='';await r.checkout.submitReturn();assert.equal(returnCalls(r).length,0);
    r.checkout.state.shipment.form.tracking='ok';r.checkout.state.shipment.form.acknowledged=false;await r.checkout.submitReturn();assert.equal(returnCalls(r).length,0);
  }finally{r.stop();}
});
test('return success freezes its original body, blocks cancellation and rereads exact persisted fields',async()=>{
  const wait=deferred();let body;const r=setupReturn(c=>{if(c.url.endsWith('/express')){body=c.data;return wait.promise;}
    if(body&&!c.url.endsWith('/logistics'))return{data:returnDetail({refundType:5,refundExpress:body.refund_express,refundExpressName:body.refund_express_name,refundPhone:body.refund_phone,refundGoodsExplain:body.refund_explain})};});
  try{await r.start({id:'25'});fillReturn(r);const first=r.checkout.submitReturn();await tick();r.checkout.state.shipment.form.tracking='CHANGED';
    await r.checkout.submitReturn();await r.checkout.cancel();assert.equal(returnCalls(r).length,1);assert.equal(posts(r).length,0);assert.equal(body.refund_express,'LOCAL-25');
    wait.resolve({data:null});await first;assert.equal(r.checkout.state.shipment.outcome,'success');assert.equal(r.checkout.canReturn.value,false);
  }finally{wait.resolve({status:400});r.stop();}
});
for(const changed of [{},{refundType:5,refundExpress:'WRONG'},{refundType:5,refundExpress:'LOCAL-25',refundExpressName:'本地快递甲',refundPhone:'000000',refundGoodsExplain:'备注',returnImagesError:'unavailable'}]) {
  test(`return unknown requires exact read-back ${JSON.stringify(changed)}`,async()=>{
    let sent=false;const r=setupReturn(c=>{if(c.url.endsWith('/express')){sent=true;return{transport:'lost'};}
      if(sent&&!c.url.endsWith('/logistics'))return{data:returnDetail(changed)};});
    try{await r.start({id:'25'});fillReturn(r);await r.checkout.submitReturn();await r.checkout.load();await r.checkout.submitReturn();await r.checkout.cancel();
      assert.equal(returnCalls(r).length,1);assert.equal(posts(r).length,0);assert.equal(r.checkout.state.shipment.outcome,'unknown');
    }finally{r.stop();}
  });
}
test('return lost response after commit is confirmed by read-only refresh',async()=>{
  let body;const r=setupReturn(c=>{if(c.url.endsWith('/express')){body=c.data;return{transport:'lost'};}
    if(body&&!c.url.endsWith('/logistics'))return{data:returnDetail({refundType:5,refundExpress:body.refund_express,refundExpressName:body.refund_express_name,refundPhone:body.refund_phone,refundGoodsExplain:body.refund_explain})};});
  try{await r.start({id:'25'});fillReturn(r);await r.checkout.submitReturn();assert.equal(r.checkout.state.shipment.outcome,'unknown');await r.checkout.load();assert.equal(r.checkout.state.shipment.outcome,'success');assert.equal(returnCalls(r).length,1);}finally{r.stop();}
});
test('return explicit rejection retains form but does not retry automatically',async()=>{
  const r=setupReturn(c=>c.url.endsWith('/express')?{status:400,msg:'明确拒绝'}:undefined);try{await r.start({id:'25'});fillReturn(r);await r.checkout.submitReturn();assert.equal(r.checkout.canReturn.value,true);assert.equal(r.checkout.state.shipment.form.explain,'备注');assert.equal(returnCalls(r).length,1);}finally{r.stop();}
});
for(const ending of ['auth','hide','unload']) {
  test(`return late response is ignored after ${ending}`,async()=>{
    const wait=deferred(),r=setupReturn(c=>c.url.endsWith('/express')?wait.promise:undefined);try{await r.start({id:'25'});fillReturn(r);const pending=r.checkout.submitReturn();await tick();
      if(ending==='auth')r.auth.setLogin('replacement',22);else r.hooks[ending==='hide'?'onHide':'onUnload']();wait.resolve({data:null});await pending;
      assert.equal(r.checkout.detail.value,null);assert.equal(r.checkout.state.shipment.form.tracking,'');
      if(ending==='hide'){assert.equal(r.checkout.state.shipment.outcome,'unknown');r.hooks.onShow();await tick();assert.equal(r.checkout.state.shipment.outcome,'unknown');assert.equal(r.checkout.canReturn.value,false);}
      else assert.equal(r.checkout.state.shipment.pending,null);
    }finally{wait.resolve({status:400});r.stop();}
  });
}
test('native image selection is account-bound and a late picker never uploads',async()=>{
  const r=setupReturn();let picker,uploads=0;r.uni.chooseImage=call=>{picker=call;};r.uni.uploadFile=()=>{uploads++;};
  try{await r.start({id:'25'});const pending=r.checkout.uploadReturnImage();r.auth.setLogin('new',22);picker.success({tempFiles:[{size:12}],tempFilePaths:['local.png']});await pending;assert.equal(uploads,0);assert.deepEqual(r.checkout.state.shipment.form.images,[]);}finally{r.stop();}
});
test('native uploads cap three images and use canonical rather than signed references',async()=>{
  const r=setupReturn(c=>c.url.endsWith('/express')?{status:400,msg:'test rejection'}:undefined);let id=0;
  r.uni.chooseImage=c=>c.success({tempFiles:[{size:12}],tempFilePaths:['local.png']});
  r.uni.uploadFile=c=>{id++;assert.match(c.header['Authori-zation'],/^Bearer /);c.success({statusCode:200,data:JSON.stringify({status:200,data:{att_id:id,url:`/api/assets/${id}`,src:`/api/assets/${id}?expires=1999999999&signature=${'a'.repeat(43)}`,type:'image/png',size:12}})});};
  try{await r.start({id:'25'});fillReturn(r);for(let i=0;i<4;i++)await r.checkout.uploadReturnImage();assert.equal(id,3);await r.checkout.submitReturn();assert.deepEqual(returnCalls(r)[0].data.refund_img,['/api/assets/1','/api/assets/2','/api/assets/3']);r.checkout.removeReturnImage(1);assert.equal(r.checkout.state.shipment.form.images.length,2);}finally{r.stop();}
});
test('late native upload expiration cannot clear a replacement login or expose old evidence',async()=>{
  const r=setupReturn();let uploaded;r.uni.chooseImage=c=>c.success({tempFiles:[{size:12}],tempFilePaths:['local.png']});r.uni.uploadFile=c=>{uploaded=c;};
  try{await r.start({id:'25'});const pending=r.checkout.uploadReturnImage();await tick();r.auth.setLogin('replacement',22);
    uploaded.success({statusCode:200,data:JSON.stringify({status:410000,msg:'expired'})});await pending;assert.equal(r.auth.uid,22);assert.equal(r.auth.token,'replacement');assert.deepEqual(r.checkout.state.shipment.form.images,[]);assert.deepEqual(r.navigations,[]);
  }finally{r.stop();}
});
for (const id of ['0', '025', '25junk', ['25', '26'], '-1']) {
  test(`refund record rejects invalid route ${JSON.stringify(id)} without I/O`, async () => {
    const r = setup(); try { await r.start({ id }); assert.ok(r.checkout.routeError.value); assert.equal(r.calls.length, 0); } finally { r.stop(); }
  });
}
for (const change of [{uid:22}, {id:26}, {refundPrice:'NaN'}, {items:[]}, {items:[{id:25,cartId:2025,name:'x',sku:'',image:'',quantity:2}]}]) {
  test(`refund detail rejects malformed or mismatched data ${JSON.stringify(change)}`, async () => {
    const r = setup(() => ({data:detail(25,change)})); try { await r.start({id:'25'}); assert.equal(r.checkout.detail.value,null); assert.ok(r.checkout.state.error); } finally {r.stop();}
  });
}
test('refund detail read failure clears stale fields and a read retry restores them', async () => {
  let fail=false; const r=setup(()=>fail?{transport:'read offline'}:undefined);
  try {await r.start({id:'25'});fail=true;await r.checkout.load();assert.equal(r.checkout.detail.value,null);assert.match(r.checkout.state.error,/offline/);
    fail=false;await r.checkout.load();assert.equal(r.checkout.detail.value.id,25);assert.equal(posts(r).length,0);
  } finally {r.stop();}
});
for (const ending of ['auth','hide','unload']) {
  test(`refund detail discards a late read after ${ending}`,async()=>{
    const waiting=deferred(),r=setup(()=>waiting.promise);
    try {const starting=r.start({id:'25'});await tick();if(ending==='auth')r.auth.setLogin('new',22);else r.hooks[ending==='hide'?'onHide':'onUnload']();
      waiting.resolve({data:detail()});await starting;assert.equal(r.checkout.detail.value,null);
    } finally {waiting.resolve({data:detail()});r.stop();}
  });
}
test('refund list retries the exact failed cursor and never displays failure as empty success',async()=>{
  const first=Array.from({length:10},(_,i)=>record(30-i));let fail=true;
  const r=setup(c=>c.data.cursor?(fail?{transport:'append offline'}:{data:page(c.data,[record(20)])}):{data:page(c.data,first,'c25')},'refundList');
  try {await r.start({});assert.equal(r.checkout.list.value.length,10);await r.checkout.load(true);
    assert.equal(r.checkout.list.value.length,10);assert.equal(r.checkout.state.cursor,'c25');assert.match(r.checkout.state.error,/offline/);
    r.checkout.goDetail(r.checkout.list.value[0]);assert.equal(r.navigations.length,0);fail=false;await r.checkout.load(true);
    assert.equal(r.checkout.list.value.length,11);assert.deepEqual(r.calls.map(c=>c.data.cursor),[undefined,'c25','c25']);
  } finally {r.stop();}
});
test('refund list filter changes invalidate an older pending read',async()=>{
  const waiting=deferred(),r=setup(c=>c.data.filter==='all'?waiting.promise:{data:page(c.data,[record(25,{refundType:6,refundedPrice:'5.00'})])},'refundList');
  try {const starting=r.start({});await tick();r.checkout.setFilter('completed');await tick();waiting.resolve({data:page({filter:'all',limit:10},[record(30)])});await starting;
    assert.equal(r.checkout.state.filter,'completed');assert.deepEqual(r.checkout.list.value.map(row=>row.id),[25]);
  } finally {waiting.resolve({data:page({})});r.stop();}
});
test('refund list rejects duplicate append rows without losing the retry cursor',async()=>{
  const rows=Array.from({length:10},(_,i)=>record(30-i)),r=setup(c=>({data:page(c.data,c.data.cursor?[record(21)]:rows,c.data.cursor?null:'c25')}),'refundList');
  try {await r.start({});await r.checkout.load(true);assert.equal(r.checkout.list.value.length,10);assert.ok(r.checkout.state.error);assert.equal(r.checkout.state.cursor,'c25');}finally{r.stop();}
});
test('refund cancellation locks before confirmation and late confirmation after hide sends nothing',async()=>{
  let modal;const r=setup();r.uni.showModal=options=>{modal=options;};
  try {await r.start({id:'25'});const pending=r.checkout.cancel();await r.checkout.cancel();assert.equal(r.checkout.state.operating,true);r.hooks.onHide();modal.success({confirm:true});await pending;assert.equal(posts(r).length,0);}finally{r.stop();}
});
test('refund cancellation cancelled confirmation sends nothing',async()=>{
  const r=setup();r.uni.showModal=options=>options.success({confirm:false});
  try {await r.start({id:'25'});await r.checkout.cancel();assert.equal(posts(r).length,0);assert.equal(r.checkout.canCancel.value,true);}finally{r.stop();}
});
test('refund cancellation success rereads the server record and cannot repeat',async()=>{
  let cancelled=false;const r=setup(c=>{if(c.url.includes('/cancel/')){cancelled=true;return{data:null};}return{data:detail(25,{isCancel:cancelled?1:0})};});
  r.uni.showModal=options=>options.success({confirm:true});
  try {await r.start({id:'25'});await r.checkout.cancel();assert.equal(r.checkout.detail.value.isCancel,1);await r.checkout.cancel();assert.equal(posts(r).length,1);assert.equal(r.checkout.canCancel.value,false);}finally{r.stop();}
});
for(const result of [{transport:'lost response'},{data:{ok:true}}]) {
  test(`refund cancellation unknown result remains blocked after read and hide/show ${JSON.stringify(result)}`,async()=>{
    let confirmed=false;const r=setup(c=>c.url.includes('/cancel/')?result:{data:detail(25,{isCancel:confirmed?1:0})});r.uni.showModal=o=>o.success({confirm:true});
    try{await r.start({id:'25'});await r.checkout.cancel();assert.equal(r.checkout.state.cancelOutcome,'unknown');await r.checkout.load();await r.checkout.cancel();
      r.hooks.onHide();r.hooks.onShow();await tick();await r.checkout.cancel();assert.equal(posts(r).length,1);assert.equal(r.checkout.canCancel.value,false);
      confirmed=true;await r.checkout.load();assert.equal(r.checkout.detail.value.isCancel,1);assert.equal(r.checkout.state.operationError,'');
    }finally{r.stop();}
  });
}
test('refund cancellation explicit rejection permits a fresh confirmed retry',async()=>{
  const r=setup(c=>c.url.includes('/cancel/')?{status:400,msg:'明确拒绝'}:undefined);r.uni.showModal=o=>o.success({confirm:true});
  try{await r.start({id:'25'});await r.checkout.cancel();assert.equal(r.checkout.canCancel.value,true);await r.checkout.cancel();assert.equal(posts(r).length,2);}finally{r.stop();}
});
test('refund image failures are scoped to current item objects and clear on reread',async()=>{
  const r=setup();try{await r.start({id:'25'});const old=r.checkout.detail.value.items[0];r.checkout.imageFailed(old);
    assert.deepEqual(r.checkout.failedImages.value,[25]);await r.checkout.load();r.checkout.imageFailed(old);assert.deepEqual(r.checkout.failedImages.value,[]);
  }finally{r.stop();}
});
test('refund cancellation dispatched before hide remains uncertain after late success and unchanged read',async()=>{
  const waiting=deferred(),r=setup(c=>c.url.includes('/cancel/')?waiting.promise:undefined);r.uni.showModal=o=>o.success({confirm:true});
  try{await r.start({id:'25'});const pending=r.checkout.cancel();await tick();assert.equal(posts(r).length,1);r.hooks.onHide();
    waiting.resolve({data:null});await pending;r.hooks.onShow();await tick();assert.equal(r.checkout.state.cancelOutcome,'unknown');assert.equal(r.checkout.canCancel.value,false);
    await r.checkout.cancel();assert.equal(posts(r).length,1);
  }finally{waiting.resolve({data:null});r.stop();}
});
