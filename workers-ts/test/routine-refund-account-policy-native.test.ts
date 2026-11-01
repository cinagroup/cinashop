/** Owned native PG16, real restricted LOGINs and production HMAC maintenance
 * only. No provider requests, dispatch claims, ownership assignment or money. */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Env } from '@/env';
import { createContainerFromDb, withTx, type DbClient } from '@/lib/di';
import { appendRoutineRefundAccountPolicy, readRoutineRefundAccountPolicyTx, type RoutineRefundAccountPolicy } from '@/services/payment/RoutineRefundAccountPolicy';
import { routinePaymentCredentialCommitment } from '@/services/payment/RoutineApprovedPaymentAccount';
import { routineEvidenceHmac } from '@/services/payment/RoutineProviderObservation';
import { ROUTINE_REFUND_GATE } from '@/migrations/routineRefund';
import { routineRefundRuntimeFixture, type RoutineRefundRuntimeContext } from './helpers/routineRefundRuntimeFixture';
import { paymentQueryKeys } from './helpers/paymentQueryFixture';

type Context = RoutineRefundRuntimeContext;
type Runtime = Pick<Env, 'APP_KEY' | 'ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS'>;
function setup(c: Context) {
  const keys = paymentQueryKeys(), materials = { ref: 'old_routine_merchant', version: 1, appId: 'wx_old_refund', merchantId: '1234567890',
    serialNo: 'AABB', apiV3Key: 'a'.repeat(32), privateKey: keys.privateKey, platformPublicKey: keys.publicKey,
    platformPublicKeyId: 'OLD_REFUND_PLATFORM_KEY' };
  const registry = JSON.stringify({ format: 1, credentials: [materials] });
  const env: Runtime = { APP_KEY: 'owned-phase29-policy-authenticator', ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS: registry };
  const now = Math.floor(Date.now() / 1000), commitment = routinePaymentCredentialCommitment(env, materials.ref, materials.version);
  const data = (patch: Partial<RoutineRefundAccountPolicy> = {}): RoutineRefundAccountPolicy => ({ accountId: 'approved_old_refund_account',
    state: 'active', ...commitment, credentialRef: materials.ref, credentialVersion: 1,
    purposes: ['refund_notify', 'refund_query', 'refund_request'], validFrom: now - 60, validUntil: now + 1800, ...patch });
  const rows = () => c.f.db.execute(sql`SELECT to_jsonb(t) AS row,xmin::text AS xmin FROM public.routine_refund_account_policy t ORDER BY account_id,revision`);
  const read = (purpose: Parameters<typeof readRoutineRefundAccountPolicyTx>[3] = 'refund_query', db = c.app.db) =>
    withTx(createContainerFromDb(db), tx => readRoutineRefundAccountPolicyTx(tx, env, data().accountId, purpose));
  const append = (d = data(), expectedRevision = 0, operationId = randomUUID(), db = c.f.db) =>
    appendRoutineRefundAccountPolicy(db, env, c.target, { operationId, expectedRevision, data: d });
  const business = async () => {
    const result: Record<string, unknown> = {};
    for (const table of ['user', 'wechat_user', 'system_config', 'store_order', 'store_order_refund', 'store_order_refund_payment',
      'user_bill', 'user_recharge', 'other_order', 'routine_refund_dispatch', 'routine_refund_provider_evidence'])
      result[table] = await c.f.db.execute(sql.raw(`SELECT to_jsonb(t) AS row,xmin::text AS xmin FROM public.${table} t ORDER BY to_jsonb(t)::text`));
    return result;
  };
  return { env, registry, materials, data, rows, read, append, business };
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Routine refund account policy native maintenance', () => {
  it('records an independent purpose-bound approval, reads public metadata and preserves the first receipt/xmin', async () =>
    routineRefundRuntimeFixture(async c => {
      const s = setup(c), before = await s.business(), operation = randomUUID(), d = s.data();
      expect(await s.append(d, 0, operation)).toEqual({ recordId: operation, revision: 1, replayed: false });
      const first = await s.rows();
      for (const purpose of d.purposes) {
        const row = await s.read(purpose);
        expect(row).toMatchObject({ record_id: operation, account_id: d.accountId, revision: 1,
          payload: { format: 1, purpose: 'routine_refund_account', previousRecordId: '', data: d,
            scope: { database: c.target.database, maintenance: c.target.maintenance } } });
        expect(Object.isFrozen(row)).toBe(true); expect(Object.isFrozen(row.payload.data.purposes)).toBe(true);
        const json = JSON.stringify(row);
        for (const secret of [s.materials.privateKey, s.materials.platformPublicKey, s.materials.apiV3Key, s.env.APP_KEY])
          expect(json).not.toContain(secret);
      }
      expect(await s.append(d, 0, operation)).toEqual({ recordId: operation, revision: 1, replayed: true });
      expect(await s.rows()).toEqual(first); expect(await s.business()).toEqual(before);
    }), 180000);

  it('uses exact material bytes and never falls back when credentials are missing, replaced or the latest approval is revoked', async () =>
    routineRefundRuntimeFixture(async c => {
      const s = setup(c), d = s.data(), operation = randomUUID();
      for (const patch of [{ credentialStamp: '0'.repeat(64) }, { appId: 'wx_current_other' }, { merchantId: '9876543210' },
        { credentialRef: 'unprovisioned' }, { credentialVersion: 2 }])
        await expect(s.append(s.data(patch))).rejects.toMatchObject({ code: 503 });
      expect(await s.rows()).toEqual([]);
      await s.append(d, 0, operation); const first = await s.rows(), before = await s.business();
      for (const registry of [undefined, JSON.stringify({ format: 1, credentials: [] }),
        JSON.stringify({ format: 1, credentials: [{ ...s.materials, serialNo: 'CCDD' }] })]) {
        s.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS = registry;
        await expect(s.read()).rejects.toMatchObject({ code: 503 });
      }
      // Loss of secrets cannot erase a durable receipt or prevent revocation.
      s.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS = undefined;
      expect(await s.append(d, 0, operation)).toEqual({ recordId: operation, revision: 1, replayed: true });
      expect(await s.rows()).toEqual(first);
      await s.append(s.data({ state: 'revoked' }), 1);
      s.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS = s.registry;
      for (const purpose of d.purposes) await expect(s.read(purpose)).rejects.toMatchObject({ code: 503 });
      expect(await s.business()).toEqual(before);
    }), 180000);

  it('enforces CAS, globally unique UUID intent and latest time/purpose restrictions without rewriting history', async () =>
    routineRefundRuntimeFixture(async c => {
      const s = setup(c), operation = randomUUID(), d = s.data(); await s.append(d, 0, operation);
      const first = await s.rows();
      for (const [data, revision, id] of [[s.data({ merchantId: '999' }), 0, operation],
        [s.data({ accountId: 'other_subject' }), 0, operation], [d, 1, operation], [d, 0, randomUUID()]] as const)
        await expect(s.append(data, revision, id)).rejects.toMatchObject({ code: 503 });
      expect(await s.rows()).toEqual(first);
      await s.append(s.data({ purposes: ['refund_query'] }), 1);
      expect((await s.read()).revision).toBe(2);
      await expect(s.read('refund_request')).rejects.toMatchObject({ code: 503 });
      await expect(s.read('refund_notify')).rejects.toMatchObject({ code: 503 });
      const now = Math.floor(Date.now() / 1000);
      await s.append(s.data({ validFrom: now + 600, validUntil: now + 1200 }), 2);
      await expect(s.read()).rejects.toMatchObject({ code: 503 });
      await expect(s.append(s.data({ validFrom: now - 1200, validUntil: now - 600 }), 3)).rejects.toMatchObject({ code: 503 });
      expect((await s.rows())[0]).toEqual(first[0]);
    }), 180000);

  it('refuses runtime writers, maintenance/admin readers and SET ROLE impersonation on real independent connections', async () =>
    routineRefundRuntimeFixture(async c => {
      const s = setup(c), before = await s.business();
      for (const db of [c.app.db, c.admin.db]) await expect(s.append(s.data(), 0, randomUUID(), db)).rejects.toMatchObject({ code: 503 });
      await s.append(); const first = await s.rows();
      for (const db of [c.f.db, c.admin.db]) await expect(s.read('refund_query', db)).rejects.toMatchObject({ code: 503 });
      await expect(withTx(createContainerFromDb(c.app.db), tx => readRoutineRefundAccountPolicyTx(tx, s.env,
        s.data().accountId, 'refund_query', 'financial'))).rejects.toMatchObject({ code: 503 });
      await expect(withTx(createContainerFromDb(c.f.db), async tx => {
        await tx.execute(sql.raw(`SET LOCAL ROLE "${c.app.role}"`));
        await readRoutineRefundAccountPolicyTx(tx, s.env, s.data().accountId, 'refund_query');
      })).rejects.toMatchObject({ code: 503 });
      expect(await s.rows()).toEqual(first); expect(await s.business()).toEqual(before);
    }), 180000);

  it('captures maintenance DTO, target and credential strings before a real asynchronous BEGIN', async () =>
    routineRefundRuntimeFixture(async c => {
      const s = setup(c), d = s.data(), original = structuredClone(d), target = { ...c.target };
      const operationId = randomUUID(), input = { operationId, expectedRevision: 0, data: d }; let mutated = false;
      const delayed = new Proxy(c.f.db, { get(db, key, receiver) {
        const method: unknown = Reflect.get(db, key, receiver);
        if (typeof method !== 'function') return method;
        if (key !== 'transaction') return method.bind(db);
        return (...args: unknown[]) => Reflect.apply(method, db, [async (tx: DbClient) => {
          await Promise.resolve(); mutated = true; d.purposes.splice(0); d.appId = 'wx_changed';
          target.app = c.admin.role; input.expectedRevision = 63; s.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS = undefined;
          return (args[0] as (tx: DbClient) => Promise<unknown>)(tx);
        }, ...args.slice(1)]);
      } });
      expect(await appendRoutineRefundAccountPolicy(delayed, s.env, target, input)).toEqual({ recordId: operationId, revision: 1, replayed: false });
      expect(mutated).toBe(true); expect((await s.rows())[0]).toMatchObject({ row: { payload: { data: original } } });
      s.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS = s.registry;
      expect((await s.read()).payload.data).toEqual(original);
    }), 180000);

  it('retains only committed policy under independent maintenance contention and caller rollback', async () =>
    routineRefundRuntimeFixture(async c => {
      const s = setup(c), before = await s.rows();
      if (!c.f.withPeer) throw Error('Independent native maintenance peer required');
      await c.f.withPeer(peer => withTx(createContainerFromDb(peer.db), async tx => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${ROUTINE_REFUND_GATE[0]},${ROUTINE_REFUND_GATE[1]})`);
        await expect(s.append()).rejects.toMatchObject({ code: 503 });
      }));
      expect(await s.rows()).toEqual(before); await s.append();
      const first = await s.rows(), abort = Error('Owned refund policy caller rollback');
      // The public maintenance API owns its TX; the read API uses exactly its
      // caller TX and cannot turn a subsequent abort into a dispatch or effect.
      await expect(withTx(createContainerFromDb(c.app.db), async tx => {
        await readRoutineRefundAccountPolicyTx(tx, s.env, s.data().accountId, 'refund_query'); throw abort;
      })).rejects.toBe(abort);
      expect(await s.rows()).toEqual(first);
    }), 180000);

  it('refuses a structurally valid row signed in the payment-policy domain instead of treating storage as refund approval', async () =>
    routineRefundRuntimeFixture(async c => {
      const s = setup(c), before = await s.business();
      const [scope] = await c.f.db.execute<{ database: string; databaseOid: string; maintenance: string; maintenanceOid: string }>(sql`
        SELECT current_database() AS database,(SELECT oid::text FROM pg_catalog.pg_database WHERE datname=current_database()) AS "databaseOid",
          current_user AS maintenance,(SELECT oid::text FROM pg_catalog.pg_roles WHERE rolname=current_user) AS "maintenanceOid"`);
      const body = { record_id: randomUUID(), account_id: s.data().accountId, revision: 1,
        payload: { format: 1, purpose: 'routine_refund_account', scope, previousRecordId: '', data: s.data() },
        created_at: Math.floor(Date.now() / 1000) };
      await c.f.db.execute(sql`INSERT INTO public.routine_refund_account_policy(record_id,account_id,revision,payload,created_at,signature)
        VALUES(${body.record_id}::uuid,${body.account_id},1,${JSON.stringify(body.payload)}::text::jsonb,${body.created_at},
          ${routineEvidenceHmac(s.env, 'approved-account-policy', body)})`);
      await expect(s.read()).rejects.toMatchObject({ code: 503 });
      await expect(s.append(s.data(), 1)).rejects.toMatchObject({ code: 503 });
      expect(await s.business()).toEqual(before);
    }), 180000);
});
