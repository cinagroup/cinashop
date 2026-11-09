/** Real Admin JWT, live permission, production router and independent LOGIN.
 * Only Redis/KV/Queue/ID/fetch transports are local; all payment/refund rows
 * are authored through the production producer/claim/RSA/economic paths. */
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Hono } from 'hono';
import { eq,sql } from 'drizzle-orm';
import { beforeAll,afterAll,afterEach,describe,expect,it,vi } from 'vitest';
import type { AppVariables,Env } from '@/env';
import type { DbClient } from '@/lib/di';
import * as Di from '@/lib/di';
import { adminRechargeRefundRoutes } from '@/routes/admin-recharge-refunds';
import { errorHandler } from '@/middleware/error';
import { runRechargeRefundNoticeUpgrade } from '@/migrations/rechargeRefundNotice';
import { systemAdmin,user,userRecharge,capitalFlow,storeOrderOutbox } from '@/models/schema';
import { createToken,md5 } from '@/utils/jwt';
import { RECHARGE_REFUND_VERSION,rechargeRefundIdentity,type RechargeRefundRequest } from '@/services/payment/RechargeRefundRequest';
import type { AdminRechargeRefundView } from '@/services/admin/AdminRechargeRefundReadService';
import type { quoteAdminRechargeRefund } from '@/services/admin/AdminRechargeRefundAdmission';
import { rechargeAuthorUids,type AuthorRecharge } from './helpers/rechargeRefundAdminAuthorNative';
import { rechargeRefundHttpNativeFixture,type RechargeRefundHttpNativeFixture } from './helpers/rechargeRefundHttpNative';

const transport=vi.hoisted(()=>{
 const values=new Map<string,unknown>();
 const get=vi.fn(async(key:string)=>values.get(key)??null),set=vi.fn(async(key:string,value:unknown)=>{values.set(key,value);return true;});
 const remove=vi.fn(async(key:string)=>values.delete(key)),take=vi.fn(async(key:string)=>{const value=values.get(key)??null;values.delete(key);return value;});
 const setIfAbsent=vi.fn(async(key:string,value:unknown)=>{if(values.has(key))return false;values.set(key,value);return true;});
 const redis={eval:vi.fn(async()=>1),get,set:vi.fn(async(key:string,value:unknown)=>{await set(key,value);return'OK';}),del:vi.fn(async(key:string)=>Number(await remove(key)))};
 return{values,get,set,remove,take,setIfAbsent,redis};
});
vi.mock('@upstash/redis/cloudflare',()=>({Redis:class{constructor(){return transport.redis;}}}));
vi.mock('@/utils/cache',async original=>({...await original<typeof import('@/utils/cache')>(),getRedis:()=>transport.redis,
 cacheGet:transport.get,cacheSet:transport.set,cacheTake:transport.take,cacheDelete:transport.remove,cacheSetIfAbsent:transport.setIfAbsent}));

type Name='success'|'closed'|'unknown'|'badSignature'|'rollback'|'lostAck'|'cancel'|'insufficient';
interface Specimen {order:AuthorRecharge;key:string;body:RechargeRefundRequest}
const version={version:RECHARGE_REFUND_VERSION},aliases=['/api/admin/finance/recharge-refunds','/adminapi/finance/recharge-refunds'];
type Envelope={status:number;msg:string;data:unknown};
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('real Admin recharge refund HTTP',()=>{
 let f:RechargeRefundHttpNativeFixture,h:Hono<{Bindings:Env;Variables:AppVariables}>,setup:Promise<void>|undefined,pending:Promise<unknown>|undefined;
 let token='',opens=0,closes=0,active=0,busy=false,fault:'none'|'rollback'|'lost-ack'='none',faults=0;
 const specimens=new Map<Name,Specimen>(),errors:Error[]=[];
 const start=<T>(run:()=>Promise<T>)=>{if(busy)throw Error('Previous HTTP business pending');busy=true;
  const work=run().finally(()=>{busy=false;});pending=work;void work.catch(()=>undefined);return work;};
 beforeAll(async()=>{setup=(async()=>{
  f=await rechargeRefundHttpNativeFixture(transport.values);
  const [index]=await f.maintenanceDb.execute<{present:boolean}>(sql`SELECT pg_catalog.to_regclass('public.cf_event_key_uq') IS NOT NULL AS present`);
  if(!index)throw Error('Owned flow catalog missing');if(!index.present)await f.maintenanceDb.execute(sql`CREATE UNIQUE INDEX cf_event_key_uq ON public.capital_flow USING btree(event_key)`);
  await runRechargeRefundNoticeUpgrade(f.maintenanceDb);
  h=new Hono<{Bindings:Env;Variables:AppVariables}>();h.use('*',async(c,next)=>{c.set('container',f.appContainer);await next();});
  for(const alias of aliases)h.route(alias,adminRechargeRefundRoutes);h.onError(errorHandler);
  const actual=Di.createAdminDatabaseSession;
  vi.spyOn(Di,'createAdminDatabaseSession').mockImplementation(env=>{
   const session=actual(env),root=session.container.db;opens++;active++;
   const wrapped=Object.create(root) as DbClient;Object.defineProperty(wrapped,'$client',{value:root.$client});
   Object.defineProperty(wrapped,'transaction',{value:async(work:(tx:DbClient)=>Promise<unknown>,options:Parameters<DbClient['transaction']>[1])=>{
    let economic=false;
    const value=await root.transaction(async raw=>{
     const result=await work(raw as unknown as DbClient);
     economic=!!result&&typeof result==='object'&&'captured'in result&&result.captured===true&&'replayed'in result&&result.replayed===false;
     if(economic&&fault==='rollback'){fault='none';faults++;const e=Error('Actual HTTP economic rollback');errors.push(e);throw e;}
     return result;
    },options);
    if(economic&&fault==='lost-ack'){fault='none';faults++;const e=Error('Actual HTTP economic COMMIT lost acknowledgement');errors.push(e);throw e;}
    return value;
   }});
   return{container:Di.createContainerFromDb(wrapped),close:async()=>{try{await session.close();}finally{closes++;active--;}}};
  });
 })();await setup;},240000);
 afterAll(async()=>{try{if(setup)await Promise.allSettled([setup]);if(pending)await Promise.allSettled([pending]);}
  finally{try{await f?.close();}finally{vi.restoreAllMocks();}}},30000);
 afterEach(()=>{expect(active).toBe(0);expect(closes).toBe(opens);});
 function specimen(name:Name){const s=specimens.get(name);if(!s)throw Error('Missing real paid specimen '+name);return s;}
 async function call(path:string,key:string=randomUUID(),body:unknown=version,options:{token?:string;scope?:string;headers?:Record<string,string>;alias?:number}={}){
  const headers={'Content-Type':'application/json','Authorization':'Bearer '+(options.token??token),'Idempotency-Key':key,
   'X-Recharge-Refund-Scope':options.scope??`v1:admin:${f.actor().id}`,...options.headers};
  const response=await h.request(aliases[options.alias??0]+'/'+path,{method:'POST',headers,body:JSON.stringify(body)},{...f.env,UPSTASH_REDIS_URL:'https://redis.example',UPSTASH_REDIS_TOKEN:'synthetic-local-redis'});
  expect(response.headers.get('Cache-Control')).toContain('private');expect(response.headers.get('Cache-Control')).toContain('no-store');expect(response.headers.get('Pragma')).toBe('no-cache');
  const text=await response.text();for(const secret of[f.env.APP_KEY,'recharge_refund_actual_payer','BEGIN PRIVATE KEY','BEGIN PUBLIC KEY'])expect(text).not.toContain(secret);
  return{response,body:JSON.parse(text) as Envelope,text};
 }
 async function view(s:Specimen,alias=0){const r=await call('execution',s.key,version,{alias});expect(r.body.status,r.body.msg).toBe(200);return r.body.data as AdminRechargeRefundView;}
 it('creates a real Admin JWT and enforces its live Redis bucket without opening Admin for failures',()=>start(async()=>{
  const issued=await createToken(f.actor().id,'admin',f.actor().authVersion,f.env.APP_KEY);token=issued.token;
  const bucket={uid:f.actor().id,type:'admin',token,exp:issued.exp};
  const before=opens;expect((await call('receipt')).body.status).not.toBe(200);expect(opens).toBe(before);
  transport.values.set('tb_'+md5(token),bucket);
  const good=await call('receipt');expect(good.body.status,good.body.msg).toBe(200);expect(good.body.data).toEqual({version:RECHARGE_REFUND_VERSION,receipt:null});
  expect(opens).toBe(before+1);
 }),5000);
 it.each(aliases)('authenticates the dedicated permission and private missing receipt at %s',alias=>start(async()=>{
  const r=await call('receipt',randomUUID(),version,{alias:aliases.indexOf(alias)});expect(r.body.status,r.body.msg).toBe(200);
  expect(r.body.data).toEqual({version:RECHARGE_REFUND_VERSION,receipt:null});
 }),5000);
 it.each(['scope','version','extra','query','key','encoding','bodyType'] as const)('rejects closed HTTP input %s without merchant I/O',kind=>start(async()=>{
  const posts=f.posts.length,gets=f.gets.length;
  const r=await call(kind==='query'?'receipt?key=leak':'receipt',kind==='key'?'bad key':randomUUID(),
   kind==='version'?{version:'wrong'}:kind==='extra'?{...version,operationId:randomUUID()}:version,
   {scope:kind==='scope'?'v1:admin:1':undefined,headers:kind==='encoding'?{'Content-Encoding':'gzip'}:kind==='bodyType'?{'Content-Type':'text/plain'}:undefined});
  expect(r.body.status).not.toBe(200);expect(f.posts).toHaveLength(posts);expect(f.gets).toHaveLength(gets);
 }),5000);
 it.each(['disabled','password','wrongGrant','apiRealm'] as const)('refuses %s before opening an independent Admin session',kind=>start(async()=>{
  const before=opens;
  try{
   let other=token;
   if(kind==='disabled')await f.maintenanceDb.update(systemAdmin).set({status:0}).where(eq(systemAdmin.id,f.actor().id));
   if(kind==='password')await f.maintenanceDb.update(systemAdmin).set({pwd:'controlled-new-password'}).where(eq(systemAdmin.id,f.actor().id));
   if(kind==='wrongGrant')await f.rules('refund.manage,order.manage,recharge_order.view');
   if(kind==='apiRealm'){
    const issued=await createToken(f.actor().id,'api',f.actor().authVersion,f.env.APP_KEY);other=issued.token;
    transport.values.set('tb_'+md5(other),{uid:f.actor().id,type:'admin',token:other,exp:issued.exp});
   }
   expect((await call('receipt',randomUUID(),version,{token:other})).body.status).not.toBe(200);expect(opens).toBe(before);
  }finally{
   if(kind==='disabled')await f.maintenanceDb.update(systemAdmin).set({status:1}).where(eq(systemAdmin.id,f.actor().id));
   if(kind==='password')await f.maintenanceDb.update(systemAdmin).set({pwd:'recharge-refund-author-password'}).where(eq(systemAdmin.id,f.actor().id));
   if(kind==='wrongGrant')await f.rules('recharge_order.refund');
  }
 }),5000);
 it.each(['success','closed','unknown','badSignature','rollback','lostAck','cancel','insufficient'] as const)('authors a real paid order and HTTP quote for %s',name=>start(async()=>{
  const index=['success','closed','unknown','badSignature','rollback','lostAck','cancel','insufficient'].indexOf(name);
  if(index===0)await f.approve(2,'active',['refund_request','refund_query']);const paid=await f.paid(rechargeAuthorUids[index]);
  if(name==='insufficient')await f.spend(paid.order.uid);
  const key=randomUUID(),r=await call('quote/'+paid.order.id,key);expect(r.body.status,r.body.msg).toBe(200);
  const quote=r.body.data as Awaited<ReturnType<typeof quoteAdminRechargeRefund>>;
  expect(quote.options.map(o=>o.recoverGift)).toEqual([false,true]);expect(quote.options.every(o=>o.sufficient)).toBe(name!=='insufficient');
  specimens.set(name,{order:paid.order,key,body:f.body(paid.order,quote,name!=='closed')});
 }),5000);
 it('durably rejects insufficient balance before hold/attempt/POST and preserves its original refusal',()=>start(async()=>{
  const s=specimen('insufficient'),before=await f.wallet(s.order.uid),posts=f.posts.length;
  const r=await call('execute/'+s.order.id,s.key,s.body);expect(r.body.status,r.body.msg).toBe(200);
  expect((r.body.data as AdminRechargeRefundView).execution).toMatchObject({phase:'rejected_insufficient',wallet:'none',attemptCount:0});
  expect(await f.wallet(s.order.uid)).toBe(before);expect(f.posts).toHaveLength(posts);
  expect((await view(s)).receipt).toMatchObject({admission:'rejected_insufficient',walletDebitCents:1150,postBalance:before});
  expect((await f.maintenanceDb.execute(sql`SELECT * FROM public.recharge_refund_attempt WHERE operation_id IN
   (SELECT operation_id FROM public.recharge_refund_operation WHERE request_key=${s.key})`))).toHaveLength(0);
  expect((await call('execute/'+s.order.id,s.key,s.body)).body.status).toBe(200);expect(f.posts).toHaveLength(posts);
 }),5000);
 it('sends one v2 first POST only after actual COMMIT, captures principal and restores both aliases without resend',()=>start(async()=>{
  const s=specimen('success'),r=await f.observeFirst('SUCCESS',()=>call('execute/'+s.order.id,s.key,s.body));
  expect(r.body.status,r.body.msg).toBe(200);expect((r.body.data as AdminRechargeRefundView).execution).toMatchObject({phase:'succeeded',wallet:'captured',attemptCount:1});
  expect(await f.wallet(s.order.uid)).toBe('0.00');expect(f.committed.at(-1)?.credentialVersion).toBe(2);
 }),5000);
 it('reads/replays the original success and immutable request hash without reconstructing a quote or provider I/O',()=>start(async()=>{
  const s=specimen('success'),before=await f.snapshot(s.order),posts=f.posts.length,gets=f.gets.length;
  const a=await view(s,1),r=await call('execute/'+s.order.id,s.key,s.body,{alias:1});expect(r.body.status,r.body.msg).toBe(200);
  expect((r.body.data as AdminRechargeRefundView).receipt).toEqual(a.receipt);
  expect(a.receipt.requestHash).toBe((await rechargeRefundIdentity(f.actor().id,s.key,s.body)).requestHash);expect(a.receipt.recoverGift).toBe(s.body.recoverGift);
  expect(await f.snapshot(s.order)).toBe(before);expect(f.posts).toHaveLength(posts);expect(f.gets).toHaveLength(gets);
 }),5000);
 it('returns full held principal on verified CLOSED while retaining the selected original gift',()=>start(async()=>{
  const s=specimen('closed'),r=await f.observeFirst('CLOSED',()=>call('execute/'+s.order.id,s.key,s.body));
  expect(r.body.status,r.body.msg).toBe(200);expect((r.body.data as AdminRechargeRefundView).execution).toMatchObject({phase:'released',wallet:'released',attemptCount:1});
  expect(await f.wallet(s.order.uid)).toBe('11.50');expect((await view(s)).receipt).toMatchObject({walletDebitCents:1000,postBalance:'1.50'});
 }),5000);
 it.each(['unknown','badSignature'] as const)('preserves the original held first attempt for %s and never retries its POST',name=>start(async()=>{
  const s=specimen(name),r=await f.observeFirst(name==='unknown'?'UNKNOWN':'bad-signature',()=>call('execute/'+s.order.id,s.key,s.body));
  expect(r.body.status===200).toBe(name==='unknown');const v=await view(s);expect(v.execution).toMatchObject({phase:'awaiting_provider',wallet:'held',attemptCount:1});
  expect(await f.wallet(s.order.uid)).toBe('0.00');const posts=f.posts.length;
  const retry=await call('execute/'+s.order.id,s.key,s.body);expect(retry.body.status,retry.body.msg).toBe(200);expect(f.posts).toHaveLength(posts);
 }),5000);
 it.each(['rollback','lostAck'] as const)('keeps independently committed provider truth across actual money %s',name=>start(async()=>{
  const s=specimen(name);fault=name==='rollback'?'rollback':'lost-ack';
  const r=await f.observeFirst('SUCCESS',()=>call('execute/'+s.order.id,s.key,s.body));expect(r.body.status).not.toBe(200);expect(fault).toBe('none');
  expect((await view(s)).execution.phase).toBe(name==='rollback'?'awaiting_local':'succeeded');
 }),5000);
 it.each(['rollback','lostAck'] as const)('recovers stored first SUCCESS for %s without another POST or GET',name=>start(async()=>{
  const s=specimen(name),posts=f.posts.length,gets=f.gets.length,r=await call('query',s.key);
  expect(r.body.status,r.body.msg).toBe(200);expect((r.body.data as AdminRechargeRefundView).execution).toMatchObject({phase:'succeeded',wallet:'captured',attemptCount:1});
  expect(f.posts).toHaveLength(posts);expect(f.gets).toHaveLength(gets);expect(await f.wallet(s.order.uid)).toBe('0.00');
 }),5000);
 it('cancels only the actual unused reservation and verifies the immutable release on repeat',()=>start(async()=>{
  const s=specimen('cancel');await f.admit(s.key,s.body);const posts=f.posts.length;
  const r=await call('cancel/'+s.order.id,s.key);expect(r.body.status,r.body.msg).toBe(200);
  expect((r.body.data as AdminRechargeRefundView).execution).toMatchObject({phase:'cancelled',wallet:'released',attemptCount:0});
  expect(await f.wallet(s.order.uid)).toBe('11.50');expect(f.posts).toHaveLength(posts);
 }),5000);
 it('does not release a sent attempt or release a cancelled hold twice',()=>start(async()=>{
  const s=specimen('cancel'),before=await f.snapshot(s.order),posts=f.posts.length;
  expect((await call('cancel/'+s.order.id,s.key)).body.status).toBe(200);expect((await call('execute/'+s.order.id,s.key,s.body)).body.status).toBe(200);
  expect(await f.snapshot(s.order)).toBe(before);expect(f.posts).toHaveLength(posts);
  const sent=specimen('unknown');expect((await call('cancel/'+sent.order.id,sent.key)).body.status).not.toBe(200);
 }),5000);
 it('abandons a missing original key without creating a hold and cannot relabel an admitted operation',()=>start(async()=>{
  const s=specimen('success'),key=randomUUID(),before=await f.wallet(s.order.uid),posts=f.posts.length;
  const abandoned=await call('abandon/'+s.order.id,key,s.body);expect(abandoned.body.status,abandoned.body.msg).toBe(200);
  expect(abandoned.body.data).toMatchObject({receipt:{admission:'abandoned'}});
  const prior=await call('abandon/'+s.order.id,s.key,s.body);expect(prior.body.status).toBe(200);expect(prior.body.data).toMatchObject({receipt:{admission:'reserved'}});
  expect(await f.wallet(s.order.uid)).toBe(before);expect(f.posts).toHaveLength(posts);
 }),5000);
 it('rejects path/body or key/body substitution and never exposes another Admin original key',()=>start(async()=>{
  const s=specimen('success'),posts=f.posts.length;
  expect((await call('execute/'+(s.order.id+1),s.key,s.body)).body.status).not.toBe(200);
  expect((await call('execute/'+s.order.id,s.key,{...s.body,recoverGift:!s.body.recoverGift})).body.status).not.toBe(200);
  const id=f.actor().id+1,pwd='second-real-admin';await f.maintenanceDb.insert(systemAdmin).values({id,account:'second-recharge-admin',pwd,adminType:1,level:1,roles:String(f.actor().id),status:1,isDel:0});
  const issued=await createToken(id,'admin',md5(pwd),f.env.APP_KEY);transport.values.set('tb_'+md5(issued.token),{uid:id,type:'admin',token:issued.token,exp:issued.exp});
  const other=await call('receipt',s.key,version,{token:issued.token,scope:`v1:admin:${id}`});expect(other.body.status,other.body.msg).toBe(200);
  expect(other.body.data).toEqual({version:RECHARGE_REFUND_VERSION,receipt:null});expect(f.posts).toHaveLength(posts);
 }),5000);
 describe('query only after the real immutable 60-second fence',()=>{
  beforeAll(async()=>{if(busy)throw Error('Business pending before real wait');const began=performance.now();await delay(61000);
   console.log('RECHARGE_HTTP_REAL_WAIT '+JSON.stringify({elapsedMs:Math.floor(performance.now()-began)}));},240000);
  it.each([['unknown','SUCCESS'],['badSignature','CLOSED']] as const)('uses actual Admin GET/independent result/own money author for %s',(name,outcome)=>start(async()=>{
   const s=specimen(name),prior=await view(s),posts=f.posts.length;
   const r=await f.observeRecoveryQuery('admin',prior.receipt.operationId,outcome,()=>call('query',s.key));
   expect(r.body.status,r.body.msg).toBe(200);expect((r.body.data as AdminRechargeRefundView).execution).toMatchObject({phase:outcome==='SUCCESS'?'succeeded':'released',attemptCount:2});
   expect(f.posts).toHaveLength(posts);expect(f.gets.at(-1)?.ordinal).toBe(2);
  }),5000);
  it('reads terminal history after current credentials/approval and current wallet change without external I/O',()=>start(async()=>{
   const s=specimen('unknown'),before=await view(s),posts=f.posts.length,gets=f.gets.length,registry=f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS;
   await f.approve(2,'revoked');f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS='{"format":1,"credentials":[]}';
   await f.maintenanceDb.update(user).set({nowMoney:'-0.25'}).where(eq(user.uid,s.order.uid));
   try{expect(await view(s)).toEqual(before);expect((await call('query',s.key)).body.status).toBe(200);expect(await f.wallet(s.order.uid)).toBe('-0.25');}
   finally{f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS=registry;}
   expect(f.posts).toHaveLength(posts);expect(f.gets).toHaveLength(gets);
  }),5000);
  it('rejects altered physical flow or notice on read without repairing it or changing money',()=>start(async()=>{
   const s=specimen('success'),v=await view(s),event='recharge.refund:'+v.receipt.operationId;
   const [flow]=await f.maintenanceDb.select().from(capitalFlow).where(eq(capitalFlow.eventKey,event));expect(flow).toBeDefined();
   await f.maintenanceDb.update(capitalFlow).set({price:'-9.99'}).where(eq(capitalFlow.id,flow.id));
   try{const before=await f.wallet(s.order.uid);expect((await call('execution',s.key)).body.status).not.toBe(200);expect(await f.wallet(s.order.uid)).toBe(before);}
   finally{await f.maintenanceDb.update(capitalFlow).set({price:flow.price}).where(eq(capitalFlow.id,flow.id));}
   const key='recharge.refund.success.notice:'+v.receipt.operationId;
   const [notice]=await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventKey,key));expect(notice).toBeDefined();
   await f.maintenanceDb.update(storeOrderOutbox).set({aggregateId:notice.aggregateId+1}).where(eq(storeOrderOutbox.id,notice.id));
   try{expect((await call('execution',s.key)).body.status).not.toBe(200);}finally{await f.maintenanceDb.update(storeOrderOutbox).set({aggregateId:notice.aggregateId}).where(eq(storeOrderOutbox.id,notice.id));}
  }),5000);
  it.each(['success','rollback','lostAck','unknown'] as const)('retains one principal capture and local row for %s',name=>start(async()=>{
   const s=specimen(name),v=await view(s),id=v.receipt.operationId;
   const [order]=await f.maintenanceDb.select().from(userRecharge).where(eq(userRecharge.id,s.order.id));expect(order.refundPrice).toBe('10.00');
   expect(await f.maintenanceDb.select().from(capitalFlow).where(eq(capitalFlow.eventKey,'recharge.refund:'+id))).toHaveLength(1);
   expect(await f.maintenanceDb.execute(sql`SELECT * FROM public.recharge_refund_result WHERE operation_id=${id}::uuid AND source='local_settlement'`)).toHaveLength(1);
  }),5000);
  it('retains actual principal amounts, one local row/flow/notice and no extra provider POST',()=>start(async()=>{
   expect(faults).toBe(2);expect(errors).toHaveLength(2);expect(f.posts).toHaveLength(6);expect(f.gets).toHaveLength(2);expect(f.committed).toHaveLength(6);
   console.log('RECHARGE_HTTP_NATIVE_PROOF '+JSON.stringify({actualJwt:true,actualRedisBucket:true,actualAdminFactory:true,opens,closes,
    bothAliases:true,insufficientBeforePost:true,optionalGift:true,firstClaimCommitVisible:true,credentialVersions:f.committed.map(x=>x.credentialVersion),
    independentProviderCommit:true,actualMoneyRollback:true,actualMoneyCommitLostAck:true,storedFirstRecoveryWithoutGet:true,
    queryGetCount:f.gets.length,firstPostCount:f.posts.length,privateReadsNoMoney:true,passiveNoticeOnly:true}));
  }),5000);
 });
});
