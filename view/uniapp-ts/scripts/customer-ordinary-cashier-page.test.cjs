const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {runtime,tick,deferred,render}=require('./user-center-runtime.cjs');
const scope='a'.repeat(64),clone=value=>structuredClone(value);
const canonical=v=>Array.isArray(v)?`[${v.map(canonical).join(',')}]`:v&&typeof v==='object'?`{${Object.keys(v).sort().map(key=>`${JSON.stringify(key)}:${canonical(v[key])}`).join(',')}}`:JSON.stringify(v);
const digest=v=>crypto.createHash('sha256').update(canonical(v)).digest('hex');
async function rendered(r){
  for(const file of ['components/ThemePage.vue','components/customerWork/CustomerWorkShell.vue'])await render(r,file);
  const fs=require('node:fs'),path=require('node:path'),vue=require('vue'),pinia=require('pinia'),sfc=require('@vue/compiler-sfc'),dom=require('@vue/compiler-dom');
  const file=path.resolve(__dirname,'../src/pages/customer-work/ordinaryCashier.vue'),descriptor=sfc.parse(fs.readFileSync(file,'utf8'),{filename:file}).descriptor;
  const bindings=sfc.compileScript(descriptor,{id:'actual-ordinary-page-render'}).bindings;
  const renderFn=new Function('Vue',dom.compile(descriptor.template.content,{mode:'function',prefixIdentifiers:true,bindingMetadata:bindings,
    isCustomElement:tag=>['view','text','image','scroll-view','picker'].includes(tag)}).code)(vue);
  const app=vue.createSSRApp({render:renderFn,setup:()=>r.page});app.use(pinia.getActivePinia());
  return require('@vue/server-renderer').renderToString(app);
}
function make(options={}){
  const context={version:'customer-work-read-v1',actor_uid:11,principal:{kind:'customer-order-manager',service_id:1,scope:'global'},scope_key:scope,consistency_key:'b'.repeat(64),data:{profile:{uid:11,nickname:'经营账号',phone:'12345678',avatar:''},capabilities:{statistics:true,orders:true,refunds:true,logistics:true,product_management:false,user_management:false,assisted_order:false,writes:false,cashier_ordinary:false},cashier_ordinary_readiness:{writes:false,reason:'ordinary_source_not_commissioned'}}};
  context.data.metric_scopes={sales:'global_fulfillment_orders',order_totals:'global_fulfillment_orders',order_state_counts:'platform_fulfillment_orders',refund_counts:'global_refunds',inventory:'global_products',visits:'global_product_visits'};
  const envelope=data=>({version:'customer-cashier-ordinary-read-v1',actor_uid:11,principal:context.principal,scope_key:scope,consistency_key:digest({scope_key:scope,data}),data:clone(data)});
  const form=id=>({id,name:'补充信息',value:[{id:'picture',name:'uploadPicture',value:[],titleConfig:{value:'证明图片'},titleShow:{val:true}}]});
  const product=id=>({id,store_name:`商品 ${id}`,image:'',product_type:0,system_form_id:options.forms?id===70?5:6:0});
  const detail=id=>({product:product(id),skus:[{sku_unique:'sku-a',sku:'红色',image:'',price:'10.00',stock:5},{sku_unique:'sku-b',sku:'蓝色',image:'',price:'12.00',stock:8}],system_form:options.forms?form(id===70?5:6):null,readiness:{writes:false,reason:'ordinary_source_not_commissioned'}});
  let revoked=false;
  const r=runtime({component:'pages/customer-work/ordinaryCashier.vue',modal:true,send:async call=>{
    const route=new URL(call.url,'http://localhost').pathname;
    const override=await options.intercept?.(call,{envelope,detail});if(override!==undefined)return override;
    if(route==='/api/mobile/work/context')return revoked?{httpStatus:403,status:403,msg:'经营资格已撤销'}:{data:clone(context)};
    if(route.endsWith('/ordinary/readiness'))return{data:envelope({writes:false,reason:'ordinary_source_not_commissioned',product_types:[0],max_rows:200,payments:{cash:false,zero:false,weixin:false,alipay:false}})};
    if(route.endsWith('/ordinary/catalog'))return{data:envelope({list:[{...product(70),sku_count:2},{...product(71),sku_count:2}],page:1,limit:20,has_more:false,readiness:{writes:false,reason:'ordinary_source_not_commissioned'}})};
    if(/\/ordinary\/catalog\/(70|71)$/.test(route))return{data:envelope(detail(Number(route.split('/').at(-1))))};
    throw Error(`Unexpected page request ${call.method} ${route}`);
  }});
  return{r,revoke(){revoked=true;},context,envelope,detail};
}
test('actual ordinary page presents all SKUs and local rows while a closed source prevents saving a financial draft',async()=>{
const {r}=make();try{await r.start();assert.ok(r.page.manager.context.value);await r.page.selectProduct(70);assert.equal(r.page.selection.value.skus.length,2);r.page.skuUnique.value='sku-a';r.page.addQuantity.value='2';await r.page.addSelected();r.page.skuUnique.value='sku-b';await r.page.addSelected();assert.equal(r.page.cartRows.value.length,2);assert.equal(r.page.operations.canWrite.value,false);await r.page.saveDraft();assert.equal(r.calls.some(call=>call.method==='POST'),false);const html=await rendered(r);assert.ok(html.includes('普通收银暂未开放提交'));assert.ok(html.includes('红色'));assert.ok(html.includes('蓝色'));}finally{r.stop();}
});
test('actual page refuses mixing different nonzero system forms before changing local cart rows',async()=>{
  const {r}=make({forms:true});try{await r.start();await r.page.selectProduct(70);r.page.skuUnique.value='sku-a';await r.page.addSelected();assert.equal(r.page.formInfo.value.id,5);await r.page.selectProduct(71);r.page.skuUnique.value='sku-b';await r.page.addSelected();assert.equal(r.page.cartRows.value.length,1);assert.match(r.page.message.value,/不同的自定义表单/);assert.equal(r.calls.some(call=>call.method==='POST'),false);}finally{r.stop();}
});
test('an account change discards delayed private selection callbacks and clears draft contacts',async()=>{
  const reply=deferred();const {r}=make({intercept:(call,s)=>call.url.endsWith('/catalog/70')?reply.promise.then(()=>({data:s.envelope(s.detail(70))})):undefined});
  try{await r.start();r.page.contact.value={name:'旧账号联系人',phone:'12345678'};const pending=r.page.selectProduct(70);await tick();r.auth.setLogin('replacement-user-token',12);reply.resolve();await pending;await tick();assert.equal(r.page.selection.value,null);assert.equal(r.page.contact.value.name,'');assert.equal(r.page.localRows.value.length,0);}finally{r.stop();}
});
test('the native picker lease keeps the original page once and account changes revoke it',async()=>{
  const {r}=make({forms:true});try{await r.start();await r.page.selectProduct(70);r.page.skuUnique.value='sku-a';await r.page.addSelected();await r.page.beforeChooseImages(0);const original=r.page.manager.context.value;r.hooks.onHide();assert.equal(r.page.manager.context.value,original);assert.equal(r.page.manager.suspendLeaseActive(),true);r.hooks.onShow();await tick();assert.equal(r.page.manager.context.value,original);r.page.setFormChoosing(false);assert.equal(r.page.manager.suspendLeaseActive(),false);await r.page.beforeChooseImages(0);r.hooks.onHide();r.auth.setLogin('replacement-user-token',12);assert.equal(r.page.manager.suspendLeaseActive(),false);assert.equal(r.page.form.value.length,0);}finally{r.stop();}
});
test('guest selection creates a per-order tourist key without changing the registered operator identity',async()=>{
  const {r}=make();try{await r.start();await r.page.chooseGuest();assert.equal(r.page.buyerMode.value,'guest');assert.match(r.page.touristKey.value,/^[a-f0-9-]{36}$/);assert.equal(r.auth.uid,11);assert.equal(r.page.buyer.value,null);assert.equal(r.calls.some(call=>call.method==='POST'),false);}finally{r.stop();}
});
test('invalid route parameters close the actual page before reading any business data',async()=>{
  const {r}=make();try{await r.start({buyer_uid:'0'});assert.equal(r.page.manager.context.value,null);assert.match(r.page.manager.error.value,/参数/);assert.equal(r.calls.length,0);}finally{r.stop();}
});
test('changing a product or member search term before loading more starts the new query at page one',async()=>{
  const seen=[];const {r}=make({intercept:(call,s)=>{
    if(!/\/ordinary\/(catalog|users)$/.test(call.url))return;
    const member=call.url.endsWith('/users'),id=call.data.keyword==='new'?71:70;seen.push({member,keyword:call.data.keyword,page:call.data.page});
    return{data:s.envelope(member?{list:[{uid:id,nickname:'会员 '+id,phone:'12345678',integral:0,now_money:'0.00'}],page:Number(call.data.page),limit:20,has_more:true}:
      {list:[{id,store_name:'商品 '+id,image:'',product_type:0,system_form_id:0,sku_count:1}],page:Number(call.data.page),limit:20,has_more:true,readiness:{writes:false,reason:'closed'}})};
  }});
  try{await r.start();r.page.keyword.value='old';await r.page.searchProducts(false);r.page.keyword.value='new';await r.page.searchProducts(true);assert.deepEqual(r.page.catalog.value.list.map(row=>row.id),[71]);assert.deepEqual(seen.filter(row=>!row.member).at(-1),{member:false,keyword:'new',page:1});
    r.page.buyerKeyword.value='old';await r.page.searchBuyers(false);r.page.buyerKeyword.value='new';await r.page.searchBuyers(true);assert.deepEqual(r.page.buyers.value.list.map(row=>row.uid),[71]);assert.deepEqual(seen.filter(row=>row.member).at(-1),{member:true,keyword:'new',page:1});
  }finally{r.stop();}
});
test('the actual page hides the local-record reminder after original payment recovery and journal closure',async()=>{
  const path=require('node:path'),key='11111111-1111-4111-8111-111111111111',creationKey='22222222-2222-4222-8222-222222222222';
  const order={order_id:77,order_no:'wx-real-77',buyer_uid:0,creator_uid:23,pay_price:'30.00',paid:0,pay_type:'',shipping_type:2,store_id:3,total_num:3};
  const body={version:'customer-cashier-ordinary-payment-v1',scope_key:scope,order_id:order.order_id,order_no:order.order_no,expected_amount:order.pay_price};
  const source={order_id:order.order_id,order_no:order.order_no,buyer_uid:order.buyer_uid,creator_uid:order.creator_uid,amount:order.pay_price,origin_hash:'c'.repeat(64),creation_key:creationKey};
  const receipt={version:'customer-cashier-ordinary-receipt-v1',actor_uid:11,request_key:key,request_hash:digest(body),scope_key:scope,kind:'payment',intent:body,
    evidence:{outcome:'cash-paid',payment:{order_id:order.order_id,order_no:order.order_no,buyer_uid:order.buyer_uid,creator_uid:order.creator_uid,payer_uid:11,
      paid:1,pay_type:'cash',pay_time:Math.floor(Date.now()/1000),amount:order.pay_price,origin_hash:source.origin_hash,status_id:90,
      outbox:{id:91,event_key:'order.paid:77',event_type:'order.paid',payload_hash:'e'.repeat(64)}}}};
  const {r}=make({intercept:call=>call.url.endsWith(`/ordinary/operations/${key}`)?{data:{version:'customer-cashier-ordinary-receipt-v1',actor_uid:11,request_key:key,receipt}}:undefined});
  try{
    await r.start();
    // Seed the existing created-order read presentation; only the original payment GET is recovered here.
    r.page.operations.created.value={evidence:{order}};
    const hint='开始下一笔前，请先核对并关闭上方本机记录。';
    assert.equal((await rendered(r)).includes(hint),false);
    const protocol=r.load(path.resolve(__dirname,'../src/utils/customerWorkOrdinaryCashier.ts'));
    const pending=protocol.makeOrdinaryCashierPending(11,1,key,'payment',body,null,source);
    protocol.retainOrdinaryCashierPending(pending);r.page.operations.refreshPending();
    assert.equal((await rendered(r)).includes(hint),true);
    assert.throws(()=>r.page.operations.acknowledge(pending),/尚未核对/);
    const recovered=await r.page.operations.check(pending);assert.equal(recovered.request_key,key);
    assert.equal(r.page.paid.value,true);
    r.page.operations.acknowledge(pending);
    const closedHtml=await rendered(r);
    assert.equal(closedHtml.includes(hint),false);
    assert.ok(closedHtml.includes('原付款已核对。实际付款已记录'));
    assert.equal(protocol.ordinaryCashierPending().length,0);
    assert.equal(r.page.operations.payment.value.evidence.payment.paid,1);
    assert.equal(r.calls.filter(call=>call.url.endsWith(`/ordinary/operations/${key}`)).length,1);
    assert.equal(r.calls.some(call=>call.method==='POST'),false);
  }finally{r.stop();}
});
