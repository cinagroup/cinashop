/** Genuine payment/hold/POST/GET/RSA/AES/result owners and actual callback money
 * transactions. No owner-seeded payment, hold, provider result, flow or notice. */
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import type { RechargeRefundRuntimeRole } from '@/migrations/rechargeRefund';
import { runRechargeRefundNoticeUpgrade } from '@/migrations/rechargeRefundNotice';
import { captureRechargeRefundSuccessCallbackResult } from '@/services/payment/RechargeRefundCallbackSuccessCapture';
import { releaseRechargeRefundClosedCallbackResult } from '@/services/payment/RechargeRefundCallbackClosedRelease';
import { readRechargeRefundCallbackEconomicHistoryTx } from '@/services/payment/RechargeRefundCallbackEconomicHistory';
import { readRechargeRefundQueryHistoryTx } from '@/services/payment/RechargeRefundQueryHistory';
import { claimRechargeRefundServiceQuery } from '@/services/payment/RechargeRefundQueryClaim';
import { captureRechargeRefundSuccessFirstResult } from '@/services/payment/RechargeRefundSuccessCapture';
import { readRechargeRefundFirstProviderResultTx } from '@/services/payment/RechargeRefundFirstProviderResult';
import type { RechargeRefundCallbackReceipt } from '@/services/payment/RechargeRefundCallbackService';
import { rechargeAuthorUids } from './helpers/rechargeRefundAdminAuthorNative';
import { rechargeRefundCallbackEconomicNativeFixture, type RechargeRefundCallbackEconomicNativeFixture,
  type CallbackNativeSpecimen, type CallbackNativePacket } from './helpers/rechargeRefundCallbackEconomicNative';

const transport = vi.hoisted(() => {
  const values = new Map<string, unknown>();
  const get = vi.fn(async (key: string) => values.get(key) ?? null), set = vi.fn(async (key: string, value: unknown) => { values.set(key, value); return true; });
  const remove = vi.fn(async (key: string) => values.delete(key)), take = vi.fn(async (key: string) => { const value = values.get(key) ?? null; values.delete(key); return value; });
  const setIfAbsent = vi.fn(async (key: string, value: unknown) => { if (values.has(key)) return false; values.set(key, value); return true; });
  const redis = { eval: vi.fn(async () => 1), get, set: vi.fn(async (key: string, value: unknown) => { await set(key, value); return 'OK'; }), del: vi.fn(async (key: string) => Number(await remove(key))) };
  return { values, get, set, remove, take, setIfAbsent, redis };
});
vi.mock('@/utils/cache', async original => ({ ...await original<typeof import('@/utils/cache')>(), getRedis: () => transport.redis,
  cacheGet: transport.get, cacheSet: transport.set, cacheTake: transport.take, cacheDelete: transport.remove, cacheSetIfAbsent: transport.setIfAbsent,
  setTokenBucket: vi.fn(async () => true), clearToken: vi.fn(async () => true) }));

const names = ['appSuccess', 'adminSuccess', 'financialSuccess', 'giftSuccess', 'appClosed', 'adminClosed', 'financialClosed', 'giftClosed',
  'rollbackSuccess', 'rollbackClosed', 'concurrent', 'lateConflict', 'abnormal', 'foreignFirst', 'retired', 'n2Success', 'n2Closed'] as const;
type Name = typeof names[number];
type Role = RechargeRefundRuntimeRole;
const pgCode = (error: unknown): string | null => {
  const seen = new Set<object>();
  for (let n = 0; n < 7 && error && typeof error === 'object' && !seen.has(error); n++) {
    seen.add(error); const code = Object.getOwnPropertyDescriptor(error, 'code');
    if (code && 'value' in code && code.value !== undefined) return typeof code.value === 'string' ? code.value : null;
    const cause = Object.getOwnPropertyDescriptor(error, 'cause'); if (!cause || !('value' in cause)) return null; error = cause.value;
  }
  return null;
};
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('actual complete callback economic owners', () => {
  let f: RechargeRefundCallbackEconomicNativeFixture, setup: Promise<void> | undefined, pending: Promise<unknown> | undefined, busy = false;
  const specimens = new Map<Name, CallbackNativeSpecimen>(), receipts = new Map<Name, RechargeRefundCallbackReceipt>(), packets = new Map<Name, CallbackNativePacket>();
  let captured = 0, released = 0;
  const start = <T>(run: () => Promise<T>): Promise<T> => {
    if (busy) throw Error('Previous callback economic case still pending'); busy = true;
    const work = run().finally(() => { busy = false; }); pending = work; void work.catch(() => undefined); return work;
  };
  beforeAll(async () => { setup = (async () => {
    f = await rechargeRefundCallbackEconomicNativeFixture(transport.values);
    const [index] = await f.maintenanceDb.execute<{ present: boolean }>(sql`SELECT pg_catalog.to_regclass('public.cf_event_key_uq') IS NOT NULL AS present`);
    if (!index) throw Error('Owned flow catalog missing');
    if (!index.present) await f.maintenanceDb.execute(sql`CREATE UNIQUE INDEX cf_event_key_uq ON public.capital_flow USING btree(event_key)`);
    await runRechargeRefundNoticeUpgrade(f.maintenanceDb);
  })(); await setup; }, 240000);
  afterAll(async () => {
    try { if (setup) await Promise.allSettled([setup]); if (pending) await Promise.allSettled([pending]); }
    finally { try { await f?.close(); } finally { vi.restoreAllMocks(); } }
  }, 30000);
  afterEach(() => {
    if (!f) return; expect(f.calls).toHaveLength(rechargeAuthorUids.length);
    expect(f.calls.every(c => { const u = new URL(c.url); return c.method === 'GET' && u.origin === 'https://api.weixin.qq.com' && u.pathname === '/sns/jscode2session'; })).toBe(true);
  });
  function specimen(name: Name) { const r = specimens.get(name); if (!r) throw Error('Missing actual specimen ' + name); return r; }
  function receipt(name: Name) { const r = receipts.get(name); if (!r) throw Error('Missing actual callback receipt ' + name); return r; }
  const root = (role: Role) => f.profilePeers[role].db;
  const capture = (name: Name, role: Role = 'app', db: DbClient = root(role)) =>
    captureRechargeRefundSuccessCallbackResult(createContainerFromDb(db), f.env, role, specimen(name).operation.operation_id, receipt(name).resultId);
  const release = (name: Name, role: Role = 'app', db: DbClient = root(role)) =>
    releaseRechargeRefundClosedCallbackResult(createContainerFromDb(db), f.env, role, specimen(name).operation.operation_id, receipt(name).resultId);
  async function money(name: Name) {
    const r = specimen(name), id = String(r.operation.operation_id);
    const [extra] = await f.maintenanceDb.execute<{ value: unknown }>(sql`SELECT jsonb_build_object(
      'flows',(SELECT COALESCE(jsonb_agg(to_jsonb(t)||jsonb_build_object('_xmin',xmin::text) ORDER BY id),'[]'::jsonb) FROM public.capital_flow t WHERE event_key=${'recharge.refund:' + id} OR flow_id=${id.replaceAll('-', '')}),
      'notice',(SELECT COALESCE(jsonb_agg(to_jsonb(t)||jsonb_build_object('_xmin',xmin::text) ORDER BY id),'[]'::jsonb) FROM public.store_order_outbox t WHERE event_key=${'recharge.refund.success.notice:' + id})
    ) AS value`);
    return JSON.stringify({ base: JSON.parse(await f.snapshot(r.order)), extra: extra.value });
  }
  async function noWrite(name: Name, run: () => Promise<unknown>) { const before = await money(name), posts = f.posts.length, gets = f.gets.length;
    await expect(run()).rejects.toThrow(); expect(await money(name)).toBe(before); expect(f.posts).toHaveLength(posts); expect(f.gets).toHaveLength(gets); }
  async function artifacts(name: Name) {
    const id = specimen(name).operation.operation_id;
    const [a] = await f.appRuntime.db.execute<{ local: number; flow: number; notice: number; release: number; status: string; version: number; attempts: number }>(sql`SELECT
      (SELECT count(*)::integer FROM public.recharge_refund_result WHERE operation_id=${id}::uuid AND source IN('local_settlement','local_release')) AS local,
      (SELECT count(*)::integer FROM public.capital_flow WHERE event_key=${'recharge.refund:' + id}) AS flow,
      (SELECT count(*)::integer FROM public.store_order_outbox WHERE event_key=${'recharge.refund.success.notice:' + id}) AS notice,
      (SELECT count(*)::integer FROM public.user_bill WHERE event_key=${'recharge_refund_release:' + id}) AS release,
      status,version,attempt_count AS attempts FROM public.recharge_refund_state WHERE operation_id=${id}::uuid`); return a;
  }
  async function retain(name: Name, status: 'SUCCESS' | 'CLOSED' | 'ABNORMAL', patch: Record<string, unknown> = {}) {
    await f.approve(3, 'active', ['refund_notify']); const r = specimen(name), p = f.packet(r, status, patch), service = f.callbackService();
    const v = await service.verify(r.operation.operation_id, p.headers, p.body), saved = await service.persist(v); receipts.set(name, saved); packets.set(name, p); return saved;
  }
  function controlledRoot(role: Role) {
    const db = root(role), wrapped = Object.create(db) as object, d = Object.getOwnPropertyDescriptor(db, '$client');
    if (!d || !('value' in d)) throw Error('Actual money root missing'); Object.defineProperty(wrapped, '$client', { value: d.value });
    let mode: 'none' | 'rollback' | 'lost-ack' = 'none', calls = 0, commits = 0; const fault = Error('Actual callback money transaction ACK fault');
    Object.defineProperty(wrapped, 'transaction', { value: async (work: (tx: DbClient) => Promise<unknown>, options: Parameters<DbClient['transaction']>[1]) => {
      expect(options).toEqual({ isolationLevel: 'read committed', accessMode: 'read write' }); calls++;
      const value = await db.transaction(async raw => { const result = await work(raw as unknown as DbClient); if (mode === 'rollback') { mode = 'none'; throw fault; } return result; }, options);
      commits++; if (mode === 'lost-ack') { mode = 'none'; throw fault; } return value;
    } });
    return { root: wrapped as DbClient, fault, set: (next: typeof mode) => { mode = next; }, counts: () => ({ calls, commits }) };
  }

  it.each(names)('authors genuine paid/held/solePOST specimen%s', name => start(async () => {
    const r = await f.persisted(name === 'foreignFirst' ? 'SUCCESS' : 'UNKNOWN', name === 'giftSuccess' || name === 'giftClosed'); specimens.set(name, r);
    expect(f.posts.filter(p => p.body.out_refund_no === r.operation.out_refund_no)).toHaveLength(1);
    expect(await artifacts(name)).toMatchObject({ local: 0, flow: 0, notice: 0, release: 0, status: 'SUBMITTING', version: 1, attempts: 1 });
  }), 5000);
  const immediate = names.filter(n => !['foreignFirst', 'n2Success', 'n2Closed'].includes(n));
  it.each(immediate)('independently commits real RSA/AES callback for%s before its money request', name => start(async () => {
    const before = await money(name), r = await retain(name, name === 'abnormal' ? 'ABNORMAL' : name.includes('Closed') ? 'CLOSED' : 'SUCCESS');
    expect(r.status).toBe(name === 'abnormal' ? 'ABNORMAL' : name.includes('Closed') ? 'CLOSED' : 'SUCCESS');
    const after = JSON.parse(await money(name)), old = JSON.parse(before); delete after.base.results; delete old.base.results; expect(after).toEqual(old);
  }), 5000);
  it('refuses ABNORMAL and a caller-selected first response without changing money', () => start(async () => {
    await noWrite('abnormal', () => capture('abnormal')); await noWrite('abnormal', () => release('abnormal'));
    const r = specimen('appSuccess');
    await noWrite('appSuccess', () => captureRechargeRefundSuccessCallbackResult(f.appContainer, f.env, 'app', r.operation.operation_id, r.receipt.resultId));
  }), 5000);
  it('rejects actual wrong LOGIN and transaction mode for the complete physical callback cause', () => start(async () => {
    const r = specimen('appSuccess'), id = r.operation.operation_id, result = receipt('appSuccess').resultId;
    await noWrite('appSuccess', () => capture('appSuccess', 'app', f.adminRuntime.db));
    await noWrite('appSuccess', () => capture('appSuccess', 'app', f.maintenanceDb));
    await expect(f.appRuntime.db.transaction(tx => readRechargeRefundCallbackEconomicHistoryTx(tx as unknown as DbClient, f.env, 'app', id, result),
      { isolationLevel: 'repeatable read', accessMode: 'read only' })).rejects.toThrow();
    await expect(f.appRuntime.db.transaction(tx => readRechargeRefundCallbackEconomicHistoryTx(tx as unknown as DbClient, f.env, 'app', id, result, undefined, 'read'),
      { isolationLevel: 'read committed', accessMode: 'read write' })).rejects.toThrow();
  }), 5000);
  it('refuses a damaged actual original hold before fresh capture', () => start(async () => {
    const r = specimen('rollbackSuccess'), key = 'recharge_refund_hold:' + r.operation.operation_id;
    await f.maintenanceDb.execute(sql`UPDATE public.user_bill SET status=0 WHERE event_key=${key}`);
    try { await noWrite('rollbackSuccess', () => capture('rollbackSuccess')); }
    finally { await f.maintenanceDb.execute(sql`UPDATE public.user_bill SET status=1 WHERE event_key=${key}`); }
  }), 5000);
  it('captures a callback SUCCESS atN1 while the current wallet is negative without another debit', () => start(async () => {
    const r = specimen('appSuccess'); await f.maintenanceDb.execute(sql`UPDATE public."user" SET now_money=-3 WHERE uid=${r.order.uid}`);
    const before = await f.wallet(r.order.uid), result = await capture('appSuccess'); captured++;
    expect(result).toMatchObject({ captured: true, replayed: false }); expect(await f.wallet(r.order.uid)).toBe(before);
    expect(await artifacts('appSuccess')).toEqual({ local: 1, flow: 1, notice: 1, release: 0, status: 'SUCCEEDED', version: 2, attempts: 1 });
    const [notice] = await f.appRuntime.db.execute(sql`SELECT * FROM public.store_order_outbox WHERE event_key=${'recharge.refund.success.notice:' + r.operation.operation_id}`);
    expect(notice).toMatchObject({ status: 'PENDING', dispatch_count: 0, attempt_count: 0, payload: { purpose: 'recharge-refund-callback-success-notice-intent-v1',
      business: { principalCents: 1000, postBalanceCents: 150 }, callback: { eventId: receipt('appSuccess').eventId } } });
  }), 5000);
  it.each(['admin', 'financial'] as const)('fresh callback capture under actual%s role', role => start(async () => {
    const name = (role + 'Success') as Name, r = specimen(name), before = await f.wallet(r.order.uid);
    expect((await capture(name, role)).replayed).toBe(false); captured++; expect(await f.wallet(r.order.uid)).toBe(before);
    expect(await artifacts(name)).toMatchObject({ local: 1, flow: 1, notice: 1, release: 0, version: 2, attempts: 1 });
  }), 5000);
  it('captures the principal while keeping the selected gift recovery confined to the original hold', () => start(async () => {
    const r = specimen('giftSuccess'); expect(await f.wallet(r.order.uid)).toBe('0.00'); expect((await capture('giftSuccess')).replayed).toBe(false); captured++;
    expect(await f.wallet(r.order.uid)).toBe('0.00'); const [flow] = await f.appRuntime.db.execute(sql`SELECT price::text AS price FROM public.capital_flow WHERE event_key=${'recharge.refund:' + r.operation.operation_id}`);
    expect(flow.price).toBe('-10.00');
  }), 5000);
  it.each(['app', 'admin', 'financial'] as const)('releases original principal hold under actual%s role', role => start(async () => {
    const name = (role + 'Closed') as Name, r = specimen(name); expect(await f.wallet(r.order.uid)).toBe('1.50');
    expect((await release(name, role)).replayed).toBe(false); released++; expect(await f.wallet(r.order.uid)).toBe('11.50');
    expect(await artifacts(name)).toEqual({ local: 1, flow: 0, notice: 0, release: 1, status: 'FAILED', version: 2, attempts: 1 });
  }), 5000);
  it('returns the whole gifted hold to a later negative wallet without clamping', () => start(async () => {
    const r = specimen('giftClosed'); await f.maintenanceDb.execute(sql`UPDATE public."user" SET now_money=-12 WHERE uid=${r.order.uid}`);
    expect((await release('giftClosed')).replayed).toBe(false); released++; expect(await f.wallet(r.order.uid)).toBe('-0.50');
  }), 5000);
  it.each(['rollbackSuccess', 'rollbackClosed'] as const)('rolls back all actual callback money effects for%s while preserving provider truth', name => start(async () => {
    const c = controlledRoot('app'), before = await money(name); c.set('rollback');
    await expect(name === 'rollbackSuccess' ? capture(name, 'app', c.root) : release(name, 'app', c.root)).rejects.toBe(c.fault);
    expect(c.counts()).toEqual({ calls: 1, commits: 0 }); expect(await money(name)).toBe(before);
  }), 5000);
  it.each(['rollbackSuccess', 'rollbackClosed'] as const)('recovers a real lost COMMIT acknowledgement for%s without duplicate money', name => start(async () => {
    const c = controlledRoot('financial'); c.set('lost-ack');
    await expect(name === 'rollbackSuccess' ? capture(name, 'financial', c.root) : release(name, 'financial', c.root)).rejects.toBe(c.fault);
    expect(c.counts()).toEqual({ calls: 1, commits: 1 }); const before = await money(name);
    expect((await (name === 'rollbackSuccess' ? capture(name) : release(name))).replayed).toBe(true);
    expect(await money(name)).toBe(before); if (name === 'rollbackSuccess') captured++; else released++;
  }), 5000);
  it('serializes two actual App/Financial capture transactions into one money/notice/local result', () => start(async () => {
    const roles = ['app', 'financial'] as const, r = specimen('concurrent'), balance = await f.wallet(r.order.uid), posts = f.posts.length, gets = f.gets.length;
    // The existing one-second lock budget permits a55P03 busy refusal. Await
    // BOTH real transactions before observing or explicitly replaying a loser;
    // Promise.all would leave the winning transaction pending after rejection.
    const outcomes = await Promise.allSettled(roles.map(role => capture('concurrent', role)));
    expect(outcomes.some(v => v.status === 'fulfilled')).toBe(true);
    const values = [];
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.status === 'fulfilled') values.push(outcome.value);
      else {
        expect(pgCode(outcome.reason)).toBe('55P03');
        values.push(await capture('concurrent', roles[index]));
      }
    }
    expect(values.map(v => v.replayed).sort()).toEqual([false, true]); expect(values[0].localResultId).toBe(values[1].localResultId); captured++;
    expect(values[0].flowId).toBe(values[1].flowId); expect(values[0].noticeId).toBe(values[1].noticeId);
    expect(await f.wallet(r.order.uid)).toBe(balance); expect(f.posts).toHaveLength(posts); expect(f.gets).toHaveLength(gets);
    expect(await artifacts('concurrent')).toMatchObject({ local: 1, flow: 1, notice: 1, version: 2, attempts: 1 });
  }), 5000);
  it('replays actual immutable callback success/release across all three roles after later wallet changes', () => start(async () => {
    for (const name of ['appSuccess', 'appClosed'] as const) {
      const r = specimen(name); await f.maintenanceDb.execute(sql`UPDATE public."user" SET now_money=17 WHERE uid=${r.order.uid}`); const before = await money(name);
      for (const role of ['app', 'admin', 'financial'] as const) expect((await (name === 'appSuccess' ? capture(name, role) : release(name, role))).replayed).toBe(true);
      expect(await money(name)).toBe(before);
    }
  }), 5000);
  it('validates existing financial artifacts on replay while allowing the established flow mark edit', () => start(async () => {
    const r = specimen('appSuccess'), key = 'recharge.refund:' + r.operation.operation_id;
    await f.maintenanceDb.execute(sql`UPDATE public.capital_flow SET price=-9.99 WHERE event_key=${key}`);
    try { await noWrite('appSuccess', () => capture('appSuccess')); } finally { await f.maintenanceDb.execute(sql`UPDATE public.capital_flow SET price=-10,mark='legitimate later mark' WHERE event_key=${key}`); }
    const before = await money('appSuccess'); expect((await capture('appSuccess')).replayed).toBe(true); expect(await money('appSuccess')).toBe(before);
  }), 5000);
  it('keeps consistent later callback evidence in complete replay without another financial effect', () => start(async () => {
    const r = specimen('appSuccess'), initial = packets.get('appSuccess')!;
    const p = f.packet(r, 'SUCCESS', { success_time: JSON.parse(initial.plaintext).success_time }), s = f.callbackService();
    await s.persist(await s.verify(r.operation.operation_id, p.headers, p.body)); const before = await money('appSuccess');
    expect((await capture('appSuccess')).replayed).toBe(true); expect(await money('appSuccess')).toBe(before);
  }), 5000);
  it('retains a real late opposite terminal and then refuses replay without reversing or repeating settled money', () => start(async () => {
    await capture('lateConflict'); captured++; const r = specimen('lateConflict'), p = f.packet(r, 'CLOSED'), s = f.callbackService();
    const late = await s.persist(await s.verify(r.operation.operation_id, p.headers, p.body)); await noWrite('lateConflict', () => capture('lateConflict'));
    await noWrite('lateConflict', () => releaseRechargeRefundClosedCallbackResult(f.appContainer, f.env, 'app', r.operation.operation_id, late.resultId));
    expect(await artifacts('lateConflict')).toMatchObject({ local: 1, flow: 1, notice: 1, release: 0, status: 'SUCCEEDED' });
  }), 5000);
  it('refuses to relabel an actual first-owned settlement as a callback settlement', () => start(async () => {
    const r = specimen('foreignFirst'); await captureRechargeRefundSuccessFirstResult(f.appContainer, f.env, 'app', r.operation.operation_id, r.receipt.resultId);
    const first = await f.appRuntime.db.transaction(tx => readRechargeRefundFirstProviderResultTx(tx as unknown as DbClient, f.env, 'app', r.operation.operation_id, r.receipt.resultId),
      { isolationLevel: 'repeatable read', accessMode: 'read only' });
    await retain('foreignFirst', 'SUCCESS', { refund_id: first.observation.providerRefundId,
      success_time: new Date(first.observation.successTime * 1000).toISOString().replace('.000Z', 'Z') });
    await noWrite('foreignFirst', () => capture('foreignFirst')); expect(await artifacts('foreignFirst')).toMatchObject({ local: 1, flow: 1, notice: 1 });
  }), 5000);

  describe('actual GET2 followed by independently committed callback', () => {
    beforeAll(async () => {
      if (busy) throw Error('Money action pending before wait'); const began = performance.now(); await delay(61000);
      const elapsed = performance.now() - began; expect(elapsed).toBeGreaterThanOrEqual(61000);
      console.log('RECHARGE_CALLBACK_MONEY_REAL_WAIT ' + JSON.stringify({ elapsedMs: Math.floor(elapsed) }));
    }, 240000);
    it.each(['n2Success', 'n2Closed'] as const)('authors a genuine no-body GET2 and callback terminal for%s', name => start(async () => {
      const r = specimen(name); await f.approve(2, 'active', ['refund_query']);
      const token = await claimRechargeRefundServiceQuery(f.appRuntime.db, f.env, 'app', r.operation.operation_id), exchange = await f.query('app', token, 'PROCESSING');
      await exchange.service.persistRechargeRefundQueryResult(exchange.verified);
      const h = await f.appRuntime.db.transaction(tx => readRechargeRefundQueryHistoryTx(tx as unknown as DbClient, f.env, 'app', r.operation.operation_id),
        { isolationLevel: 'repeatable read', accessMode: 'read only' });
      const id = h.results.find(p => p.record.source === 'query')!.observation.providerRefundId;
      await retain(name, name === 'n2Success' ? 'SUCCESS' : 'CLOSED', { refund_id: id });
      expect(h.totalAttempts).toBe(2); expect(f.gets.filter(g => g.operationId === r.operation.operation_id)).toHaveLength(1);
    }), 5000);
    it.each(['n2Success', 'n2Closed'] as const)('converges real%s asN2->N3 without forging a GET or modifying its original hold twice', name => start(async () => {
      const posts = f.posts.length, gets = f.gets.length;
      expect((await (name === 'n2Success' ? capture(name) : release(name))).replayed).toBe(false);
      if (name === 'n2Success') captured++; else released++;
      const before = await money(name); expect((await (name === 'n2Success' ? capture(name, 'admin') : release(name, 'financial'))).replayed).toBe(true);
      expect(await money(name)).toBe(before); expect(await artifacts(name)).toMatchObject({ local: 1, version: 3, attempts: 2 });
      expect(f.posts).toHaveLength(posts); expect(f.gets).toHaveLength(gets);
    }), 5000);
  });
  it('settles and replays retained callback truth after notify revocation, credential retirement and actor grant removal', () => start(async () => {
    const r = specimen('retired'), registry = f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS;
    await f.approve(3, 'revoked', ['refund_notify']); await f.rules(''); f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS = '{}';
    try {
      const before = await f.wallet(r.order.uid); expect((await capture('retired')).replayed).toBe(false); captured++;
      expect(await f.wallet(r.order.uid)).toBe(before); const after = await money('retired');
      expect((await capture('retired', 'financial')).replayed).toBe(true); expect(await money('retired')).toBe(after);
    } finally { f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS = registry; await f.rules('recharge_order.refund'); }
  }), 5000);
  it('retains all actual producer/callback artifacts and reports only dedicated callback economic acceptance', () => start(async () => {
    expect(f.posts).toHaveLength(names.length); expect(f.gets).toHaveLength(2); expect(captured).toBe(9); expect(released).toBe(6);
    console.log('RECHARGE_CALLBACK_ECONOMIC_NATIVE_PROOF ' + JSON.stringify({ actualOriginalPaidHoldsAndSolePosts: true, actualRsaAesCallbacks: true,
      separateCallbackMoneyCause: true, actualAllThreeRoles: true, actualN1AndN2Closure: true, actualNegativeWalletCaptureNoDebit: true,
      fullPrincipalAndGiftChoices: true, fullHoldNegativeReleaseNoClamp: true, actualRollbackBoth: true, actualLostAckBoth: true,
      actualConcurrentCapture: true, actualFinancialArtifactsReplay: true, currentCredentialAndActorIndependent: true,
      completeLateProviderHistory: true, lateConflictManualNoUndo: true, firstQueryAndCallbackNotRelabelled: true,
      passiveNoticeOnly: true, posts: f.posts.length, gets: f.gets.length, callbackCaptures: captured, callbackReleases: released,
      noProductionHttpOrQueueIntegrationClaim: true }));
  }), 5000);
});
