import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse, compileScript } from '@vue/compiler-sfc';
import { createRenderer, h, nextTick } from 'vue';
import { createRouter, createMemoryHistory, RouterView } from 'vue-router';
const script='/src/pages/order/Checkout.shipping-test.ts';
export function checkoutShippingPlugin(root) {
 const id=root.replaceAll('\\','/').replace(/\/$/,'')+script;
 return {name:'actual-checkout-shipping',resolveId(value){if(value===script)return id;},async load(value){if(value!==id)return;
  const filename=root+'/src/pages/order/Checkout.vue';return compileScript(parse(await readFile(filename,'utf8'),{filename}).descriptor,{id:'shipping-checkout'}).content;}};
}
const renderer=createRenderer({createElement:()=>({children:[]}),createText:text=>({text}),createComment:text=>({text}),
 insert(node,parent){node.parent=parent;(parent.children??=[]).push(node);},remove(node){if(node.parent)node.parent.children=node.parent.children.filter(x=>x!==node);},parentNode:node=>node.parent,nextSibling:()=>null,patchProp(){},setText(){},setElementText(){}});
const flush=async()=>{for(let i=0;i<25;i++){await Promise.resolve();await nextTick();}};
const gate=()=>{let resolve;return {promise:new Promise(r=>{resolve=r;}),resolve};};
const store={id:1,name:'所属门店',introduction:'',phone:'',address:'隔离地址',detailed_address:'',image:'',latitude:'',longitude:'',valid_time:'',day_time:''};
const item={id:10,productId:70,unique:'qared001',cartNum:1,type:2,isNew:1,isValid:true,productInfo:{price:'10.00',storeName:'隔离砍价',image:'',stock:8,otPrice:'',suk:'红色',systemFormId:0,productType:0},sumPrice:'10.00'};
const selection=(types=[1,2],address=true)=>({kind:'bargain',activityId:40,cartIds:[10],methods:types,shippingTypes:types,requiresAddress:address,stores:types.includes(2)?[store]:[]});
export function registerCheckoutShippingTests(getContext){
 async function mount(shipping=()=>selection(),addressFailure=false,productType=0,type=2){
  const selectedItem={...item,type,productInfo:{...item.productInfo,productType}};
  const {server,api,response}=getContext();const calls=[];let view;
  api.defaults.adapter=async config=>{const body=config.method==='post'?JSON.parse(config.data):{};calls.push({url:config.url,body});
   if(config.url==='/cart/list')return response(config,{status:200,data:[selectedItem]});
   if(config.url==='/address/list')return response(config,addressFailure?{status:400,msg:'地址不可用'}:{status:200,data:[{id:11,real_name:'隔离',phone:'00000000000',is_default:1}]});
   if(config.url==='/order/check_shipping')return response(config,{status:200,data:await shipping()});
   if(config.url==='/store/list')return response(config,{status:200,data:[store]});
   if(config.url==='/coupons/order/0')return response(config,{status:200,data:[]});
   if(config.url==='/order/confirm'||config.url.startsWith('/order/computed/'))return response(config,{status:200,data:{orderKey:'shipping_key1',addressInfo:body.addressId?{id:body.addressId}:null,cartInfo:[{...selectedItem,truePrice:'2.00',sumPrice:'2.00',productInfo:{...selectedItem.productInfo,price:'2.00'}}],priceGroup:{sumPrice:'2.00',totalPrice:'2.00',pay_price:'2.00',total_postage:'0.00',pay_postage:'0.00',storePostageDiscount:'0.00',vipPrice:'0.00',levelPrice:'0.00',memberPrice:'0.00',couponPrice:'0.00',deduction_price:'0.00',firstOrderPrice:'0.00',usedIntegral:0,SurplusIntegral:0,pay_integral:0}}});
   throw new Error('Unexpected request '+config.url);
  };
  const component=(await server.ssrLoadModule(script)).default;
  const router=createRouter({history:createMemoryHistory(),routes:[{path:'/checkout',component:{setup(props,ctx){view=component.setup(props,ctx);return()=>null;}}},{path:'/away',component:{render:()=>null}}]});
  const app=renderer.createApp({render:()=>h(RouterView)});app.use(router);await router.push(`/checkout?mode=buy&cartId=10&type=${type}${type===2?'&bargainUserId=80':''}`);app.mount({children:[]});await flush();
  return {view,calls,router,close(){app.unmount();}};
 }
 it('PC actual checkout chooses the sole allowed pickup channel and uses only the scoped stores',async()=>{
  const f=await mount(()=>selection([2]));try{assert.equal(f.view.shippingType.value,2);assert.equal(f.view.quoteReady.value,true);
   assert.deepEqual(f.calls.find(c=>c.url==='/order/check_shipping').body,{cartIds:[10],view:'bargain'});
   assert.equal(f.calls.some(c=>c.url==='/store/list'),false);assert.deepEqual(f.calls.find(c=>c.url==='/order/confirm').body,{type:2,bargainUserId:80,addressId:0,shippingType:2,storeId:1,couponId:0,useIntegral:false,cartIds:[10]});
  }finally{f.close();}
 });
 it('PC fails closed on an old permissive response and recovers through explicit delivery refresh',async()=>{
  let valid=false;const f=await mount(()=>valid?selection([1]):{type:0,methods:[1,2,3]});try{
   assert.equal(f.view.quoteReady.value,false);assert.match(f.view.deliveryError.value,/响应无效/);assert.equal(f.calls.some(c=>c.url==='/order/confirm'),false);
   valid=true;f.view.renewQuote();await flush();assert.equal(f.view.quoteReady.value,true);
  }finally{f.close();}
 });
 it('PC does not silently switch delivery after rules change, and requotes only after explicit choices',async()=>{
  let types=[1];const f=await mount(()=>selection(types));try{const count=f.calls.filter(c=>c.url==='/order/confirm'||c.url.startsWith('/order/computed/')).length;
   types=[2];f.view.renewQuote();await flush();assert.equal(f.view.shippingType.value,1);assert.match(f.view.deliveryError.value,/重新选择/);assert.equal(f.view.canSubmit.value,false);
   assert.equal(f.calls.filter(c=>c.url==='/order/confirm'||c.url.startsWith('/order/computed/')).length,count);
   f.view.shippingType.value=2;f.view.selectedStoreId.value=1;await flush();assert.equal(f.view.quoteReady.value,true);
  }finally{f.close();}
 });
 it('PC ignores an older shipping response after a newer refresh finishes',async()=>{
  const waiting=gate();let calls=0;const f=await mount(()=>++calls===2?waiting.promise:selection(calls===1?[1]:[2]));try{
   f.view.renewQuote();await flush();f.view.renewQuote();await flush();assert.deepEqual(f.view.allowedShippingTypes.value,[2]);
   waiting.resolve(selection([1]));await flush();assert.deepEqual(f.view.allowedShippingTypes.value,[2]);
  }finally{waiting.resolve(selection());f.close();}
 });
 it('PC does not require an address for non-logistics bargain checkout',async()=>{
  const f=await mount(()=>selection([1],false),true,3);try{assert.equal(f.view.requiresAddress.value,false);assert.equal(f.view.quoteReady.value,true,f.view.quoteState.value.error);assert.equal(f.calls.find(c=>c.url==='/order/confirm').body.addressId,0);}finally{f.close();}
 });
 for(const productType of [1,2,3])it(`PC ordinary non-logistics type ${productType} quotes without a saved address`,async()=>{
  const f=await mount(undefined,true,productType,0);try{assert.equal(f.view.requiresAddress.value,false);assert.equal(f.view.quoteReady.value,true,f.view.quoteState.value.error);assert.equal(f.calls.find(c=>c.url==='/order/confirm').body.addressId,0);}finally{f.close();}
 });
 it('PC ordinary physical checkout still requires a usable saved address',async()=>{
  const f=await mount(undefined,true,0,0);try{assert.equal(f.view.requiresAddress.value,true);assert.equal(f.view.quoteReady.value,false);assert.equal(f.calls.some(c=>c.url==='/order/confirm'),false);}finally{f.close();}
 });
 for(const change of ['route','identity'])it(`PC late shipping response cannot restore eligibility after ${change} changes`,async()=>{
  const waiting=gate();let delay=false;const f=await mount(()=>delay?waiting.promise:selection());try{
   delay=true;f.view.renewQuote();await flush();if(change==='route')await f.router.push('/away');else getContext().authUtils.setAuth('other-selector-owner',22);
   waiting.resolve(selection([2]));await flush();assert.notDeepEqual(f.view.allowedShippingTypes.value,[2]);
  }finally{waiting.resolve(selection());f.close();}
 });
}
