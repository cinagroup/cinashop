import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { asc, eq, sql } from 'drizzle-orm';
import * as di from '../src/lib/di';
import type { DbClient } from '../src/lib/di';
import { storeOrderCartInfo, storeOrderOutbox, storeOrderRefund, storeProduct, storeProductAttrValue,
  storeService, systemAttachment, systemFormData, user } from '../src/models/schema';
import { OrderOutboxService } from '../src/services/order/OrderOutboxService';
import { CASHIER_FORM_IMAGE_VERSION, CASHIER_FORM_SESSION_VERSION } from '../src/services/customer-work/CustomerCashierFormImages';
import { CUSTOMER_FINANCIAL_VERSION, CUSTOMER_FINANCIAL_QUOTE_VERSION } from '../src/services/customer-work/CustomerWorkFinancialProtocol';
import { CustomerWorkReadService } from '../src/services/customer-work/CustomerWorkReadService';
import { customerCashierRuntimeHttpFixture, cashierHttpImage, cashierHttpImageSha, type CashierHttpForm } from './helpers/customerCashierRuntimeHttpFixture';

const base='/mobile/work/cashier/second-card';
/** Genuine production routes/auth/factory and full independent PG16 LOGINs.
 * The matrix requires original producer facts, actual queued App consumption
 * and fixed Financial settlement, including a real private object read. */
describe.skipIf(!process.env.TEST_FINANCE_POSTGRES_URL)('complete second-card HTTP domain on independent full Cashier PG16', {timeout:30000},()=>{
  let f:Awaited<ReturnType<typeof customerCashierRuntimeHttpFixture>>,external:ReturnType<typeof vi.spyOn>;
  beforeAll(async()=>{f=await customerCashierRuntimeHttpFixture();},180000);
  beforeEach(async()=>{external=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('No provider HTTP in local cashier acceptance'));await f.reset();});
  afterEach(()=>{try{expect(external).not.toHaveBeenCalled();}finally{vi.restoreAllMocks();vi.useRealTimers();}});
  afterAll(async()=>{await f?.close();},30000);
  async function ok(path:string,body?:unknown,key?:string,uid=101){
    const r=await f.request(path,body,key,uid);expect(r.body.status,r.body.msg).toBe(200);return r.body.data;
  }
  async function selected(buyer=11){
    const catalog=await ok(base+'/catalog'),selection=await ok(base+'/catalog/70');
    expect(catalog.data.list).toMatchObject([{id:70,product_type:4}]);expect(selection.data.readiness).toEqual({writes:true,reason:''});
    const key=randomUUID(),intent={version:'customer-cashier-second-card-v1',scope_key:selection.scope_key,
      buyer_uid:buyer,tourist_key:buyer?'':'http-original-guest',product_id:70,sku_unique:'qared001',quantity:2,
      real_name:buyer?'HTTP 原购买人':'HTTP 原游客',user_phone:'00000000000',mark:'',custom_form:[] as unknown[],coupon_id:0,use_integral:false};
    return{key,intent,selection};
  }
  async function imageSession(s:Awaited<ReturnType<typeof selected>>){
    const i=s.intent,body={version:CASHIER_FORM_SESSION_VERSION,scope_key:i.scope_key,buyer_uid:i.buyer_uid,tourist_key:i.tourist_key,
      product_id:i.product_id,sku_unique:i.sku_unique,quantity:i.quantity};
    const created=await ok(base+'/form-sessions',body,s.key);
    expect((await ok(base+'/form-sessions/'+s.key)).receipt).toEqual(created.receipt);return{...s,sessionBody:body};
  }
  async function upload(s:Awaited<ReturnType<typeof imageSession>>,key=randomUUID(),patch:Record<string,unknown>={}){
    const form=new FormData();form.append('file',new File([cashierHttpImage],'owned.png',{type:'image/png'}));
    form.append('metadata',JSON.stringify({version:CASHIER_FORM_IMAGE_VERSION,scope_key:s.intent.scope_key,session_key:s.key,
      field_id:'id:"photo"',sha256:cashierHttpImageSha,size:cashierHttpImage.length,...patch}));
    const encoded=new Response(form),body=await encoded.arrayBuffer();
    const response=await f.raw(base+'/form-sessions/'+s.key+'/images',{method:'POST',body,headers:{Authorization:'Bearer '+await f.bearer(),
      'Content-Type':encoded.headers.get('Content-Type')!,'Content-Length':String(body.byteLength),'Idempotency-Key':key}});
    return{key,response,body:await response.json() as {status:number;msg:string;data:any}};
  }
  async function prepare(buyer=11,form:CashierHttpForm='none'){
    const s=await selected(buyer);let image:any=null;
    if(form==='image'){
      const session=await imageSession(s),posted=await upload(session);expect(posted.body.status,posted.body.msg).toBe(200);image=posted.body.data.receipt;
      expect(image).toMatchObject({actor_uid:101,sha256:cashierHttpImageSha,size:cashierHttpImage.length,state:'stored'});
      expect((await ok(base+'/form-images/'+posted.key)).receipt).toEqual(image);
      const previews=await ok(base+'/form-sessions/'+s.key+'/previews',{references:[image.reference]});
      const url=previews.previews[0].url;expect(url).toMatch(/^\/api\/assets\/[1-9]\d*\?expires=\d+&signature=/);
      const download=await f.raw(url.slice(4));expect(download.status).toBe(200);expect(new Uint8Array(await download.arrayBuffer())).toEqual(cashierHttpImage);
      s.intent.custom_form=[{id:'name',name:'texts',value:'HTTP 原购买人'},{id:'photo',name:'uploadPicture',value:[image.reference],cashierImageScope:{actor_uid:999}}];
    }else if(form==='text')s.intent.custom_form=[{id:'name',name:'texts',value:'HTTP 原购买人'}];
    const draft=await ok(base+'/drafts',s.intent,s.key),quote=await ok(base+'/quote',{request_key:s.key,intent:s.intent});
    expect(quote.quote.items.map((x:{cartId:number})=>x.cartId)).toEqual([draft.cart_id]);
    return{...s,draft,quote,image};
  }
  async function created(s:Awaited<ReturnType<typeof prepare>>){
    const body={intent:s.intent,quote_token:s.quote.quote_token},data=await ok(base+'/orders',body,s.key);
    const receipt=(await ok(base+'/creations/'+s.key)).receipt;expect(receipt).toEqual(data.receipt);
    return{...s,createBody:body,created:data,order:await f.order(data.receipt.order_id)};
  }
  async function cash(s:Awaited<ReturnType<typeof created>>,key=randomUUID()){
    const body={version:'customer-cashier-second-card-payment-v1',scope_key:s.intent.scope_key,
      order_id:s.order.id,order_no:s.order.orderId,expected_amount:s.order.payPrice};
    const data=await ok(base+'/orders/'+s.order.id+'/cash',body,key);
    expect((await ok(base+'/payments/'+key)).receipt.evidence).toEqual(data.evidence);
    return{...s,paymentKey:key,paymentBody:body,payment:data};
  }
  async function financialInput(id:number,payload:Record<string,unknown>){
    const order=await f.order(id),read=await ok('/mobile/work/financial/orders/'+id+'?order_no='+encodeURIComponent(order.orderId));
    return{version:CUSTOMER_FINANCIAL_VERSION,scope_key:read.scope_key,order_id:id,
      expected_order_revision:read.data.order_revision,expected_financial_revision:read.data.financial_revision,payload};
  }
  async function refund(id:number){
    const first=await financialInput(id,{}),quoted=await ok('/mobile/work/financial/refund-quote',{
      version:CUSTOMER_FINANCIAL_QUOTE_VERSION,scope_key:first.scope_key,order_id:id,
      expected_order_revision:first.expected_order_revision,expected_financial_revision:first.expected_financial_revision,mode:'remaining',items:[]});
    const quote=quoted.data,creationBody=await financialInput(id,{mode:'remaining',items:[],quoted_price:quote.quoted_price,
      refund_price:quote.quoted_price,quote_fingerprint:quote.quote_fingerprint,reason:'HTTP 原收银付款退款'}),creationKey=randomUUID();
    const creation=await ok('/mobile/work/financial/refund-create',creationBody,creationKey),refundId=Number(creation.receipt.evidence.refund_id);
    const row=(await f.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.id,refundId)))[0];
    const review=(await ok('/mobile/work/financial/refunds/'+refundId+'?refund_no='+encodeURIComponent(row.orderId))).data;
    const executionBody=await financialInput(review.order_id,{refund_id:refundId,refund_no:review.refund_no,
      expected_refund_revision:review.refund_revision,review_fingerprint:review.review_fingerprint,refund_price:review.refund_price,
      decision:{apply_type:review.apply_type,refund_type:review.refund_type,received:false,...(review.refund_settlement==='cash'?{cash_returned:true}:{})}});
    const executionKey=randomUUID(),execution=await ok('/mobile/work/financial/refund-execute',executionBody,executionKey);
    return{creationKey,creationBody,creation,executionKey,executionBody,execution,refundId};
  }
  const matrix=[11,0].flatMap(buyer=>['7.00','0.00'].flatMap(price=>(['none','text','image'] as const).map(form=>({buyer,price,form}))));
  it.each(matrix)('real18-route Cashier→App queue consumer→Financial refund buyer=$buyer price=$price form=$form',async({buyer,price,form})=>{
    await f.reset(price,form);
    const accounts=await f.db.select().from(user).orderBy(asc(user.uid)),s=await cash(await created(await prepare(buyer,form)));
    expect(s.order).toMatchObject({uid:buyer,paid:0,staffId:101,payType:''});
    expect(s.payment.evidence).toMatchObject({buyer_uid:buyer,creator_uid:101,amount:s.order.payPrice,paid:1});
    const before=(await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,s.order.id)))[0];
    expect(before).toMatchObject({uid:buyer,cartNum:2,writeTimes:6,writeSurplusTimes:6,writeStart:0,writeEnd:0});
    const message=f.messages.find((x:any)=>x.action==='processOrderPaidOutbox'&&x.outboxId===s.payment.outbox.id) as Parameters<OrderOutboxService['processMessage']>[0];
    expect(message).toEqual({action:'processOrderPaidOutbox',outboxId:s.payment.outbox.id,eventKey:s.payment.outbox.eventKey});
    const appConsumer=new OrderOutboxService(di.createContainerFromDb(f.appRuntime.db),f.env);
    expect(await appConsumer.processMessage(message)).toBe('completed');
    const paid=await f.order(s.order.id),cart=(await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,paid.id)))[0];
    expect(paid).toMatchObject({uid:buyer,paid:1,payType:'cash'});
    expect(cart.writeStart).toBe(paid.payTime);expect(cart.writeEnd).toBe(paid.payTime+10*86400);
    const accountsAfterConsumer=await f.db.select().from(user).orderBy(asc(user.uid));
    expect(accountsAfterConsumer.map(x=>[x.uid,x.nowMoney,x.integral])).toEqual(accounts.map(x=>[x.uid,x.nowMoney,x.integral]));
    expect((await f.db.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id,s.payment.outbox.id)))[0].status).toBe('COMPLETED');
    const consumed=await f.facts();expect(await appConsumer.processMessage(message)).toBe('already-completed');expect(await f.facts()).toEqual(consumed);
    expect((await ok(base+'/records')).data.list).toHaveLength(1);
    const detail=await ok(base+'/records/'+paid.id+'?order_no='+encodeURIComponent(paid.orderId));
    if(form!=='none'){
      expect(paid.customForm).toContain('HTTP 原购买人');expect(await f.db.select().from(systemFormData)).toHaveLength(1);
      if(form==='image'){
        expect(detail.data.form.components[1].value).toEqual([s.image.reference]);expect(f.put).toHaveBeenCalledTimes(1);expect(f.remove).not.toHaveBeenCalled();
        expect((await f.db.select().from(systemAttachment))[0]).toMatchObject({type:3,relationId:101,moduleType:6});
        expect((await ok(base+'/form-sessions/'+s.key)).receipt.state).toBe('consumed');
      }
    }
    const done=await refund(paid.id);
    expect(done.execution.execution).toMatchObject({status:price==='0.00'?'ZERO_SUCCESS':'CASH_SUCCESS',completed:true,verified:true});
    const[proof]=await f.db.execute<{source:any;buyer_uid:number;amount:string}>(sql`SELECT source,buyer_uid,amount::text FROM customer_financial_manual_refund_v1 WHERE refund_id=${done.refundId}`);
    const[origin]=await f.db.execute<{origin_hash:string}>(sql`SELECT origin_hash FROM cashier_second_card_origin_v1 WHERE order_id=${paid.id}`);
    expect(proof).toMatchObject({buyer_uid:buyer,amount:paid.payPrice});expect(proof.source.payment.origin_hash).toBe(origin.origin_hash);
    expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id,70)))[0].stock).toBe(10);
    expect((await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id,1)))[0].stock).toBe(10);
    expect(await f.db.select().from(user).orderBy(asc(user.uid))).toEqual(accountsAfterConsumer);expect(accounts.some(x=>x.uid===0)).toBe(false);
    const committed=await f.facts();
    const currentReceipt=(await ok(base+'/creations/'+s.key)).receipt;
    const{order:originalProjection,...originalImmutable}=s.created.receipt;
    const{order:currentProjection,...currentImmutable}=currentReceipt;
    expect(currentImmutable).toEqual(originalImmutable);expect(currentProjection.id).toBe(originalProjection.id);
    expect((await ok(base+'/orders',s.createBody,s.key)).receipt).toEqual(currentReceipt);
    expect((await ok(base+'/orders/'+paid.id+'/cash',s.paymentBody,s.paymentKey)).replayed).toBe(true);
    expect((await ok('/mobile/work/financial/refund-create',done.creationBody,done.creationKey)).receipt).toEqual(done.creation.receipt);
    expect((await ok('/mobile/work/financial/refund-execute',done.executionBody,done.executionKey)).receipt).toEqual(done.execution.receipt);
    expect(await f.facts()).toEqual(committed);
  });

  it('keeps App source-only, all five full profiles ready and actual request session independently authenticated',async()=>{
    const session=await di.createCustomerCashierDatabaseSession(f.env);
    try{
      const[row]=await session.container.db.execute(sql`SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid,
        (SELECT usesysid::text FROM pg_stat_activity WHERE pid=pg_backend_pid()) AS oid`);
      expect(row).toMatchObject({role:f.cashierRuntime.role,session:f.cashierRuntime.role,oid:f.commissioned.binding.roleOid});
      expect(row.pid).not.toBe(await f.appRuntime.verify());expect(row.pid).not.toBe(await f.financialRuntime.verify());
    }finally{await session.close();await session.close();}
    const[app]=await f.appRuntime.db.execute(sql`SELECT has_table_privilege(current_user,'cashier_second_card_origin_v1','SELECT') AS origin,
      has_table_privilege(current_user,'cashier_second_card_cart_v1','SELECT,INSERT') AS carts,
      has_table_privilege(current_user,'cashier_second_card_payment_v1','SELECT,INSERT') AS payments,
      has_table_privilege(current_user,'cashier_second_card_form_session_v1','SELECT,INSERT') AS forms`);
    expect(app).toEqual({origin:true,carts:false,payments:false,forms:false});
    const[city]=await f.appRuntime.db.execute(sql`SELECT has_table_privilege(current_user,'customer_city_delivery_job','SELECT') AS jobs,
      has_table_privilege(current_user,'customer_city_delivery_attempt','SELECT') AS attempts,
      has_table_privilege(current_user,'customer_city_delivery_binding','SELECT') AS bindings`);
    expect(city).toEqual({jobs:false,attempts:false,bindings:false});
    let denied=false;try{await f.appRuntime.db.execute(sql`SELECT count(*) FROM public.customer_city_delivery_job`);}
    catch(error){denied=true;const chain=[];for(let cause:unknown=error;cause&&typeof cause==='object';cause='cause'in cause?cause.cause:undefined)
      if('code'in cause)chain.push(cause.code);expect(chain).toContain('42501');}expect(denied).toBe(true);
    const context=await ok('/mobile/work/context');expect(context.data.capabilities.cashier_second_card).toBe(false);
    expect(f.commissioned.audit.ready).toBe(true);expect(f.commissioned.completeServiceCoverageVerified).toBe(false);
  });
  it('retains App context with only partial city SELECT and includes actual city facts on the separately authorized Financial reader',async()=>{
    const first=await ok('/mobile/work/context'),principal='"'+f.appRuntime.role+'"';
    await f.exec('GRANT SELECT ON public.customer_city_delivery_job TO '+principal);
    try{
      const partial=await ok('/mobile/work/context');expect(partial.consistency_key).toBe(first.consistency_key);
      expect(partial.data.capabilities.cashier_second_card).toBe(false);
    }finally{await f.exec('REVOKE SELECT ON public.customer_city_delivery_job FROM '+principal);}
    const full=await new CustomerWorkReadService(di.createContainerFromDb(f.financialRuntime.db),f.env).context(f.actor());
    expect(full.scope_key).toBe(first.scope_key);expect(full.consistency_key).not.toBe(first.consistency_key);
    const[allowed]=await f.financialRuntime.db.execute(sql`SELECT has_table_privilege(current_user,'customer_city_delivery_job','SELECT')
      AND has_table_privilege(current_user,'customer_city_delivery_attempt','SELECT')
      AND has_table_privilege(current_user,'customer_city_delivery_binding','SELECT') AS ready`);expect(allowed.ready).toBe(true);
  });
  it.each(['App DSN','role OID','database OID','missing binding'] as const)('fails closed on actual factory $0 without business effects',async(kind)=>{
    const env={...f.env,CUSTOMER_CASHIER_RUNTIME_IDENTITY:{...f.commissioned.binding}};
    if(kind==='App DSN'){
      const wrong=new URL(f.appRuntime.connectionString);wrong.searchParams.set('application_name','cashier_wrong_login_probe');
      env.HYPERDRIVE_CUSTOMER_CASHIER={connectionString:wrong.href} as typeof env.HYPERDRIVE_CUSTOMER_CASHIER;
    }
    if(kind==='role OID')env.CUSTOMER_CASHIER_RUNTIME_IDENTITY.roleOid=String(BigInt(f.commissioned.binding.roleOid)+1n);
    if(kind==='database OID')env.CUSTOMER_CASHIER_RUNTIME_IDENTITY.databaseOid=String(BigInt(f.commissioned.binding.databaseOid)+1n);
    if(kind==='missing binding')delete env.HYPERDRIVE_CUSTOMER_CASHIER;
    const before=await f.facts(),r=await f.request(base+'/catalog',undefined,undefined,101,env);expect(r.body.status).toBe(503);expect(await f.facts()).toEqual(before);
  });
  it('retains original owner receipts and replay after qualification loss while blocking new writes and other owners',async()=>{
    const s=await cash(await created(await prepare(0))),before=await f.facts();
    expect((await ok(base+'/creations/'+s.key,undefined,undefined,102)).receipt).toBeNull();
    expect((await ok(base+'/payments/'+s.paymentKey,undefined,undefined,102)).receipt).toBeNull();
    await f.maintenanceDb.update(storeService).set({customer:0}).where(eq(storeService.uid,101));
    expect((await ok(base+'/creations/'+s.key)).receipt.order_id).toBe(s.order.id);
    expect((await ok(base+'/payments/'+s.paymentKey)).receipt.evidence).toEqual(s.payment.evidence);
    expect((await ok(base+'/orders/'+s.order.id+'/cash',s.paymentBody,s.paymentKey)).replayed).toBe(true);
    expect((await f.request(base+'/catalog')).body.status).not.toBe(200);
    expect((await f.request(base+'/orders/'+s.order.id+'/cash',s.paymentBody,randomUUID())).body.status).not.toBe(200);
    expect(await f.facts()).toEqual(before);
    await f.maintenanceDb.update(user).set({pwd:'changed-after-original'}).where(eq(user.uid,101));
    expect((await f.request(base+'/payments/'+s.paymentKey)).body.status).not.toBe(200);
  });
  it('uses real image cancel and both abandonment routes without resuming an abandoned UUID',async()=>{
    await f.reset('7.00','image');const s=await imageSession(await selected()),posted=await upload(s);expect(posted.body.status).toBe(200);
    const cancelled=await ok(base+'/form-sessions/'+s.key+'/cancel',{version:CASHIER_FORM_SESSION_VERSION,scope_key:s.intent.scope_key},s.key);
    expect(cancelled.receipt.state).toBe('cancelled');expect((await upload(s)).body.status).not.toBe(200);
    const first=await selected(),abandoned=await ok(base+'/creations/'+first.key+'/abandon',{
      version:'customer-cashier-abandon-v1',kind:'creation',intent:first.intent},first.key);
    expect(abandoned.abandonment).not.toBeNull();expect((await f.request(base+'/drafts',first.intent,first.key)).body.status).not.toBe(200);
    await f.reset();const order=await created(await prepare()),paymentKey=randomUUID(),paymentIntent={version:'customer-cashier-second-card-payment-v1',
      scope_key:order.intent.scope_key,order_id:order.order.id,order_no:order.order.orderId,expected_amount:order.order.payPrice};
    const payment=await ok(base+'/payments/'+paymentKey+'/abandon',{version:'customer-cashier-abandon-v1',kind:'payment',intent:paymentIntent},paymentKey);
    expect(payment.abandonment).not.toBeNull();expect((await f.request(base+'/orders/'+order.order.id+'/cash',paymentIntent,paymentKey)).body.status).not.toBe(200);
    expect((await f.order(order.order.id)).paid).toBe(0);
  });
  it('denies tampered private signatures before object reads and refuses metadata hash mismatch before put',async()=>{
    await f.reset('7.00','image');const s=await imageSession(await selected()),bad=await upload(s,randomUUID(),{sha256:'a'.repeat(64)});
    expect(bad.body.status).not.toBe(200);expect(f.put).not.toHaveBeenCalled();const good=await upload(s);expect(good.body.status).toBe(200);
    const previews=await ok(base+'/form-sessions/'+s.key+'/previews',{references:[good.body.data.receipt.reference]});
    f.get.mockClear();const url=previews.previews[0].url as string;
    const tampered=await f.raw(url.slice(4)+'x');expect(tampered.status).not.toBe(200);expect(f.get).not.toHaveBeenCalled();
    const bare=await f.raw(good.body.data.receipt.reference.slice(4));expect(bare.status).not.toBe(200);expect(f.get).not.toHaveBeenCalled();
  });

  function loseCommittedReply(kind:'creation'|'payment'|'upload',key:string){
    const original=di.createCustomerCashierDatabaseSession;let lost=false;
    const hook=vi.spyOn(di,'createCustomerCashierDatabaseSession').mockImplementation(async env=>{
      const session=await original(env),wrapped=new Proxy(session.container.db,{get(target,name,receiver){
        const value=Reflect.get(target,name,receiver);if(typeof value!=='function')return value;if(name!=='transaction')return value.bind(target);
        return async(...args:unknown[])=>{
          const result=await Reflect.apply(value,target,args);
          const query=kind==='creation'?sql`SELECT EXISTS(SELECT 1 FROM cashier_second_card_origin_v1 WHERE actor_uid=101 AND request_key=${key}::uuid) AS ready`
            :kind==='payment'?sql`SELECT EXISTS(SELECT 1 FROM cashier_second_card_payment_v1 WHERE actor_uid=101 AND request_key=${key}::uuid) AS ready`
            :sql`SELECT EXISTS(SELECT 1 FROM cashier_second_card_form_upload_v1 WHERE actor_uid=101 AND request_key=${key}::uuid AND state='stored') AS ready`;
          const[row]=await f.maintenanceDb.execute<{ready:boolean}>(query);
          if(!lost&&row.ready){lost=true;throw Object.assign(Error('Independently observed actual COMMIT reply loss'),{code:'40003'});}return result;
        };
      }});
      return{...session,container:di.createContainerFromDb(wrapped as DbClient)};
    });
    return{hook,occurred:()=>lost};
  }
  it.each(['creation','payment','upload'] as const)('recovers $0 after independently observed real COMMIT response loss through production routes',async(kind)=>{
    if(kind==='upload'){
      await f.reset('7.00','image');const s=await imageSession(await selected()),key=randomUUID(),fault=loseCommittedReply(kind,key);
      await upload(s,key);expect(fault.occurred()).toBe(true);fault.hook.mockRestore();
      const original=await ok(base+'/form-images/'+key);expect(original.receipt).toMatchObject({state:'stored',sha256:cashierHttpImageSha});
      const replay=await upload(s,key);expect(replay.body.status).toBe(200);expect(replay.body.data).toEqual(original);expect(f.put).toHaveBeenCalledTimes(1);expect(f.remove).not.toHaveBeenCalled();
    }else if(kind==='creation'){
      const s=await prepare(),fault=loseCommittedReply(kind,s.key);await f.request(base+'/orders',{intent:s.intent,quote_token:s.quote.quote_token},s.key);
      expect(fault.occurred()).toBe(true);fault.hook.mockRestore();const original=await ok(base+'/creations/'+s.key),before=await f.facts();
      expect((await ok(base+'/orders',{intent:s.intent,quote_token:s.quote.quote_token},s.key)).receipt).toEqual(original.receipt);expect(await f.facts()).toEqual(before);
    }else{
      const s=await created(await prepare()),key=randomUUID(),body={version:'customer-cashier-second-card-payment-v1',scope_key:s.intent.scope_key,
        order_id:s.order.id,order_no:s.order.orderId,expected_amount:s.order.payPrice},fault=loseCommittedReply(kind,key);
      await f.request(base+'/orders/'+s.order.id+'/cash',body,key);expect(fault.occurred()).toBe(true);fault.hook.mockRestore();
      const original=await ok(base+'/payments/'+key),before=await f.facts(),replay=await ok(base+'/orders/'+s.order.id+'/cash',body,key);
      expect(replay.evidence).toEqual(original.receipt.evidence);expect(replay.replayed).toBe(true);expect(await f.facts()).toEqual(before);
    }
  });
});
