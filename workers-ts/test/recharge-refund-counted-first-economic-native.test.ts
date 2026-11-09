/** Genuine deferred original POST atN2/N3 plus DIRECT Worker callbackN2.
 * Only the strict local channel issuer is synthetic; no provider/funds row is seeded. */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions, Response as LocalResponse, type V4FetchHandler } from 'miniflare';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrderMessage } from '@/env';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { runRechargeRefundNoticeUpgrade } from '@/migrations/rechargeRefundNotice';
import { recoverAppRechargeRefund, recoverAdminRechargeRefund } from '@/services/payment/RechargeRefundRecoveryService';
import { readRechargeRefundMixedProviderHistoryTx } from '@/services/payment/RechargeRefundMixedProviderHistory';
import { claimRechargeRefundServiceQuery } from '@/services/payment/RechargeRefundQueryClaim';
import { captureRechargeRefundSuccessFirstResult } from '@/services/payment/RechargeRefundSuccessCapture';
import { releaseRechargeRefundClosedFirstResult } from '@/services/payment/RechargeRefundClosedRelease';
import { captureRechargeRefundSuccessCountedFirstResult } from '@/services/payment/RechargeRefundCountedFirstSuccessCapture';
import { releaseRechargeRefundClosedCountedFirstResult } from '@/services/payment/RechargeRefundCountedFirstClosedRelease';
import { lookupAdminRechargeRefundExecution } from '@/services/admin/AdminRechargeRefundReadService';
import { isRechargeRefundRecoveryDispatch, isRechargeRefundRecoveryMessage, type RechargeRefundRecoveryMessage } from '@/services/payment/RechargeRefundRecoveryQueue';
import { rechargeRefundCallbackEconomicNativeFixture, type RechargeRefundCallbackEconomicNativeFixture, type CallbackNativeSpecimen } from './helpers/rechargeRefundCallbackEconomicNative';
import type { NativeQueryExchange } from './helpers/rechargeQueryProviderNative';
import type { RechargeRefundCallbackReceipt } from '@/services/payment/RechargeRefundCallbackService';

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
const names=['appSuccess','adminClosed','financialSuccess','financialClosed','rollbackSuccess','rollbackClosed','concurrent','n3Success','workerFirstSuccess','workerCbSuccess','workerCbClosed'] as const;
type Name = typeof names[number];
type Subject = Pick<CallbackNativeSpecimen, 'order' | 'operation' | 'transaction' | 'key'>;
type Exchange = { messages: OrderMessage[]; acks: string[]; retries: Array<{ id: string; delaySeconds: number }> };
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('actual counted first response and Worker callbackN2 owners', () => {
  let f: RechargeRefundCallbackEconomicNativeFixture, mf: Miniflare, setup: Promise<void> | undefined, pending: Promise<unknown> | undefined, busy = false;
  const specimens = new Map<Name, Awaited<ReturnType<RechargeRefundCallbackEconomicNativeFixture['requested']>>>(), callbacks = new Map<Name, RechargeRefundCallbackReceipt>(), queries = new Map<Name, { exchange: NativeQueryExchange; resultId?: string }>();
  const firstResults=new Map<Name,string>();
  const key = randomUUID(), gatewayCalls: string[] = []; let captured = 0, released = 0, due: RechargeRefundRecoveryMessage[] = [];
  const start = <T>(run: () => Promise<T>) => {
    if (busy) throw Error('Previous counted first action pending'); busy = true;
    const work = run().finally(() => { busy = false; }); pending = work; void work.catch(() => undefined); return work;
  };
  beforeAll(async () => { setup = (async () => {
    f = await rechargeRefundCallbackEconomicNativeFixture(transport.values);
    const [index] = await f.maintenanceDb.execute<{ present: boolean }>(sql`SELECT pg_catalog.to_regclass('public.cf_event_key_uq') IS NOT NULL AS present`);
    if (!index) throw Error('Missing owned flow catalog'); if (!index.present) await f.maintenanceDb.execute(sql`CREATE UNIQUE INDEX cf_event_key_uq ON public.capital_flow USING btree(event_key)`);
    await runRechargeRefundNoticeUpgrade(f.maintenanceDb);
    const bundle = await build({ entryPoints: [resolve(import.meta.dirname, 'integration/RechargeRefundRecoveryWorkerdScenario.ts')], bundle: true, write: false,
      format: 'esm', platform: 'browser', conditions: ['workerd', 'worker', 'browser'], external: ['node:*', 'cloudflare:*'], target: 'es2022', tsconfig: resolve(import.meta.dirname, '../tsconfig.json') });
    const outbound: V4FetchHandler = async request => { gatewayCalls.push(request.url); return new LocalResponse('Counted first/callback recovery must not dispatch provider I/O', { status: 503 }); };
    mf = new Miniflare(convertV4MiniflareOptions({ script: bundle.outputFiles[0].text, modules: true, compatibilityDate: '2026-08-09', compatibilityFlags: ['nodejs_compat'],
      host: '127.0.0.1', port: 0, kvNamespaces: ['CONFIG_KV'], hyperdrives: { HYPERDRIVE: f.appRuntime.connectionString }, outboundService: outbound,
      bindings: { APP_KEY: f.env.APP_KEY, UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '', ORDER_DLQ_NAME: 'recharge-refund-local-dlq',
        ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS: f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS!, TEST_SCENARIO_KEY: key,
        TEST_OWNED_DATABASE: f.binding.database, TEST_APP_LOGIN: f.profilePeers.app.role } })); await mf.ready;
  })(); await setup; }, 240000);
  afterAll(async () => { try { if (setup) await Promise.allSettled([setup]); if (pending) await Promise.allSettled([pending]); }
    finally { try { await mf?.dispose(); } finally { try { await f?.close(); } finally { vi.restoreAllMocks(); } } } }, 30000);
  afterEach(() => { expect(gatewayCalls).toEqual([]); });
  function specimen(name: Name) { const r = specimens.get(name); if (!r) throw Error('Missing real specimen ' + name); return r; }
  async function call(path: string, input: unknown): Promise<Exchange> {
    const response = await mf.dispatchFetch('http://localhost/' + path, { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    expect(response.status).toBe(200); return await response.json() as Exchange;
  }
  async function whole(r: Subject) {
    return f.appRuntime.db.transaction(async tx => {
      const [s] = await tx.execute(sql`SELECT last_result_id FROM public.recharge_refund_state WHERE operation_id=${r.operation.operation_id}::uuid`);
      return readRechargeRefundMixedProviderHistoryTx(tx as unknown as DbClient, f.env, 'app', r.operation.operation_id, s?.last_result_id ?? undefined, 'read');
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }
  async function local(r: Subject) { const h = await whole(r); if (!h.local) throw Error('Missing real local receipt'); return h.local; }
  async function snapshot(r: Subject) {
    const id = String(r.operation.operation_id), [extra] = await f.maintenanceDb.execute<{ value: unknown }>(sql`SELECT jsonb_build_object(
      'flows',(SELECT COALESCE(jsonb_agg(to_jsonb(t)||jsonb_build_object('_xmin',xmin::text) ORDER BY id),'[]'::jsonb) FROM public.capital_flow t WHERE event_key=${'recharge.refund:' + id} OR flow_id=${id.replaceAll('-', '')}),
      'notices',(SELECT COALESCE(jsonb_agg(to_jsonb(t)||jsonb_build_object('_xmin',xmin::text) ORDER BY id),'[]'::jsonb) FROM public.store_order_outbox t WHERE event_key=${'recharge.refund.success.notice:' + id})) AS value`);
    return JSON.stringify({ base: JSON.parse(await f.snapshot(r.order)), extra: extra.value });
  }
  async function unchanged(r: Subject, run: () => Promise<unknown>, rejects = false) {
    const before = await snapshot(r), posts = f.posts.length, gets = f.gets.length;
    if (rejects) await expect(run()).rejects.toThrow(); else await run();
    expect(await snapshot(r)).toBe(before); expect(f.posts).toHaveLength(posts); expect(f.gets).toHaveLength(gets);
  }
  async function view(r: Subject, phase: 'succeeded' | 'released' | 'awaiting_local', attempts = 1) {
    const before = await snapshot(r), result = await lookupAdminRechargeRefundExecution(f.adminContainer, f.env, f.actor(), r.key);
    expect(result?.receipt).toMatchObject({ operationId: r.operation.operation_id, requestHash: r.operation.request_hash });
    expect(result?.execution).toMatchObject({ phase, wallet: phase === 'succeeded' ? 'captured' : phase === 'released' ? 'released' : 'held', attemptCount: attempts });
    expect(await snapshot(r)).toBe(before); return result;
  }
  async function retain(r: Subject, status: 'SUCCESS' | 'CLOSED', patch: Record<string, unknown> = {}) {
    await f.approve(3, 'active', ['refund_notify']); const p = f.packet(r, status, patch), s = f.callbackService();
    return s.persist(await s.verify(r.operation.operation_id, p.headers, p.body));
  }
  async function matching(r: Subject) {
    const h = await whole(r), result = h.universe.requestQueryHistory.results.find(p => ['SUCCESS', 'CLOSED'].includes(p.observation.status));
    if (!result) throw Error('Missing original terminal observation');
    return { refund_id: result.observation.providerRefundId, ...(result.observation.status === 'SUCCESS'
      ? { success_time: new Date(result.observation.successTime * 1000).toISOString().replace('.000Z', 'Z') } : {}) };
  }
  const success=(name:Name)=>name.endsWith('Success')||name==='concurrent';
  const countedNames=names.filter(n=>!n.startsWith('workerCb'));
  async function money(name:Name,role:'app'|'admin'|'financial'='app',db=f.profilePeers[role].db){
    const r=specimen(name),id=firstResults.get(name);if(!id)throw Error('Missing actual original POST result');
    return (success(name)?captureRechargeRefundSuccessCountedFirstResult:releaseRechargeRefundClosedCountedFirstResult)(createContainerFromDb(db),f.env,role,r.operation.operation_id,id);
  }
  function controlledRoot(role:'app'|'financial'){
    const db=f.profilePeers[role].db,wrapped=Object.create(db),d=Object.getOwnPropertyDescriptor(db,'$client');
    if(!d||!('value' in d))throw Error('Missing actual root');Object.defineProperty(wrapped,'$client',{value:d.value});
    let mode:'none'|'rollback'|'lost-ack'='none',calls=0,commits=0;const fault=Error('Counted original POST actual transaction ACK fault');
    Object.defineProperty(wrapped,'transaction',{value:async(work:(tx:DbClient)=>Promise<unknown>,options:Parameters<DbClient['transaction']>[1])=>{
      expect(options).toEqual({isolationLevel:'read committed',accessMode:'read write'});calls++;
      const value=await db.transaction(async raw=>{const result=await work(raw as unknown as DbClient);if(mode==='rollback'){mode='none';throw fault;}return result;},options);
      commits++;if(mode==='lost-ack'){mode='none';throw fault;}return value;
    }});return{root:wrapped as DbClient,fault,set:(v:typeof mode)=>{mode=v;},counts:()=>({calls,commits})};
  }
  const pgCode=(e:unknown):unknown=>e&&typeof e==='object'?'code' in e?(e as {code:unknown}).code:'cause' in e?pgCode((e as {cause:unknown}).cause):undefined:undefined;
  async function recordFirst(name:Name){const r=specimen(name),saved=await r.service.persistRechargeRefundFirstResult(r.verified);
    expect(saved.status).toBe(success(name)?'SUCCESS':'CLOSED');firstResults.set(name,saved.resultId);return saved;}
  async function countedLocal(name:Name,n=2){const r=specimen(name),h=await whole(r),l=h.local;
    expect(h.universe.requestQueryHistory.totalAttempts).toBe(n);expect(h.state.version).toBe(n+1);expect(l?.caused_by_result_id).toBe(firstResults.get(name));
    expect((l?.evidence as Record<string,unknown>).purpose).toBe('recharge-refund-counted-first-'+(success(name)?'local-capture-v1':'closed-release-v1'));return l;
  }
  it('uses a distinct actual App LOGIN connection in the real Worker',()=>start(async()=>{
    const r=await mf.dispatchFetch('http://localhost/identity',{headers:{Authorization:'Bearer '+key}});expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({role:f.profilePeers.app.role,database:f.binding.database,login:true});
  }),5000);
  it.each(names)('authors actual payment, hold and sole verified POST without result persistence%s',name=>start(async()=>{
    const r=await f.requested(name.startsWith('workerCb')?'UNKNOWN':success(name)?'SUCCESS':'CLOSED',name==='adminClosed'||name==='rollbackClosed');specimens.set(name,r);
    expect((await whole(r)).universe.requestQueryHistory.results).toHaveLength(0);expect(f.posts.filter(p=>p.body.out_refund_no===r.operation.out_refund_no)).toHaveLength(1);
    if(!name.startsWith('workerCb')){const issued=f.firstIssuerTranscripts.get(String(r.operation.out_refund_no));expect(issued).toBeDefined();f.queryIssuerRefundIds.set(String(r.operation.operation_id),issued!.refundId);}
  }),5000);
  describe('after the actual original attempt fence',()=>{
    beforeAll(async()=>{if(busy)throw Error('Pending business before real wait');const began=performance.now();await delay(61000);
      const elapsedMs=Math.floor(performance.now()-began);expect(elapsedMs).toBeGreaterThanOrEqual(61000);console.log('RECHARGE_COUNTED_FIRST_REAL_WAIT '+JSON.stringify({fence:1,elapsedMs}));},240000);
    it.each(names)('claims/sends/verifies actual GET2 while original first response is unrecorded%s',name=>start(async()=>{
      const r=specimen(name);await f.approve(2,'active',['refund_query']);const token=await claimRechargeRefundServiceQuery(f.appRuntime.db,f.env,'app',r.operation.operation_id);
      const exchange=await f.query('app',token,name==='workerCbSuccess'?'CLOSED':'PROCESSING');
      // These two actual responses stay independently verified but unrecorded
      // until after Worker callback money, covering real late truth atN2.
      const saved=name.startsWith('workerCb')?undefined:await exchange.service.persistRechargeRefundQueryResult(exchange.verified);
      queries.set(name,{exchange,resultId:saved?.resultId});expect((await whole(r)).state).toMatchObject({status:'UNKNOWN',attempt_count:2,version:2,wallet_state:'held'});
    }),5000);
    it.each(countedNames.filter(n=>n!=='n3Success'))('independently commits terminal original POST after real GET2%s',name=>start(async()=>{
      const saved=await recordFirst(name);expect((await whole(specimen(name))).universe.requestQueryHistory.results.find(x=>x.record.result_id===saved.resultId)?.record.source).toBe('request');
    }),5000);
    it('keeps old firstN1 money authors closed and rejects a borrowed root',()=>start(async()=>{
      const a=specimen('appSuccess'),b=specimen('adminClosed');
      await unchanged(a,()=>captureRechargeRefundSuccessFirstResult(f.appContainer,f.env,'app',a.operation.operation_id,firstResults.get('appSuccess')),true);
      await unchanged(b,()=>releaseRechargeRefundClosedFirstResult(f.appContainer,f.env,'app',b.operation.operation_id,firstResults.get('adminClosed')),true);
      await unchanged(a,()=>money('appSuccess','app',f.adminRuntime.db),true);
    }),5000);
    it.each(['appSuccess','adminClosed','financialSuccess','financialClosed'] as const)('settles original cause with actual count using%s role, negative wallet and optional gift',name=>start(async()=>{
      const r=specimen(name),role=name.startsWith('financial')?'financial':name==='adminClosed'?'admin':'app';
      await f.maintenanceDb.execute(sql`UPDATE public."user" SET now_money=-20 WHERE uid=${r.order.uid}`);
      const result=name==='appSuccess'?await recoverAppRechargeRefund(f.appContainer,f.env,r.operation.operation_id)
        :name==='adminClosed'?await recoverAdminRechargeRefund(f.adminContainer,f.env,f.actor(),r.operation.operation_id):await money(name,role);
      expect(result).toMatchObject({replayed:false});if(success(name))captured++;else released++;
      expect(await f.wallet(r.order.uid)).toBe(success(name)?'-20.00':name==='adminClosed'?'-8.50':'-10.00');
      await countedLocal(name);await view(r,success(name)?'succeeded':'released',2);
    }),5000);
    it.each(['rollbackSuccess','rollbackClosed'] as const)('rolls back all counted first money while retaining actual provider truth%s',name=>start(async()=>{
      const c=controlledRoot('app'),r=specimen(name);c.set('rollback');await unchanged(r,async()=>{await expect(money(name,'app',c.root)).rejects.toBe(c.fault);});
      expect(c.counts()).toEqual({calls:1,commits:0});expect((await whole(r)).state.wallet_state).toBe('held');
    }),5000);
    it.each(['rollbackSuccess','rollbackClosed'] as const)('recovers lost counted first COMMIT ACK without duplicate money%s',name=>start(async()=>{
      const c=controlledRoot('financial');c.set('lost-ack');await expect(money(name,'financial',c.root)).rejects.toBe(c.fault);expect(c.counts()).toEqual({calls:1,commits:1});
      await unchanged(specimen(name),async()=>{expect((await money(name)).replayed).toBe(true);});if(success(name))captured++;else released++;await countedLocal(name);
    }),5000);
    it('serializes actual App and Financial owners into one counted first capture/notice',()=>start(async()=>{
      const outcomes=await Promise.allSettled((['app','financial'] as const).map(role=>money('concurrent',role)));expect(outcomes.some(v=>v.status==='fulfilled')).toBe(true);
      const values=[];for(const [i,r]of outcomes.entries()){if(r.status==='fulfilled')values.push(r.value);else{expect(pgCode(r.reason)).toBe('55P03');values.push(await money('concurrent',i===0?'app':'financial'));}}
      expect(values.map(v=>v.replayed).sort()).toEqual([false,true]);expect(values[0].localResultId).toBe(values[1].localResultId);captured++;await countedLocal('concurrent');
    }),5000);
    it.each(['app','admin','financial'] as const)('replays counted first success and release from actual%s after later wallet changes',role=>start(async()=>{
      for(const name of ['appSuccess','financialClosed'] as const){const r=specimen(name);await f.maintenanceDb.execute(sql`UPDATE public."user" SET now_money=17 WHERE uid=${r.order.uid}`);
        await unchanged(r,async()=>{expect((await money(name,role)).replayed).toBe(true);});}
    }),5000);
    it.each(['appSuccess','adminClosed'] as const)('keeps counted first receipt and original cause after consistent callback%s',name=>start(async()=>{
      const r=specimen(name),receipt=await countedLocal(name);await retain(r,success(name)?'SUCCESS':'CLOSED',await matching(r));
      await unchanged(r,async()=>{expect((await recoverAppRechargeRefund(f.appContainer,f.env,r.operation.operation_id))).toMatchObject({replayed:true});});
      expect(await local(r)).toEqual(receipt);await view(r,success(name)?'succeeded':'released',2);
    }),5000);
    it.each(['workerCbSuccess','workerCbClosed'] as const)('commits actual callback atN2 with NO enqueue%s',name=>start(async()=>{
      const r=specimen(name),cb=await retain(r,success(name)?'SUCCESS':'CLOSED',{refund_id:'qr'+String(r.operation.operation_id).replaceAll('-','').slice(0,28)});callbacks.set(name,cb);
      expect((await whole(r)).state.wallet_state).toBe('held');await view(r,'awaiting_local',2);
    }),5000);
    describe('after a second actual immutable query fence',()=>{
      beforeAll(async()=>{if(busy)throw Error('Pending business before second real wait');const began=performance.now();await delay(61000);
        const elapsedMs=Math.floor(performance.now()-began);expect(elapsedMs).toBeGreaterThanOrEqual(61000);console.log('RECHARGE_COUNTED_FIRST_REAL_WAIT '+JSON.stringify({fence:2,elapsedMs}));},240000);
      it('claims and records real GET3 before the original POST is persisted',()=>start(async()=>{
        const r=specimen('n3Success');await f.approve(2,'active',['refund_query']);const token=await claimRechargeRefundServiceQuery(f.appRuntime.db,f.env,'app',r.operation.operation_id);
        const x=await f.query('app',token,'PROCESSING');await x.service.persistRechargeRefundQueryResult(x.verified);expect((await whole(r)).state.attempt_count).toBe(3);
      }),5000);
      it('persists original first SUCCESS and settles actualN3 to version4 without another POST',()=>start(async()=>{
        const r=specimen('n3Success');await recordFirst('n3Success');const v=await recoverAppRechargeRefund(f.appContainer,f.env,r.operation.operation_id);
        expect(v).toMatchObject({outcome:'captured',replayed:false});captured++;await countedLocal('n3Success',3);await view(r,'succeeded',3);
      }),5000);
      it('actual Cron traverses submitting then UNKNOWN pages to recover three lost enqueues atN2',()=>start(async()=>{
        const scheduled=await call('scheduled',{scheduledAt:Date.now()}),roots=scheduled.messages.filter(isRechargeRefundRecoveryDispatch);expect(roots).toHaveLength(1);
        const first=await call('queue',{messages:roots});expect(first.retries).toEqual([]);expect(first.messages.filter(isRechargeRefundRecoveryMessage)).toEqual([]);
        const next=first.messages.filter(isRechargeRefundRecoveryDispatch);expect(next).toHaveLength(1);expect(next[0].phase).toBe('unknown');
        const second=await call('queue',{messages:next});expect(second.retries).toEqual([]);due=second.messages.filter(isRechargeRefundRecoveryMessage);
        expect(due.map(m=>m.operationId).sort()).toEqual(['workerCbSuccess','workerCbClosed','workerFirstSuccess'].map(n=>String(specimen(n as Name).operation.operation_id)).sort());
      }),5000);
      it.each(['workerCbSuccess','workerCbClosed','workerFirstSuccess'] as const)('actual workerd Queue converges original cause atN2%s',name=>start(async()=>{
        const r=specimen(name),m=due.find(x=>x.operationId===r.operation.operation_id);expect(m).toBeDefined();const result=await call('queue',{messages:[m]});
        expect(result.acks).toEqual(['local-0']);expect(result.retries).toEqual([]);if(success(name))captured++;else released++;
        const h=await whole(r);expect(h.state).toMatchObject({version:3,attempt_count:2,wallet_state:success(name)?'captured':'released'});
        expect(h.local?.caused_by_result_id).toBe(name==='workerFirstSuccess'?firstResults.get(name):callbacks.get(name)!.resultId);
        if(name==='workerFirstSuccess')await countedLocal(name);await view(r,success(name)?'succeeded':'released',2);
      }),5000);
      it.each(['workerCbSuccess','workerCbClosed','workerFirstSuccess'] as const)('duplicate actual Worker delivery preserves all money/receipt bytes%s',name=>start(async()=>{
        const r=specimen(name),m=due.find(x=>x.operationId===r.operation.operation_id);await unchanged(r,async()=>{const result=await call('queue',{messages:[m]});expect(result.acks).toEqual(['local-0']);expect(result.retries).toEqual([]);});
      }),5000);
      it.each(['workerCbSuccess','workerCbClosed'] as const)('independently retains the real late GET after Worker callback money%s',name=>start(async()=>{
        const r=specimen(name),receipt=await local(r),x=queries.get(name)!.exchange;await x.service.persistRechargeRefundQueryResult(x.verified);
        if(name==='workerCbClosed'){await unchanged(r,async()=>{expect((await recoverAppRechargeRefund(f.appContainer,f.env,r.operation.operation_id))).toMatchObject({replayed:true});});await view(r,'released',2);}
        else{await unchanged(r,()=>recoverAppRechargeRefund(f.appContainer,f.env,r.operation.operation_id),true);expect((await whole(r)).universe.disposition).toBe('manual_review');}
        expect(await local(r)).toEqual(receipt);
      }),5000);
    });
  });
  it('historical counted first replay survives retired credentials while current Admin grants remain required',()=>start(async()=>{
    const r=specimen('appSuccess'),registry=f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS;f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS='{}';
    try{await unchanged(r,async()=>{expect((await recoverAppRechargeRefund(f.appContainer,f.env,r.operation.operation_id))).toMatchObject({replayed:true});});}finally{f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS=registry;}
    await f.rules('');try{await unchanged(r,()=>recoverAdminRechargeRefund(f.adminContainer,f.env,f.actor(),r.operation.operation_id),true);}finally{await f.rules('recharge_order.refund');}
  }),5000);
  it('retains opposite late callback truth without undoing counted first money or rewriting its receipt',()=>start(async()=>{
    const r=specimen('appSuccess'),receipt=await local(r);await retain(r,'CLOSED',{refund_id:(await matching(r)).refund_id});
    await unchanged(r,()=>recoverAppRechargeRefund(f.appContainer,f.env,r.operation.operation_id),true);await unchanged(r,()=>lookupAdminRechargeRefundExecution(f.adminContainer,f.env,f.actor(),r.key),true);
    expect(await local(r)).toEqual(receipt);
  }),5000);
  it('reports direct current native evidence without claiming production callback HTTP',()=>start(async()=>{
    expect(f.posts).toHaveLength(11);expect(f.gets).toHaveLength(12);expect(captured).toBe(7);expect(released).toBe(4);expect(gatewayCalls).toEqual([]);
    console.log('RECHARGE_COUNTED_FIRST_NATIVE_PROOF '+JSON.stringify({posts:11,gets:12,captures:captured,releases:released,actualDeferredOriginalPostN2AndN3:true,
      actualOriginalCauseAndDistinctReceipt:true,actualAppAdminFinancialMoneyAndReplay:true,actualRollbackLostCommitAckConcurrency:true,
      actualNegativeWalletOptionalGiftFullHold:true,actualWorkerAppHyperdrive:true,actualWorkerCallbackN2LostEnqueueAndDuplicate:true,
      actualWorkerCountedFirstN2LostEnqueueAndDuplicate:true,actualLateGetTruthAfterWorkerCallbackMoney:true,noProductionCallbackHttpClaim:true}));
  }),5000);
});
