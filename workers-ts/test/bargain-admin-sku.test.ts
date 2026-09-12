import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { saveBargain } from '../src/services/activity/BargainAdminService';
import { readBargainSkuOptions } from '../src/services/activity/BargainAdminSkuService';
import { adminActivitySave, adminBargainSkuOptions } from '../src/controllers/api/v1/AdminCrudController';
import { createBargainSelectionFixture } from './helpers/bargainSelectionFixture';
import { storeProductAttr, storeProductAttrResult, storeProductAttrValue, storeCart, user,
  systemStore, storeOrderCartInfo, storeOrderStatus, printDocument } from '../src/models/schema';
import { ActivityJoinService } from '../src/services/activity/ActivityJoinService';
import { BargainSkuCatalogService } from '../src/services/activity/BargainSkuCatalogService';
import { StoreOrderCreateService, cancelStoreOrder } from '../src/services/order/StoreOrderCreateService';

describe('single-SKU bargain admin save', () => {
  let f: Awaited<ReturnType<typeof createBargainSelectionFixture>>;
  beforeEach(async()=>{f=await createBargainSelectionFixture([storeOrderCartInfo,storeOrderStatus,printDocument]);
    f.app.get('/admin/sku',adminBargainSkuOptions);f.app.post('/admin/save',adminActivitySave);
  },30_000);
  afterEach(async()=>{await f?.close();});
  const body=()=>({type:'bargain',productId:70,storeName:'单规格活动',stock:6,quota:5,price:'10.00',minPrice:'2.00',people:2,
    startTime:f.startTime.toISOString(),stopTime:f.stopTime.toISOString(),sku:{baseUnique:'qared001'}});
  const state=async()=>({...await f.snapshot(),sequences:undefined,
    attrs:await f.db.select().from(storeProductAttr).orderBy(storeProductAttr.id),
    results:await f.db.select().from(storeProductAttrResult).orderBy(storeProductAttrResult.id)});
  const activitySku=async(id:number)=>(await f.db.select().from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId,id),eq(storeProductAttrValue.type,2))))[0];
  it('creates the selected SKU, dimensions and snapshot atomically through the actual HTTP controller',async()=>{
    const response=await f.app.request('/admin/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body())},f.env);
    const result=await response.json() as {status:number;msg?:string;data:{id:number}};expect(result.status,result.msg).toBe(200);
    const sku=await activitySku(result.data.id);
    expect(sku).toMatchObject({suk:'红色,大号',stock:6,quota:5,quotaShow:5,price:'10.00',sales:0,type:2});
    expect(sku.unique).toMatch(/^[a-f0-9]{8}$/);expect(sku.unique).not.toBe('qared001');
    const saved=await state();expect(saved.attrs.filter(row=>row.type===2)).toMatchObject([{attrName:'颜色',attrValues:'红色'},{attrName:'尺码',attrValues:'大号'}]);
    expect(JSON.parse(saved.results[0].result).value[0]).toMatchObject({unique:sku.unique,stock:6,quota:5});
    expect(saved.skus.find(row=>row.id===1)).toMatchObject({stock:8,price:'10.00'});
  });
  it('returns only bounded selector data with no-store and rejects mismatched ownership of activity/product',async()=>{
    const response=await f.app.request('/admin/sku?productId=70&activityId=40',{},f.env);expect(response.headers.get('cache-control')).toBe('private, no-store');
    const result=await response.json() as {status:number;data:{options:Array<Record<string,unknown>>;current:unknown[]}};
    expect(result.status).toBe(200);expect(result.data.options).toHaveLength(2);expect(result.data.current).toHaveLength(2);
    expect(result.data.options[0]).not.toHaveProperty('diskInfo');
    await expect(readBargainSkuOptions(f.container,'70','999')).rejects.toThrow('不匹配');
  });
  it.each([undefined,null,{}, {baseUnique:'qared001',expected:[]}, {baseUnique:'bad'}, {baseUnique:'foreign1'}])('rejects missing/malformed/foreign SKU %j without partial creation',async sku=>{
    const before=await state();await expect(saveBargain(f.container,{...body(),sku})).rejects.toThrow();expect(await state()).toEqual(before);
  });
  it.each(['retired','stock','dimensions','duplicate'])('rejects unusable source %s and rolls back all activity writes',async mode=>{
    if(mode==='retired')await f.db.update(storeProductAttrValue).set({isRetired:1}).where(eq(storeProductAttrValue.id,1));
    if(mode==='stock')await f.db.update(storeProductAttrValue).set({stock:3}).where(eq(storeProductAttrValue.id,1));
    if(mode==='dimensions')await f.db.delete(storeProductAttr);
    if(mode==='duplicate')await f.db.update(storeProductAttrValue).set({suk:'红色,大号'}).where(eq(storeProductAttrValue.id,2));
    const before=await state();await expect(saveBargain(f.container,body())).rejects.toThrow();expect(await state()).toEqual(before);
  });
  it('preserves the activity SKU identity/sales while applying a deliberate inventory edit with matching originals',async()=>{
    const id=await saveBargain(f.container,body()),original=await activitySku(id);
    await f.db.update(storeProductAttrValue).set({sales:2}).where(eq(storeProductAttrValue.id,original.id));
    await saveBargain(f.container,{id,stock:7,quota:6,expected:{stock:6,quota:5},sku:{baseUnique:'qared001',expected:{id:original.id,unique:original.unique,stock:6,quota:5}}});
    expect(await activitySku(id)).toMatchObject({id:original.id,unique:original.unique,stock:7,quota:6,quotaShow:6,sales:2});
  });
  it('rejects stale SKU originals even if the activity main inventory has not changed',async()=>{
    const id=await saveBargain(f.container,body()),original=await activitySku(id);
    await f.db.update(storeProductAttrValue).set({stock:5}).where(eq(storeProductAttrValue.id,original.id));const before=await state();
    await expect(saveBargain(f.container,{id,price:'11.00',sku:{baseUnique:'qared001',expected:{id:original.id,unique:original.unique,stock:6,quota:5}}})).rejects.toThrow('规格已变化');
    expect(await state()).toEqual(before);
  });
  it('does not overwrite a differing SKU inventory during a price-only save',async()=>{
    const id=await saveBargain(f.container,body()),original=await activitySku(id);
    await f.db.update(storeProductAttrValue).set({stock:5,quota:4}).where(eq(storeProductAttrValue.id,original.id));
    await saveBargain(f.container,{id,price:'11.00',sku:{baseUnique:'qared001',expected:{id:original.id,unique:original.unique,stock:5,quota:4}}});
    expect(await activitySku(id)).toMatchObject({stock:5,quota:4,quotaShow:5,price:'11.00'});
  });
  it('does not replace a historical SKU or silently delete a multi-SKU configuration',async()=>{
    const before=await state();await expect(saveBargain(f.container,{id:40,sku:{baseUnique:'qared001',expected:null}})).rejects.toThrow('多规格');expect(await state()).toEqual(before);
    const id=await saveBargain(f.container,body()),original=await activitySku(id),saved=await state();
    await expect(saveBargain(f.container,{id,sku:{baseUnique:'qablue01',expected:{id:original.id,unique:original.unique,stock:6,quota:5}}})).rejects.toThrow('不能替换');expect(await state()).toEqual(saved);
  });
  it('rolls back the main row and SKU if saving the dimension snapshot fails',async()=>{
    await f.exec(`CREATE FUNCTION qa_sku_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'sku snapshot failed'; END $$;
      CREATE TRIGGER qa_sku_fail AFTER INSERT ON store_product_attr_result FOR EACH ROW EXECUTE FUNCTION qa_sku_fail()`);
    const before=await state();await expect(saveBargain(f.container,body())).rejects.toThrow();expect(await state()).toEqual(before);
  });
  it('supports actual start, two helpers, selection, checkout and exact cancellation for a newly saved SKU',async()=>{
    const id=await saveBargain(f.container,body());await f.db.insert(user).values({uid:33,account:'sku-helper-33'});
    const joins=new ActivityJoinService(f.container),participant=await joins.startBargain(11,id);
    await joins.helpBargain(22,participant.id);await joins.helpBargain(33,participant.id);
    const catalog=await new BargainSkuCatalogService(f.container).read(11,String(id),String(participant.id));
    expect(catalog.can_select).toBe(true);expect(catalog.skus).toHaveLength(1);expect(catalog.skus[0].catalog_price).toBe('2.00');
    await f.db.update(systemStore).set({isStore:1}).where(eq(systemStore.id,1));
    await f.db.insert(storeCart).values({id:10,uid:11,productId:70,productAttrUnique:catalog.skus[0].unique,cartNum:1,type:2,activityId:id,bargainUserId:participant.id,isNew:1,status:1});
    const before=await activitySku(id);
    await StoreOrderCreateService.createWithRuntime(f.container,{CONFIG_KV:f.env.CONFIG_KV,nextOrderId:async()=>'sku_created_order'},
      {uid:11,key:'sku_created_order',cartIds:[10],type:2,bargainUserId:participant.id,shippingType:2,storeId:1,realName:'隔离',userPhone:'00000000000',userIp:'127.0.0.1'});
    expect(await activitySku(id)).toMatchObject({stock:5,quota:4,sales:1});
    await cancelStoreOrder(f.container,{uid:11,orderId:'sku_created_order'});expect(await activitySku(id)).toEqual(before);
  });
});
