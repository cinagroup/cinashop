import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@/env';
import { createContainerFromDb, withTx, type DbClient } from '@/lib/di';
import { agentLevel, agentLevelTask, agentLevelTaskRecord, luckLottery, storeCouponIssue, storeCouponIssueUser,
  storeCouponUser, storeOrder, systemConfig, user, userBill, userFriends, userMoney, userSpread, userVisit, wechatUser } from '@/models/schema';
import { ROUTINE_IDENTITY_WITNESS_SQL, inspectRoutineIdentityWitness } from '@/migrations/routineIdentityWitness';
import { WechatAuthService, type VerifiedSocialIdentity } from '@/services/wechat/WechatAuthService';
import { readRoutineCredentials } from '@/services/wechat/RoutineRuntimeConfig';
import { issueRoutineIdentityObservation, type RoutineIdentityObservation } from '@/services/wechat/RoutineIdentityObservation';
import { appendRoutineIdentityWitness, readRoutineIdentityWitness } from '@/services/wechat/RoutineIdentityWitness';
import { md5 } from '@/utils/jwt';
import { financePostgres, ownsFinanceFixtureTarget, validateFinanceFixtureUrl } from './helpers/financePostgres';
import { withFinancePeers } from './helpers/financePeers';

const APP = 'owned-witness-mini', OPENID = 'owned-witness-openid', UNION = 'owned-witness-union';
const TABLE = 'public.routine_identity_witness';
type ReadInput = Parameters<typeof readRoutineIdentityWitness>[2];

/** Native PG16 only: real catalog/constraints, caller transactions, Auth
 * reconciliation and independently authenticated LOGINs. This proves only the
 * witness table's narrow ACL, not commissioning of the whole runtime role.
 * No HMAC, SQL, binding resolver, source fence or Auth effect is mocked. */
describe('Mini identity observations and durable public witnesses on actual PG16', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>, env: Env;
  const kv = new Map<string, string>();
  let network: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;
  const container = () => createContainerFromDb(f.db);
  const auth = () => new WechatAuthService(container(), env);
  const facts = (patch: Partial<ReadInput> = {}): ReadInput => ({ uid: 7, bindingId: 7, appId: APP, openid: OPENID, ...patch });
  const raw = () => f.db.execute(sql`SELECT observation_id::text,uid,binding_id,format_version,observation,
    created_at::text,signature FROM public.routine_identity_witness ORDER BY observation_id`);
  const business = async () => ({ users: await f.db.select().from(user).orderBy(user.uid),
    bindings: await f.db.select().from(wechatUser).orderBy(wechatUser.id),
    bills: await f.db.select().from(userBill).orderBy(userBill.id), money: await f.db.select().from(userMoney).orderBy(userMoney.id) });
  const append = (observation: RoutineIdentityObservation, uid = 7, db = f.db) =>
    withTx(createContainerFromDb(db), tx => appendRoutineIdentityWitness(tx, env, { uid, observation }));
  const read = (input = facts(), db = f.db) => withTx(createContainerFromDb(db), tx => readRoutineIdentityWitness(tx, env, input));
  async function observation(openid = OPENID, unionid = '') {
    const credentials = await readRoutineCredentials(container(), env);
    return issueRoutineIdentityObservation(env, { appId: credentials.appId, openid, unionid, sourceStamp: credentials.stamp });
  }
  const identity = (proof: RoutineIdentityObservation): VerifiedSocialIdentity => ({ openid: proof.openid,
    unionid: proof.unionid, userType: 'routine', routineStamp: proof.sourceStamp, routineObservation: proof });
  function gifts() {
    for (const [name, value] of Object.entries({ newcomer_status: '1', register_integral_status: '1',
      register_give_integral: '5', register_money_status: '1', register_give_money: '2' })) kv.set('cfg_' + name, value);
  }
  async function corrupt(statement: string) {
    await f.exec('ALTER TABLE public.routine_identity_witness DISABLE TRIGGER riw_immutable_rows');
    try { await f.exec(statement); }
    finally { await f.exec('ALTER TABLE public.routine_identity_witness ENABLE TRIGGER riw_immutable_rows'); }
  }
  // Execute real SQL first, then mutate only the caller's JS arguments at the
  // asynchronous boundary. No statement, result, source check or lock is faked.
  function afterFirstSql(tx: DbClient, change: () => void): DbClient {
    let first = true;
    return new Proxy(tx, { get(target, property, receiver) {
      const method: unknown = Reflect.get(target, property, receiver);
      if (typeof method !== 'function') return method;
      if (property !== 'execute') return method.bind(target);
      return async (...args: unknown[]) => {
        const result: unknown = await Reflect.apply(method, target, args);
        if (first) { first = false; change(); }
        return result;
      };
    } });
  }

  beforeAll(async () => {
    if (!process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Actual isolated PostgreSQL16 is required; this suite cannot be skipped into memory');
    f = await financePostgres([systemConfig, user, wechatUser, userVisit, userBill, userMoney, storeCouponIssue,
      storeCouponIssueUser, storeCouponUser, userSpread, userFriends, luckLottery, agentLevel, agentLevelTask,
      agentLevelTaskRecord, storeOrder], { namespace: 'public' });
    await f.exec('CREATE UNIQUE INDEX riw_fixture_openid_uq ON public.wechat_user(openid)');
  }, 30_000);
  afterAll(async () => { await f?.close(); }, 30_000);
  beforeEach(async () => {
    // This database is owned by this fixture. Drop/reinstall only its raw
    // ledger; never TRUNCATE the immutable table or touch a supplied database.
    await f.exec('DROP TABLE IF EXISTS public.routine_identity_witness');
    await f.exec('DROP FUNCTION IF EXISTS public.routine_identity_witness_immutable_v1()');
    await f.reset(); await f.exec(ROUTINE_IDENTITY_WITNESS_SQL); kv.clear();
    await f.db.insert(systemConfig).values([
      { id: 1, menuName: 'routine_appId', value: JSON.stringify(APP), sort: 5 },
      { id: 2, menuName: 'routine_appsecret', value: '"owned-witness-secret"', sort: 5 },
    ]);
    await f.db.insert(user).values([
      { uid: 7, account: 'owned-witness-user', pwd: md5('owned-password'), nickname: 'Existing member', userType: 'routine',
        status: 1, nowMoney: '25.00', integral: 81, level: 2, levelStatus: 1, isMoneyLevel: 1 },
      { uid: 8, account: 'owned-witness-other', status: 1 },
    ]);
    await f.db.insert(wechatUser).values({ id: 7, uid: 7, openid: OPENID, userType: 'routine' });
    env = { APP_KEY: 'owned-routine-witness-signing-key', CONFIG_KV: {
      get: vi.fn(async (key: string) => {
        if (/^cfg_(?:routine_appId|routine_appsecret)/u.test(key)) throw Error('Credentials cannot come from KV');
        return kv.get(key) ?? '0';
      }), put: vi.fn(async () => {}), delete: vi.fn(async () => {}),
    } } as unknown as Env;
    network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No provider HTTP is permitted in internal witness tests'));
  });
  afterEach(() => { try { expect(network).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); } });

  it('preserves an existing UID and rights, stores the complete observed payload and does not repeat registration gifts', async () => {
    gifts(); const before = await business(), proof = await observation();
    expect(await auth().reconcileVerifiedIdentity(identity(proof))).toBe(7);
    expect(await auth().reconcileVerifiedIdentity(identity(proof))).toBe(7);
    expect(await business()).toEqual(before);
    expect(await raw()).toMatchObject([{ uid: 7, binding_id: 7, observation_id: proof.observationId, observation: proof }]);
    const saved = await read(); expect(saved).toMatchObject({ uid: 7, bindingId: 7, observation: proof });
    expect(Object.isFrozen(saved)).toBe(true); expect(Object.isFrozen(saved?.observation)).toBe(true);
  });

  it('materializes the exact routine openid after a unionid-only lookup before appending in the same SQL transaction', async () => {
    gifts(); await f.db.delete(wechatUser);
    await f.db.insert(wechatUser).values({ id: 9, uid: 7, openid: 'owned-official-openid', unionid: UNION, userType: 'wechat' });
    const before = await business(), proof = await observation('owned-union-mini-openid', UNION);
    expect(await auth().reconcileVerifiedIdentity(identity(proof))).toBe(7);
    const after = await business(); expect(after.users).toEqual(before.users); expect(after.bills).toEqual([]); expect(after.money).toEqual([]);
    expect(after.bindings).toContainEqual(before.bindings[0]);
    const binding = after.bindings.find(row => row.openid === proof.openid)!;
    expect(binding).toMatchObject({ uid: 7, userType: 'routine', unionid: UNION });
    const rows = await raw(); expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ uid: 7, binding_id: binding.id, observation: proof });
    const [xid] = await f.db.execute<{ same: boolean }>(sql`SELECT w.xmin=e.xmin AS same FROM public.wechat_user w
      JOIN public.routine_identity_witness e ON e.binding_id=w.id WHERE e.observation_id=${proof.observationId}::uuid`);
    expect(xid.same).toBe(true);
  });

  it.each(['exact', 'unionid-only'] as const)('keeps existing %s UID login usable when every registration KV read fails', async kind => {
    gifts();
    if (kind === 'unionid-only') {
      await f.db.delete(wechatUser);
      await f.db.insert(wechatUser).values({ id: 9, uid: 7, openid: 'owned-official-openid', unionid: UNION, userType: 'wechat' });
    }
    const proof = await observation(kind === 'exact' ? OPENID : 'owned-kv-independent-openid', kind === 'exact' ? '' : UNION);
    const before = await business();
    vi.mocked(env.CONFIG_KV.get).mockRejectedValue(Error('owned_registration_kv_unavailable'));
    expect(await auth().reconcileVerifiedIdentity(identity(proof))).toBe(7);
    expect(await auth().reconcileVerifiedIdentity(identity(proof))).toBe(7);
    expect(env.CONFIG_KV.get).not.toHaveBeenCalled();
    const after = await business();
    expect(after.users).toEqual(before.users); expect(after.bills).toEqual(before.bills); expect(after.money).toEqual(before.money);
    for (const binding of before.bindings) expect(after.bindings).toContainEqual(binding);
    expect(after.bindings).toHaveLength(kind === 'exact' ? before.bindings.length : before.bindings.length + 1);
    const binding = after.bindings.find(row => row.openid === proof.openid)!;
    expect(binding).toMatchObject({ uid: 7, userType: 'routine' });
    expect(await raw()).toMatchObject([{ observation_id: proof.observationId, uid: 7, binding_id: binding.id, observation: proof }]);
    expect(await read(facts({ bindingId: binding.id, openid: proof.openid }))).toMatchObject({ uid: 7, observation: proof });
  });

  it('does not create a new UID, gifts or proof when registration configuration cannot be prefetched', async () => {
    gifts(); const proof = await observation('owned-new-kv-failure-openid'), before = await business();
    vi.mocked(env.CONFIG_KV.get).mockRejectedValue(Error('owned_registration_kv_unavailable'));
    await expect(auth().reconcileVerifiedIdentity(identity(proof))).rejects.toThrow('owned_registration_kv_unavailable');
    expect(env.CONFIG_KV.get).toHaveBeenCalled(); expect(await business()).toEqual(before); expect(await raw()).toEqual([]);
  });

  it('aborts when the gift-prefetch candidate disappears before the actual source and identity transaction', async () => {
    gifts(); const proof = await observation(), before = await business(); let transactions = 0;
    vi.mocked(env.CONFIG_KV.get).mockRejectedValue(Error('owned_registration_kv_must_not_be_read'));
    const db = new Proxy(f.db, { get(target, property, receiver) {
      const method: unknown = Reflect.get(target, property, receiver);
      if (typeof method !== 'function') return method;
      if (property !== 'transaction') return method.bind(target);
      return async (...args: unknown[]) => {
        if (++transactions === 1) {
          // Independent committed owner SQL, before BEGIN on the real Auth
          // transaction. Keep this external deletion in the final assertions.
          await f.db.delete(wechatUser).where(eq(wechatUser.id, 7));
        }
        return Reflect.apply(method, target, args);
      };
    } });
    await expect(new WechatAuthService(createContainerFromDb(db), env).reconcileVerifiedIdentity(identity(proof)))
      .rejects.toThrow('重新授权');
    expect(transactions).toBe(1); expect(env.CONFIG_KV.get).not.toHaveBeenCalled();
    expect(await business()).toEqual({ ...before, bindings: [] }); expect(await raw()).toEqual([]);
  });

  it('captures append UID and signed observation before the first actual asynchronous SQL result', async () => {
    const proof = await observation(), input = { uid: 7, observation: proof }; let changes = 0;
    const saved = await withTx(container(), tx => appendRoutineIdentityWitness(afterFirstSql(tx, () => {
      changes++; input.uid = 8; input.observation = { ...proof, openid: 'owned-mutated-openid' };
    }), env, input));
    expect(changes).toBe(1); expect(input.uid).toBe(8); expect(input.observation.openid).toBe('owned-mutated-openid');
    expect(saved).toMatchObject({ uid: 7, bindingId: 7, observation: proof });
    expect(await raw()).toMatchObject([{ uid: 7, binding_id: 7, observation: proof }]);
  });

  it('captures all public read arguments before the first actual asynchronous SQL result', async () => {
    const proof = await observation(); await append(proof); const before = await raw(), input = facts(); let changes = 0;
    const saved = await withTx(container(), tx => readRoutineIdentityWitness(afterFirstSql(tx, () => {
      changes++; Object.assign(input, { uid: 8, bindingId: 10, appId: 'owned-other-app', openid: 'owned-other-openid' });
    }), env, input));
    expect(changes).toBe(1); expect(input).toEqual({ uid: 8, bindingId: 10, appId: 'owned-other-app', openid: 'owned-other-openid' });
    expect(saved).toMatchObject({ uid: 7, bindingId: 7, observation: proof }); expect(await raw()).toEqual(before);
  });

  it.each(['appId', 'openid'] as const)('rejects newline in public %s before issuing any helper SQL', async field => {
    const input = facts(); input[field] += '\n'; let statements = 0;
    await withTx(container(), async tx => {
      await expect(readRoutineIdentityWitness(afterFirstSql(tx, () => { statements++; }), env, input)).rejects.toThrow('参数无效');
    });
    expect(statements).toBe(0); expect(await raw()).toEqual([]);
  });

  it('rolls back the identity, registration gifts and already-appended witness together on a deferred commit failure', async () => {
    gifts(); const before = await business(), proof = await observation('owned-rollback-mini-openid');
    await f.exec(`CREATE FUNCTION public.riw_fixture_late_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.openid='owned-rollback-mini-openid' THEN
        IF NOT EXISTS(SELECT 1 FROM public.routine_identity_witness e WHERE e.observation_id='${proof.observationId}'::uuid
          AND e.uid=NEW.uid AND e.binding_id=NEW.id) THEN RAISE EXCEPTION 'witness_not_visible_in_identity_transaction'; END IF;
        RAISE EXCEPTION 'owned_identity_witness_late_commit_failure';
      END IF; RETURN NEW; END $$;
      CREATE CONSTRAINT TRIGGER riw_fixture_late_failure AFTER INSERT ON public.wechat_user
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.riw_fixture_late_failure()`);
    try {
      await expect(auth().reconcileVerifiedIdentity(identity(proof))).rejects.toThrow('owned_identity_witness_late_commit_failure');
      expect(await business()).toEqual(before); expect(await raw()).toEqual([]);
    } finally {
      await f.exec('DROP TRIGGER riw_fixture_late_failure ON public.wechat_user; DROP FUNCTION public.riw_fixture_late_failure()');
    }
  });

  it('retains a committed complete proof across lost acknowledgement and makes the same observation retry idempotent', async () => {
    const proof = await observation();
    await expect((async () => { await append(proof); throw Error('owned_acknowledgement_lost_after_commit'); })()).rejects.toThrow('acknowledgement_lost');
    const before = await raw(), retried = await append(proof);
    expect(retried).toMatchObject({ observationId: proof.observationId, uid: 7, bindingId: 7, observation: proof });
    expect(await raw()).toEqual(before); expect(before).toHaveLength(1);
  });

  it.each(['uid', 'binding'] as const)('cannot consume the same observation again for another %s', async field => {
    const proof = await observation(); await append(proof); const before = await raw();
    if (field === 'uid') await f.db.update(wechatUser).set({ uid: 8 }).where(eq(wechatUser.id, 7));
    else await f.db.update(wechatUser).set({ id: 10 }).where(eq(wechatUser.id, 7));
    await expect(append(proof, field === 'uid' ? 8 : 7)).rejects.toThrow('其他绑定');
    expect(await raw()).toEqual(before);
  });

  it.each(['stamp-only', 'unknown-proof', 'rotated-source'] as const)('does not fill a current account into %s input', async kind => {
    const proof = await observation(), before = await business(); let input: VerifiedSocialIdentity = identity(proof);
    if (kind === 'stamp-only') input = { openid: OPENID, userType: 'routine', routineStamp: proof.sourceStamp };
    if (kind === 'unknown-proof') input = { ...input, routineObservation: { ...proof, signature: '0'.repeat(64) } };
    if (kind === 'rotated-source') await f.db.update(systemConfig).set({ value: '"rotated-secret"' }).where(eq(systemConfig.id, 2));
    await expect(auth().reconcileVerifiedIdentity(input)).rejects.toThrow();
    expect(await business()).toEqual(before); expect(await raw()).toEqual([]);
  });

  it('independently rejects a signed wrong AppID or source stamp before writing a witness', async () => {
    const credentials = await readRoutineCredentials(container(), env);
    for (const patch of [{ appId: 'other-mini' }, { sourceStamp: 'f'.repeat(64) }]) {
      const proof = issueRoutineIdentityObservation(env, { appId: credentials.appId, openid: OPENID, sourceStamp: credentials.stamp, ...patch });
      await expect(append(proof)).rejects.toThrow('配置已变化');
    }
    expect(await raw()).toEqual([]);
  });

  it('reads an expired public proof after Secret rotation with the current configuration table unavailable', async () => {
    const proof = await observation(); await append(proof);
    await f.db.update(systemConfig).set({ value: '"new-secret"' }).where(eq(systemConfig.id, 2));
    await f.exec('ALTER TABLE public.system_config RENAME TO riw_fixture_unavailable_config');
    vi.spyOn(Date, 'now').mockReturnValue((proof.observedAt + 86400) * 1000);
    try { expect(await read()).toMatchObject({ uid: 7, bindingId: 7, observation: proof }); }
    finally { await f.exec('ALTER TABLE public.riw_fixture_unavailable_config RENAME TO system_config'); }
    expect(env.CONFIG_KV.get).not.toHaveBeenCalled();
  });

  it.each(['AppID', 'UID', 'binding', 'openid', 'deleted-binding', 'deleted-user', 'disabled-user'] as const)
    ('refuses public proof reuse for %s while preserving the original payload', async kind => {
      const proof = await observation(); await append(proof); const before = await raw(); let input = facts();
      if (kind === 'AppID') input = facts({ appId: 'other-mini' });
      if (kind === 'UID') input = facts({ uid: 8 });
      if (kind === 'binding') input = facts({ bindingId: 10 });
      if (kind === 'openid') input = facts({ openid: 'other-openid' });
      if (kind === 'deleted-binding') await f.db.update(wechatUser).set({ isDel: 1 }).where(eq(wechatUser.id, 7));
      if (kind === 'deleted-user') await f.db.update(user).set({ deleteTime: new Date() }).where(eq(user.uid, 7));
      if (kind === 'disabled-user') await f.db.update(user).set({ status: 0 }).where(eq(user.uid, 7));
      expect(await read(input)).toBeNull(); expect(await raw()).toEqual(before);
    });

  it('requires caller-owned transactions for append and read', async () => {
    const proof = await observation();
    await expect(appendRoutineIdentityWitness(f.db, env, { uid: 7, observation: proof })).rejects.toThrow();
    await expect(readRoutineIdentityWitness(f.db, env, facts())).rejects.toThrow('调用方事务');
    expect(await raw()).toEqual([]);
  });

  it.each(['REPEATABLE READ', 'READ COMMITTED, READ ONLY'] as const)('rejects append transaction mode %s', async mode => {
    const proof = await observation();
    await expect(withTx(container(), async tx => {
      await tx.execute(sql.raw('SET TRANSACTION ISOLATION LEVEL ' + mode));
      return appendRoutineIdentityWitness(tx, env, { uid: 7, observation: proof });
    })).rejects.toThrow(); expect(await raw()).toEqual([]);
  });

  it('enforces immutable UPDATE, DELETE and TRUNCATE even for the fixture owner', async () => {
    await append(await observation()); const before = await raw();
    for (const statement of [`UPDATE ${TABLE} SET signature=signature`, `DELETE FROM ${TABLE}`, `TRUNCATE ${TABLE}`])
      await expect(f.exec(statement)).rejects.toMatchObject({ code: '42501' });
    expect(await raw()).toEqual(before);
  });

  it.each(['table', 'constraint', 'index', 'missing-function', 'function', 'trigger', 'trigger-disabled'] as const)
    ('fails closed on missing/drifted %s without repairing storage', async kind => {
      const proof = await observation();
      const statements = {
        table: 'DROP TABLE public.routine_identity_witness',
        constraint: 'ALTER TABLE public.routine_identity_witness DROP CONSTRAINT riw_uid_ck',
        index: 'DROP INDEX public.riw_binding_latest',
        'missing-function': 'DROP FUNCTION public.routine_identity_witness_immutable_v1() CASCADE',
        function: "CREATE OR REPLACE FUNCTION public.routine_identity_witness_immutable_v1() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$ BEGIN RETURN OLD; END $$",
        trigger: 'DROP TRIGGER riw_immutable_truncate ON public.routine_identity_witness',
        'trigger-disabled': 'ALTER TABLE public.routine_identity_witness DISABLE TRIGGER riw_immutable_rows',
      } as const;
      await f.exec(statements[kind]); expect(await inspectRoutineIdentityWitness(f.db)).toBe(false);
      await expect(append(proof)).rejects.toThrow('未完整就绪'); await expect(read()).rejects.toThrow('未完整就绪');
      expect(await inspectRoutineIdentityWitness(f.db)).toBe(false);
      if (kind !== 'table') expect(await raw()).toEqual([]);
    });

  it.each(['observation-openid', 'observation-signature', 'observation-AppID', 'record-signature', 'record-time', 'record-uid', 'record-binding'] as const)
    ('detects maintenance-corrupted %s after restoring the exact immutable catalog', async kind => {
      await append(await observation()); let input = facts();
      if (kind === 'observation-openid') await corrupt(`UPDATE ${TABLE} SET observation=jsonb_set(observation,'{openid}','"foreign-openid"')`);
      if (kind === 'observation-signature') await corrupt(`UPDATE ${TABLE} SET observation=jsonb_set(observation,'{signature}',to_jsonb(repeat('0',64)))`);
      if (kind === 'observation-AppID') {
        await corrupt(`UPDATE ${TABLE} SET observation=jsonb_set(observation,'{appId}','"foreign-app"')`); input = facts({ appId: 'foreign-app' });
      }
      if (kind === 'record-signature') await corrupt(`UPDATE ${TABLE} SET signature=repeat('0',64)`);
      if (kind === 'record-time') await corrupt(`UPDATE ${TABLE} SET created_at=created_at+1`);
      if (kind === 'record-uid') {
        await f.db.update(wechatUser).set({ uid: 8 }).where(eq(wechatUser.id, 7));
        await corrupt(`UPDATE ${TABLE} SET uid=8`); input = facts({ uid: 8 });
      }
      if (kind === 'record-binding') {
        await f.db.update(wechatUser).set({ id: 10 }).where(eq(wechatUser.id, 7));
        await corrupt(`UPDATE ${TABLE} SET binding_id=10`); input = facts({ bindingId: 10 });
      }
      expect(await inspectRoutineIdentityWitness(f.db)).toBe(true); await expect(read(input)).rejects.toThrow();
    });

  it('applies real JSON object/capacity CHECKs and never treats a small forged SQL payload as authenticated', async () => {
    const insert = (value: unknown) => f.db.execute(sql`INSERT INTO public.routine_identity_witness
      (observation_id,uid,binding_id,format_version,observation,created_at,signature)
      VALUES(${randomUUID()}::uuid,7,7,1,${JSON.stringify(value)}::jsonb,
        floor(extract(epoch FROM clock_timestamp()))::bigint,${'0'.repeat(64)})`);
    await expect(insert([])).rejects.toMatchObject({ cause: { code: '23514', constraint_name: 'riw_observation_ck' } });
    await expect(insert({ appId: APP, padding: 'x'.repeat(8192) })).rejects.toMatchObject({ cause: { code: '23514', constraint_name: 'riw_observation_ck' } });
    expect(await raw()).toEqual([]);
    await insert({ appId: APP }); expect(await raw()).toHaveLength(1);
    await expect(read()).rejects.toThrow();
  });

  it.each([731668, 731669] as const)('uses the independent witness gate with actual peer lock %s', async gate => {
    gifts(); const proof = await observation('owned-gate-mini-openid'), before = await business();
    await withFinancePeers(f.db, async ([holder]) => {
      await holder.exec('BEGIN');
      try {
        await holder.exec(`SELECT pg_advisory_xact_lock(${gate},0)`);
        if (gate === 731669) {
          await expect(auth().reconcileVerifiedIdentity(identity(proof))).rejects.toThrow('未完整就绪');
          expect(await business()).toEqual(before); expect(await raw()).toEqual([]);
        } else {
          const uid = await auth().reconcileVerifiedIdentity(identity(proof));
          expect(uid).not.toBe(7); expect(await raw()).toMatchObject([{ uid, observation: proof }]);
        }
      } finally { await holder.exec('ROLLBACK'); }
    });
    if (gate === 731669) {
      const uid = await auth().reconcileVerifiedIdentity(identity(proof));
      expect(await raw()).toMatchObject([{ uid, observation: proof }]);
    }
  });

  it('uses a separate restricted LOGIN with only witness SELECT/INSERT, and reads old public proof without config permission', async () => {
    const base = validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL ?? '');
    const [owned] = await f.db.execute<{ database: string; schema: string }>(sql`SELECT current_database() AS database,current_schema() AS schema`);
    if (owned.schema !== 'public' || !ownsFinanceFixtureTarget(owned.database, owned.schema, base.href)) throw Error('Unowned restricted-role test target');
    const role = 'riw_fixture_' + randomUUID().replaceAll('-', ''), password = randomUUID();
    if (!/^riw_fixture_[a-f0-9]{32}$/u.test(role) || !/^finance_fixture_[a-f0-9]{32}$/u.test(owned.database)) throw Error('Unsafe owned role/database name');
    let client: ReturnType<typeof postgres> | undefined, created = false;
    const proof = await observation();
    try {
      await f.exec(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 1 PASSWORD '${password}'`);
      created = true;
      await f.exec(`GRANT CONNECT ON DATABASE "${owned.database}" TO "${role}";
        GRANT USAGE ON SCHEMA public TO "${role}";
        GRANT SELECT,INSERT ON public.routine_identity_witness TO "${role}";
        GRANT SELECT ON public.system_config,public."user",public.wechat_user TO "${role}";
        GRANT UPDATE(uid) ON public."user" TO "${role}";
        GRANT UPDATE(id) ON public.wechat_user TO "${role}"`);
      const target = new URL(base.href); target.pathname = '/' + owned.database; target.username = role; target.password = password;
      client = postgres(target.href, { max: 1, prepare: false, connect_timeout: 5,
        connection: { options: '-c search_path=public -c statement_timeout=5000 -c lock_timeout=2000' } });
      const db = drizzle(client) as unknown as DbClient;
      const [login] = await db.execute(sql`SELECT current_user AS role,session_user AS session,
        current_database() AS database,current_setting('server_version_num')::integer/10000 AS major,
        rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls AS elevated
        FROM pg_roles WHERE rolname=current_user`);
      expect(login).toEqual({ role, session: role, database: owned.database, major: 16, elevated: false });
      const [acl] = await db.execute(sql`SELECT has_table_privilege(current_user,'public.routine_identity_witness','SELECT') AS s,
        has_table_privilege(current_user,'public.routine_identity_witness','INSERT') AS i,
        has_table_privilege(current_user,'public.routine_identity_witness','UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS extra,
        has_function_privilege(current_user,'public.routine_identity_witness_immutable_v1()','EXECUTE') AS execute`);
      expect(acl).toEqual({ s: true, i: true, extra: false, execute: false });
      expect(await append(proof, 7, db)).toMatchObject({ uid: 7, bindingId: 7, observation: proof });
      for (const statement of [`UPDATE ${TABLE} SET signature=signature`, `DELETE FROM ${TABLE}`, `TRUNCATE ${TABLE}`])
        await expect(client.unsafe(statement)).rejects.toMatchObject({ code: '42501' });
      await f.exec(`REVOKE SELECT ON public.system_config FROM "${role}"`);
      await f.db.update(systemConfig).set({ value: '"rotated-secret"' }).where(eq(systemConfig.id, 2));
      const [permission] = await db.execute(sql`SELECT has_table_privilege(current_user,'public.system_config','SELECT') AS configured`);
      expect(permission.configured).toBe(false);
      expect(await read(facts(), db)).toMatchObject({ uid: 7, bindingId: 7, observation: proof });
      expect(await raw()).toHaveLength(1);
    } finally {
      try { await client?.end({ timeout: 1 }); }
      finally {
        if (created) {
          try { await f.exec(`DROP OWNED BY "${role}"`); }
          finally { await f.exec(`DROP ROLE "${role}"`); }
        }
      }
    }
  });
});
