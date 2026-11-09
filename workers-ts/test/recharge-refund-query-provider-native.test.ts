/** Actual claims/GET RSA/independent result transactions, with separate query economic authors after the original transport assertions. */
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { recoverAppRechargeRefund } from '@/services/payment/RechargeRefundRecoveryService';
import { setTimeout as delay } from 'node:timers/promises';
import { eq,sql } from 'drizzle-orm';
import { capitalFlow,user,userBill,userRecharge } from '@/models/schema';
import { createContainerFromDb } from '@/lib/di';
import { runRechargeRefundNoticeUpgrade } from '@/migrations/rechargeRefundNotice';
import { captureRechargeRefundSuccessQueryResult } from '@/services/payment/RechargeRefundQuerySuccessCapture';
import { releaseRechargeRefundClosedQueryResult } from '@/services/payment/RechargeRefundQueryClosedRelease';
import { captureRechargeRefundSuccessFirstResult } from '@/services/payment/RechargeRefundSuccessCapture';
import { releaseRechargeRefundClosedFirstResult } from '@/services/payment/RechargeRefundClosedRelease';
import { OrderOutboxService } from '@/services/order/OrderOutboxService';
import { afterAll,afterEach,beforeAll,describe,expect,it,vi } from 'vitest';
import type { DbClient } from '@/lib/di';
import { claimAdminRechargeRefundQuery,claimRechargeRefundServiceQuery } from '@/services/payment/RechargeRefundQueryClaim';
import { readRechargeRefundQueryHistoryTx } from '@/services/payment/RechargeRefundQueryHistory';
import { type AuthorRecharge,rechargeAuthorUids,rechargeAuthorOriginal } from './helpers/rechargeRefundAdminAuthorNative';
import { rechargeQueryProviderNativeFixture,type RechargeQueryProviderNativeFixture,type NativeQueryExchange } from './helpers/rechargeQueryProviderNative';
const transport=vi.hoisted(()=>{
 const values=new Map<string,unknown>();
 const get=vi.fn(async(key:string)=>values.get(key)??null),set=vi.fn(async(key:string,value:unknown)=>{values.set(key,value);return true;});
 const remove=vi.fn(async(key:string)=>values.delete(key)),take=vi.fn(async(key:string)=>{const value=values.get(key)??null;values.delete(key);return value;});
 const setIfAbsent=vi.fn(async(key:string,value:unknown)=>{if(values.has(key))return false;values.set(key,value);return true;});
 const redis={eval:vi.fn(async()=>1),get,set:vi.fn(async(key:string,value:unknown)=>{await set(key,value);return'OK';}),del:vi.fn(async(key:string)=>Number(await remove(key)))};
 return{values,get,set,remove,take,setIfAbsent,redis};
});
vi.mock('@/utils/cache',async original=>({...await original<typeof import('@/utils/cache')>(),getRedis:()=>transport.redis,
 cacheGet:transport.get,cacheSet:transport.set,cacheTake:transport.take,cacheDelete:transport.remove,cacheSetIfAbsent:transport.setIfAbsent,
 setTokenBucket:vi.fn(async()=>true),clearToken:vi.fn(async()=>true)}));
const names=['primary','lateClosed','abnormal','unknown','merchantMissing','badSignature','unsigned404','badJson','wrongAmount','wrongAccount','wrongTime'] as const;
type Name=typeof names[number];
interface Specimen {id:string;order:AuthorRecharge}
type NativeFaultMode='none'|'rollback'|'lost-ack';
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('genuine recharge query provider and independent evidence',()=>{
 let f:RechargeQueryProviderNativeFixture,setup:Promise<void>|undefined,pending:Promise<unknown>|undefined,busy=false;
 const specimens=new Map<Name,Specimen>();let late:NativeQueryExchange|undefined,primary2=false,primary3=false;
 const start=<T>(run:()=>Promise<T>):Promise<T>=>{
  if(busy)throw Error('Previous genuine query provider still pending');busy=true;
  const work=run().finally(()=>{busy=false;});pending=work;void work.catch(()=>undefined);return work;
 };
 beforeAll(async()=>{setup=(async()=>{f=await rechargeQueryProviderNativeFixture(transport.values);
   const [index]=await f.maintenanceDb.execute<{present:boolean}>(sql`SELECT pg_catalog.to_regclass('public.cf_event_key_uq') IS NOT NULL AS present`);
   if(!index)throw Error('Owned cash-flow catalog missing');
   if(!index.present)await f.maintenanceDb.execute(sql`CREATE UNIQUE INDEX cf_event_key_uq ON public.capital_flow USING btree(event_key)`);
   await runRechargeRefundNoticeUpgrade(f.maintenanceDb);})();await setup;},240000);
 afterAll(async()=>{
  try{if(setup)await Promise.allSettled([setup]);if(pending)await Promise.allSettled([pending]);}
  finally{try{await f?.close();}finally{vi.restoreAllMocks();}}
 },30000);
 afterEach(()=>{
  if(!f)return;expect(f.calls).toHaveLength(rechargeAuthorUids.length);
  expect(f.calls.every(call=>{const u=new URL(call.url);return call.method==='GET'&&u.origin==='https://api.weixin.qq.com'&&u.pathname==='/sns/jscode2session';})).toBe(true);
 });
 function specimen(name:Name){const s=specimens.get(name);if(!s)throw Error('Missing genuine order '+name);return s;}
 const read=(id:string,role:'app'|'admin'|'financial'='app')=>f.profilePeers[role].db.transaction(tx=>readRechargeRefundQueryHistoryTx(tx as unknown as DbClient,f.env,role,id),
  {isolationLevel:'repeatable read',accessMode:'read only'});
 const economic=(snapshot:string)=>Object.fromEntries(Object.entries(JSON.parse(snapshot) as Record<string,unknown>).filter(([key])=>!['states','attempts','results'].includes(key)));
 function controlledRoot(root:DbClient){
  let mode:NativeFaultMode='none',calls=0,completed=0,commits=0;const fault=Error('Actual query result transaction acknowledgement fault');
  const wrapped=Object.create(root) as object,client=Object.getOwnPropertyDescriptor(root,'$client');if(!client||!('value'in client))throw Error('Genuine root required');
  Object.defineProperty(wrapped,'$client',{value:client.value});
  Object.defineProperty(wrapped,'transaction',{value:async(work:(tx:DbClient)=>Promise<unknown>,options:unknown)=>{
   expect(options).toEqual({isolationLevel:'read committed',accessMode:'read write'});calls++;
   const value=await root.transaction(async tx=>{const result=await work(tx as unknown as DbClient);completed++;
    if(mode==='rollback'){mode='none';throw fault;}return result;},{isolationLevel:'read committed',accessMode:'read write'});
   commits++;if(mode==='lost-ack'){mode='none';throw fault;}return value;
  }});
  return{root:wrapped as DbClient,fault,set:(next:NativeFaultMode)=>{mode=next;},counts:()=>({calls,completed,commits})};
 }
 async function wait(stage:number){
  if(busy)throw Error('Business transaction still pending before temporal wait');
  const began=performance.now();await delay(61000);const elapsed=performance.now()-began;expect(elapsed).toBeGreaterThanOrEqual(61000);
  console.log('RECHARGE_QUERY_PROVIDER_REAL_WAIT '+JSON.stringify({stage,elapsedMs:Math.floor(elapsed)}));
 }
 it.each(names)('authors new paid/held/solePOST/signedUNKNOWN specimen %s',name=>start(async()=>{
  const r=await f.persisted('UNKNOWN',name==='primary');specimens.set(name,{id:String(r.operation.operation_id),order:r.order});
  expect(r.receipt.status).toBe('UNKNOWN');expect(f.posts.filter(post=>post.body.out_refund_no===r.operation.out_refund_no)).toHaveLength(1);
 }),5000);
 describe('actual GET2 after elapsed61s',()=>{
  beforeAll(async()=>{expect(specimens.size).toBe(names.length);await wait(2);},240000);
  it('sends exactly one no-body GET, verifies signed404, and independently commits/replays NOT_FOUND',()=>start(async()=>{
   const s=specimen('primary'),before=await f.snapshot(s.order),token=await claimRechargeRefundServiceQuery(f.appRuntime.db,f.env,'app',s.id);
   const exchange=await f.query('app',token,'NOT_FOUND'),count=f.gets.length;
   await expect(exchange.service.persistRechargeRefundQueryResult({...exchange.verified})).rejects.toThrow();
   await expect(f.service(f.appRuntime.db).persistRechargeRefundQueryResult(exchange.verified)).rejects.toThrow();
   await expect(f.service(f.profilePeers.financial.db).persistRechargeRefundQueryResult(exchange.verified)).rejects.toThrow();
   const receipts=await Promise.all([exchange.service.persistRechargeRefundQueryResult(exchange.verified),exchange.service.persistRechargeRefundQueryResult(exchange.verified)]);
   expect(receipts[0].resultId).toBe(receipts[1].resultId);expect(receipts[0].status).toBe('NOT_FOUND');
   await expect(exchange.service.queryRechargeRefund(token)).rejects.toThrow();expect(f.gets.length).toBe(count);
   const h=await read(s.id);expect(h.results.map(row=>row.observation.status)).toEqual(['UNKNOWN','NOT_FOUND']);
   expect(h.totalAttempts).toBe(2);expect(h.requestAttempts).toBe(1);expect(h.queryDisposition).toBe('unresolved');
   expect(h.results[1].observation.httpStatus).toBe(404);expect(h.results[1].record.source).toBe('query');
   expect(economic(await f.snapshot(s.order))).toEqual(economic(before));primary2=true;
  }),5000);
  it('retains a genuinely verified CLOSED token for later persistence without updating current money',()=>start(async()=>{
   const s=specimen('lateClosed'),before=await f.snapshot(s.order),token=await claimRechargeRefundServiceQuery(f.appRuntime.db,f.env,'app',s.id);
   late=await f.query('app',token,'CLOSED');expect(late.verified.status).toBe('CLOSED');
   expect((await read(s.id)).results.length).toBe(1);expect(economic(await f.snapshot(s.order))).toEqual(economic(before));
  }),5000);
  it('rolls back an actual ABNORMAL result body then retries the same verified row without another GET',()=>start(async()=>{
   const s=specimen('abnormal'),before=await f.snapshot(s.order),control=controlledRoot(f.profilePeers.financial.db);
   const token=await claimRechargeRefundServiceQuery(control.root,f.env,'financial',s.id),exchange=await f.query('financial',token,'ABNORMAL',control.root),gets=f.gets.length;
   const counts=control.counts();control.set('rollback');await expect(exchange.service.persistRechargeRefundQueryResult(exchange.verified)).rejects.toBe(control.fault);
   expect(control.counts()).toEqual({calls:counts.calls+1,completed:counts.completed+1,commits:counts.commits});
   expect((await read(s.id)).results.length).toBe(1);
   const receipt=await exchange.service.persistRechargeRefundQueryResult(exchange.verified);expect(receipt.status).toBe('ABNORMAL');expect(receipt.replayed).toBe(false);
   expect((await read(s.id)).results.length).toBe(2);expect(f.gets.length).toBe(gets);expect(economic(await f.snapshot(s.order))).toEqual(economic(before));
  }),5000);
  it('keeps signed500 UNKNOWN truth after real COMMIT lostACK and replays the same result UUID without another GET',()=>start(async()=>{
   const s=specimen('unknown'),before=await f.snapshot(s.order),control=controlledRoot(f.appRuntime.db);
   const token=await claimRechargeRefundServiceQuery(control.root,f.env,'app',s.id),exchange=await f.query('app',token,'UNKNOWN',control.root),gets=f.gets.length;
   const counts=control.counts();control.set('lost-ack');
   const outcomes=await Promise.allSettled([exchange.service.persistRechargeRefundQueryResult(exchange.verified),exchange.service.persistRechargeRefundQueryResult(exchange.verified)]);
   expect(outcomes.every(out=>out.status==='rejected'&&out.reason===control.fault)).toBe(true);
   expect(control.counts()).toEqual({calls:counts.calls+1,completed:counts.completed+1,commits:counts.commits+1});
   const actual=await read(s.id);expect(actual.results.length).toBe(2);const saved=actual.results[1].record;
   const receipt=await exchange.service.persistRechargeRefundQueryResult(exchange.verified);expect(receipt).toMatchObject({status:'UNKNOWN',resultId:saved.result_id,signature:saved.signature,replayed:true});
   const done=control.counts();expect(await exchange.service.persistRechargeRefundQueryResult(exchange.verified)).toBe(receipt);expect(control.counts()).toEqual(done);
   expect(actual.results[1].observation.httpStatus).toBe(500);expect(f.gets.length).toBe(gets);expect(economic(await f.snapshot(s.order))).toEqual(economic(before));
  }),5000);
  it('records a signed merchant-missing404 as UNKNOWN rather than missing-refund or release',()=>start(async()=>{
   const s=specimen('merchantMissing'),before=await f.snapshot(s.order),token=await claimRechargeRefundServiceQuery(f.profilePeers.financial.db,f.env,'financial',s.id);
   const exchange=await f.query('financial',token,'MERCHANT_NOT_FOUND'),receipt=await exchange.service.persistRechargeRefundQueryResult(exchange.verified);
   expect(receipt.status).toBe('UNKNOWN');const h=await read(s.id);expect(h.results[1].observation).toMatchObject({status:'UNKNOWN',httpStatus:404,errorCode:'MCH_NOT_EXISTS'});
   expect(h.state.wallet_state).toBe('held');expect(economic(await f.snapshot(s.order))).toEqual(economic(before));
  }),5000);
  it.each([
   ['badSignature','bad-signature'],['unsigned404','unsigned-404'],['badJson','bad-json'],['wrongAmount','wrong-amount'],['wrongAccount','wrong-account'],['wrongTime','wrong-success-time'],
  ] as const)('rejects actual %s GET response without fabricating provider evidence or reminting the burned request', (name,outcome)=>start(async()=>{
   const s=specimen(name),before=await f.snapshot(s.order),token=await claimRechargeRefundServiceQuery(f.appRuntime.db,f.env,'app',s.id);
   await expect(f.query('app',token,outcome)).rejects.toThrow();const gets=f.gets.length;
   await expect(f.query('app',token,outcome)).rejects.toThrow();expect(f.gets.length).toBe(gets);
   const h=await read(s.id);expect(h.totalAttempts).toBe(2);expect(h.results.length).toBe(1);expect(h.results[0].record.source).toBe('request');
   expect(h.state.wallet_state).toBe('held');expect(economic(await f.snapshot(s.order))).toEqual(economic(before));
  }),5000);
 });
 describe('independent truth and actual GET3 after another elapsed61s',()=>{
  beforeAll(async()=>{expect(primary2).toBe(true);expect(late).toBeDefined();await wait(3);},240000);
  it('persists retained CLOSED truth after actual lease expiry and current credential/actor/source/hold withdrawal without releasing money',()=>start(async()=>{
   const s=specimen('lateClosed'),exchange=late;if(!exchange)throw Error('Missing actual verified token');
   const [clock]=await f.maintenanceDb.execute<{now:string}>(sql`SELECT floor(extract(epoch FROM pg_catalog.clock_timestamp()))::bigint AS now`);
   expect(Number(clock.now)).toBeGreaterThanOrEqual(exchange.point.payload.leaseUntil);
   const registry=f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS;await f.approve(1,'revoked');f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS='{}';await f.rules('');
   await f.maintenanceDb.execute(sql`UPDATE public."user" SET now_money=17 WHERE uid=${s.order.uid}`);
   await f.maintenanceDb.execute(sql`UPDATE public.user_recharge SET paid=0,refund_price=10 WHERE id=${s.order.id}`);
   await f.maintenanceDb.execute(sql`UPDATE public.user_bill SET status=0 WHERE event_key=${'recharge_refund_hold:'+s.id}`);
   const before=await f.snapshot(s.order),gets=f.gets.length;
   try{
    const receipt=await exchange.service.persistRechargeRefundQueryResult(exchange.verified);expect(receipt.status).toBe('CLOSED');
    const h=await read(s.id);expect(h.queryDisposition).toBe('terminal_evidence');expect(h.state.wallet_state).toBe('held');
    expect(Number(h.results[1].record.created_at)).toBeGreaterThanOrEqual(exchange.point.payload.issuedAt);
    expect(Number(h.results[1].record.created_at)).toBeLessThan(Number(clock.now)-30);
    expect(economic(await f.snapshot(s.order))).toEqual(economic(before));expect(await f.wallet(s.order.uid)).toBe('17.00');expect(f.gets.length).toBe(gets);
   }finally{f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS=registry;await f.rules('recharge_order.refund');}
  }),5000);
  it('uses rotated original-pair credentials for actual Financial GET3 and keeps older NOT_FOUND then PROCESSING queryable',()=>start(async()=>{
   const s=specimen('primary'),before=await f.snapshot(s.order),registry=f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS;
   await f.approve(2,'active',['refund_query']);const material=JSON.parse(registry!) as {format:number;credentials:Array<{version:number}>};
   f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS=JSON.stringify({...material,credentials:material.credentials.filter(row=>row.version===2)});
   try{
    const token=await claimRechargeRefundServiceQuery(f.profilePeers.financial.db,f.env,'financial',s.id),exchange=await f.query('financial',token,'PROCESSING');
    const receipt=await exchange.service.persistRechargeRefundQueryResult(exchange.verified);expect(receipt.status).toBe('PROCESSING');
    const h=await read(s.id,'financial');expect(h.results.map(row=>row.observation.status)).toEqual(['UNKNOWN','NOT_FOUND','PROCESSING']);
    expect(h.queryDisposition).toBe('unresolved');expect(h.totalAttempts).toBe(3);expect(h.requestAttempts).toBe(1);expect(h.queries[1].payload.approval.credentialVersion).toBe(2);
    expect(h.results[2].observation.verifierKey).toBe(rechargeAuthorOriginal.serial+'_V2');
    expect(economic(await f.snapshot(s.order))).toEqual(economic(before));primary3=true;
   }finally{f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS=registry;}
  }),5000);
 });
 describe('actual GET4 after a third elapsed61s',()=>{
  beforeAll(async()=>{expect(primary3).toBe(true);await wait(4);},240000);
  it('uses current original Admin authority for SUCCESS with the originalPOST time window and retains the held wallet',()=>start(async()=>{
   const s=specimen('primary'),before=await f.snapshot(s.order),token=await claimAdminRechargeRefundQuery(f.adminRuntime.db,f.env,f.actor(),s.id);
   const exchange=await f.query('admin',token,'SUCCESS'),receipt=await exchange.service.persistRechargeRefundQueryResult(exchange.verified);
   expect(receipt.status).toBe('SUCCESS');const h=await read(s.id,'admin');
   expect(h.totalAttempts).toBe(4);expect(h.requestAttempts).toBe(1);expect(h.queryAttempts).toBe(3);expect(h.queryDisposition).toBe('terminal_evidence');
   expect(h.results.map(row=>row.observation.status)).toEqual(['UNKNOWN','NOT_FOUND','PROCESSING','SUCCESS']);
   const observed=h.results.at(-1)!.observation;expect(observed.successTime).toBe(h.first.payload.issuedAt-299);
   expect(observed.successTime).toBeLessThan(exchange.point.payload.issuedAt-300);expect(h.state.wallet_state).toBe('held');
   expect(h.results.slice(1).map(row=>row.observation.verifierKey)).toEqual([rechargeAuthorOriginal.serial,rechargeAuthorOriginal.serial+'_V2',rechargeAuthorOriginal.serial+'_V2']);
   for(const index of [1,2,3])expect(Number(h.attempts[index].created_at)-Number(h.attempts[index-1].created_at)).toBeGreaterThanOrEqual(60);
   expect(f.posts.filter(row=>row.body.out_refund_no===h.first.payload.request.outRefundNo)).toHaveLength(1);
   expect(f.gets.filter(row=>row.operationId===s.id)).toHaveLength(3);expect(f.posts.length).toBe(names.length);expect(f.gets.length).toBe(13);
   expect(economic(await f.snapshot(s.order))).toEqual(economic(before));
   console.log('RECHARGE_QUERY_PROVIDER_NATIVE_PROOF '+JSON.stringify({ordinals:h.attempts.map(row=>row.ordinal),issuedAt:h.attempts.map(row=>row.created_at),
    statuses:h.results.map(row=>row.observation.status),credentialVersions:h.queries.map(row=>row.payload.approval.credentialVersion),verifierKeys:h.results.slice(1).map(row=>row.observation.verifierKey),requestAttempts:1,primaryPosts:1,primaryGets:3,totalSpecimenPosts:f.posts.length,totalGets:f.gets.length,
    signed404:true,independentResultCommit:true,lostAckReplayWithoutGet:true,invalidResponsesRetainNoProviderRecord:true,
    originalPostSuccessWindow:true,moneyUnchanged:true,queryCausedEconomicWriterCovered:false}));
  }),5000);
 });

 describe('query-caused atomic capture and CLOSED release',()=>{
  type Role='app'|'admin'|'financial';
  const container=(role:Role,root:DbClient=f.profilePeers[role].db)=>({...f.adminContainer,db:root});
  const cause=async(name:Name,status:'SUCCESS'|'CLOSED')=>{
   const r=specimen(name),rows=await f.adminRuntime.db.execute(sql`SELECT result_id FROM public.recharge_refund_result
    WHERE operation_id=${r.id}::uuid AND source='query' AND status=${status} LIMIT 2`);
   expect(rows).toHaveLength(1);return String(rows[0].result_id);
  };
  const capture=async(role:Role='app',root?:DbClient)=>captureRechargeRefundSuccessQueryResult(container(role,root),f.env,role,specimen('primary').id,await cause('primary','SUCCESS'));
  const release=async(role:Role='financial',root?:DbClient)=>releaseRechargeRefundClosedQueryResult(container(role,root),f.env,role,specimen('lateClosed').id,await cause('lateClosed','CLOSED'));
  const local=async(name:Name)=>f.adminRuntime.db.execute(sql`SELECT * FROM public.recharge_refund_result WHERE operation_id=${specimen(name).id}::uuid AND source IN('local_settlement','local_release')`);
  const money=async(name:Name)=>{
   const r=specimen(name),base=await f.snapshot(r.order),[extra]=await f.maintenanceDb.execute(sql`SELECT
    (SELECT COALESCE(jsonb_agg(to_jsonb(t)||jsonb_build_object('_xmin',xmin::text) ORDER BY id),'[]'::jsonb) FROM public.capital_flow t WHERE order_id=${r.order.orderId}) AS flows,
    (SELECT COALESCE(jsonb_agg(to_jsonb(t)||jsonb_build_object('_xmin',xmin::text) ORDER BY id),'[]'::jsonb) FROM public.store_order_outbox t WHERE aggregate_type='recharge' AND aggregate_id=${r.order.id}) AS outbox`);
   return JSON.stringify({base,extra});
  };
  const noWrite=async(name:Name,work:()=>Promise<unknown>)=>{
   const before=await money(name),posts=f.posts.length,gets=f.gets.length;await expect(work()).rejects.toThrow();
   expect(await money(name)).toBe(before);expect(f.posts).toHaveLength(posts);expect(f.gets).toHaveLength(gets);
  };
  it('refuses first-POST provider rows as query causes and keeps first-only authors closed to query causes',()=>start(async()=>{
   const r=specimen('primary'),[first]=await f.adminRuntime.db.execute(sql`SELECT result_id FROM public.recharge_refund_result WHERE operation_id=${r.id}::uuid AND source='request'`);
   await noWrite('primary',()=>captureRechargeRefundSuccessQueryResult(container('app'),f.env,'app',r.id,first.result_id));
   await noWrite('primary',async()=>captureRechargeRefundSuccessFirstResult(container('app'),f.env,'app',r.id,await cause('primary','SUCCESS')));
   await noWrite('lateClosed',async()=>releaseRechargeRefundClosedFirstResult(container('financial'),f.env,'financial',specimen('lateClosed').id,await cause('lateClosed','CLOSED')));
  }),5000);
  it('uses a controlled negative current wallet after a genuinely admitted gift-reclaim hold',()=>start(async()=>{
   const r=specimen('primary');await f.maintenanceDb.update(user).set({nowMoney:'-0.25'}).where(eq(user.uid,r.order.uid));
   expect(await f.wallet(r.order.uid)).toBe('-0.25');const h=await read(r.id);expect(h.operation).toMatchObject({reclaim_gift:true,debit_cents:1150,wallet_after:0});
  }),5000);
  it('rolls actual query refund/flow/intent/localreceipt/state back while verified provider SUCCESS remains committed',()=>start(async()=>{
   const control=controlledRoot(f.adminRuntime.db);control.set('rollback');await noWrite('primary',()=>capture('admin',control.root));
   expect(control.counts()).toEqual({calls:1,completed:1,commits:0});expect(await local('primary')).toHaveLength(0);
   expect((await read(specimen('primary').id)).results.at(-1)!.observation.status).toBe('SUCCESS');
  }),5000);
  it('refuses a mismatched actual role and maintenance owner execution without adopting a caller ready object',()=>start(async()=>{
   const id=await cause('primary','SUCCESS'),r=specimen('primary');
   await noWrite('primary',()=>captureRechargeRefundSuccessQueryResult(container('admin',f.appRuntime.db),f.env,'admin',r.id,id));
   await noWrite('primary',()=>captureRechargeRefundSuccessQueryResult(container('admin',f.maintenanceDb),f.env,'admin',r.id,id));
  }),5000);
  it('refuses an orphan financial artifact instead of adopting it as an already captured refund',()=>start(async()=>{
   const r=specimen('primary'),[orphan]=await f.adminRuntime.db.insert(capitalFlow).values({eventKey:'recharge.refund:'+r.id,flowId:'controlled_query_orphan',
    orderId:r.order.orderId,uid:r.order.uid,price:'-10.00',tradingType:4}).returning({id:capitalFlow.id});
   try{await noWrite('primary',()=>capture());}finally{await f.maintenanceDb.delete(capitalFlow).where(eq(capitalFlow.id,orphan.id));}
  }),5000);
  it('settles two actual App/Financial contenders to one query capture and one replay without another wallet debit',()=>start(async()=>{
   const roles=['app','financial']as const,outcomes=await Promise.allSettled(roles.map(role=>capture(role)));
   expect(outcomes.some(r=>r.status==='fulfilled')).toBe(true);const receipts=[];
   for(const [i,row]of outcomes.entries()){
    if(row.status==='fulfilled')receipts.push(row.value);
    else{let error:unknown=row.reason,code:unknown;for(let n=0;n<7&&error&&typeof error==='object';n++){
      const r=error as {code?:unknown;cause?:unknown};if(r.code!==undefined){code=r.code;break;}error=r.cause;
     }expect(code).toBe('55P03');receipts.push(await capture(roles[i]));}
   }
   expect(receipts.map(r=>r.replayed).sort()).toEqual([false,true]);expect(receipts[0].localResultId).toBe(receipts[1].localResultId);
   expect(receipts[0].flowId).toBe(receipts[1].flowId);expect(receipts[0].noticeId).toBe(receipts[1].noticeId);
   expect(await f.wallet(specimen('primary').order.uid)).toBe('-0.25');
  }),5000);
  it('binds query4 and its independent approval to one actual negative principal flow and passive notice',()=>start(async()=>{
   const r=specimen('primary'),rows=await local('primary');expect(rows).toHaveLength(1);
   expect(rows[0]).toMatchObject({source:'local_settlement',caused_by_result_id:await cause('primary','SUCCESS'),evidence:{purpose:'recharge-refund-query-local-capture-v1',
    settlement:{query:{ordinal:4},projection:{beforeVersion:4,afterVersion:5,totalAttempts:4},wallet:{beforeCents:-25,afterCents:-25},recharge:{reclaimGift:true,postReservationBalanceCents:0}}}});
   const [physical]=await f.adminRuntime.db.execute(sql`SELECT
    (SELECT refund_price::text FROM public.user_recharge WHERE id=${r.order.id}) AS refund,
    (SELECT count(*)::integer FROM public.capital_flow WHERE event_key=${'recharge.refund:'+r.id} AND price=-10) AS flow,
    (SELECT count(*)::integer FROM public.store_order_outbox WHERE event_key=${'recharge.refund.success.notice:'+r.id} AND status='PENDING'
      AND payload->>'purpose'='recharge-refund-query-success-notice-intent-v1' AND payload->'business'->>'postBalanceCents'='0') AS notice,
    (SELECT status FROM public.recharge_refund_state WHERE operation_id=${r.id}::uuid) AS status,
    (SELECT version FROM public.recharge_refund_state WHERE operation_id=${r.id}::uuid) AS version`);
   expect(physical).toEqual({refund:'10.00',flow:1,notice:1,status:'SUCCEEDED',version:5});
  }),5000);
  it('replays after a later actual paid recharge without changing the immutable refund notice balance',()=>start(async()=>{
   const r=specimen('primary');await f.paid(r.order.uid);expect(await f.wallet(r.order.uid)).toBe('11.25');
   const before=await money('primary');expect((await capture('admin')).replayed).toBe(true);expect(await money('primary')).toBe(before);
  }),5000);
  it('does not dispatch the query-specific passive intent through the legacy Queue route',()=>start(async()=>{
   const r=specimen('primary'),[notice]=await f.appRuntime.db.execute(sql`SELECT id FROM public.store_order_outbox WHERE event_key=${'recharge.refund.success.notice:'+r.id}`);
   const before=await money('primary'),messages=f.messages.length;
   expect(await new OrderOutboxService(createContainerFromDb(f.appRuntime.db),f.env).dispatchById(Number(notice.id))).toEqual({claimed:0,enqueued:0});
   expect(await money('primary')).toBe(before);expect(f.messages).toHaveLength(messages);
  }),5000);
  it('replays immutable capture after current approval/credentials/Admin authority are withdrawn',()=>start(async()=>{
   const registry=f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS;await f.approve(2,'revoked');await f.rules('');f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS='';
   try{const before=await money('primary');expect((await capture('financial')).replayed).toBe(true);expect(await money('primary')).toBe(before);}
   finally{f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS=registry;await f.rules('recharge_order.refund');}
  }),5000);
  it('retains CLOSED evidence but refuses fresh money while the preceding controlled source withdrawal remains',()=>start(async()=>{
   await noWrite('lateClosed',()=>release());expect(await local('lateClosed')).toHaveLength(0);
  }),5000);
  it('restores only the exact genuine paid-source fields from the stored pre-withdrawal order and still refuses its tampered hold',()=>start(async()=>{
   const r=specimen('lateClosed');expect(r.order).toMatchObject({paid:1,refundPrice:'0.00'});
   // Cleanup of the earlier negative specimen, not a payment producer. The
   // actual signed callback, settlement and immutable hold all predate it.
   await f.maintenanceDb.update(userRecharge).set({paid:r.order.paid,refundPrice:r.order.refundPrice}).where(eq(userRecharge.id,r.order.id));
   await noWrite('lateClosed',()=>release());
  }),5000);
  it('restores the canonical status of the genuine pre-existing hold after the controlled negative mutation',()=>start(async()=>{
   const r=specimen('lateClosed'),h=await read(r.id);expect(h.first.payload.holdBillId).toBeGreaterThan(0);
   await f.maintenanceDb.update(userBill).set({status:1}).where(eq(userBill.id,h.first.payload.holdBillId));
   expect(await f.wallet(r.order.uid)).toBe('17.00');expect(await local('lateClosed')).toHaveLength(0);
  }),5000);
  it('rolls a real query CLOSED wallet credit/bill/localreceipt/state transaction back',()=>start(async()=>{
   const control=controlledRoot(f.profilePeers.financial.db);control.set('rollback');await noWrite('lateClosed',()=>release('financial',control.root));
   expect(control.counts()).toEqual({calls:1,completed:1,commits:0});expect(await f.wallet(specimen('lateClosed').order.uid)).toBe('17.00');
  }),5000);
  it('keeps the real CLOSED release committed after lost COMMIT acknowledgement without repeating provider IO',()=>start(async()=>{
   const control=controlledRoot(f.adminRuntime.db);control.set('lost-ack');const posts=f.posts.length,gets=f.gets.length;
   await expect(release('admin',control.root)).rejects.toBe(control.fault);expect(control.counts()).toEqual({calls:1,completed:1,commits:1});
   expect(await f.wallet(specimen('lateClosed').order.uid)).toBe('27.00');expect(await local('lateClosed')).toHaveLength(1);
   expect(f.posts).toHaveLength(posts);expect(f.gets).toHaveLength(gets);
  }),5000);
  it('replays query CLOSED from another actual role and returns only the original principal hold, preserving its gift option',()=>start(async()=>{
   const r=specimen('lateClosed'),before=await money('lateClosed'),receipt=await release('app');expect(receipt.replayed).toBe(true);
   expect(await money('lateClosed')).toBe(before);const rows=await local('lateClosed');expect(rows).toHaveLength(1);
   expect(rows[0]).toMatchObject({source:'local_release',caused_by_result_id:await cause('lateClosed','CLOSED'),evidence:{purpose:'recharge-refund-query-closed-release-v1',
    release:{query:{ordinal:2},projection:{beforeVersion:2,afterVersion:3,totalAttempts:2},wallet:{beforeCents:1700,afterCents:2700},recharge:{reclaimGift:false,debitCents:1000}}}});
   const [artifacts]=await f.adminRuntime.db.execute(sql`SELECT
    (SELECT count(*)::integer FROM public.user_bill WHERE event_key=${'recharge_refund_release:'+r.id} AND number=10 AND balance=27) AS bills,
    (SELECT count(*)::integer FROM public.capital_flow WHERE event_key=${'recharge.refund:'+r.id}) AS flows,
    (SELECT count(*)::integer FROM public.store_order_outbox WHERE event_key=${'recharge.refund.success.notice:'+r.id}) AS notices,
    (SELECT status FROM public.recharge_refund_state WHERE operation_id=${r.id}::uuid) AS status`);
   expect(artifacts).toEqual({bills:1,flows:0,notices:0,status:'FAILED'});
  }),5000);
  it('never turns terminal local history into a new GET or a second economic author cause',()=>start(async()=>{
   const posts=f.posts.length,gets=f.gets.length;
   for(const name of ['primary','lateClosed']as const){const r=specimen(name);await expect(claimRechargeRefundServiceQuery(f.appRuntime.db,f.env,'app',r.id)).rejects.toThrow();
    const rows=await local(name);if(name==='primary')await noWrite(name,()=>captureRechargeRefundSuccessQueryResult(container('app'),f.env,'app',r.id,rows[0].result_id));
    else await noWrite(name,()=>releaseRechargeRefundClosedQueryResult(container('app'),f.env,'app',r.id,rows[0].result_id));}
   expect(f.posts).toHaveLength(posts);expect(f.gets).toHaveLength(gets);
   console.log('RECHARGE_QUERY_ECONOMIC_NATIVE_PROOF '+JSON.stringify({queryCapture:true,queryClosedRelease:true,actualNegativeWalletCaptureWithoutDebit:true,
    actualRollbackBoth:true,actualConcurrentCapture:true,actualLostAckRelease:true,replayAcrossAll3Roles:true,latePaidCreditReplay:true,
    originalHoldGiftChoicesCovered:true,queryAndFirstPostCodecsSeparate:true,legacyQueueInactive:true,totalPosts:posts,totalGets:gets}));
  }),5000);
 });

 describe('actual private App recovery coordinator',()=>{
  const app=(root:DbClient=f.appRuntime.db)=>({...f.adminContainer,db:root});
  const target=(name:Name)=>specimen(name).id;
  it('recovers an already committed query SUCCESS receipt without a new GET',()=>start(async()=>{
   const gets=f.gets.length,posts=f.posts.length,before=await f.snapshot(specimen('primary').order);
   expect(await recoverAppRechargeRefund(app(),f.env,target('primary'))).toMatchObject({operationId:target('primary'),outcome:'captured',replayed:true});
   expect(await f.snapshot(specimen('primary').order)).toBe(before);expect(f.gets).toHaveLength(gets);expect(f.posts).toHaveLength(posts);
  }),5000);
  it('recovers an already committed query CLOSED receipt without another wallet return or GET',()=>start(async()=>{
   const gets=f.gets.length,posts=f.posts.length,before=await f.snapshot(specimen('lateClosed').order);
   expect(await recoverAppRechargeRefund(app(),f.env,target('lateClosed'))).toMatchObject({operationId:target('lateClosed'),outcome:'released',replayed:true});
   expect(await f.snapshot(specimen('lateClosed').order)).toBe(before);expect(await f.wallet(specimen('lateClosed').order.uid)).toBe('27.00');
   expect(f.gets).toHaveLength(gets);expect(f.posts).toHaveLength(posts);
  }),5000);
  it('keeps the coordinator fixed to actual App LOGIN, rejecting Financial and owner roots',()=>start(async()=>{
   const before=await f.snapshot(specimen('primary').order),gets=f.gets.length;
   for(const root of [f.profilePeers.financial.db,f.maintenanceDb])await expect(recoverAppRechargeRefund(app(root),f.env,target('primary'))).rejects.toThrow();
   expect(await f.snapshot(specimen('primary').order)).toBe(before);expect(f.gets).toHaveLength(gets);
  }),5000);
  it('claims/GETs/persists/settles an actual due UNKNOWN and retains a real capture after lost COMMIT acknowledgement',()=>start(async()=>{
   await f.approve(2,'active',['refund_query']);const real=f.appRuntime.db,fault=Error('Actual recovery capture COMMIT acknowledgement lost');let committed=false;
   const wrapped=Object.create(real) as object,client=Object.getOwnPropertyDescriptor(real,'$client');if(!client||!('value'in client))throw Error('Genuine App root missing');
   Object.defineProperty(wrapped,'$client',{value:client.value});
   Object.defineProperty(wrapped,'transaction',{value:async(work:(tx:DbClient)=>Promise<unknown>,options:Parameters<DbClient['transaction']>[1])=>{
    const result=await real.transaction(tx=>work(tx as unknown as DbClient),options);
    if(result&&typeof result==='object'&&'captured'in result&&result.captured===true){committed=true;throw fault;}
    return result;
   }});
   const gets=f.gets.length,posts=f.posts.length;
   await expect(f.observeRecoveryQuery('app',target('unknown'),'SUCCESS',()=>recoverAppRechargeRefund(app(wrapped as DbClient),f.env,target('unknown')))).rejects.toBe(fault);
   expect(committed).toBe(true);expect(f.gets).toHaveLength(gets+1);expect(f.posts).toHaveLength(posts);
   const [actual]=await f.appRuntime.db.execute(sql`SELECT
    (SELECT status FROM public.recharge_refund_state WHERE operation_id=${target('unknown')}::uuid) AS status,
    (SELECT count(*)::integer FROM public.recharge_refund_result WHERE operation_id=${target('unknown')}::uuid AND source='local_settlement') AS local,
    (SELECT count(*)::integer FROM public.capital_flow WHERE event_key=${'recharge.refund:'+target('unknown')}) AS flow,
    (SELECT count(*)::integer FROM public.store_order_outbox WHERE event_key=${'recharge.refund.success.notice:'+target('unknown')}) AS notice`);
   expect(actual).toEqual({status:'SUCCEEDED',local:1,flow:1,notice:1});expect(await f.wallet(specimen('unknown').order.uid)).toBe('1.50');
  }),5000);
  it('replays that exact stored query result after current query approval and credentials are withdrawn, without another GET',()=>start(async()=>{
   const registry=f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS;await f.approve(2,'revoked');f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS='';
   const gets=f.gets.length,posts=f.posts.length,before=await f.snapshot(specimen('unknown').order);
   try{expect(await recoverAppRechargeRefund(app(),f.env,target('unknown'))).toMatchObject({outcome:'captured',replayed:true});
    expect(await f.snapshot(specimen('unknown').order)).toBe(before);expect(f.gets).toHaveLength(gets);expect(f.posts).toHaveLength(posts);
   }finally{f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS=registry;}
  }),5000);
  it('records an actual nonterminal query observation then immediately returns the immutable wait fence without another GET',()=>start(async()=>{
   await f.approve(2,'active',['refund_query']);const id=target('merchantMissing'),gets=f.gets.length,posts=f.posts.length;
   expect(await f.observeRecoveryQuery('app',id,'UNKNOWN',()=>recoverAppRechargeRefund(app(),f.env,id))).toMatchObject({operationId:id,outcome:'observed',providerStatus:'UNKNOWN'});
   const before=await f.snapshot(specimen('merchantMissing').order),waiting=await recoverAppRechargeRefund(app(),f.env,id);
   expect(waiting).toMatchObject({operationId:id,outcome:'waiting'});expect(await f.snapshot(specimen('merchantMissing').order)).toBe(before);
   expect(f.gets).toHaveLength(gets+1);expect(f.posts).toHaveLength(posts);
  }),5000);
  it('never issues an initial POST for a genuinely admitted pristine operation with no request attempt',()=>start(async()=>{
   await f.approve(1,'active');const paid=await f.paid(rechargeAuthorUids[18]),q=await f.quote(paid.order),key=randomUUID();
   const operation=(await f.admit(key,f.body(paid.order,q,false))).operation,gets=f.gets.length,posts=f.posts.length,before=await f.snapshot(paid.order);
   expect(await recoverAppRechargeRefund(app(),f.env,operation.operation_id)).toEqual({operationId:operation.operation_id,outcome:'not_requested'});
   expect(await f.snapshot(paid.order)).toBe(before);expect(f.gets).toHaveLength(gets);expect(f.posts).toHaveLength(posts);
   expect(await f.appRuntime.db.execute(sql`SELECT attempt_id FROM public.recharge_refund_attempt WHERE operation_id=${operation.operation_id}::uuid`)).toHaveLength(0);
  }),5000);
  it('retains all original economic/provider cases and adds only two independently committed recovery GETs',()=>start(async()=>{
   expect(f.posts).toHaveLength(11);expect(f.gets).toHaveLength(15);
   console.log('RECHARGE_RECOVERY_SERVICE_NATIVE_PROOF '+JSON.stringify({fixedActualAppLogin:true,storedSuccessNoGet:true,storedClosedNoGet:true,
    actualDueClaimGetPersistCapture:true,actualCaptureCommitLostAck:true,retiredCredentialReplayNoGet:true,nonterminalObservationThenWait:true,
    pristineAdmittedNoInitialPost:true,original42CasesRetained:true,totalPosts:f.posts.length,totalGets:f.gets.length,automaticRecoveryGets:2}));
  }),5000);
 });
});
