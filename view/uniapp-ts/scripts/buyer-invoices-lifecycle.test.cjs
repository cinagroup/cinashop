const test=require('node:test'),assert=require('node:assert/strict');
const {runtime,tick,deferred}=require('./uni-store-runtime.cjs');
const fixture=require('../../common/test/buyerInvoiceFixture.cjs');
const path=require('node:path');
function setup(override=()=>undefined,{orderPage=false,...options}={}){
  const sent=[];const r=runtime({component:'pages/user/'+(orderPage?'invoiceOrder':'invoice')+'.vue',platform:'H5',modal:true,...options,send:async c=>{
    sent.push(c);const custom=await override(c);if(custom)return custom;
    if(c.method!=='GET'){const action=c.url.includes('make_up')?'apply':c.url.includes('/del/')?'delete':c.url.includes('set_default')?'default':'save';return{data:{version:1,uid:11,action,id:action==='apply'?81:71}};}
    assert.equal(c.data.view,'buyer');const q={kind:c.url.endsWith('/invoice')?'titles':'records',cursor:c.data.cursor??null,limit:c.data.limit??20};
    return{data:c.url.includes('invoice_detail')?fixture.order({orderNo:c.url.split('/').at(-1)}):fixture.page(q)};
  }});return Object.assign(r,{sent,get flow(){return r.checkout.flow;}});
}
test('UniApp actual invoice hub reads records, edits full fields and sends a versioned save',async()=>{const r=setup();try{
  await r.start({});assert.equal(r.flow.records[0].orderNo,'invoice_order_A');await r.flow.selectKind('titles');r.flow.edit(r.flow.titles[0]);await r.flow.save();
  const post=r.sent.find(c=>c.method==='POST');assert.equal(post.url,'/api/invoice/save?view=buyer');assert.equal(post.data.drawerPhone,'13800000000');assert.equal(post.data.revision,fixture.revision);assert.equal(r.flow.state.draft,null);assert.equal(r.flow.state.message,'抬头已保存');
}finally{r.stop();}});
test('UniApp actual order invoice applies exact PK, public number, title and versions then reads status',async()=>{const r=setup(()=>undefined,{orderPage:true});try{
  await r.start({orderId:'invoice_order_A'});await r.flow.apply(r.flow.titles[0]);const post=r.sent.find(c=>c.method==='POST');assert.equal(post.url,'/api/order/make_up_invoice?view=buyer');
  assert.deepEqual({...post.data},{orderId:91,orderNo:'invoice_order_A',revision:fixture.revision,titleId:71,titleRevision:fixture.revision});assert.match(r.flow.state.message,/开票申请已提交/);
}finally{r.stop();}});
test('UniApp navigation keeps the legacy invoice detail order identity and registers its actual page',()=>{const r=setup();try{
  const navigation=r.load(path.resolve(__dirname,'../src/config/navigation.ts'));
  assert.ok(navigation.REGISTERED_PAGE_ROUTES.has('/pages/user/invoiceOrder'));
  assert.equal(navigation.resolveRegisteredPageRoute('/pages/users/user_invoice_order/index','order_id=invoice_order_A'),'/pages/user/invoiceOrder?orderId=invoice_order_A');
}finally{r.stop();}});
for(const ending of ['identity','onHide','onUnload'])test('UniApp invoice removes old private data and drops late reads after '+ending,async()=>{const wait=deferred(),r=setup(c=>c.url.includes('invoice_detail')?wait.promise:undefined,{orderPage:true});try{
  await r.start({orderId:'invoice_order_A'});if(ending==='identity')r.auth.setLogin('new-user',22);else r.hooks[ending]();wait.resolve({data:fixture.order()});await tick();assert.equal(r.flow.state.page,null);assert.equal(r.flow.state.order,null);assert.equal(r.flow.state.draft,null);
}finally{wait.resolve({status:400});r.stop();}});
test('UniApp late deletion confirmation cannot target a stale title object',async()=>{let modal;const r=setup(()=>undefined,{modal:o=>{modal=o;}});try{await r.start({});await r.flow.selectKind('titles');const wait=r.flow.remove(r.flow.titles[0]);await r.flow.load();modal.success({confirm:true});await wait;assert.equal(r.sent.filter(c=>c.method==='DELETE').length,0);}finally{r.stop();}});
test('UniApp failed write uses one mutation and read-only reconciliation without retaining the form',async()=>{const r=setup(c=>c.method==='POST'?{transport:'owned unknown write'}:undefined);try{
  await r.start({});await r.flow.selectKind('titles');r.flow.edit(r.flow.titles[0]);await r.flow.save();assert.equal(r.sent.filter(c=>c.method==='POST').length,1);assert.equal(r.flow.state.draft,null);assert.match(r.flow.state.message,/重新读取当前资料/);
}finally{r.stop();}});
test('UniApp hidden pending write cannot be repeated while readback precedes its terminal result',async()=>{const wait=deferred(),r=setup(c=>c.method==='POST'?wait.promise:undefined);try{
  await r.start({});await r.flow.selectKind('titles');r.flow.edit(r.flow.titles[0]);const pending=r.flow.save();await tick();r.hooks.onHide();r.hooks.onShow();await tick();r.flow.edit();assert.equal(r.flow.state.uncertain,true);assert.equal(r.flow.state.draft,null);
  wait.resolve({data:{version:1,uid:11,action:'save',id:71}});await pending;await r.flow.load();assert.equal(r.sent.filter(c=>c.method==='POST').length,1);assert.equal(r.flow.state.uncertain,false);
}finally{wait.resolve({status:400});r.stop();}});
for(const query of [{orderId:['a','b']},{orderId:'../bad'},{orderId:'a',uid:'22'},{}])test('UniApp invalid invoice route sends no request '+JSON.stringify(query),async()=>{const r=setup(()=>undefined,{orderPage:true});try{await r.start(query);assert.equal(r.sent.length,0);assert.ok(r.flow.state.error);}finally{r.stop();}});
test('UniApp anonymous invoice hub has login action without private reads',async()=>{const r=setup(()=>undefined,{authenticated:false});try{await r.start({});assert.equal(r.sent.length,0);r.flow.login();assert.deepEqual(r.navigations,['/pages/auth/login']);}finally{r.stop();}});
test('UniApp malformed own-view response clears all previously shown invoice data',async()=>{let malformed=false;const r=setup(()=>malformed?{data:fixture.page({kind:'records',cursor:null,limit:20},{uid:22})}:undefined);try{await r.start({});assert.equal(r.flow.records.length,1);malformed=true;await r.flow.load();assert.equal(r.flow.state.page,null);assert.equal(r.flow.records.length,0);assert.ok(r.flow.state.error);}finally{r.stop();}});
test('UniApp H5 hash/document listeners reject duplicate order parameters and do not resurrect a hidden page',async()=>{
  const oldWindow=Object.getOwnPropertyDescriptor(globalThis,'window'),oldDocument=Object.getOwnPropertyDescriptor(globalThis,'document'),listeners=new Map(),location={hash:'#/pages/user/invoiceOrder?orderId=invoice_order_A'},doc={visibilityState:'visible',addEventListener:(k,f)=>listeners.set(k,f),removeEventListener:k=>listeners.delete(k)};
  Object.defineProperty(globalThis,'window',{configurable:true,value:{location,addEventListener:(k,f)=>listeners.set(k,f),removeEventListener:k=>listeners.delete(k)}});Object.defineProperty(globalThis,'document',{configurable:true,value:doc});
  const r=setup(()=>undefined,{orderPage:true});try{await r.start({orderId:'invoice_order_A'});assert.ok(r.flow.state.order);location.hash='#/pages/user/invoiceOrder?orderId=a&orderId=b';listeners.get('hashchange')();await tick();assert.equal(r.flow.state.order,null);assert.ok(r.flow.state.error);
    location.hash='#/pages/order/detail?orderId=invoice_order_A';listeners.get('hashchange')();const count=r.sent.length;r.hooks.onHide();doc.visibilityState='hidden';listeners.get('visibilitychange')();doc.visibilityState='visible';listeners.get('visibilitychange')();await tick();assert.equal(r.sent.length,count);assert.equal(r.flow.state.page,null);
  }finally{r.stop();if(oldWindow)Object.defineProperty(globalThis,'window',oldWindow);else delete globalThis.window;if(oldDocument)Object.defineProperty(globalThis,'document',oldDocument);else delete globalThis.document;}
});
