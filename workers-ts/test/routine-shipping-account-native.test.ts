/** Real owned PG16 maintenance, independent LOGINs, production approval/parser
 * and token service. Only Redis and provider HTTP transport are controlled.
 * This file proves no shipping upload, payment provenance or domain producer. */
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@/env';
import { createContainerFromDb, withTx } from '@/lib/di';
import { systemConfig } from '@/models/schema';
import { runRoutineOriginalPaymentEvidenceUpgrade } from '@/migrations/runRoutineOriginalPaymentEvidenceUpgrade';
import { runRoutinePaymentAccountPolicyUpgrade } from '@/migrations/runRoutinePaymentAccountPolicyUpgrade';
import { runRoutineRefundUpgrade } from '@/migrations/runRoutineRefundUpgrade';
import { upgradeCustomerFinancialRoutineRefund } from '@/migrations/upgradeCustomerFinancialRoutineRefund';
import { runRoutineShippingUpgrade } from '@/migrations/runRoutineShippingUpgrade';
import { assertRoutineShippingReadyTx, assertRoutineShippingReadTx } from '@/migrations/routineShipping';
import { appendRoutineShippingAccountPolicy, assertPreparedRoutineShippingAccount, assertRoutineShippingHistoricalAccountTx,
  parseRoutineShippingAccountJournal, prepareRoutineShippingAccountTx, routineShippingAccountId, routineShippingClockTx,
  routineShippingCredentialCommitment, routineShippingScopeTx, shippingMac,
  type RoutineShippingAccountPolicy, type RoutineShippingEnv } from '@/services/payment/RoutineShippingAccount';
import { routineEvidenceHmac } from '@/services/payment/RoutineProviderObservation';
import { getRoutineShippingAccessToken, invalidateRoutineShippingAccessToken } from '@/services/wechat/RoutineShippingAccessToken';
import { customerCashierRuntimeHttpFixture } from './helpers/customerCashierRuntimeHttpFixture';

const transport = vi.hoisted(() => {
  const state = { available: false, values: new Map<string,unknown>(), expirations: new Map<string,number>(),
    getHook: undefined as undefined | (() => Promise<void>) };
  const redis = {
    get: vi.fn(async (key: string) => {
      const until = state.expirations.get(key);
      if (until !== undefined && until <= Date.now()) { state.values.delete(key); state.expirations.delete(key); }
      const value = state.values.get(key) ?? null; await state.getHook?.(); return value;
    }),
    set: vi.fn(async (key: string, value: unknown, options: { pxat: number }) => {
      if (options.pxat > Date.now()) { state.values.set(key, value); state.expirations.set(key, options.pxat); }
      else { state.values.delete(key); state.expirations.delete(key); }
      return 'OK';
    }),
    del: vi.fn(async (key: string) => { state.expirations.delete(key); return Number(state.values.delete(key)); }),
  };
  return { state, redis, resolve: vi.fn(() => state.available ? redis : null) };
});
vi.mock('@/utils/cache', async importOriginal => ({ ...await importOriginal<typeof import('@/utils/cache')>(), getRedis: transport.resolve }));

type Fixture = Awaited<ReturnType<typeof customerCashierRuntimeHttpFixture>>;
const APP = 'wx_shipping_archived_a', SECRET = 'synthetic-shipping-secret-A-not-live';
const MATERIAL = { ref: 'archived_shipping_a', version: 1, appId: APP, secret: SECRET };
const REGISTRY = JSON.stringify({ format: 1, credentials: [MATERIAL] });
const KEY = 'owned-phase32-shipping-approval-authenticator';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Routine shipping actual maintenance approval and App token native', () => {
  let f: Fixture, counter = 100;
  let forbiddenNetwork: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;
  const target = () => ({ database: f.target.database, maintenance: f.target.maintenance, app: f.target.app, admin: f.target.admin });
  const environment = (): Env => ({ ...f.env, APP_KEY: KEY, ROUTINE_SHIPPING_ACCOUNT_CREDENTIALS: REGISTRY });
  function account(env: RoutineShippingEnv, patch: Partial<RoutineShippingAccountPolicy> = {}): RoutineShippingAccountPolicy {
    const merchantId = String(1234500000 + counter++), now = Math.floor(Date.now() / 1000);
    return { accountId: routineShippingAccountId(env, APP, merchantId), state: 'active', appId: APP, merchantId,
      credentialRef: MATERIAL.ref, credentialVersion: 1, credentialStamp: routineShippingCredentialCommitment(env, MATERIAL.ref, 1).credentialStamp,
      purposes: ['shipping_upload'], validFrom: now - 60, validUntil: now + 3600, ...patch };
  }
  const append = (env: RoutineShippingEnv, data: RoutineShippingAccountPolicy, revision = 0, operationId = randomUUID(), db = f.maintenanceDb) =>
    appendRoutineShippingAccountPolicy(db, env, target(), { operationId, expectedRevision: revision, data });
  const prepare = (env: RoutineShippingEnv, data: RoutineShippingAccountPolicy, db = f.appRuntime.db) =>
    withTx(createContainerFromDb(db), async tx => {
      expect(await assertRoutineShippingReadyTx(tx)).toBe(true);
      return prepareRoutineShippingAccountTx(tx, env, data.appId, data.merchantId);
    });
  const rows = () => f.maintenanceDb.execute(sql`SELECT pg_catalog.to_jsonb(t) AS row,xmin::text AS xmin
    FROM public.routine_shipping_account_policy t ORDER BY account_id,revision`);
  function noSecrets(value: unknown) {
    const text = JSON.stringify(value);
    for (const secret of [SECRET, KEY, REGISTRY, 'synthetic-provider-token-A', 'synthetic-error-contains-secret']) expect(text).not.toContain(secret);
    expect(text).not.toContain('connectionString'); expect(text).not.toContain('postgres://');
  }
  async function unavailable(promise: Promise<unknown>) {
    const error: unknown = await promise.then(() => { throw Error('Expected shipping refusal'); }, cause => cause);
    expect(error).toMatchObject({ code: 503 });
    const publicError = error as { name?: unknown; message?: unknown; code?: unknown };
    noSecrets({ name: publicError.name, message: publicError.message, code: publicError.code });
  }
  const appContainer = () => createContainerFromDb(f.appRuntime.db);
  const response = (expires = 7200) => Response.json({ access_token: 'synthetic-provider-token-A', expires_in: expires });

  beforeAll(async () => {
    forbiddenNetwork = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Explicit token transport required in owned native acceptance'));
    f = await customerCashierRuntimeHttpFixture();
    await runRoutineOriginalPaymentEvidenceUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders);
    await runRoutinePaymentAccountPolicyUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders);
    await runRoutineRefundUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders);
    const financial = await upgradeCustomerFinancialRoutineRefund(f.maintenanceDb, f.target,
      { routineRefund: { routineRefund: true }, manualRefund: f.manual, originalPaymentReaders: f.readers }, f.peers, f.appReaders);
    await runRoutineShippingUpgrade(f.maintenanceDb, f.target, financial.peers, f.appReaders);
    expect(new Set(await Promise.all([f.appRuntime,f.adminRuntime,f.financialRuntime,f.managerRuntime,f.cashierRuntime].map(peer => peer.verify()))).size).toBe(5);
  }, 180000);
  beforeEach(() => {
    transport.state.available = true; transport.state.values.clear(); transport.state.expirations.clear(); transport.state.getHook = undefined;
    transport.resolve.mockClear(); transport.redis.get.mockClear(); transport.redis.set.mockClear(); transport.redis.del.mockClear();
  });
  afterEach(() => { expect(forbiddenNetwork).not.toHaveBeenCalled(); });
  afterAll(async () => { try { if (f) await f.close(); } finally { forbiddenNetwork?.mockRestore(); } }, 30000);

  it('authors and authenticates a purpose-bound journal with the actual maintenance owner and App while preserving business rows', async () => {
    const env = environment(), data = account(env), operationId = randomUUID(), before = await f.facts();
    expect(await append(env, data, 0, operationId)).toEqual({ recordId: operationId, revision: 1, replayed: false });
    const prepared = await prepare(env, data);
    expect(prepared.account).toMatchObject({ record_id: operationId, account_id: data.accountId, revision: 1,
      payload: { format: 1, previousRecordId: '', data, scope: { database: f.target.database, maintenance: f.target.maintenance } } });
    expect(Object.isFrozen(prepared)).toBe(true); expect(Object.isFrozen(prepared.account.payload.data.purposes)).toBe(true);
    const scope = await withTx(createContainerFromDb(f.maintenanceDb), tx => routineShippingScopeTx(tx));
    const [raw] = await f.appRuntime.db.execute(sql`SELECT * FROM public.routine_shipping_account_policy WHERE record_id=${operationId}::uuid`);
    expect(parseRoutineShippingAccountJournal(env, raw, scope)).toEqual(prepared.account);
    noSecrets(prepared.account); expect(await f.facts()).toEqual(before);
    expect(await f.maintenanceDb.execute(sql`SELECT * FROM public.routine_shipping_dispatch`)).toHaveLength(0);
    expect(await f.maintenanceDb.execute(sql`SELECT * FROM public.routine_shipping_provider_evidence`)).toHaveLength(0);
  });

  it('preserves first row/xmin and global UUID intent on replay after material withdrawal and enforces CAS', async () => {
    const env = environment(), data = account(env), operationId = randomUUID(); await append(env, data, 0, operationId);
    const first = Array.from(await rows());
    for (const [value, revision, id] of [[data,1,operationId],[data,0,randomUUID()],[{ ...data, credentialVersion: 2 },0,operationId]] as const)
      await unavailable(append(env, value, revision, id));
    const other = account(env); await unavailable(append(env, other, 0, operationId));
    env.ROUTINE_SHIPPING_ACCOUNT_CREDENTIALS = undefined;
    expect(await append(env, data, 0, operationId)).toEqual({ recordId: operationId, revision: 1, replayed: true });
    await unavailable(prepare(env, data)); expect(Array.from(await rows())).toEqual(first);
    await append(env, { ...data, state: 'revoked' }, 1);
    env.ROUTINE_SHIPPING_ACCOUNT_CREDENTIALS = REGISTRY; await unavailable(prepare(env, data));
    expect((await rows())[0]).toEqual(first[0]);
  });

  it('rejects wrong purposes, material bytes/ref/version and invalid or latest inactive windows without falling back', async () => {
    const env = environment(), data = account(env), first = Array.from(await rows());
    const invalid: RoutineShippingAccountPolicy[] = [
      { ...data, credentialStamp: '0'.repeat(64) }, { ...data, credentialRef: 'missing_ref' }, { ...data, credentialVersion: 2 },
      { ...data, purposes: ['refund_query'] as unknown as ['shipping_upload'] },
    ];
    for (const d of invalid) await unavailable(append(env, d));
    expect(Array.from(await rows())).toEqual(first); await append(env, data);
    const prepared = await prepare(env, data), fetcher = vi.fn<typeof fetch>(async () => response());
    for (const registry of [undefined, '{', JSON.stringify({ format: 1, credentials: [] }),
      JSON.stringify({ format: 1, credentials: [{ ...MATERIAL, version: 2 }] }),
      JSON.stringify({ format: 1, credentials: [{ ...MATERIAL, secret: SECRET + '-different' }] })]) {
      env.ROUTINE_SHIPPING_ACCOUNT_CREDENTIALS = registry;
      await unavailable(getRoutineShippingAccessToken(appContainer(), env, prepared, { fetcher }));
    }
    expect(fetcher).not.toHaveBeenCalled(); expect(transport.redis.get).not.toHaveBeenCalled(); env.ROUTINE_SHIPPING_ACCOUNT_CREDENTIALS = REGISTRY;
    const now = Math.floor(Date.now() / 1000), future = { ...data, validFrom: now + 600, validUntil: now + 1800 };
    await append(env, future, 1); await unavailable(prepare(env, data));
    await unavailable(append(env, { ...data, validFrom: now - 1200, validUntil: now - 600 }, 2));
    await append(env, { ...data, state: 'revoked' }, 2); await unavailable(prepare(env, data));
    await unavailable(getRoutineShippingAccessToken(appContainer(), env, prepared, { fetcher })); expect(fetcher).not.toHaveBeenCalled();
  });

  it('enforces real LOGIN, RC/RW and prior shared gate while historical metadata is readable in App RR/RO', async () => {
    const env = environment(), data = account(env); await append(env, data); const proof = await prepare(env, data), first = Array.from(await rows());
    for (const peer of [f.appRuntime,f.adminRuntime,f.financialRuntime,f.managerRuntime,f.cashierRuntime])
      await unavailable(append(env, account(env), 0, randomUUID(), peer.db));
    for (const db of [f.maintenanceDb,f.adminRuntime.db,f.financialRuntime.db,f.managerRuntime.db,f.cashierRuntime.db])
      await unavailable(withTx(createContainerFromDb(db), tx => prepareRoutineShippingAccountTx(tx, env, data.appId, data.merchantId)));
    await unavailable(withTx(appContainer(), async tx => { expect(await assertRoutineShippingReadTx(tx)).toBe(true);
      return prepareRoutineShippingAccountTx(tx, env, data.appId, data.merchantId); }));
    for (const isolationLevel of ['read committed','repeatable read'] as const)
      await unavailable(withTx(appContainer(), async tx => {
        await tx.execute(sql.raw(`SET TRANSACTION ISOLATION LEVEL ${isolationLevel},READ ONLY`));
        await tx.execute(sql`SELECT pg_catalog.pg_try_advisory_xact_lock_shared(731719,0)`);
        return prepareRoutineShippingAccountTx(tx, env, data.appId, data.merchantId);
      }));
    await unavailable(withTx(createContainerFromDb(f.maintenanceDb), async tx => {
      await tx.execute(sql`SET LOCAL ROLE ${sql.identifier(f.appRuntime.role)}`);
      return prepareRoutineShippingAccountTx(tx, env, data.appId, data.merchantId);
    }));
    expect(await withTx(appContainer(), async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ,READ ONLY`);
      return assertRoutineShippingHistoricalAccountTx(tx, env, proof.account, proof.account.created_at);
    })).toEqual(proof.account);
    expect(Array.from(await rows())).toEqual(first);
  }, 90000);

  it('rejects a future-created prior revision and foreign HMAC history without modifying system time or repairing records', async () => {
    const env = environment(), data = account(env), foreign = account(env), scope = await withTx(createContainerFromDb(f.maintenanceDb), tx => routineShippingScopeTx(tx));
    const now = await withTx(createContainerFromDb(f.maintenanceDb), tx => routineShippingClockTx(tx));
    // A past SQL clock was once ahead. The row is a legitimate same-scope MAC
    // specimen, used solely to prove the author's monotonic-write refusal.
    const body = { record_id: randomUUID(), account_id: data.accountId, revision: 1,
      payload: { format: 1 as const, scope, previousRecordId: '', data }, created_at: now + 600 };
    const bad = { ...body, record_id: randomUUID(), account_id: foreign.accountId, payload: { ...body.payload, data: foreign }, created_at: now };
    for (const [r, signature] of [[body,shippingMac(env,'account-policy',body)], [bad,routineEvidenceHmac(env,'approved-account-policy',bad)]] as const)
      await f.maintenanceDb.execute(sql`INSERT INTO public.routine_shipping_account_policy(record_id,account_id,revision,payload,created_at,signature)
        VALUES(${r.record_id}::uuid,${r.account_id},1,${JSON.stringify(r.payload)}::text::jsonb,${r.created_at},${signature})`);
    const before = Array.from(await rows()); await unavailable(append(env, data, 1)); await unavailable(prepare(env, foreign));
    await unavailable(append(env, foreign, 1)); expect(Array.from(await rows())).toEqual(before);
  });

  it('uses archived App A for real token GET despite current B or clear and refuses transaction containers before any I/O', async () => {
    const env = environment(), data = account(env); await append(env, data); const prepared = await prepare(env, data);
    const [range] = await f.maintenanceDb.execute<{ next_id: number }>(sql`SELECT (COALESCE(pg_catalog.max(id),0)+1)::integer AS next_id FROM public.system_config`);
    if (!Number.isSafeInteger(range?.next_id) || range.next_id <= 0 || range.next_id > 2147483645) throw Error('Owned configuration fixture ID range unavailable');
    const inserted = await f.maintenanceDb.insert(systemConfig).values([
      { id: range.next_id, menuName: 'routine_appId', value: JSON.stringify('wx_current_b'), sort: 2147483647 },
      { id: range.next_id + 1, menuName: 'routine_appsecret', value: JSON.stringify('synthetic-current-B-secret'), sort: 2147483647 },
      { id: range.next_id + 2, menuName: 'pay_routine_mchid', value: JSON.stringify('9876543210'), sort: 2147483647 },
    ]).returning({ id: systemConfig.id });
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input)); expect(url.origin + url.pathname).toBe('https://api.weixin.qq.com/cgi-bin/token');
      expect([...url.searchParams]).toEqual([['grant_type','client_credential'],['appid',APP],['secret',SECRET]]);
      expect(init).toMatchObject({ method: 'GET', redirect: 'manual' }); expect(init?.signal).toBeInstanceOf(AbortSignal); return response();
    });
    try {
      for (const value of ['wx_current_b','']) {
        await f.maintenanceDb.update(systemConfig).set({ value: JSON.stringify(value) }).where(eq(systemConfig.id, inserted[0].id));
        expect(await getRoutineShippingAccessToken(appContainer(), env, prepared, { fetcher, forceRefresh: true })).toBe('synthetic-provider-token-A');
      }
      expect(fetcher).toHaveBeenCalledTimes(2);
      const cacheKey = 'routine:shipping:v1:access_token:' + data.credentialStamp;
      expect(transport.redis.set.mock.calls.every(([key]) => key === cacheKey)).toBe(true); noSecrets({ cacheKey });
      const before = [transport.resolve.mock.calls.length,transport.redis.get.mock.calls.length,transport.redis.set.mock.calls.length,fetcher.mock.calls.length];
      await withTx(appContainer(), async tx => {
        await unavailable(getRoutineShippingAccessToken(createContainerFromDb(tx), env, prepared, { fetcher }));
        await unavailable(assertPreparedRoutineShippingAccount(createContainerFromDb(tx), env, prepared));
      });
      expect([transport.resolve.mock.calls.length,transport.redis.get.mock.calls.length,transport.redis.set.mock.calls.length,fetcher.mock.calls.length]).toEqual(before);
      const registry = env.ROUTINE_SHIPPING_ACCOUNT_CREDENTIALS; env.ROUTINE_SHIPPING_ACCOUNT_CREDENTIALS = undefined;
      await unavailable(getRoutineShippingAccessToken(appContainer(), env, prepared, { fetcher })); env.ROUTINE_SHIPPING_ACCOUNT_CREDENTIALS = registry;
      expect(fetcher).toHaveBeenCalledTimes(2);
      await f.maintenanceDb.execute(sql`ALTER FUNCTION public.routine_shipping_immutable_v1() COST 101`);
      try { await unavailable(getRoutineShippingAccessToken(appContainer(), env, prepared, { fetcher })); expect(fetcher).toHaveBeenCalledTimes(2); }
      finally { await f.maintenanceDb.execute(sql`ALTER FUNCTION public.routine_shipping_immutable_v1() COST 100`); }
    } finally { await f.maintenanceDb.delete(systemConfig).where(inArray(systemConfig.id, inserted.map(row => row.id))); }
  }, 90000);

  it.each([301, 302, 303, 307, 308])('refuses token HTTP %s under real archived-account approval without caching redirect data', async status => {
    const env = environment(), data = account(env); await append(env, data); const prepared = await prepare(env, data);
    const canceled = vi.fn(), fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.redirect).toBe('manual');
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ access_token: 'redirect-token-must-not-be-used', expires_in: 7200 })));
      }, cancel: canceled }), { status, headers: { location: 'https://redirect-destination.invalid/never-followed' } });
    });
    await unavailable(getRoutineShippingAccessToken(appContainer(), env, prepared, { fetcher, forceRefresh: true }));
    expect(fetcher).toHaveBeenCalledTimes(1); expect(canceled).toHaveBeenCalledTimes(1); expect(transport.redis.set).not.toHaveBeenCalled();
  }, 5000);

  it('keeps token absolute short TTL, refreshes expired cache and redacts malformed/failed transport without exposing secrets', async () => {
    const env = environment(), data = account(env); await append(env, data); const prepared = await prepare(env, data), start = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start), fetcher = vi.fn<typeof fetch>(async () => response(60));
    try {
      expect(await getRoutineShippingAccessToken(appContainer(), env, prepared, { fetcher })).toBe('synthetic-provider-token-A');
      const key = 'routine:shipping:v1:access_token:' + data.credentialStamp;
      expect(transport.redis.set.mock.calls[0]).toEqual([key,{version:1,token:'synthetic-provider-token-A',expiresAt:start+60000},{pxat:start+60000}]);
      expect(await getRoutineShippingAccessToken(appContainer(), env, prepared, { fetcher })).toBe('synthetic-provider-token-A'); expect(fetcher).toHaveBeenCalledTimes(1);
      clock.mockReturnValue(start + 61000);
      expect(await getRoutineShippingAccessToken(appContainer(), env, prepared, { fetcher })).toBe('synthetic-provider-token-A'); expect(fetcher).toHaveBeenCalledTimes(2);
      transport.state.expirations.delete(key); transport.state.values.set(key, { version:1,token:'synthetic-provider-token-A',expiresAt:start });
      await unavailable(getRoutineShippingAccessToken(appContainer(), env, prepared, { fetcher })); expect(fetcher).toHaveBeenCalledTimes(2);
      await invalidateRoutineShippingAccessToken(env, prepared); expect(transport.redis.del.mock.calls).toEqual([[key]]);
      transport.state.available = false;
      for (const packet of [{ access_token:'synthetic-provider-token-A',expires_in:0 }, { access_token:'synthetic-provider-token-A',expires_in:7201 },
        { errcode:40013,errmsg:SECRET }, { access_token:'bad token',expires_in:60 }])
        await unavailable(getRoutineShippingAccessToken(appContainer(), env, prepared, { fetcher: async () => Response.json(packet) }));
      await unavailable(getRoutineShippingAccessToken(appContainer(), env, prepared,
        { fetcher: async () => { throw Error('synthetic-error-contains-secret:' + SECRET); } }));
    } finally { clock.mockRestore(); }
  }, 90000);

  it('captures real maintenance DTO/target/environment before BEGIN and token deployment before asynchronous cache transport', async () => {
    const env = environment(), data = account(env), expected = structuredClone(data), declared = target(), operationId = randomUUID();
    const input = { operationId, expectedRevision: 0, data }, expectedEnv = { ...env };
    const pending = appendRoutineShippingAccountPolicy(f.maintenanceDb, env, declared, input);
    data.purposes.splice(0); data.appId = 'wx_mutated'; declared.app = f.adminRuntime.role; input.expectedRevision = 63; input.operationId = randomUUID();
    env.APP_KEY = 'changed_after_call'; env.ROUTINE_SHIPPING_ACCOUNT_CREDENTIALS = undefined;
    expect(await pending).toEqual({ recordId: operationId, revision:1, replayed:false });
    const prepared = await prepare(expectedEnv, expected); expect(prepared.account.payload.data).toEqual(expected);
    const fetcher = vi.fn<typeof fetch>(async input => { const url = new URL(String(input)); expect(url.searchParams.get('appid')).toBe(APP);
      expect(url.searchParams.get('secret')).toBe(SECRET); return response(); });
    transport.state.getHook = async () => { expectedEnv.ROUTINE_SHIPPING_ACCOUNT_CREDENTIALS = JSON.stringify({ format:1,credentials:[{ ...MATERIAL,appId:'wx_changed',secret:'synthetic-new-secret' }] }); };
    expect(await getRoutineShippingAccessToken(appContainer(), expectedEnv, prepared, { fetcher })).toBe('synthetic-provider-token-A');
    expect(fetcher).toHaveBeenCalledTimes(1); transport.state.getHook = undefined;
    await unavailable(getRoutineShippingAccessToken(appContainer(), expectedEnv, prepared, { fetcher })); expect(fetcher).toHaveBeenCalledTimes(1);
    const first = Array.from(await rows());
    const abort = Error('owned shipping caller rollback');
    await expect(withTx(appContainer(), async tx => { expect(await assertRoutineShippingReadyTx(tx)).toBe(true);
      const originalEnv = { ...expectedEnv, ROUTINE_SHIPPING_ACCOUNT_CREDENTIALS: REGISTRY };
      await prepareRoutineShippingAccountTx(tx, originalEnv, expected.appId, expected.merchantId);
      throw abort;
    })).rejects.toBe(abort);
    expect(Array.from(await rows())).toEqual(first);
  }, 90000);
});
