import { Hono } from 'hono';
import { createContainerFromDb, type DbClient } from '../../src/lib/di';
import type { AppVariables, Env } from '../../src/env';
import { shippingTemplates, shippingTemplatesRegion, shippingTemplatesFree, shippingTemplatesNoDelivery, storeProduct, systemCity,
 storeSeckill, storeBargain, storeCombination, storeIntegral, storeDiscountsProducts } from '../../src/models/schema';
import { adminShippingTemplateDel } from '../../src/controllers/api/v1/AdminCrudController';
import { adminSave, privateResponse } from '../../src/controllers/product/ShippingTemplateCreationController';
import { SHIPPING_TEMPLATE_CREATE_REPLAY_SQL } from '../../src/migrations/shippingTemplateCreateReplay';
import { financePostgres } from './financePostgres';
import { readAdminShippingSnapshot } from '../../src/services/admin/AdminShippingTemplateSnapshot';
import { adminShippingTemplateDetail, adminShippingTemplateCities } from '../../src/controllers/api/v1/AdminCrudController';

/** Actual controller, disposable SQL; authentication is an explicit local fixture. */
export function shippingAdminApp(db: DbClient) {
 const app = new Hono<{Bindings:Env;Variables:AppVariables}>();
 app.use('*',async(c,next)=>{c.set('container',createContainerFromDb(db));c.set('adminId',7);
  c.set('adminInfo',{id:7,account:'fixture',roles:'',level:0,realName:'fixture',divisionId:0});await next();});
 app.onError((e,c)=>c.json({status:400,msg:e.message,data:null}));
 app.post('/save',privateResponse,adminSave);app.delete('/delete/:id',adminShippingTemplateDel);
 app.get('/:id/edit',adminShippingTemplateDetail);app.get('/city_list',adminShippingTemplateCities);
 return app;
}
export const shippingRegion=(name='全国',price='6.00')=>({region_id:0,region_name:name,first:'1',first_price:price,continue:'1',continue_price:'2.00'});
export async function postShipping(db:DbClient,body:unknown) {
 // Existing atomicity tests now emulate opening the editor before submission.
 // Explicit expectedRevision (including invalid/null) is never replaced.
 if (body && typeof body === 'object' && 'id' in body && Number.isSafeInteger(body.id) && Number(body.id)>0 && !('expectedRevision' in body)) {
  let revision='shipping-v1:'+ '0'.repeat(64);
  try { revision=(await readAdminShippingSnapshot(db,Number(body.id))).revision; } catch { /* Missing/retired remains an HTTP rejection. */ }
  body={...body,expectedRevision:revision};
 }
 const response=await shippingAdminApp(db).request('/save',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID(),'X-Shipping-Creation-Scope':'v1:0:0:7'},body:JSON.stringify(body)});
 return response.json() as Promise<{status:number;msg:string;data:{id:number}|null}>;
}
export async function createAdminShippingFixture() {
 const f=await financePostgres([shippingTemplates,shippingTemplatesRegion,shippingTemplatesFree,shippingTemplatesNoDelivery,storeProduct,systemCity,
  storeSeckill,storeBargain,storeCombination,storeIntegral,storeDiscountsProducts]);
 try {
  await f.exec(SHIPPING_TEMPLATE_CREATE_REPLAY_SQL);
  await f.db.insert(shippingTemplates).values({id:10,name:'原模板',type:2,sort:9,status:0,appoint:1,noDelivery:1,addTime:123});
  await f.db.insert(shippingTemplatesRegion).values({id:10,templateId:10,regionId:0,regionName:'全国',first:'1.00',firstPrice:'6.00',continue:'1.00',continuePrice:'2.00'});
  await f.db.insert(shippingTemplatesFree).values({tempId:10,cityId:101,number:'2.00',price:'99.00'});
  await f.db.insert(shippingTemplatesNoDelivery).values({tempId:10,cityId:102});
  const snapshot=async()=>({templates:await f.db.select().from(shippingTemplates).orderBy(shippingTemplates.id),regions:await f.db.select().from(shippingTemplatesRegion).orderBy(shippingTemplatesRegion.id),free:await f.db.select().from(shippingTemplatesFree).orderBy(shippingTemplatesFree.id),noDelivery:await f.db.select().from(shippingTemplatesNoDelivery).orderBy(shippingTemplatesNoDelivery.id)});
  return {...f,snapshot};
 }catch(error){await f.close();throw error;}
}
