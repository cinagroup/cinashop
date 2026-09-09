import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { saveBargain } from '../src/services/activity/BargainAdminService';
import { readBargainSkuOptions } from '../src/services/activity/BargainAdminSkuService';
import { bargainShippingFields } from '../src/services/activity/BargainAdminShippingService';
import { StoreOrderCreateService } from '../src/services/order/StoreOrderCreateService';
import { shippingTemplates, storeBargain, storeCart, storeProduct, storeProductDescription } from '../src/models/schema';
import { createBargainSelectionFixture } from './helpers/bargainSelectionFixture';
import { adminActivitySave } from '../src/controllers/api/v1/AdminCrudController';
import { shippingForm, withBargainShipping } from '../../view/admin-ts/src/api/bargainShippingEdit';

describe('bargain admin shipping through saved SQL and real quote', () => {
 let f: Awaited<ReturnType<typeof createBargainSelectionFixture>>;
 beforeEach(async () => { f = await createBargainSelectionFixture(); f.app.post('/admin/save', adminActivitySave);
  await f.db.insert(storeCart).values({id:10,uid:11,productId:70,productAttrUnique:'qared001',cartNum:1,type:2,activityId:40,bargainUserId:80,isNew:1,status:1});
 }, 30_000);
 afterEach(async () => { await f?.close(); });
 const current = async () => bargainShippingFields((await f.db.select().from(storeBargain).where(eq(storeBargain.id,40)))[0]);
 const state = async () => ({ ...await f.snapshot(), sequences: undefined, descriptions: await f.db.select().from(storeProductDescription) });
 const request = async (patch: object) => {
  const response = await f.app.request('/admin/save', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'bargain',id:40,...patch})}, f.env);
  return response.json() as Promise<{status:number;msg:string}>;
 };
 const input = async (patch: object = {}) => ({deliveryType:'1,2',freight:1,postage:'0.00',tempId:0,expected:await current(),...patch});
 const quote = () => new StoreOrderCreateService(f.container,f.env).quoteOrder({uid:11,cartIds:[10],type:2,bargainUserId:80,shippingType:1,cityId:101});
 it.each([[1,'9.00',10,'0.00',0,200],[2,'8.50',10,'8.50',0,1050],[3,'9.00',10,'0.00',10,800]] as const)(
  'saves freight=%i, normalizes inactive fields, reloads and changes actual checkout price', async (freight,postage,tempId,storedPostage,storedTemplate,payCents) => {
   const before = await state(); expect((await request({shipping:await input({freight,postage,tempId})})).status).toBe(200);
   const edit = await readBargainSkuOptions(f.container,'70','40');
   expect(edit.shipping.current).toEqual({deliveryType:'1,2',freight,postage:storedPostage,tempId:storedTemplate});
   expect((await quote()).payCents).toBe(payCents);
   const after = await state(); expect(after.skus).toEqual(before.skus); expect(after.participations).toEqual(before.participations); expect(after.orders).toHaveLength(0);
  });
 it('retains unread/unchanged legacy rules on rename and rejects old shipping originals atomically', async () => {
  const original = await current(); await saveBargain(f.container,{id:40,storeName:'仅改名称'}); expect(await current()).toEqual(original);
  const shipping = await input({deliveryType:'2'}); await saveBargain(f.container,{id:40,shipping}); const before=await state();
  const response = await request({storeName:'不能覆盖',description:'<p>不能写入</p>',shipping:{...shipping,freight:2,postage:'5.00'}});
  expect(response.status).not.toBe(200); expect(response.msg).toContain('已变化'); expect(await state()).toEqual(before);
  await expect(quote()).rejects.toThrow('配送');
 });
 it.each([{deliveryType:''},{deliveryType:'1,1'},{deliveryType:'4'},{freight:0},{freight:'2'},
  {freight:2,postage:'0.00'},{postage:'1.001'},{postage:'100000000.00'},{postage:1},{tempId:-1},
  {freight:3,tempId:0},{freight:3,tempId:999},{expected:undefined},{expected:null}])('rejects invalid shipping %# without writes',async patch=>{
   const before=await state(); expect((await request({shipping:await input(patch)})).status).not.toBe(200); expect(await state()).toEqual(before);
 });
 it.each([1,2,3])('normalizes non-logistics source type %i at save time',async productType=>{
  await f.db.update(storeProduct).set({productType}).where(eq(storeProduct.id,70));
  await saveBargain(f.container,{id:40,shipping:await input({freight:3,tempId:999,postage:'12.00'})});
  expect(await current()).toEqual({deliveryType:'2',freight:2,postage:'0.00',tempId:0});
  expect((await readBargainSkuOptions(f.container,'70','40')).shipping.templates).toEqual([]);
 });
 it('inherits second-card delivery without treating it as a zero-postage virtual product',async()=>{
  await f.db.update(storeProduct).set({productType:4}); await saveBargain(f.container,{id:40,shipping:await input({freight:2,postage:'7.50'})});
  expect(await current()).toEqual({deliveryType:'2',freight:2,postage:'7.50',tempId:0});
 });
 it.each([0,1,2])('lists and accepts only active templates for source owner type %i',async type=>{
  const relationId=type?77:0;
  await f.db.update(storeProduct).set({type,relationId});
  await f.db.insert(shippingTemplates).values([{id:11,name:'所属方',ownerType:type,relationId},
   {id:12,name:'他人',ownerType:2,relationId:88},{id:13,name:'停用',ownerType:type,relationId,status:0},
   {id:14,name:'删除',ownerType:type,relationId,isDel:1}]);
  const read=await readBargainSkuOptions(f.container,'70','40');expect(read.shipping.templates.map(r=>r.id)).toEqual(type?[11]:[10,11]);
  for(const tempId of [12,13,14,...(type?[10]:[])]) await expect(saveBargain(f.container,{id:40,shipping:await input({freight:3,tempId})})).rejects.toThrow('不属于');
  await saveBargain(f.container,{id:40,shipping:await input({freight:3,tempId:11})});expect((await current()).tempId).toBe(11);
 });
 it('creates a real single-SKU activity with shipping and rolls back all fields on a later description failure',async()=>{
  const body={productId:70,storeName:'配送新活动',price:'10.00',minPrice:'2.00',people:2,stock:6,quota:5,sku:{baseUnique:'qared001'},
   startTime:f.startTime.toISOString(),stopTime:f.stopTime.toISOString(),shipping:{deliveryType:'2,1',freight:3,postage:'0.00',tempId:10}};
  const id=await saveBargain(f.container,body);expect((await readBargainSkuOptions(f.container,'70',String(id))).shipping.current?.deliveryType).toBe('1,2');
  await f.exec(`CREATE FUNCTION qa_shipping_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'shipping rollback'; END $$;
   CREATE TRIGGER qa_shipping_fail AFTER INSERT ON store_product_description FOR EACH ROW EXECUTE FUNCTION qa_shipping_fail()`);
  const before=await state(); await expect(saveBargain(f.container,{id:40,shipping:await input(),description:'<p>失败</p>'})).rejects.toThrow();expect(await state()).toEqual(before);
 });
});

describe('actual admin shipping payload',()=>{
 const original={deliveryType:'',freight:1,postage:'0.00',tempId:0}, options={current:original,productType:0,templates:[{id:10,name:'本地'}]};
 it('does not send unread or unchanged historical rules; deliberate edits include originals',()=>{
  expect(withBargainShipping({id:40},shippingForm(),null,0,70)).toEqual({id:40});
  expect(withBargainShipping({id:40},shippingForm(original),original,70,70,options)).toEqual({id:40});
  expect(withBargainShipping({id:40},{...shippingForm(original),methods:['1'],freight:2,postage:'4.50'},original,70,70,options))
   .toEqual({id:40,shipping:{deliveryType:'1',freight:2,postage:'4.50',tempId:0,expected:original}});
 });
 it('requires matching loaded product, methods and available template',()=>{
  expect(()=>withBargainShipping({},shippingForm(),null,70,71,options)).toThrow('加载');
  expect(()=>withBargainShipping({},shippingForm(original),null,70,70,options)).toThrow('配送');
  expect(()=>withBargainShipping({},{...shippingForm(),freight:3,tempId:99},null,70,70,options)).toThrow('模板');
  expect(withBargainShipping({},{...shippingForm(),freight:3,tempId:10},null,70,70,options)).toMatchObject({shipping:{freight:3,tempId:10,postage:'0.00'}});
 });
});
