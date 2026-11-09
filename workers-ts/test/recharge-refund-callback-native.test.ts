/** Real App LOGIN/RSA/AES/COMMIT evidence, with no money or HTTP route claim. */
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DbClient } from '@/lib/di';
import { readRechargeRefundCallbackPointTx } from '@/services/payment/RechargeRefundCallbackPoint';
import { parseRechargeRefundCallbackResult } from '@/services/payment/RechargeRefundCallbackCodec';
import { parseRechargeRefundCallbackProviderUniverse } from '@/services/payment/RechargeRefundCallbackHistoryCodec';
import type { RechargeRefundCallbackReceipt, VerifiedRechargeRefundCallback } from '@/services/payment/RechargeRefundCallbackService';
import { rechargeAuthorUids, rechargeAuthorOriginal } from './helpers/rechargeRefundAdminAuthorNative';
import { rechargeRefundCallbackNativeFixture, type CallbackNativePacket, type CallbackNativeSpecimen,
  type RechargeRefundCallbackNativeFixture } from './helpers/rechargeRefundCallbackNative';

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

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('actual original-account recharge callback retention', () => {
  let f: RechargeRefundCallbackNativeFixture, setup: Promise<void> | undefined, pending: Promise<unknown> | undefined, busy = false;
  let r: CallbackNativeSpecimen, packet: CallbackNativePacket, token: VerifiedRechargeRefundCallback, receipt: RechargeRefundCallbackReceipt;
  let service: ReturnType<RechargeRefundCallbackNativeFixture['service']>, verifiedCount = 0, retainedCount = 0;
  const start = <T>(run: () => Promise<T>): Promise<T> => {
    if (busy) throw Error('Previous native callback still pending'); busy = true;
    const work = run().finally(() => { busy = false; }); pending = work; void work.catch(() => undefined); return work;
  };
  beforeAll(async () => { setup = (async () => { f = await rechargeRefundCallbackNativeFixture(transport.values); })(); await setup; }, 240000);
  afterAll(async () => {
    try { if (setup) await Promise.allSettled([setup]); if (pending) await Promise.allSettled([pending]); }
    finally { try { await f?.close(); } finally { vi.restoreAllMocks(); } }
  }, 30000);
  afterEach(() => {
    if (!f) return;
    expect(f.calls).toHaveLength(rechargeAuthorUids.length);
    expect(f.calls.every(c => { const u = new URL(c.url); return c.method === 'GET' && u.origin === 'https://api.weixin.qq.com' && u.pathname === '/sns/jscode2session'; })).toBe(true);
  });
  const withoutResults = (value: string) => Object.fromEntries(Object.entries(JSON.parse(value) as Record<string, unknown>).filter(([key]) => key !== 'results'));
  const callbackRows = () => f.appRuntime.db.execute(sql`SELECT * FROM public.recharge_refund_result WHERE operation_id=${r.operation.operation_id}::uuid AND source='callback' ORDER BY created_at,result_id`);
  function controlledRoot() {
    const root = f.appRuntime.db, wrapped = Object.create(root) as object, d = Object.getOwnPropertyDescriptor(root, '$client');
    if (!d || !('value' in d)) throw Error('Actual root required');
    Object.defineProperty(wrapped, '$client', { value: d.value });
    let mode: 'none' | 'rollback-read' | 'lost-read' | 'rollback-write' | 'lost-write' = 'none', calls = 0, commits = 0;
    const fault = Error('Actual callback transaction ACK fault');
    Object.defineProperty(wrapped, 'transaction', { value: async (work: (tx: DbClient) => Promise<unknown>, options: { isolationLevel: 'repeatable read' | 'read committed'; accessMode: 'read only' | 'read write' }) => {
      expect(options).toEqual(options.accessMode === 'read only' ? { isolationLevel: 'repeatable read', accessMode: 'read only' } : { isolationLevel: 'read committed', accessMode: 'read write' });
      calls++; const suffix = options.accessMode === 'read only' ? 'read' : 'write';
      const result = await root.transaction(async raw => {
        const tx = raw as unknown as DbClient;
        const [identity] = await tx.execute<{ login: string; session: string }>(sql`SELECT current_user AS login,session_user AS session`);
        expect(identity.login).toBe(f.binding.app); expect(identity.session).toBe(f.binding.app);
        const result = await work(tx);
        if (mode === 'rollback-' + suffix) { mode = 'none'; throw fault; } return result;
      }, options);
      commits++; if (mode === 'lost-' + suffix) { mode = 'none'; throw fault; } return result;
    } });
    return { root: wrapped as DbClient, fault, set: (next: typeof mode) => { mode = next; }, counts: () => ({ calls, commits }) };
  }
  it('authors one genuine paid recharge, original hold and sole signed firstPOST before any callback', () => start(async () => {
    r = await f.persisted('UNKNOWN'); expect(r.receipt.status).toBe('UNKNOWN'); expect(f.posts).toHaveLength(1);
    expect(await callbackRows()).toHaveLength(0); expect(await f.wallet(r.order.uid)).toBe('1.50');
    service = f.service();
  }), 5000);
  it('commits a distinct notify-onlyV3 approval and verifies actual RSA/AES under App after AppID switched to B', () => start(async () => {
    const a = await f.approve(3, 'active', ['refund_notify']); expect(a.data.credentialVersion).toBe(3);
    expect(a.data.appId).toBe(rechargeAuthorOriginal.appId); expect(a.data.purposes).toEqual(['refund_notify']);
    packet = f.packet(r); const before = await f.snapshot(r.order);
    token = await service.verify(r.operation.operation_id, packet.headers, packet.body); verifiedCount++;
    expect(token).toMatchObject({ operationId: r.operation.operation_id, eventId: packet.envelope.id, status: 'SUCCESS' });
    expect(await f.snapshot(r.order)).toBe(before); expect(await callbackRows()).toHaveLength(0);
    const encoded = JSON.stringify(token); expect(encoded).not.toContain('PRIVATE KEY'); expect(encoded).not.toContain('plaintext');
  }), 5000);
  it('independently commits/replays one immutable callback with actual raw-byte digests and no money/state/attempt changes', () => start(async () => {
    const before = await f.snapshot(r.order);
    const both = await Promise.all([service.persist(token), service.persist(token)]); receipt = both[0]; retainedCount++;
    expect(both[1]).toBe(receipt); expect(receipt).toMatchObject({ status: 'SUCCESS', replayed: false });
    expect(withoutResults(await f.snapshot(r.order))).toEqual(withoutResults(before)); expect(await callbackRows()).toHaveLength(1);
    const point = await f.appRuntime.db.transaction(tx => readRechargeRefundCallbackPointTx(tx as unknown as DbClient, f.env, r.operation.operation_id), { isolationLevel: 'repeatable read', accessMode: 'read only' });
    const row = (await callbackRows())[0], approval = point.policies.find(p => p.payload.data.credentialVersion === 3)!;
    const parsed = parseRechargeRefundCallbackResult(f.env, point.scope, point.operation, point.first.attempt, point.firstApproval, approval, row);
    expect(parsed.observation).toMatchObject({ requestDigest: createHash('sha256').update(packet.body).digest('hex'),
      plaintextDigest: createHash('sha256').update(packet.plaintext).digest('hex'), verifierKey: f.keyId });
    expect(parsed.observation.plaintextDigest).not.toBe(createHash('sha256').update(JSON.stringify(JSON.parse(packet.plaintext))).digest('hex'));
    expect(parsed.record.attempt_id).toBeNull(); expect(parsed.record.source).toBe('callback'); expect(f.posts).toHaveLength(1);
  }), 5000);
  it('rejects cloned and foreign-owner verified capabilities without touching any row', () => start(async () => {
    const before = await f.snapshot(r.order);
    await expect(service.persist({ ...token })).rejects.toThrow();
    await expect(f.service().persist(token)).rejects.toThrow();
    await expect(f.service(f.adminRuntime.db).persist(token)).rejects.toThrow();
    expect(await service.persist(token)).toBe(receipt); expect(await f.snapshot(r.order)).toBe(before);
  }), 5000);
  it('requires the same APP_KEY even for a cached original receipt', () => start(async () => {
    const before = await f.snapshot(r.order), key = f.env.APP_KEY;
    try { f.env.APP_KEY = key + '-changed'; await expect(service.persist(token)).rejects.toThrow(); }
    finally { f.env.APP_KEY = key; }
    expect(await service.persist(token)).toBe(receipt); expect(await f.snapshot(r.order)).toBe(before);
  }), 5000);
  it('acknowledges freshly encrypted/signed redelivery of identical cleartext while preserving the first attestation', () => start(async () => {
    const before = await f.snapshot(r.order), p = f.reencrypt(packet); expect(p.body).not.toBe(packet.body);
    const t = await service.verify(r.operation.operation_id, p.headers, p.body); verifiedCount++;
    const replay = await service.persist(t); expect(replay).toMatchObject({ ...receipt, replayed: true });
    expect(await f.snapshot(r.order)).toBe(before);
  }), 5000);
  it('rejects conflicting facts under the same actual event ID without replacing the old observation', () => start(async () => {
    const before = await f.snapshot(r.order), p = f.packet(r, 'SUCCESS', { refund_id: 'different_actual_refund' }, { eventId: String(packet.envelope.id) });
    const t = await service.verify(r.operation.operation_id, p.headers, p.body); verifiedCount++;
    await expect(service.persist(t)).rejects.toThrow(); expect(await f.snapshot(r.order)).toBe(before);
  }), 5000);
  it.each(['CLOSED', 'ABNORMAL'] as const)('retains genuine verified%s as separate truth without moving funds', status => start(async () => {
    const before = await f.snapshot(r.order), p = f.packet(r, status), t = await service.verify(r.operation.operation_id, p.headers, p.body); verifiedCount++;
    expect((await service.persist(t)).status).toBe(status); retainedCount++;
    expect(withoutResults(await f.snapshot(r.order))).toEqual(withoutResults(before));
  }), 5000);
  it.each(['signature', 'old timestamp', 'future timestamp', 'noncanonical timestamp', 'serial', 'probe', 'missing header'] as const)('rejects actual invalid callback header%s', kind => start(async () => {
    let p = f.packet(r);
    if (kind === 'old timestamp' || kind === 'future timestamp' || kind === 'noncanonical timestamp') {
      const timestamp = kind === 'noncanonical timestamp' ? '0' + p.headers['wechatpay-timestamp']
        : String(Math.floor(Date.now() / 1000) + (kind === 'old timestamp' ? -601 : 601));
      p = f.issue(p.envelope, p.plaintext, { 'wechatpay-timestamp': timestamp });
    }
    const before = await f.snapshot(r.order), headers = { ...p.headers };
    if (kind === 'signature') headers['wechatpay-signature'] = (headers['wechatpay-signature'][0] === 'A' ? 'B' : 'A') + headers['wechatpay-signature'].slice(1);
    if (kind === 'serial') headers['wechatpay-serial'] = rechargeAuthorOriginal.serial;
    if (kind === 'probe') headers['wechatpay-signature'] = 'WECHATPAY/SIGNTEST/synthetic';
    if (kind === 'missing header') delete headers['wechatpay-nonce'];
    await expect(service.verify(r.operation.operation_id, headers, p.body)).rejects.toThrow(); expect(await f.snapshot(r.order)).toBe(before);
  }), 5000);
  it('rejects actual ciphertext/tag tampering even after the outer body is validly signed', () => start(async () => {
    const p = f.packet(r), resource = p.envelope.resource as Record<string, unknown>, bytes = Buffer.from(String(resource.ciphertext), 'base64'); bytes[bytes.length - 1] ^= 1;
    const changed = f.issue({ ...p.envelope, resource: { ...resource, ciphertext: bytes.toString('base64') } }, p.plaintext), before = await f.snapshot(r.order);
    await expect(service.verify(r.operation.operation_id, changed.headers, changed.body)).rejects.toThrow(); expect(await f.snapshot(r.order)).toBe(before);
  }), 5000);
  it.each(['wrong AES key', 'invalid UTF8', 'invalid JSON'] as const)('rejects signed callback%s without producing evidence or exposing cleartext', kind => start(async () => {
    const p = f.packet(r, 'SUCCESS', {}, kind === 'wrong AES key' ? { wrongKey: true }
      : { bytes: kind === 'invalid UTF8' ? Uint8Array.from([0xff, 0xfe, 0xfd]) : Buffer.from('synthetic-private-destination not-json') }), before = await f.snapshot(r.order);
    const error = await service.verify(r.operation.operation_id, p.headers, p.body).then(() => null, (error: unknown) => error);
    expect(error).toBeInstanceOf(Error); expect(String(error)).not.toContain('synthetic-private-destination'); expect(await f.snapshot(r.order)).toBe(before);
  }), 5000);
  it('rejects executable header descriptors before reading their values', () => start(async () => {
    const p = f.packet(r), before = await f.snapshot(r.order), h = { ...p.headers }; let calls = 0;
    Object.defineProperty(h, 'wechatpay-signature', { enumerable: true, get() { calls++; return p.headers['wechatpay-signature']; } });
    await expect(service.verify(r.operation.operation_id, h, p.body)).rejects.toThrow(); expect(calls).toBe(0); expect(await f.snapshot(r.order)).toBe(before);
  }), 5000);
  it.each(['merchant', 'transaction', 'order', 'refund number', 'amount', 'current AppID', 'event type', 'fractional success time'] as const)('rejects valid RSA/AES with substituted%s', kind => start(async () => {
    const changes: Record<string, unknown> = kind === 'merchant' ? { mchid: '1900000651' } : kind === 'transaction' ? { transaction_id: 'wrong_trade' }
      : kind === 'order' ? { out_trade_no: 'wrong_order' } : kind === 'refund number' ? { out_refund_no: 'wrong_refund' }
      : kind === 'amount' ? { amount: { total: 1000, refund: 999, payer_total: 1000, payer_refund: 999 } }
      : kind === 'current AppID' ? { appid: rechargeAuthorOriginal.currentAppId }
      : kind === 'fractional success time' ? { success_time: new Date().toISOString() } : {};
    const p = f.packet(r, 'SUCCESS', changes, kind === 'event type' ? { eventType: 'REFUND.CLOSED' } : {}), before = await f.snapshot(r.order);
    await expect(service.verify(r.operation.operation_id, p.headers, p.body)).rejects.toThrow(); expect(await f.snapshot(r.order)).toBe(before);
  }), 5000);
  it.each(['admin', 'financial', 'manager', 'owner'] as const)('rejects actual wrong%s LOGIN before any callback write', role => start(async () => {
    const root = role === 'owner' ? f.maintenanceDb : f.profilePeers[role].db, p = f.packet(r), before = await f.snapshot(r.order);
    await expect(f.service(root).verify(r.operation.operation_id, p.headers, p.body)).rejects.toThrow(); expect(await f.snapshot(r.order)).toBe(before);
  }), 5000);
  it.each(['missing', 'malformed'])('rejects%s operation identity without a callback write', kind => start(async () => {
    const p = f.packet(r), before = await f.snapshot(r.order);
    await expect(service.verify(kind === 'missing' ? randomUUID() : 'invalid', p.headers, p.body)).rejects.toThrow();
    expect(await f.snapshot(r.order)).toBe(before);
  }), 5000);
  it('refuses a genuine reserved paid recharge that has no committed first attempt', () => start(async () => {
    await f.approve(3, 'active', ['refund_request', 'refund_notify']);
    const paid = await f.paid(rechargeAuthorUids[1]), q = await f.quote(paid.order), op = (await f.admit(randomUUID(), f.body(paid.order, q, false))).operation;
    const before = await f.snapshot(paid.order), p = f.packet(r);
    await expect(service.verify(op.operation_id, p.headers, p.body)).rejects.toThrow();
    expect(await f.snapshot(paid.order)).toBe(before);
    expect(await f.appRuntime.db.execute(sql`SELECT * FROM public.recharge_refund_attempt WHERE operation_id=${op.operation_id}::uuid`)).toHaveLength(0);
    expect(f.posts).toHaveLength(1);
  }), 5000);
  it.each(['rollback-read', 'lost-read'] as const)('does not mint verification after actual preparation%s', fault => start(async () => {
    const c = controlledRoot(), p = f.packet(r), s = f.service(c.root), before = await f.snapshot(r.order); c.set(fault);
    await expect(s.verify(r.operation.operation_id, p.headers, p.body)).rejects.toBe(c.fault); expect(c.counts().calls).toBe(1);
    expect(await f.snapshot(r.order)).toBe(before);
  }), 5000);
  it.each(['rollback-write', 'lost-write'] as const)('recovers the same verified fact after actual retention%s without new POST/RSA', fault => start(async () => {
    const c = controlledRoot(), p = f.packet(r), s = f.service(c.root), t = await s.verify(r.operation.operation_id, p.headers, p.body); verifiedCount++;
    const before = await f.snapshot(r.order), count = (await callbackRows()).length; c.set(fault);
    const outcomes = await Promise.allSettled([s.persist(t), s.persist(t)]); expect(outcomes.every(x => x.status === 'rejected' && x.reason === c.fault)).toBe(true);
    expect((await callbackRows()).length).toBe(count + (fault === 'lost-write' ? 1 : 0));
    const saved = await s.persist(t); retainedCount++; expect(saved.replayed).toBe(fault === 'lost-write');
    const counts = c.counts(); expect(await s.persist(t)).toBe(saved); expect(c.counts()).toEqual(counts);
    expect(withoutResults(await f.snapshot(r.order))).toEqual(withoutResults(before)); expect(f.posts).toHaveLength(1);
  }), 5000);
  it('requires notify purpose approval rather than an otherwise valid first-request policy', () => start(async () => {
    const p = f.packet(r); await f.approve(3, 'active', ['refund_request']); const before = await f.snapshot(r.order);
    try { await expect(service.verify(r.operation.operation_id, p.headers, p.body)).rejects.toThrow(); expect(await f.snapshot(r.order)).toBe(before); }
    finally { await f.approve(3, 'active', ['refund_notify']); }
  }), 5000);
  it('retains an actually verified result after wallet/source/grant/current credential drift and approval revocation', () => start(async () => {
    const p = f.packet(r), s = f.service(), t = await s.verify(r.operation.operation_id, p.headers, p.body); verifiedCount++;
    const registry = f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS;
    await f.maintenanceDb.execute(sql`UPDATE public."user" SET now_money=-3 WHERE uid=${r.order.uid}`);
    await f.maintenanceDb.execute(sql`UPDATE public.user_recharge SET paid=0,refund_price=10 WHERE id=${r.order.id}`);
    await f.maintenanceDb.execute(sql`UPDATE public.user_bill SET status=0 WHERE event_key=${'recharge_refund_hold:' + r.operation.operation_id}`);
    await f.rules(''); await f.approve(3, 'revoked', ['refund_notify']); f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS = '{}';
    const before = await f.snapshot(r.order);
    try { const saved = await s.persist(t); retainedCount++; expect(saved.status).toBe('SUCCESS'); expect(withoutResults(await f.snapshot(r.order))).toEqual(withoutResults(before)); }
    finally { f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS = registry; await f.rules('recharge_order.refund'); }
  }), 5000);
  it('rejects a global event ID reused by another genuinely paid/held/solePOST operation', () => start(async () => {
    const other = await f.persisted('UNKNOWN'), a = await f.approve(3, 'active', ['refund_notify']); expect(a.data.purposes).toEqual(['refund_notify']);
    const p = f.packet(other, 'SUCCESS', {}, { eventId: String(packet.envelope.id) }), s = f.service(), before = await f.snapshot(r.order), otherBefore = await f.snapshot(other.order);
    const t = await s.verify(other.operation.operation_id, p.headers, p.body); verifiedCount++;
    await expect(s.persist(t)).rejects.toThrow(); expect(await f.snapshot(r.order)).toBe(before); expect(await f.snapshot(other.order)).toBe(otherBefore);
    expect(f.posts).toHaveLength(2);
  }), 5000);
  it('physically reads every retained provider row and reports real callback contradictions for manual review', () => start(async () => {
    const before = await f.snapshot(r.order);
    const h = await f.appRuntime.db.transaction(async raw => {
      const tx = raw as unknown as DbClient, p = await readRechargeRefundCallbackPointTx(tx, f.env, r.operation.operation_id);
      const attempts = await tx.execute(sql`SELECT * FROM public.recharge_refund_attempt WHERE operation_id=${r.operation.operation_id}::uuid ORDER BY ordinal`);
      const results = await tx.execute(sql`SELECT * FROM public.recharge_refund_result WHERE operation_id=${r.operation.operation_id}::uuid ORDER BY created_at,result_id`);
      return parseRechargeRefundCallbackProviderUniverse(f.env, p.scope, p.operation, Array.from(attempts), Array.from(p.policies), Array.from(results));
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
    expect(h.callbacks).toHaveLength(retainedCount); expect(h.providerResultCount).toBe(retainedCount + 1);
    expect(h.disposition).toBe('manual_review'); expect(h.requestQueryHistory.totalAttempts).toBe(1);
    expect(h.requestQueryHistory.requestAttempts).toBe(1); expect(await f.snapshot(r.order)).toBe(before);
    console.log('RECHARGE_CALLBACK_NATIVE_PROOF ' + JSON.stringify({ actualAppLogin: true, actualOriginalPaymentAndFirstPost: true,
      distinctNotifyRsaAndAesV3: true, actualRsaAes: true, exactPlaintextBytes: true, independentResultCommit: true,
      rollbackAndLostAck: true, redeliveryKeepsOriginalAttestation: true, changedEventRejected: true, providerTruthSurvivesLocalDrift: true,
      fullPhysicalMixedProviderHistory: true, conflictManualReview: true, noWalletStateOrAttemptWrite: true, firstPosts: f.posts.length,
      callbackRows: h.callbacks.length, verifiedCount, noCallbackMoneyOrHttpAcceptance: true }));
  }), 5000);
});
