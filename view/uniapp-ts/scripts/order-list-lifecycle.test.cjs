const test=require('node:test');
const assert=require('node:assert/strict');
const {runtime,tick,deferred}=require('./uni-store-runtime.cjs');
const row=(id,change={})=>({id,uid:11,orderId:`local_list_${id}`,paid:0,status:0,payPrice:'10.00',totalPrice:'10.00',totalNum:1,addTime:1000-id,cartInfo:[],pid:0,supplierAllocationStatus:0,shippingType:1,deliveryType:'',refundStatus:0,...change});
const rows=page=>Array.from({length:page===1?10:2},(_,i)=>row((page-1)*10+i+1));
const setup=(override=()=>undefined)=>runtime({component:'pages/order/list.vue',send:c=>override(c)??{data:rows(c.data.page)}});
const writes=r=>r.calls.filter(c=>c.url==='/api/order/del');
const confirmDelete=r=>{r.uni.showModal=options=>options.success({confirm:true,cancel:false});};

test('UniApp deletion confirms cancellation consequences but cancelled dialog performs no write',async()=>{
  const r=setup();let modal;r.uni.showModal=options=>{modal=options;options.success({confirm:false,cancel:true});};
  try{await r.start({});await r.checkout.remove(r.checkout.orders.value[0]);assert.match(modal.content,/取消并删除未付款订单 local_list_1.*释放库存、优惠券和抵扣积分/);assert.equal(modal.confirmText,'确认删除');assert.equal(writes(r).length,0);assert.equal(r.checkout.orders.value.length,10);assert.equal(r.checkout.busy.value,false);}finally{r.stop();}
});
test('UniApp deletion resets pagination after success, preserving all shifted rows',async()=>{
  let deleted=false;const r=setup(c=>{if(c.url.endsWith('/order/del')){deleted=true;return{data:null};}const all=Array.from({length:12},(_,i)=>row(i+1)).filter(row=>!deleted||row.id!==1);return{data:all.slice((c.data.page-1)*10,c.data.page*10)};});confirmDelete(r);
  try{await r.start({});await r.checkout.loadMore();assert.equal(r.checkout.orders.value.length,12);await r.checkout.remove(r.checkout.orders.value[0]);assert.equal(r.checkout.list.page,1);assert.equal(r.checkout.orders.value.length,10);assert.deepEqual(writes(r).map(c=>c.data),[{order_id:'local_list_1'}]);await r.checkout.loadMore();assert.deepEqual(r.checkout.orders.value.map(o=>o.id),Array.from({length:11},(_,i)=>i+2));assert.equal(r.toasts.at(-1).title,'订单已删除');}finally{r.stop();}
});
for(const ending of ['filter','identity','onHide','onUnload'])test(`UniApp delete confirmation cannot follow ${ending}`,async()=>{
  const r=setup();let modal;r.uni.showModal=options=>{modal=options;};
  try{await r.start({});const old=r.checkout.orders.value[0],pending=r.checkout.remove(old);await r.checkout.remove(old);
    if(ending==='filter'){r.checkout.switchTab(4);await tick();}else if(ending==='identity')r.auth.setLogin('synthetic-local-token',11);else r.hooks[ending]();
    modal.success({confirm:true});await pending;assert.equal(writes(r).length,0);assert.equal(r.toasts.length,0);
  }finally{modal?.success({confirm:false});r.stop();}
});
for(const ending of ['filter','identity','onHide','onUnload'])test(`UniApp late delete reply cannot alter ${ending} replacement`,async()=>{
  const wait=deferred(),r=setup(c=>c.url.endsWith('/order/del')?wait.promise:undefined);confirmDelete(r);
  try{await r.start({});const old=r.checkout.orders.value[0],pending=r.checkout.remove(old);await tick();await r.checkout.remove(old);await r.checkout.loadMore();r.checkout.goDetail(old.order_id);assert.equal(writes(r).length,1);assert.equal(r.navigations.length,0);
    if(ending==='filter'){r.checkout.switchTab(4);await tick();}else if(ending==='identity')r.auth.setLogin('other',22);else r.hooks[ending]();
    const count=r.calls.length;wait.resolve({data:null});await pending;assert.equal(r.calls.length,count);assert.equal(r.toasts.length,0);
  }finally{wait.resolve({data:null});r.stop();}
});
for(const response of [{status:400,msg:'退款处理中'},{data:{}},{data:undefined},{transport:'回执丢失'}])test(`UniApp rejected/unknown deletion keeps rows and blocks replay: ${JSON.stringify(response)}`,async()=>{
  const r=setup(c=>c.url.endsWith('/order/del')?response:undefined);confirmDelete(r);
  try{await r.start({});const old=r.checkout.orders.value[0];await r.checkout.remove(old);await r.checkout.remove(old);await r.checkout.loadMore();assert.equal(writes(r).length,1);assert.equal(r.checkout.orders.value[0],old);assert.match(r.checkout.navigationError.value,/尚未确认/);assert.equal(r.toasts.length,0);await r.checkout.load(true);assert.equal(r.checkout.navigationError.value,'');}finally{r.stop();}
});
test('UniApp deletion rechecks confirmation state and rejects copied or ineligible rows',async()=>{
  const r=setup();let modal;r.uni.showModal=options=>{modal=options;};
  try{await r.start({});const old=r.checkout.orders.value[0];await r.checkout.remove({...old});assert.equal(modal,undefined);const pending=r.checkout.remove(old);old.paid=1;old.status=3;modal.success({confirm:true});await pending;assert.equal(writes(r).length,0);assert.match(r.checkout.navigationError.value,/状态已变化/);
    await r.checkout.load(true);for(const order of r.checkout.orders.value){order.paid=1;order.status=2;await r.checkout.remove(order);}assert.equal(writes(r).length,0);
  }finally{modal?.success({confirm:false});r.stop();}
});
test('UniApp successful deletion with failed refresh clears stale rows',async()=>{
  let deleted=false;const r=setup(c=>{if(c.url.endsWith('/order/del')){deleted=true;return{data:null};}return deleted?{transport:'刷新失败'}:undefined;});confirmDelete(r);
  try{await r.start({});const old=r.checkout.orders.value[0];await r.checkout.remove(old);assert.equal(r.checkout.orders.value.length,0);assert.match(r.checkout.list.error,/刷新失败/);await r.checkout.remove(old);assert.equal(writes(r).length,1);}finally{r.stop();}
});
test('UniApp deletion adapter rejects invalid IDs before I/O and accepts completed/refunded state',async()=>{
  const r=setup(c=>c.url.endsWith('/order/del')?{data:null}:{data:[row(1,{paid:1,status:3}),row(2,{paid:1,status:0,refundStatus:2,pid:99})]});let content;r.uni.showModal=options=>{content=options.content;options.success({confirm:true});};
  try{await r.start({});const {apiOrderDelete}=r.load(require('node:path').resolve(__dirname,'../src/api/order.ts'));for(const id of ['',null,1,'../bad','x'.repeat(51)])await assert.rejects(apiOrderDelete(id));assert.equal(writes(r).length,0);
    await r.checkout.remove(r.checkout.orders.value[0]);assert.match(content,/不会发起退款.*售后退款记录仍会保留/);await r.checkout.remove(r.checkout.orders.value[1]);assert.equal(writes(r).length,2);
  }finally{r.stop();}
});
test('UniApp failed native confirmation is recoverable without a write',async()=>{
  const r=setup();r.uni.showModal=options=>options.fail({errMsg:'native modal failed'});
  try{await r.start({});await r.checkout.remove(r.checkout.orders.value[0]);assert.equal(writes(r).length,0);assert.equal(r.checkout.busy.value,false);await r.checkout.load(true);assert.equal(r.checkout.navigationError.value,'');}finally{r.stop();}
});
test('UniApp order list omits absent filters instead of serializing them as empty status',async()=>{
  const r=setup();try{await r.start({});assert.equal(Object.hasOwn(r.calls[0].data,'status'),false);assert.equal(Object.hasOwn(r.calls[0].data,'type'),false);
    r.checkout.switchTab(0);await tick();assert.equal(r.calls.at(-1).data.status,0);
  }finally{r.stop();}
});
test('UniApp order list retries the failed second page rather than skipping it',async()=>{
  let fail=true;const r=setup(c=>fail&&c.data.page===2?{transport:'第二页读取失败'}:undefined);
  try{await r.start({});await r.checkout.loadMore();assert.equal(r.checkout.orders.value.length,10);fail=false;await r.checkout.loadMore();
    assert.deepEqual(r.calls.map(c=>c.data.page),[1,2,2]);assert.equal(r.checkout.orders.value.at(-1).order_id,'local_list_12');
  }finally{r.stop();}
});
test('UniApp order list serializes concurrent load-more taps',async()=>{
  const waiting=deferred(),r=setup(c=>c.data.page>1?waiting.promise:undefined);
  try{await r.start({});const first=r.checkout.loadMore();const second=r.checkout.loadMore();await tick();assert.equal(r.calls.length,2);
    waiting.resolve({data:rows(2)});await Promise.all([first,second]);assert.equal(r.checkout.orders.value.length,12);
  }finally{waiting.resolve({data:[]});r.stop();}
});
test('UniApp order list hides all prior orders when the page hides',async()=>{
  const r=setup();try{await r.start({});r.hooks.onHide?.();assert.equal(r.checkout.orders.value.length,0);}finally{r.stop();}
});
for(const ending of ['filter','identity','onHide','onUnload'])test(`UniApp order list ignores delayed pagination after ${ending}`,async()=>{
  const waiting=deferred(),r=setup(c=>c.data.page===2?waiting.promise:undefined);
  try{await r.start({});const pending=r.checkout.loadMore();await tick();
    if(ending==='filter'){r.checkout.switchTab(3);await tick();}else if(ending==='identity')r.auth.setLogin('other',22);else r.hooks[ending]();
    waiting.resolve({data:rows(2)});await pending;assert.equal(r.checkout.orders.value.length,ending==='filter'?10:0);
  }finally{waiting.resolve({data:[]});r.stop();}
});
test('UniApp order list overlapping pages require refresh and remain recoverable',async()=>{
  let overlap=true;const r=setup(c=>overlap&&c.data.page===2?{data:[row(1)]}:undefined);
  try{await r.start({});await r.checkout.loadMore();assert.equal(r.checkout.list.refreshRequired,true);const count=r.calls.length;await r.checkout.loadMore();assert.equal(r.calls.length,count);
    overlap=false;await r.checkout.load(true);assert.equal(r.checkout.list.refreshRequired,false);await r.checkout.loadMore();assert.equal(r.checkout.orders.value.length,12);
  }finally{r.stop();}
});
test('UniApp order list all six filters reset to their first page',async()=>{
  const r=setup();try{await r.start({});for(const status of [0,1,2,3,4,undefined]){r.checkout.switchTab(status);await tick();assert.equal(r.calls.at(-1).data.status,status);assert.equal(r.calls.at(-1).data.page,1);assert.equal(r.checkout.orders.value.length,10);}}finally{r.stop();}
});
for(const options of [{status:'bad'},{status:['0','1']},{status:'0',type:'1'},{status:null},{type:'-1'}])test(`UniApp order list refuses invalid filter ${JSON.stringify(options)}`,async()=>{
  const r=setup();try{await r.start(options);assert.equal(r.calls.length,0);assert.ok(r.checkout.list.error);r.checkout.switchTab(0);await tick();assert.equal(r.calls.length,1);}finally{r.stop();}
});
test('UniApp order list clears account rows and offers login without a private request',async()=>{
  const r=setup();try{await r.start({});r.auth.clear();assert.equal(r.checkout.orders.value.length,0);const count=r.calls.length;await r.checkout.load(true);assert.equal(r.calls.length,count);
    r.checkout.login();assert.deepEqual(r.navigations,['/pages/auth/login']);
  }finally{r.stop();}
});
test('UniApp order list native navigation gate survives completion until hide, with scoped retry',async()=>{
  const r=setup();let fail;
  r.uni.navigateTo=opts=>{r.navigations.push(opts.url);fail=opts.fail;};
  try{await r.start({});r.checkout.goDetail('local_list_1');r.checkout.goDetail('local_list_1');assert.equal(r.navigations.length,1);fail();assert.ok(r.checkout.navigationError.value);
    r.checkout.goDetail('local_list_1');assert.equal(r.navigations.length,2);r.hooks.onHide();r.hooks.onShow();await tick();r.checkout.goDetail('foreign');assert.equal(r.navigations.length,2);
  }finally{r.stop();}
});
test('UniApp order list H5 updates filter URL, rejects duplicates, and recovers',async()=>{
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'window'),handlers=new Map();
  Object.defineProperty(globalThis,'window',{configurable:true,value:{location:{hash:'#/pages/order/list?status=0'},addEventListener:(name,fn)=>handlers.set(name,fn),removeEventListener:name=>handlers.delete(name)}});
  const r=setup();try{await r.start({status:'0'});r.checkout.switchTab(4);assert.equal(window.location.hash,'#/pages/order/list?status=4');handlers.get('hashchange')();await tick();assert.equal(r.calls.at(-1).data.status,4);
    window.location.hash='#/pages/order/list?status=0&status=1';handlers.get('hashchange')();assert.equal(r.checkout.orders.value.length,0);assert.ok(r.checkout.list.error);
    r.checkout.switchTab(2);handlers.get('hashchange')();await tick();assert.equal(r.calls.at(-1).data.status,2);
  }finally{r.stop();assert.equal(handlers.size,0);if(descriptor)Object.defineProperty(globalThis,'window',descriptor);else delete globalThis.window;}
});
