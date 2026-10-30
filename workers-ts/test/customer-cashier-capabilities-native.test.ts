import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as di from '../src/lib/di';
import type { DbClient } from '../src/lib/di';
import type { Env, AppVariables } from '../src/env';
import * as images from '../src/migrations/runCashierSecondCardFormImages';
import { pricingIdentifier } from '../src/migrations/checkoutPricingLockCatalog';
import { auditRuntimeBusinessPrivileges } from '../src/migrations/auditRuntimeBusinessPrivileges';
import { errorHandler } from '../src/middleware/error';
import { v1Routes } from '../src/routes/v1';
import { createToken, md5 } from '../src/utils/jwt';
import { storeService, user } from '../src/models/schema';
import { outRequestHash } from '../src/services/out/OutIdempotency';
import { customerCashierRuntimeHttpFixture } from './helpers/customerCashierRuntimeHttpFixture';
import { financePostgres } from './helpers/financePostgres';

const base = '/mobile/work/cashier/second-card', path = base+'/capabilities';
const ident = pricingIdentifier;
// This suite requires the canonical real five-LOGIN fixture and production
// routes. No permission, authentication, scope or readiness result is mocked.
// Interposition below observes actual read-only transactions or changes real
// maintenance rows between the snapshot and fresh publication checks.
describe.skipIf(!process.env.TEST_FINANCE_POSTGRES_URL).sequential('actual independent Cashier capability publication on owned PG16', { timeout:30000 }, () => {
  let f: Awaited<ReturnType<typeof customerCashierRuntimeHttpFixture>>;
  beforeAll(async () => { f = await customerCashierRuntimeHttpFixture(); f.env.CUSTOMER_CASHIER_RUNTIME_TARGET = f.commissioned.target; },180000);
  beforeEach(async () => { vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('No provider HTTP during capability acceptance')); await f.reset(); });
  afterEach(() => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); } });
  afterAll(async () => { await f?.close(); },30000);
  async function capability(config=f.env) {
    const result = await f.request(path,undefined,undefined,101,config); return result;
  }
  async function success() {
    const result = await capability(); expect(result.body.status,result.body.msg).toBe(200); return result.body.data;
  }
  async function originalReceipts() {
    const selected=await f.request(base+'/catalog/70');expect(selected.body.status,selected.body.msg).toBe(200);
    const key=randomUUID(),intent={version:'customer-cashier-second-card-v1',scope_key:selected.body.data.scope_key,
      buyer_uid:11,tourist_key:'',product_id:70,sku_unique:'qared001',quantity:1,
      real_name:'能力撤销前原购买人',user_phone:'00000000000',mark:'',custom_form:[],coupon_id:0,use_integral:false};
    const draft=await f.request(base+'/drafts',intent,key);expect(draft.body.status,draft.body.msg).toBe(200);
    const quoted=await f.request(base+'/quote',{request_key:key,intent});expect(quoted.body.status,quoted.body.msg).toBe(200);
    const created=await f.request(base+'/orders',{intent,quote_token:quoted.body.data.quote_token},key);
    expect(created.body.status,created.body.msg).toBe(200);
    const order=await f.order(created.body.data.receipt.order_id),paymentKey=randomUUID();
    const payment=await f.request(base+'/orders/'+order.id+'/cash',{version:'customer-cashier-second-card-payment-v1',
      scope_key:intent.scope_key,order_id:order.id,order_no:order.orderId,expected_amount:order.payPrice},paymentKey);
    expect(payment.body.status,payment.body.msg).toBe(200);
    const creation=await f.request(base+'/creations/'+key),paid=await f.request(base+'/payments/'+paymentKey);
    expect(creation.body.status,creation.body.msg).toBe(200);expect(paid.body.status,paid.body.msg).toBe(200);
    expect(creation.body.data.receipt.order_id).toBe(order.id);expect(paid.body.data.receipt.evidence.paid).toBe(1);
    return{key,paymentKey,intent,creation:creation.body.data.receipt,payment:paid.body.data.receipt};
  }
  async function getWithToken(endpoint:string,token:string) {
    const response=await f.raw(endpoint,{headers:{Authorization:'Bearer '+token}});
    return{response,body:await response.json() as {status:number;msg:string;data:any}};
  }
  function rawWithApplication(db:DbClient,config:Env) {
    const application=di.createContainerFromDb(db),h=new Hono<{Bindings:Env;Variables:AppVariables}>();h.onError(errorHandler);
    h.use('*',async(c,next)=>{c.set('container',application);try{await next();}finally{expect(c.get('container')).toBe(application);expect(c.get('cashierCapabilityContext')).toBeUndefined();}});
    h.route('/api',v1Routes);
    return async()=>h.request('/api'+path,{headers:{Authorization:'Bearer '+await f.bearer()}},config);
  }
  it('keeps ordinary App context false while publishing a true dedicated capability and leaves business facts unchanged',async()=>{
    const before=await f.facts(),context=await f.request('/mobile/work/context');expect(context.body.status,context.body.msg).toBe(200);
    expect(context.body.data.data.capabilities.cashier_second_card).toBe(false);
    const result=await capability();expect(result.response.status).toBe(200);expect(result.body.status,result.body.msg).toBe(200);
    expect(result.response.headers.get('Cache-Control')).toBe('private, no-store');expect(result.response.headers.get('Pragma')).toBe('no-cache');
    const body=result.body.data;expect(body.version).toBe('customer-cashier-capabilities-v1');expect(body.actor_uid).toBe(101);
    expect(body.principal).toEqual(context.body.data.principal);expect(body.scope_key).toBe(context.body.data.scope_key);
    expect(body.data.capabilities).toEqual({cashier_second_card:true,cashier_form_images:true});
    expect(Object.values(body.data.readiness).every((s:any)=>s.ready&&s.reason==='')).toBe(true);
    expect(body.consistency_key).not.toBe(context.body.data.consistency_key);
    expect(body.consistency_key).toBe(await outRequestHash({version:body.version,actor_uid:body.actor_uid,
      service_id:body.principal.service_id,scope_key:body.scope_key,data:body.data}));
    expect(body.data.lease.expires_at-body.data.lease.issued_at).toBe(60);
    expect(body.data.lease.expires_at).toBeLessThanOrEqual(body.data.lease.session_expires_at);
    const raw=JSON.stringify(body);for(const secret of [f.database,f.appRuntime.role,f.cashierRuntime.role,f.cashierRuntime.connectionString])expect(raw).not.toContain(secret);
    expect((await auditRuntimeBusinessPrivileges(f.appRuntime.db,'app',f.target,undefined,f.peers,f.appReaders)).ready).toBe(true);
    const [appAcl]=await f.appRuntime.db.execute(sql`SELECT has_table_privilege(current_user,'public.cashier_second_card_form_session_v1','SELECT,INSERT') AS images,
      has_table_privilege(current_user,'public.cashier_second_card_cart_v1','INSERT') AS drafts,has_table_privilege(current_user,'public.customer_city_delivery_job','SELECT') AS city`);
    expect(appAcl).toEqual({images:false,drafts:false,city:false});
    expect(await f.facts()).toEqual(before);expect(f.messages).toEqual([]);expect(f.put).not.toHaveBeenCalled();expect(f.get).not.toHaveBeenCalled();
  });
  it('keeps the actual App buyer list and detail readable with the same actor/service/scope and its own consistency',async()=>{
    const cap=await success(),list=await f.request('/mobile/work/users?scope_key='+cap.scope_key);
    expect(list.body.status,list.body.msg).toBe(200);expect(list.body.data.actor_uid).toBe(cap.actor_uid);
    expect(list.body.data.principal.service_id).toBe(cap.principal.service_id);expect(list.body.data.scope_key).toBe(cap.scope_key);
    const detail=await f.request('/mobile/work/users/11?scope_key='+cap.scope_key);expect(detail.body.status,detail.body.msg).toBe(200);
    expect(detail.body.data.scope_key).toBe(cap.scope_key);expect(detail.body.data.consistency_key).toMatch(/^[a-f0-9]{64}$/u);
    expect(detail.body.data.consistency_key).not.toBe(cap.consistency_key);
  });
  it('uses actual RR/READ ONLY transactions with no assigned XID and closes the selected session once',async()=>{
    const original=di.createCustomerCashierDatabaseSession,records:Array<{readonly:string;isolation:string;xid:string|null}>=[],closes:ReturnType<typeof vi.fn>[]=[];
    vi.spyOn(di,'createCustomerCashierDatabaseSession').mockImplementation(async env=>{
      const session=await original(env),transaction=session.container.db.transaction.bind(session.container.db);
      vi.spyOn(session.container.db,'transaction').mockImplementation((async(work:any,config:any)=>transaction(async(tx:any)=>{
        const [before]=await tx.execute(sql`SELECT current_setting('transaction_read_only') AS readonly,
          current_setting('transaction_isolation') AS isolation,pg_current_xact_id_if_assigned()::text AS xid`);records.push(before);
        const result=await work(tx);expect((await tx.execute(sql`SELECT pg_current_xact_id_if_assigned()::text AS xid`))[0].xid).toBeNull();return result;
      },config)) as typeof session.container.db.transaction);
      const close=vi.fn(session.close);closes.push(close);return{...session,close};
    });
    await success();expect(records).toHaveLength(2);for(const record of records)expect(record).toEqual({readonly:'on',isolation:'repeatable read',xid:null});
    expect(closes).toHaveLength(1);expect(closes[0]).toHaveBeenCalledOnce();
  });
  it('rejects an actual different owned App database with identical valid LOGIN, UID, password and service before opening Cashier',async()=>{
    const other=await financePostgres([user,storeService],{namespace:'public'});let selected:DbClient|undefined;
    try{
      const [where]=await other.db.execute<{database:string}>(sql`SELECT current_database() AS database`);
      expect(where.database).not.toBe(f.database);
      const users=await f.maintenanceDb.select().from(user).where(eq(user.uid,101));
      const services=await f.maintenanceDb.select().from(storeService).where(eq(storeService.uid,101));
      await other.db.insert(user).values(users);await other.db.insert(storeService).values(services);
      await other.exec(`REVOKE ALL ON DATABASE ${ident(where.database)} FROM PUBLIC;GRANT CONNECT ON DATABASE ${ident(where.database)} TO ${ident(f.appRuntime.role)};GRANT USAGE ON SCHEMA public TO ${ident(f.appRuntime.role)};GRANT SELECT ON public."user",public.store_service TO ${ident(f.appRuntime.role)}`);
      const dsn=new URL(f.appRuntime.connectionString);dsn.pathname='/'+where.database;
      selected=di.createDbFromConnectionString(dsn.href,1,{searchPath:'public,pg_temp',applicationName:'capability_wrong_app_db17'});
      const [identity]=await selected.execute(sql`SELECT current_user AS role,current_database() AS database`);
      expect(identity).toEqual({role:f.appRuntime.role,database:where.database});
      const open=vi.spyOn(di,'createCustomerCashierDatabaseSession'),before=await f.facts();
      const response=await rawWithApplication(selected,{...f.env,HYPERDRIVE:{connectionString:dsn.href} as Env['HYPERDRIVE']})();
      expect(response.status).toBe(503);expect((await response.json() as {status:number}).status).toBe(503);
      expect(open).not.toHaveBeenCalled();expect(await f.facts()).toEqual(before);
    }finally{await selected?.$client.end({timeout:5});await other.close();}
  });
  it.each(['missing-target','wrong-target-db','role-alias','wrong-db-OID','wrong-App-role'] as const)('rejects trusted %s mismatch before delivering Cashier capability',async(kind)=>{
    const config={...f.env,CUSTOMER_CASHIER_RUNTIME_IDENTITY:{...f.commissioned.binding},
      CUSTOMER_CASHIER_RUNTIME_TARGET:{...f.target,local:[...f.target.local!]}};
    if(kind==='missing-target')delete (config as Env).CUSTOMER_CASHIER_RUNTIME_TARGET;
    else if(kind==='wrong-target-db')config.CUSTOMER_CASHIER_RUNTIME_TARGET!.database='wrong_capability_database17';
    else if(kind==='role-alias')config.CUSTOMER_CASHIER_RUNTIME_TARGET!.app=f.cashierRuntime.role;
    else if(kind==='wrong-db-OID')config.CUSTOMER_CASHIER_RUNTIME_IDENTITY.databaseOid=String(BigInt(config.CUSTOMER_CASHIER_RUNTIME_IDENTITY.databaseOid)+1n);
    else config.CUSTOMER_CASHIER_RUNTIME_TARGET!.app='declared_but_not_actual_app17';
    const open=vi.spyOn(di,'createCustomerCashierDatabaseSession'),result=await capability(config);
    expect(result.response.status).toBe(503);expect(result.body.status).toBe(503);expect(open).not.toHaveBeenCalled();
  });
  it.each(['?scope_key='+ 'f'.repeat(64),'?role=other','?scope_key=a&scope_key=b'] as const)('rejects request-supplied capability identity %s',async(query)=>{
    const result=await f.request(path+query);expect(result.body.status).not.toBe(200);
  });
  it('rejects Idempotency-Key rather than treating the capability as an author operation',async()=>{
    const result=await f.request(path,undefined,randomUUID());expect(result.body.status).not.toBe(200);
  });
  it.each(['missing','malformed','admin-realm','password-claim'] as const)('rejects actual %s authentication before any Cashier capability session opens',async(kind)=>{
    const open=vi.spyOn(di,'createCustomerCashierDatabaseSession');
    let token='';if(kind==='malformed')token='invalid-token';
    else if(kind==='admin-realm')token=await f.bearer(101,'admin');
    else if(kind==='password-claim')token=(await createToken(101,'api',md5('obsolete-password'),f.env.APP_KEY)).token;
    const response=await f.raw(path,{headers:token?{Authorization:'Bearer '+token}:{}}),body=await response.json() as {status:number};
    expect(body.status).not.toBe(200);expect(open).not.toHaveBeenCalled();expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });
  it.each(['customer','accountStatus','service-isDel','missing-service','duplicate'] as const)
    ('ordinary App context returns qualification403 after actual %s loss while the same valid JWT retains its genuine owner receipts',async(kind)=>{
      const original=await originalReceipts(),token=await f.bearer();
      const initial=await getWithToken('/mobile/work/context',token);expect(initial.body.status,initial.body.msg).toBe(200);
      const [service]=await f.maintenanceDb.select().from(storeService).where(eq(storeService.uid,101));
      const duplicateId=service.id+1000;
      if(kind==='missing-service')await f.maintenanceDb.delete(storeService).where(eq(storeService.id,service.id));
      else if(kind==='duplicate')await f.maintenanceDb.insert(storeService).values({...service,id:duplicateId});
      else await f.maintenanceDb.update(storeService).set(kind==='customer'?{customer:0}:kind==='accountStatus'?{accountStatus:0}:{isDel:1}).where(eq(storeService.id,service.id));
      try{
        const before=await f.facts(),context=await getWithToken('/mobile/work/context',token);
        expect(context.response.status).toBe(403);expect(context.body).toMatchObject({status:403,data:null});
        expect(context.response.headers.get('Cache-Control')).toBe('private, no-store');
        const cap=await getWithToken(path,token);expect(cap.response.status).toBe(403);expect(cap.body.status).toBe(403);
        const creation=await getWithToken(base+'/creations/'+original.key,token),payment=await getWithToken(base+'/payments/'+original.paymentKey,token);
        expect(creation.body.status,creation.body.msg).toBe(200);expect(creation.body.data.receipt).toEqual(original.creation);
        expect(payment.body.status,payment.body.msg).toBe(200);expect(payment.body.data.receipt).toEqual(original.payment);
        const foreign=await f.request(base+'/creations/'+original.key,undefined,undefined,102);
        expect(foreign.body.status,foreign.body.msg).toBe(200);expect(foreign.body.data.receipt).toBeNull();
        const attempted=await f.request(base+'/drafts',original.intent,randomUUID());expect(attempted.body.status).toBe(403);
        expect(await f.facts()).toEqual(before);
        // Explicit owner abandonment keeps its existing authority after work
        // qualification loss. It does not produce an order or reuse a UUID.
        const abandonKey=randomUUID(),abandoned=await f.request(base+'/creations/'+abandonKey+'/abandon',{
          version:'customer-cashier-abandon-v1',kind:'creation',intent:original.intent},abandonKey);
        expect(abandoned.body.status,abandoned.body.msg).toBe(200);expect(abandoned.body.data.abandonment).not.toBeNull();
        expect((await f.request(base+'/creations/'+abandonKey)).body.data.abandonment).toEqual(abandoned.body.data.abandonment);
      }finally{
        await f.maintenanceDb.delete(storeService).where(eq(storeService.id,duplicateId));
        if(kind==='missing-service')await f.maintenanceDb.insert(storeService).values(service);
        else await f.maintenanceDb.update(storeService).set(service).where(eq(storeService.id,service.id));
      }
      expect((await getWithToken('/mobile/work/context',token)).body.status).toBe(200);
    });
  it.each(['password','expired','disabled','isDel','deleteTime','missing-account'] as const)
    ('ordinary App context and original owner recovery both reject actual %s authentication loss',async(kind)=>{
      const original=await originalReceipts(),[account]=await f.maintenanceDb.select().from(user).where(eq(user.uid,101));
      const token=kind==='expired'?(await createToken(101,'api',md5(account.pwd),f.env.APP_KEY,'cinashop',Math.floor(Date.now()/1000)-8*86400)).token:await f.bearer();
      if(kind==='password')await f.maintenanceDb.update(user).set({pwd:md5('changed-after-original-owner-receipt')}).where(eq(user.uid,101));
      else if(kind==='disabled')await f.maintenanceDb.update(user).set({status:0}).where(eq(user.uid,101));
      else if(kind==='isDel')await f.maintenanceDb.update(user).set({isDel:1}).where(eq(user.uid,101));
      else if(kind==='deleteTime')await f.maintenanceDb.update(user).set({deleteTime:new Date()}).where(eq(user.uid,101));
      else if(kind==='missing-account')await f.maintenanceDb.delete(user).where(eq(user.uid,101));
      try{
        const before=await f.facts(),code=kind==='disabled'?410002:410001;
        for(const endpoint of ['/mobile/work/context',path,base+'/creations/'+original.key,base+'/payments/'+original.paymentKey]){
          const denied=await getWithToken(endpoint,token);expect(denied.body.status,endpoint+': '+denied.body.msg).toBe(code);
          expect(denied.body.data).toBeNull();expect(denied.body.status).not.toBe(403);
        }
        expect(await f.facts()).toEqual(before);
      }finally{
        if(kind==='missing-account')await f.maintenanceDb.insert(user).values(account);
        else await f.maintenanceDb.update(user).set({pwd:account.pwd,status:account.status,isDel:account.isDel,deleteTime:account.deleteTime}).where(eq(user.uid,101));
      }
      // Restored account uses an actual newly authenticated JWT; an old
      // expired token never gains owner authority from a saved capability.
      expect((await f.request(base+'/creations/'+original.key)).body.data.receipt).toEqual(original.creation);
    });
  it('does not turn an unexpired capability hint into fresh author permission',async()=>{
    const cap=await success(),[service]=await f.maintenanceDb.select().from(storeService).where(eq(storeService.uid,101));
    await f.maintenanceDb.update(storeService).set({customer:0}).where(eq(storeService.id,service.id));
    try{
      const before=await f.facts(),intent={version:'customer-cashier-second-card-v1',scope_key:cap.scope_key,buyer_uid:11,tourist_key:'',
        product_id:70,sku_unique:'qared001',quantity:1,real_name:'原购买人',user_phone:'00000000000',mark:'',custom_form:[],coupon_id:0,use_integral:false};
      const result=await f.request(base+'/drafts',intent,randomUUID());expect(result.body.status).not.toBe(200);expect(await f.facts()).toEqual(before);
      const recovery=await f.request(base+'/payments/'+randomUUID());expect(recovery.body.status,recovery.body.msg).toBe(200);
    }finally{await f.maintenanceDb.update(storeService).set({customer:service.customer}).where(eq(storeService.id,service.id));}
  });
  it('limits the capability lease to the actual short-lived authenticated JWT',async()=>{
    const issued=Math.floor(Date.now()/1000)-7*86400+25,token=await createToken(101,'api',md5('owned-financial-password'),f.env.APP_KEY,'cinashop',issued);
    const response=await f.raw(path,{headers:{Authorization:'Bearer '+token.token}}),body=await response.json() as any;
    expect(body.status,body.msg).toBe(200);expect(body.data.data.lease.expires_at).toBe(token.exp);
    expect(body.data.data.lease.expires_at-body.data.data.lease.issued_at).toBeGreaterThan(0);
    expect(body.data.data.lease.expires_at-body.data.data.lease.issued_at).toBeLessThanOrEqual(25);
  });
  it('keeps no-form/text eligibility separate from actual image-append authority drift',async()=>{
    const before=await success();await f.exec(`REVOKE INSERT ON public.cashier_second_card_form_upload_v1 FROM ${ident(f.cashierRuntime.role)}`);
    try{
      const cap=await success();expect(cap.data.capabilities).toEqual({cashier_second_card:true,cashier_form_images:false});
      expect(cap.data.readiness.form_images.ready).toBe(false);expect(cap.data.runtime_revision).not.toBe(before.data.runtime_revision);
      const selection=await f.request(base+'/catalog/70');expect(selection.body.status,selection.body.msg).toBe(200);expect(selection.body.data.data.readiness.writes).toBe(true);
    }finally{await f.exec(`GRANT INSERT ON public.cashier_second_card_form_upload_v1 TO ${ident(f.cashierRuntime.role)}`);}
    expect((await success()).data.capabilities.cashier_form_images).toBe(true);
  });
  it('fails the complete conditional capability when a real guard is disabled without repairing it',async()=>{
    await f.exec('ALTER TABLE public.city_area DISABLE TRIGGER cinashop_runtime_lock_only_v1');
    try{const cap=await success();expect(cap.data.capabilities).toEqual({cashier_second_card:false,cashier_form_images:false});expect(cap.data.readiness.conditional.ready).toBe(false);}
    finally{await f.exec('ALTER TABLE public.city_area ENABLE TRIGGER cinashop_runtime_lock_only_v1');}
  });
  it.each(['qualification','scope','password','disabled','deleted'] as const)('withholds an already-read capability after actual %s revocation before publication',async(kind)=>{
    const [service]=await f.maintenanceDb.select().from(storeService).where(eq(storeService.uid,101));
    const [account]=await f.maintenanceDb.select().from(user).where(eq(user.uid,101));
    const original=images.cashierSecondCardFormImagesReadiness;
    vi.spyOn(images,'cashierSecondCardFormImagesReadiness').mockImplementationOnce(async db=>{
      const result=await original(db);
      if(kind==='qualification')await f.maintenanceDb.update(storeService).set({customer:0}).where(eq(storeService.id,service.id));
      else if(kind==='scope')await f.maintenanceDb.update(storeService).set({merId:service.merId+1}).where(eq(storeService.id,service.id));
      else if(kind==='password')await f.maintenanceDb.update(user).set({pwd:md5('changed-after-capability-snapshot')}).where(eq(user.uid,101));
      else if(kind==='disabled')await f.maintenanceDb.update(user).set({status:0}).where(eq(user.uid,101));
      else await f.maintenanceDb.update(user).set({isDel:1}).where(eq(user.uid,101));
      return result;
    });
    try{
      const result=await capability();expect(result.body.status).toBe(kind==='password'||kind==='deleted'?410001:kind==='disabled'?410002:403);
      if(kind==='qualification'){
        expect(result.response.status).toBe(403);expect(result.body.status).not.toBe(410000);
        const recovery=await f.request(base+'/creations/'+randomUUID());expect(recovery.body.status,recovery.body.msg).toBe(200);
        expect(recovery.body.data.receipt).toBeNull();
      }
    }finally{
      await f.maintenanceDb.update(storeService).set({customer:service.customer,merId:service.merId}).where(eq(storeService.id,service.id));
      await f.maintenanceDb.update(user).set({pwd:account.pwd,status:account.status,isDel:account.isDel}).where(eq(user.uid,101));
    }
  });
});
