import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { StoreOrderCreateService, type CreateOrderParams } from '../src/services/order/StoreOrderCreateService';
import { SupplierExportService } from '../src/services/supplier/SupplierExportService';
import { SupplierPickingSheetReadService } from '../src/services/supplier/SupplierPickingSheetReadService';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { orderCreate } from '../src/controllers/api/v1/OrderController';
import { agentLevel, printDocument, storeCart, storeIntegral, storeOrderCartInfo, storeOrderStatus, storeProduct,
  storeProductAttrValue, systemSupplier, systemUserLevel, user, userBrokerage } from '../src/models/schema';

describe('checkout membership evidence and supplier consumers',()=>{
  let f:Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  const input={uid:11,key:'member-evidence',cartIds:[1],addressId:11,userIp:'127.0.0.1'};
  beforeEach(async()=>{
    vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('External requests forbidden'));
    f=await createPcCheckoutQuoteFixture([agentLevel,printDocument,storeOrderCartInfo,storeOrderStatus,userBrokerage,storeIntegral,systemSupplier,systemUserLevel]);
    await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key=>[key,'0'])));
    await f.db.insert(systemSupplier).values({id:7,supplierName:'Local membership supplier'});
    await f.db.update(storeProduct).set({type:2,relationId:7,freight:1,tempId:0}).where(eq(storeProduct.id,70));
    await f.db.insert(systemUserLevel).values({id:1,name:'Local level',discount:'80.00',isShow:1});
  },30_000);
  afterEach(async()=>{try{expect(fetch).not.toHaveBeenCalled();}finally{vi.restoreAllMocks();await f?.close();}});
  const create=(overrides:Partial<CreateOrderParams>={})=>StoreOrderCreateService.createWithRuntime(f.container,
    {CONFIG_KV:f.env.CONFIG_KV,nextOrderId:async()=>'LOCAL-MEMBER'},{...input,...overrides});
  const quote=(overrides:Partial<CreateOrderParams>={})=>new StoreOrderCreateService(f.container,f.env).quoteOrder({...input,...overrides});
  const snapshot=async()=>{const [row]=await f.db.select().from(storeOrderCartInfo);if(typeof row?.cartInfo!=='string')throw Error('Missing stored snapshot');
    return {row,info:JSON.parse(row.cartInfo) as Record<string,unknown>};};
  const state=async()=>({...await f.snapshot(),details:await f.db.select().from(storeOrderCartInfo),
    statuses:await f.db.select().from(storeOrderStatus),brokerage:await f.db.select().from(userBrokerage)});

  it.each([['level','2.00','4.00'],['member','1.00','2.00'],['','0.00','0.00']] as const)(
    'persists %s unit savings and returns the same total to exports and picking',async(priceType,unit,total)=>{
      await f.setConfig({member_func_status:priceType==='level'?'1':'0',member_card_status:priceType==='member'?'1':'0',svip_price_status:'1'});
      await f.db.update(user).set({level:1,levelStatus:1}).where(eq(user.uid,11));
      const priced=await quote();expect(priced.memberDiscountCents).toBe(Number(total)*100);
      await create();const {row,info}=await snapshot();expect(info).toMatchObject({vip_truePrice:unit,price_type:priceType});
      expect((await new SupplierExportService(f.container).storeOrder(7,{selection:'exact',ids:String(row.oid)})).export[0].vip_sum_price).toBe(total);
      expect((await new SupplierPickingSheetReadService(f.container).read(7,[row.oid])).list[0].vip_true_price).toBe(total);
    });
  it('does not label an activity price reduction as a member benefit',async()=>{
    await f.setConfig({member_func_status:'1',member_card_status:'1',svip_price_status:'1'});
    await f.db.update(user).set({level:1,levelStatus:1}).where(eq(user.uid,11));
    await f.db.insert(storeIntegral).values({id:9,productId:70,storeName:'Local activity',stock:8,quota:8,status:1,isShow:1,freight:1});
    await f.db.insert(storeProductAttrValue).values({id:2,productId:9,type:4,unique:'act00009',suk:'红色,大号',stock:8,quota:8,price:'3.00',integral:20});
    await f.db.update(storeCart).set({type:4,activityId:9}).where(eq(storeCart.id,1));
    const priced=await quote({type:4});expect(priced).toMatchObject({memberDiscountCents:0,levelDiscountCents:0,paidMemberDiscountCents:0});
    expect(priced.items[0]).toMatchObject({unitPriceCents:300,discountCents:0,priceType:''});
    await create({type:4});expect((await snapshot()).info).toMatchObject({sum_price:'3.00',vip_truePrice:'0.00',price_type:''});
  });

  it.each([
    {base:'1.07',percent:'33.90',vip:'0.90',unit:'0.35',saving:'0.72',kind:'level'},
    {base:'0.01',percent:'1.00',vip:'0.00',unit:'0.01',saving:'0.00',kind:''},
    {base:'10.00',percent:'80.00',vip:'7.00',unit:'7.00',saving:'3.00',kind:'member'},
    {base:'0.00',percent:'80.00',vip:'1.00',unit:'0.00',saving:'0.00',kind:''},
  ])('stores admitted cents at price $base / level $percent / VIP $vip',async item=>{
    await f.setConfig({member_func_status:'1',member_card_status:'1',svip_price_status:'1'});
    await f.db.update(user).set({level:1,levelStatus:1}).where(eq(user.uid,11));
    await f.db.update(systemUserLevel).set({discount:item.percent}).where(eq(systemUserLevel.id,1));
    await f.db.update(storeProductAttrValue).set({price:item.base,vipPrice:item.vip}).where(eq(storeProductAttrValue.id,1));
    await create();expect((await snapshot()).info).toMatchObject({sum_price:item.unit,vip_truePrice:item.saving,price_type:item.kind});
  });

  it.each(['product','expired','disabled-right'] as const)('does not invent a saving for an ineligible %s',async reason=>{
    await f.setConfig({member_card_status:'1',svip_price_status:reason==='disabled-right'?'0':'1'});
    if(reason==='product')await f.db.update(storeProduct).set({isVip:0}).where(eq(storeProduct.id,70));
    if(reason==='expired')await f.db.update(user).set({isEverLevel:0,isMoneyLevel:0,overdueTime:0}).where(eq(user.uid,11));
    await create();expect((await snapshot()).info).toMatchObject({sum_price:'10.00',vip_truePrice:'0.00',price_type:''});
  });

  it('keeps stored membership evidence on committed replay after pricing and rights change',async()=>{
    await f.setConfig({member_card_status:'1',svip_price_status:'1'});
    const first=await create(),saved=await snapshot();
    await f.setConfig({member_card_status:'0',svip_price_status:'0'});
    await f.db.update(storeProductAttrValue).set({price:'50.00',vipPrice:'0.01'}).where(eq(storeProductAttrValue.id,1));
    const before=await state();expect(await create()).toEqual(first);expect(await state()).toEqual(before);
    expect(await snapshot()).toEqual(saved);
    expect((await new SupplierExportService(f.container).storeOrder(7,{selection:'exact',ids:String(saved.row.oid)})).export[0].vip_sum_price).toBe('2.00');
  });

  it('rolls back the new evidence together with stock, points and all order writes on a late SQL failure',async()=>{
    await f.setConfig({member_card_status:'1',svip_price_status:'1',integral_ratio_status:'1',integral_ratio:'0.01',integral_max_type:'1',integral_max_num:'100'});
    await f.exec(`CREATE FUNCTION reject_member_bill() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'member evidence rollback'; END $$;
      CREATE TRIGGER reject_member_bill BEFORE INSERT ON user_bill FOR EACH ROW EXECUTE FUNCTION reject_member_bill()`);
    const before=await state();let failure:unknown;
    try{await create({useIntegral:true});}catch(error){failure=error;}
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).cause??failure)).toContain('member evidence rollback');
    expect(await state()).toEqual(before);
  });

  it('ignores client-forged membership fields at the actual HTTP create boundary',async()=>{
    await f.setConfig({member_card_status:'1',svip_price_status:'1'});
    f.app.post('/api/order/create/:key',orderCreate);
    Object.assign(f.env,{SEQUENCE:{idFromName:()=> 'local',get:()=>({fetch:async()=>new Response('LOCAL-MEMBER-HTTP')})}});
    const request=async(path:string,body:object)=>{
      const response=await f.app.request(path,{method:'POST',headers:{'content-type':'application/json','x-fixture-user':'11'},body:JSON.stringify(body)},f.env);
      return response.json() as Promise<{status:number;msg:string;data:{orderKey:string;quoteToken:string}}>;
    };
    const confirmed=await request('/api/order/confirm',input);expect(confirmed.status,confirmed.msg).toBe(200);
    const created=await request(`/api/order/create/${confirmed.data.orderKey}`,{...input,quoteToken:confirmed.data.quoteToken,
      vip_truePrice:'9999.99',price_type:'level',memberDiscountCents:999999,cartInfo:{vip_truePrice:'9999.99'}});
    expect(created.status,created.msg).toBe(200);
    expect((await snapshot()).info).toMatchObject({sum_price:'9.00',vip_truePrice:'1.00',price_type:'member'});
  });
});
