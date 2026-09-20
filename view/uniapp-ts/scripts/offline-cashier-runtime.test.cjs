const test=require('node:test');
const assert=require('node:assert/strict');
const {randomBytes}=require('node:crypto');
const {runtime,tick,deferred}=require('./uni-store-runtime.cjs');
const order='xx'+'3'.repeat(30);
const details=(change={})=>({order_id:order,money:'12.50',pay_price:'10.00',channel:'routine',hidden:false,pay_type:'',paid:false,created_at:100,state:'UNSELECTED',...change});
const capabilities=()=>({order_id:order,channel:'routine',pay_price:'10.00',now_money:'100.00',site_name:'本地测试',offline_pay_status:true,
  yue_pay_status:1,pay_weixin_open:1,ali_pay_status:0,methods:{yue:'available',weixin:'available',alipay:'channel_unsupported'}});
for(const route of [{},{orderId:order}])test(`Uni actual result page requires explicit identity and ignores another pending journal (${JSON.stringify(route)})`,async()=>{
  const original=JSON.stringify({version:2,uid:11,orderId:'xx'+'4'.repeat(30)}),storage=new Map([['cinashop_offline_pending_v1_11',original]]);
  const r=runtime({component:'pages/annex/offline_result/index.vue',storage,send:async c=>{
    assert.equal(c.method,'GET');assert.ok(c.url.endsWith('/offline/detail/'+order));return {data:details()};
  }});
  try{await r.start(route);await r.checkout.cashier.pay('yue');await r.checkout.cashier.create();await r.checkout.cashier.loadHistory();
    assert.equal(r.calls.length,route.orderId?1:0);assert.equal(r.checkout.state.value.intent,null);
    assert.equal(r.checkout.state.value.detail?.order_id,route.orderId);assert.equal(storage.get('cinashop_offline_pending_v1_11'),original);
    if(route.orderId){r.auth.clear();assert.equal(r.checkout.state.value.detail,null);r.auth.setLogin('returned',11);await tick();
      assert.equal(r.calls.length,2);assert.equal(r.checkout.state.value.detail.order_id,order);}
  }finally{r.stop();}
});
function setup(override=()=>undefined,storage=new Map()) {
  const r=runtime({feature:'useOfflineCashier',storage,send:async c=>{
    const custom=await override(c);if(custom)return custom;
    if(c.url.endsWith('/check/price'))return {data:{pay_price:'10.00'}};
    if(c.url.endsWith('/offline/create'))return {data:{order_id:order,pay_price:'10.00',replayed:false}};
    if(c.url.includes('/offline/detail/'))return {data:details()};
    if(c.url.endsWith('/offline/pay/type'))return {data:capabilities()};
    if(c.url.endsWith('/offline/history'))return {data:{items:[{order_id:order,money:'12.50',pay_price:'10.00',channel:'routine',created_at:100,hidden:false}],next_cursor:''}};
    if(c.url.endsWith('/offline/pay'))return {data:details({paid:true,pay_type:'yue',state:'PAID',paid_at:101})};
    throw Error('Unexpected route');
  }});
  r.uni.getRandomValues=opts=>{const bytes=randomBytes(opts.length);opts.success({randomValues:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)});};
  return {...r,async admit(){await r.start({});r.checkout.cashier.edit('12.50');await r.checkout.cashier.quote();await r.checkout.cashier.create();}};
}
test('Uni actual Pinia/request/API flow persists UUID and sends only the strict offline contract',async()=>{
  const r=setup();try{await r.admit();const create=r.calls.find(c=>c.url.endsWith('/offline/create'));assert.deepEqual(Object.keys(create.data).sort(),['money','expected_pay_price','from','request_key'].sort());
    assert.equal(create.data.from,'routine');assert.match(create.data.request_key,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    assert.equal(r.checkout.state.value.detail.paid,false);await r.checkout.cashier.pay('yue');assert.equal(r.checkout.state.value.detail.state,'PAID');
    const pay=r.calls.find(c=>c.url.endsWith('/offline/pay'));assert.deepEqual(pay.data,{order_id:order,pay_type:'yue',return_client:'h5'});
  }finally{r.stop();}
});
test('Uni create transport loss and restart retry the same persisted request without automatic write',async()=>{
  const first=setup(c=>c.url.endsWith('/offline/create')?{transport:'lost create'}:undefined);await first.admit();const before=first.calls.find(c=>c.url.endsWith('/offline/create')).data;first.stop();
  const second=setup(()=>undefined,first.storage);try{await second.start({});assert.equal(second.calls.length,0);await second.checkout.cashier.create();assert.deepEqual(second.calls[0].data,before);
    assert.equal(second.checkout.state.value.detail.paid,false);
  }finally{second.stop();}
});
test('Uni missing secure RNG blocks before POST',async()=>{
  const r=setup();delete r.uni.getRandomValues;try{await r.admit();assert.equal(r.calls.some(c=>c.url.endsWith('/offline/create')),false);assert.match(r.checkout.state.value.error,/安全随机/);}finally{r.stop();}
});
for(const server of ['rejected','old-zero'])test(`Uni minimum payable policy blocks ${server} quote without POST or journal`,async()=>{
  const r=setup(c=>c.url.endsWith('/check/price')?(server==='rejected'?{status:400,msg:'线下消费应付金额至少为0.01元'}:{data:{pay_price:'0.00'}}):undefined);
  try{await r.start({});r.checkout.cashier.edit('0.01');await r.checkout.cashier.quote();await r.checkout.cashier.create();
    assert.equal(r.checkout.state.value.quote,'');assert.match(r.checkout.state.value.error,/至少为0.01元/);
    assert.equal(r.calls.length,1);assert.ok(r.calls[0].url.endsWith('/check/price'));assert.equal(r.storage.has('cinashop_offline_pending_v1_11'),false);
  }finally{r.stop();}
});
test('Uni historical zero consumption is read-only and never declares paid',async()=>{
  const r=setup(c=>c.url.includes('/offline/detail/')?{data:details({money:'0.01',pay_price:'0.00',state:'UNAVAILABLE'})}:undefined);
  try{await r.start({orderId:order});await r.checkout.cashier.pay('yue');await r.checkout.cashier.create();
    assert.equal(r.checkout.state.value.detail.state,'UNAVAILABLE');assert.equal(r.checkout.state.value.detail.paid,false);
    assert.equal(r.calls.length,1);assert.equal(r.calls[0].method??'GET','GET');
  }finally{r.stop();}
});
test('Uni corrupted stored draft cannot be discarded into a new consumption',async()=>{
  const r=setup();r.storage.set('cinashop_offline_pending_v1_11','{"version":1}');try{await r.admit();assert.equal(r.calls.length,0);assert.ok(r.checkout.state.value.error);}finally{r.stop();}
});
test('Uni auth loss hides private state synchronously and same-owner return only reads',async()=>{
  const r=setup();try{await r.admit();r.auth.clear();assert.equal(r.checkout.state.value.intent,null);assert.equal(r.checkout.state.value.detail,null);const n=r.calls.length;
    await r.checkout.cashier.refresh();assert.equal(r.calls.length,n);r.auth.setLogin('returned',11);await tick();assert.equal(r.calls.length,n+2);assert.ok(r.calls.at(-2).url.includes('/offline/detail/'));assert.ok(r.calls.at(-1).url.endsWith('/offline/pay/type'));
  }finally{r.stop();}
});
for(const ending of ['onHide','onUnload','identity'])test(`Uni stale create after ${ending} cannot repopulate or send detail`,async()=>{
  const pending=deferred(),r=setup(c=>c.url.endsWith('/offline/create')?pending.promise:undefined);
  try{await r.start({});r.checkout.cashier.edit('12.50');await r.checkout.cashier.quote();const request=r.checkout.cashier.create();await tick();
    if(ending==='identity')r.auth.setLogin('other',22);else r.hooks[ending]();
    pending.resolve({data:{order_id:order,pay_price:'10.00',replayed:false}});await request;assert.equal(r.checkout.state.value.detail,null);
    assert.equal(r.calls.some(c=>c.url.includes('/offline/detail/')),false);
    assert.equal(JSON.parse(r.storage.get('cinashop_offline_pending_v1_11')).orderId,undefined);
  }finally{pending.resolve({status:400});r.stop();}
});
test('Uni double submit has one in-flight create and no automatic payment',async()=>{
  const pending=deferred(),r=setup(c=>c.url.endsWith('/offline/create')?pending.promise:undefined);try{await r.start({});r.checkout.cashier.edit('12.50');await r.checkout.cashier.quote();
    const one=r.checkout.cashier.create();await r.checkout.cashier.create();await tick();assert.equal(r.calls.filter(c=>c.url.endsWith('/offline/create')).length,1);
    pending.resolve({data:{order_id:order,pay_price:'10.00',replayed:false}});await one;assert.equal(r.calls.filter(c=>c.url.endsWith('/offline/pay')).length,0);
  }finally{pending.resolve({status:400});r.stop();}
});
test('Uni actual native payment callback never declares success before server confirmation',async()=>{
  const ready=details({state:'READY',pay_type:'weixin',display_until:Math.floor(Date.now()/1000)+240,
    ticket:{kind:'wechat-jsapi',appId:'wx-local',timeStamp:'100',nonceStr:'local-nonce',package:'prepay_id=local-only',signType:'RSA',paySign:'A'.repeat(128)}});
  let entrance=false,invokes=0;const r=setup(c=>entrance&&c.url.includes('/offline/detail/')?{data:ready}:undefined);
  r.uni.requestPayment=opts=>{invokes++;opts.success();};
  try{await r.admit();entrance=true;await r.checkout.cashier.refresh();await r.checkout.cashier.open(r.checkout.launchOfflineTicket);assert.equal(invokes,1);
    assert.equal(r.checkout.state.value.detail.paid,false);assert.equal(r.checkout.state.value.detail.state,'READY');assert.equal(r.calls.filter(c=>c.url.endsWith('/offline/pay')).length,0);
  }finally{r.stop();}
});
test('Uni route success/amount flags cannot bypass a server detail read',async()=>{
  const r=setup(c=>{if(c.url.endsWith('/offline/pay/type'))assert.equal(c.method,'GET');});try{await r.start({orderId:order,paid:'true',status:'SUCCESS',money:'0.01'});assert.equal(r.checkout.state.value.detail.paid,false);assert.equal(r.checkout.state.value.detail.pay_price,'10.00');assert.equal(r.calls.length,2);assert.deepEqual(r.calls.at(-1).data,{order_id:order,return_client:'h5'});}finally{r.stop();}
});
test('Uni changed availability blocks actual POST and clears all private method state on account loss',async()=>{
  let n=0;const r=setup(c=>c.url.endsWith('/offline/pay/type')&&++n>1?{data:{...capabilities(),yue_pay_status:0,methods:{...capabilities().methods,yue:'disabled'}}}:undefined);
  try{await r.admit();await r.checkout.cashier.pay('yue');assert.equal(r.calls.some(c=>c.url.endsWith('/offline/pay')),false);assert.match(r.checkout.state.value.error,/本页未发送/);
    assert.equal(r.checkout.state.value.capabilities.methods.yue,'disabled');r.auth.clear();assert.equal(r.checkout.state.value.capabilities,null);
  }finally{r.stop();}
});
test('Uni history uses authenticated native GET, recovers without creating and restores the durable original after restart',async()=>{
  const first=setup(c=>{if(c.url.endsWith('/offline/history'))assert.equal(c.method,'GET');});
  try{await first.start({});await first.checkout.cashier.loadHistory();assert.equal(first.checkout.state.value.history.items.length,1);
    assert.deepEqual(first.calls.at(-1).data,{});await first.checkout.cashier.recover(order);
    assert.deepEqual(JSON.parse(first.storage.get('cinashop_offline_pending_v1_11')),{version:2,uid:11,orderId:order});
    assert.equal(first.calls.some(c=>c.url.endsWith('/offline/create')||c.url.endsWith('/offline/pay')),false);
  }finally{first.stop();}
  const second=setup(()=>undefined,first.storage);try{await second.start({});assert.equal(second.checkout.state.value.detail.order_id,order);
    assert.equal(second.calls.length,2);assert.equal(second.checkout.state.value.money,'12.50');await second.checkout.cashier.create();assert.equal(second.calls.length,2);
  }finally{second.stop();}
});
test('Uni exact history search and auth loss cannot expose a late account list',async()=>{
  const pending=deferred(),r=setup(c=>c.url.endsWith('/offline/history')?pending.promise:undefined);
  try{await r.start({});r.checkout.cashier.searchHistory(order);const work=r.checkout.cashier.loadHistory();await tick();assert.deepEqual(r.calls.at(-1).data,{order_id:order});
    r.auth.clear();assert.equal(r.checkout.state.value.history.query,'');pending.resolve({data:{items:[{order_id:order,money:'12.50',pay_price:'10.00',channel:'routine',created_at:100,hidden:false}],next_cursor:''}});
    await work;assert.equal(r.checkout.state.value.history.items.length,0);assert.equal(r.storage.has('cinashop_offline_pending_v1_11'),false);
  }finally{pending.resolve({status:400});r.stop();}
});
test('Uni recovery does not overwrite a pending consumption or submit the recovered order automatically',async()=>{
  const r=setup();try{await r.admit();const before=r.storage.get('cinashop_offline_pending_v1_11');await r.checkout.cashier.recover('xx'+'4'.repeat(30));
    assert.equal(r.storage.get('cinashop_offline_pending_v1_11'),before);assert.match(r.checkout.state.value.error,/不会覆盖/);
    assert.equal(r.calls.filter(c=>c.url.endsWith('/offline/create')).length,1);assert.equal(r.calls.filter(c=>c.url.endsWith('/offline/pay')).length,0);
  }finally{r.stop();}
});
