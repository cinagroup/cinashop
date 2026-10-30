import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import type { AppVariables, Env } from '../../src/env';
import { createContainerFromDb } from '../../src/lib/di';
import { errorHandler } from '../../src/middleware/error';
import { v1Routes } from '../../src/routes/v1';
import { createToken, md5 } from '../../src/utils/jwt';
import { storeProduct, storeProductAttrValue, systemAttachment, systemForm, systemFormData } from '../../src/models/schema';
import { upgradeCashierRuntimeConditionalBoundary } from '../../src/migrations/upgradeCashierRuntimeConditionalBoundary';
import { runCashierSecondCardFormImages } from '../../src/migrations/runCashierSecondCardFormImages';
import { upgradeCashierSecondCardFormImagesRuntime } from '../../src/migrations/upgradeCashierSecondCardFormImagesRuntime';
import { customerWorkOfflineOriginRefundFixture } from './customerWorkOfflineOriginRefundFixture';
import { cashierImageTemplate } from './customerCashierFormImagesFixture';

export type CashierHttpForm = 'none'|'text'|'image';
export const cashierHttpImage = new Uint8Array([137,80,78,71,13,10,26,10]);
export const cashierHttpImageSha = createHash('sha256').update(cashierHttpImage).digest('hex');

/** Full registered source profiles and production v1 routing. Only private
 * object storage, KV, Queue and internal order ID I/O are local adapters;
 * auth, independent session factory, SQL business producers and App consumer
 * execute unchanged code. No paid source or consumer result is seeded. */
export async function customerCashierRuntimeHttpFixture(){
  const f=await customerWorkOfflineOriginRefundFixture();
  try{
    await runCashierSecondCardFormImages(f.maintenanceDb);
    const conditionalPeers={...f.peers,cashierSecondCard:{...f.peers.cashierSecondCard!,conditionalGuards:true as const}};
    await upgradeCashierRuntimeConditionalBoundary(f.maintenanceDb,f.target,conditionalPeers,f.appReaders);
    const peers={...conditionalPeers,cashierSecondCard:{...conditionalPeers.cashierSecondCard,formImages:true as const}};
    const commissioned=await upgradeCashierSecondCardFormImagesRuntime(f.maintenanceDb,f.target,peers,f.appReaders);
    f.env.HYPERDRIVE_CUSTOMER_CASHIER={connectionString:f.cashierRuntime.connectionString} as Env['HYPERDRIVE_CUSTOMER_CASHIER'];
    f.env.CUSTOMER_CASHIER_RUNTIME_IDENTITY=commissioned.binding;
    const objects=new Map<string,Uint8Array>(),messages:unknown[]=[];
    const put=vi.fn(async(key:string,value:Uint8Array)=>{
      objects.set(key,new Uint8Array(value));return{key,size:value.byteLength};
    });
    const remove=vi.fn(async(key:string)=>{objects.delete(key);});
    const get=vi.fn(async(key:string)=>{
      const value=objects.get(key);if(!value)return null;
      return{key,size:value.length,body:new Blob([new Uint8Array(value)]).stream(),httpEtag:'"'+createHash('sha256').update(value).digest('hex')+'"',
        httpMetadata:{contentType:'image/png'},writeHttpMetadata:(headers:Headers)=>{headers.set('Content-Type','image/png');headers.set('Cache-Control','private, no-store');}};
    });
    const send=vi.fn(async(body:unknown)=>{messages.push(body);});
    const sendBatch=vi.fn(async(batch:Array<{body:unknown}>)=>{messages.push(...batch.map(item=>item.body));});
    f.env.ASSETS_BUCKET={put,get,delete:remove} as unknown as Env['ASSETS_BUCKET'];
    f.env.ORDER_QUEUE={send,sendBatch} as unknown as Env['ORDER_QUEUE'];
    const application=createContainerFromDb(f.appRuntime.db);
    const app=()=>{
      const h=new Hono<{Bindings:Env;Variables:AppVariables}>();
      h.use('*',async(c,next)=>{c.set('container',application);await next();});h.onError(errorHandler);h.route('/api',v1Routes);return h;
    };
    const raw=async(path:string,init:RequestInit={},bindings=f.env)=>app().request('/api'+path,init,bindings);
    const bearer=async(uid=101,realm:'api'|'admin'='api',password='owned-financial-password')=>(await createToken(uid,realm,md5(password),f.env.APP_KEY)).token;
    const request=async(path:string,body?:unknown,key?:string,uid=101,bindings=f.env)=>{
      const response=await raw(path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+await bearer(uid),
        ...(body===undefined?{}:{'Content-Type':'application/json'}),...(key?{'Idempotency-Key':key}:{})},
        ...(body===undefined?{}:{body:JSON.stringify(body)})},bindings);
      return{response,body:await response.json() as {status:number;msg:string;data:any}};
    };
    const reset=async(price='7.00',form:CashierHttpForm='none')=>{
      await f.exec('TRUNCATE public.cashier_second_card_form_upload_v1,public.cashier_second_card_form_session_v1');
      await f.reset();
      await f.maintenanceDb.delete(systemFormData);await f.maintenanceDb.delete(systemForm);await f.maintenanceDb.delete(systemAttachment);
      if(form!=='none')await f.maintenanceDb.insert(systemForm).values({id:77,name:'HTTP 原生次卡表单',value:JSON.stringify(form==='image'?cashierImageTemplate:[cashierImageTemplate[0]]),status:1,isDel:0});
      await f.maintenanceDb.update(storeProduct).set({systemFormId:form==='none'?0:77,productType:4,isVip:0,isSupportRefund:1,freight:1,stock:10,sales:0}).where(eq(storeProduct.id,70));
      await f.maintenanceDb.update(storeProductAttrValue).set({price,vipPrice:price,writeTimes:3,writeValid:2,writeDays:10,writeStart:0,writeEnd:0,stock:10,sales:0}).where(eq(storeProductAttrValue.id,1));
      objects.clear();messages.splice(0);put.mockClear();get.mockClear();remove.mockClear();send.mockClear();sendBatch.mockClear();
    };
    const facts=async()=>{
      const[row]=await f.maintenanceDb.execute<{value:Record<string,unknown>}>(sql`SELECT jsonb_build_object(
        'orders',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM store_order t),
        'carts',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM store_cart t),
        'drafts',(SELECT jsonb_agg(to_jsonb(t) ORDER BY actor_uid,request_key) FROM cashier_second_card_cart_v1 t),
        'order_items',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM store_order_cart_info t),
        'audits',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM store_order_status t),
        'origins',(SELECT jsonb_agg(to_jsonb(t) ORDER BY actor_uid,request_key) FROM cashier_second_card_origin_v1 t),
        'payments',(SELECT jsonb_agg(to_jsonb(t) ORDER BY actor_uid,request_key) FROM cashier_second_card_payment_v1 t),
        'sessions',(SELECT jsonb_agg(to_jsonb(t) ORDER BY actor_uid,request_key) FROM cashier_second_card_form_session_v1 t),
        'uploads',(SELECT jsonb_agg(to_jsonb(t) ORDER BY actor_uid,request_key) FROM cashier_second_card_form_upload_v1 t),
        'outbox',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM store_order_outbox t),
        'refunds',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM store_order_refund t),
        'manual',(SELECT jsonb_agg(to_jsonb(t) ORDER BY refund_id) FROM customer_financial_manual_refund_v1 t),
        'financial_operations',(SELECT jsonb_agg(to_jsonb(t) ORDER BY actor_uid,request_key) FROM customer_financial_operation_request t),
        'collections',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM system_form_data t),
        'attachments',(SELECT jsonb_agg(to_jsonb(t) ORDER BY att_id) FROM system_attachment t),
        'users',(SELECT jsonb_agg(to_jsonb(t) ORDER BY uid) FROM "user" t),
        'cards',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM store_order_writeoff t),
        'product',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM store_product t),
        'skus',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM store_product_attr_value t)) AS value`);
      return row.value;
    };
    await reset();
    return{...f,peers,commissioned,reset,request,raw,bearer,objects,messages,put,get,remove,send,sendBatch,facts};
  }catch(error){await f.close();throw error;}
}
