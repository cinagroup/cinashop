import { Buffer } from 'node:buffer';
import { sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { createContainerFromDb, createDbFromConnectionString, withTx, type DbClient } from '@/lib/di';
import { assertRoutineShippingReadTx, inspectRoutineShippingCatalog } from '@/migrations/routineShipping';
import { ServiceUnavailableException } from '@/utils/errors';
import { assertNativeAppAbsentForRoutineRefundInTx, refundBundlePresent } from './NativeAppPaymentAuthority';
import { parseRoutineOriginalEvidence, type RoutineOriginalEvidence } from './RoutineOriginalPaymentEvidence';
import { readRoutineApprovedUsesForShippingTx } from './RoutineApprovedPaymentAccount';
import { assertRoutineShippingOriginalTx, type RoutineShippingOriginal } from './RoutineShippingOriginal';
import { amountToCents } from './RefundGateway';
import { shippingMac, shippingSame } from './RoutineShippingAccount';

type Signing = Pick<Env, 'APP_KEY'>;
type Domain = 'store_order' | 'recharge' | 'membership';
type Source = { domain: Domain; id: number; uid: number; orderNo: string; transactionId: string; amount: number };
type Snapshot = { id: number; uid: number; order_no: string; price: string; paid: number; pay_type: string;
  trade_no: string; shape: boolean; xmin: string; ctid: string };
type Identity = { database: string; database_oid: string; pid: number; role: string; session: string; role_oid: string; ready: boolean };
const unavailable = () => new ServiceUnavailableException('原生App与小程序原账号发货付款身份额外校验尚未完整就绪');
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0 && Number(v) <= 2147483647;

function source(original: RoutineOriginalEvidence): Readonly<Source> {
  const b = original.payload.binding, f = original.payload.observation.facts;
  if (b.state !== 'bound' || !positive(b.local.orderId) || !positive(b.local.buyerUid) || !positive(b.local.amountCents)
    || b.local.orderNo !== f.orderNo || b.local.amountCents !== f.amountCents
    || b.local.tradeNo !== '' && b.local.tradeNo !== f.transactionId || b.local.paid === 1 && b.local.payType !== 'weixin'
    || f.currency !== 'CNY' || f.tradeState !== 'SUCCESS' || f.tradeType !== 'JSAPI' || !f.payerId) throw unavailable();
  return Object.freeze({ domain: b.local.domain, id: b.local.orderId, uid: b.local.buyerUid,
    orderNo: f.orderNo, transactionId: f.transactionId, amount: f.amountCents });
}

async function snapshot(tx: DbClient, s: Readonly<Source>): Promise<Snapshot> {
  // Identifiers come only from the closed original domain. The caller has
  // already locked this physical source in its business/root/child order; do
  // not acquire another row lock after entering the payment boundary.
  const table = s.domain === 'store_order' ? 'public.store_order' : s.domain === 'recharge' ? 'public.user_recharge' : 'public.other_order';
  const price = s.domain === 'recharge' ? 'price' : 'pay_price', payType = s.domain === 'recharge' ? 'recharge_type' : 'pay_type';
  const shape = s.domain === 'store_order' ? 'pid IN (0,-1)' : s.domain === 'membership' ? 'type IN (0,1)' : 'true';
  const [resolution] = await tx.execute<{ ready: boolean }>(sql`SELECT
    pg_catalog.to_regclass(${table.slice('public.'.length)})=pg_catalog.to_regclass(${table}) AS ready`);
  if (resolution?.ready !== true) throw unavailable();
  const rows = await tx.execute<Snapshot>(sql`SELECT id,uid,order_id AS order_no,${sql.raw(price)}::text AS price,paid,
    ${sql.raw(payType)} AS pay_type,trade_no,${sql.raw(shape)} AS shape,xmin::text AS xmin,ctid::text AS ctid
    FROM ${sql.raw(table)} WHERE id=${s.id} LIMIT 2`);
  const r = rows[0];
  if (rows.length !== 1 || !r || r.id !== s.id || r.uid !== s.uid || r.order_no !== s.orderNo || r.paid !== 1
    || r.pay_type !== 'weixin' || r.trade_no !== s.transactionId || amountToCents(r.price) !== s.amount || r.shape !== true
    || typeof r.xmin !== 'string' || !/^[0-9]+$/u.test(r.xmin) || typeof r.ctid !== 'string' || !/^\([0-9]+,[0-9]+\)$/u.test(r.ctid))
    throw unavailable();
  return r;
}

async function identity(tx: DbClient, app: string, appOid: string, readOnly: boolean): Promise<Identity> {
  const [id] = await tx.execute<Identity>(sql`SELECT pg_catalog.current_database() AS database,
    (SELECT oid::text FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS database_oid,
    pg_catalog.pg_backend_pid() AS pid,current_user AS role,session_user AS session,r.oid::text AS role_oid,
    current_user=${app} AND session_user=${app} AND r.oid=${appOid}::oid AND r.rolcanlogin
    AND r.oid=(SELECT usesysid FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid())
    AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=r.oid AND deptype='o')
    AND pg_catalog.current_setting('server_version_num')::integer/10000=16
    AND pg_catalog.current_setting('transaction_isolation')='read committed'
    AND pg_catalog.current_setting('transaction_read_only')=${readOnly ? 'on' : 'off'}
    AND pg_catalog.current_setting('session_replication_role')='origin' AND pg_catalog.current_schema()='public'
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS ready
    FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`);
  if (!id || id.ready !== true || !positive(id.pid) || typeof id.database !== 'string' || !id.database
    || typeof id.database_oid !== 'string' || !/^[0-9]+$/u.test(id.database_oid)
    || id.role !== app || id.session !== app || id.role_oid !== appOid) throw unavailable();
  return id;
}

async function assertCurrentOriginalSet(tx: DbClient, env: Signing, s: Readonly<Source>, proof: RoutineShippingOriginal): Promise<void> {
  // The branded read may precede the try-only transaction boundary. Recheck
  // after acquisition so another order cannot have appended a conflicting
  // transaction fact or provenance in that interval and leave a stale proof.
  const rows = await tx.execute(sql`SELECT * FROM public.routine_original_payment_evidence
    WHERE order_no=${s.orderNo} OR transaction_id=${s.transactionId} ORDER BY evidence_id LIMIT 65`);
  if (!rows.length || rows.length > 64 || Buffer.byteLength(JSON.stringify(rows), 'utf8') > 1048576) throw unavailable();
  const originals = Array.from(rows, r => parseRoutineOriginalEvidence(env, r));
  if (shippingMac(env, 'related-originals', originals) !== proof.relatedDigest
    || !originals.some(row => shippingSame(row, proof.evidence))) throw unavailable();
  const uses = await readRoutineApprovedUsesForShippingTx(tx, env, originals);
  if (uses.digest !== proof.approvedUseDigest) throw unavailable();
}

/** NativeApp counter-proof for an authenticated Routine JSAPI original. This
 * keeps the original App business transaction and its physical locks. It grants
 * no shipping approval, token, dispatch or provider authority. Independent I/O
 * is only a local App PostgreSQL verifier; no refund row/profile is required. */
export async function assertNativeAppExcludedForRoutineShippingTx(business: DbClient, env: Env,
  proof: RoutineShippingOriginal): Promise<void> {
  // Deployment selection and original signature are detached before any await.
  const signing = { APP_KEY: env.APP_KEY }, binding = env.HYPERDRIVE?.connectionString;
  let verifier: DbClient | undefined;
  try {
    if (Object.hasOwn(business, '$client')) throw unavailable();
    const original = assertRoutineShippingOriginalTx(business, proof), parsed = parseRoutineOriginalEvidence(signing, original.evidence), s = source(parsed);
    if (!await assertRoutineShippingReadTx(business)) throw unavailable();
    const catalog = await inspectRoutineShippingCatalog(business), b = catalog.binding;
    if (!catalog.ready || !b?.app || !b.appOid) throw unavailable();
    const appName = b.app, appOid = b.appOid;
    const initialIdentity = await identity(business, appName, appOid, false);
    for (const key of [`store-order-payment-evidence:v1:${s.orderNo}`, `wechat:${s.transactionId}`]) {
      const [boundary] = await business.execute<{ locked: boolean }>(sql`SELECT
        pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(${key},0)) AS locked`);
      if (boundary?.locked !== true) throw unavailable();
    }
    const [maintenance] = await business.execute<{ locked: boolean }>(sql`SELECT pg_catalog.pg_try_advisory_xact_lock_shared(731663,0) AS locked`);
    if (maintenance?.locked !== true) throw unavailable();
    const before = await snapshot(business, s);
    await assertCurrentOriginalSet(business, signing, s, original);
    if (await refundBundlePresent(business)) {
      if (typeof binding !== 'string' || !binding.trim()) throw unavailable();
      const [first, second] = crypto.getRandomValues(new Int32Array(2));
      const [challenge] = await business.execute<{ locked: boolean }>(sql`SELECT
        pg_catalog.pg_try_advisory_xact_lock(${first}::integer,${second}::integer) AS locked`);
      if (challenge?.locked !== true) throw unavailable();
      verifier = createDbFromConnectionString(binding, 1, { searchPath: 'public,pg_temp', applicationName: 'cinashop_routine_shipping_verify' });
      await withTx(createContainerFromDb(verifier), async app => {
        await app.execute(sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED,READ ONLY`);
        await app.execute(sql`SELECT
          pg_catalog.set_config('statement_timeout','5s',true),pg_catalog.set_config('lock_timeout','1s',true),
          pg_catalog.set_config('idle_in_transaction_session_timeout','5s',true)`);
        const appIdentity = await identity(app, appName, appOid, true);
        if (appIdentity.database !== initialIdentity.database || appIdentity.database_oid !== initialIdentity.database_oid
          || appIdentity.pid === initialIdentity.pid) throw unavailable();
        const [probe] = await app.execute<{ acquired: boolean }>(sql`SELECT
          pg_catalog.pg_try_advisory_xact_lock_shared(${first}::integer,${second}::integer) AS acquired`);
        if (probe?.acquired !== false) throw unavailable();
        const [held] = await app.execute<{ present: boolean }>(sql`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_locks
          WHERE locktype='advisory' AND database::text=${initialIdentity.database_oid} AND pid=${initialIdentity.pid}
            AND classid::text=${String(first >>> 0)} AND objid::text=${String(second >>> 0)} AND objsubid=2
            AND mode='ExclusiveLock' AND granted) AS present`);
        if (held?.present !== true) throw unavailable();
        // Existing purpose-specific NativeApp absence code validates the
        // complete namespace, original/success ledger and actual App profile.
        // It deliberately does not retake this business-owned order boundary.
        await assertNativeAppAbsentForRoutineRefundInTx(app, signing,
          { orderNo: s.orderNo, transactionId: s.transactionId, totalAmount: s.amount });
        if (!shippingSame(await identity(app, appName, appOid, true), appIdentity)) throw unavailable();
      });
    }
    if (!shippingSame(await identity(business, appName, appOid, false), initialIdentity)
      || !shippingSame(await snapshot(business, s), before)) throw unavailable();
    const [deadline] = await business.execute<{ valid: boolean }>(sql`SELECT
      pg_catalog.clock_timestamp()<=pg_catalog.transaction_timestamp()+interval '8 seconds' AS valid`);
    if (deadline?.valid !== true) throw unavailable();
  } catch { throw unavailable(); }
  finally {
    if (verifier) { try { await verifier.$client.end({ timeout: 5 }); } catch { throw unavailable(); } }
  }
}
