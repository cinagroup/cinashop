import { eq, sql } from 'drizzle-orm';
import { vi } from 'vitest';
import type { Env } from '../../src/env';
import { systemAttachment, systemForm, systemFormData, storeProduct } from '../../src/models/schema';
import { customerCashierSecondCardFixture } from './customerCashierSecondCardFixture';
import { runCashierSecondCardFormImages, cashierSecondCardFormImagesReadiness } from '../../src/migrations/runCashierSecondCardFormImages';
import { CASHIER_SECOND_CARD_FORM_IMAGE_TABLES, CASHIER_SECOND_CARD_FORM_IMAGE_FUNCTIONS,
  CASHIER_SECOND_CARD_FORM_SESSION_UPDATE_COLUMNS, CASHIER_SECOND_CARD_FORM_UPLOAD_UPDATE_COLUMNS } from '../../src/migrations/cashierSecondCardFormImages';

export const cashierImageTemplate = [
  {id:'name',name:'texts',titleConfig:{value:'购买人'},titleShow:{val:true},value:''},
  {id:'photo',name:'uploadPicture',titleConfig:{value:'核对图片'},titleShow:{val:true},value:[],
    assistedImageScope:{digest:'forged-template'},cashierImageScope:{digest:'forged-template'}},
];
/** Storage is a private synthetic adapter; every SQL fact and transition uses
 * the established independently authenticated PostgreSQL16 customer LOGIN. */
export async function customerCashierFormImagesFixture() {
  const f=await customerCashierSecondCardFixture([systemAttachment,systemForm,systemFormData]);
  try{
    await runCashierSecondCardFormImages(f.maintenanceDb);const role=`"${f.role}"`;
    for(const table of CASHIER_SECOND_CARD_FORM_IMAGE_TABLES)await f.exec(`GRANT SELECT,INSERT ON public.${table} TO ${role}`);
    await f.exec(`GRANT UPDATE(${CASHIER_SECOND_CARD_FORM_SESSION_UPDATE_COLUMNS.join(',')}) ON public.cashier_second_card_form_session_v1 TO ${role}`);
    await f.exec(`GRANT UPDATE(${CASHIER_SECOND_CARD_FORM_UPLOAD_UPDATE_COLUMNS.join(',')}) ON public.cashier_second_card_form_upload_v1 TO ${role}`);
    for(const fn of CASHIER_SECOND_CARD_FORM_IMAGE_FUNCTIONS)await f.exec(`GRANT EXECUTE ON FUNCTION public.${fn} TO ${role}`);
    const ready=await cashierSecondCardFormImagesReadiness(f.db);
    console.log('CUSTOMER_CASHIER_IMAGES_READINESS '+JSON.stringify(ready));if(!ready.ready)throw Error('Actual cashier image LOGIN was not commissioned');
    const objects=new Map<string,Uint8Array>(),put=vi.fn(async(key:string,value:Uint8Array)=>{objects.set(key,new Uint8Array(value));return {key,size:value.byteLength};}),
      remove=vi.fn(async(key:string)=>{objects.delete(key);}),queue=vi.fn(async()=>{});
    f.env.ASSETS_BUCKET={put,delete:remove} as unknown as Env['ASSETS_BUCKET'];
    f.env.ORDER_QUEUE={send:queue,sendBatch:async()=>{}} as unknown as Env['ORDER_QUEUE'];let serial=0;
    f.env.SEQUENCE={idFromName:()=>({}),get:()=>({fetch:async()=>new Response(`IMG-CASHIER-${Date.now()}-${++serial}`)})} as unknown as Env['SEQUENCE'];
    const reset=async(price='7.00')=>{await f.exec('TRUNCATE public.cashier_second_card_form_upload_v1,public.cashier_second_card_form_session_v1');await f.reset(price);
      await f.maintenanceDb.update(storeProduct).set({systemFormId:0}).where(eq(storeProduct.id,70));await f.maintenanceDb.delete(systemFormData);await f.maintenanceDb.delete(systemForm);await f.maintenanceDb.delete(systemAttachment);
      await f.maintenanceDb.insert(systemForm).values({id:77,name:'真实图片次卡表单',value:JSON.stringify(cashierImageTemplate),status:1,isDel:0});
      await f.maintenanceDb.update(storeProduct).set({systemFormId:77}).where(eq(storeProduct.id,70));objects.clear();put.mockClear();remove.mockClear();queue.mockClear();};
    await reset();return {...f,reset,objects,put,remove,queue,
      facts:async()=>{const [r]=await f.maintenanceDb.execute<{data:Record<string,number>}>(sql`SELECT jsonb_build_object(
        'sessions',(SELECT count(*) FROM cashier_second_card_form_session_v1),'uploads',(SELECT count(*) FROM cashier_second_card_form_upload_v1),
        'attachments',(SELECT count(*) FROM system_attachment),'carts',(SELECT count(*) FROM store_cart),'orders',(SELECT count(*) FROM store_order),
        'collections',(SELECT count(*) FROM system_form_data),'origins',(SELECT count(*) FROM cashier_second_card_origin_v1),'payments',(SELECT count(*) FROM cashier_second_card_payment_v1)) AS data`);return r.data;}};
  }catch(error){await f.close();throw error;}
}
