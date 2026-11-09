/** Genuine first/query/callback money, Admin receipt and actual Worker Queue
 * convergence. Synthetic local channel issuer only; no business row is seeded. */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions, Response as LocalResponse, type V4FetchHandler } from 'miniflare';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrderMessage } from '@/env';
import type { DbClient } from '@/lib/di';
import { runRechargeRefundNoticeUpgrade } from '@/migrations/rechargeRefundNotice';
import { recoverAppRechargeRefund, recoverAdminRechargeRefund } from '@/services/payment/RechargeRefundRecoveryService';
import { readRechargeRefundMixedProviderHistoryTx } from '@/services/payment/RechargeRefundMixedProviderHistory';
import { claimRechargeRefundServiceQuery } from '@/services/payment/RechargeRefundQueryClaim';
import { captureRechargeRefundSuccessFirstResult } from '@/services/payment/RechargeRefundSuccessCapture';
import { releaseRechargeRefundClosedFirstResult } from '@/services/payment/RechargeRefundClosedRelease';
import { captureRechargeRefundSuccessQueryResult } from '@/services/payment/RechargeRefundQuerySuccessCapture';
import { releaseRechargeRefundClosedQueryResult } from '@/services/payment/RechargeRefundQueryClosedRelease';
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
const names = ['firstFreshSuccess', 'firstFreshClosed', 'firstLateSuccess', 'firstLateClosed', 'cbSuccess', 'cbClosed', 'queueSuccess', 'queueClosed',
  'queryFreshSuccess', 'queryFreshClosed', 'queryLateSuccess', 'queryLateClosed', 'lateGetSuccess', 'lateGetConflict'] as const;
type Name = typeof names[number];
type Subject = Pick<CallbackNativeSpecimen, 'order' | 'operation' | 'transaction' | 'key'>;
type Exchange = { messages: OrderMessage[]; acks: string[]; retries: Array<{ id: string; delaySeconds: number }> };
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('actual mixed recharge refund economic and recovery owners', () => {
  let f: RechargeRefundCallbackEconomicNativeFixture, mf: Miniflare, setup: Promise<void> | undefined, pending: Promise<unknown> | undefined, busy = false;
  let unrecorded: Awaited<ReturnType<RechargeRefundCallbackEconomicNativeFixture['requested']>>;
  const specimens = new Map<Name, CallbackNativeSpecimen>(), callbacks = new Map<Name, RechargeRefundCallbackReceipt>(), queries = new Map<Name, { exchange: NativeQueryExchange; resultId?: string }>();
  const key = randomUUID(), gatewayCalls: string[] = []; let captured = 0, released = 0, due: RechargeRefundRecoveryMessage[] = [];
  const start = <T>(run: () => Promise<T>) => {
    if (busy) throw Error('Previous mixed recovery action pending'); busy = true;
    const work = run().finally(() => { busy = false; }); pending = work; void work.catch(() => undefined); return work;
  };
  beforeAll(async () => { setup = (async () => {
    f = await rechargeRefundCallbackEconomicNativeFixture(transport.values);
    const [index] = await f.maintenanceDb.execute<{ present: boolean }>(sql`SELECT pg_catalog.to_regclass('public.cf_event_key_uq') IS NOT NULL AS present`);
    if (!index) throw Error('Missing owned flow catalog'); if (!index.present) await f.maintenanceDb.execute(sql`CREATE UNIQUE INDEX cf_event_key_uq ON public.capital_flow USING btree(event_key)`);
    await runRechargeRefundNoticeUpgrade(f.maintenanceDb);
    const bundle = await build({ entryPoints: [resolve(import.meta.dirname, 'integration/RechargeRefundRecoveryWorkerdScenario.ts')], bundle: true, write: false,
      format: 'esm', platform: 'browser', conditions: ['workerd', 'worker', 'browser'], external: ['node:*', 'cloudflare:*'], target: 'es2022', tsconfig: resolve(import.meta.dirname, '../tsconfig.json') });
    const outbound: V4FetchHandler = async request => { gatewayCalls.push(request.url); return new LocalResponse('Terminal callback recovery must not dispatch provider I/O', { status: 503 }); };
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
  async function firstMoney(r: CallbackNativeSpecimen) {
    const success = r.receipt.status === 'SUCCESS';
    const result = await (success ? captureRechargeRefundSuccessFirstResult : releaseRechargeRefundClosedFirstResult)(f.appContainer, f.env, 'app', r.operation.operation_id, r.receipt.resultId);
    expect(result.replayed).toBe(false); if (success) captured++; else released++; return local(r);
  }
  async function queryMoney(name: Name) {
    const r = specimen(name), resultId = queries.get(name)?.resultId; if (!resultId) throw Error('Missing actual GET result');
    const success = name.endsWith('Success'), result = await (success ? captureRechargeRefundSuccessQueryResult : releaseRechargeRefundClosedQueryResult)(f.appContainer, f.env, 'app', r.operation.operation_id, resultId);
    expect(result.replayed).toBe(false); if (success) captured++; else released++; return local(r);
  }
  it('uses an actual separate App LOGIN backend inside workerd without provider I/O', () => start(async () => {
    expect((await mf.dispatchFetch('http://localhost/identity')).status).toBe(403);
    const r = await mf.dispatchFetch('http://localhost/identity', { headers: { Authorization: 'Bearer ' + key } }); expect(r.status).toBe(200);
    const identity = await r.json(); expect(identity).toMatchObject({ role: f.profilePeers.app.role, database: f.binding.database, login: true });
    expect(identity).not.toMatchObject({ pid: f.identities.app.pid });
  }), 5000);
  it.each(names)('authors actual paid/held/solePOST specimen%s', name => start(async () => {
    const r = await f.persisted(name.startsWith('first') ? name.endsWith('Success') ? 'SUCCESS' : 'CLOSED' : 'UNKNOWN', name === 'cbClosed'); specimens.set(name, r);
    expect(f.posts.filter(p => p.body.out_refund_no === r.operation.out_refund_no)).toHaveLength(1);
    expect((await whole(r)).local).toBeNull();
  }), 5000);
  it.each(['firstFreshSuccess', 'firstFreshClosed'] as const)('validates consistent callback history before fresh original-first settlement%s', name => start(async () => {
    const r = specimen(name), cb = await retain(r, name.endsWith('Success') ? 'SUCCESS' : 'CLOSED', await matching(r)); callbacks.set(name, cb);
    const result = await firstMoney(r); expect(result.caused_by_result_id).toBe(r.receipt.resultId);
    expect((await whole(r)).universe.callbacks).toHaveLength(1); await view(r, name.endsWith('Success') ? 'succeeded' : 'released');
  }), 5000);
  it.each(['firstLateSuccess', 'firstLateClosed'] as const)('keeps original first receipt bytes after late consistent callback%s', name => start(async () => {
    const r = specimen(name), receipt = await firstMoney(r); await retain(r, name.endsWith('Success') ? 'SUCCESS' : 'CLOSED', await matching(r));
    await unchanged(r, async () => { expect((await recoverAppRechargeRefund(f.appContainer, f.env, r.operation.operation_id)).outcome).toBe(name.endsWith('Success') ? 'captured' : 'released'); });
    expect(await local(r)).toEqual(receipt); await view(r, name.endsWith('Success') ? 'succeeded' : 'released');
  }), 5000);
  it.each(['cbSuccess', 'cbClosed'] as const)('recovers real callback via actual App/current Admin%s with negative wallet or optional gift', name => start(async () => {
    const r = specimen(name), cb = await retain(r, name === 'cbSuccess' ? 'SUCCESS' : 'CLOSED'); callbacks.set(name, cb);
    if (name === 'cbSuccess') await f.maintenanceDb.execute(sql`UPDATE public."user" SET now_money=-3 WHERE uid=${r.order.uid}`);
    const result = await (name === 'cbSuccess' ? recoverAppRechargeRefund(f.appContainer, f.env, r.operation.operation_id)
      : recoverAdminRechargeRefund(f.adminContainer, f.env, f.actor(), r.operation.operation_id));
    expect(result).toMatchObject({ outcome: name === 'cbSuccess' ? 'captured' : 'released', providerResultId: cb.resultId, replayed: false });
    if (name === 'cbSuccess') captured++; else released++;
    expect(await f.wallet(r.order.uid)).toBe(name === 'cbSuccess' ? '-3.00' : '11.50');
    expect((await local(r)).caused_by_result_id).toBe(cb.resultId); await view(r, name === 'cbSuccess' ? 'succeeded' : 'released');
  }), 5000);
  it.each(['queueSuccess', 'queueClosed'] as const)('retains%s without enqueue, leaving a genuine held operation for the due scheduler', name => start(async () => {
    const r = specimen(name), cb = await retain(r, name === 'queueSuccess' ? 'SUCCESS' : 'CLOSED'); callbacks.set(name, cb);
    expect((await whole(r)).state.wallet_state).toBe('held'); await view(r, 'awaiting_local');
  }), 5000);
  it('actually sends and verifies the sole POST without persisting its first response yet', () => start(async () => {
    unrecorded = await f.requested('UNKNOWN'); expect((await whole(unrecorded)).universe.requestQueryHistory.results).toHaveLength(0);
  }), 5000);
  it('settles a real callback before the first verified POST response is durably recorded', () => start(async () => {
    const cb = await retain(unrecorded, 'SUCCESS'), result = await recoverAppRechargeRefund(f.appContainer, f.env, unrecorded.operation.operation_id);
    expect(result).toMatchObject({ outcome: 'captured', providerResultId: cb.resultId, replayed: false }); captured++;
    expect((await whole(unrecorded)).universe.requestQueryHistory.results).toHaveLength(0); await view(unrecorded, 'succeeded');
  }), 5000);
  it('independently retains a late real first response after callback money and replays its original callback receipt', () => start(async () => {
    const receipt = await local(unrecorded), result = await unrecorded.service.persistRechargeRefundFirstResult(unrecorded.verified);
    expect(result.status).toBe('UNKNOWN'); await unchanged(unrecorded, async () => {
      expect((await recoverAppRechargeRefund(f.appContainer, f.env, unrecorded.operation.operation_id))).toMatchObject({ outcome: 'captured', replayed: true });
    }); expect(await local(unrecorded)).toEqual(receipt); await view(unrecorded, 'succeeded');
  }), 5000);
  it('rejects new GET admission once a genuine terminal callback exists and rejects a borrowed App root', () => start(async () => {
    const r = specimen('queueSuccess'); await unchanged(r, () => claimRechargeRefundServiceQuery(f.appRuntime.db, f.env, 'app', r.operation.operation_id), true);
    await unchanged(r, () => recoverAppRechargeRefund(f.adminContainer, f.env, r.operation.operation_id), true);
  }), 5000);
  it('retains late opposite callback truth after first-owned money and refuses recovery/read without changing money', () => start(async () => {
    const r = specimen('firstLateSuccess'); await retain(r, 'CLOSED', { refund_id: (await matching(r)).refund_id });
    await unchanged(r, () => recoverAppRechargeRefund(f.appContainer, f.env, r.operation.operation_id), true);
    await unchanged(r, () => captureRechargeRefundSuccessFirstResult(f.appContainer, f.env, 'app', r.operation.operation_id, r.receipt.resultId), true);
    await unchanged(r, () => lookupAdminRechargeRefundExecution(f.adminContainer, f.env, f.actor(), r.key), true);
  }), 5000);
  describe('after the real immutable GET fence', () => {
    beforeAll(async () => { if (busy) throw Error('Business pending before wait'); const began = performance.now(); await delay(61000);
      const elapsedMs = Math.floor(performance.now() - began); expect(elapsedMs).toBeGreaterThanOrEqual(61000);
      console.log('RECHARGE_MIXED_RECOVERY_REAL_WAIT ' + JSON.stringify({ elapsedMs })); }, 240000);
    it.each(['queryFreshSuccess', 'queryFreshClosed', 'queryLateSuccess', 'queryLateClosed'] as const)('claims/sends/verifies/commits actual GET2 for%s', name => start(async () => {
      const r = specimen(name); await f.approve(2, 'active', ['refund_query']); const token = await claimRechargeRefundServiceQuery(f.appRuntime.db, f.env, 'app', r.operation.operation_id);
      const exchange = await f.query('app', token, name.endsWith('Success') ? 'SUCCESS' : 'CLOSED'), result = await exchange.service.persistRechargeRefundQueryResult(exchange.verified);
      queries.set(name, { exchange, resultId: result.resultId }); expect((await whole(r)).universe.requestQueryHistory.totalAttempts).toBe(2);
    }), 5000);
    it.each(['queryFreshSuccess', 'queryFreshClosed'] as const)('validates full consistent callback history before fresh query settlement%s', name => start(async () => {
      const r = specimen(name); await retain(r, name.endsWith('Success') ? 'SUCCESS' : 'CLOSED', await matching(r));
      const result = await queryMoney(name); expect(result.caused_by_result_id).toBe(queries.get(name)!.resultId);
      await view(r, name.endsWith('Success') ? 'succeeded' : 'released', 2);
    }), 5000);
    it.each(['queryLateSuccess', 'queryLateClosed'] as const)('keeps original query receipt bytes after consistent late callback%s', name => start(async () => {
      const r = specimen(name), receipt = await queryMoney(name); await retain(r, name.endsWith('Success') ? 'SUCCESS' : 'CLOSED', await matching(r));
      await unchanged(r, async () => { expect((await recoverAdminRechargeRefund(f.adminContainer, f.env, f.actor(), r.operation.operation_id)).outcome).toBe(name.endsWith('Success') ? 'captured' : 'released'); });
      expect(await local(r)).toEqual(receipt); await view(r, name.endsWith('Success') ? 'succeeded' : 'released', 2);
    }), 5000);
    it.each(['lateGetSuccess', 'lateGetConflict'] as const)('settles callback atN2 while its already-issued verified GET is not durably recorded%s', name => start(async () => {
      const r = specimen(name); await f.approve(2, 'active', ['refund_query']); const token = await claimRechargeRefundServiceQuery(f.appRuntime.db, f.env, 'app', r.operation.operation_id);
      const exchange = await f.query('app', token, name === 'lateGetSuccess' ? 'PROCESSING' : 'CLOSED'); queries.set(name, { exchange });
      const cb = await retain(r, 'SUCCESS', { refund_id: 'qr' + String(r.operation.operation_id).replaceAll('-', '').slice(0, 28) });
      const result = await recoverAppRechargeRefund(f.appContainer, f.env, r.operation.operation_id); captured++;
      expect(result).toMatchObject({ outcome: 'captured', providerResultId: cb.resultId, replayed: false });
      expect((await whole(r)).universe.requestQueryHistory.results).toHaveLength(1); await view(r, 'succeeded', 2);
    }), 5000);
    it.each(['lateGetSuccess', 'lateGetConflict'] as const)('retains independently committed late GET truth after callback money%s', name => start(async () => {
      const r = specimen(name), receipt = await local(r), x = queries.get(name)!.exchange; await x.service.persistRechargeRefundQueryResult(x.verified);
      if (name === 'lateGetSuccess') {
        await unchanged(r, async () => { expect((await recoverAppRechargeRefund(f.appContainer, f.env, r.operation.operation_id))).toMatchObject({ outcome: 'captured', replayed: true }); });
        expect(await local(r)).toEqual(receipt); await view(r, 'succeeded', 2);
      } else {
        await unchanged(r, () => recoverAppRechargeRefund(f.appContainer, f.env, r.operation.operation_id), true);
        await unchanged(r, () => lookupAdminRechargeRefundExecution(f.adminContainer, f.env, f.actor(), r.key), true);
        expect((await whole(r)).universe.disposition).toBe('manual_review'); expect((await local(r))).toEqual(receipt);
      }
    }), 5000);
    it('preserves a late opposite callback after query-owned money rather than adopting its later arrival', () => start(async () => {
      const r = specimen('queryLateSuccess'); await retain(r, 'CLOSED', { refund_id: (await matching(r)).refund_id });
      await unchanged(r, () => captureRechargeRefundSuccessQueryResult(f.appContainer, f.env, 'app', r.operation.operation_id, queries.get('queryLateSuccess')!.resultId), true);
      await unchanged(r, () => recoverAppRechargeRefund(f.appContainer, f.env, r.operation.operation_id), true);
    }), 5000);
    it('uses actual Worker Cron/due dispatch to recover the two terminal callbacks whose enqueue was lost', () => start(async () => {
      const scheduled = await call('scheduled', { scheduledAt: Date.now() }), roots = scheduled.messages.filter(isRechargeRefundRecoveryDispatch); expect(roots).toHaveLength(1);
      const dispatch = await call('queue', { messages: roots }); expect(dispatch.retries).toEqual([]); due = dispatch.messages.filter(isRechargeRefundRecoveryMessage);
      expect(due.map(r => r.operationId).sort()).toEqual(['queueSuccess', 'queueClosed'].map(n => String(specimen(n as Name).operation.operation_id)).sort());
      expect(gatewayCalls).toEqual([]);
    }), 5000);
    it.each(['queueSuccess', 'queueClosed'] as const)('actual workerd Queue/App Hyperdrive converges%s without a GET or POST', name => start(async () => {
      const r = specimen(name), address = due.find(m => m.operationId === r.operation.operation_id); expect(address).toBeDefined();
      const posts = f.posts.length, gets = f.gets.length, result = await call('queue', { messages: [address] }); expect(result.acks).toEqual(['local-0']); expect(result.retries).toEqual([]);
      if (name === 'queueSuccess') captured++; else released++;
      expect((await local(r)).caused_by_result_id).toBe(callbacks.get(name)!.resultId); await view(r, name === 'queueSuccess' ? 'succeeded' : 'released');
      expect(f.posts).toHaveLength(posts); expect(f.gets).toHaveLength(gets);
    }), 5000);
    it.each(['queueSuccess', 'queueClosed'] as const)('actual duplicate Queue delivery replays original callback money for%s', name => start(async () => {
      const r = specimen(name), address = due.find(m => m.operationId === r.operation.operation_id);
      await unchanged(r, async () => { const result = await call('queue', { messages: [address] }); expect(result.acks).toEqual(['local-0']); expect(result.retries).toEqual([]); });
    }), 5000);
  });
  it('replays actual callback truth after current credentials retire without dispatching provider I/O', () => start(async () => {
    const r = specimen('cbSuccess'), registry = f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS; f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS = '{}';
    try { await unchanged(r, async () => { expect(await recoverAppRechargeRefund(f.appContainer, f.env, r.operation.operation_id)).toMatchObject({ outcome: 'captured', replayed: true }); }); }
    finally { f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS = registry; }
  }), 5000);
  it('still requires current original Admin permission while App historical recovery remains available', () => start(async () => {
    const r = specimen('cbClosed'); await f.rules(''); try {
      await unchanged(r, () => recoverAdminRechargeRefund(f.adminContainer, f.env, f.actor(), r.operation.operation_id), true);
      await unchanged(r, async () => { expect(await recoverAppRechargeRefund(f.appContainer, f.env, r.operation.operation_id)).toMatchObject({ outcome: 'released', replayed: true }); });
    } finally { await f.rules('recharge_order.refund'); }
  }), 5000);
  it('reports actual complete mixed-history acceptance without claiming a production callback HTTP route', () => start(async () => {
    expect(f.posts).toHaveLength(15); expect(f.gets).toHaveLength(6); expect(captured).toBe(9); expect(released).toBe(6); expect(gatewayCalls).toEqual([]);
    console.log('RECHARGE_MIXED_RECOVERY_NATIVE_PROOF ' + JSON.stringify({ actualFirstQueryCallbackMoney: true, actualCompleteProviderHistories: true,
      actualOriginalReceiptDomainsPreserved: true, actualAppAndCurrentAdminRecovery: true, actualAdminThreeFamilyReads: true,
      actualCallbackBeforeFirstResult: true, actualLateGetAfterCallbackMoney: true, lateConflictsRetainedNoMoneyUndo: true,
      actualQueryAdmissionTerminalCallbackStop: true, actualWorkerdAppLogin: true, actualWorkerCronDueDispatch: true,
      actualLostEnqueueRecovered: true, actualWorkerQueueCallbackMoneyAndReplay: true, actualNoProviderIOfromWorker: true,
      actualNegativeWalletAndOptionalGift: true, actualCredentialRetirementAndAdminGrantRemoval: true,
      posts: f.posts.length, gets: f.gets.length, captures: captured, releases: released, noProductionCallbackHttpClaim: true }));
  }), 5000);
});
