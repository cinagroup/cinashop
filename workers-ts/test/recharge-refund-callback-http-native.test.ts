/** Actual production callback HTTP/DI plus real workerd RSA/AES, SQL COMMIT,
 * durable ACK and actual Worker Queue. Only local issuer/transport/ACK faults. */
import {createHash,randomUUID}from 'node:crypto';
import {performance}from 'node:perf_hooks';
import {setTimeout as delay}from 'node:timers/promises';
import {resolve}from 'node:path';
import {build}from 'esbuild';
import {Miniflare,convertV4MiniflareOptions,Response as LocalResponse,type V4FetchHandler}from 'miniflare';
import {sql}from 'drizzle-orm';
import {beforeAll,afterAll,afterEach,describe,it,expect,vi}from 'vitest';
import type {OrderMessage}from '@/env';
import type {DbClient}from '@/lib/di';
import {runRechargeRefundNoticeUpgrade}from '@/migrations/rechargeRefundNotice';
import {claimRechargeRefundServiceQuery}from '@/services/payment/RechargeRefundQueryClaim';
import {readRechargeRefundMixedProviderHistoryTx}from '@/services/payment/RechargeRefundMixedProviderHistory';
import {isRechargeRefundRecoveryMessage,isRechargeRefundRecoveryDispatch}from '@/services/payment/RechargeRefundRecoveryQueue';
import {rechargeRefundCallbackEconomicNativeFixture,type RechargeRefundCallbackEconomicNativeFixture}from './helpers/rechargeRefundCallbackEconomicNative';
import type {CallbackNativePacket,CallbackNativeSpecimen}from './helpers/rechargeRefundCallbackEconomicNative';
const transport = vi.hoisted(() => {
  const values = new Map<string, unknown>(), get = vi.fn(async (k: string) => values.get(k) ?? null), set = vi.fn(async (k: string, v: unknown) => { values.set(k, v); return true; });
  const remove = vi.fn(async (k: string) => values.delete(k)), take = vi.fn(async (k: string) => { const v = values.get(k) ?? null; values.delete(k); return v; });
  const setIfAbsent = vi.fn(async (k: string, v: unknown) => { if (values.has(k)) return false; values.set(k, v); return true; });
  const redis = { eval: vi.fn(async () => 1), get, set: vi.fn(async (k: string, v: unknown) => { await set(k, v); return 'OK'; }), del: vi.fn(async (k: string) => Number(await remove(k))) };
  return { values, get, set, remove, take, setIfAbsent, redis };
});
vi.mock('@/utils/cache', async original => ({ ...await original<typeof import('@/utils/cache')>(), getRedis: () => transport.redis,
  cacheGet: transport.get, cacheSet: transport.set, cacheTake: transport.take, cacheDelete: transport.remove, cacheSetIfAbsent: transport.setIfAbsent,
  setTokenBucket: vi.fn(async () => true), clearToken: vi.fn(async () => true) }));
const names=['success','closedGift','enqueueBefore','enqueueAfter','enqueueHold','rollback','lostAck','rotate','n2','abnormal']as const;
type Name=typeof names[number];
type Exchange={messages:OrderMessage[];trace:Array<{mode:string;committed:boolean}>;acks:string[];retries:string[]};
const status=(name:Name)=>name==='abnormal'?'ABNORMAL':['closedGift','enqueueAfter','n2'].includes(name)?'CLOSED':'SUCCESS';
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('actual production recharge refund callback HTTP in workerd',()=>{
 let f:RechargeRefundCallbackEconomicNativeFixture,mf:Miniflare,wrong:Miniflare,setup:Promise<void>|undefined,pending:Promise<unknown>|undefined,busy=false;
 const specimens=new Map<Name,CallbackNativeSpecimen>(),packets=new Map<Name,CallbackNativePacket>(),work=new Map<Name,OrderMessage>();
 const key=randomUUID(),gatewayCalls:string[]=[],ackTimes:number[]=[];let captured=0,released=0;
 const start=<T>(run:()=>Promise<T>)=>{if(busy)throw Error('Previous HTTP action still pending');busy=true;const p=run().finally(()=>{busy=false;});pending=p;void p.catch(()=>undefined);return p;};
 beforeAll(async()=>{setup=(async()=>{
  f=await rechargeRefundCallbackEconomicNativeFixture(transport.values);
  const [index]=await f.maintenanceDb.execute<{present:boolean}>(sql`SELECT pg_catalog.to_regclass('public.cf_event_key_uq') IS NOT NULL AS present`);
  if(!index)throw Error('Missing owned catalog');if(!index.present)await f.maintenanceDb.execute(sql`CREATE UNIQUE INDEX cf_event_key_uq ON public.capital_flow USING btree(event_key)`);
  await runRechargeRefundNoticeUpgrade(f.maintenanceDb);
  const bundle=await build({entryPoints:[resolve(import.meta.dirname,'integration/RechargeRefundCallbackWorkerdScenario.ts')],bundle:true,write:false,format:'esm',platform:'browser',conditions:['workerd','worker','browser'],external:['node:*','cloudflare:*'],target:'es2022',tsconfig:resolve(import.meta.dirname,'../tsconfig.json')});
  const outbound:V4FetchHandler=async request=>{gatewayCalls.push(request.url);return new LocalResponse('Unplanned actual Worker external I/O',{status:503});};
  const runtime=(connectionString:string)=>new Miniflare(convertV4MiniflareOptions({script:bundle.outputFiles[0].text,modules:true,compatibilityDate:'2026-08-09',compatibilityFlags:['nodejs_compat'],host:'127.0.0.1',port:0,kvNamespaces:['CONFIG_KV'],hyperdrives:{HYPERDRIVE:connectionString},outboundService:outbound,
   bindings:{APP_KEY:f.env.APP_KEY,UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:'',ORDER_DLQ_NAME:'recharge-refund-http-dlq',ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS:f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS!,TEST_SCENARIO_KEY:key,TEST_OWNED_DATABASE:f.binding.database}}));
  mf=runtime(f.appRuntime.connectionString);await mf.ready;wrong=runtime(f.adminRuntime.connectionString);await wrong.ready;
 })();await setup;},240000);
 afterAll(async()=>{try{if(setup)await Promise.allSettled([setup]);if(pending)await Promise.allSettled([pending]);}
  finally{try{if(mf)await control('/test/drain',{});}finally{try{await wrong?.dispose();}finally{try{await mf?.dispose();}finally{try{await f?.close();}finally{vi.restoreAllMocks();}}}}}},30000);
 afterEach(()=>{expect(gatewayCalls).toEqual([]);});
 const specimen=(name:Name)=>{const r=specimens.get(name);if(!r)throw Error('Missing actual specimen '+name);return r;};
 async function control(path:string,input:unknown,runtime=mf):Promise<Exchange>{const response=await runtime.dispatchFetch('http://localhost'+path,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(input)});expect(response.status).toBe(200);return await response.json()as Exchange;}
 async function drain(){return control('/test/drain',{});}
 async function rows(name:Name){return Array.from(await f.appRuntime.db.execute(sql`SELECT * FROM public.recharge_refund_result WHERE operation_id=${specimen(name).operation.operation_id}::uuid AND source='callback' ORDER BY created_at,result_id`));}
 async function whole(name:Name){const r=specimen(name);return f.appRuntime.db.transaction(async raw=>{const tx=raw as unknown as DbClient;
  const [s]=await tx.execute(sql`SELECT last_result_id FROM public.recharge_refund_state WHERE operation_id=${r.operation.operation_id}::uuid`);
  return readRechargeRefundMixedProviderHistoryTx(tx,f.env,'app',r.operation.operation_id,s?.last_result_id??undefined,'read');},{isolationLevel:'repeatable read',accessMode:'read only'});}
 async function money(name:Name){const r=specimen(name),id=String(r.operation.operation_id),base=JSON.parse(await f.snapshot(r.order))as Record<string,unknown>;delete base.results;
  const [extra]=await f.maintenanceDb.execute<{value:unknown}>(sql`SELECT jsonb_build_object('flows',(SELECT COALESCE(jsonb_agg(to_jsonb(t)||jsonb_build_object('_xmin',xmin::text) ORDER BY id),'[]'::jsonb) FROM public.capital_flow t WHERE event_key=${'recharge.refund:'+id}),
   'notices',(SELECT COALESCE(jsonb_agg(to_jsonb(t)||jsonb_build_object('_xmin',xmin::text) ORDER BY id),'[]'::jsonb) FROM public.store_order_outbox t WHERE event_key=${'recharge.refund.success.notice:'+id}))AS value`);
  return JSON.stringify({base,extra:extra.value});}
 async function issue(name:Name){await f.approve(3,'active',['refund_notify']);const p=f.packet(specimen(name),status(name));
  const raw=f.issue({...p.envelope,summary:'退款通知'},p.plaintext);packets.set(name,raw);return raw;}
 async function http(name:Name,p=packets.get(name)!,options:{path?:string;method?:string;headers?:Record<string,string>;body?:string|Uint8Array;runtime?:Miniflare;fault?:string}={}){
  if(!p)throw Error('Missing actual issuer packet');const r=specimen(name),path=options.path??(options.fault?'/test/fault/'+options.fault+'/':'/api/pay/notify/recharge-refund/')+String(r.operation.operation_id);
  const began=performance.now(),response=await(options.runtime??mf).dispatchFetch('http://localhost'+path,{method:options.method??'POST',headers:{...p.headers,...(options.fault?{Authorization:'Bearer '+key}:{}),...options.headers},body:options.method==='GET'?undefined:options.body??p.body});
  const elapsedMs=performance.now()-began;if(response.status===204){ackTimes.push(elapsedMs);expect(elapsedMs).toBeLessThan(5000);expect(await response.text()).toBe('');}
  else{expect(await response.json()).toEqual(response.status===405?{code:'FAIL',message:'仅接受 POST'}:{code:'FAIL',message:'充值退款通知尚未完成持久核对'});}
  expect(response.headers.get('Cache-Control')).toContain('no-store');return response.status;
 }
 async function enqueue(name:Name){const r=await drain(),matches=r.messages.filter(isRechargeRefundRecoveryMessage);expect(matches).toHaveLength(1);expect(matches[0].operationId).toBe(specimen(name).operation.operation_id);work.set(name,matches[0]);return r;}
 async function settle(name:Name,message=work.get(name)){if(!message)throw Error('Missing real queued address');const before=await money(name),r=await control('/test/queue',{messages:[message]});expect(r.acks).toEqual(['local-0']);expect(r.retries).toEqual([]);
  const h=await whole(name);expect(h.state.wallet_state).toBe(status(name)==='SUCCESS'?'captured':'released');expect(h.local?.caused_by_result_id).toBe((await rows(name))[0].result_id);
  expect(await money(name)).not.toBe(before);if(status(name)==='SUCCESS')captured++;else released++;return h;}
 it('runs the actual ordinary App and wrong-LOGIN HTTP surfaces on distinct real backends',()=>start(async()=>{
  for(const [runtime,role]of [[mf,f.profilePeers.app.role],[wrong,f.profilePeers.admin.role]]as const){const result=await runtime.dispatchFetch('http://localhost/test/identity',{headers:{Authorization:'Bearer '+key}});expect(await result.json()).toMatchObject({database:f.binding.database,role,login:true});}
 }),5000);
 it.each(names)('authors real paid/held/solePOST specimen%s',name=>start(async()=>{const r=await f.persisted('UNKNOWN',name==='closedGift');specimens.set(name,r);expect(await rows(name)).toEqual([]);}),5000);
 it('acknowledges actual RSA/AES HTTP only after durable raw-byte evidence COMMIT and leaves money held',()=>start(async()=>{
  const p=await issue('success'),before=await money('success');expect(await http('success',p)).toBe(204);expect(await money('success')).toBe(before);
  const saved=await rows('success');expect(saved).toHaveLength(1);const e=saved[0].evidence as {verification:{requestDigest:string;plaintextDigest:string;verifierKey:string}};
  expect(e.verification).toMatchObject({requestDigest:createHash('sha256').update(p.body).digest('hex'),plaintextDigest:createHash('sha256').update(p.plaintext).digest('hex'),verifierKey:f.keyId});await enqueue('success');
 }),5000);
 it('actual Worker Queue consumes only the original held debit after successful HTTP ACK',()=>start(async()=>{await f.maintenanceDb.execute(sql`UPDATE public."user" SET now_money=-3 WHERE uid=${specimen('success').order.uid}`);await settle('success');expect(await f.wallet(specimen('success').order.uid)).toBe('-3.00');}),5000);
 it('re-encrypted/re-signed identical cleartext retains the original result and replays money on duplicate delivery',()=>start(async()=>{
  const before=await rows('success'),snapshot=await money('success'),p=f.reencrypt(packets.get('success')!);expect(p.body).not.toBe(packets.get('success')!.body);expect(await http('success',p)).toBe(204);expect(await rows('success')).toEqual(before);await enqueue('success');
  const r=await control('/test/queue',{messages:[work.get('success')]});expect(r.acks).toEqual(['local-0']);expect(r.retries).toEqual([]);expect(await money('success')).toBe(snapshot);
 }),5000);
 it('refuses changed cleartext for the same event even with genuine workerd RSA/AES',()=>start(async()=>{
  const old=packets.get('success')!,value=JSON.parse(old.plaintext)as Record<string,unknown>,p=f.reencrypt({...old,plaintext:JSON.stringify({...value,user_received_account:'changed-account'})});
  const before=await rows('success'),snapshot=await money('success');expect(await http('success',p)).toBe(503);expect(await rows('success')).toEqual(before);expect(await money('success')).toBe(snapshot);expect((await drain()).messages).toEqual([]);
 }),5000);
 it.each(['raw-byte','RSA','AES','amount','merchant','business','clear-UTF8','missing-header','oversized-header','oversized-body','wrong-operation','wrong-role','wrong-method']as const)('rejects actual HTTP%s without accepting evidence or changing money',kind=>start(async()=>{
  const old=packets.get('success')!,before=await rows('success'),snapshot=await money('success');let p=old,opts:Parameters<typeof http>[2]={};
  if(kind==='raw-byte')opts.body=old.body+' ';
  if(kind==='RSA')opts.headers={'wechatpay-signature':(old.headers['wechatpay-signature'][0]==='A'?'B':'A')+old.headers['wechatpay-signature'].slice(1)};
  if(kind==='AES')p=f.packet(specimen('success'),'SUCCESS',{}, {wrongKey:true});
  if(kind==='amount')p=f.packet(specimen('success'),'SUCCESS',{amount:{total:1000,refund:999,payer_total:1000,payer_refund:999}});
  if(kind==='merchant')p=f.packet(specimen('success'),'SUCCESS',{mchid:'9999999999'});
  if(kind==='business')p=f.packet(specimen('success'),'SUCCESS',{out_refund_no:'unrelated-refund'});
  if(kind==='clear-UTF8')p=f.packet(specimen('success'),'SUCCESS',{}, {bytes:Uint8Array.of(0xff)});
  if(kind==='missing-header')opts.headers={'wechatpay-signature':''};
  if(kind==='oversized-header')opts.headers={'wechatpay-nonce':'a'.repeat(129)};
  if(kind==='oversized-body')opts.body='x'.repeat(16385);
  if(kind==='wrong-operation')opts.path='/api/pay/notify/recharge-refund/'+specimen('rollback').operation.operation_id;
  if(kind==='wrong-role')opts.runtime=wrong;
  if(kind==='wrong-method')opts.method='GET';
  expect(await http('success',p,opts)).toBe(kind==='wrong-method'?405:503);expect(await rows('success')).toEqual(before);expect(await money('success')).toBe(snapshot);expect((await drain()).messages).toEqual([]);
 }),5000);
 it.each(['rollback-read','lost-read','rollback-write']as const)('actual%s cannot produce a success ACK or enqueue',fault=>start(async()=>{
  const p=packets.get('rollback')??await issue('rollback'),before=await money('rollback');expect(await http('rollback',p,{fault})).toBe(503);expect(await rows('rollback')).toEqual([]);expect(await money('rollback')).toBe(before);
  const r=await drain();expect(r.messages).toEqual([]);expect(r.trace).toEqual(fault==='rollback-write'?[{mode:'read',committed:true},{mode:'write',committed:false}]:[{mode:'read',committed:fault==='lost-read'}]);
 }),5000);
 it('retries an actual rolled-back HTTP result through the production route and converges once',()=>start(async()=>{expect(await http('rollback')).toBe(204);await enqueue('rollback');await settle('rollback');}),5000);
 it('lost actual write COMMIT ACK returns failure despite durable truth, then redelivery preserves original bytes',()=>start(async()=>{
  const p=await issue('lostAck'),before=await money('lostAck');expect(await http('lostAck',p,{fault:'lost-write'})).toBe(503);const saved=await rows('lostAck');expect(saved).toHaveLength(1);expect(await money('lostAck')).toBe(before);
  const fault=await drain();expect(fault.messages).toEqual([]);expect(fault.trace).toEqual([{mode:'read',committed:true},{mode:'write',committed:true}]);
 }),5000);
 it('redelivers a lost actual COMMIT ACK through ordinary production HTTP and converges once',()=>start(async()=>{
  const saved=await rows('lostAck');expect(await http('lostAck')).toBe(204);expect(await rows('lostAck')).toEqual(saved);await enqueue('lostAck');await settle('lostAck');
 }),5000);
 it('only the maintained current original-account key can verify, regardless of untrusted URL selectors',()=>start(async()=>{
  const p=await issue('rotate');await f.approve(1,'active',['refund_notify']);expect(await http('rotate',p,{path:'/api/pay/notify/recharge-refund/'+specimen('rotate').operation.operation_id+'?appId=wx_recharge_refund_original_a&role=admin&credentialVersion=3'})).toBe(503);expect(await rows('rotate')).toEqual([]);expect((await drain()).messages).toEqual([]);
  await f.approve(3,'active',['refund_notify']);expect(await http('rotate',p)).toBe(204);await enqueue('rotate');await settle('rotate');
 }),5000);
 it('actual CLOSED callback ACK holds money until Worker returns the complete optional-gift hold without clamping',()=>start(async()=>{
  const p=await issue('closedGift');expect(await http('closedGift',p)).toBe(204);await enqueue('closedGift');await f.maintenanceDb.execute(sql`UPDATE public."user" SET now_money=-20 WHERE uid=${specimen('closedGift').order.uid}`);await settle('closedGift');expect(await f.wallet(specimen('closedGift').order.uid)).toBe('-8.50');
 }),5000);
 it.each(['enqueueBefore','enqueueAfter']as const)('durable ACK survives actual enqueue fault%s, leaving a due held operation',name=>start(async()=>{
  await control('/test/config',{failure:name==='enqueueBefore'?'before':'after'});const p=await issue(name),before=await money(name);expect(await http(name,p)).toBe(204);expect(await rows(name)).toHaveLength(1);expect(await money(name)).toBe(before);
  const r=await drain();expect(r.messages.filter(isRechargeRefundRecoveryMessage)).toHaveLength(name==='enqueueBefore'?0:1);await control('/test/config',{failure:'none'});
 }),5000);
 it('successful HTTP ACK does not wait for an unresolved Queue send',()=>start(async()=>{
  await control('/test/config',{failure:'hold'});const p=await issue('enqueueHold');expect(await http('enqueueHold',p)).toBe(204);expect((await whole('enqueueHold')).state.wallet_state).toBe('held');
  await enqueue('enqueueHold');await control('/test/config',{failure:'none'});await settle('enqueueHold');
 }),5000);
 it('durably ACKs ABNORMAL truth without manufacturing a terminal settlement message',()=>start(async()=>{
  const p=await issue('abnormal'),before=await money('abnormal');expect(await http('abnormal',p)).toBe(204);expect((await drain()).messages).toEqual([]);expect(await money('abnormal')).toBe(before);expect((await whole('abnormal')).state.wallet_state).toBe('held');
 }),5000);
 describe('after the actual first-attempt query fence',()=>{
  beforeAll(async()=>{if(busy)throw Error('Business pending before real HTTP wait');const began=performance.now();await delay(61000);const elapsedMs=Math.floor(performance.now()-began);expect(elapsedMs).toBeGreaterThanOrEqual(61000);console.log('RECHARGE_CALLBACK_HTTP_REAL_WAIT '+JSON.stringify({elapsedMs}));},240000);
  it('uses a genuine already-committed GET2 before accepting actual HTTP callback and Queue money atN2',()=>start(async()=>{
   const r=specimen('n2');await f.approve(2,'active',['refund_query']);const token=await claimRechargeRefundServiceQuery(f.appRuntime.db,f.env,'app',r.operation.operation_id),x=await f.query('app',token,'PROCESSING');await x.service.persistRechargeRefundQueryResult(x.verified);
   expect((await whole('n2')).state).toMatchObject({attempt_count:2,version:2,wallet_state:'held'});
  }),5000);
  it('actual production HTTP persists and ACKs callback truth atN2 while money remains held',()=>start(async()=>{
   const r=specimen('n2');await issue('n2');const p=f.packet(r,'CLOSED',{refund_id:'qr'+String(r.operation.operation_id).replaceAll('-','').slice(0,28)});expect(await http('n2',p)).toBe(204);await enqueue('n2');expect((await whole('n2')).state.wallet_state).toBe('held');
  }),5000);
  it('actual Worker callbackN2 consumes only the original hold with actual version2->3',()=>start(async()=>{
   const h=await settle('n2');expect(h.state).toMatchObject({attempt_count:2,version:3});
  }),5000);
  it('actual Cron/due scan recovers both failed enqueue boundaries without trusting HTTP status or supplied amounts',()=>start(async()=>{
   const scheduled=await control('/test/scheduled',{scheduledAt:Date.now()}),roots=scheduled.messages.filter(isRechargeRefundRecoveryDispatch);expect(roots).toHaveLength(1);
   const dispatched=await control('/test/queue',{messages:roots});expect(dispatched.retries).toEqual([]);const due=dispatched.messages.filter(isRechargeRefundRecoveryMessage);
   expect(due.map(m=>m.operationId).sort()).toEqual(['enqueueBefore','enqueueAfter','abnormal'].map(n=>String(specimen(n as Name).operation.operation_id)).sort());
   for(const name of ['enqueueBefore','enqueueAfter']as const){const address=due.find(m=>m.operationId===specimen(name).operation.operation_id);expect(address).toBeDefined();work.set(name,address!);}
  }),5000);
  it.each(['enqueueBefore','enqueueAfter']as const)('actual Worker converges HTTP truth after lost enqueue%s exactly once',name=>start(async()=>{
   await settle(name);const snapshot=await money(name),r=await control('/test/queue',{messages:[work.get(name)]});expect(r.acks).toEqual(['local-0']);expect(r.retries).toEqual([]);expect(await money(name)).toBe(snapshot);
  }),5000);
 });
 it('retains a contradictory authentic late HTTP callback without undoing already captured funds',()=>start(async()=>{
  const saved=await rows('success'),local=(await whole('success')).local,snapshot=await money('success'),old=JSON.parse(packets.get('success')!.plaintext)as Record<string,unknown>;
  const p=f.packet(specimen('success'),'CLOSED',{refund_id:old.refund_id});expect(await http('success',p)).toBe(204);expect(await rows('success')).toHaveLength(2);expect((await whole('success')).universe.disposition).toBe('manual_review');expect((await whole('success')).local).toEqual(local);expect(await money('success')).toBe(snapshot);expect((await rows('success'))).toContainEqual(saved[0]);await drain();
 }),5000);
 it('reports actual HTTP crypto/COMMIT/ACK/Queue closure with explicit remaining migration scope',()=>start(async()=>{
  expect(f.posts).toHaveLength(10);expect(f.gets).toHaveLength(1);expect(captured).toBe(6);expect(released).toBe(3);expect(ackTimes.length).toBeGreaterThanOrEqual(12);expect(ackTimes.every(t=>t<5000)).toBe(true);expect(gatewayCalls).toEqual([]);
  console.log('RECHARGE_CALLBACK_HTTP_NATIVE_PROOF '+JSON.stringify({posts:10,gets:1,captures:captured,releases:released,successfulAcks:ackTimes.length,maxAckMs:Math.ceil(Math.max(...ackTimes)),actualProductionWorkerAppDiRoute:true,actualWorkerdRsaAesRawDigests:true,actualReadCommitBeforeCrypto:true,actualDurableCommitBeforeAck:true,actualReadWriteRollbackAndLostCommitAck:true,actualWrongLoginAndKeyRotationRefused:true,actualAckIndependentOfQueue:true,actualCronLostEnqueueRecovery:true,actualWorkerCallbackN2:true,actualAbnormalHeldAndLateConflictRetained:true,noticeConsumerAndUiAccepted:false}));
 }),5000);
});
