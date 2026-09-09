import { afterEach,beforeEach,describe,expect,it } from 'vitest';
import { eq } from 'drizzle-orm';
import { shippingTemplates } from '../src/models/schema';
import { createAdminShippingFixture,postShipping,shippingRegion,shippingAdminApp } from './helpers/adminShippingFixture';

describe('actual admin shipping writes are atomic',()=>{
 let f:Awaited<ReturnType<typeof createAdminShippingFixture>>;
 beforeEach(async()=>{f=await createAdminShippingFixture();},30_000);
 afterEach(async()=>{await f?.close();});
 it.each([0,10])('rolls back template and all regions after a later insert failure, id=%i',async id=>{
  await f.exec("CREATE FUNCTION qa_region_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.region_name='boom' THEN RAISE EXCEPTION 'isolated region failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER qa_region_failure BEFORE INSERT ON shipping_templates_region FOR EACH ROW EXECUTE FUNCTION qa_region_failure()");
  const before=await f.snapshot();
  expect((await postShipping(f.db,{id,name:'修改中',type:1,regions:[shippingRegion('成功行'),shippingRegion('boom')]})).status).not.toBe(200);
  expect(await f.snapshot()).toEqual(before);
 });
 it('preserves omitted metadata, rule sets, ownership and creation time on a rename',async()=>{
  const before=await f.snapshot();expect((await postShipping(f.db,{id:10,name:'新名称'})).status).toBe(200);
  expect(await f.snapshot()).toEqual({...before,templates:before.templates.map(t=>({...t,name:'新名称'}))});
 });
 it('does not create orphan child rows when editing a missing template',async()=>{
  const before=await f.snapshot();expect((await postShipping(f.db,{id:99,name:'不存在',regions:[shippingRegion()]})).status).not.toBe(200);
  expect(await f.snapshot()).toEqual(before);
 });
 it('does not edit a retired template',async()=>{
  await f.db.update(shippingTemplates).set({isDel:1}).where(eq(shippingTemplates.id,10));const before=await f.snapshot();
  expect((await postShipping(f.db,{id:10,name:'恢复?',regions:[shippingRegion()]})).status).not.toBe(200);expect(await f.snapshot()).toEqual(before);
 });
 it('accepts existing full-form payload without changing ownership or unrelated rule sets',async()=>{
  const before=await f.snapshot();const result=await postShipping(f.db,{id:10,name:'完整编辑',type:3,sort:5,status:1,regions:[shippingRegion('全国','8.50')],ownerType:2,relationId:999,isDel:1});
  expect(result).toMatchObject({status:200,data:{id:10}});const after=await f.snapshot();
  expect(after.templates[0]).toMatchObject({name:'完整编辑',type:3,sort:5,status:1,ownerType:0,relationId:0,isDel:0,addTime:123});
  expect(after.free).toEqual(before.free);expect(after.noDelivery).toEqual(before.noDelivery);expect(after.regions).toHaveLength(1);expect(after.regions[0].firstPrice).toBe('8.50');
  expect(after.regions[0].billingGroup).toBe(3);
 });
 it.each([{id:-1},{id:true},{id:'x'},{id:null},{type:4},{sort:-1},{status:2},{name:''},{name:'x'.repeat(256)},
  {regions:null},{regions:{}},{regions:[null]},{regions:[{...shippingRegion(),region_id:-1}]},
  {regions:[{...shippingRegion(),first_price:'-1'}]},{regions:[{...shippingRegion(),first:'1.001'}]},
  {regions:[{...shippingRegion(),continue_price:'10000000000'}]},
  {regions:Array.from({length:1001},()=>shippingRegion())}])('rejects invalid payload without any writes %#',async patch=>{
  const before=await f.snapshot();expect((await postShipping(f.db,{id:10,name:'无效编辑',...patch})).status).not.toBe(200);expect(await f.snapshot()).toEqual(before);
 });
 it('only clears regions on an explicit empty array, preserving special rule sets',async()=>{
  const before=await f.snapshot();expect((await postShipping(f.db,{id:10,regions:[]})).status).toBe(200);
  expect(await f.snapshot()).toEqual({...before,regions:[]});
 });
 it('creates a platform template and preserves the established zero/empty-region contract',async()=>{
  const result=await postShipping(f.db,{name:'新模板',regions:[],ownerType:2,relationId:123});
  expect(result.status).toBe(200);expect((await f.snapshot()).templates.find(t=>t.id===result.data?.id)).toMatchObject({name:'新模板',type:1,status:1,ownerType:0,relationId:0});
 });
 it('bounds the actual HTTP request body and marks the response no-store',async()=>{
  const app=shippingAdminApp(f.db),before=await f.snapshot();
  const rejected=await app.request('/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:10,name:'x'.repeat(262145)})});
  expect((await rejected.json() as {status:number}).status).not.toBe(200);expect(await f.snapshot()).toEqual(before);
  const accepted=await app.request('/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:10,name:'正常'})});
  expect(accepted.headers.get('cache-control')).toContain('no-store');
 });
});
