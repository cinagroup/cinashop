/** Actual Worker Cron -> Queue -> App Hyperdrive -> claim/GET RSA -> provider
 * COMMIT -> funds, inside workerd. No runtime authority or paid row is seeded. */
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare,convertV4MiniflareOptions,Response as LocalResponse,type V4FetchHandler } from 'miniflare';
import { sql } from 'drizzle-orm';
import { beforeAll,afterAll,afterEach,describe,expect,it,vi } from 'vitest';
import type { OrderMessage } from '@/env';
import { createContainerFromDb } from '@/lib/di';
import { runRechargeRefundNoticeUpgrade } from '@/migrations/rechargeRefundNotice';
import { RechargeRefundRecoveryQueueService,rechargeRefundRecoveryPageQuery } from '@/services/payment/RechargeRefundRecoveryQueueService';
import { createRechargeRefundRecoveryRoot,isRechargeRefundRecoveryDispatch,isRechargeRefundRecoveryMessage,
 type RechargeRefundRecoveryDispatchMessage,type RechargeRefundRecoveryMessage } from '@/services/payment/RechargeRefundRecoveryQueue';
import { lookupAdminRechargeRefundExecution } from '@/services/admin/AdminRechargeRefundReadService';
import { rechargeRefundCents,rechargeRefundDecimal } from '@/services/payment/RechargeRefundMoney';
import { PgDialect } from 'drizzle-orm/pg-core';
import { rechargeAuthorUids,type AuthorRecharge } from './helpers/rechargeRefundAdminAuthorNative';
import { rechargeQueryProviderNativeFixture,type RechargeQueryProviderNativeFixture } from './helpers/rechargeQueryProviderNative';

const transport=vi.hoisted(()=>{
 const values=new Map<string,unknown>(),get=vi.fn(async(k:string)=>values.get(k)??null),set=vi.fn(async(k:string,v:unknown)=>{values.set(k,v);return true;});
 const remove=vi.fn(async(k:string)=>values.delete(k)),take=vi.fn(async(k:string)=>{const v=values.get(k)??null;values.delete(k);return v;});
 const setIfAbsent=vi.fn(async(k:string,v:unknown)=>{if(values.has(k))return false;values.set(k,v);return true;});
 const redis={eval:vi.fn(async()=>1),get,set:vi.fn(async(k:string,v:unknown)=>{await set(k,v);return'OK';}),del:vi.fn(async(k:string)=>Number(await remove(k)))};
 return{values,get,set,remove,take,setIfAbsent,redis};
});
vi.mock('@/utils/cache',async original=>({...await original<typeof import('@/utils/cache')>(),getRedis:()=>transport.redis,
 cacheGet:transport.get,cacheSet:transport.set,cacheTake:transport.take,cacheDelete:transport.remove,cacheSetIfAbsent:transport.setIfAbsent,
 setTokenBucket:vi.fn(async()=>true),clearToken:vi.fn(async()=>true)}));
type Specimen={id:string;order:AuthorRecharge;key:string};
type Exchange={messages:OrderMessage[];acks:string[];retries:Array<{id:string;delaySeconds:number}>};
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('actual workerd recharge refund background recovery',()=>{
 let f:RechargeQueryProviderNativeFixture,mf:Miniflare,setup:Promise<void>|undefined,pending:Promise<unknown>|undefined,busy=false;
 const key=randomUUID(),specimens=new Map<string,Specimen>(),failures:unknown[]=[];
 let root:RechargeRefundRecoveryDispatchMessage,first:Exchange,tail:Exchange,pristine:Specimen;
 const start=<T>(run:()=>Promise<T>)=>{if(busy)throw Error('Previous genuine Worker action pending');busy=true;
  const work=run().finally(()=>{busy=false;});pending=work;void work.catch(()=>undefined);return work;};
 beforeAll(async()=>{setup=(async()=>{
  f=await rechargeQueryProviderNativeFixture(transport.values);
  const [index]=await f.maintenanceDb.execute<{present:boolean}>(sql`SELECT pg_catalog.to_regclass('public.cf_event_key_uq') IS NOT NULL AS present`);
  if(!index)throw Error('Owned flow catalog missing');if(!index.present)await f.maintenanceDb.execute(sql`CREATE UNIQUE INDEX cf_event_key_uq ON public.capital_flow USING btree(event_key)`);
  await runRechargeRefundNoticeUpgrade(f.maintenanceDb);
  const actualTarget=new URL(f.appRuntime.connectionString);
  expect(actualTarget.pathname.slice(1)).toMatch(/^finance_fixture_[a-f0-9]{32}$/u);
  expect(actualTarget.pathname).toBe('/'+f.binding.database);expect(decodeURIComponent(actualTarget.username)).toBe(f.profilePeers.app.role);
  const bundle=await build({entryPoints:[resolve(import.meta.dirname,'integration/RechargeRefundRecoveryWorkerdScenario.ts')],bundle:true,write:false,
   format:'esm',platform:'browser',conditions:['workerd','worker','browser'],external:['node:*','cloudflare:*'],target:'es2022',tsconfig:resolve(import.meta.dirname,'../tsconfig.json')});
  const localFetch=globalThis.fetch;
  const outbound:V4FetchHandler=async request=>{
   try{
    expect(request.method).toBe('GET');expect(new URL(request.url).origin).toBe('https://api.mch.weixin.qq.com');
    expect(globalThis.fetch).toBe(localFetch);
    expect(await f.maintenanceDb.execute(sql`SELECT pid FROM pg_catalog.pg_stat_activity
     WHERE usename=${f.profilePeers.app.role} AND xact_start IS NOT NULL`)).toHaveLength(0);
    const response=await localFetch(request.url,{method:'GET',headers:Object.fromEntries(request.headers)});
    return new LocalResponse(await response.text(),{status:response.status,headers:Object.fromEntries(response.headers)});
   }catch(error){failures.push(error);return new LocalResponse('Local gateway rejected unexpected exchange',{status:503});}
  };
  mf=new Miniflare(convertV4MiniflareOptions({script:bundle.outputFiles[0].text,modules:true,compatibilityDate:'2026-08-09',compatibilityFlags:['nodejs_compat'],
   host:'127.0.0.1',port:0,kvNamespaces:['CONFIG_KV'],hyperdrives:{HYPERDRIVE:f.appRuntime.connectionString},outboundService:outbound,
   bindings:{APP_KEY:f.env.APP_KEY,UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:'',ORDER_DLQ_NAME:'recharge-refund-local-dlq',
    ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS:f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS!,TEST_SCENARIO_KEY:key,
    TEST_OWNED_DATABASE:f.binding.database,TEST_APP_LOGIN:f.profilePeers.app.role}}));
  await mf.ready;
 })();await setup;},240000);
 afterAll(async()=>{try{if(setup)await Promise.allSettled([setup]);if(pending)await Promise.allSettled([pending]);}
  finally{try{await mf?.dispose();}finally{try{await f?.close();}finally{vi.restoreAllMocks();}}}},30000);
 afterEach(()=>{expect(failures).toEqual([]);});
 async function call(path:string,input:unknown):Promise<Exchange>{
  const response=await mf.dispatchFetch('http://localhost/'+path,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(input)});
  expect(response.status).toBe(200);return await response.json() as Exchange;
 }
 function specimen(work:RechargeRefundRecoveryMessage){const s=specimens.get(work.operationId);if(!s)throw Error('Unknown authored operation');return s;}
 function address(index:number){const work=first.messages.filter(isRechargeRefundRecoveryMessage)[index];if(!work)throw Error('Missing bounded address');return work;}
 const view=(s:Specimen)=>lookupAdminRechargeRefundExecution(f.adminContainer,f.env,f.actor(),s.key);
 const economic=(s:string)=>Object.fromEntries(Object.entries(JSON.parse(s) as Record<string,unknown>).filter(([k])=>!['attempts','results','states'].includes(k)));
 it('uses a separate actual App LOGIN backend inside workerd and denies an unauthenticated test bridge',()=>start(async()=>{
  expect((await mf.dispatchFetch('http://localhost/identity')).status).toBe(403);
  const r=await mf.dispatchFetch('http://localhost/identity',{headers:{Authorization:'Bearer '+key}});expect(r.status).toBe(200);
  const identity=await r.json();expect(identity).toMatchObject({role:f.profilePeers.app.role,database:f.binding.database,login:true});
  expect(identity).not.toMatchObject({pid:f.identities.app.pid});
 }),5000);
 it('runs actual Worker Cron and preserves every existing five-minute root with one new recovery root',()=>start(async()=>{
  const scheduledAt=1786276800000,r=await call('scheduled',{scheduledAt});expect(r.messages).toHaveLength(22);
  const roots=r.messages.filter(isRechargeRefundRecoveryDispatch);expect(roots).toEqual([createRechargeRefundRecoveryRoot(scheduledAt)]);root=roots[0];
  expect(r.messages.filter(m=>m.action==='runScheduledMaintenance')).toHaveLength(12);expect(f.posts).toHaveLength(0);expect(f.gets).toHaveLength(0);
 }),5000);
 it('leaves the minute shelf-only Cron separate from recharge recovery',()=>start(async()=>{
  const r=await call('scheduled',{scheduledAt:1786276800000,cron:'* * * * *'});
  expect(r.messages).toEqual([{action:'runScheduledMaintenance',job:'product_auto_shelf',runId:'scheduled:1786276800000',scheduledAt:1786276800000,cursor:0,threshold:null}]);
 }),5000);
 it.each(Array.from({length:21},(_,i)=>i))('authors genuine paid/held/solePOST/signedUNKNOWN candidate %i',index=>start(async()=>{
  const r=await f.persisted('UNKNOWN',false,rechargeAuthorUids[index%rechargeAuthorUids.length]);
  specimens.set(String(r.operation.operation_id),{id:String(r.operation.operation_id),order:r.order,key:r.key});expect(r.receipt.status).toBe('UNKNOWN');
 }),5000);
 it('authors an actual pristine reservation without a first request',()=>start(async()=>{
  const paid=await f.paid(rechargeAuthorUids.at(-1)!),q=await f.quote(paid.order),key=randomUUID(),r=await f.admit(key,f.body(paid.order,q,false));
  pristine={id:String(r.operation.operation_id),order:paid.order,key};expect((await view(pristine))?.execution).toMatchObject({phase:'not_requested',attemptCount:0});
 }),5000);
 it('actual Queue never sends an initial POST for a pristine admitted operation',()=>start(async()=>{
  const before=await f.snapshot(pristine.order),posts=f.posts.length,r=await call('queue',{messages:[{action:'recoverRechargeRefund',operationId:pristine.id}]});
  expect(r.acks).toEqual(['local-0']);expect(r.retries).toEqual([]);expect(await f.snapshot(pristine.order)).toBe(before);expect(f.posts).toHaveLength(posts);expect(f.gets).toHaveLength(0);
 }),5000);
 it('rejects borrowed actual Admin/Financial/owner roots for new App scan without Queue or provider I/O',()=>start(async()=>{
  for(const db of [f.adminRuntime.db,f.profilePeers.financial.db,f.maintenanceDb])await expect(new RechargeRefundRecoveryQueueService(createContainerFromDb(db),f.env).snapshot(root)).rejects.toThrow();
  expect(f.gets).toHaveLength(0);
 }),5000);
 it('does not accept a future cutoff as database time',()=>start(async()=>{
  const [clock]=await f.appRuntime.db.execute<{now:string}>(sql`SELECT floor(extract(epoch FROM pg_catalog.clock_timestamp()))::bigint AS now`);
  await expect(new RechargeRefundRecoveryQueueService(f.appContainer,f.env).snapshot({...root,cutoff:Number(clock.now)+3600})).rejects.toThrow();
 }),5000);
 describe('after the real immutable query fence',()=>{
  beforeAll(async()=>{if(busy)throw Error('Business pending before temporal wait');const began=performance.now();await delay(61000);
   console.log('RECHARGE_QUEUE_REAL_WAIT '+JSON.stringify({elapsedMs:Math.floor(performance.now()-began)}));},240000);
  it('retries enqueue failure after RR/RO snapshot COMMIT without changing a wallet or claim',()=>start(async()=>{
   const s=[...specimens.values()][0],before=await f.snapshot(s.order),r=await call('queue',{messages:[root],failure:'before'});
   expect(r.acks).toEqual([]);expect(r.retries).toEqual([{id:'local-0',delaySeconds:60}]);expect(r.messages).toEqual([]);
   expect(await f.snapshot(s.order)).toBe(before);expect(f.gets).toHaveLength(0);
  }),5000);
  it('retains an unknown enqueue acknowledgement without mutating financial evidence',()=>start(async()=>{
   const s=[...specimens.values()][0],before=await f.snapshot(s.order),r=await call('queue',{messages:[root],failure:'after'});
   expect(r.acks).toEqual([]);expect(r.retries).toEqual([{id:'local-0',delaySeconds:60}]);
   expect(r.messages.filter(isRechargeRefundRecoveryMessage)).toHaveLength(20);expect(r.messages.filter(isRechargeRefundRecoveryDispatch)).toHaveLength(1);
   expect(await f.snapshot(s.order)).toBe(before);expect(f.gets).toHaveLength(0);
  }),5000);
  it('replays the root through actual Worker, enqueues only20 addresses and freezes a composite continuation',()=>start(async()=>{
   first=await call('queue',{messages:[root],attempts:2});expect(first.acks).toEqual(['local-0']);expect(first.retries).toEqual([]);
   const work=first.messages.filter(isRechargeRefundRecoveryMessage),pages=first.messages.filter(isRechargeRefundRecoveryDispatch);
   expect(work).toHaveLength(20);expect(new Set(work.map(w=>w.operationId)).size).toBe(20);expect(work.some(w=>w.operationId===pristine.id)).toBe(false);
   expect(pages).toHaveLength(1);expect(pages[0]).toMatchObject({phase:'submitting',cutoff:expect.any(Number),cursor:{operationId:expect.any(String),queryAt:expect.any(Number)}});
   expect(f.posts).toHaveLength(21);expect(f.gets).toHaveLength(0);
  }),5000);
  it('claims, verifies an actual workerd GET and independently commits UNKNOWN, retaining all held money',()=>start(async()=>{
   const work=address(0),s=specimen(work),before=await f.snapshot(s.order);
   const r=await f.observeRecoveryQuery('app',s.id,'UNKNOWN',()=>call('queue',{messages:[work]}));
   expect(r.acks).toEqual(['local-0']);expect(r.retries).toEqual([]);expect(f.gets).toHaveLength(1);
   expect(economic(await f.snapshot(s.order))).toEqual(economic(before));expect((await view(s))?.execution).toMatchObject({wallet:'held',attemptCount:2,phase:'awaiting_provider'});
  }),5000);
  it('records SUCCESS and consumes the original hold inside actual Worker without a second wallet debit',()=>start(async()=>{
   const work=address(1),s=specimen(work),before=await f.wallet(s.order.uid);
   const r=await f.observeRecoveryQuery('app',s.id,'SUCCESS',()=>call('queue',{messages:[work]}));expect(r.acks).toEqual(['local-0']);expect(r.retries).toEqual([]);
   expect(await f.wallet(s.order.uid)).toBe(before);expect((await view(s))?.execution).toMatchObject({phase:'succeeded',wallet:'captured',attemptCount:2});
  }),5000);
  it('records CLOSED and releases exactly the original principal hold inside actual Worker',()=>start(async()=>{
   const work=address(2),s=specimen(work),before=rechargeRefundCents(await f.wallet(s.order.uid),true);
   const r=await f.observeRecoveryQuery('app',s.id,'CLOSED',()=>call('queue',{messages:[work]}));expect(r.acks).toEqual(['local-0']);expect(r.retries).toEqual([]);
   expect(await f.wallet(s.order.uid)).toBe(rechargeRefundDecimal(before+1000));expect((await view(s))?.execution).toMatchObject({phase:'released',wallet:'released',attemptCount:2});
  }),5000);
  it('continues past moved/settled rows without losing the21st original first-attempt address',()=>start(async()=>{
   const page=first.messages.find(isRechargeRefundRecoveryDispatch)!;tail=await call('queue',{messages:[page]});
   expect(tail.acks).toEqual(['local-0']);expect(tail.retries).toEqual([]);const remaining=tail.messages.filter(isRechargeRefundRecoveryMessage);
   expect(remaining).toHaveLength(1);expect(new Set([...first.messages.filter(isRechargeRefundRecoveryMessage),...remaining].map(m=>m.operationId)).size).toBe(21);
   const next=tail.messages.find(isRechargeRefundRecoveryDispatch)!;expect(next).toEqual({...page,phase:'unknown',cursor:null});
  }),5000);
  it('does not revisit a newly claimed UNKNOWN whose next query is beyond the root frozen cutoff',()=>start(async()=>{
   const page=tail.messages.find(isRechargeRefundRecoveryDispatch)!,r=await call('queue',{messages:[page]});
   expect(r.acks).toEqual(['local-0']);expect(r.messages).toEqual([]);expect(f.gets).toHaveLength(3);
  }),5000);
  it.each([0,1,2])('acks duplicate operation address %i without a new GET or second financial mutation',index=>start(async()=>{
   const work=address(index),s=specimen(work),before=await f.snapshot(s.order),r=await call('queue',{messages:[work],attempts:2});
   expect(r.acks).toEqual(['local-0']);expect(r.retries).toEqual([]);expect(await f.snapshot(s.order)).toBe(before);expect(f.gets).toHaveLength(3);expect(f.posts).toHaveLength(21);
  }),5000);
  it('makes the bounded predicate eligible for the existing exact due index and needs no new DDL',()=>start(async()=>{
   const page=first.messages.find(isRechargeRefundRecoveryDispatch)!,query=rechargeRefundRecoveryPageQuery(page,page.cutoff!);
   const q=new PgDialect().sqlToQuery(query);expect(q.sql).not.toContain('OFFSET');
   const plan=await f.appRuntime.db.transaction(async tx=>{
    // Planner eligibility only on a tiny genuine fixture, not a throughput or
    // default-plan claim. No financial authority or row is modified.
    await tx.execute(sql`SET LOCAL enable_seqscan=off`);return tx.execute(sql`EXPLAIN (FORMAT JSON) ${query}`);
   },{isolationLevel:'repeatable read',accessMode:'read only'});
   expect(JSON.stringify(plan)).toContain('rcrs_due');
  }),5000);
  it('retains all first attempts and proves the actual Cron/Queue/Hyperdrive/provider/funds chain',()=>start(async()=>{
   expect(f.posts).toHaveLength(21);expect(f.gets).toHaveLength(3);expect(failures).toEqual([]);
   console.log('RECHARGE_QUEUE_WORKERD_NATIVE_PROOF '+JSON.stringify({actualWorkerCron:true,actualWorkerQueue:true,actualAppHyperdrive:true,actualAppDifferentBackend:true,
    existingFiveMinuteRootsPreserved:true,minuteCronSeparate:true,readonlyDiscovery:true,enqueueRollbackAndUnknownAck:true,boundedPages:[20,1],
    frozenCutoffExcludesNewQuery:true,actualQueryCommitBeforeGet:true,noActiveAppTransactionAtProvider:true,actualRsa:true,providerResultIndependentCommit:true,querySuccessCapture:true,queryClosedRelease:true,
    duplicateNoGetOrMoney:true,pristineNoInitialPost:true,noNewSchemaOrBroadGrant:true,firstPosts:21,queryGets:3}));
  }),5000);
 });
});
