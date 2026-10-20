import { afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import { eq,sql } from 'drizzle-orm';
import { createApp } from '../src/app';
import { createToken,md5 } from '../src/utils/jwt';
import type { Env } from '../src/env';
import { CartComputationService } from '../src/services/order/CartComputationService';
import { StoreOrderCreateService } from '../src/services/order/StoreOrderCreateService';
import { StoreCartService } from '../src/services/order/StoreCartService';
import { ValidateException } from '../src/utils/errors';
import type { Container } from '../src/lib/di';
import { cartComputationFixture } from './helpers/cartComputationFixture';
import { storeActivity,storeCart,storeCouponIssue,storeCouponIssueUser,storeCouponProduct,storeCouponUser,storeOrder,
  storeIntegral,storeProduct,storeProductAttrValue,storeProductCategory,storePromotions,storePromotionsAuxiliary,storeSeckill,storeSeckillTime,systemConfig,systemUserLevel,user } from '../src/models/schema';

const wiring=vi.hoisted(()=>({open:vi.fn()}));
vi.mock('@/lib/di',async original=>({...await original<typeof import('@/lib/di')>(),createContainer:wiring.open}));
describe('registered cart/compute with actual customer JWT, SQL and read-only pricing',()=>{
  let f:Awaited<ReturnType<typeof cartComputationFixture>>,env:Env,token:string,other:string;
  const app=createApp();
  beforeAll(async()=>{
    f=await cartComputationFixture();wiring.open.mockImplementation(()=>f.container);
    env={...f.env,APP_KEY:'synthetic-cart-budget-jwt',UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:''};
    token=(await createToken(11,'api',md5('budget-password'),env.APP_KEY)).token;
    other=(await createToken(22,'api',md5('other-password'),env.APP_KEY)).token;
  },30000);
  afterAll(async()=>{vi.restoreAllMocks();await f?.close();},30000);
  beforeEach(async()=>{
    vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Budget tests forbid external I/O'));
    for(const table of [storeCouponProduct,storeCouponIssueUser,storeCouponUser,storeCouponIssue,storePromotionsAuxiliary,storePromotions,storeProductCategory,systemUserLevel,storeOrder,storeSeckill,storeIntegral,storeActivity,storeSeckillTime])await f.db.delete(table);
    await f.db.delete(storeCart).where(sql`${storeCart.id} <> 1`);
    await f.db.delete(storeProductAttrValue).where(sql`${storeProductAttrValue.id} <> 1`);
    await f.db.delete(storeProduct).where(sql`${storeProduct.id} <> 70`);
    await f.db.update(user).set({pwd:'budget-password',status:1,isDel:0,deleteTime:null,isEverLevel:0,isMoneyLevel:0,level:0,levelStatus:0,isFirstOrder:0,integral:100}).where(eq(user.uid,11));
    await f.db.update(storeCart).set({uid:11,isNew:0,isPay:0,isDel:0,status:1,staffId:0,touristUid:'',storeId:0,type:0,activityId:0,productId:70,productType:0,productAttrUnique:'qared001',cartNum:2});
    await f.db.update(storeProduct).set({price:'19.99',vipPrice:'10.00',stock:8,isVip:1,isShow:1,isDel:0,isVerify:1,productType:0,isPresaleProduct:0,cateId:'',brandId:0});
    await f.db.update(storeProductAttrValue).set({price:'19.99',vipPrice:'10.00',stock:8,isRetired:0});
    await f.setBudgetConfig({member_func_status:'0',member_card_status:'1',svip_price_status:'1',newcomer_status:'1',first_order_status:'0',newcomer_limit_status:'0',first_order_discount:'90',first_order_discount_limit:'100'});
    f.writes.length=0;
  });
  afterEach(()=>{expect(fetch).not.toHaveBeenCalled();vi.restoreAllMocks();});
  async function request(body:unknown={cartId:'1'},options:{token?:string;query?:string;contentType?:string;raw?:BodyInit}={}){
    const response=await app.request(`/api/cart/compute${options.query??''}`,{method:'POST',headers:{'Authori-zation':`Bearer ${options.token??token}`,'Content-Type':options.contentType??'application/json'},
      body:options.raw??JSON.stringify(body)},env);
    return {response,body:await response.json<{status:number;msg:string;data:any}>()};
  }
  async function issue(id:number,overrides:Partial<typeof storeCouponIssue.$inferInsert>={}){
    await f.db.insert(storeCouponIssue).values({id,couponTitle:`预算券${id}`,category:1,couponType:0,type:1,couponPrice:'3.00',
      useMinPrice:'0.00',receiveType:1,receiveLimit:1,remainCount:50,totalCount:50,day:7,status:1,...overrides});
  }
  async function integralSelection(onceNum=-1,num=-1){
    // An explicitly configured positive consumer, not the PHP batch default.
    await f.db.insert(storeIntegral).values({id:10,productId:70,stock:8,quota:8,onceNum,num,status:1,isShow:1,isDel:0,freight:1});
    await f.db.insert(storeProductAttrValue).values({id:2,productId:10,type:4,unique:'int00001',suk:'红色,大号',stock:8,quota:8,price:'5.00',integral:10});
    await f.db.update(storeCart).set({type:4,activityId:10});
  }
  const integralQuote=()=>new StoreOrderCreateService(f.container,f.env).quoteOrder({uid:11,cartIds:[1],type:4,addressId:11,shippingType:1});
  const integralState=async()=>({...await f.snapshot(),activity:await f.db.select().from(storeIntegral)});
  it('preserves old numeric projection and quotes SVIP only as an assumption without business/KV/token/provider writes',async()=>{
    const before=await f.snapshot(),result=await request();expect(result.body.status,result.body.msg).toBe(200);
    expect(result.body.data).toMatchObject({promotions:[],coupon:[],svip_status:false,svip_price:19.98,
      deduction:{product_type:0,type:0,activity_id:0,sum_price:39.98,vip_price:0,promotions_price:0,coupon_price:0,first_order_price:0,pay_price:39.98},
      budget:{requiresCouponClaim:false,couponIssueId:0,couponUserId:0,hypotheticalPaidMemberPayPrice:'20.00',needsCheckoutRequote:true}});
    expect(result.body.data).not.toHaveProperty('orderKey');expect(result.body.data).not.toHaveProperty('quoteToken');
    expect(result.response.headers.get('cache-control')).toContain('private, no-store');expect(result.response.headers.get('pragma')).toBe('no-cache');
    expect(await f.snapshot()).toEqual(before);expect(f.writes).toEqual([]);
  });
  it.skipIf(!process.env.TEST_FINANCE_POSTGRES_URL)('proves native PostgreSQL calculation actually runs inside REPEATABLE READ, READ ONLY',async()=>{
    const original=StoreCartService.prototype.list,settings:unknown[]=[];
    vi.spyOn(StoreCartService.prototype,'list').mockImplementation(async function(this:StoreCartService,uid,scope){
      const container=(this as unknown as {container:Container}).container;
      settings.push(...await container.db.execute(sql`SELECT current_setting('transaction_read_only') AS mode, current_setting('transaction_isolation') AS level`));
      return original.call(this,uid,scope);
    });
    const result=await request();expect(result.body.status,result.body.msg).toBe(200);
    expect(settings).toEqual([{mode:'on',level:'repeatable read'},{mode:'on',level:'repeatable read'}]);
  });
  it('preserves every cent for a schema-valid high-price, high-quantity SKU instead of multiplying binary floats',async()=>{
    await f.db.update(storeProduct).set({price:'9999999900.79',stock:4000});
    await f.db.update(storeProductAttrValue).set({price:'9999999900.79',stock:4000});
    await f.db.update(storeCart).set({cartNum:3478});
    const result=await request();expect(result.body.status,result.body.msg).toBe(200);
    expect(result.body.data.deduction).toMatchObject({sum_price:34779999654947.62,pay_price:34779999654947.62,vip_price:0,promotions_price:0});
  });
  it('selects the largest read-only claimable saving, preserves its not-owned shape, then accepts only real explicitly claimed ownership',async()=>{
    await issue(10);await issue(11,{type:2,couponPrice:'85.99'});const before=await f.snapshot();
    const result=await request();expect(result.body.status,result.body.msg).toBe(200);
    expect(result.body.data).toMatchObject({coupon:{id:11,coupon_type:2,true_coupon_price:5.99},deduction:{coupon_price:5.99,pay_price:33.99},budget:{requiresCouponClaim:true,couponIssueId:11,couponUserId:0}});
    expect(result.body.data.coupon).not.toHaveProperty('used');expect(await f.snapshot()).toEqual(before);expect(f.writes).toEqual([]);
    const response=await app.request('/api/coupon/receive',{method:'POST',headers:{'Authori-zation':`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({id:11})},env);
    const claim=await response.json<{status:number;msg:string;data:{couponUserId:number}}>();expect(claim.status,claim.msg).toBe(200);
    const owned=await request();expect(owned.body.status,owned.body.msg).toBe(200);
    expect(owned.body.data).toMatchObject({coupon:{used:{id:claim.data.couponUserId,cid:11}},budget:{requiresCouponClaim:false,couponUserId:claim.data.couponUserId}});
    const quote=await new StoreOrderCreateService(f.container,f.env).quoteOrder({uid:11,cartIds:[1],type:0,couponId:claim.data.couponUserId,addressId:11});
    expect(quote.couponPriceCents).toBe(599);expect(quote.payCents).toBe(3399);
  });
  it('prefers already owned equally valuable coupons, never another UID or reserved/used/revoked rows',async()=>{
    await issue(10);await issue(11);await issue(12,{couponPrice:'30.00'});
    await f.db.insert(storeCouponUser).values([{id:41,uid:11,issueCouponId:11,couponPrice:'3.00'},
      {id:42,uid:22,issueCouponId:12,couponPrice:'30.00'},{id:43,uid:11,issueCouponId:12,couponPrice:'30.00',status:3}]);
    const result=await request();expect(result.body.status,result.body.msg).toBe(200);
    expect(result.body.data.budget).toMatchObject({requiresCouponClaim:false,couponUserId:41,couponIssueId:11});
  });
  it('compares a genuinely claimable second coupon against an older owned value snapshot of that same template',async()=>{
    await issue(10,{couponPrice:'5.00',receiveLimit:2});
    await f.db.insert(storeCouponUser).values({id:41,uid:11,issueCouponId:10,couponPrice:'3.00'});
    let result=await request();expect(result.body.status,result.body.msg).toBe(200);
    expect(result.body.data).toMatchObject({deduction:{coupon_price:5},budget:{requiresCouponClaim:true,couponIssueId:10,couponUserId:0}});
    await f.db.update(storeCouponIssue).set({couponPrice:'3.00'}).where(eq(storeCouponIssue.id,10));
    result=await request();expect(result.body.status,result.body.msg).toBe(200);expect(result.body.data.budget).toMatchObject({requiresCouponClaim:false,couponUserId:41});
  });
  it.each([{category:2},{appType:1},{receiveType:2},{remainCount:0},{status:0},{isDel:1},{receiveLimit:-1},
    {startTime:new Date(Date.now()+86400000)},{endTime:new Date(Date.now()-86400000)},
    {day:0,useEndTime:null},{day:0,useStartTime:new Date(Date.now()+86400000),useEndTime:new Date(Date.now()+2*86400000)},
    {day:2147483647},{couponTitle:'券'.repeat(65)}])('does not promise an unavailable manual coupon %j',async overrides=>{
    await issue(10,{couponPrice:'30.00',...overrides});const result=await request();expect(result.body.status,result.body.msg).toBe(200);expect(result.body.data.coupon).toEqual([]);
  });
  it('keeps historical one-time evidence and all received states in manual claim limits',async()=>{
    await issue(10,{receiveLimit:0});await issue(11,{receiveLimit:1});
    await f.db.insert(storeCouponIssueUser).values({uid:11,issueCouponId:10});
    await f.db.insert(storeCouponUser).values({uid:11,issueCouponId:11,status:1,couponPrice:'3.00'});
    const result=await request();expect(result.body.status,result.body.msg).toBe(200);expect(result.body.data.coupon).toEqual([]);
  });
  it.each(['owned','claimable'])('refuses an incomplete maximum above 1000 %s candidates',async kind=>{
    if(kind==='owned'){
      await issue(10);await f.db.insert(storeCouponUser).values(Array.from({length:1001},(_,i)=>({id:i+1,uid:11,issueCouponId:10,couponPrice:'3.00'})));
    }else await f.db.insert(storeCouponIssue).values(Array.from({length:1001},(_,i)=>({id:i+1,couponTitle:'候选券',category:1,couponType:0,
      type:1,couponPrice:'3.00',receiveType:1,receiveLimit:1,remainCount:2,totalCount:2,day:7,status:1})));
    const result=await request();expect(result.body.status).not.toBe(200);expect(result.body.msg).toContain('读取上限');expect(result.body.data).toBeNull();
  });
  it('uses the mature per-unit membership truncation and does not grant disabled, expired or opted-out SVIP prices',async()=>{
    await f.db.insert(systemUserLevel).values({id:1,name:'银卡',discount:'88.50',isShow:1});
    await f.db.update(user).set({level:1,levelStatus:1}).where(eq(user.uid,11));await f.setBudgetConfig({member_func_status:'1'});
    let result=await request();expect(result.body.data.deduction).toMatchObject({vip_price:4.8,pay_price:35.18});expect(result.body.data.svip_price).toBe(15.18);
    await f.setBudgetConfig({svip_price_status:'0'});result=await request();expect(result.body.data.svip_price).toBe(0);
    await f.setBudgetConfig({svip_price_status:'1'});await f.db.update(user).set({isMoneyLevel:1,overdueTime:Math.floor(Date.now()/1000)-1}).where(eq(user.uid,11));
    result=await request();expect(result.body.data.svip_status).toBe(false);
    await f.db.update(storeProduct).set({isVip:0});result=await request();expect(result.body.data.svip_price).toBe(0);
  });
  it('uses only selected rows for full-discount thresholds and exact price-promotion overlay/owned coupon eligibility',async()=>{
    await issue(10,{couponPrice:'3.00'});await f.db.insert(storeCouponUser).values({id:41,uid:11,issueCouponId:10,couponPrice:'3.00'});
    const now=Math.floor(Date.now()/1000);
    await f.db.insert(storePromotions).values([{id:1,pid:0,type:1,storeId:0,promotionsType:3,promotionsCate:1,name:'满五十减十',productPartakeType:1,thresholdType:1,
      startTime:now-100,stopTime:now+100,status:1,isDel:0,updateTime:now,overlay:'5'},
      {id:2,pid:1,type:1,storeId:0,promotionsType:3,promotionsCate:1,thresholdType:1,threshold:'50.00',discountType:1,discount:'10.00',status:1,isDel:0}]);
    await f.db.insert(storeCart).values({id:2,uid:11,productId:70,productAttrUnique:'qared001',cartNum:2,isNew:0,status:1});
    const selected=await request();expect(selected.body.status,selected.body.msg).toBe(200);expect(selected.body.data.deduction).toMatchObject({promotions_price:0,coupon_price:3,pay_price:36.98});
    const both=await request({cartId:'2,1'});expect(both.body.status,both.body.msg).toBe(200);expect(both.body.data.deduction).toMatchObject({sum_price:79.96,promotions_price:10,coupon_price:3,pay_price:66.96});
    expect(both.body.data.budget.selection.map((row:{id:number})=>row.id)).toEqual([2,1]);expect(both.body.data.promotions).toEqual([]);
    await f.db.update(storePromotions).set({overlay:''}).where(eq(storePromotions.id,1));
    const noStack=await request({cartId:'1,2'});expect(noStack.body.status,noStack.body.msg).toBe(200);expect(noStack.body.data.deduction.coupon_price).toBe(0);
  });
  it('quotes gift thresholds after the selected best coupon with exact eligible-line allocation, without awarding gifts',async()=>{
    const now=Math.floor(Date.now()/1000);
    await f.db.insert(storePromotions).values({id:1,pid:0,type:1,storeId:0,promotionsType:4,promotionsCate:1,name:'买指定商品满送积分',
      thresholdType:1,threshold:'39.00',giveIntegral:5,productPartakeType:2,startTime:now-100,stopTime:now+100,status:1,isDel:0,updateTime:now});
    await f.db.insert(storePromotionsAuxiliary).values({promotionsId:1,type:1,productId:70,unique:'qared001',isAll:1});
    await f.db.insert(storeProduct).values({id:71,price:'19.99',stock:8,isShow:1,isVerify:1,isVip:1,freight:1,deliveryType:'1,2,3'});
    await f.db.insert(storeProductAttrValue).values({id:2,productId:71,type:0,unique:'qared002',suk:'蓝色',price:'19.99',vipPrice:'10.00',stock:8});
    await f.db.insert(storeCart).values({id:2,uid:11,productId:71,productAttrUnique:'qared002',cartNum:2,isNew:0,status:1});
    await issue(10,{couponType:2,productId:'71',couponPrice:'30.00'});
    const before=await f.snapshot(),result=await request({cartId:'1,2'});expect(result.body.status,result.body.msg).toBe(200);
    expect(result.body.data).toMatchObject({deduction:{pay_price:49.96,coupon_price:30},budget:{gifts:[{id:1,giveIntegral:5}]}});
    expect(await f.snapshot()).toEqual(before);expect(f.writes).toEqual([]);
    await f.db.update(storeCouponIssue).set({productId:'70'}).where(eq(storeCouponIssue.id,10));
    const affected=await request({cartId:'1,2'});expect(affected.body.status,affected.body.msg).toBe(200);expect(affected.body.data.budget.gifts).toEqual([]);
  });
  it('resolves encoded product scopes, relation scopes and category descendants through the same checkout evaluator',async()=>{
    await f.db.insert(storeProductCategory).values([{id:1,pid:0,cateName:'父类',path:'0'},{id:2,pid:1,cateName:'子类',path:'0,1'}]);
    await f.db.update(storeProduct).set({cateId:'2'});
    for(const [id,overrides] of [[10,{couponType:2,legacyProductIds:'70'}],[11,{couponType:2,productId:'70'}],[12,{couponType:2}],[13,{couponType:1,legacyCategoryId:1}]] as const)await issue(id,{couponPrice:`${id-9}.00`,...overrides});
    await f.db.insert(storeCouponProduct).values({couponId:12,productId:70});
    const result=await request();expect(result.body.status,result.body.msg).toBe(200);expect(result.body.data.budget.couponIssueId).toBe(13);
  });
  it('keeps first-order precedence over coupons, price promotions and gifts with actual integer cap',async()=>{
    await issue(10,{couponPrice:'30.00'});await f.setBudgetConfig({first_order_status:'1',first_order_discount:'85.99',first_order_discount_limit:'5.00'});
    const result=await request();expect(result.body.status,result.body.msg).toBe(200);
    expect(result.body.data).toMatchObject({coupon:[],deduction:{first_order_price:5,coupon_price:0,promotions_price:0,pay_price:34.98},budget:{gifts:[]}});
    await f.db.insert(storeOrder).values({uid:11,orderId:'paid-normal-budget-test',paid:1,type:0});
    const repeat=await request();expect(repeat.body.status,repeat.body.msg).toBe(200);expect(repeat.body.data.deduction.first_order_price).toBe(0);
  });
  it.each([{uid:22},{isNew:1},{isPay:1},{isDel:1},{status:0},{staffId:3},{touristUid:'other'},{storeId:3},{productType:3},{type:8}])('rejects invalid/cross-origin reusable cart %j without dropping part of a selection',async change=>{
    await f.db.update(storeCart).set(change).where(eq(storeCart.id,1));const result=await request();expect(result.body.status).not.toBe(200);expect(result.body.data).toBeNull();
  });
  it.each([{isRetired:1},{stock:1}])('does not budget a retired or insufficient exact SKU %j',async change=>{
    await f.db.update(storeProductAttrValue).set(change);expect((await request()).body.status).not.toBe(200);
  });
  it('quotes a qualified reusable seckill at its activity price and rejects current stock, time or lifetime quota changes',async()=>{
    await f.db.insert(storeSeckillTime).values({id:1,title:'全天',status:1,startTime:'00:00',endTime:'24:00'});
    await f.db.insert(storeSeckill).values({id:10,productId:70,timeId:'1',stock:8,quota:8,onceNum:2,num:3,status:1,isShow:1,isDel:0});
    await f.db.insert(storeProductAttrValue).values({id:2,productId:10,type:1,unique:'sec00001',suk:'红色,大号',stock:8,quota:8,price:'5.00'});
    await f.db.update(storeCart).set({type:1,activityId:10});
    const result=await request();expect(result.body.status,result.body.msg).toBe(200);expect(result.body.data).toMatchObject({coupon:[],deduction:{type:1,activity_id:10,pay_price:10,coupon_price:0,first_order_price:0},svip_price:0});
    await f.db.insert(storeOrder).values({uid:11,orderId:'activity-history-budget',type:1,activityId:10,totalNum:2,paid:1});expect((await request()).body.status).not.toBe(200);
    await f.db.delete(storeOrder);await f.db.update(storeSeckill).set({quota:1});expect((await request()).body.status).not.toBe(200);
    await f.db.update(storeSeckill).set({quota:8});await f.db.update(storeSeckillTime).set({status:0});expect((await request()).body.status).not.toBe(200);
  });
  it('prices a qualified integral activity cash component while refusing insufficient real redemption points',async()=>{
    await f.db.insert(storeIntegral).values({id:10,productId:70,stock:8,quota:8,onceNum:2,num:-1,status:1,isShow:1,isDel:0});
    await f.db.insert(storeProductAttrValue).values({id:2,productId:10,type:4,unique:'int00001',suk:'红色,大号',stock:8,quota:8,price:'5.00',integral:60});
    await f.db.update(storeCart).set({type:4,activityId:10});await f.db.update(user).set({integral:100}).where(eq(user.uid,11));
    expect((await request()).body.status).not.toBe(200);
    await f.db.update(user).set({integral:120}).where(eq(user.uid,11));const result=await request();expect(result.body.status,result.body.msg).toBe(200);
    expect(result.body.data).toMatchObject({deduction:{type:4,pay_price:10,coupon_price:0,first_order_price:0},budget:{requiredIntegral:120}});
  });
  it('budgets and quotes explicitly unlimited integral caps without reserving points, stock or an order',async()=>{
    await integralSelection();
    await f.db.insert(storeOrder).values({uid:11,orderId:'unlimited-retained-budget',unique:'unlimited-retained-budget',type:4,activityId:10,paid:1,totalNum:2147483647});
    const before=await integralState(),result=await request();expect(result.body.status,result.body.msg).toBe(200);
    expect(result.body.data).toMatchObject({deduction:{type:4,pay_price:10},budget:{requiredIntegral:20}});
    expect(await integralQuote()).toMatchObject({requiredIntegralPoints:20,payCents:1000});
    expect(await integralState()).toEqual(before);expect(f.writes).toEqual([]);
  });
  it.each(['once','total'] as const)('refuses a zero integral %s cap in both the registered budget and checkout quote without writes',async cap=>{
    await integralSelection(cap==='once'?0:-1,cap==='total'?0:-1);
    const before=await integralState(),result=await request();expect(result.body.status).not.toBe(200);expect(result.body.data).toBeNull();
    await expect(integralQuote()).rejects.toBeInstanceOf(ValidateException);
    expect(await integralState()).toEqual(before);expect(f.writes).toEqual([]);
  });
  it('uses retained PHP integral roots in budget and quote: hidden paid and active unpaid count, children and foreign scopes do not',async()=>{
    await integralSelection(-1,5);
    // Labelled imported headers exercise activity count rules. These are not
    // payment, immutable origin, allocation or complete-history certificates.
    const rows=[
      {id:2001,paid:1,isDel:1,isSystemDel:1,totalNum:2},
      {id:2002,pid:-1,paid:0,isDel:0,isSystemDel:1,totalNum:1},
      {id:2003,pid:2001,paid:1,totalNum:99},
      {id:2004,paid:0,isDel:1,totalNum:99},
      {id:2005,uid:22,paid:1,totalNum:99},
      {id:2006,activityId:11,paid:1,totalNum:99},
      {id:2007,type:0,paid:1,totalNum:99},
    ];
    await f.db.insert(storeOrder).values(rows.map(row=>({uid:11,type:4,activityId:10,orderId:`retained_budget_${row.id}`,unique:`retained_budget_${row.id}`,...row})));
    let before=await integralState(),result=await request();expect(result.body.status,result.body.msg).toBe(200);
    expect(await integralQuote()).toMatchObject({requiredIntegralPoints:20,payCents:1000});
    expect(await integralState()).toEqual(before);expect(f.writes).toEqual([]);
    await f.db.update(storeIntegral).set({num:4}).where(eq(storeIntegral.id,10));
    before=await integralState();result=await request();expect(result.body.status).not.toBe(200);expect(result.body.data).toBeNull();
    await expect(integralQuote()).rejects.toBeInstanceOf(ValidateException);
    expect(await integralState()).toEqual(before);expect(f.writes).toEqual([]);
  });
  it('does not release private results after real account password version changes during a request',async()=>{
    const real=f.container.userDao.findForAuth.bind(f.container.userDao);let calls=0;
    vi.spyOn(f.container.userDao,'findForAuth').mockImplementation(async uid=>{
      if(++calls===2)await f.db.update(user).set({pwd:'revoked-after-snapshot'}).where(eq(user.uid,uid));return real(uid);
    });
    const result=await request();expect(result.body.status).not.toBe(200);expect(result.body.data).toBeNull();
  });
  it('rechecks JWT expiry after calculation and cannot use another owner token',async()=>{
    const result=await request({cartId:'1'},{token:other});expect(result.body.status).not.toBe(200);
    await expect(new CartComputationService(f.container).compute({uid:11,passwordVersion:'budget-password',expiresAt:Math.floor(Date.now()/1000)-1},{cartIds:[1]})).rejects.toThrow('登录已过期');
    const old=(await createToken(11,'api',md5('budget-password'),env.APP_KEY,'cinashop',Math.floor(Date.now()/1000)-8*86400)).token;
    expect((await request({cartId:'1'},{token:old})).body.status).not.toBe(200);
  });
  it('rejects verified expiry reached during pricing rather than releasing the already calculated private budget',async()=>{
    let clock=Date.now();const expiresAt=Math.floor(clock/1000)+2,original=StoreCartService.prototype.list;
    vi.spyOn(Date,'now').mockImplementation(()=>clock);
    vi.spyOn(StoreCartService.prototype,'list').mockImplementation(async function(this:StoreCartService,uid,scope){
      const rows=await original.call(this,uid,scope);clock+=3000;return rows;
    });
    await expect(new CartComputationService(f.container).compute({uid:11,passwordVersion:'budget-password',expiresAt},{cartIds:[1]})).rejects.toThrow('登录已过期');
  });
  it('keeps strong login/station-open and early unknown/duplicate query/body/cache rejection on the actual app',async()=>{
    for(const query of ['?cartId=1','?shipping_type=1&shipping_type=2','?price=0'])expect((await request({cartId:'1'},{query})).body.status).not.toBe(200);
    for(const options of [{token:''},{contentType:'text/plain'},{raw:'x'.repeat(4097)},{raw:new Uint8Array([255])}]){
      const result=await request({cartId:'1'},options);expect(result.body.status).not.toBe(200);expect(result.response.headers.get('cache-control')).toContain('no-store');
    }
    await f.db.insert(systemConfig).values({menuName:'station_open',value:'0'});
    const closed=await request();expect(closed.body.status).not.toBe(200);
    await f.db.delete(systemConfig).where(eq(systemConfig.menuName,'station_open'));
  });
});
