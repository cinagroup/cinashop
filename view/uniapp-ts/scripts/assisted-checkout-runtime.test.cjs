const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');
const root = path.resolve(__dirname, '..');
const permissions = ['order.assisted','product.view','user.view'];
const key = 'a'.repeat(32), token = 'b'.repeat(32), savedKey = 'cinashop_assisted_pending_v1_1';
const manual = {realName:'合成收货人',phone:'13000000000',province:'甲省',city:'乙市',district:'丙区',street:'',detail:'本地合成地址',cityId:3};
const address = {...manual,id:11,uid:11,real_name:manual.realName,city_id:3,is_del:0,is_default:1};
function cart(uid=11,type=0) {return {id:21,uid,staff_id:1,type:0,activity_id:0,store_id:0,is_new:0,is_del:0,is_pay:0,status:1,
  product_id:7,product_attr_unique:'sku1',cart_num:1,is_valid:1,truePrice:9,trueStock:9,
  productInfo:{id:7,product_type:type,store_name:'合成商品',image:'',is_presale_product:0,
    attrInfo:{id:1,product_id:7,unique:'sku1',suk:'合成规格',price:'10.00',stock:9,image:''}}};}
function quote(body,uid=11,type=0) {
  const requires=body.shipping_type===1 && ![1,2,3].includes(type);
  const selected=requires?(body.manualAddress?{...body.manualAddress,id:0,real_name:body.manualAddress.realName,city_id:body.manualAddress.cityId}:address):null;
  return {orderKey:key,quoteToken:token,checkout:{version:1,adminId:1,uid,touristUid:body.tourist_uid,cartIds:[21],isNew:0,
    shippingType:body.shipping_type,storeId:body.store_id,couponId:body.couponId,useIntegral:body.useIntegral,payType:body.payType,
    addressSource:selected?(selected.id?'saved':'manual'):'none',addressRequired:requires,systemFormId:0},
    systemForm:null,addressInfo:selected,cartInfo:[cart(uid,type)],integral_ratio_status:uid?1:0,userInfo:{uid,integral:uid?100:0},
    priceGroup:{sumPrice:'10.00',totalPrice:'9.00',vipPrice:'1.00',couponPrice:'0.00',firstOrderPrice:'0.00',total_postage:requires?'6.00':'0.00',storePostageDiscount:requires?'3.00':'0.00',
      deduction_price:body.useIntegral?'0.50':'0.00',pay_postage:requires?'3.00':'0.00',pay_price:requires?(body.useIntegral?'11.50':'12.00'):'9.00',
      usedIntegral:body.useIntegral?50:0,SurplusIntegral:uid?(body.useIntegral?50:100):0}};
}
function server({uid=11,type=0,transform=v=>v,create,city}={}) {
  return async call=>{
    assert.equal(call.header['Authori-zation'],undefined,'shopper token must never reach assisted APIs');
    const publicApi=['/api/store/list','/api/city'].includes(call.url);
    assert.equal(call.header.Authorization,publicApi?undefined:'Bearer admin-1');
    if(call.url.includes('/order/cart/'))return {data:[cart(uid,type)]};
    if(call.url.includes('/user/address/list/'))return {data:[address]};
    if(call.url==='/api/store/list')return {data:[{id:1,name:'本地门店',address:'甲省',detailed_address:'合成地址'}]};
    if(call.url==='/api/city')return city?city(call):{data:call.data.pid>=4?[]:[{id:call.data.pid+1,value:call.data.pid+1,pid:call.data.pid,label:['甲省','乙市','丙区','丁街道'][call.data.pid],...(call.data.pid<3?{children:[]}: {})}]};
    if(call.url.includes('/order/coupons/'))return {data:[{id:41,coupon_title:'合成优惠券',true_coupon_price:'1.00'}]};
    if(call.url.includes('/order/confirm/')||call.url.includes('/order/computed/')){
      const value=await transform(quote(call.data,uid,type),call);
      return {data:call.url.includes('/computed/')?{result:value}:value};
    }
    if(call.url.includes('/order/create/'))return create?create(call):{data:{result:{key,order_id:'LOCAL_ORDER_1',pay_price:'12.00',extended:false}}};
    throw Error('Unexpected API '+call.url);
  };
}
async function setup(options={}) {
  const r=runtime({feature:'useAssistedCheckout',send:options.send||server(options),storage:options.storage,
    ...(options.component?{component:'pages/behalf/order_confirm/index.vue'}:{})});
  r.admin=r.load(path.join(root,'src/stores/adminSession.ts')).useAdminSession();
  r.draft=r.load(path.join(root,'src/stores/assistedDraft.ts')).useAssistedDraft();
  r.admin.install({id:1,label:'合成管理员',token:'admin-1',expiresAt:Date.now()+3600000,permissions:options.permissions||permissions});
  if(!options.resume && !options.noDraft)r.draft.choose(options.uid??11,options.uid===0?'guest-local':'');
  await r.start(options.query??(options.resume?{resume:'1'}:{uid:String(options.uid??11)}));
  return r;
}
const writes=r=>r.calls.filter(call=>call.url.includes('/order/create/'));
async function create(r){r.checkout.consent.value=true;await r.checkout.submit();await tick();}

test('actual confirm SFC reads exact Admin scope, complete quote and no create/payment until consent',async()=>{
  const r=await setup({component:true});try{
    assert.equal(r.checkout.quote.value.amounts.payable,'12.00');assert.equal(r.checkout.quote.value.address.id,11);
    assert.equal(r.checkout.quote.value.amounts.originalPostage,'6.00');assert.equal(r.checkout.quote.value.amounts.postageDiscount,'3.00');
    assert.equal(r.checkout.quote.value.items[0].price,'9.00');assert.equal(r.checkout.canSubmit.value,false);
    await r.checkout.submit();assert.equal(writes(r).length,0);assert.deepEqual([...r.storage.keys()].sort(),['uni_token','uni_uid']);
    r.checkout.consent.value=true;assert.equal(r.checkout.canSubmit.value,true);
  }finally{r.stop();}
});
test('natural Admin expiry removes assisted checkout delivery fields and quote without another request',async()=>{
  const r=await setup({component:true});try{
    assert.ok(r.checkout.quote.value);r.checkout.manual.value={...manual};
    const calls=r.calls.length;r.admin.expiresAt=Date.now()+80;r.admin.ensureFresh();
    await new Promise(resolve=>setTimeout(resolve,160));
    assert.equal(r.admin.token,'');assert.equal(r.checkout.scope.value,null);
    assert.deepEqual(r.checkout.items.value,[]);assert.deepEqual(r.checkout.addresses.value,[]);
    assert.equal(r.checkout.quote.value,null);assert.equal(r.checkout.manual.value.realName,'');
    assert.equal(r.calls.length,calls);
  }finally{r.stop();}
});
for(const [label,patch] of [
  ['owner',v=>v.checkout.adminId=2],['guest',v=>v.checkout.touristUid='foreign'],['cart set',v=>v.checkout.cartIds=[22]],
  ['cart staff',v=>v.cartInfo[0].staff_id=2],['cart paid',v=>v.cartInfo[0].is_pay=1],['sku',v=>v.cartInfo[0].productInfo.attrInfo.unique='wrong'],
  ['choice',v=>v.checkout.useIntegral=true],['address',v=>v.addressInfo.id=12],['amount',v=>v.priceGroup.pay_price='NaN'],
  ['receipt',v=>v.quoteToken='bad'],['missing item',v=>v.cartInfo=[]],['form shape',v=>v.checkout.systemFormId='0'],
])test('rejects malformed or foreign quote '+label,async()=>{
  const r=await setup({transform:v=>{patch(v);return v;}});try{assert.equal(r.checkout.quote.value,null);assert.ok(r.checkout.quoteError.value);await create(r);assert.equal(writes(r).length,0);}finally{r.stop();}
});
for(const type of [1,2,3])test('non-logistics '+type+' omits delivery address and never auto-pays',async()=>{
  const r=await setup({type});try{assert.equal(r.checkout.needsAddress.value,false);await create(r);
    assert.equal(writes(r).length,1);assert.equal(writes(r)[0].data.addressId,0);assert.equal(r.checkout.verified.value,true);
    assert.equal(r.calls.some(c=>/\/pay\//.test(c.url)),false);
  }finally{r.stop();}
});
test('second-card product requires selected pickup store and contacts before create',async()=>{
  const r=await setup({type:4});try{assert.deepEqual(r.checkout.shippingTypes.value,[2]);assert.equal(r.checkout.shipping.value,2);
    await create(r);assert.equal(writes(r).length,0);r.checkout.storeId.value=1;r.checkout.contact.value={name:'合成自提',phone:'13000000000'};
    await r.checkout.refreshQuote();await create(r);assert.equal(writes(r)[0].data.shipping_type,2);assert.equal(writes(r)[0].data.real_name,'合成自提');
  }finally{r.stop();}
});
test('guest structured address uses city_area cascade with no customer directory/auth and freezes exact address',async()=>{
  const r=await setup({uid:0});try{
    assert.equal(r.calls.some(c=>c.url.includes('/user/address')),false);assert.equal(r.checkout.quote.value,null);
    for(let level=0;level<3;level++)await r.checkout.selectRegion(level,0);
    Object.assign(r.checkout.manual.value,{realName:manual.realName,phone:manual.phone,detail:manual.detail});
    await r.checkout.refreshQuote();assert.equal(r.checkout.quote.value.address.cityId,3);await create(r);
    assert.deepEqual(writes(r)[0].data.manualAddress,manual);assert.equal(writes(r)[0].data.tourist_uid,'guest-local');
    assert.deepEqual(r.calls.filter(c=>c.url==='/api/city').map(c=>c.data.pid),[0,1,2,3]);
    assert.equal(writes(r)[0].data.adminId,undefined);
  }finally{r.stop();}
});
test('late child region cannot replace a newer province selection',async()=>{
  const wait=deferred();const r=await setup({uid:0,city:c=>c.data.pid===0?{data:[1,5].map(id=>({id,value:id,pid:0,label:'省'+id,children:[]}))}:c.data.pid===1?wait.promise:{data:[]}});
  try{const old=r.checkout.selectRegion(0,0);await tick();await r.checkout.selectRegion(0,1);
    wait.resolve({data:[{id:2,value:2,pid:1,label:'旧城市',children:[]}]});await old;
    assert.equal(r.checkout.manual.value.province,'省5');assert.deepEqual(r.checkout.regions.value[1],[]);
  }finally{wait.resolve({data:[]});r.stop();}
});
test('changing integral invalidates consent/current quote; older response cannot restore submit',async()=>{
  const wait=deferred();let slow=false;const r=await setup({transform:async(v,c)=>{if(slow&&c.data.useIntegral)await wait.promise;return v;}});
  try{r.checkout.consent.value=true;r.checkout.useIntegral.value=true;assert.equal(r.checkout.canSubmit.value,false);assert.equal(r.checkout.consent.value,false);
    slow=true;const old=r.checkout.refreshQuote();await tick();r.checkout.useIntegral.value=false;await r.checkout.refreshQuote();
    wait.resolve();await old;assert.equal(r.checkout.quote.value.usedPoints,0);assert.equal(r.checkout.canSubmit.value,false);
  }finally{wait.resolve();r.stop();}
});
test('coupon directory is explicit, only displayed IDs selectable, shipping invalidates candidate list',async()=>{
  const r=await setup();try{assert.equal(r.calls.some(c=>c.url.includes('/coupons/')),false);r.checkout.selectCoupon(99);assert.equal(r.checkout.couponId.value,0);
    await r.checkout.loadCoupons();r.checkout.selectCoupon(41);assert.equal(r.checkout.quote.value,null);assert.equal(r.checkout.couponId.value,41);
    r.checkout.setShipping(2);assert.equal(r.checkout.couponId.value,0);assert.deepEqual(r.checkout.coupons.value,[]);
  }finally{r.stop();}
});
test('required system form fails closed without inventing empty answers',async()=>{
  const r=await setup({transform:v=>({...v,checkout:{...v.checkout,systemFormId:4}})});try{await create(r);assert.equal(r.checkout.canSubmit.value,false);assert.equal(writes(r).length,0);}finally{r.stop();}
});

const formTemplate=()=>[
  ['texts',''],['radios','A'],['checkboxs',['A']],['selects','B'],['citys','本地市'],['dates','2026-09-23'],
  ['dateranges',['2026-09-23','2026-09-24']],['times','10:30'],['timeranges','10:30 - 11:30'],['uploadPicture',[]],
].map(([name,value],index)=>({id:String(index),name,value,titleConfig:{value:'合成项目'+index},titleShow:{val:true},
  wordsConfig:{list:[{val:'A'},{val:'B'}]},numConfig:{val:2}}));
const withForm=v=>({...v,checkout:{...v.checkout,systemFormId:77},systemForm:{version:1,id:77,name:'合成商品表单',value:formTemplate()}});
function filled(r){return r.checkout.customForm.value.map(item=>({...item,value:item.name==='texts'?'合成答案':item.name==='uploadPicture'?['/api/assets/41']:item.value}));}
const signed=(id=41)=>`/api/assets/${id}?expires=${Math.floor(Date.now()/1000)+600}&signature=${'x'.repeat(43)}`;
function fakeUpload(r,patch={}){r.uni.uploadFile=call=>{
  assert.equal(call.url,`/api/admin/order/form_image/${key}/${r.checkout.scope.value.uid}`);
  assert.equal(call.header.Authorization,'Bearer admin-1');assert.equal(call.header['Authori-zation'],undefined);assert.equal(call.name,'file');
  call.success({statusCode:200,data:JSON.stringify({status:200,data:{att_id:41,url:'/api/assets/41',src:signed(),...patch}})});
};}
function mountForm(r,{uploadImage}={}){
  const vue=require('vue'),events=[],props=vue.reactive({modelValue:r.checkout.customForm.value,disabled:false,uploadImage:uploadImage||r.checkout.uploadFormImage});
  const child=r.load(path.join(root,'src/components/SystemFormFields.vue')).default;let controls;
  const renderer=vue.createRenderer({createComment:()=>({}),insert(){},remove(){},parentNode:()=>null,nextSibling:()=>null});
  const app=renderer.createApp({setup(){
    vue.watchEffect(()=>{props.disabled=r.checkout.formLocked.value;props.modelValue=r.checkout.customForm.value;},{flush:'sync'});
    controls=child.setup(props,{expose(){},emit(name,value){events.push([name,value]);
      if(name==='update:modelValue')r.checkout.updateForm(value);if(name==='pending')r.checkout.onFormPending(value);if(name==='choosing')r.checkout.onFormChoosing(value);
    }});return ()=>null;
  }});app.mount({});return {controls,props,events,stop:()=>app.unmount()};
}

test('all ten authoritative components submit minimal canonical values through the actual page setup',async()=>{
  const r=await setup({component:true,transform:withForm});try{
    assert.equal(r.checkout.customForm.value.length,10);assert.ok(r.checkout.formValidation.value);
    await create(r);assert.equal(writes(r).length,0);
    r.checkout.updateForm(filled(r));assert.equal(r.checkout.formValidation.value,'');await create(r);
    const form=writes(r)[0].data.customForm;assert.equal(form.length,10);
    assert.ok(form.every(item=>Object.keys(item).sort().join(',')==='id,name,value'));
    const saved=r.storage.get(savedKey);assert.ok(saved.includes('合成答案'));assert.ok(!saved.includes('signature='));assert.ok(!saved.includes('wordsConfig'));assert.ok(!saved.includes('admin-1'));
  }finally{r.stop();}
});
for(const patch of [v=>v.systemForm.id=78,v=>v.systemForm.version=2,v=>v.systemForm.value=[],v=>v.systemForm.value[0].name='unsafe',v=>v.systemForm.value.push(v.systemForm.value[0])])
test('malformed authoritative form cannot enable submission '+patch.toString(),async()=>{
  const r=await setup({transform:v=>{v=withForm(v);patch(v);return v;}});try{assert.equal(r.checkout.quote.value,null);await create(r);assert.equal(writes(r).length,0);}finally{r.stop();}
});
test('template image defaults never import a member or previous checkout attachment',async()=>{
  const r=await setup({transform:v=>{v=withForm(v);v.systemForm.value[9].value=['/api/assets/99'];return v;}});try{
    assert.deepEqual(r.checkout.customForm.value[9].value,[]);assert.ok(r.checkout.formValidation.value);
  }finally{r.stop();}
});
test('repricing preserves same-template answers but a template edit clears answers, previews and consent',async()=>{
  let edited=false;const r=await setup({transform:v=>{v=withForm(v);if(edited)v.systemForm.value[0].titleConfig.value='新版项目';return v;}});try{
    r.checkout.updateForm(filled(r));const before=JSON.stringify(r.checkout.customForm.value);await r.checkout.refreshQuote();
    assert.equal(JSON.stringify(r.checkout.customForm.value),before);r.checkout.consent.value=true;
    r.checkout.updateForm(filled(r));assert.equal(r.checkout.consent.value,false);
    edited=true;await r.checkout.refreshQuote();assert.equal(r.checkout.customForm.value[0].value,'');assert.deepEqual(r.checkout.previews.value,{});assert.ok(r.checkout.formValidation.value);
  }finally{r.stop();}
});
test('frozen form survives timeout and restart with exact original values and no new quote or upload',async()=>{
  const first=await setup({transform:withForm,create:()=>({transport:'timeout'})});let original;
  try{first.checkout.updateForm(filled(first));await create(first);original=writes(first)[0];}finally{first.stop();}
  const second=await setup({storage:first.storage,resume:true,create:()=>({transport:'timeout'})});try{
    second.checkout.updateForm([]);await second.checkout.submit();assert.deepEqual(writes(second),[original]);assert.equal(second.calls.length,1);
  }finally{second.stop();}
});
test('only fresh first-attempt explicit form rejection may release the frozen request',async()=>{
  let count=0;const rejected={status:400,data:{errorCode:'ORDER_FORM_REJECTED',orderKey:key}};
  const r=await setup({transform:withForm,create:()=>++count===1?rejected:count===2?{transport:'timeout'}:rejected});try{
    r.checkout.updateForm(filled(r));await create(r);assert.equal(r.checkout.pending.value,null);assert.equal(r.storage.has(savedKey),false);
    await r.checkout.refreshQuote();await create(r);await r.checkout.submit();assert.equal(r.checkout.pending.value.attempts,2);assert.ok(r.storage.has(savedKey));
  }finally{r.stop();}
});
test('large legitimate minimal answers survive journal readback beyond the old 16 KB limit',async()=>{
  const r=await setup({transform:v=>{v=withForm(v);v.systemForm.value=[0,1,2].map(id=>({id,name:'texts',value:'',titleShow:{val:true}}));return v;}});try{
    r.checkout.updateForm(r.checkout.customForm.value.map(item=>({...item,value:'合'.repeat(9000)})));await create(r);
    assert.equal(writes(r).length,1);assert.equal(JSON.parse(r.storage.get(savedKey)).payload.customForm[0].value.length,9000);
  }finally{r.stop();}
});
for(const [label,change] of [['metadata',x=>x[0].assistedImageScope={}],['signature',x=>x[9].value=[signed()]],['external',x=>x[9].value=['https://foreign.invalid/p.png']],['overflow',x=>x[9].value=['/api/assets/2147483648']],['duplicate',x=>x[1].id=x[0].id]])
test('tampered stored form fails closed: '+label,async()=>{
  const first=await setup({transform:withForm,create:()=>({transport:'timeout'})});first.checkout.updateForm(filled(first));await create(first);first.stop();
  const raw=JSON.parse(first.storage.get(savedKey));change(raw.payload.customForm);first.storage.set(savedKey,JSON.stringify(raw));
  const r=await setup({storage:first.storage,resume:true});try{assert.ok(r.checkout.error.value);assert.equal(r.calls.length,0);assert.ok(r.storage.has(savedKey));}finally{r.stop();}
});
for(const uid of [11,0])test('scoped upload uses Admin-only credentials and canonical references uid='+uid,async()=>{
  const r=await setup({uid,type:1,transform:withForm});try{fakeUpload(r);const result=await r.checkout.uploadFormImage('local.png');
    assert.equal(result.url,'/api/assets/41');assert.equal(r.checkout.previews.value[result.url],result.src);assert.equal(r.storage.has(savedKey),false);
  }finally{r.stop();}
});
for(const patch of [{url:'/api/assets/42'},{src:'https://foreign.invalid/api/assets/41'},{src:signed(42)},{src:'/api/assets/41?expires=1&signature='+'x'.repeat(43)}])
test('invalid upload output never becomes an attachment '+JSON.stringify(patch),async()=>{
  const r=await setup({transform:withForm});try{fakeUpload(r,patch);await assert.rejects(r.checkout.uploadFormImage('local.png'));assert.deepEqual(r.checkout.previews.value,{});}finally{r.stop();}
});
for(const status of [200,401])test('late upload after Admin replacement cannot publish or clear new session status='+status,async()=>{
  const r=await setup({transform:withForm});try{let upload;r.uni.uploadFile=c=>upload=c;const pending=r.checkout.uploadFormImage('local.png');
    r.admin.install({id:2,label:'Other',token:'admin-2',expiresAt:Date.now()+3600000,permissions});
    upload.success({statusCode:status,data:JSON.stringify({status:200,data:{att_id:41,url:'/api/assets/41',src:signed()}})});
    await assert.rejects(pending,/身份已变化/);assert.equal(r.admin.id,2);assert.equal(r.auth.token,'synthetic-local-token');assert.deepEqual(r.checkout.previews.value,{});
  }finally{r.stop();}
});
test('active upload authentication failure clears only Admin, never shopper session or pending journal',async()=>{
  const r=await setup({transform:withForm});try{r.uni.uploadFile=c=>c.success({statusCode:401,data:''});await assert.rejects(r.checkout.uploadFormImage('local.png'));
    assert.equal(r.admin.authenticated,false);assert.equal(r.auth.token,'synthetic-local-token');
  }finally{r.stop();}
});
test('preview renewal checks exact IDs, sends only the scoped ID list and never changes answers',async()=>{
  const base=server({transform:withForm});const r=await setup({send:call=>call.url.includes('/form_preview/')?{data:[{att_id:41,reference:'/api/assets/41',url:signed()}]}:base(call)});try{
    r.checkout.updateForm(filled(r));const before=JSON.stringify(r.checkout.customForm.value);await r.checkout.refreshPreviews();
    assert.equal(JSON.stringify(r.checkout.customForm.value),before);assert.equal(r.checkout.previews.value['/api/assets/41'],signed());
    assert.deepEqual(r.calls.at(-1).data,{ids:[41]});assert.equal(writes(r).length,0);
  }finally{r.stop();}
});
test('foreign preview response is rejected without altering the original references',async()=>{
  const base=server({transform:withForm});const r=await setup({send:call=>call.url.includes('/form_preview/')?{data:[{att_id:42,reference:'/api/assets/42',url:signed(42)}]}:base(call)});try{
    r.checkout.updateForm(filled(r));await r.checkout.refreshPreviews();assert.match(r.checkout.previewError.value,/归属/);assert.deepEqual(r.checkout.previews.value,{});
  }finally{r.stop();}
});
test('actual time-range controls retain first selection and submission waits for a complete range',async()=>{
  const r=await setup({transform:withForm});const child=mountForm(r);try{
    r.checkout.updateForm(filled(r).map(item=>({...item,value:item.name==='timeranges'?'':item.value})));
    child.controls.setTimePart(8,0,'09:15');assert.equal(r.checkout.customForm.value[8].value,'09:15 - ');assert.ok(r.checkout.formValidation.value);
    child.controls.setTimePart(8,1,'10:30');assert.equal(r.checkout.customForm.value[8].value,'09:15 - 10:30');assert.equal(r.checkout.formValidation.value,'');
  }finally{child.stop();r.stop();}
});
for(const range of [['2026-09-23',''],['','2026-09-23']])test('half-filled date range cannot authorize submission '+JSON.stringify(range),async()=>{
  const r=await setup({transform:withForm});try{
    r.checkout.updateForm(filled(r).map(item=>({...item,value:item.name==='dateranges'?range:item.value})));
    assert.match(r.checkout.formValidation.value,/完整范围/);await create(r);assert.equal(writes(r).length,0);
  }finally{r.stop();}
});
test('late preview cannot restore private image links after leaving the checkout',async()=>{
  const reply=deferred(),base=server({transform:withForm}),r=await setup({send:call=>call.url.includes('/form_preview/')?reply.promise:base(call)});
  try{r.checkout.updateForm(filled(r));const reading=r.checkout.refreshPreviews();await tick();r.hooks.onHide();
    reply.resolve({data:[{att_id:41,reference:'/api/assets/41',url:signed()}]});await reading;
    assert.deepEqual(r.checkout.previews.value,{});assert.deepEqual(r.checkout.customForm.value,[]);assert.equal(r.checkout.previewBusy.value,false);
  }finally{r.stop();}
});
for(const returnBeforeUpload of [true,false])test('actual native chooser hide/show preserves answers and requires a fresh quote '+returnBeforeUpload,async()=>{
  const r=await setup({transform:withForm});let chooser,upload; r.uni.chooseImage=c=>chooser=c;r.uni.uploadFile=c=>upload=c;
  r.checkout.updateForm(filled(r).map(item=>({...item,value:item.name==='uploadPicture'?[]:item.value})));const child=mountForm(r);
  try{const before=r.calls.length,choosing=child.controls.chooseImages(9);assert.equal(r.checkout.formPending.value,1);
    r.hooks.onHide();assert.equal(child.props.disabled,false);assert.equal(r.checkout.customForm.value[0].value,'合成答案');assert.equal(r.checkout.canSubmit.value,false);
    if(returnBeforeUpload)r.hooks.onShow();chooser.success({tempFilePaths:['local.png']});await tick();assert.ok(upload);
    upload.success({statusCode:200,data:JSON.stringify({status:200,data:{att_id:41,url:'/api/assets/41',src:signed()}})});await choosing;
    if(!returnBeforeUpload)r.hooks.onShow();await tick();assert.equal(r.checkout.customForm.value[0].value,'合成答案');
    assert.deepEqual(r.checkout.customForm.value[9].value,['/api/assets/41']);assert.equal(r.checkout.formPending.value,0);assert.equal(r.checkout.consent.value,false);
    assert.equal(r.calls.slice(before).filter(c=>c.url.includes('/computed/')).length,1);assert.equal(writes(r).length,0);
    r.checkout.consent.value=true;assert.equal(r.checkout.canSubmit.value,true);
  }finally{child.stop();r.stop();}
});
test('chooser cancel still releases pending and preserves answers through native hide/show',async()=>{
  const r=await setup({transform:withForm});let chooser;r.uni.chooseImage=c=>chooser=c;r.checkout.updateForm(filled(r).map(item=>({...item,value:item.name==='uploadPicture'?[]:item.value})));
  const child=mountForm(r);try{const selecting=child.controls.chooseImages(9);r.hooks.onHide();r.hooks.onShow();chooser.fail({errMsg:'cancel'});await selecting;await tick();
    assert.equal(r.checkout.customForm.value[0].value,'合成答案');assert.equal(r.checkout.formPending.value,0);assert.equal(writes(r).length,0);
  }finally{child.stop();r.stop();}
});
test('ordinary hide while upload is running cancels UI ownership and ignores late upload',async()=>{
  const r=await setup({transform:withForm});let upload;r.uni.chooseImage=c=>c.success({tempFilePaths:['local.png']});r.uni.uploadFile=c=>upload=c;
  const child=mountForm(r);try{const selecting=child.controls.chooseImages(9);await tick();assert.ok(upload);r.hooks.onHide();
    upload.success({statusCode:200,data:JSON.stringify({status:200,data:{att_id:41,url:'/api/assets/41',src:signed()}})});await selecting;
    assert.deepEqual(r.checkout.customForm.value,[]);assert.deepEqual(r.checkout.previews.value,{});assert.equal(r.checkout.formPending.value,0);
  }finally{child.stop();r.stop();}
});
test('partial multi-upload keeps completed references and prevents removal or submit during the upload',async()=>{
  const r=await setup({transform:withForm});let next;r.uni.chooseImage=c=>c.success({tempFilePaths:['a.png','b.png']});
  const child=mountForm(r,{uploadImage:async file=>{if(file==='a.png')return {url:'/api/assets/41'};return new Promise((_,reject)=>next=reject);}});
  try{const selecting=child.controls.chooseImages(9);await tick();assert.deepEqual(r.checkout.customForm.value[9].value,['/api/assets/41']);
    child.controls.removeImage(9,0);assert.deepEqual(r.checkout.customForm.value[9].value,['/api/assets/41']);await create(r);assert.equal(writes(r).length,0);
    next(Error('second failed'));await selecting;assert.deepEqual(r.checkout.customForm.value[9].value,['/api/assets/41']);assert.equal(r.checkout.formPending.value,0);
  }finally{child.stop();r.stop();}
});
test('native chooser cannot return more than the configured image limit',async()=>{
  const r=await setup({transform:withForm});let calls=0;r.uni.chooseImage=c=>c.success({tempFilePaths:['a','b','c']});
  const child=mountForm(r,{uploadImage:async()=>{calls++;return {url:'/api/assets/41'};}});
  try{await child.controls.chooseImages(9);assert.equal(calls,0);assert.deepEqual(r.checkout.customForm.value[9].value,[]);}finally{child.stop();r.stop();}
});
for(const action of ['cancel','fail','throw'])test('native confirmation '+action+' never creates',async()=>{
  const r=await setup();try{r.checkout.consent.value=true;r.uni.showModal=o=>{if(action==='throw')throw Error('native');if(action==='fail')o.fail();else o.success({confirm:false});};
    r.checkout.confirmSubmit();await tick();assert.equal(writes(r).length,0);assert.equal(r.checkout.confirming.value,false);
  }finally{r.stop();}
});
test('accepted native confirmation persists the original intent before one create and no automatic payment',async()=>{
  let r;const send=server({create:call=>{const saved=JSON.parse(r.storage.get(savedKey));assert.equal(saved.attempts,1);assert.equal(saved.payload.quoteToken,call.data.quoteToken);
    return {data:{result:{key,order_id:'LOCAL_ORDER_1',pay_price:'12.00',extended:false}}};}});
  r=await setup({send});try{r.checkout.consent.value=true;r.uni.showModal=o=>o.success({confirm:true});r.checkout.confirmSubmit();r.checkout.confirmSubmit();await tick();
    assert.equal(writes(r).length,1);assert.equal(r.checkout.verified.value,true);assert.equal(r.draft.checkoutLock,true);
    r.checkout.clearResult();assert.equal(r.storage.has(savedKey),false);assert.equal(r.draft.scope,null);assert.equal(r.calls.some(c=>/\/pay/.test(c.url)),false);
  }finally{r.stop();}
});
test('confirmed order opens detail only after server result verification',async()=>{
  const r=await setup();try{
    r.checkout.goDetail();assert.deepEqual(r.navigations,[]);
    await create(r);assert.equal(r.checkout.verified.value,true);
    r.checkout.goDetail();assert.deepEqual(r.navigations,['/pages/behalf/order_detail/index?orderId=LOCAL_ORDER_1']);
    r.admin.clear();r.checkout.goDetail();assert.equal(r.navigations.length,1);
    assert.equal(r.calls.some(call=>/\/pay\//.test(call.url)),false);
  }finally{r.stop();}
});
for(const failure of ['throw','readback'])test('storage '+failure+' failure before dispatch creates no order',async()=>{
  const r=await setup();try{r.uni.setStorageSync=()=>{if(failure==='throw')throw Error('storage full');};await create(r);assert.equal(writes(r).length,0);assert.ok(r.checkout.notice.value);}finally{r.stop();}
});
test('corrupt journal blocks new checkout and buyer/cart writes without discarding it',async()=>{
  const storage=new Map([[savedKey,'bad-json']]);const r=await setup({storage,resume:true});try{
    assert.match(r.checkout.error.value,/损坏/);assert.equal(r.calls.length,0);assert.throws(()=>r.draft.choose(11),/先恢复/);assert.equal(storage.get(savedKey),'bad-json');
  }finally{r.stop();}
});
test('unknown create survives recreation with exact original key and body, not a new quote',async()=>{
  const send=server({create:()=>({transport:'timeout'})}),first=await setup({send});let original;
  try{await create(first);original=writes(first)[0];assert.equal(first.draft.checkoutLock,true);assert.throws(()=>first.draft.choose(22),/恢复/);}finally{first.stop();}
  const second=await setup({send,storage:first.storage,resume:true});try{
    assert.equal(second.calls.length,0);second.checkout.useIntegral.value=true;second.checkout.mark.value='changed';await second.checkout.submit();
    assert.deepEqual(writes(second),[original]);assert.equal(JSON.parse(second.storage.get(savedKey)).attempts,2);assert.equal(second.checkout.verified.value,false);
    second.checkout.clearResult();assert.equal(second.storage.has(savedKey),true);
  }finally{second.stop();}
});
test('first definitive quote rejection releases intent, but rejection after uncertainty preserves it',async()=>{
  let count=0;const reject={status:400,data:{errorCode:'ORDER_QUOTE_RECONFIRM_REQUIRED',orderKey:key}};
  const r=await setup({create:()=>++count===1?reject:count===2?{transport:'timeout'}:reject});try{
    await create(r);assert.equal(r.checkout.pending.value,null);assert.equal(r.storage.has(savedKey),false);
    await r.checkout.refreshQuote();await create(r);await r.checkout.submit();assert.equal(r.checkout.pending.value.attempts,2);assert.equal(r.storage.has(savedKey),true);
  }finally{r.stop();}
});
test('stored success must be reverified before clearing and replay cannot replace conflicting result',async()=>{
  const first=await setup();await create(first);first.stop();
  const second=await setup({storage:first.storage,resume:true,create:()=>({data:{result:{key,order_id:'OTHER_ORDER',pay_price:'12.00',extended:true}}})});
  try{assert.equal(second.checkout.verified.value,false);second.checkout.clearResult();assert.equal(second.storage.has(savedKey),true);
    await second.checkout.submit();assert.equal(second.checkout.verified.value,false);assert.match(second.checkout.notice.value,/冲突/);
  }finally{second.stop();}
});
for(const boundary of ['hide','account'])test('late success after '+boundary+' cannot publish old order into new UI',async()=>{
  const wait=deferred();const r=await setup({create:()=>wait.promise});try{r.checkout.consent.value=true;const pending=r.checkout.submit();await tick();
    if(boundary==='hide')r.hooks.onHide();else r.admin.install({id:2,label:'other',token:'admin-2',expiresAt:Date.now()+3600000,permissions});
    wait.resolve({data:{result:{key,order_id:'LOCAL_ORDER_1',pay_price:'12.00',extended:false}}});await pending;
    assert.equal(r.checkout.pending.value,null);assert.equal(r.checkout.verified.value,false);assert.equal(r.storage.has(savedKey),true);
  }finally{wait.resolve({transport:'closed'});r.stop();}
});
test('duplicate submit while HTTP waits records a single attempt',async()=>{
  const wait=deferred();const r=await setup({create:()=>wait.promise});try{r.checkout.consent.value=true;const pending=r.checkout.submit();await tick();await r.checkout.submit();
    assert.equal(writes(r).length,1);assert.equal(JSON.parse(r.storage.get(savedKey)).attempts,1);wait.resolve({transport:'timeout'});await pending;
  }finally{wait.resolve({transport:'closed'});r.stop();}
});
test('old backend and forged direct-link UID cannot authorize a new order',async()=>{
  const r=await setup({query:{uid:'22'}});try{assert.match(r.checkout.error.value,/上下文/);assert.equal(r.calls.length,0);}finally{r.stop();}
});

test('changing the buyer draft immediately removes the old quote and disables submission',async()=>{
  const r=await setup();try{r.checkout.consent.value=true;r.draft.choose(22);assert.equal(r.checkout.quote.value,null);
    await r.checkout.submit();assert.equal(writes(r).length,0);assert.equal(r.checkout.canSubmit.value,false);
  }finally{r.stop();}
});
test('a restored verified server result can clear delivery data even without a fresh buyer draft',async()=>{
  const first=await setup();await create(first);first.stop();
  const second=await setup({storage:first.storage,resume:true});try{
    assert.equal(second.draft.scope,null);await second.checkout.submit();assert.equal(second.checkout.verified.value,true);
    second.checkout.clearResult();assert.equal(second.storage.has(savedKey),false);
    assert.equal(second.calls.length,1);assert.equal(second.calls[0].url,`/api/admin/order/create/${key}/11`);
  }finally{second.stop();}
});
for(const invalid of ['foreign-key','malformed-price','missing-result'])test('uncertain create result remains frozen: '+invalid,async()=>{
  const r=await setup({create:()=>({data:invalid==='missing-result'?{}:{result:{key:invalid==='foreign-key'?'c'.repeat(32):key,
    order_id:'LOCAL_ORDER_1',pay_price:invalid==='malformed-price'?'oops':'12.00',extended:false}}})});try{
    await create(r);assert.equal(r.checkout.verified.value,false);assert.equal(r.checkout.pending.value.attempts,1);assert.equal(r.storage.has(savedKey),true);
  }finally{r.stop();}
});
test('restoring after Admin authentication expiration requires fresh original Admin login without shopper logout',async()=>{
  const r=await setup({create:()=>({status:401,httpStatus:401,msg:'expired'})});try{await create(r);
    assert.equal(r.admin.authenticated,false);assert.equal(r.auth.uid,11);assert.equal(r.storage.has(savedKey),true);assert.equal(r.checkout.pending.value,null);
  }finally{r.stop();}
});
test('a different Admin never loads the prior Admin journal or buyer details',async()=>{
  const first=await setup({create:()=>({transport:'timeout'})});await create(first);first.stop();
  const second=await setup({storage:first.storage,resume:true});try{second.admin.install({id:2,label:'other',token:'admin-2',expiresAt:Date.now()+3600000,permissions});
    await second.checkout.load();assert.equal(second.checkout.pending.value,null);assert.match(second.checkout.error.value,/没有本机/);
    assert.equal(second.calls.length,0);assert.equal(second.storage.has(savedKey),true);
  }finally{second.stop();}
});
test('quote reload claiming an existing order does not silently start a second order',async()=>{
  const r=await setup({transform:(v,c)=>c.url.includes('/computed/')?{orderId:'LOCAL_ALREADY',key}:v});try{
    await r.checkout.refreshQuote();assert.equal(r.checkout.quote.value,null);assert.match(r.checkout.error.value,/已有订单 LOCAL_ALREADY/);
    await create(r);assert.equal(writes(r).length,0);
  }finally{r.stop();}
});
