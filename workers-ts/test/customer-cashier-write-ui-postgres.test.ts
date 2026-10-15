import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppVariables, Env } from '../src/env';
import { createContainerFromDb, type DbClient } from '../src/lib/di';
import { authMiddleware } from '../src/middleware/auth';
import { errorHandler } from '../src/middleware/error';
import { createToken, md5 } from '../src/utils/jwt';
import { storeCart, storeOrder, storeOrderCartInfo, storeOrderOutbox, storeProduct, storeProductAttrValue, storeService, systemForm, systemFormData } from '../src/models/schema';
import * as controller from '../src/controllers/api/v1/CustomerWorkCashierController';
import { CustomerWorkCashierCatalog } from '../src/services/customer-work/CustomerWorkCashierCatalog';
import { CustomerWorkReadService } from '../src/services/customer-work/CustomerWorkReadService';
import { customerCashierSecondCardFixture } from './helpers/customerCashierSecondCardFixture';
import { observeIntegralReadDb } from './helpers/integralProductReadFixture';

/** Actual UserJWT controller pipeline on the existing independently logged-in
 * PostgreSQL16 cashier fixture. Maintenance only installs/seeds test authority. */
describe('ordinary customer integrated cashier write UI PG16 contract',()=>{
  let f:Awaited<ReturnType<typeof customerCashierSecondCardFixture>>,serial=0;
  beforeAll(async()=>{f=await customerCashierSecondCardFixture([systemForm,systemFormData]);
    f.env.SEQUENCE={idFromName:()=>({}),get:()=>({fetch:async()=>new Response(`UI-CASHIER-${Date.now()}-${++serial}`)})} as unknown as Env['SEQUENCE'];
  },180000);
  beforeEach(async()=>{await f.reset();await f.maintenanceDb.update(storeProduct).set({systemFormId:0}).where(eq(storeProduct.id,70));});
  afterAll(async()=>{await f?.close();},30000);
  const catalog=(db:DbClient=f.db)=>new CustomerWorkCashierCatalog(createContainerFromDb(db),f.env);
  function app(db:DbClient=f.db){const h=new Hono<{Bindings:Env;Variables:AppVariables}>();
    h.use('*',async(c,next)=>{c.set('container',createContainerFromDb(db));await next();});h.use('*',authMiddleware({force:true}));h.onError(errorHandler);
    h.get('/catalog',controller.cashierCatalog);h.get('/catalog/:id',controller.cashierSelection);
    h.post('/drafts',controller.cashierDraft);h.post('/quote',controller.cashierQuote);h.post('/orders',controller.cashierCreate);
    h.post('/orders/:id/cash',controller.cashierCash);h.get('/creations/:key',controller.cashierCreationStatus);h.get('/payments/:key',controller.cashierPaymentStatus);return h;}
  async function http(path:string,body?:unknown,key?:string,uid=101){const bearer=(await createToken(uid,'api',md5('owned-financial-password'),f.env.APP_KEY)).token;
    const response=await app().request(path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${bearer}`,...(body===undefined?{}:{'Content-Type':'application/json'}),...(key?{'Idempotency-Key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})},f.env);
    return {response,body:await response.json() as {status:number;msg:string;data:any}};}
  async function draft(overrides:Parameters<typeof f.input>[0]={}){const selected=await f.input(overrides),{request_key,...intent}=selected;
    const r=await http('/drafts',intent,request_key);expect(r.body.status).toBe(200);return {request_key,intent,cart_id:r.body.data.cart_id};}
  async function quote(value:Awaited<ReturnType<typeof draft>>){const r=await http('/quote',{request_key:value.request_key,intent:value.intent});expect(r.body.status).toBe(200);
    expect(r.body.data.quote.items.map((v:{cartId:number})=>v.cartId)).toEqual([value.cart_id]);return r.body.data;}
  async function create(value:Awaited<ReturnType<typeof draft>>){const q=await quote(value),r=await http('/orders',{intent:value.intent,quote_token:q.quote_token},value.request_key);
    expect(r.body.status).toBe(200);return r.body.data;}
  const counts=async()=>{const[rows]=await f.maintenanceDb.execute<{data:unknown}>(sql`SELECT jsonb_build_object(
    'orders',(SELECT count(*) FROM store_order),'carts',(SELECT count(*) FROM store_cart),
    'origins',(SELECT count(*) FROM cashier_second_card_origin_v1),'payments',(SELECT count(*) FROM cashier_second_card_payment_v1),
    'outbox',(SELECT count(*) FROM store_order_outbox),'form_data',(SELECT count(*) FROM system_form_data)) AS data`);return rows.data;};
  const template=[{id:'name',name:'texts',titleConfig:{value:'购买人称呼'},titleShow:{val:true},value:''}];
  async function form(value:unknown=template){const id=1000+ ++serial;await f.maintenanceDb.insert(systemForm).values({id,name:'真实次卡表单',value:JSON.stringify(value),status:1,isDel:0});
    await f.maintenanceDb.update(storeProduct).set({systemFormId:id}).where(eq(storeProduct.id,70));return id;}

  it('selects live base type4 SKUs and the actual active canonical form in a read-only catalog',async()=>{
    const id=await form(),before=await counts(),result=await catalog().list(f.actor(),{});
    expect(result).toMatchObject({version:'customer-cashier-catalog-v1',actor_uid:101,data:{readiness:{writes:true,reason:''}}});
    expect(result.data.list).toMatchObject([{id:70,product_type:4,system_form_id:id,sku_count:1}]);
    const selected=await catalog().selection(f.actor(),70,{});
    expect(selected.data.skus).toMatchObject([{sku_unique:'qared001',sku:'红色,大号',price:'7.00',stock:10,write_times:3,write_valid:2,write_days:10}]);
    expect(selected.data.system_form).toMatchObject({id,value:template});expect(await counts()).toEqual(before);
    expect(JSON.stringify(selected)).not.toMatch(/owned-financial-password|vip_price|cost|custom_form|tourist_hash/);
  });
  it('excludes hidden unreviewed presale nonroot and noncard products and retired empty or expired specifications',async()=>{
    for(const patch of [{isShow:0},{isVerify:0},{isPresaleProduct:1},{pid:9},{productType:0},{stock:0}]){
      await f.maintenanceDb.update(storeProduct).set(patch).where(eq(storeProduct.id,70));expect((await catalog().list(f.actor())).data.list).toEqual([]);
      await expect(catalog().selection(f.actor(),70)).rejects.toThrow();
      await f.maintenanceDb.update(storeProduct).set({isShow:1,isVerify:1,isPresaleProduct:0,pid:0,productType:4,stock:10}).where(eq(storeProduct.id,70));
    }
    await f.maintenanceDb.update(storeProduct).set({stock:1}).where(eq(storeProduct.id,70));
    expect((await catalog().selection(f.actor(),70)).data.skus[0].stock).toBe(1);
    for(const patch of [{isRetired:1},{stock:0},{writeTimes:0},{writeValid:3,writeStart:1,writeEnd:2}]){
      await f.maintenanceDb.update(storeProductAttrValue).set(patch).where(eq(storeProductAttrValue.id,1));
      expect((await catalog().list(f.actor())).data.list).toEqual([]);await expect(catalog().selection(f.actor(),70)).rejects.toThrow();
      await f.maintenanceDb.update(storeProductAttrValue).set({isRetired:0,stock:10,writeTimes:3,writeValid:2,writeDays:10,writeStart:0,writeEnd:0}).where(eq(storeProductAttrValue.id,1));
    }
  });
  it('blocks unavailable required image upload and oversized form intents without changing authority',async()=>{
    await form([{id:'photo',name:'uploadPicture',titleShow:{val:true},value:[]}]);
    expect((await catalog().selection(f.actor(),70)).data.readiness).toEqual({writes:false,reason:'cashier_form_upload_scope_unavailable'});
    await form([{...template[0],titleConfig:{value:'x'.repeat(65537)}}]);
    expect((await catalog().selection(f.actor(),70)).data.readiness).toEqual({writes:false,reason:'cashier_form_capacity_exceeded'});
    const id=await form();await f.maintenanceDb.update(systemForm).set({status:0}).where(eq(systemForm.id,id));
    await expect(catalog().selection(f.actor(),70)).rejects.toThrow('表单');
  });
  it('runs actual UserJWT draft quote create and canonical text form writes and recovers the same committed creation',async()=>{
    await form();const value=await draft({custom_form:[{id:'name',name:'texts',value:'真实次卡姓名'}]}),q=await quote(value);
    expect(q.system_form.value).toEqual(template);expect(q.pricing.amount).toBe((q.quote.payCents/100).toFixed(2));
    const first=await http('/orders',{intent:value.intent,quote_token:q.quote_token},value.request_key);expect(first.body.status).toBe(200);
    const receipt=first.body.data.receipt;expect(receipt.order).toMatchObject({id:receipt.order_id,order_no:first.body.data.orderId,buyer_uid:11,creator_uid:101,amount:q.pricing.amount});
    expect((await http(`/creations/${value.request_key}`)).body.data.receipt).toEqual(receipt);
    const before=await counts(),again=await http('/orders',{intent:value.intent,quote_token:q.quote_token},value.request_key);
    expect(again.body.status).toBe(200);expect(again.body.data).toEqual(first.body.data);expect(await counts()).toEqual(before);
    const [saved]=await f.maintenanceDb.select({form:storeOrder.customForm}).from(storeOrder).where(eq(storeOrder.id,receipt.order_id));expect(saved.form).toContain('真实次卡姓名');
  });
  it('runs genuine UID0 zero payment and original UUID recovery after customer role loss without a new effect',async()=>{
    await f.reset('0.00');const value=await draft({buyer_uid:0,tourist_key:'guest-ui-cashier-original'}),created=await create(value),key=randomUUID();
    const intent={version:'customer-cashier-second-card-payment-v1',scope_key:value.intent.scope_key,order_id:created.receipt.order_id,order_no:created.orderId,expected_amount:'0.00'};
    const paid=await http(`/orders/${intent.order_id}/cash`,intent,key);expect(paid.body.status).toBe(200);expect(paid.body.data.evidence).toMatchObject({buyer_uid:0,creator_uid:101,amount:'0.00',paid:1});
    await f.processPaid(paid.body.data.outbox);const before=await counts();await f.maintenanceDb.update(storeService).set({customer:0}).where(eq(storeService.uid,101));
    expect((await http(`/creations/${value.request_key}`)).body.data.receipt.order.order_no).toBe(created.orderId);
    expect((await http(`/payments/${key}`)).body.data.receipt.evidence).toEqual(paid.body.data.evidence);
    expect((await http(`/orders/${intent.order_id}/cash`,intent,key)).body.data.replayed).toBe(true);
    expect((await http(`/orders/${intent.order_id}/cash`,intent,randomUUID())).body.status).not.toBe(200);
    expect(await counts()).toEqual(before);
  });
  it('refuses changed actual root or cart proof during creation UUID recovery',async()=>{
    const value=await draft(),created=await create(value),id=created.receipt.order_id;
    await f.maintenanceDb.update(storeOrder).set({staffId:102}).where(eq(storeOrder.id,id));
    expect((await http(`/creations/${value.request_key}`)).body.status).not.toBe(200);
    await f.maintenanceDb.update(storeOrder).set({staffId:101}).where(eq(storeOrder.id,id));
    await f.maintenanceDb.update(storeOrderCartInfo).set({cartInfo:'{}'}).where(eq(storeOrderCartInfo.oid,id));
    expect((await http(`/creations/${value.request_key}`)).body.status).not.toBe(200);
    expect((await http(`/creations/${value.request_key}`,undefined,undefined,102)).body.data.receipt).toBe(null);
  });
  it('keeps original retired-root payment facts but refuses corrupt actual payment event recovery',async()=>{
    const value=await draft(),created=await create(value),id=created.receipt.order_id,key=randomUUID();
    const paid=await http(`/orders/${id}/cash`,{version:'customer-cashier-second-card-payment-v1',scope_key:value.intent.scope_key,order_id:id,order_no:created.orderId,expected_amount:created.receipt.order.amount},key);
    expect(paid.body.status).toBe(200);await f.processPaid(paid.body.data.outbox);
    await f.maintenanceDb.update(storeOrder).set({pid:-1}).where(eq(storeOrder.id,id));
    expect((await http(`/payments/${key}`)).body.data.receipt.order.root_retired).toBe(true);
    await f.maintenanceDb.update(storeOrderOutbox).set({aggregateId:id+1}).where(eq(storeOrderOutbox.id,paid.body.data.outbox.id));
    expect((await http(`/payments/${key}`)).body.status).not.toBe(200);
  });
  it('binds the displayed active form template to quote and demands reconfirmation on a real definition edit',async()=>{
    const id=await form(),value=await draft({custom_form:[{id:'name',name:'texts',value:'姓名'}]}),q=await quote(value);
    const changed=[{...template[0],titleConfig:{value:'已变更的真实题目'}}];await f.maintenanceDb.update(systemForm).set({value:JSON.stringify(changed)}).where(eq(systemForm.id,id));
    const before=await counts(),stale=await http('/orders',{intent:value.intent,quote_token:q.quote_token},value.request_key);
    expect(stale.body.status).not.toBe(200);expect(JSON.stringify(stale.body)).toContain('ORDER_QUOTE_RECONFIRM_REQUIRED');expect(await counts()).toEqual(before);
    const fresh=await quote(value);expect(fresh.system_form.value).toEqual(changed);
    expect((await http('/orders',{intent:value.intent,quote_token:fresh.quote_token},value.request_key)).body.status).toBe(200);
  });
  it('binds every cashier validity term to the genuine quote before accepting current immutable rights',async()=>{
    for(const changed of ['mode','days','start','end'] as const){
      await f.reset();
      const [clock]=await f.maintenanceDb.execute<{now:number}>(sql`SELECT floor(extract(epoch from clock_timestamp()))::integer AS now`);
      if(changed==='start'||changed==='end')await f.maintenanceDb.update(storeProductAttrValue)
        .set({writeValid:3,writeStart:clock.now-100,writeEnd:clock.now+3600}).where(eq(storeProductAttrValue.id,1));
      const value=await draft(),q=await quote(value);
      const selectedBefore=(await catalog().selection(f.actor(),70)).data.skus[0];
      const patch=changed==='mode'?{writeValid:1}:changed==='days'?{writeDays:20}:
        changed==='start'?{writeStart:clock.now-50}:{writeEnd:clock.now+7200};
      await f.maintenanceDb.update(storeProductAttrValue).set(patch).where(eq(storeProductAttrValue.id,1));
      const before=await counts(),beforeStock=await f.maintenanceDb.select({stock:storeProductAttrValue.stock,sales:storeProductAttrValue.sales})
        .from(storeProductAttrValue).where(eq(storeProductAttrValue.id,1));
      const stale=await http('/orders',{intent:value.intent,quote_token:q.quote_token},value.request_key);
      expect(stale.body.status).not.toBe(200);expect(JSON.stringify(stale.body)).toContain('ORDER_QUOTE_RECONFIRM_REQUIRED');
      expect(await counts()).toEqual(before);
      expect(await f.maintenanceDb.select({stock:storeProductAttrValue.stock,sales:storeProductAttrValue.sales})
        .from(storeProductAttrValue).where(eq(storeProductAttrValue.id,1))).toEqual(beforeStock);
      const fresh=await quote(value);
      const [current]=await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id,1));
      expect(fresh.card).toEqual({product_id:70,sku_unique:'qared001',quantity:2,unit_write_times:3,total_write_times:6,
        write_valid:current.writeValid,write_days:current.writeDays,write_start:current.writeStart,write_end:current.writeEnd});
      expect(fresh.quote.card).toEqual(fresh.card);
      expect([fresh.card.write_valid,fresh.card.write_days,fresh.card.write_start,fresh.card.write_end])
        .not.toEqual([selectedBefore.write_valid,selectedBefore.write_days,selectedBefore.write_start,selectedBefore.write_end]);
      expect((await http('/orders',{intent:value.intent,quote_token:fresh.quote_token},value.request_key)).body.status).toBe(200);
    }
  },30000);
  it('rejects fixed cashier expiry after the actual final origin INSERT wait and rolls back all business writes',async()=>{
    const [initial]=await f.maintenanceDb.execute<{now:number}>(sql`SELECT floor(extract(epoch from clock_timestamp()))::integer AS now`);
    const expiresAt=initial.now+4;
    await f.maintenanceDb.update(storeProductAttrValue).set({writeValid:3,writeStart:initial.now-100,writeEnd:expiresAt})
      .where(eq(storeProductAttrValue.id,1));
    const value=await draft({buyer_uid:0,tourist_key:'guest-final-expiry'}),q=await quote(value),before=await counts();
    const stock=async()=>f.maintenanceDb.execute(sql`SELECT 'product' AS kind,stock,sales FROM store_product WHERE id=70
      UNION ALL SELECT 'sku',stock,sales FROM store_product_attr_value WHERE id=1 ORDER BY kind`);
    const beforeStock=await stock();
    let pending:Promise<Awaited<ReturnType<typeof http>>>|undefined;
    let result:Awaited<ReturnType<typeof http>>|undefined;
    let observed:{pid:number;clock:number;queryStarted:number}|undefined,blockerPid=0,releaseClock=0;
    try{await f.withPeer(async(observer,observerPid)=>f.maintenanceDb.transaction(async holder=>{
      const [holderIdentity]=await holder.execute<{pid:number}>(sql`SELECT pg_backend_pid() AS pid`);blockerPid=holderIdentity.pid;
      // No runtime privilege is expanded: a separate maintenance connection
      // holds the final append table while real UserJWT creation does the work.
      await holder.execute(sql`LOCK TABLE public.cashier_second_card_origin_v1 IN SHARE MODE`);
      const readyDeadline=Date.now()+5000;
      while(Date.now()<readyDeadline){const [now]=await observer.execute<{clock:number}>(sql`SELECT extract(epoch from clock_timestamp())::double precision AS clock`);
        if(expiresAt-now.clock<=1.35){expect(now.clock).toBeLessThan(expiresAt);break;}
        await new Promise(resolve=>setTimeout(resolve,15));}
      pending=http('/orders',{intent:value.intent,quote_token:q.quote_token},value.request_key);
      const waitDeadline=Date.now()+1200;
      while(Date.now()<waitDeadline){const [state]=await observer.execute<{pid:number;clock:number;queryStarted:number}>(sql`SELECT a.pid,
        extract(epoch from clock_timestamp())::double precision AS clock,extract(epoch from a.query_start)::double precision AS "queryStarted" FROM pg_catalog.pg_stat_activity a
        WHERE a.usename=${f.role} AND a.pid<>${observerPid} AND ${blockerPid}=ANY(pg_catalog.pg_blocking_pids(a.pid))
          AND a.wait_event_type='Lock' AND a.query LIKE '%INSERT INTO public.cashier_second_card_origin_v1%' LIMIT 1`);
        if(state){observed=state;break;}await new Promise(resolve=>setTimeout(resolve,10));}
      expect(observed).toBeDefined();expect(observed!.queryStarted).toBeLessThan(expiresAt);
      while(true){const [now]=await observer.execute<{clock:number}>(sql`SELECT extract(epoch from clock_timestamp())::double precision AS clock`);
        if(now.clock>=expiresAt+0.025){releaseClock=now.clock;break;}await new Promise(resolve=>setTimeout(resolve,10));}
    }));}finally{if(pending)result=await pending;}
    console.log('CASHIER_FINAL_EXPIRY_WAIT',JSON.stringify({expires_at:expiresAt,blocking_pid:blockerPid,creation_pid:observed!.pid,
      blocked_clock:observed!.queryStarted,observed_clock:observed!.clock,released_clock:releaseClock,observed_wait_ms:Math.round((releaseClock-observed!.queryStarted)*1000)}));
    expect(releaseClock-observed!.queryStarted).toBeLessThan(1.45);
    expect(result!.body.status).not.toBe(200);expect(JSON.stringify(result!.body)).toContain('ORDER_QUOTE_RECONFIRM_REQUIRED');
    expect(result!.body.msg).not.toMatch(/lock timeout|55P03/);expect(await counts()).toEqual(before);expect(await stock()).toEqual(beforeStock);
    await f.maintenanceDb.update(storeProductAttrValue).set({writeEnd:expiresAt+3600}).where(eq(storeProductAttrValue.id,1));
    const fresh=await quote(value);
    expect((await http('/orders',{intent:value.intent,quote_token:fresh.quote_token},value.request_key)).body.status).toBe(200);
  },20000);
  it('reports cashier readiness independently and fails closed without repairing absent runtime SELECT privileges',async()=>{
    const before=await counts();await f.exec(`REVOKE SELECT ON public.cashier_second_card_origin_v1 FROM "${f.role}"`);
    try{const read=await catalog().list(f.actor());expect(read.data.readiness.writes).toBe(false);
      const context=await new CustomerWorkReadService(f.container,f.env).context(f.actor());
      expect(context.data.capabilities).toMatchObject({cashier_second_card:false,assisted_order:false,writes:false});
      expect((await f.maintenanceDb.execute<{p:boolean}>(sql`SELECT has_table_privilege(${f.role},'public.cashier_second_card_origin_v1','SELECT') AS p`))[0].p).toBe(false);
      expect(await counts()).toEqual(before);
    }finally{await f.exec(`GRANT SELECT ON public.cashier_second_card_origin_v1 TO "${f.role}"`);}
  });
  it('rejects another staff current role revocation and noncanonical catalog query identities before returning selection',async()=>{
    expect((await http('/catalog',undefined,undefined,102)).body.status).not.toBe(200);
    for(const path of ['/catalog?buyer_uid=11','/catalog?limit=01','/catalog?limit=51','/catalog/070','/catalog/70?keyword=x','/catalog?keyword=a&keyword=b'])expect((await http(path)).body.status).not.toBe(200);
    let revoked=false;const observed=observeIntegralReadDb(f.db,async(_db,command)=>{if(!revoked&&command.includes('from "store_product"')){revoked=true;await f.maintenanceDb.update(storeService).set({customer:0}).where(eq(storeService.uid,101));}});
    await expect(catalog(observed).list(f.actor())).rejects.toThrow();expect(revoked).toBe(true);
  });
  it('rechecks actual cashier product form and validity admission after an independent LOGIN cart lock wait',async()=>{
    const firstForm=await form(),secondForm=await form();await f.maintenanceDb.update(storeProduct).set({systemFormId:firstForm}).where(eq(storeProduct.id,70));
    for(const change of ['form','review','owner','validity'] as const){
      await f.reset();await f.maintenanceDb.update(storeProduct).set({systemFormId:firstForm,isVerify:1,relationId:0}).where(eq(storeProduct.id,70));
      const value=await draft({custom_form:[{id:'name',name:'texts',value:'姓名'}]}),q=await quote(value);let pending:Promise<Awaited<ReturnType<typeof http>>>|undefined,blocked=false;
      await f.withPeer(async(peer,pid)=>peer.transaction(async tx=>{
        await tx.update(storeCart).set({cartNum:value.intent.quantity}).where(eq(storeCart.id,value.cart_id));
        pending=http('/orders',{intent:value.intent,quote_token:q.quote_token},value.request_key);
        const deadline=Date.now()+2500;while(Date.now()<deadline){const [state]=await f.maintenanceDb.execute<{blocked:boolean}>(sql`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity a WHERE a.usename=${f.role} AND a.pid<>${pid} AND ${pid}=ANY(pg_catalog.pg_blocking_pids(a.pid))) AS blocked`);
          if(state.blocked){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,20));}
        if(change==='form')await f.maintenanceDb.update(storeProduct).set({systemFormId:secondForm}).where(eq(storeProduct.id,70));
        if(change==='review')await f.maintenanceDb.update(storeProduct).set({isVerify:0}).where(eq(storeProduct.id,70));
        if(change==='owner')await f.maintenanceDb.update(storeProduct).set({relationId:999}).where(eq(storeProduct.id,70));
        if(change==='validity')await f.maintenanceDb.update(storeProductAttrValue).set({writeDays:20}).where(eq(storeProductAttrValue.id,1));
      }));
      expect(blocked).toBe(true);expect((await pending!).body.status).not.toBe(200);
      expect(await counts()).toMatchObject({orders:0,origins:0,payments:0,outbox:0});
      expect((await f.db.select({stock:storeProductAttrValue.stock}).from(storeProductAttrValue).where(eq(storeProductAttrValue.id,1)))[0].stock).toBe(10);
    }
  },30000);
});
