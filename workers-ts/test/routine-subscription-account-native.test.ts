/** Real owned PG16 maintenance, independent LOGINs, production approval/parser
 * and token service. Only Redis and provider HTTP transport are controlled.
 * This file proves no subscription send, payment provenance or target owner. */
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@/env';
import { createContainerFromDb, withTx } from '@/lib/di';
import { systemConfig } from '@/models/schema';
import { runRoutineOriginalPaymentEvidenceUpgrade } from '@/migrations/runRoutineOriginalPaymentEvidenceUpgrade';
import { runRoutineIdentityOwnershipUpgrade } from '@/migrations/runRoutineIdentityOwnershipUpgrade';
import { runRoutineSubscriptionUpgrade } from '@/migrations/runRoutineSubscriptionUpgrade';
import { assertRoutineSubscriptionReadyTx, assertRoutineSubscriptionReadTx } from '@/migrations/routineSubscription';
import { appendRoutineSubscriptionAccountPolicy, assertPreparedRoutineSubscriptionAccount, assertRoutineSubscriptionHistoricalAccountTx,
  parseRoutineSubscriptionAccountJournal, prepareRoutineSubscriptionAccountTx, routineSubscriptionAccountId, routineSubscriptionClockTx,
  routineSubscriptionCredentialCommitment, routineSubscriptionScopeTx, subscriptionMac,
  type RoutineSubscriptionAccountPolicy, type RoutineSubscriptionEnv } from '@/services/wechat/RoutineSubscriptionAccount';
import { routineEvidenceHmac } from '@/services/payment/RoutineProviderObservation';
import { getRoutineSubscriptionAccessToken, invalidateRoutineSubscriptionAccessToken } from '@/services/wechat/RoutineSubscriptionAccessToken';
import { customerCashierRuntimeHttpFixture } from './helpers/customerCashierRuntimeHttpFixture';

const transport = vi.hoisted(() => {
  const state = { available: false, values: new Map<string,unknown>(), expirations: new Map<string,number>(),
    getHook: undefined as undefined | (() => Promise<void>),setHook:undefined as undefined|(()=>Promise<void>) };
  const redis = {
    get: vi.fn(async (key: string) => {
      const until = state.expirations.get(key);
      if (until !== undefined && until <= Date.now()) { state.values.delete(key); state.expirations.delete(key); }
      const value = state.values.get(key) ?? null; await state.getHook?.(); return value;
    }),
    set: vi.fn(async (key: string, value: unknown, options: { pxat: number }) => {
      if (options.pxat > Date.now()) { state.values.set(key, value); state.expirations.set(key, options.pxat); }
      else { state.values.delete(key); state.expirations.delete(key); }
      await state.setHook?.();
      return 'OK';
    }),
    del: vi.fn(async (key: string) => { state.expirations.delete(key); return Number(state.values.delete(key)); }),
  };
  return { state, redis, resolve: vi.fn(() => state.available ? redis : null) };
});
vi.mock('@/utils/cache', async importOriginal => ({ ...await importOriginal<typeof import('@/utils/cache')>(), getRedis: transport.resolve }));

type Fixture = Awaited<ReturnType<typeof customerCashierRuntimeHttpFixture>>;
const SECRET = 'synthetic-subscription-secret-A-not-live', MARK='order_deliver_success';
let APP:string,OTHER_APP:string,MATERIAL:{ref:string;version:number;appId:string;secret:string},
  OTHER_MATERIAL:typeof MATERIAL,REGISTRY:string;
const KEY = 'owned-phase32-subscription-approval-authenticator';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Routine subscription actual maintenance approval and App token native', () => {
  let f: Fixture, counter = 100;
  let forbiddenNetwork: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;
  const target = () => ({ database: f.target.database, maintenance: f.target.maintenance, app: f.target.app, admin: f.target.admin });
  const environment = (): Env => ({ ...f.env, APP_KEY: KEY, ROUTINE_SUBSCRIPTION_ACCOUNT_CREDENTIALS: REGISTRY });
  function account(env: RoutineSubscriptionEnv, patch: Partial<RoutineSubscriptionAccountPolicy> = {}): RoutineSubscriptionAccountPolicy {
    const appId=patch.appId??APP,ref=patch.credentialRef??MATERIAL.ref,now=Math.floor(Date.now()/1000);
    return {accountId:routineSubscriptionAccountId(env,appId),state:'active',appId,
      credentialRef:ref,credentialVersion:1,credentialStamp:routineSubscriptionCredentialCommitment(env,ref,1).credentialStamp,
      purposes:['subscription_send'],templates:[{mark:MARK,templateId:'owned_subscription_template_a'}],
      validFrom:now-60,validUntil:now+3600,...patch};
  }
  const append = (env: RoutineSubscriptionEnv, data: RoutineSubscriptionAccountPolicy, revision = 0, operationId = randomUUID(), db = f.maintenanceDb) =>
    appendRoutineSubscriptionAccountPolicy(db, env, target(), { operationId, expectedRevision: revision, data });
  const prepare = (env: RoutineSubscriptionEnv, data: RoutineSubscriptionAccountPolicy, db = f.appRuntime.db) =>
    withTx(createContainerFromDb(db), async tx => {
      expect(await assertRoutineSubscriptionReadyTx(tx)).toBe(true);
      return prepareRoutineSubscriptionAccountTx(tx, env, data.appId, MARK);
    });
  const rows = () => f.maintenanceDb.execute(sql`SELECT pg_catalog.to_jsonb(t) AS row,xmin::text AS xmin
    FROM public.routine_subscription_account_policy t ORDER BY account_id,revision`);
  function noSecrets(value: unknown) {
    const text = JSON.stringify(value);
    for (const secret of [SECRET, KEY, REGISTRY, 'synthetic-provider-token-A', 'synthetic-error-contains-secret']) expect(text).not.toContain(secret);
    expect(text).not.toContain('connectionString'); expect(text).not.toContain('postgres://');
  }
  async function unavailable(promise: Promise<unknown>) {
    const error: unknown = await promise.then(() => { throw Error('Expected subscription refusal'); }, cause => cause);
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
    await runRoutineIdentityOwnershipUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders);
    await runRoutineSubscriptionUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders);
    expect(new Set(await Promise.all([f.appRuntime,f.adminRuntime,f.financialRuntime,f.managerRuntime,f.cashierRuntime].map(peer => peer.verify()))).size).toBe(5);
  }, 180000);
  beforeEach(() => {
    counter++;APP='wx_subscription_a_'+counter;OTHER_APP='wx_subscription_b_'+counter;
    MATERIAL={ref:'archived_subscription_a',version:1,appId:APP,secret:SECRET};
    OTHER_MATERIAL={ref:'archived_subscription_b',version:1,appId:OTHER_APP,secret:SECRET+'-B'};
    REGISTRY=JSON.stringify({format:1,credentials:[MATERIAL,OTHER_MATERIAL]});
    transport.state.available = true; transport.state.values.clear(); transport.state.expirations.clear(); transport.state.getHook = undefined;transport.state.setHook=undefined;
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
    expect(prepared.template).toEqual({mark:MARK,templateId:'owned_subscription_template_a'});
    expect(Object.isFrozen(prepared.account.payload.data.templates)).toBe(true);
    expect(Object.isFrozen(prepared.template)).toBe(true);
    const scope = await withTx(createContainerFromDb(f.maintenanceDb), tx => routineSubscriptionScopeTx(tx));
    const [raw] = await f.appRuntime.db.execute(sql`SELECT * FROM public.routine_subscription_account_policy WHERE record_id=${operationId}::uuid`);
    expect(parseRoutineSubscriptionAccountJournal(env, raw, scope)).toEqual(prepared.account);
    noSecrets(prepared.account); expect(await f.facts()).toEqual(before);
    expect(forbiddenNetwork).not.toHaveBeenCalled();
  });

  it('preserves first row/xmin and global UUID intent on replay after material withdrawal and enforces CAS', async () => {
    const env = environment(), data = account(env), operationId = randomUUID(); await append(env, data, 0, operationId);
    const first = Array.from(await rows());
    for (const [value, revision, id] of [[data,1,operationId],[data,0,randomUUID()],[{ ...data, credentialVersion: 2 },0,operationId]] as const)
      await unavailable(append(env, value, revision, id));
    const other = account(env, {appId:OTHER_APP,credentialRef:OTHER_MATERIAL.ref}); await unavailable(append(env, other, 0, operationId));
    env.ROUTINE_SUBSCRIPTION_ACCOUNT_CREDENTIALS = undefined;
    expect(await append(env, data, 0, operationId)).toEqual({ recordId: operationId, revision: 1, replayed: true });
    await unavailable(prepare(env, data)); expect(Array.from(await rows())).toEqual(first);
    await append(env, { ...data, state: 'revoked' }, 1);
    env.ROUTINE_SUBSCRIPTION_ACCOUNT_CREDENTIALS = REGISTRY; await unavailable(prepare(env, data));
    expect((await rows())[0]).toEqual(first[0]);
  });

  it('rejects wrong purposes, material bytes/ref/version and invalid or latest inactive windows without falling back', async () => {
    const env = environment(), data = account(env), first = Array.from(await rows());
    const invalid: RoutineSubscriptionAccountPolicy[] = [
      { ...data, credentialStamp: '0'.repeat(64) }, { ...data, credentialRef: 'missing_ref' }, { ...data, credentialVersion: 2 },
      ...['refund_query','shipping_upload','notify','query'].map(p=>({...data,purposes:[p] as unknown as ['subscription_send']})),
    ];
    for (const d of invalid) await unavailable(append(env, d));
    expect(Array.from(await rows())).toEqual(first); await append(env, data);
    const prepared = await prepare(env, data), fetcher = vi.fn<typeof fetch>(async () => response());
    for (const registry of [undefined, '{', JSON.stringify({ format: 1, credentials: [] }),
      JSON.stringify({ format: 1, credentials: [{ ...MATERIAL, version: 2 }] }),
      JSON.stringify({ format: 1, credentials: [{ ...MATERIAL, secret: SECRET + '-different' }] })]) {
      env.ROUTINE_SUBSCRIPTION_ACCOUNT_CREDENTIALS = registry;
      await unavailable(getRoutineSubscriptionAccessToken(appContainer(), env, prepared, { fetcher }));
    }
    expect(fetcher).not.toHaveBeenCalled(); expect(transport.redis.get).not.toHaveBeenCalled(); env.ROUTINE_SUBSCRIPTION_ACCOUNT_CREDENTIALS = REGISTRY;
    const now = Math.floor(Date.now() / 1000), future = { ...data, validFrom: now + 600, validUntil: now + 1800 };
    await append(env, future, 1); await unavailable(prepare(env, data));
    await unavailable(append(env, { ...data, validFrom: now - 1200, validUntil: now - 600 }, 2));
    await append(env, { ...data, state: 'revoked' }, 2); await unavailable(prepare(env, data));
    await unavailable(getRoutineSubscriptionAccessToken(appContainer(), env, prepared, { fetcher })); expect(fetcher).not.toHaveBeenCalled();
  });

  it('enforces real LOGIN, RC/RW and prior shared gate while historical metadata is readable in App RR/RO', async () => {
    const env = environment(), data = account(env); await append(env, data); const proof = await prepare(env, data), first = Array.from(await rows());
    for (const peer of [f.appRuntime,f.adminRuntime,f.financialRuntime,f.managerRuntime,f.cashierRuntime])
      await unavailable(append(env, account(env), 0, randomUUID(), peer.db));
    for (const db of [f.maintenanceDb,f.adminRuntime.db,f.financialRuntime.db,f.managerRuntime.db,f.cashierRuntime.db])
      await unavailable(withTx(createContainerFromDb(db), tx => prepareRoutineSubscriptionAccountTx(tx, env, data.appId, MARK)));
    await unavailable(withTx(appContainer(), async tx => { expect(await assertRoutineSubscriptionReadTx(tx)).toBe(true);
      return prepareRoutineSubscriptionAccountTx(tx, env, data.appId, MARK); }));
    for (const isolationLevel of ['read committed','repeatable read'] as const)
      await unavailable(withTx(appContainer(), async tx => {
        await tx.execute(sql.raw(`SET TRANSACTION ISOLATION LEVEL ${isolationLevel},READ ONLY`));
        await tx.execute(sql`SELECT pg_catalog.pg_try_advisory_xact_lock_shared(731725,0)`);
        return prepareRoutineSubscriptionAccountTx(tx, env, data.appId, MARK);
      }));
    await unavailable(withTx(createContainerFromDb(f.maintenanceDb), async tx => {
      await tx.execute(sql`SET LOCAL ROLE ${sql.identifier(f.appRuntime.role)}`);
      return prepareRoutineSubscriptionAccountTx(tx, env, data.appId, MARK);
    }));
    expect(await withTx(appContainer(), async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ,READ ONLY`);
      return assertRoutineSubscriptionHistoricalAccountTx(tx, env, proof.account, proof.account.created_at);
    })).toEqual(proof.account);
    expect(Array.from(await rows())).toEqual(first);
  }, 90000);

  it('rejects a future-created prior revision and foreign HMAC history without modifying system time or repairing records', async () => {
    const env = environment(), data = account(env), foreign = account(env, {appId:OTHER_APP,credentialRef:OTHER_MATERIAL.ref}), scope = await withTx(createContainerFromDb(f.maintenanceDb), tx => routineSubscriptionScopeTx(tx));
    const now = await withTx(createContainerFromDb(f.maintenanceDb), tx => routineSubscriptionClockTx(tx));
    // A past SQL clock was once ahead. The row is a legitimate same-scope MAC
    // specimen, used solely to prove the author's monotonic-write refusal.
    const body = { record_id: randomUUID(), account_id: data.accountId, revision: 1,
      payload: { format: 1 as const, scope, previousRecordId: '', data }, created_at: now + 600 };
    const bad = { ...body, record_id: randomUUID(), account_id: foreign.accountId, payload: { ...body.payload, data: foreign }, created_at: now };
    for (const [r, signature] of [[body,subscriptionMac(env,'account-policy',body)], [bad,routineEvidenceHmac(env,'approved-account-policy',bad)]] as const)
      await f.maintenanceDb.execute(sql`INSERT INTO public.routine_subscription_account_policy(record_id,account_id,revision,payload,created_at,signature)
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
      expect(init).toMatchObject({ method: 'GET', redirect: 'error' }); expect(init?.signal).toBeInstanceOf(AbortSignal); return response();
    });
    try {
      for (const value of ['wx_current_b','']) {
        await f.maintenanceDb.update(systemConfig).set({ value: JSON.stringify(value) }).where(eq(systemConfig.id, inserted[0].id));
        expect(await getRoutineSubscriptionAccessToken(appContainer(), env, prepared, { fetcher, forceRefresh: true })).toBe('synthetic-provider-token-A');
      }
      expect(fetcher).toHaveBeenCalledTimes(2);
      const cacheKey = 'routine:subscription:v1:access_token:' + data.credentialStamp;
      expect(transport.redis.set.mock.calls.every(([key]) => key === cacheKey)).toBe(true); noSecrets({ cacheKey });
      const before = [transport.resolve.mock.calls.length,transport.redis.get.mock.calls.length,transport.redis.set.mock.calls.length,fetcher.mock.calls.length];
      await withTx(appContainer(), async tx => {
        await unavailable(getRoutineSubscriptionAccessToken(createContainerFromDb(tx), env, prepared, { fetcher }));
        await unavailable(assertPreparedRoutineSubscriptionAccount(createContainerFromDb(tx), env, prepared));
      });
      expect([transport.resolve.mock.calls.length,transport.redis.get.mock.calls.length,transport.redis.set.mock.calls.length,fetcher.mock.calls.length]).toEqual(before);
      const registry = env.ROUTINE_SUBSCRIPTION_ACCOUNT_CREDENTIALS; env.ROUTINE_SUBSCRIPTION_ACCOUNT_CREDENTIALS = undefined;
      await unavailable(getRoutineSubscriptionAccessToken(appContainer(), env, prepared, { fetcher })); env.ROUTINE_SUBSCRIPTION_ACCOUNT_CREDENTIALS = registry;
      expect(fetcher).toHaveBeenCalledTimes(2);
      await f.maintenanceDb.execute(sql`ALTER FUNCTION public.routine_subscription_immutable_v1() COST 101`);
      try { await unavailable(getRoutineSubscriptionAccessToken(appContainer(), env, prepared, { fetcher })); expect(fetcher).toHaveBeenCalledTimes(2); }
      finally { await f.maintenanceDb.execute(sql`ALTER FUNCTION public.routine_subscription_immutable_v1() COST 100`); }
    } finally { await f.maintenanceDb.delete(systemConfig).where(inArray(systemConfig.id, inserted.map(row => row.id))); }
  }, 90000);

  it('keeps token absolute short TTL, refreshes expired cache and redacts malformed/failed transport without exposing secrets', async () => {
    const env = environment(), data = account(env); await append(env, data); const prepared = await prepare(env, data), start = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start), fetcher = vi.fn<typeof fetch>(async () => response(60));
    try {
      expect(await getRoutineSubscriptionAccessToken(appContainer(), env, prepared, { fetcher })).toBe('synthetic-provider-token-A');
      const key = 'routine:subscription:v1:access_token:' + data.credentialStamp;
      expect(transport.redis.set.mock.calls[0]).toEqual([key,{version:1,token:'synthetic-provider-token-A',expiresAt:start+60000},{pxat:start+60000}]);
      expect(await getRoutineSubscriptionAccessToken(appContainer(), env, prepared, { fetcher })).toBe('synthetic-provider-token-A'); expect(fetcher).toHaveBeenCalledTimes(1);
      clock.mockReturnValue(start + 61000);
      expect(await getRoutineSubscriptionAccessToken(appContainer(), env, prepared, { fetcher })).toBe('synthetic-provider-token-A'); expect(fetcher).toHaveBeenCalledTimes(2);
      transport.state.expirations.delete(key); transport.state.values.set(key, { version:1,token:'synthetic-provider-token-A',expiresAt:start });
      await unavailable(getRoutineSubscriptionAccessToken(appContainer(), env, prepared, { fetcher })); expect(fetcher).toHaveBeenCalledTimes(2);
      await invalidateRoutineSubscriptionAccessToken(env, prepared); expect(transport.redis.del.mock.calls).toEqual([[key]]);
      transport.state.available = false;
      for (const packet of [{ access_token:'synthetic-provider-token-A',expires_in:0 }, { access_token:'synthetic-provider-token-A',expires_in:7201 },
        { errcode:40013,errmsg:SECRET }, { access_token:'bad token',expires_in:60 }])
        await unavailable(getRoutineSubscriptionAccessToken(appContainer(), env, prepared, { fetcher: async () => Response.json(packet) }));
      await unavailable(getRoutineSubscriptionAccessToken(appContainer(), env, prepared,
        { fetcher: async () => { throw Error('synthetic-error-contains-secret:' + SECRET); } }));
    } finally { clock.mockRestore(); }
  }, 90000);

  it('captures real maintenance DTO/target/environment before BEGIN and token deployment before asynchronous cache transport', async () => {
    const env = environment(), data = account(env), expected = structuredClone(data), declared = target(), operationId = randomUUID();
    const input = { operationId, expectedRevision: 0, data }, expectedEnv = { ...env };
    const pending = appendRoutineSubscriptionAccountPolicy(f.maintenanceDb, env, declared, input);
    data.purposes.splice(0);data.templates[0].templateId='mutated_template';data.templates.splice(0);
    data.appId = 'wx_mutated'; declared.app = f.adminRuntime.role; input.expectedRevision = 63; input.operationId = randomUUID();
    env.APP_KEY = 'changed_after_call'; env.ROUTINE_SUBSCRIPTION_ACCOUNT_CREDENTIALS = undefined;
    expect(await pending).toEqual({ recordId: operationId, revision:1, replayed:false });
    const prepared = await prepare(expectedEnv, expected); expect(prepared.account.payload.data).toEqual(expected);
    const fetcher = vi.fn<typeof fetch>(async input => { const url = new URL(String(input)); expect(url.searchParams.get('appid')).toBe(APP);
      expect(url.searchParams.get('secret')).toBe(SECRET); return response(); });
    transport.state.getHook = async () => { expectedEnv.ROUTINE_SUBSCRIPTION_ACCOUNT_CREDENTIALS = JSON.stringify({ format:1,credentials:[{ ...MATERIAL,appId:'wx_changed',secret:'synthetic-new-secret' }] }); };
    expect(await getRoutineSubscriptionAccessToken(appContainer(), expectedEnv, prepared, { fetcher })).toBe('synthetic-provider-token-A');
    expect(fetcher).toHaveBeenCalledTimes(1); transport.state.getHook = undefined;
    await unavailable(getRoutineSubscriptionAccessToken(appContainer(), expectedEnv, prepared, { fetcher })); expect(fetcher).toHaveBeenCalledTimes(1);
    const first = Array.from(await rows());
    const abort = Error('owned subscription caller rollback');
    await expect(withTx(appContainer(), async tx => { expect(await assertRoutineSubscriptionReadyTx(tx)).toBe(true);
      const originalEnv = { ...expectedEnv, ROUTINE_SUBSCRIPTION_ACCOUNT_CREDENTIALS: REGISTRY };
      await prepareRoutineSubscriptionAccountTx(tx, originalEnv, expected.appId, MARK);
      throw abort;
    })).rejects.toBe(abort);
    expect(Array.from(await rows())).toEqual(first);
  }, 90000);

  it('requires a dense sorted explicit template list and never invokes untrusted accessors or falls back to another mark',async()=>{
    const env=environment(),data=account(env),before=Array.from(await rows());let getterCalls=0;
    const accessor=[{mark:MARK,templateId:'safe'}];Object.defineProperty(accessor,'0',{enumerable:true,get(){getterCalls++;throw Error('getter must not run');}});
    for(const list of [[],Array(1),accessor,
      [{mark:MARK,templateId:'a'},{mark:MARK,templateId:'b'}],
      [{mark:'z_last',templateId:'z'},{mark:'a_first',templateId:'a'}],
      [{mark:MARK,templateId:'unsafe/template'}],
      Array.from({length:17},(_,i)=>({mark:'mark_'+String(i).padStart(2,'0'),templateId:'id_'+i}))])
      await unavailable(append(env,{...data,templates:list}));
    expect(getterCalls).toBe(0);expect(Array.from(await rows())).toEqual(before);
    await append(env,data);
    await unavailable(withTx(appContainer(),async tx=>{
      expect(await assertRoutineSubscriptionReadyTx(tx)).toBe(true);
      return prepareRoutineSubscriptionAccountTx(tx,env,APP,'unapproved_mark');
    }));
    expect((await prepare(env,data)).template).toEqual(data.templates[0]);
  });

  it('seals template preparation and rejects copied capabilities, shipping/current namespaces and material fallbacks',async()=>{
    const env=environment(),data=account(env);await append(env,data);const proof=await prepare(env,data);
    const fetcher=vi.fn<typeof fetch>(async()=>response());
    for(const copy of [{...proof},JSON.parse(JSON.stringify(proof)),{...proof,template:{mark:MARK,templateId:'other_template'}}])
      await unavailable(getRoutineSubscriptionAccessToken(appContainer(),env,copy,{fetcher}));
    expect(transport.resolve).not.toHaveBeenCalled();expect(fetcher).not.toHaveBeenCalled();
    for(const prefix of ['routine:shipping:v1:access_token:','routine:v2:access_token:'])
      transport.state.values.set(prefix+data.credentialStamp,{version:1,token:'wrong-purpose-token',expiresAt:Date.now()+60000});
    expect(await getRoutineSubscriptionAccessToken(appContainer(),env,proof,{fetcher})).toBe('synthetic-provider-token-A');
    expect(transport.redis.get.mock.calls.map(([key])=>key)).toEqual(['routine:subscription:v1:access_token:'+data.credentialStamp]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    env.ROUTINE_SUBSCRIPTION_ACCOUNT_CREDENTIALS=undefined;
    env.ROUTINE_SHIPPING_ACCOUNT_CREDENTIALS=REGISTRY;
    await unavailable(getRoutineSubscriptionAccessToken(appContainer(),env,proof,{fetcher}));expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(['cache','provider','write'] as const)('rechecks a revoked approval after %s I/O with no SQL lock held by the transport',async stage=>{
    const env=environment(),data=account(env);await append(env,data);const proof=await prepare(env,data);
    let retired=false;const revoke=async()=>{await append(env,{...data,state:'revoked'},1);retired=true;};
    const key='routine:subscription:v1:access_token:'+data.credentialStamp;
    if(stage==='cache'){
      transport.state.values.set(key,{version:1,token:'synthetic-provider-token-A',expiresAt:Date.now()+60000});
      transport.state.getHook=revoke;
    }else if(stage==='write')transport.state.setHook=revoke;
    const fetcher=vi.fn<typeof fetch>(async()=>{if(stage==='provider')await revoke();return response();});
    await unavailable(getRoutineSubscriptionAccessToken(appContainer(),env,proof,{fetcher}));
    expect(retired).toBe(true);expect(fetcher).toHaveBeenCalledTimes(stage==='cache'?0:1);
    expect(transport.redis.set).toHaveBeenCalledTimes(stage==='write'?1:0);
  });

  it('retires prior template capabilities while preserving historical policy without treating it as send evidence',async()=>{
    const env=environment(),data=account(env);await append(env,data);const proof=await prepare(env,data);
    const next={...data,templates:[{mark:MARK,templateId:'owned_replacement_template'}]};
    await append(env,next,1);
    const fetcher=vi.fn<typeof fetch>(async()=>response());
    await unavailable(getRoutineSubscriptionAccessToken(appContainer(),env,proof,{fetcher}));expect(fetcher).not.toHaveBeenCalled();
    const current=await prepare(env,data);expect(current.template.templateId).toBe('owned_replacement_template');
    await append(env,{...next,state:'revoked'},2);env.ROUTINE_SUBSCRIPTION_ACCOUNT_CREDENTIALS=undefined;
    expect(await withTx(appContainer(),async tx=>{
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ,READ ONLY`);
      return assertRoutineSubscriptionHistoricalAccountTx(tx,env,proof.account,proof.account.created_at);
    })).toEqual(proof.account);
    await unavailable(prepare(env,data));
  });

  it('bounds and authenticates token responses before caching without exposing transport or provider bodies',async()=>{
    const env=environment(),data=account(env);await append(env,data);const proof=await prepare(env,data);
    transport.state.available=false;
    const redirected=response();Object.defineProperty(redirected,'redirected',{value:true});
    for(const packet of [redirected,
      new Response('{}',{headers:{'content-length':'32769'}}),new Response(' '.repeat(32769)),
      new Response(new Uint8Array([255])),Response.json([]),
      Response.json({access_token:'synthetic-provider-token-A',expires_in:'7200'}),
      Response.json({access_token:'synthetic-provider-token-A',expires_in:60},{status:503})])
      await unavailable(getRoutineSubscriptionAccessToken(appContainer(),env,proof,{fetcher:async()=>packet}));
    expect(transport.redis.set).not.toHaveBeenCalled();
  });
});
