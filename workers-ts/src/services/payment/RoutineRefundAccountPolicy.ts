import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { createContainerFromDb, withTx, type DbClient } from '@/lib/di';
import { inspectRoutineRefundCatalog, assertRoutineRefundInstalledTx, assertRoutineRefundReadInTx,
  assertRoutineRefundStatusReadTx, ROUTINE_REFUND_GATE } from '@/migrations/routineRefund';
import type { RoutinePaymentRuntimeTarget } from '@/migrations/routinePaymentRuntime';
import { ServiceUnavailableException } from '@/utils/errors';
import { routineEvidenceCanonical, routineEvidenceHmac } from './RoutineProviderObservation';
import { routinePaymentCredentialCommitment } from './RoutineApprovedPaymentAccount';

import { parseRoutineRefundAccountPolicy as parse, parseRoutineRefundAccountJournal as journal, validateRoutineRefundAccountHistory,
  type RoutineRefundScope as Scope, type RoutineRefundPurpose, type RoutineRefundAccountPolicy,
  type RoutineRefundAccountJournal } from './RoutinePurposeAccountEvidenceCodec';
export type { RoutineRefundPurpose, RoutineRefundAccountPolicy, RoutineRefundAccountJournal } from './RoutinePurposeAccountEvidenceCodec';

type Signing = Pick<Env, 'APP_KEY'>;
type Runtime = Pick<Env, 'APP_KEY' | 'ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS'>;
type Target = Pick<RoutinePaymentRuntimeTarget, 'database' | 'maintenance' | 'app' | 'admin'>;
const fail = (): never => { throw new ServiceUnavailableException('原账号退款批准或维护权限尚未完整就绪'); };
const hex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const token = (v: unknown, max = 64): v is string => typeof v === 'string' && new RegExp(`^[A-Za-z0-9_-]{1,${max}}$`, 'u').test(v);
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0 && Number(v) <= 2147483647;
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v);
const mac = (env: Signing, value: unknown) => routineEvidenceHmac(env, 'routine-refund-account-policy-v1', value);
const same = (a: unknown, b: unknown) => routineEvidenceCanonical(a) === routineEvidenceCanonical(b);
function equal(a: unknown, b: string) {
  return hex(a) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(descriptors, key))
    || Object.entries(descriptors).some(([key, d]) => !keys.includes(key) || !d.enumerable || !('value' in d))) return fail();
  return value as Record<string, unknown>;
}
async function scope(tx: DbClient): Promise<Scope> {
  const [row] = await tx.execute<Scope>(sql`SELECT pg_catalog.current_database() AS database,
    (SELECT oid::text FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS "databaseOid",
    pg_catalog.pg_get_userbyid(c.relowner) AS maintenance,c.relowner::text AS "maintenanceOid"
    FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass('public.routine_refund_account_policy')`);
  if (!row || !token(row.database, 128) || !token(row.maintenance, 128)
    || !/^[0-9]+$/u.test(row.databaseOid) || !/^[0-9]+$/u.test(row.maintenanceOid)) return fail();
  return { ...row };
}
async function history(tx: DbClient, env: Signing, accountId: string, s: Scope): Promise<RoutineRefundAccountJournal[]> {
  const rows = await tx.execute(sql`SELECT * FROM public.routine_refund_account_policy
    WHERE account_id=${accountId} ORDER BY revision LIMIT 65`);
  if (rows.length > 64 || Buffer.byteLength(JSON.stringify(rows), 'utf8') > 1048576) return fail();
  const decoded = Array.from(rows, row => journal(env, row, s));
  validateRoutineRefundAccountHistory(decoded,accountId);
  return decoded;
}
async function clock(tx: DbClient): Promise<number> {
  const [row] = await tx.execute<{ now: string }>(sql`SELECT pg_catalog.floor(extract(epoch FROM pg_catalog.clock_timestamp()))::bigint AS now`);
  if (!positive(Number(row?.now))) return fail();
  return Number(row.now);
}
function commitment(env: Runtime, data: RoutineRefundAccountPolicy) {
  const expected = routinePaymentCredentialCommitment(env, data.credentialRef, data.credentialVersion);
  if (data.appId !== expected.appId || data.merchantId !== expected.merchantId
    || !equal(data.credentialStamp, expected.credentialStamp)) return fail();
}

/** Policy metadata only. This cannot authorize a provider request, acquire a
 * CNSR claim, select merchant secrets, establish an original or settle money.
 * A future dispatch consumer must additionally prove the immutable original,
 * physical order/refund, live actor and first pinned dispatch in its own TX. */
export async function readRoutineRefundAccountPolicyTx(tx: DbClient, env: Runtime,
  accountId: string, purpose: RoutineRefundPurpose, role: import('@/migrations/routineRefundActorAddon').RoutineRefundRuntimeRole = 'app'): Promise<RoutineRefundAccountJournal> {
  env = { APP_KEY: env.APP_KEY, ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS: env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS };
  if (!token(accountId) || !['refund_request', 'refund_query', 'refund_notify'].includes(purpose)
    || !['app','financial','admin','manager'].includes(role)) return fail();
  if (!await assertRoutineRefundInstalledTx(tx, role)) return fail();
  const row = (await history(tx, env, accountId, await scope(tx))).at(-1), now = await clock(tx);
  if (!row || row.payload.data.state !== 'active' || now < row.payload.data.validFrom || now >= row.payload.data.validUntil
    || !row.payload.data.purposes.includes(purpose)) return fail();
  commitment(env, row.payload.data);
  return row;
}

/** Select one explicitly approved account for authenticated original facts.
 * Histories that ever named this pair stay in the candidate set, so editing
 * the latest pair cannot hide an invalid chain. No credential trial occurs. */
export async function selectRoutineRefundAccountPolicyTx(tx: DbClient, env: Runtime,
  pair: { appId: string; merchantId: string }, purpose: RoutineRefundPurpose,
  projection?:'write-snapshot'|'read-snapshot'): Promise<RoutineRefundAccountJournal> {
  const raw=object(pair,['appId','merchantId']);pair = { appId: raw.appId as string, merchantId: raw.merchantId as string };
  if (!token(pair.appId,32) || typeof pair.merchantId!=='string' || !/^[0-9]{1,32}$/u.test(pair.merchantId)
    || !['refund_request','refund_query','refund_notify'].includes(purpose)) return fail();
  if(projection!==undefined&&projection!=='write-snapshot'&&projection!=='read-snapshot')return fail();
  if (!await (projection==='read-snapshot'?assertRoutineRefundStatusReadTx(tx):projection==='write-snapshot'
    ?assertRoutineRefundReadInTx(tx):assertRoutineRefundInstalledTx(tx))) return fail();
  const subjects = await tx.execute<{account_id:string}>(sql`SELECT DISTINCT account_id FROM public.routine_refund_account_policy
    WHERE payload->'data'->>'appId'=${pair.appId} AND payload->'data'->>'merchantId'=${pair.merchantId}
    ORDER BY account_id LIMIT 17`);
  if (subjects.length>16) return fail();
  const s=await scope(tx), now=await clock(tx), matches:RoutineRefundAccountJournal[]=[];
  for (const subject of subjects) {
    if (!token(subject.account_id)) return fail();
    const row=(await history(tx,env,subject.account_id,s)).at(-1);
    if (!row) return fail();
    const d=row.payload.data;
    if (d.appId===pair.appId && d.merchantId===pair.merchantId && d.state==='active'
      && now>=d.validFrom && now<d.validUntil && d.purposes.includes(purpose)) matches.push(row);
  }
  if (matches.length!==1) return fail();
  commitment(env,matches[0].payload.data);
  return matches[0];
}

/** Durable historical metadata, including revoked approvals. This never
 * resolves current credentials or produces a fresh provider capability. */
export async function readRoutineRefundAccountJournalTx(tx: DbClient, env: Signing,
  recordId: string, statusRead=false): Promise<RoutineRefundAccountJournal> {
  if (!uuid(recordId)) return fail();
  if (!await (statusRead?assertRoutineRefundStatusReadTx(tx):assertRoutineRefundReadInTx(tx))) return fail();
  const [raw]=await tx.execute(sql`SELECT * FROM public.routine_refund_account_policy WHERE record_id=${recordId}::uuid`);
  const s=await scope(tx), row=journal(env,raw,s), rows=await history(tx,env,row.account_id,s);
  if (!rows.some(candidate=>same(candidate,row))) return fail();
  return row;
}

/** Explicit maintenance journal. Separate domain and purpose from payment
 * query/notify v1. No HTTP route, provisioning, config/UID/order mutation,
 * provider transport or runtime approval writer is introduced here. */
export async function appendRoutineRefundAccountPolicy(db: DbClient, env: Runtime, declared: Target,
  input: { operationId: string; expectedRevision: number; data: RoutineRefundAccountPolicy }) {
  env = { APP_KEY: env.APP_KEY, ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS: env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS };
  const r = object(input, ['operationId', 'expectedRevision', 'data']);
  const target = { database: declared.database, maintenance: declared.maintenance, app: declared.app, admin: declared.admin };
  if (!uuid(r.operationId) || !Number.isSafeInteger(r.expectedRevision) || Number(r.expectedRevision) < 0
    || Number(r.expectedRevision) >= 64 || Object.values(target).some(v => !token(v, 128))
    || new Set([target.maintenance, target.app, target.admin]).size !== 3) return fail();
  const data = parse(r.data), operationId = r.operationId, expectedRevision = Number(r.expectedRevision);
  return withTx(createContainerFromDb(db), async tx => {
    await tx.execute(sql`SELECT
      pg_catalog.set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
      pg_catalog.set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
      pg_catalog.set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
    const [identity] = await tx.execute(sql`SELECT pg_catalog.current_database()=${target.database} AND current_user=${target.maintenance}
      AND current_user=session_user AND r.rolsuper AND r.rolcanlogin AND pg_catalog.current_schema()='public'
      AND r.oid=(SELECT usesysid FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid())
      AND pg_catalog.current_setting('server_version_num')::integer/10000=16 AND pg_catalog.current_setting('transaction_isolation')='read committed'
      AND pg_catalog.current_setting('transaction_read_only')='off' AND pg_catalog.current_setting('session_replication_role')='origin'
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS ready
      FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`);
    if (identity?.ready !== true) return fail();
    const [gate] = await tx.execute(sql`SELECT pg_catalog.pg_try_advisory_xact_lock(${ROUTINE_REFUND_GATE[0]},${ROUTINE_REFUND_GATE[1]}) AS locked`);
    if (gate?.locked !== true) return fail();
    const catalog = await inspectRoutineRefundCatalog(tx, target);
    if (!catalog.ready || catalog.binding?.app !== target.app) return fail();
    const s = await scope(tx);
    if (s.database !== target.database || s.maintenance !== target.maintenance) return fail();
    const rows = await history(tx, env, data.accountId, s);
    // A UUID is global, including across different account subjects. Read a
    // receipt before registry lookup so withdrawn secrets do not erase history.
    const [rawReplay] = await tx.execute(sql`SELECT * FROM public.routine_refund_account_policy WHERE record_id=${operationId}::uuid`);
    if (rawReplay) {
      const replay = journal(env, rawReplay, s);
      if (replay.account_id !== data.accountId || replay.revision !== expectedRevision + 1
        || !rows.some(row => same(row, replay)) || !same(replay.payload.data, data)) return fail();
      return { recordId: replay.record_id, revision: replay.revision, replayed: true };
    }
    const prior = rows.at(-1), now = await clock(tx);
    if ((prior?.revision ?? 0) !== expectedRevision || prior && now < prior.created_at
      || data.state === 'active' && now >= data.validUntil) return fail();
    if (data.state === 'active') commitment(env, data);
    const body = { record_id: operationId, account_id: data.accountId, revision: expectedRevision + 1,
      payload: { format: 1 as const, purpose: 'routine_refund_account' as const, scope: s,
        previousRecordId: prior?.record_id ?? '', data }, created_at: now };
    const signature = mac(env, body);
    await tx.execute(sql`INSERT INTO public.routine_refund_account_policy(record_id,account_id,revision,payload,created_at,signature)
      VALUES(${operationId}::uuid,${data.accountId},${body.revision},${JSON.stringify(body.payload)}::text::jsonb,${now},${signature})`);
    const [saved] = await tx.execute(sql`SELECT * FROM public.routine_refund_account_policy WHERE record_id=${operationId}::uuid`);
    if (!same(journal(env, saved, s), { ...body, signature })) return fail();
    return { recordId: operationId, revision: body.revision, replayed: false };
  });
}
