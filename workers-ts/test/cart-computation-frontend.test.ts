import { afterEach,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { CartBudgetSession,cartBudgetScope,normalizeCartBudget } from '../../view/common/cartComputation';
import { CartCouponPreselection } from '../../view/common/cartCouponPreselection';
import { orderCouponScope,type OrderCouponState } from '../../view/common/orderCoupons';
import type { CheckoutCartItem } from '../../view/common/checkoutSelection';

const item=():CheckoutCartItem=>({id:1,productId:70,cartNum:2,unique:'qared001',type:0,activityId:0,isNew:0,isValid:true,
  productInfo:{storeName:'预算测试商品',image:'/product.png',price:'19.99',otPrice:'25.00',suk:'红色,大号',stock:8,systemFormId:0,productType:0},sumPrice:'39.98'});
const owner={uid:11,version:0};
const scope=()=>cartBudgetScope([item()],owner);
function projection(owned=false){return {promotions:[],coupon:{id:owned?71:11,cid:11,coupon_title:'满减三元',true_coupon_price:3,...(owned?{used:{id:71,cid:11}}:{})},
  deduction:{product_type:0,type:0,activity_id:0,sum_price:39.98,vip_price:0,promotions_price:0,coupon_price:3,first_order_price:0,pay_price:36.98},svip_status:false,svip_price:19.98,
  budget:{requiresCouponClaim:!owned,couponIssueId:11,couponUserId:owned?71:0,selection:scope().selection,gifts:[],requiredIntegral:0,hypotheticalPaidMemberPayPrice:'17.00',excludes:['shipping','integral','payment'],needsCheckoutRequote:true}};}
const ownedCoupon=()=>({id:71,coupon_title:'满减三元',coupon_price:'3.00',use_min_price:'0.00',applicable_type:0,coupon_type:1,
  availability:'available',availability_message:'当前可用',start_time:null,end_time:null,estimated_discount:'3.00',eligible_subtotal:'39.98'});
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}

describe('cart budget DTO, immutable selection and one-shot owned coupon suggestion',()=>{
  it('distinguishes a real owned coupon from a not-yet-claimed hypothesis',()=>{
    expect(normalizeCartBudget(projection(),scope()).coupon).toEqual({issueId:11,userId:0,requiresClaim:true,title:'满减三元',discount:'3.00'});
    expect(normalizeCartBudget(projection(true),scope()).coupon).toMatchObject({userId:71,requiresClaim:false});
  });
  it('retains the mature 14-digit, safe-cent money contract for schema-valid large cart totals',()=>{
    const p=projection();Object.assign(p,{coupon:[],svip_price:0});
    Object.assign(p.deduction,{sum_price:34779999654947.62,pay_price:34779999654947.62,coupon_price:0});
    Object.assign(p.budget,{requiresCouponClaim:false,couponIssueId:0,couponUserId:0,hypotheticalPaidMemberPayPrice:null});
    expect(normalizeCartBudget(p,scope())).toMatchObject({raw:'34779999654947.62',pay:'34779999654947.62',coupon:null});
    p.deduction.sum_price=90071992547410;expect(()=>normalizeCartBudget(p,scope())).toThrow('超出安全范围');
  });
  it.each(['pay_price','sum_price','coupon_price','vip_price','promotions_price','first_order_price'])('rejects inconsistent integer price identity %s',field=>{
    const p=projection();(p.deduction as Record<string,unknown>)[field]=0.123;expect(()=>normalizeCartBudget(p,scope())).toThrow();
  });
  it.each([{cartNum:3},{unique:'replaced'},{id:2},{productId:71},{type:1},{activityId:10}])('rejects a changed exact cart snapshot %j',change=>{
    const p=projection();Object.assign(p.budget.selection[0]!,change);expect(()=>normalizeCartBudget(p,scope())).toThrow('购物车商品已变化');
  });
  it('rejects missing claim evidence and cannot render an unclaimed amount as owned',()=>{
    const p=projection();p.budget.requiresCouponClaim=false;expect(()=>normalizeCartBudget(p,scope())).toThrow();
    const invalid=projection(true);invalid.coupon.used!.cid=12;expect(()=>normalizeCartBudget(invalid,scope())).toThrow();
  });
  it('withdraws late results on quantity, hide and same-UID session replacements',async()=>{
    const first=deferred<unknown>(),second=deferred<unknown>();let calls=0;
    const session=new CartBudgetSession(()=>++calls===1?first.promise:second.promise,()=>{});
    const old=session.load(scope());session.reset();const fresh=session.load({...scope(),version:1,fingerprint:'replacement'});
    second.resolve(projection(true));await fresh;first.resolve(projection());await old;
    expect(session.state.result?.coupon?.userId).toBe(71);session.reset();expect(session.state.result).toBeNull();
  });
  it('cannot reuse a route coupon merely by submitting its ID; requires the current real eligible owned list',()=>{
    const preselect=new CartCouponPreselection('71',owner,[1]),selected=orderCouponScope([item()],1,0);
    const page:OrderCouponState={fingerprint:selected.fingerprint,list:[],nextCursor:null,loading:false,error:''};
    preselect.bind(selected,owner,[1],true);expect(preselect.accept(page)).toEqual({couponId:0,loadMore:false});
    expect(preselect.accept({...page,list:[{id:71,availability:'available'} as OrderCouponState['list'][number]]})).toEqual({couponId:0,loadMore:false});
  });
  it.each(['owner','scope','selection','activity','revoke'])('withdraws the pending suggestion on %s',reason=>{
    const suggestion=new CartCouponPreselection('71',owner,[1]),selected=orderCouponScope([item()],1,0);
    suggestion.bind(selected,owner,[1],true);
    if(reason==='owner')suggestion.bind(selected,{...owner,version:1},[1],true);
    if(reason==='scope')suggestion.bind(orderCouponScope([item()],2,0),owner,[1],true);
    if(reason==='selection')suggestion.bind(selected,owner,[2],true);
    if(reason==='activity')suggestion.bind(selected,owner,[1],false);
    if(reason==='revoke')suggestion.revoke();
    expect(suggestion.accept({fingerprint:selected.fingerprint,list:[{id:71,availability:'available'} as OrderCouponState['list'][number]],nextCursor:null,loading:false,error:''}).couponId).toBe(0);
  });
});

let runtime:any,platform:any;
const closes:Array<()=>void>=[];
beforeAll(async()=>{
  const root=resolve(import.meta.dirname,'../../view/uniapp-ts'),require=createRequire(resolve(root,'package.json'));
  const {parse,compileScript,compileTemplate}=require('@vue/compiler-sfc');
  const filename=resolve(root,'src/pages/cart/index.vue'),descriptor=parse(readFileSync(filename,'utf8'),{filename}).descriptor;
  expect(compileTemplate({source:descriptor.template.content,filename,id:'cart-budget-page'}).errors).toEqual([]);
  const result=await build({absWorkingDir:root,stdin:{resolveDir:root,contents:`export {default as CartPage} from './src/pages/cart/index.vue';export {useCheckout} from './src/composables/useCheckout';export {useCartStore} from './src/stores/cart';export {createRenderer,reactive,nextTick} from 'vue';export {createPinia,setActivePinia} from 'pinia';`},
    alias:{'@':resolve(root,'src')},bundle:true,write:false,format:'esm',platform:'browser',plugins:[{name:'cart-budget-native-fixture',setup(builder){
      builder.onResolve({filter:/^@dcloudio\/uni-app$/},()=>({path:'hooks',namespace:'cart-native'}));
      builder.onResolve({filter:/^(?:@\/stores\/auth|\.\/auth)$|[\\/]stores[\\/]auth(?:\.ts)?$/},()=>({path:'auth',namespace:'cart-native'}));
      builder.onLoad({filter:/[\\/]stores[\\/]auth\.ts$/},()=>({contents:`export const useAuthStore=()=>globalThis.__cartBudgetPlatform.auth;`}));
      builder.onResolve({filter:/ThemePage\.vue$/},()=>({path:'theme',namespace:'cart-native'}));
      builder.onLoad({filter:/.*/,namespace:'cart-native'},({path})=>({contents:path==='hooks'
        ?`export const onLoad=fn=>globalThis.__cartBudgetPlatform.hooks.load.push(fn);export const onShow=fn=>globalThis.__cartBudgetPlatform.hooks.show.push(fn);export const onHide=fn=>globalThis.__cartBudgetPlatform.hooks.hide.push(fn);export const onUnload=fn=>globalThis.__cartBudgetPlatform.hooks.unload.push(fn);`
        :path==='auth'?`export const useAuthStore=()=>globalThis.__cartBudgetPlatform.auth;`:`export default {render:()=>null};`}));
      builder.onLoad({filter:/\.vue$/},({path})=>({contents:compileScript(parse(readFileSync(path,'utf8'),{filename:path}).descriptor,{id:'cart-budget-page'}).content,loader:'ts'}));
    }}]});
  runtime=await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
},30000);
const flush=async()=>{for(let i=0;i<16;i++){await Promise.resolve();await runtime.nextTick();}};
beforeEach(()=>{
  if(!runtime)return;
  runtime.setActivePinia(runtime.createPinia());
  platform={auth:runtime.reactive({uid:11,sessionVersion:0,token:'cart-budget-client-token',isLoggedIn:true,clear(){this.uid=0;this.token='';this.sessionVersion++;this.isLoggedIn=false;}}),
    hooks:{load:[],show:[],hide:[],unload:[]},calls:[],navigations:[],owned:false,sender:null};
  vi.stubGlobal('__cartBudgetPlatform',platform);
  vi.stubGlobal('uni',{request:(call:any)=>{platform.calls.push(call);if(platform.sender?.(call))return;
    const path=new URL(call.url,'http://local.test').pathname;
    const data=path==='/api/cart/list'?[item()]:path==='/api/cart/compute'?projection(platform.owned):path==='/api/coupon/receive'?(platform.owned=true,{couponUserId:71}):path==='/api/coupons/order/0'?[ownedCoupon()]:[];
    call.success({statusCode:200,data:{status:200,msg:'ok',data},header:{}});
  },navigateTo:({url}:any)=>platform.navigations.push(url),showToast(){},getStorageSync:()=>'',setStorageSync(){},removeStorageSync(){}});
});
afterEach(()=>{while(closes.length)closes.pop()!();vi.unstubAllGlobals();});
function mount(component:any){
  const renderer=runtime.createRenderer({patchProp(){},insert(){},remove(){},createElement:()=>({}),createText:()=>({}),createComment:()=>({}),setText(){},setElementText(){},parentNode:()=>null,nextSibling:()=>null});
  const app=renderer.createApp({...component,render:()=>null}),vm=app.mount({});closes.push(()=>app.unmount());
  return {vm,bindings:app._instance.setupState};
}
async function cartPage(){const page=mount(runtime.CartPage);for(const fn of platform.hooks.show)fn();await flush();page.bindings.cartStore.toggleAll(true);await flush();return page.bindings;}
describe('actual compiled UniApp cart page, request adapter and checkout consumer',()=>{
  it('sends selected IDs only, explicitly claims then re-budgets before navigating with the real owned coupon ID',async()=>{
    const page=await cartPage();expect(page.budgetReady).toBe(true);expect(page.budget.result.coupon.requiresClaim).toBe(true);
    expect(platform.calls.filter((c:any)=>c.url.endsWith('/coupon/receive'))).toHaveLength(0);
    await page.goCheckout();await flush();
    expect(platform.calls.filter((c:any)=>c.url.endsWith('/cart/compute')).map((c:any)=>c.data)).toEqual([{cartId:'1'},{cartId:'1'}]);
    expect(platform.calls.filter((c:any)=>c.url.endsWith('/coupon/receive')).map((c:any)=>c.data)).toEqual([{id:11}]);
    expect(platform.navigations).toEqual(['/pages/order/confirm?couponId=71']);
    expect(platform.calls.every((c:any)=>!c.data.orderKey&&!c.data.quoteToken&&!c.data.price)).toBe(true);
  });
  it('retains a failed claim without navigation, budget ownership or optimistic coupon ID',async()=>{
    platform.sender=(call:any)=>{if(call.url.endsWith('/coupon/receive')){call.success({statusCode:200,data:{status:400,msg:'优惠券已领完',data:null}});return true;}};
    const page=await cartPage();await page.goCheckout();await flush();expect(platform.navigations).toEqual([]);expect(page.claimError).toBe('优惠券已领完');expect(page.budget.result.coupon.requiresClaim).toBe(true);
  });
  it('withdraws a dispatched claim reply after same-user session replacement and cannot navigate the new session',async()=>{
    let claim:any;platform.sender=(call:any)=>{if(call.url.endsWith('/coupon/receive')){claim=call;return true;}};
    const page=await cartPage(),pending=page.goCheckout();platform.auth.sessionVersion++;
    claim.success({statusCode:200,data:{status:200,data:{couponUserId:71}}});await pending;await flush();expect(platform.navigations).toEqual([]);expect(page.claiming).toBe(false);
  });
  it('withdraws late old budget responses when the cart page hides',async()=>{
    let delayed:any;platform.sender=(call:any)=>{if(call.url.endsWith('/cart/compute')){delayed=call;return true;}};
    const page=await cartPage();expect(page.budget.loading).toBe(true);const old=delayed;
    for(const fn of platform.hooks.hide)fn();old.success({statusCode:200,data:{status:200,data:projection()}});await flush();expect(page.budget.result).toBeNull();expect(page.budgetReady).toBe(false);
  });
  it('preselects the route coupon once only after current owned eligibility, then clears it after shipping/session changes',async()=>{
    const cart=runtime.useCartStore();await cart.fetchList();cart.toggleAll(true);platform.owned=true;
    const checkout=mount({setup:()=>runtime.useCheckout()}).bindings;for(const fn of platform.hooks.load)fn({couponId:'71'});for(const fn of platform.hooks.show)fn();await flush();
    expect(checkout.couponId).toBe(71);
    const couponCalls=platform.calls.filter((c:any)=>c.url.includes('/coupons/order/0'));expect(couponCalls.length).toBeGreaterThan(0);
    checkout.setShipping(2);await flush();expect(checkout.couponId).toBe(0);
    platform.auth.sessionVersion++;await flush();expect(checkout.couponId).toBe(0);expect(checkout.items).toEqual([]);
  });
  it('never preselects a route ID absent from the actual eligible owned page',async()=>{
    const cart=runtime.useCartStore();await cart.fetchList();cart.toggleAll(true);
    const checkout=mount({setup:()=>runtime.useCheckout()}).bindings;for(const fn of platform.hooks.load)fn({couponId:'72'});for(const fn of platform.hooks.show)fn();await flush();
    expect(checkout.couponId).toBe(0);
  });
});
