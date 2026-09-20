import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '../src/app';
import type { Env } from '../src/env';
import { createContainerFromDb, withTx, type Container } from '../src/lib/di';
import { adminRefundEvidenceFixture } from './helpers/adminRefundEvidenceFixture';
import { adminRefundCreation, adminRefundOperation, storeOrder, storeOrderCartInfo, storeOrderRefund,
  storeOrderRefundPayment, systemAdmin, systemRole, systemConfig, userBrokerage } from '../src/models/schema';
import { WechatPayService } from '../src/services/wechat/WechatPayService';
import { AlipayRefundService } from '../src/services/payment/AlipayRefundService';
import { createToken, md5 } from '../src/utils/jwt';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';
import { lockOrderSettlement } from '../src/services/order/OrderBrokerageService';

// Only the database binding is redirected. Each peer env has its own root
// connection; simultaneous HTTP calls never mutate a global current container.
const wiring=vi.hoisted(()=>({containers:new Map<Env,Container>()}));
vi.mock('../src/lib/di',async importOriginal=>{
  const original=await importOriginal<typeof import('../src/lib/di')>();
  return {...original,createContainer:(env:Env)=>{
    const container=wiring.containers.get(env);if(!container)throw Error('Creation HTTP SQL fixture unavailable');return container;
  }};
});
const app=createApp(),protocol='admin-refund-creation-v1';
const bases=['/adminapi/refund/creation','/api/admin/refund/creation'];
const endpoints=['create','execute','receipt','abandon'] as const;
let f:Awaited<ReturnType<typeof adminRefundEvidenceFixture>>;
beforeEach(async()=>{
  f=await adminRefundEvidenceFixture(undefined,[adminRefundCreation,adminRefundOperation,userBrokerage]);
  wiring.containers.set(f.env,f.container);
  await f.db.update(systemRole).set({rules:'refund.manage'}).where(eq(systemRole.id,1));
  await f.db.update(systemAdmin).set({level:1,roles:'1'}).where(eq(systemAdmin.id,100));
  await f.db.insert(systemRole).values({id:2,type:1,roleName:'Synthetic view-only',rules:'refund.view'});
  await f.db.update(systemAdmin).set({roles:'2'}).where(eq(systemAdmin.id,101));
  await f.db.update(storeOrderCartInfo).set({skuUnique:'qared001'}).where(eq(storeOrderCartInfo.id,1));
  await f.db.insert(systemConfig).values({menuName:'refund_time_available',value:'0'});
  const forbidden=async()=>{throw Error('Unconfigured external I/O');};
  for(const gateway of [WechatPayService,AlipayRefundService])for(const method of ['requestRefund','queryRefund'] as const)
    vi.spyOn(gateway.prototype,method).mockImplementation(forbidden);
  vi.spyOn(globalThis,'fetch').mockImplementation(forbidden);
  for(const method of ['log','warn','error'] as const)vi.spyOn(console,method).mockImplementation(()=>{});
},30000);
afterEach(async()=>{try{expect(fetch).not.toHaveBeenCalled();}finally{wiring.containers.clear();vi.restoreAllMocks();await f?.close();}},45000);
const headers=(key?:string,id=100)=>{
  const h=new Headers({'Authori-zation':`Bearer ${f.tokens.get(id)??''}`,'Content-Type':'application/json','X-Refund-Operation-Scope':`v1:admin:${id}`});
  if(key!==undefined)h.set('Idempotency-Key',key);return h;
};
const send=async(endpoint:typeof endpoints[number],key:string,value:unknown={version:protocol},options:{base?:string;id?:number;env?:Env}={})=>
  app.request(`${options.base??bases[0]}/${endpoint}`,{method:'POST',headers:headers(key,options.id),body:JSON.stringify(value)},options.env??f.env);
const noStore=(r:Response)=>expect(r.headers.get('Cache-Control')).toContain('no-store');
function object(value:unknown):Record<string,unknown> {
  if(!value || typeof value!=='object' || Array.isArray(value))throw Error('Expected HTTP response object');
  return value as Record<string,unknown>;
}
const envelope=async(r:Response)=>{
  noStore(r);const value=object(await r.json());
  if(typeof value.status!=='number' || typeof value.msg!=='string' || !Object.hasOwn(value,'data'))throw Error('Invalid HTTP envelope');
  return {status:value.status,msg:value.msg,data:value.data};
};
async function reviewed(payType:'yue'|'weixin'|'alipay'='yue',mode:'items'|'remaining'='items') {
  await f.db.update(storeOrder).set({payType}).where(eq(storeOrder.id,1));
  const r=await app.request(`${bases[0]}/quote`,{method:'POST',headers:headers(),body:JSON.stringify({
    version:'admin-refund-creation-quote-v1',orderId:1,mode,items:mode==='items'?[{cartId:501,cartNum:1}]:[],
  })},f.env);
  const q=await envelope(r);expect(q.status).toBe(200);const data=object(q.data);
  return {version:protocol,review:object(data.review),mode,items:mode==='items'?data.items:[],quotedPrice:data.quotedPrice,
    refundPrice:mode==='items'?'3.00':'8.00',reason:'Synthetic reviewed creation',quoteFingerprint:data.quoteFingerprint};
}
const creations=()=>f.db.select().from(adminRefundCreation);
const operations=()=>f.db.select().from(adminRefundOperation);
const snapshot=async()=>({business:await f.snapshot(),applications:await f.applications(),audit:await f.statuses(),
  creations:await creations(),operations:await operations()});

it.each(bases)('creates via %s without money and explicitly executes/replays across the other alias',async base=>{
  const value=await reviewed(),key=crypto.randomUUID(),before=await f.snapshot(),other=bases.find(b=>b!==base)!;
  const created=await envelope(await send('create',key,value,{base}));
  expect(created).toMatchObject({status:200,data:{version:protocol,replayed:false,receipt:{version:protocol,adminId:100,requestKey:key,orderId:1,outcome:'created'}}});
  const receipt=object(object(created.data).receipt);
  expect(receipt.refundId).toBeGreaterThan(0);expect(await f.snapshot()).toEqual(before);expect(await operations()).toEqual([]);
  expect(JSON.stringify(created)).not.toMatch(/authVersion|cartInfo|userAddress|Synthetic reviewed creation/);
  expect(await envelope(await send('receipt',key,{version:protocol},{base:other}))).toMatchObject({data:{receipt}});
  expect(await envelope(await send('create',key,value,{base:other}))).toMatchObject({data:{receipt,replayed:true}});
  const result=await envelope(await send('execute',key,value,{base:other}));
  expect(result).toMatchObject({status:200,data:{version:protocol,creation:{receipt,replayed:true},operation:{
    receipt:{refundId:receipt.refundId,requestKey:key,outcome:'balance-settled'},execution:{completed:true,status:'BALANCE_SUCCESS'}}}});
  const after=await snapshot();expect(after.business.users.find(row=>row.uid===11)?.nowMoney).toBe('3.00');
  expect(after.business.bills.filter(row=>row.type==='pay_product_refund')).toHaveLength(1);
  expect(await envelope(await send('execute',key,value,{base}))).toMatchObject({data:{operation:{replayed:true}}});
  expect(await envelope(await send('abandon',key,value,{base}))).toMatchObject({data:{receipt}});
  expect(await snapshot()).toEqual(after);
});

it.each(['items','remaining'] as const)('executes a directly reviewed %s intent with one financial/stock effect',async mode=>{
  const value=await reviewed('yue',mode),key=crypto.randomUUID(),before=await f.snapshot();
  const result=await envelope(await send('execute',key,value));expect(result.status).toBe(200);
  expect(object(object(result.data).creation).replayed).toBe(false);expect(object(object(object(result.data).operation).execution).completed).toBe(true);
  const after=await f.snapshot(),quantity=mode==='items'?1:2;
  expect(after.users.find(row=>row.uid===11)?.nowMoney).toBe(value.refundPrice);
  expect(after.products.find(row=>row.id===70)?.stock).toBe(before.products.find(row=>row.id===70)!.stock+quantity);
  expect(after.skus.find(row=>row.unique==='qared001')?.stock).toBe(before.skus.find(row=>row.unique==='qared001')!.stock+quantity);
  expect(await envelope(await send('execute',key,value))).toMatchObject({data:{operation:{replayed:true}}});
  expect(await f.snapshot()).toEqual(after);expect(await creations()).toHaveLength(1);expect(await operations()).toHaveLength(1);
});

it('missing evidence is read-only and does not fence a later original create',async()=>{
  const value=await reviewed(),key=crypto.randomUUID(),before=await snapshot();
  expect(await envelope(await send('receipt',key))).toMatchObject({status:200,data:{version:protocol,receipt:null}});
  expect(await snapshot()).toEqual(before);
  expect(await envelope(await send('create',key,value))).toMatchObject({status:200,data:{receipt:{outcome:'created'}}});
});

it('durable abandonment fences late create/execute without inventing an application or payment',async()=>{
  const value=await reviewed(),key=crypto.randomUUID(),before=await f.snapshot(),applications=await f.applications();
  const abandoned=await envelope(await send('abandon',key,value));
  expect(abandoned).toMatchObject({status:200,data:{receipt:{outcome:'abandoned',refundId:null}}});
  const receipt=object(abandoned.data).receipt;
  expect(await envelope(await send('create',key,value))).toMatchObject({data:{receipt,replayed:true}});
  expect(await envelope(await send('execute',key,value))).toMatchObject({data:{creation:{receipt,replayed:true},operation:null}});
  expect(await envelope(await send('receipt',key))).toMatchObject({data:{receipt}});
  expect(await f.snapshot()).toEqual(before);expect(await f.applications()).toEqual(applications);expect(await operations()).toEqual([]);
  expect(WechatPayService.prototype.requestRefund).not.toHaveBeenCalled();expect(AlipayRefundService.prototype.requestRefund).not.toHaveBeenCalled();
});

it.each(['created','abandoned'] as const)('rejects changed original bodies against %s evidence across all write endpoints',async state=>{
  const value=await reviewed(),key=crypto.randomUUID();await send(state==='created'?'create':'abandon',key,value);
  const before=await snapshot();
  for(const endpoint of ['create','execute','abandon'] as const)for(const changed of [
    {...value,reason:'Changed original reason'},{...value,refundPrice:'4.00'},
    {...value,items:[{cartId:501,cartNum:2}]},{...value,quoteFingerprint:'a'.repeat(64)},
  ])expect(await envelope(await send(endpoint,key,changed))).toMatchObject({status:409,data:null});
  expect(await snapshot()).toEqual(before);
});

it('uses current Admin scope, requires manage even for lookup, and isolates identical UUIDs by owner',async()=>{
  const value=await reviewed(),key=crypto.randomUUID();const created=await envelope(await send('create',key,value));
  const before=await snapshot();
  for(const endpoint of endpoints)for(const id of [0,101,102,103]){
    const r=await envelope(await send(endpoint,key,endpoint==='receipt'?{version:protocol}:value,{id}));expect(r.status).not.toBe(200);
  }
  expect(await snapshot()).toEqual(before);
  await f.db.update(systemAdmin).set({roles:'1'}).where(eq(systemAdmin.id,101));
  expect(await envelope(await send('receipt',key,{version:protocol},{id:101}))).toMatchObject({status:200,data:{receipt:null}});
  expect(await envelope(await send('abandon',key,value,{id:101}))).toMatchObject({status:200,data:{receipt:{adminId:101,outcome:'abandoned'}}});
  expect(await envelope(await send('receipt',key))).toMatchObject({data:{receipt:object(created.data).receipt}});
  expect(await f.snapshot()).toEqual(before.business);
});

it.each(endpoints.flatMap(endpoint=>['disabled','password','role','expired'].map(change=>({endpoint,change})) ))
  ('rechecks $change after entry authentication while reading $endpoint',async({endpoint,change})=>{
  const value=await reviewed(),key=crypto.randomUUID();await send('create',key,value);const before=await snapshot();
  const auth=vi.spyOn(f.container.systemAdminDao,'get');
  const bytes=new TextEncoder().encode(JSON.stringify(endpoint==='receipt'?{version:protocol}:value));
  const stream=new ReadableStream<Uint8Array>({async pull(controller){
    expect(auth).toHaveBeenCalledExactlyOnceWith(100);
    if(change==='expired')vi.spyOn(Date,'now').mockReturnValue(Date.now()+8*24*3600*1000);
    else await f.db.update(systemAdmin).set(change==='disabled'?{status:0}:change==='password'?{pwd:'changed-synthetic-digest'}:{roles:''}).where(eq(systemAdmin.id,100));
    controller.enqueue(bytes);controller.close();
  }},{highWaterMark:0});
  const init:RequestInit & {duplex:'half'}={method:'POST',headers:headers(key),body:stream,duplex:'half'};
  const r=await app.request(new Request(`http://localhost${bases[0]}/${endpoint}`,init),undefined,f.env);
  expect(await envelope(r)).toMatchObject({status:change==='disabled'?410002:change==='role'?400011:410001,data:null});
  expect(await snapshot()).toEqual(before);
});

it('recovers across a renewed token for the same actor without changing the original creation identity',async()=>{
  const value=await reviewed(),key=crypto.randomUUID(),created=await envelope(await send('create',key,value));
  f.tokens.set(100,(await createToken(100,'admin',md5('synthetic-digest'),f.env.APP_KEY,'cinashop',Math.floor(Date.now()/1000)+1)).token);
  expect(await envelope(await send('receipt',key))).toMatchObject({data:{receipt:object(created.data).receipt}});
  expect(await envelope(await send('execute',key,value))).toMatchObject({status:200,data:{creation:{receipt:object(created.data).receipt,replayed:true}}});
});

it.each(['weixin','alipay'] as const)('keeps creation/admission after unknown %s transport, and only explicit original execution queries recovery',async payType=>{
  const value=await reviewed(payType),key=crypto.randomUUID();
  const gateway=payType==='weixin'?WechatPayService.prototype:AlipayRefundService.prototype;
  vi.mocked(gateway.requestRefund).mockRejectedValueOnce(Error('Synthetic lost transport response'));
  expect((await envelope(await send('execute',key,value))).status).not.toBe(200);
  const evidence=await envelope(await send('receipt',key)),receipt=object(object(evidence.data).receipt);
  expect(receipt).toMatchObject({outcome:'created',requestKey:key});
  expect(await operations()).toMatchObject([{refundId:receipt.refundId,outcome:'provider-admitted'}]);
  expect(await f.db.select().from(storeOrderRefundPayment)).toMatchObject([{providerStatus:'UNKNOWN',attemptCount:1,requestAmount:300}]);
  expect(await envelope(await send('abandon',key,value))).toMatchObject({data:{receipt}});
  expect(gateway.queryRefund).not.toHaveBeenCalled();
  vi.mocked(gateway.queryRefund).mockResolvedValueOnce({status:'SUCCESS',providerRefundId:'synthetic-create-http'});
  expect(await envelope(await send('execute',key,value))).toMatchObject({status:200,data:{creation:{receipt,replayed:true},
    operation:{receipt:{outcome:'provider-admitted'},execution:{completed:true,status:'SUCCESS'}}}});
  expect(gateway.requestRefund).toHaveBeenCalledTimes(1);
  expect(gateway.queryRefund).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({outRefundNo:`CNSR${receipt.refundId}`,refundAmount:300}));
  const after=await snapshot();await send('execute',key,value);expect(await snapshot()).toEqual(after);
});

it('exposes committed creation/admission during gateway I/O and preserves a duplicate in-flight lease',async()=>{
  const value=await reviewed('weixin'),key=crypto.randomUUID();
  vi.mocked(WechatPayService.prototype.requestRefund).mockImplementationOnce(async()=>{
    expect(await envelope(await send('receipt',key))).toMatchObject({data:{receipt:{outcome:'created'}}});
    expect(await operations()).toMatchObject([{outcome:'provider-admitted'}]);
    expect(await envelope(await send('execute',key,value))).toMatchObject({status:200,data:{creation:{replayed:true},
      operation:{execution:{completed:false,status:'PROCESSING'}}}});
    expect(await f.db.select().from(storeOrderRefundPayment)).toMatchObject([{providerStatus:'REQUESTING',attemptCount:1}]);
    return {status:'PROCESSING'};
  });
  expect(await envelope(await send('execute',key,value))).toMatchObject({data:{operation:{execution:{completed:false,status:'PROCESSING'}}}});
  expect(WechatPayService.prototype.requestRefund).toHaveBeenCalledTimes(1);expect(WechatPayService.prototype.queryRefund).not.toHaveBeenCalled();
  expect(await creations()).toHaveLength(1);expect(await operations()).toHaveLength(1);
});

it('rolls back application and audit on creation-receipt failure, without leaking SQL details or moving funds',async()=>{
  const value=await reviewed(),key=crypto.randomUUID(),before=await snapshot();
  await f.exec(`CREATE FUNCTION reject_creation_http() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_PRIVATE_CREATION'; END $$;
    CREATE TRIGGER reject_creation_http BEFORE INSERT ON admin_refund_creation FOR EACH ROW EXECUTE FUNCTION reject_creation_http()`);
  expect(await envelope(await send('execute',key,value))).toEqual({status:500,msg:'系统繁忙,请稍后再试',data:null});
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('SYNTHETIC_PRIVATE_CREATION');
  expect(await snapshot()).toEqual(before);expect(await envelope(await send('receipt',key))).toMatchObject({data:{receipt:null}});
});

it('retains committed creation on financial-receipt failure, then explicitly resumes after fixture repair',async()=>{
  const value=await reviewed(),key=crypto.randomUUID(),before=await f.snapshot();
  await f.exec(`CREATE FUNCTION reject_financial_http() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_PRIVATE_FINANCIAL'; END $$;
    CREATE TRIGGER reject_financial_http BEFORE INSERT ON admin_refund_operation FOR EACH ROW EXECUTE FUNCTION reject_financial_http()`);
  expect(await envelope(await send('execute',key,value))).toEqual({status:500,msg:'系统繁忙,请稍后再试',data:null});
  const receipt=object(object((await envelope(await send('receipt',key))).data).receipt);expect(receipt.outcome).toBe('created');
  expect(await f.snapshot()).toEqual(before);expect(await operations()).toEqual([]);
  await f.exec('DROP TRIGGER reject_financial_http ON admin_refund_operation');
  expect(await envelope(await send('execute',key,value))).toMatchObject({status:200,data:{creation:{receipt,replayed:true},operation:{execution:{completed:true}}}});
  expect(await creations()).toHaveLength(1);expect(await operations()).toHaveLength(1);
});

it('never installs missing creation schema from any HTTP endpoint',async()=>{
  const value=await reviewed(),before=await f.snapshot(),applications=await f.applications();await f.exec('DROP TABLE admin_refund_creation');
  for(const endpoint of endpoints)expect(await envelope(await send(endpoint,crypto.randomUUID(),endpoint==='receipt'?{version:protocol}:value)))
    .toMatchObject({status:500,data:null});
  expect(await f.snapshot()).toEqual(before);expect(await f.applications()).toEqual(applications);expect(await operations()).toEqual([]);
  expect(await f.db.execute(sql`SELECT to_regclass('admin_refund_creation')::text AS name`)).toMatchObject([{name:null}]);
});

it('a missing financial ledger does not erase the application already committed by execute',async()=>{
  const value=await reviewed(),key=crypto.randomUUID(),before=await f.snapshot();await f.exec('DROP TABLE admin_refund_operation');
  expect(await envelope(await send('execute',key,value))).toMatchObject({status:500,data:null});
  expect(await envelope(await send('receipt',key))).toMatchObject({status:200,data:{receipt:{outcome:'created'}}});
  expect(await f.snapshot()).toEqual(before);expect(await creations()).toHaveLength(1);
});

it('recovers durable creation/settlement evidence after business deletion without starting a new application',async()=>{
  const value=await reviewed(),key=crypto.randomUUID(),first=await envelope(await send('execute',key,value));
  await f.db.delete(storeOrderRefund).where(eq(storeOrderRefund.storeOrderId,1));await f.db.delete(storeOrder).where(eq(storeOrder.id,1));
  const before=await snapshot();
  expect(await envelope(await send('receipt',key))).toMatchObject({data:{receipt:object(object(first.data).creation).receipt}});
  expect(await envelope(await send('execute',key,value))).toMatchObject({status:200,data:{creation:{receipt:object(object(first.data).creation).receipt,replayed:true},operation:{receipt:object(object(first.data).operation).receipt,replayed:true}}});
  expect((await envelope(await send('create',crypto.randomUUID(),value))).status).not.toBe(200);expect(await snapshot()).toEqual(before);
});

it('keeps original recovery under a now-invalid policy and rejects newly admitted stale source facts',async()=>{
  const value=await reviewed(),key=crypto.randomUUID();
  await f.db.update(storeOrderCartInfo).set({cartInfo:'{"product":{"storeName":"Changed same-price goods"},"sku":{"price":"5.00"}}'}).where(eq(storeOrderCartInfo.id,1));
  expect(await envelope(await send('create',key,value))).toMatchObject({status:400,data:null});expect(await creations()).toEqual([]);
  const fresh=await reviewed(),created=await envelope(await send('create',key,fresh));
  await f.db.update(systemConfig).set({value:'invalid'}).where(eq(systemConfig.menuName,'refund_time_available'));
  expect(await envelope(await send('create',key,fresh))).toMatchObject({data:{receipt:object(created.data).receipt,replayed:true}});
  expect(await envelope(await send('execute',key,fresh))).toMatchObject({status:200,data:{creation:{receipt:object(created.data).receipt,replayed:true}}});
});

it('rejects bad protocol/body selectors and body-provided authority instead of translating a legacy request',async()=>{
  const value=await reviewed(),before=await snapshot();
  for(const invalid of [null,[],{}, {...value,version:'old'}, {...value,adminId:101}, {...value,requestKey:crypto.randomUUID()},
    {...value,quoteFingerprint:undefined}, {...value,review:{...value.review,uid:'11'}}, {...value,review:{...value.review,extra:1}},
    {...value,items:[{cartId:1,cartNum:1}]}, {...value,items:[{cartId:501,cartNum:3}]}, {...value,refundPrice:'6.00'},
    {...value,reason:'x'.repeat(256)},{...value,reason:''},{...value,mode:'remaining'},{refund_price:'3.00',cart_ids:'501'}]){
    expect((await envelope(await send('create',crypto.randomUUID(),invalid))).status).not.toBe(200);
  }
  for(const invalid of [null,{},value,{version:'old'},{version:protocol,adminId:100}])
    expect(await envelope(await send('receipt',crypto.randomUUID(),invalid))).toMatchObject({status:400,data:null});
  expect(await snapshot()).toEqual(before);
});

it('requires the exact scope/key, bounded UTF-8 JSON and no query parameters',async()=>{
  const value=await reviewed(),before=await snapshot();
  for(const [name,bad] of [['Idempotency-Key',''],['Idempotency-Key','old-key'],['Idempotency-Key',`${crypto.randomUUID()}, ${crypto.randomUUID()}`],
    ['X-Refund-Operation-Scope','v1:admin:0100'],['X-Refund-Operation-Scope','v1:admin:101'],['X-Refund-Operation-Scope',''],
    ['Content-Type','text/plain'],['Content-Type','application/json; charset=utf-16'],['Content-Encoding','gzip'],
    ['Content-Length','8193'],['Content-Length','invalid']]){
    const h=headers(crypto.randomUUID());h.set(name,bad);
    const r=await app.request(`${bases[0]}/create`,{method:'POST',headers:h,body:JSON.stringify(value)},f.env);
    expect(await envelope(r)).toMatchObject({status:name==='X-Refund-Operation-Scope'?412:400,data:null});
  }
  for(const endpoint of endpoints)for(const raw of ['{',' '.repeat(8193),new Uint8Array([0xff,0xfe])])
    expect(await envelope(await app.request(`${bases[0]}/${endpoint}`,{method:'POST',headers:headers(crypto.randomUUID()),body:raw},f.env))).toMatchObject({status:400,data:null});
  expect(await envelope(await app.request(`${bases[0]}/receipt?key=forbidden`,{method:'POST',headers:headers(crypto.randomUUID()),body:JSON.stringify({version:protocol})},f.env))).toMatchObject({status:400,data:null});
  expect(await snapshot()).toEqual(before);
});

it('cancels oversized streams even when Content-Length lies and applies the tighter receipt limit',async()=>{
  let cancelled=false;
  const stream=new ReadableStream<Uint8Array>({pull(c){c.enqueue(new Uint8Array(8193).fill(32));},cancel(){cancelled=true;}},{highWaterMark:0});
  const h=headers(crypto.randomUUID());h.set('Content-Length','1');
  const init:RequestInit & {duplex:'half'}={method:'POST',headers:h,body:stream,duplex:'half'};
  expect(await envelope(await app.request(new Request(`http://localhost${bases[0]}/create`,init),undefined,f.env))).toMatchObject({status:400,data:null});
  expect(cancelled).toBe(true);
  expect(await envelope(await app.request(`${bases[0]}/receipt`,{method:'POST',headers:headers(crypto.randomUUID()),body:' '.repeat(513)},f.env))).toMatchObject({status:400,data:null});
  expect(await creations()).toEqual([]);
});

it('requires production token storage, does not dispatch alternate methods and honors only allowed CORS origins',async()=>{
  const value=await reviewed(),before=await snapshot();
  for(const method of ['GET','HEAD','PUT','DELETE'])for(const endpoint of endpoints){
    const r=await app.request(`${bases[0]}/${endpoint}`,{method,headers:headers(crypto.randomUUID())},f.env);noStore(r);
    if(method!=='HEAD')expect(object(await r.json()).status).not.toBe(200);
  }
  const allowed=await app.request(`${bases[0]}/execute`,{method:'OPTIONS',headers:{Origin:'http://localhost:5173',
    'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type,authori-zation,idempotency-key,x-refund-operation-scope'}},f.env);
  expect(allowed.headers.get('Access-Control-Allow-Headers')?.toLowerCase()).toContain('x-refund-operation-scope');
  const denied=await app.request(`${bases[0]}/execute`,{method:'OPTIONS',headers:{Origin:'https://not-authorized.invalid',
    'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type,authori-zation,idempotency-key,x-refund-operation-scope'}},f.env);
  expect(denied.headers.get('Access-Control-Allow-Origin')).toBeNull();noStore(denied);expect(await snapshot()).toEqual(before);
  f.env.NODE_ENV='production';const r=await send('execute',crypto.randomUUID(),value);expect(r.status).toBe(503);noStore(r);
  expect(await snapshot()).toEqual(before);
});

describe.runIf(!!process.env.TEST_FINANCE_POSTGRES_URL)('independent real HTTP/PG16 backends',()=>{
  it('serializes two original execute requests into one application and one balance effect',async()=>{
    const value=await reviewed(),key=crypto.randomUUID();
    await withFinancePeers(f.db,async peers=>{
      const envs=peers.slice(0,2).map(peer=>{const env={...f.env};wiring.containers.set(env,createContainerFromDb(peer.db));return env;});
      const results=await Promise.all(envs.map(env=>send('execute',key,value,{env}).then(envelope)));
      expect(results.map(r=>r.status)).toEqual([200,200]);
      expect(object(object(results[0].data).creation).receipt).toEqual(object(object(results[1].data).creation).receipt);
      expect(object(object(results[0].data).operation).receipt).toEqual(object(object(results[1].data).operation).receipt);
    });
    expect(await creations()).toHaveLength(1);expect(await operations()).toHaveLength(1);
    expect((await f.snapshot()).users.find(row=>row.uid===11)?.nowMoney).toBe('3.00');
    expect((await f.snapshot()).bills.filter(row=>row.type==='pay_product_refund')).toHaveLength(1);
  });
  it('a create proven waiting for its order commits before a competing abandonment can report its original outcome',async()=>{
    const value=await reviewed(),key=crypto.randomUUID(),before=await f.snapshot();
    await withFinancePeers(f.db,async([blocker,writer,abandoner])=>{
      const writerEnv={...f.env},abandonEnv={...f.env};
      wiring.containers.set(writerEnv,createContainerFromDb(writer.db));wiring.containers.set(abandonEnv,createContainerFromDb(abandoner.db));
      let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{entered=r;});
      const held=outcome(withTx(createContainerFromDb(blocker.db),async tx=>{await lockOrderSettlement(tx,1);entered();await gate;}));
      let pending:Promise<Response>|undefined,abandoned:Promise<Response>|undefined;
      try{await ready;pending=send('create',key,value,{env:writerEnv});await waitForFinanceBlock(f.db,writer.pid,blocker.pid);
        abandoned=send('abandon',key,value,{env:abandonEnv});await waitForFinanceBlock(f.db,abandoner.pid,writer.pid);release();
        expect((await held).ok).toBe(true);const created=await envelope(await pending),result=await envelope(await abandoned);
        expect(created).toMatchObject({status:200,data:{receipt:{outcome:'created'}}});expect(object(result.data).receipt).toEqual(object(created.data).receipt);
      }finally{release();await held;await pending;await abandoned;}
    });
    expect(await f.snapshot()).toEqual(before);expect(await creations()).toHaveLength(1);expect(await operations()).toEqual([]);
  });
});
