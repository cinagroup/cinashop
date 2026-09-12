import { Hono } from 'hono';
import { createContainerFromDb, type DbClient } from '../../src/lib/di';
import type { AppVariables, Env } from '../../src/env';
import { shippingTemplates, shippingTemplatesRegion, shippingTemplatesFree, shippingTemplatesNoDelivery, storeProduct, systemCity,
 storeSeckill, storeBargain, storeCombination, storeIntegral, storeDiscountsProducts } from '../../src/models/schema';
import { adminShippingTemplateSave, adminShippingTemplateDel } from '../../src/controllers/api/v1/AdminCrudController';
import { financePostgres } from './financePostgres';

/** Actual controller, disposable SQL; authentication is an explicit local fixture. */
export function shippingAdminApp(db: DbClient) {
 const app = new Hono<{Bindings:Env;Variables:AppVariables}>();
 app.use('*',async(c,next)=>{c.set('container',createContainerFromDb(db));await next();});
 app.onError((e,c)=>c.json({status:400,msg:e.message,data:null}));
 app.post('/save',adminShippingTemplateSave);app.delete('/delete/:id',adminShippingTemplateDel);
 return app;
}
export const shippingRegion=(name='全国',price='6.00')=>({region_id:0,region_name:name,first:'1',first_price:price,continue:'1',continue_price:'2.00'});
export async function postShipping(db:DbClient,body:unknown) {
 const response=await shippingAdminApp(db).request('/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 return response.json() as Promise<{status:number;msg:string;data:{id:number}|null}>;
}
export async function createAdminShippingFixture() {
 const f=await financePostgres([shippingTemplates,shippingTemplatesRegion,shippingTemplatesFree,shippingTemplatesNoDelivery,storeProduct,systemCity,
  storeSeckill,storeBargain,storeCombination,storeIntegral,storeDiscountsProducts]);
 try {
  await f.db.insert(shippingTemplates).values({id:10,name:'原模板',type:2,sort:9,status:0,appoint:1,noDelivery:1,addTime:123});
  await f.db.insert(shippingTemplatesRegion).values({id:10,templateId:10,regionId:0,regionName:'全国',first:'1.00',firstPrice:'6.00',continue:'1.00',continuePrice:'2.00'});
  await f.db.insert(shippingTemplatesFree).values({tempId:10,cityId:101,number:'2.00',price:'99.00'});
  await f.db.insert(shippingTemplatesNoDelivery).values({tempId:10,cityId:102});
  const snapshot=async()=>({templates:await f.db.select().from(shippingTemplates).orderBy(shippingTemplates.id),regions:await f.db.select().from(shippingTemplatesRegion).orderBy(shippingTemplatesRegion.id),free:await f.db.select().from(shippingTemplatesFree).orderBy(shippingTemplatesFree.id),noDelivery:await f.db.select().from(shippingTemplatesNoDelivery).orderBy(shippingTemplatesNoDelivery.id)});
  return {...f,snapshot};
 }catch(error){await f.close();throw error;}
}
