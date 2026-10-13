import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppVariables, Env } from '../src/env';
import { createContainerFromDb, type DbClient } from '../src/lib/di';
import { authMiddleware } from '../src/middleware/auth';
import { errorHandler } from '../src/middleware/error';
import { createToken, md5 } from '../src/utils/jwt';
import { storeOrder, storeProduct, storeProductAttrValue, storeService, systemAttachment, systemForm, systemFormData, user } from '../src/models/schema';
import * as imageController from '../src/controllers/api/v1/CustomerCashierFormImagesController';
import * as cashierController from '../src/controllers/api/v1/CustomerWorkCashierController';
import { CustomerCashierFormImages, CASHIER_FORM_IMAGE_VERSION, CASHIER_FORM_SESSION_VERSION } from '../src/services/customer-work/CustomerCashierFormImages';
import { CustomerWorkCashierCatalog } from '../src/services/customer-work/CustomerWorkCashierCatalog';
import { CustomerWorkCashierReadService } from '../src/services/customer-work/CustomerWorkCashierReadService';
import { CustomerWorkReadService } from '../src/services/customer-work/CustomerWorkReadService';
import { AdminAssistedOrderService } from '../src/services/admin/AdminAssistedOrderService';
import { readOrderSystemFormForOrder } from '../src/services/order/OrderSystemFormService';
import { AttachmentService, isAttachmentObjectCleanupMessage } from '../src/services/system/AttachmentService';
import { cashierSecondCardFormImagesReadiness } from '../src/migrations/runCashierSecondCardFormImages';
import { cashierImageTemplate, customerCashierFormImagesFixture } from './helpers/customerCashierFormImagesFixture';

const png=new Uint8Array([137,80,78,71,13,10,26,10]),sha=(v:Uint8Array)=>createHash('sha256').update(v).digest('hex');
describe.skipIf(!process.env.TEST_FINANCE_POSTGRES_URL)('ordinary customer cashier durable form images PostgreSQL16',()=>{
  let f:Awaited<ReturnType<typeof customerCashierFormImagesFixture>>;
  beforeAll(async()=>{f=await customerCashierFormImagesFixture();},180000);
  beforeEach(async()=>{await f.reset();});afterAll(async()=>{vi.restoreAllMocks();await f?.close();},30000);
  const service=(db:DbClient=f.db)=>new CustomerCashierFormImages(createContainerFromDb(db),f.env);
  function app(db:DbClient=f.db){const h=new Hono<{Bindings:Env;Variables:AppVariables}>();
    h.use('*',async(c,next)=>{c.set('container',createContainerFromDb(db));await next();});h.use('*',authMiddleware({force:true}));h.onError(errorHandler);
    h.post('/form-sessions',imageController.formSessionCreate);h.get('/form-sessions/:key',imageController.formSessionRead);
    h.post('/form-sessions/:key/cancel',imageController.formSessionCancel);h.post('/form-sessions/:key/images',imageController.formImageUpload);
    h.post('/form-sessions/:key/previews',imageController.formSessionPreviews);h.get('/form-images/:key',imageController.formImageRead);
    h.post('/drafts',cashierController.cashierDraft);h.post('/quote',cashierController.cashierQuote);h.post('/orders',cashierController.cashierCreate);
    h.get('/creations/:key',cashierController.cashierCreationStatus);h.get('/records/:id',cashierController.cashierRecord);return h;}
  async function http(path:string,body?:unknown,key?:string,uid=101,db:DbClient=f.db,realm:'api'|'admin'='api'){
    const token=(await createToken(uid,realm,md5('owned-financial-password'),f.env.APP_KEY)).token;
    const response=await app(db).request(path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,
      ...(body===undefined?{}:{'Content-Type':'application/json'}),...(key?{'Idempotency-Key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})},f.env);
    return {response,body:await response.json() as {status:number;msg:string;data:any}};}
  async function session(overrides:Parameters<typeof f.input>[0]={}){const native=await f.input(overrides),{request_key,...intent}=native;
    const body={version:CASHIER_FORM_SESSION_VERSION,scope_key:intent.scope_key,buyer_uid:intent.buyer_uid,tourist_key:intent.tourist_key,
      product_id:intent.product_id,sku_unique:intent.sku_unique,quantity:intent.quantity};
    const r=await http('/form-sessions',body,request_key);expect(r.body.status,r.body.msg).toBe(200);return {key:request_key,intent,body,receipt:r.body.data.receipt};}
  const metadata=(s:Awaited<ReturnType<typeof session>>,overrides:Record<string,unknown>={})=>({version:CASHIER_FORM_IMAGE_VERSION,scope_key:s.intent.scope_key,
    session_key:s.key,field_id:'id:"photo"',sha256:sha(png),size:png.length,...overrides});
  async function upload(s:Awaited<ReturnType<typeof session>>,key=randomUUID(),meta=metadata(s),db:DbClient=f.db,bytes=png,extra=false){
    const form=new FormData();form.append('file',new File([bytes],'local.png',{type:'image/png'}));form.append('metadata',JSON.stringify(meta));if(extra)form.append('scope','forged');
    const encoded=new Response(form),body=await encoded.arrayBuffer(),token=(await createToken(101,'api',md5('owned-financial-password'),f.env.APP_KEY)).token;
    const response=await app(db).request(`/form-sessions/${s.key}/images`,{method:'POST',body,headers:{Authorization:`Bearer ${token}`,
      'Content-Type':encoded.headers.get('Content-Type')!,'Content-Length':String(body.byteLength),'Idempotency-Key':key}},f.env);
    return {key,response,body:await response.json() as {status:number;msg:string;data:any}};}
  function answers(reference:string){return [{id:'name',name:'texts',value:'原购买人'},{id:'photo',name:'uploadPicture',value:[reference],cashierImageScope:{actor_uid:999}}];}
  async function prepared(s:Awaited<ReturnType<typeof session>>,reference:string){const intent={...s.intent,custom_form:answers(reference)},draft=await http('/drafts',intent,s.key);
    expect(draft.body.status,draft.body.msg).toBe(200);return {...s,intent,cart_id:draft.body.data.cart_id};}
  async function quoted(s:Awaited<ReturnType<typeof prepared>>){const q=await http('/quote',{request_key:s.key,intent:s.intent});expect(q.body.status,q.body.msg).toBe(200);return q.body.data;}
  async function created(s:Awaited<ReturnType<typeof prepared>>){const q=await quoted(s),c=await http('/orders',{intent:s.intent,quote_token:q.quote_token},s.key);expect(c.body.status,c.body.msg).toBe(200);return c.body.data;}
  function lostReplyDb(db:DbClient,transactionNumber:number){let number=0,thrown=false;
    return new Proxy(db,{get(target,key,receiver){const value=Reflect.get(target,key,receiver);if(typeof value!=='function')return value;
      if(key!=='transaction')return value.bind(target);return async(...args:unknown[])=>{const result=await Reflect.apply(value,target,args);number++;
        if(!thrown&&number===transactionNumber){thrown=true;throw Object.assign(Error('Original COMMIT response lost'),{code:'40003'});}return result;};}});}

  it('commissions only new guarded columns and enables required image selection independently',async()=>{
    expect(await cashierSecondCardFormImagesReadiness(f.db)).toMatchObject({ready:true,privileges:{narrow_update:true,authority_safe:true,role_safe:true}});
    const context=await new CustomerWorkReadService(f.container,f.env).context(f.actor());expect(context.data.capabilities).toMatchObject({cashier_second_card:true,cashier_form_images:true,assisted_order:false,writes:false});
    const selection=await new CustomerWorkCashierCatalog(f.container,f.env).selection(f.actor(),70);expect(selection.data.readiness).toEqual({writes:true,reason:''});
    expect(selection.data.system_form?.value[1]).not.toHaveProperty('cashierImageScope');expect(selection.data.system_form?.value[1]).not.toHaveProperty('assistedImageScope');
    await expect(f.db.execute(sql`UPDATE public.cashier_second_card_form_session_v1 SET scope_key=${'a'.repeat(64)}`)).rejects.toThrow();
    await expect(f.db.execute(sql`DELETE FROM public.cashier_second_card_form_upload_v1`)).rejects.toThrow();
  });
  it('runs real member image upload freeze create cash and immutable form detail',async()=>{
    const s=await session(),u=await upload(s);expect(u.body.status,u.body.msg).toBe(200);const image=u.body.data.receipt;
    expect(image).toMatchObject({actor_uid:101,service_id:1,session_key:s.key,state:'stored',field_id:'id:"photo"',sha256:sha(png),size:8,mime:'image/png'});
    expect(f.put).toHaveBeenCalledTimes(1);const key=f.put.mock.calls[0][0];expect(key).toMatch(/^attachments\/cc\/[A-Za-z0-9_-]{43}\/[a-f0-9]{32}\.png$/);expect(key).not.toContain('tourist');
    const p=await prepared(s,image.reference),c=await created(p),actual=await f.actual(c.receipt.order_id);expect(actual.order.customForm).toContain('cashierImageScope');
    const paid=await f.cash(actual.order);expect(paid.evidence).toMatchObject({paid:1,amount:actual.order.payPrice});await f.processPaid(paid.outbox!);
    const detail=await new CustomerWorkCashierReadService(f.container,f.env).record(f.actor(),actual.order.id,{order_no:actual.order.orderId});
    expect(detail.data.form).toMatchObject({session_key:s.key,system_form_id:77,components:[{value:'原购买人'},{value:[image.reference]}],previews:[{reference:image.reference}]});
    expect(detail.data.form?.previews[0].url).toMatch(new RegExp(`^${image.reference}\\?expires=\\d+&signature=`));expect(detail.data.form?.components[1]).not.toHaveProperty('cashierImageScope');
    expect((await service().getSession(f.actor(),s.key)).receipt).toMatchObject({state:'consumed',order_id:actual.order.id,order_no:actual.order.orderId});
    expect(await f.facts()).toMatchObject({sessions:1,uploads:1,attachments:1,orders:1,collections:1,origins:1,payments:1});
  });
  it('runs actual guest zero payment with separate operator image ownership',async()=>{
    await f.reset('0.00');const s=await session({buyer_uid:0,tourist_key:'original-guest'}),u=await upload(s);expect(u.body.status,u.body.msg).toBe(200);
    const c=await created(await prepared(s,u.body.data.receipt.reference)),actual=await f.actual(c.receipt.order_id),paid=await f.cash(actual.order);
    expect(actual.order.uid).toBe(0);expect(paid.evidence).toMatchObject({amount:'0.00',buyer_uid:0,creator_uid:101});
    const [attachment]=await f.maintenanceDb.select().from(systemAttachment);expect(attachment).toMatchObject({type:3,relationId:101,moduleType:6});
  });
  it('recovers absent session and image receipts without creating a row',async()=>{
    const before=await f.facts();expect((await service().getSession(f.actor(),randomUUID())).receipt).toBeNull();expect((await service().getImage(f.actor(),randomUUID())).receipt).toBeNull();expect(await f.facts()).toEqual(before);expect(f.put).not.toHaveBeenCalled();
  });
  it('rejects actor and realm substitution and wrong original session selection',async()=>{
    const s=await session();expect((await http(`/form-sessions/${s.key}`,undefined,undefined,102)).body.data.receipt).toBeNull();
    expect((await http('/form-sessions',s.body,randomUUID(),102)).body.status).not.toBe(200);expect((await http('/form-sessions',s.body,randomUUID(),101,f.db,'admin')).body.status).not.toBe(200);
    expect((await http('/form-sessions',{...s.body,buyer_uid:0,tourist_key:'other-guest'},s.key)).body.status).toBe(409);
    const bad=await upload(s,randomUUID(),metadata(s,{session_key:randomUUID()}));expect(bad.body.status).not.toBe(200);expect(f.put).not.toHaveBeenCalled();
  });
  it.each([{sha256:'a'.repeat(64)},{size:9},{field_id:'id:"name"'},{scope_key:'b'.repeat(64)}])('rejects upload metadata $field_id before R2',async(patch)=>{
    const s=await session(),u=await upload(s,randomUUID(),metadata(s,patch));expect(u.body.status).not.toBe(200);expect(f.put).not.toHaveBeenCalled();expect(await f.facts()).toMatchObject({uploads:0,attachments:0,orders:0});
  });
  it('rejects multipart extra keys and a different original upload content before R2',async()=>{
    const s=await session(),extra=await upload(s,randomUUID(),metadata(s),f.db,png,true);expect(extra.body.status).not.toBe(200);expect(f.put).not.toHaveBeenCalled();
    const key=randomUUID(),first=await upload(s,key);expect(first.body.status,first.body.msg).toBe(200);const other=new Uint8Array([...png,0]),retry=await upload(s,key,metadata(s,{sha256:sha(other),size:other.length}),f.db,other);
    expect(retry.body.status).toBe(409);expect(f.put).toHaveBeenCalledTimes(1);expect((await service().getImage(f.actor(),key)).receipt?.sha256).toBe(sha(png));
  });
  it('replays the same stored UUID without another object or attachment',async()=>{
    const s=await session(),key=randomUUID(),first=await upload(s,key),second=await upload(s,key);expect(second.body.status,second.body.msg).toBe(200);expect(second.body.data).toEqual(first.body.data);expect(f.put).toHaveBeenCalledTimes(1);expect(await f.facts()).toMatchObject({uploads:1,attachments:1});
  });
  it('serializes concurrent same-byte original UUID completion into one attachment',async()=>{
    const s=await session(),key=randomUUID();let release!:()=>void,entered!:()=>void;const arrived=new Promise<void>(resolve=>entered=resolve),held=new Promise<void>(resolve=>release=resolve);
    f.put.mockImplementationOnce(async(objectKey,bytes)=>{f.objects.set(objectKey,bytes);entered();await held;return {key:objectKey,size:bytes.length};});
    await f.withPeer(async peer=>{const first=service(peer).upload(f.actor(),s.key,key,metadata(s),new File([png],'local.png',{type:'image/png'}));await arrived;
      let second:Awaited<ReturnType<CustomerCashierFormImages['upload']>>;try{second=await service().upload(f.actor(),s.key,key,metadata(s),new File([png],'local.png',{type:'image/png'}));}finally{release();}
      expect(await first).toEqual(second!);});expect(await f.facts()).toMatchObject({uploads:1,attachments:1});expect(f.objects.size).toBe(1);expect(f.remove).not.toHaveBeenCalled();
  });
  it('serializes draft freeze and cancellation into one durable winner without revival',async()=>{
    const s=await session(),u=await upload(s),intent={...s.intent,custom_form:answers(u.body.data.receipt.reference)};
    await f.withPeer(async peer=>{const [draft,cancel]=await Promise.all([
      http('/drafts',intent,s.key,101,peer),http(`/form-sessions/${s.key}/cancel`,{version:CASHIER_FORM_SESSION_VERSION,scope_key:s.intent.scope_key},s.key)]);
      expect([draft.body.status,cancel.body.status].filter(status=>status===200)).toHaveLength(1);
      const state=(await service().getSession(f.actor(),s.key)).receipt?.state;
      if(state==='cancelled'){expect((await f.facts()).carts).toBe(0);expect((await http('/drafts',intent,s.key)).body.status).not.toBe(200);}
      else {expect(state).toBe('frozen');expect((await f.facts()).carts).toBe(1);expect(cancel.body.status).toBe(409);}
    });expect((await f.facts()).orders).toBe(0);
  });
  it('preserves no-image cashier with installed readable tables but missing guarded UPDATE grants',async()=>{
    await f.maintenanceDb.update(systemForm).set({value:JSON.stringify([cashierImageTemplate[0]])}).where(eq(systemForm.id,77));
    await f.exec(`REVOKE UPDATE(state,cancelled_at,frozen_request_hash,frozen_input_json,order_id,order_no,snapshot_json,snapshot_hash,collection_json,collection_hash) ON public.cashier_second_card_form_session_v1 FROM "${f.role}"`);
    try{expect((await cashierSecondCardFormImagesReadiness(f.db)).ready).toBe(false);
      const native=await f.input({custom_form:[{id:'name',name:'texts',value:'旧无图片'}]}),{request_key,...intent}=native;
      const draft=await http('/drafts',intent,request_key);expect(draft.body.status,draft.body.msg).toBe(200);
      const q=await http('/quote',{request_key,intent});expect(q.body.status,q.body.msg).toBe(200);
      const created=await http('/orders',{intent,quote_token:q.body.data.quote_token},request_key);expect(created.body.status,created.body.msg).toBe(200);
      expect(await f.facts()).toMatchObject({sessions:0,uploads:0,orders:1,collections:1});
    }finally{await f.exec(`GRANT UPDATE(state,cancelled_at,frozen_request_hash,frozen_input_json,order_id,order_no,snapshot_json,snapshot_hash,collection_json,collection_hash) ON public.cashier_second_card_form_session_v1 TO "${f.role}"`);}
  });
  it('marks base cashier unavailable and rejects UUID writes explicitly when installed tables lack SELECT',async()=>{
    await f.exec(`REVOKE SELECT ON public.cashier_second_card_form_session_v1 FROM "${f.role}"`);
    try{const context=await new CustomerWorkReadService(f.container,f.env).context(f.actor());expect(context.data.capabilities.cashier_second_card).toBe(false);
      expect(context.data.cashier_readiness.reason).toBe('cashier_second_card_form_images_read_grants_missing');
      const native=await f.input({custom_form:[{id:'name',name:'texts',value:'无法核对'}]}),{request_key,...intent}=native;
      const r=await http('/drafts',intent,request_key);expect(r.response.status).toBe(503);expect(r.body.status).toBe(503);expect((await f.facts()).carts).toBe(0);
    }finally{await f.exec(`GRANT SELECT ON public.cashier_second_card_form_session_v1 TO "${f.role}"`);}
  });
  it('recovers a committed image after a lost original metadata COMMIT response',async()=>{
    const s=await session(),key=randomUUID(),db=lostReplyDb(f.db,2),scoped=service(db);
    await expect(scoped.upload(f.actor(),s.key,key,metadata(s),new File([png],'local.png',{type:'image/png'}))).rejects.toThrow('COMMIT');
    const recovered=await service().getImage(f.actor(),key);expect(recovered.receipt).toMatchObject({state:'stored',sha256:sha(png)});expect(f.objects.size).toBe(1);expect(f.remove).not.toHaveBeenCalled();
    const replay=await service().upload(f.actor(),s.key,key,metadata(s),new File([png],'local.png',{type:'image/png'}));expect(replay).toEqual(recovered);expect(f.put).toHaveBeenCalledTimes(1);
  });
  it('retains a reserved original UUID after object uncertainty and permits only same bytes recovery',async()=>{
    const s=await session(),key=randomUUID();f.put.mockImplementationOnce(async(objectKey,bytes)=>{f.objects.set(objectKey,bytes);throw Error('R2 reply unknown');});
    const failed=await upload(s,key);expect(failed.body.status).not.toBe(200);expect((await service().getImage(f.actor(),key)).receipt?.state).toBe('reserved');expect(f.objects.size).toBe(1);
    expect((await upload(s,key)).body.status).toBe(200);expect(await f.facts()).toMatchObject({uploads:1,attachments:1});
  });
  it('cancels only an unfrozen original session and recovers a lost cancel COMMIT response',async()=>{
    const s=await session(),u=await upload(s);expect(u.body.status,u.body.msg).toBe(200);const cancelBody={version:CASHIER_FORM_SESSION_VERSION,scope_key:s.intent.scope_key};
    await expect(service(lostReplyDb(f.db,1)).cancel(f.actor(),s.key,s.key,cancelBody)).rejects.toThrow('COMMIT');
    expect((await service().getSession(f.actor(),s.key)).receipt?.state).toBe('cancelled');expect((await service().cancel(f.actor(),s.key,s.key,cancelBody)).receipt?.state).toBe('cancelled');
    expect((await http('/drafts',{...s.intent,custom_form:answers(u.body.data.receipt.reference)},s.key)).body.status).not.toBe(200);expect((await upload(s)).body.status).not.toBe(200);expect(await f.facts()).toMatchObject({orders:0,carts:0,attachments:1});
  });
  it('makes a late R2 result unconsumable after durable cancellation and compensates it',async()=>{
    const s=await session(),key=randomUUID();let release!:()=>void,entered!:()=>void;const arrived=new Promise<void>(resolve=>entered=resolve),held=new Promise<void>(resolve=>release=resolve);
    f.put.mockImplementationOnce(async(objectKey,bytes)=>{f.objects.set(objectKey,bytes);entered();await held;return {key:objectKey,size:bytes.length};});
    await f.withPeer(async peer=>{const uploading=service(peer).upload(f.actor(),s.key,key,metadata(s),new File([png],'local.png',{type:'image/png'}));await arrived;
      try{await service().cancel(f.actor(),s.key,s.key,{version:CASHIER_FORM_SESSION_VERSION,scope_key:s.intent.scope_key});}finally{release();}
      await expect(uploading).rejects.toThrow('取消');});
    expect((await service().getImage(f.actor(),key)).receipt?.state).toBe('reserved');expect(f.objects.size).toBe(0);expect(f.remove).toHaveBeenCalledTimes(1);expect(await f.facts()).toMatchObject({attachments:0,orders:0});
  });
  it('does not cancel a frozen request and never clears a financial original UUID',async()=>{
    const s=await session(),u=await upload(s),p=await prepared(s,u.body.data.receipt.reference),before=await f.facts();
    const r=await http(`/form-sessions/${s.key}/cancel`,{version:CASHIER_FORM_SESSION_VERSION,scope_key:s.intent.scope_key},s.key);expect(r.body.status).toBe(409);expect(await f.facts()).toEqual(before);
    const c=await created(p);expect((await service().getSession(f.actor(),s.key)).receipt?.state).toBe('consumed');expect(c.receipt.order_id).toBeGreaterThan(0);
  });
  it('allows original owner recovery and active cancellation after role loss without a new upload',async()=>{
    const s=await session(),u=await upload(s);await f.maintenanceDb.update(storeService).set({customer:0}).where(eq(storeService.uid,101));
    expect((await service().getImage(f.actor(),u.key)).receipt?.state).toBe('stored');expect((await service().previews(f.actor(),s.key,{references:[u.body.data.receipt.reference]})).previews).toHaveLength(1);
    expect((await upload(s)).body.status).not.toBe(200);expect((await service().cancel(f.actor(),s.key,s.key,{version:CASHIER_FORM_SESSION_VERSION,scope_key:s.intent.scope_key})).receipt?.state).toBe('cancelled');expect(f.put).toHaveBeenCalledTimes(1);
  });
  it.each(['template','role','product','sku'])('rejects metadata after %s changes during R2 and preserves retry facts',async(change)=>{
    const s=await session();f.put.mockImplementationOnce(async(key,bytes)=>{f.objects.set(key,bytes);
      if(change==='template')await f.maintenanceDb.update(systemForm).set({value:JSON.stringify(cashierImageTemplate.map(c=>({...c,titleConfig:{value:'改后模板'}})))}).where(eq(systemForm.id,77));
      else if(change==='role')await f.maintenanceDb.update(storeService).set({customer:0}).where(eq(storeService.uid,101));
      else if(change==='product')await f.maintenanceDb.update(storeProduct).set({isVerify:0}).where(eq(storeProduct.id,70));
      else await f.maintenanceDb.update(storeProductAttrValue).set({isRetired:1}).where(eq(storeProductAttrValue.id,1));
      return {key,size:bytes.length};});
    const r=await upload(s);expect(r.body.status).not.toBe(200);expect((await service().getImage(f.actor(),r.key)).receipt?.state).toBe('reserved');expect(await f.facts()).toMatchObject({attachments:0});expect(f.remove).not.toHaveBeenCalled();
    if(change==='role')await f.maintenanceDb.update(storeService).set({customer:1}).where(eq(storeService.uid,101));
    else if(change==='product')await f.maintenanceDb.update(storeProduct).set({isVerify:1}).where(eq(storeProduct.id,70));
    else if(change==='sku')await f.maintenanceDb.update(storeProductAttrValue).set({isRetired:0}).where(eq(storeProductAttrValue.id,1));
    expect((await upload(s,r.key)).body.status).toBe(200);
  });
  it('rejects external ordinary and other-session attachment references without a business write',async()=>{
    const s=await session(),other=await session({buyer_uid:0,tourist_key:'different-guest'}),u=await upload(other);
    const [ordinary]=await f.maintenanceDb.insert(systemAttachment).values({type:3,relationId:101,moduleType:3,imageType:8,name:'attachments/user/101/2026/10/private.png',attDir:'/api/assets/999',sattDir:'/api/assets/999'}).returning({id:systemAttachment.attId});
    for(const ref of ['https://example.invalid/private.png',`/api/assets/${ordinary.id}`,u.body.data.receipt.reference]){
      const r=await http('/drafts',{...s.intent,custom_form:answers(ref)},s.key);expect(r.body.status,r.body.msg).not.toBe(200);}
    expect(await f.facts()).toMatchObject({carts:0,orders:0,origins:0});expect((await service().getSession(f.actor(),s.key)).receipt?.state).toBe('active');
  });
  it('keeps canonical original answers across harmless form labels and a fresh quote',async()=>{
    const s=await session(),u=await upload(s),p=await prepared(s,u.body.data.receipt.reference),old=await quoted(p);
    await f.maintenanceDb.update(systemForm).set({name:'重新命名',value:JSON.stringify(cashierImageTemplate.map(c=>({...c,titleConfig:{value:'更新显示名称'}})))}).where(eq(systemForm.id,77));
    const rejected=await http('/orders',{intent:p.intent,quote_token:old.quote_token},s.key);expect(rejected.body.status).not.toBe(200);expect(await f.facts()).toMatchObject({orders:0,collections:0,attachments:1});
    const c=await created(p),detail=await new CustomerWorkCashierReadService(f.container,f.env).record(f.actor(),c.receipt.order_id,{order_no:c.orderId});
    expect(detail.data.form?.components[1]).toMatchObject({titleConfig:{value:'更新显示名称'},value:[u.body.data.receipt.reference]});expect(f.put).toHaveBeenCalledTimes(1);
  });
  it('rolls back actual order collection rejection while preserving original frozen uploads',async()=>{
    const s=await session(),u=await upload(s),p=await prepared(s,u.body.data.receipt.reference),q=await quoted(p);
    await f.exec(`REVOKE INSERT ON public.system_form_data FROM "${f.role}"`);
    try{const r=await http('/orders',{intent:p.intent,quote_token:q.quote_token},s.key);expect(r.body.status).not.toBe(200);expect(await f.facts()).toMatchObject({orders:0,collections:0,origins:0,attachments:1});expect((await service().getSession(f.actor(),s.key)).receipt?.state).toBe('frozen');}
    finally{await f.exec(`GRANT INSERT ON public.system_form_data TO "${f.role}"`);}
    expect((await created(p)).receipt.order_id).toBeGreaterThan(0);
  });
  it('rejects fixed expiry after the actual final session consumption UPDATE wait with complete rollback',async()=>{
    const [initial]=await f.maintenanceDb.execute<{now:number}>(sql`SELECT floor(extract(epoch from clock_timestamp()))::integer AS now`),expiresAt=initial.now+4;
    await f.maintenanceDb.update(storeProductAttrValue).set({writeValid:3,writeStart:initial.now-100,writeEnd:expiresAt}).where(eq(storeProductAttrValue.id,1));
    const s=await session({buyer_uid:0,tourist_key:'guest-final-form-expiry'}),u=await upload(s),p=await prepared(s,u.body.data.receipt.reference),q=await quoted(p),before=await f.facts();
    const stock=async()=>f.maintenanceDb.execute(sql`SELECT 'product' AS kind,stock,sales FROM store_product WHERE id=70 UNION ALL SELECT 'sku',stock,sales FROM store_product_attr_value WHERE id=1 ORDER BY kind`),beforeStock=await stock();
    let pending:Promise<Awaited<ReturnType<typeof http>>>|undefined,result:Awaited<ReturnType<typeof http>>|undefined,
      observed:{pid:number;clock:number;queryStarted:number}|undefined,blockerPid=0,releaseClock=0;
    try{await f.withPeer(async(observer,observerPid)=>f.maintenanceDb.transaction(async holder=>{
      const [identity]=await holder.execute<{pid:number}>(sql`SELECT pg_backend_pid() AS pid`);blockerPid=identity.pid;
      await holder.execute(sql`LOCK TABLE public.cashier_second_card_form_session_v1 IN SHARE MODE`);
      const readyDeadline=Date.now()+5000;
      while(Date.now()<readyDeadline){const [clock]=await observer.execute<{now:number}>(sql`SELECT extract(epoch from clock_timestamp())::double precision AS now`);
        if(expiresAt-clock.now<=1.35){expect(clock.now).toBeLessThan(expiresAt);break;}await new Promise(resolve=>setTimeout(resolve,15));}
      pending=http('/orders',{intent:p.intent,quote_token:q.quote_token},s.key);
      const waitDeadline=Date.now()+1200;
      while(Date.now()<waitDeadline){const [state]=await observer.execute<{pid:number;clock:number;queryStarted:number}>(sql`SELECT a.pid,extract(epoch from clock_timestamp())::double precision AS clock,extract(epoch from a.query_start)::double precision AS "queryStarted" FROM pg_stat_activity a
        WHERE a.usename=${f.role} AND a.pid<>${observerPid} AND ${blockerPid}=ANY(pg_blocking_pids(a.pid)) AND a.wait_event_type='Lock' AND a.query LIKE '%UPDATE public.cashier_second_card_form_session_v1%' LIMIT 1`);
        if(state){observed=state;break;}await new Promise(resolve=>setTimeout(resolve,10));}
      expect(observed).toBeDefined();expect(observed!.queryStarted).toBeLessThan(expiresAt);
      while(true){const [clock]=await observer.execute<{now:number}>(sql`SELECT extract(epoch from clock_timestamp())::double precision AS now`);
        if(clock.now>=expiresAt+0.025){releaseClock=clock.now;break;}await new Promise(resolve=>setTimeout(resolve,10));}
    }));}finally{if(pending)result=await pending;}
    console.log('CASHIER_FORM_FINAL_EXPIRY_WAIT '+JSON.stringify({expires_at:expiresAt,blocking_pid:blockerPid,creation_pid:observed!.pid,blocked_clock:observed!.queryStarted,observed_clock:observed!.clock,released_clock:releaseClock,observed_wait_ms:Math.round((releaseClock-observed!.queryStarted)*1000)}));
    expect(releaseClock-observed!.queryStarted).toBeLessThan(1.45);expect(JSON.stringify(result!.body)).toContain('ORDER_QUOTE_RECONFIRM_REQUIRED');expect(result!.body.msg).not.toMatch(/lock timeout|55P03/);
    expect(await f.facts()).toEqual(before);expect(await stock()).toEqual(beforeStock);expect((await service().getSession(f.actor(),s.key)).receipt?.state).toBe('frozen');
    await f.maintenanceDb.update(storeProductAttrValue).set({writeEnd:expiresAt+3600}).where(eq(storeProductAttrValue.id,1));expect((await created(p)).receipt.order_id).toBeGreaterThan(0);
  },20000);
  it('reads original canonical form after carts and quote KV disappear and root retires',async()=>{
    const s=await session(),u=await upload(s),c=await created(await prepared(s,u.body.data.receipt.reference));
    await f.maintenanceDb.update(storeOrder).set({pid:-1,isDel:1}).where(eq(storeOrder.id,c.receipt.order_id));
    const detail=await new CustomerWorkCashierReadService(f.container,f.env).record(f.actor(),c.receipt.order_id,{order_no:c.orderId});expect(detail.data.record.root_retired).toBe(true);expect(detail.data.form?.session_key).toBe(s.key);
    const refreshed=await service().previews(f.actor(),s.key,{references:[u.body.data.receipt.reference]});expect(refreshed.previews[0].reference).toBe(u.body.data.receipt.reference);
  });
  it('rejects actual order or collection tampering during receipt and form recovery',async()=>{
    const s=await session(),u=await upload(s),c=await created(await prepared(s,u.body.data.receipt.reference));
    await f.maintenanceDb.update(storeOrder).set({customForm:'[]'}).where(eq(storeOrder.id,c.receipt.order_id));expect((await http(`/creations/${s.key}`)).body.status).not.toBe(200);
    const [proof]=await f.maintenanceDb.execute<{snapshot_json:string}>(sql`SELECT snapshot_json FROM cashier_second_card_form_session_v1 WHERE actor_uid=101 AND request_key=${s.key}::uuid`);
    await f.maintenanceDb.update(storeOrder).set({customForm:proof.snapshot_json}).where(eq(storeOrder.id,c.receipt.order_id));await f.maintenanceDb.update(systemFormData).set({value:'[]'}).where(eq(systemFormData.relationId,c.receipt.order_id));
    expect((await http(`/records/${c.receipt.order_id}?order_no=${c.orderId}`)).body.status).not.toBe(200);
  });
  it('keeps Admin/User numeric collision out of cashier private form and generic signing',async()=>{
    const s=await session(),u=await upload(s),c=await created(await prepared(s,u.body.data.receipt.reference)),actual=await f.actual(c.receipt.order_id);
    await expect(new AdminAssistedOrderService(f.container,f.env).orderForm(101,11,c.orderId)).rejects.toThrow('不存在');
    const form=await readOrderSystemFormForOrder(f.db,new AttachmentService(f.container,f.env),actual.order);expect(form[1].value).toEqual([]);expect(form[1]).not.toHaveProperty('cashierImageScope');
    expect(isAttachmentObjectCleanupMessage({action:'deleteAttachmentObjects',keys:[f.put.mock.calls[0][0]]})).toBe(true);expect(isAttachmentObjectCleanupMessage({action:'deleteAttachmentObjects',keys:['attachments/cc/../../private.png']})).toBe(false);
  });
  it('fails closed when a consumed attachment is removed or original owner login is invalid',async()=>{
    const s=await session(),u=await upload(s),c=await created(await prepared(s,u.body.data.receipt.reference));
    await f.maintenanceDb.delete(systemAttachment).where(eq(systemAttachment.attId,u.body.data.receipt.attachment_id));expect((await http(`/creations/${s.key}`)).body.status).not.toBe(200);
    await f.maintenanceDb.update(user).set({status:0}).where(eq(user.uid,101));expect((await http(`/form-sessions/${s.key}`)).body.status).not.toBe(200);expect((await http(`/records/${c.receipt.order_id}?order_no=${c.orderId}`)).body.status).not.toBe(200);
  });
});
