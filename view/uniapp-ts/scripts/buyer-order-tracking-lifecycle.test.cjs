const test=require('node:test'),assert=require('node:assert/strict');
const {runtime,tick,deferred}=require('./uni-store-runtime.cjs');
const {tracking}=require('../../common/test/buyerOrderTrackingFixture.cjs');
function setup(override=()=>undefined,options={}) {
  const sent=[];const r=runtime({component:'pages/order/express.vue',platform:'H5',...options,send:async c=>{
    sent.push(c);assert.equal(c.method,'GET');assert.deepEqual(c.data,{view:'buyer'});
    const path=new URL(c.url,'http://127.0.0.1').pathname.split('/'),refund=path.at(-1)==='refund',reference=path.at(refund?-2:-1);
    return await override(c)??{data:tracking({reference,kind:refund?'refund':'order'})};
  }});return Object.assign(r,{sent});
}
test('UniApp actual logistics SFC uses explicit owner-bound view, return path, UTC metadata and current trace expansion',async()=>{
  const r=setup();try{await r.start({orderId:'25',type:'refund'});const v=r.checkout;
    assert.equal(v.kind.value,'refund');assert.equal(v.displayResult.value.expressNo,'RETURN-25');assert.equal(v.shipment.value.items[0].quantity,1);
    assert.match(r.sent[0].url,/\/express\/25\/refund$/);assert.match(v.updatedText.value,/UTC$/);assert.equal(v.visibleTraces.value.length,1);v.expand();assert.equal(v.visibleTraces.value.length,2);
  }finally{r.stop();}
});
test('UniApp package selection copies only current waybill and rejects old object/image callbacks',async()=>{
  const r=setup(()=>({data:tracking({split:true})})),copied=[];r.uni.setClipboardData=o=>{copied.push(o.data);o.success();};
  try{await r.start({orderId:'local_A'});const v=r.checkout,old=v.result.value.packages[0],image=v.shipment.value.items[0];
    v.select(v.result.value.packages[1]);assert.equal(v.shipment.value.recipientName,'私有联系人1');await v.copy();assert.deepEqual(copied,['PACKET-B']);assert.match(v.state.copyMessage,/已复制/);
    await v.load();v.select(old);assert.equal(v.selectedPackageId.value,'child_A');v.imageFailed(image);assert.deepEqual([...v.failedImages.value],[]);
  }finally{r.stop();}
});
for(const ending of ['identity','onHide','onUnload'])test('UniApp removes logistics and drops pending read/copy after '+ending,async()=>{
  const wait=deferred(),r=setup();let clipboard;r.uni.setClipboardData=o=>{clipboard=o;};
  try{await r.start({orderId:'local_A'});const copy=r.checkout.copy();
    if(ending==='identity')r.auth.setLogin('replacement',22);else r.hooks[ending]();
    assert.equal(r.checkout.result.value,null);clipboard.success();await copy;assert.equal(r.checkout.state.copyMessage,'');
  }finally{wait.resolve();r.stop();}
});
test('UniApp refresh failure clears private goods/traces and fresh show can recover',async()=>{
  let fail=false;const r=setup(()=>fail?{transport:'owned read failure'}:undefined);
  try{await r.start({orderId:'local_A'});fail=true;await r.checkout.load();assert.equal(r.checkout.result.value,null);assert.equal(r.checkout.shipment.value,null);assert.match(r.checkout.state.error,/owned read failure/);
    r.hooks.onHide();fail=false;r.hooks.onShow();await tick();assert.equal(r.checkout.displayResult.value.expressNo,'OUTGOING-local_A');
  }finally{r.stop();}
});
for(const mutation of [d=>{d.identity.uid=22;},d=>{d.identity.kind='refund';},d=>{d.contexts[0].uid=22;},d=>{d.order.delivery_id='wrong';}])test('UniApp rejects malformed/foreign actual API result '+mutation.toString(),async()=>{
  const r=setup(()=>{const d=tracking();mutation(d);return{data:d};});try{await r.start({orderId:'local_A'});assert.equal(r.checkout.result.value,null);assert.ok(r.checkout.state.error);}finally{r.stop();}
});
test('UniApp old outgoing response cannot replace return view or an A-B-A generation',async()=>{
  const wait=deferred();let first=true;const r=setup(c=>c.url.endsWith('/local_A')&&first?(first=false,wait.promise):undefined);
  try{await r.start({orderId:'local_A'});await r.start({orderId:'25',type:'refund'});await r.start({orderId:'local_A'});wait.resolve({data:tracking({reference:'local_A',split:true})});await tick();
    assert.equal(r.checkout.result.value.identity.reference,'local_A');assert.equal(r.checkout.result.value.packages.length,1);
  }finally{wait.resolve({status:400});r.stop();}
});
for(const query of [{orderId:'../bad'},{orderId:'return_public',type:'refund'},{orderId:'25',type:'other'},{orderId:['local_A','local_B']}])test('UniApp invalid logistics route sends no request '+JSON.stringify(query),async()=>{
  const r=setup();try{await r.start(query);assert.equal(r.sent.length,0);assert.ok(r.checkout.state.error);}finally{r.stop();}
});
test('UniApp anonymous logistics page has a login action and sends no read',async()=>{const r=setup(()=>undefined,{authenticated:false});try{await r.start({orderId:'local_A'});assert.equal(r.sent.length,0);r.checkout.login();assert.deepEqual(r.navigations,['/pages/auth/login']);}finally{r.stop();}});
test('UniApp H5 actual hash listener rejects duplicate parameters and clears when navigating away',async()=>{
  const prior=Object.getOwnPropertyDescriptor(globalThis,'window'),listeners=new Map(),location={hash:'#/pages/order/express?orderId=local_A'};
  Object.defineProperty(globalThis,'window',{configurable:true,value:{location,addEventListener:(k,f)=>listeners.set(k,f),removeEventListener:(k)=>listeners.delete(k)}});
  const r=setup();try{await r.start({orderId:'local_A'});assert.ok(r.checkout.result.value);location.hash='#/pages/order/express?orderId=25&type=refund&type=refund';listeners.get('hashchange')();await tick();assert.equal(r.checkout.result.value,null);assert.ok(r.checkout.state.error);
    location.hash='#/pages/order/detail?orderId=local_A';listeners.get('hashchange')();assert.equal(r.checkout.result.value,null);
  }finally{r.stop();if(prior)Object.defineProperty(globalThis,'window',prior);else delete globalThis.window;}
});
test('UniApp hidden H5 page cannot reload a stale route after later document visibility events',async()=>{
  const oldWindow=Object.getOwnPropertyDescriptor(globalThis,'window'),oldDocument=Object.getOwnPropertyDescriptor(globalThis,'document'),listeners=new Map(),location={hash:'#/pages/order/express?orderId=local_A'},doc={visibilityState:'visible',addEventListener:(k,f)=>listeners.set(k,f),removeEventListener:k=>listeners.delete(k)};
  Object.defineProperty(globalThis,'window',{configurable:true,value:{location,addEventListener:(k,f)=>listeners.set(k,f),removeEventListener:k=>listeners.delete(k)}});Object.defineProperty(globalThis,'document',{configurable:true,value:doc});
  const r=setup();try{await r.start({orderId:'local_A'});location.hash='#/pages/order/detail?orderId=local_A';listeners.get('hashchange')();const count=r.sent.length;doc.visibilityState='hidden';listeners.get('visibilitychange')();doc.visibilityState='visible';listeners.get('visibilitychange')();await tick();assert.equal(r.sent.length,count);assert.equal(r.checkout.result.value,null);}finally{r.stop();if(oldWindow)Object.defineProperty(globalThis,'window',oldWindow);else delete globalThis.window;if(oldDocument)Object.defineProperty(globalThis,'document',oldDocument);else delete globalThis.document;}
});
