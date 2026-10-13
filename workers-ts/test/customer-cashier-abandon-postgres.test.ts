import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { Hono } from 'hono';
import type { AppVariables, Env } from '../src/env';
import { createContainerFromDb, type DbClient } from '../src/lib/di';
import { authMiddleware } from '../src/middleware/auth';
import { errorHandler } from '../src/middleware/error';
import { createToken, md5 } from '../src/utils/jwt';
import { outRequestHash } from '../src/services/out/OutIdempotency';
import { storeOrder, storeProduct, storeService, systemForm, user } from '../src/models/schema';
import { withTx } from '../src/lib/di';
import { registerPaymentReconciliationTx } from '../src/services/payment/PaymentReconciliationRegistry';
import * as controller from '../src/controllers/api/v1/CustomerWorkCashierController';
import { CustomerWorkCashierService } from '../src/services/customer-work/CustomerWorkCashierService';
import { CustomerCashierFormImages, CASHIER_FORM_IMAGE_VERSION, CASHIER_FORM_SESSION_VERSION } from '../src/services/customer-work/CustomerCashierFormImages';
import { customerCashierFormImagesFixture } from './helpers/customerCashierFormImagesFixture';
import { cashierSecondCardAbandonReadiness } from '../src/migrations/runCashierSecondCardAbandon';

type Kind = 'creation'|'payment';
type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Expected an actual JSON object');
  return value as RecordValue;
}
function field(value: unknown, name: string) { return record(value)[name]; }
const envelope = (kind: Kind, intent: unknown) => ({version:'customer-cashier-abandon-v1',kind,intent});

/** Real UserJWT + independently authenticated PG16 customer connections.
 * Both race winners are observed in PostgreSQL; maintenance never fabricates
 * a successful business creation, payment or abandonment receipt. */
describe.skipIf(!process.env.TEST_FINANCE_POSTGRES_URL)('customer cashier durable abandonment PostgreSQL16',()=>{
  let f:Awaited<ReturnType<typeof customerCashierFormImagesFixture>>;
  beforeAll(async()=>{f=await customerCashierFormImagesFixture();},180000);
  beforeEach(async()=>{await f.reset();await f.maintenanceDb.update(storeProduct).set({systemFormId:0,isShow:1}).where(eq(storeProduct.id,70));});
  afterAll(async()=>{await f?.close();},30000);
  const service=(db:DbClient=f.db)=>new CustomerWorkCashierService(createContainerFromDb(db),f.env);
  function app(db:DbClient=f.db) {
    const h=new Hono<{Bindings:Env;Variables:AppVariables}>();
    h.use('*',async(c,next)=>{c.set('container',createContainerFromDb(db));await next();});
    h.use('*',authMiddleware({force:true}));h.onError(errorHandler);
    h.post('/drafts',controller.cashierDraft);h.post('/quote',controller.cashierQuote);h.post('/orders',controller.cashierCreate);
    h.post('/orders/:id/cash',controller.cashierCash);
    h.get('/creations/:key',controller.cashierCreationStatus);h.get('/payments/:key',controller.cashierPaymentStatus);
    h.post('/creations/:key/abandon',controller.cashierCreationAbandon);h.post('/payments/:key/abandon',controller.cashierPaymentAbandon);
    return h;
  }
  async function http(path:string,body?:unknown,key?:string,options:{db?:DbClient;uid?:number;realm?:'api'|'admin';headers?:Record<string,string>}={}) {
    const token=(await createToken(options.uid??101,options.realm??'api',md5('owned-financial-password'),f.env.APP_KEY)).token;
    const response=await app(options.db??f.db).request(path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,
      ...(body===undefined?{}:{'Content-Type':'application/json'}),...(key?{'Idempotency-Key':key}:{}),...options.headers},
      ...(body===undefined?{}:{body:JSON.stringify(body)})},f.env);
    const parsed:unknown=await response.json(),r=record(parsed);
    if(typeof r.status!=='number'||typeof r.msg!=='string')throw Error('Invalid real HTTP result');
    return {response,status:r.status,message:r.msg,data:r.data};
  }
  const path=(kind:Kind,key:string)=>`/${kind==='creation'?'creations':'payments'}/${key}`;
  async function selected(overrides:Parameters<typeof f.input>[0]={}) {
    const {request_key,quote_token:_token,...intent}=await f.input(overrides);return {key:request_key,intent};
  }
  async function draft(s:Awaited<ReturnType<typeof selected>>) {
    const result=await http('/drafts',s.intent,s.key);expect(result.status,result.message).toBe(200);return result;
  }
  async function quote(s:Awaited<ReturnType<typeof selected>>) {
    const result=await http('/quote',{request_key:s.key,intent:s.intent});expect(result.status,result.message).toBe(200);return record(result.data);
  }
  async function create(s:Awaited<ReturnType<typeof selected>>) {
    await draft(s);const q=await quote(s),r=await http('/orders',{intent:s.intent,quote_token:q.quote_token},s.key);
    expect(r.status,r.message).toBe(200);return record(r.data);
  }
  async function payment() {
    const s=await selected(),created=await create(s),receipt=record(created.receipt),order=record(receipt.order);
    const intent={version:'customer-cashier-second-card-payment-v1' as const,scope_key:s.intent.scope_key,
      order_id:Number(receipt.order_id),order_no:String(order.order_no),expected_amount:String(order.amount)};
    return {key:randomUUID(),intent,creation:s};
  }
  async function abandon(kind:Kind,s:{key:string;intent:unknown},db=f.db) {
    return http(`${path(kind,s.key)}/abandon`,envelope(kind,s.intent),s.key,{db});
  }
  async function facts() {
    const [r]=await f.maintenanceDb.execute<{data:Record<string,number>}>(sql`SELECT jsonb_build_object(
      'orders',(SELECT count(*) FROM store_order),'origins',(SELECT count(*) FROM cashier_second_card_origin_v1),
      'payments',(SELECT count(*) FROM cashier_second_card_payment_v1),'abandoned',(SELECT count(*) FROM cashier_second_card_abandon_v1),
      'outbox',(SELECT count(*) FROM store_order_outbox),'audits',(SELECT count(*) FROM store_order_status),
      'stock',(SELECT stock FROM store_product_attr_value WHERE id=1)) AS data`);return r.data;
  }
  function proof(result:unknown,kind:Kind,s:{key:string;intent:unknown}) {
    const r=record(result);expect(r).toMatchObject({version:'customer-cashier-receipt-v1',actor_uid:101,request_key:s.key,kind,receipt:null});
    expect(r.abandonment).toMatchObject({version:'customer-cashier-abandon-v1',actor_uid:101,request_key:s.key,kind,
      scope_key:field(s.intent,'scope_key'),intent:s.intent});
    const p=record(r.abandonment);expect(p.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);return p;
  }
  function lostCommit(db:DbClient) {
    let lost=false;return new Proxy(db,{get(target,key,receiver){const value=Reflect.get(target,key,receiver);
      if(typeof value!=='function')return value;if(key!=='transaction')return value.bind(target);
      return async(...args:unknown[])=>{const result=await Reflect.apply(value,target,args);
        if(!lost){lost=true;throw Object.assign(Error('Actual committed reply lost'),{code:'40003'});}return result;};}});
  }
  /** Pause only after the real shared advisory lock is held in its transaction. */
  function holdFirstRequestLock(db:DbClient) {
    let release!:()=>void,entered!:()=>void,paused=false;
    const held=new Promise<void>(resolve=>release=resolve),arrived=new Promise<void>(resolve=>entered=resolve),dialect=new PgDialect();
    const wrapped=new Proxy(db,{get(target,key,receiver){const value=Reflect.get(target,key,receiver);
      if(typeof value!=='function')return value;if(key!=='transaction')return value.bind(target);
      return async(callback:(tx:DbClient)=>Promise<unknown>,...options:unknown[])=>Reflect.apply(value,target,[async(tx:DbClient)=>callback(new Proxy(tx,{get(inner,name,context){
        const method=Reflect.get(inner,name,context);if(typeof method!=='function')return method;if(name!=='execute')return method.bind(inner);
        return async(query:SQL,...args:unknown[])=>{const result=await Reflect.apply(method,inner,[query,...args]);
          if(!paused&&/pg_advisory_xact_lock\s*\(\s*731688/.test(dialect.sqlToQuery(query).sql)){paused=true;entered();await held;}return result;};
      }})),...options]);}});
    const arrive=async()=>{let timer:ReturnType<typeof setTimeout>|undefined;
      try{await Promise.race([arrived,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(Error('Business transaction never acquired the actual cashier request lock')),5000);})]);}
      catch(error){release();throw error;}finally{if(timer!==undefined)clearTimeout(timer);}};
    return {db:wrapped,arrive,release};
  }
  async function waitForLock(pid:number) {
    const until=Date.now()+5000;
    while(Date.now()<until){const[r]=await f.maintenanceDb.execute<{waiting:boolean}>(sql`SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=${pid}`);
      if(r?.waiting)return;await new Promise(resolve=>setTimeout(resolve,10));}
    throw Error('Expected the independent PostgreSQL backend to wait for the shared lock');
  }

  it.each([{buyer_uid:11,tourist_key:''},{buyer_uid:0,tourist_key:'abandoned-guest'}])('persists an absent creation barrier and rejects late draft or create for buyer $buyer_uid',async(buyer)=>{
    const s=await selected(buyer),before=await facts(),r=await abandon('creation',s);expect(r.status,r.message).toBe(200);
    const p=proof(r.data,'creation',s);expect(p.request_hash).toBe(await outRequestHash(s.intent));
    expect((await http(path('creation',s.key))).data).toMatchObject({receipt:null,abandonment:p});
    expect((await http('/drafts',s.intent,s.key)).status).toBe(409);
    expect((await http('/orders',{intent:s.intent,quote_token:'a'.repeat(32)},s.key)).status).not.toBe(200);
    expect(await facts()).toEqual({...before,abandoned:1});
    await create({...s,key:randomUUID()});expect((await facts()).orders).toBe(1);
  });
  it('does not treat an absent GET receipt as a durable barrier',async()=>{
    const s=await selected(),r=await http(path('creation',s.key));expect(r.status).toBe(200);
    expect(r.data).toMatchObject({receipt:null,abandonment:null});expect((await facts()).abandoned).toBe(0);
    await create(s);expect((await facts()).orders).toBe(1);
  });
  it('commissions only append and read authority and rejects direct mutation of a real terminal fact',async()=>{
    const s=await selected();expect(await cashierSecondCardAbandonReadiness(f.db)).toMatchObject({ready:true});
    expect((await abandon('creation',s)).status).toBe(200);
    await expect(f.db.execute(sql`UPDATE public.cashier_second_card_abandon_v1 SET scope_key=${'a'.repeat(64)}`)).rejects.toThrow();
    await expect(f.db.execute(sql`DELETE FROM public.cashier_second_card_abandon_v1`)).rejects.toThrow();
    await expect(f.db.execute(sql`TRUNCATE public.cashier_second_card_abandon_v1`)).rejects.toThrow();
    expect((await facts()).abandoned).toBe(1);
  });
  it('refuses new fences under overbroad inherited write authority',async()=>{
    const s=await selected();await f.exec(`GRANT UPDATE ON public.cashier_second_card_abandon_v1 TO "${f.role}"`);
    try{expect(await cashierSecondCardAbandonReadiness(f.db)).toMatchObject({ready:false});
      expect((await abandon('creation',s)).status).not.toBe(200);expect((await facts()).abandoned).toBe(0);}
    finally{await f.exec(`REVOKE UPDATE ON public.cashier_second_card_abandon_v1 FROM "${f.role}"`);}
  });
  it('fails closed when original abandonment SELECT authority is missing',async()=>{
    const s=await selected();await f.exec(`REVOKE SELECT ON public.cashier_second_card_abandon_v1 FROM "${f.role}"`);
    try{expect((await http(path('creation',s.key))).status).not.toBe(200);
      expect((await http('/drafts',s.intent,s.key)).status).not.toBe(200);expect((await facts()).orders).toBe(0);}
    finally{await f.exec(`GRANT SELECT ON public.cashier_second_card_abandon_v1 TO "${f.role}"`);}
  });
  it('rejects an incompatible ledger catalog without trusting its current measured fingerprint',async()=>{
    const s=await selected();await f.exec('ALTER INDEX public.csca_actor_history RENAME TO csca_drifted_history');
    try{expect(await cashierSecondCardAbandonReadiness(f.db)).toMatchObject({ready:false});
      expect((await abandon('creation',s)).status).not.toBe(200);expect((await http('/drafts',s.intent,s.key)).status).not.toBe(200);}
    finally{await f.exec('ALTER INDEX public.csca_drifted_history RENAME TO csca_actor_history');}
    expect((await facts()).abandoned).toBe(0);
  });
  it('rejects a forged content hash at the actual append-only SQL boundary',async()=>{
    const s=await selected(),serialized=JSON.stringify(s.intent);
    await expect(f.db.execute(sql`INSERT INTO public.cashier_second_card_abandon_v1(actor_uid,request_key,kind,request_hash,scope_key,intent,intent_json)
      VALUES(101,${s.key}::uuid,'creation',${'0'.repeat(64)},${s.intent.scope_key},${serialized}::jsonb,${serialized})`)).rejects.toThrow();
    expect((await facts()).abandoned).toBe(0);
  });
  it('fences another quote and final create on the same still-valid original selection',async()=>{
    const s=await selected();await draft(s);const q=await quote(s);
    expect((await abandon('creation',s)).status).toBe(200);
    expect((await http('/quote',{request_key:s.key,intent:s.intent})).status).toBe(409);
    expect((await http('/orders',{intent:s.intent,quote_token:q.quote_token},s.key)).status).toBe(409);
    expect(await facts()).toMatchObject({orders:0,origins:0,stock:10,abandoned:1});
  });
  it('abandons an actual quoted draft after the product is unavailable and keeps the frozen body',async()=>{
    const s=await selected();await draft(s);const q=await quote(s);
    await f.maintenanceDb.update(storeProduct).set({isShow:0}).where(eq(storeProduct.id,70));
    const r=await abandon('creation',s);expect(r.status,r.message).toBe(200);proof(r.data,'creation',s);
    expect((await http('/orders',{intent:s.intent,quote_token:q.quote_token},s.key)).status).not.toBe(200);
    expect((await facts()).orders).toBe(0);expect((await facts()).stock).toBe(10);
  });
  it('binds abandonment to the exact original body and rejects replacement against an existing draft',async()=>{
    const s=await selected();await draft(s);
    expect((await abandon('creation',{...s,intent:{...s.intent,quantity:1}})).status).toBe(409);
    const first=await abandon('creation',s);expect(first.status,first.message).toBe(200);
    expect((await abandon('creation',{...s,intent:{...s.intent,mark:'other content'}})).status).toBe(409);
    expect((await facts()).abandoned).toBe(1);
  });
  it('replays the same immutable barrier on an independent customer LOGIN connection',async()=>{
    const s=await selected(),first=await abandon('creation',s);expect(first.status,first.message).toBe(200);
    await f.withPeer(async peer=>{const second=await abandon('creation',s,peer);expect(second.status,second.message).toBe(200);
      expect(field(second.data,'abandonment')).toEqual(field(first.data,'abandonment'));});expect((await facts()).abandoned).toBe(1);
  });
  it('keeps already committed creation and rejects an altered body instead of abandoning the order',async()=>{
    const s=await selected(),created=await create(s),before=await facts(),r=await abandon('creation',s);
    expect(r.status,r.message).toBe(200);expect(r.data).toMatchObject({receipt:created.receipt,abandonment:null});
    expect((await abandon('creation',{...s,intent:{...s.intent,quantity:1}})).status).toBe(409);expect(await facts()).toEqual(before);
  });
  it('refuses a fabricated no-effect result when a committed order has lost its origin row',async()=>{
    const s=await selected();await create(s);await f.exec('DELETE FROM public.cashier_second_card_origin_v1');
    const r=await abandon('creation',s);expect(r.status).not.toBe(200);
    expect(await facts()).toMatchObject({orders:1,abandoned:0,stock:8});
  });
  it('allows the original valid owner to abandon after customer qualification was revoked',async()=>{
    const s=await selected();await draft(s);await f.maintenanceDb.update(storeService).set({customer:0}).where(eq(storeService.uid,101));
    const r=await abandon('creation',s);expect(r.status,r.message).toBe(200);proof(r.data,'creation',s);
    expect((await http(path('creation',s.key))).status).toBe(200);expect((await facts()).orders).toBe(0);
  });
  it('separates actors and rejects an AdminJWT as an ordinary owner',async()=>{
    const s=await selected(),r=await abandon('creation',s);expect(r.status,r.message).toBe(200);
    const other=await http(path('creation',s.key),undefined,undefined,{uid:102});expect(other.data).toMatchObject({receipt:null,abandonment:null});
    expect((await http(`${path('creation',s.key)}/abandon`,envelope('creation',s.intent),s.key,{realm:'admin'})).status).not.toBe(200);
    expect((await facts()).abandoned).toBe(1);
  });
  it('rejects an expired or password-invalidated owner even when the original operation is absent',async()=>{
    const s=await selected(),actor={...f.actor(),expires_at:Math.floor(Date.now()/1000)-1};
    await expect(service().abandon(actor,s.key,envelope('creation',s.intent),s.key)).rejects.toThrow();
    await f.maintenanceDb.update(user).set({pwd:'changed-password'}).where(eq(user.uid,101));
    expect((await abandon('creation',s)).status).not.toBe(200);expect((await facts()).abandoned).toBe(0);
  });
  it.each(['missing','different','query','kind','version','extra','content-type','encoding','oversized'])('rejects invalid abandonment HTTP admission: %s',async(mode)=>{
    const s=await selected();let body:unknown=envelope('creation',s.intent),key:string|undefined=s.key,p=`${path('creation',s.key)}/abandon`;
    const headers:Record<string,string>={};
    if(mode==='missing')key=undefined;if(mode==='different')key=randomUUID();if(mode==='query')p+='?scope_key='+s.intent.scope_key;
    if(mode==='kind')body=envelope('payment',s.intent);if(mode==='version')body={...envelope('creation',s.intent),version:'invalid'};
    if(mode==='extra')body={...envelope('creation',s.intent),actor_uid:101};if(mode==='content-type')headers['Content-Type']='text/plain';
    if(mode==='encoding')headers['Content-Encoding']='gzip';if(mode==='oversized')body=envelope('creation',{...s.intent,mark:'x'.repeat(262144)});
    expect((await http(p,body,key,{headers})).status).not.toBe(200);expect((await facts()).abandoned).toBe(0);
  });
  it('recovers a committed abandonment after its actual transaction response was lost',async()=>{
    const s=await selected();await expect(service(lostCommit(f.db)).abandon(f.actor(),s.key,envelope('creation',s.intent),s.key)).rejects.toThrow('reply lost');
    expect((await facts()).abandoned).toBe(1);const r=await http(path('creation',s.key));expect(r.status,r.message).toBe(200);proof(r.data,'creation',s);
    expect((await http('/drafts',s.intent,s.key)).status).toBe(409);
  });
  it('rolls back an uncommitted abandonment without falsely excluding a later real creation',async()=>{
    const s=await selected();await f.exec(`REVOKE INSERT ON public.cashier_second_card_abandon_v1 FROM "${f.role}"`);
    try{expect((await abandon('creation',s)).status).not.toBe(200);expect((await facts()).abandoned).toBe(0);}
    finally{await f.exec(`GRANT INSERT ON public.cashier_second_card_abandon_v1 TO "${f.role}"`);}
    await create(s);expect((await facts()).orders).toBe(1);
  });
  it('serializes a creation arriving while abandonment owns the real shared lock',async()=>{
    const s=await selected();await draft(s);const q=await quote(s),gate=holdFirstRequestLock(f.db);
    await f.withPeer(async(peer,pid)=>{const first=abandon('creation',s,gate.db);await gate.arrive();
      const late=http('/orders',{intent:s.intent,quote_token:q.quote_token},s.key,{db:peer});
      try{await waitForLock(pid);}finally{gate.release();}
      const [a,c]=await Promise.all([first,late]);expect(a.status,a.message).toBe(200);proof(a.data,'creation',s);expect(c.status).toBe(409);});
    expect(await facts()).toMatchObject({orders:0,origins:0,abandoned:1,stock:10});
  });
  it('returns the real committed creation when creation holds the shared lock first',async()=>{
    const s=await selected();await draft(s);const q=await quote(s),gate=holdFirstRequestLock(f.db);
    await f.withPeer(async(peer,pid)=>{const first=http('/orders',{intent:s.intent,quote_token:q.quote_token},s.key,{db:gate.db});await gate.arrive();
      const second=abandon('creation',s,peer);try{await waitForLock(pid);}finally{gate.release();}
      const [c,a]=await Promise.all([first,second]);expect(c.status,c.message).toBe(200);expect(a.status,a.message).toBe(200);
      expect(a.data).toMatchObject({receipt:field(c.data,'receipt'),abandonment:null});});
    expect(await facts()).toMatchObject({orders:1,origins:1,abandoned:0,stock:8});
  });
  it.each(['7.00','0.00'])('durably abandons a cash UUID at %s without cancelling its real unpaid order',async(price)=>{
    await f.reset(price);await f.maintenanceDb.update(storeProduct).set({systemFormId:0}).where(eq(storeProduct.id,70));
    const p=await payment(),before=await facts(),r=await abandon('payment',p);expect(r.status,r.message).toBe(200);proof(r.data,'payment',p);
    expect((await http(`/orders/${p.intent.order_id}/cash`,p.intent,p.key)).status).toBe(409);
    expect(await facts()).toEqual({...before,abandoned:1});expect((await f.actual(p.intent.order_id)).order.paid).toBe(0);
    const paid=await http(`/orders/${p.intent.order_id}/cash`,p.intent,randomUUID());expect(paid.status,paid.message).toBe(200);
    expect((await facts()).payments).toBe(1);expect((await facts()).outbox).toBe(1);
  });
  it('returns the actual committed cash receipt and preserves its outbox',async()=>{
    const p=await payment(),paid=await http(`/orders/${p.intent.order_id}/cash`,p.intent,p.key);expect(paid.status,paid.message).toBe(200);
    const before=await facts(),r=await abandon('payment',p);expect(r.status,r.message).toBe(200);
    expect(r.data).toMatchObject({receipt:{order_id:p.intent.order_id,evidence:field(paid.data,'evidence')},abandonment:null});expect(await facts()).toEqual(before);
    expect((await abandon('payment',{...p,intent:{...p.intent,expected_amount:'0.01'}})).status).toBe(409);
  });
  it('refuses to assert abandonment after actual cash effects lose their payment receipt',async()=>{
    const p=await payment();expect((await http(`/orders/${p.intent.order_id}/cash`,p.intent,p.key)).status).toBe(200);
    await f.exec('DELETE FROM public.cashier_second_card_payment_v1');
    expect((await abandon('payment',p)).status).not.toBe(200);
    expect(await facts()).toMatchObject({outbox:1,abandoned:0});expect((await f.actual(p.intent.order_id)).order.paid).toBe(1);
  });
  it('never cancels an initiated UNKNOWN provider claim while resolving the cash UUID',async()=>{
    const p=await payment();await withTx(f.container,async tx=>{await registerPaymentReconciliationTx(tx,{
      provider:'wechat',profile:'wechat',orderDomain:'store_order',orderNo:p.intent.order_no,
      expectedAmountCents:1400,providerStatus:'UNKNOWN',initiated:true});});
    const before=await f.maintenanceDb.execute(sql`SELECT * FROM payment_reconciliation_case`);
    await abandon('payment',p);
    expect(await f.maintenanceDb.execute(sql`SELECT * FROM payment_reconciliation_case`)).toEqual(before);
    expect((await f.actual(p.intent.order_id)).order.paid).toBe(0);expect((await facts()).payments).toBe(0);
  });
  it('allows the valid owner to abandon a stale cash amount after qualification and amount changed',async()=>{
    const p=await payment();await f.maintenanceDb.update(storeOrder).set({payPrice:'20.00'}).where(eq(storeOrder.id,p.intent.order_id));
    await f.maintenanceDb.update(storeService).set({customer:0}).where(eq(storeService.uid,101));
    const r=await abandon('payment',p);expect(r.status,r.message).toBe(200);proof(r.data,'payment',p);
    expect((await f.actual(p.intent.order_id)).order).toMatchObject({paid:0,payPrice:'20.00'});
    expect(await facts()).toMatchObject({payments:0,outbox:0,abandoned:1});
  });
  it('preserves a committed payment proof after actual COMMIT reply loss',async()=>{
    const p=await payment();await expect(service(lostCommit(f.db)).cash(f.actor(),{...p.intent,request_key:p.key})).rejects.toThrow('reply lost');
    const r=await abandon('payment',p);expect(r.status,r.message).toBe(200);expect(r.data).toMatchObject({receipt:{order_id:p.intent.order_id},abandonment:null});
    expect(await facts()).toMatchObject({payments:1,outbox:1,abandoned:0});
  });
  it('serializes a late cash payment behind durable abandonment on an independent LOGIN',async()=>{
    const p=await payment(),gate=holdFirstRequestLock(f.db);
    await f.withPeer(async(peer,pid)=>{const first=abandon('payment',p,gate.db);await gate.arrive();
      const late=http(`/orders/${p.intent.order_id}/cash`,p.intent,p.key,{db:peer});try{await waitForLock(pid);}finally{gate.release();}
      const [a,c]=await Promise.all([first,late]);expect(a.status,a.message).toBe(200);proof(a.data,'payment',p);expect(c.status).toBe(409);});
    expect(await facts()).toMatchObject({payments:0,outbox:0,abandoned:1});expect((await f.actual(p.intent.order_id)).order.paid).toBe(0);
  });
  it('returns the real committed payment when cash acquires the shared lock first',async()=>{
    const p=await payment(),gate=holdFirstRequestLock(f.db);
    await f.withPeer(async(peer,pid)=>{const first=http(`/orders/${p.intent.order_id}/cash`,p.intent,p.key,{db:gate.db});await gate.arrive();
      const second=abandon('payment',p,peer);try{await waitForLock(pid);}finally{gate.release();}
      const [c,a]=await Promise.all([first,second]);expect(c.status,c.message).toBe(200);expect(a.status,a.message).toBe(200);
      expect(a.data).toMatchObject({receipt:{evidence:field(c.data,'evidence')},abandonment:null});});
    expect(await facts()).toMatchObject({payments:1,outbox:1,abandoned:0});
  });
  it('retains frozen private image facts after financial abandonment and rejects revival of their parent UUID',async()=>{
    await f.maintenanceDb.update(storeProduct).set({systemFormId:77}).where(eq(storeProduct.id,70));
    const s=await selected(),images=new CustomerCashierFormImages(f.container,f.env);
    const body={version:CASHIER_FORM_SESSION_VERSION,scope_key:s.intent.scope_key,buyer_uid:s.intent.buyer_uid,tourist_key:s.intent.tourist_key,
      product_id:s.intent.product_id,sku_unique:s.intent.sku_unique,quantity:s.intent.quantity};
    await images.createSession(f.actor(),s.key,body);
    const bytes=new Uint8Array([137,80,78,71,13,10,26,10]),digest=await crypto.subtle.digest('SHA-256',bytes);
    const sha256=Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('');
    const uploaded=await images.upload(f.actor(),s.key,randomUUID(),{version:CASHIER_FORM_IMAGE_VERSION,scope_key:s.intent.scope_key,
      session_key:s.key,field_id:'id:"photo"',sha256,size:bytes.length},new File([bytes],'proof.png',{type:'image/png'}));
    const image=record(field(uploaded,'receipt')),original={...s,intent:{...s.intent,custom_form:[{id:'name',name:'texts',value:'原答案'},
      {id:'photo',name:'uploadPicture',value:[image.reference]}]}};
    await draft(original);const q=await quote(original);expect((await images.getSession(f.actor(),s.key)).receipt?.state).toBe('frozen');
    await f.maintenanceDb.update(systemForm).set({status:0}).where(eq(systemForm.id,77));
    const r=await abandon('creation',original);expect(r.status,r.message).toBe(200);proof(r.data,'creation',original);
    expect((await images.getSession(f.actor(),s.key)).receipt?.state).toBe('frozen');expect(f.objects.size).toBe(1);expect(f.remove).not.toHaveBeenCalled();
    expect((await http('/orders',{intent:original.intent,quote_token:q.quote_token},s.key)).status).not.toBe(200);
    await expect(images.createSession(f.actor(),s.key,body)).rejects.toThrow();
    await f.maintenanceDb.update(systemForm).set({status:1}).where(eq(systemForm.id,77));
    const newKey=randomUUID();expect((await images.createSession(f.actor(),newKey,body)).receipt?.state).toBe('active');
    expect((await facts()).orders).toBe(0);expect((await facts()).stock).toBe(10);
  });
});
