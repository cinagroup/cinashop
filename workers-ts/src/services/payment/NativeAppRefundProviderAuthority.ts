import { sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { createContainerFromDb, createDbFromConnectionString, withTx, type Container, type DbClient } from '@/lib/di';
import { ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { assertNativeAppRefundAccountInTx, refundBundlePresent } from './NativeAppPaymentAuthority';
import { amountToCents, type RefundProviderRequest } from './RefundGateway';

type Mode = 'request' | 'query';
type Row = Record<string, unknown>;
type Snapshot = { payment: string; refund: string; child: string; root: string;
  payment_xmin: string; refund_xmin: string; child_xmin: string; root_xmin: string;
  refund_price: string; total_price: string };
type Identity = { database: string; database_oid: string; pid: number; role: string; session: string };
const unavailable = () => new ServiceUnavailableException('原生App退款提供方额外校验尚未完整就绪');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const positiveId = (n: unknown) => Number.isSafeInteger(n) && Number(n) > 0 && Number(n) <= 2147483647;
const integer = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0;

function detach(value: RefundProviderRequest): Readonly<RefundProviderRequest> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['outTradeNo','transactionId','outRefundNo','refundAmount','totalAmount','reason'].includes(key))) throw unavailable();
  const request = Object.freeze({ outTradeNo: value.outTradeNo, outRefundNo: value.outRefundNo,
    transactionId: value.transactionId, refundAmount: value.refundAmount, totalAmount: value.totalAmount, reason: value.reason });
  if (typeof request.outTradeNo !== 'string' || !request.outTradeNo || typeof request.outRefundNo !== 'string' || !request.outRefundNo
    || request.transactionId !== undefined && typeof request.transactionId !== 'string'
    || request.reason !== undefined && typeof request.reason !== 'string'
    || !Number.isSafeInteger(request.refundAmount) || !Number.isSafeInteger(request.totalAmount)
    || request.refundAmount <= 0 || request.totalAmount <= 0 || request.refundAmount > request.totalAmount) throw unavailable();
  return request;
}
function row(text: string): Row {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable();
  return value as Row;
}
async function snapshot(tx: DbClient, request: Readonly<RefundProviderRequest>): Promise<Snapshot> {
  // One statement gives one fresh committed view of all four rows. Preserve
  // full JSON text and xmin so a value ABA cannot disguise an intervening write.
  const rows = await tx.execute<Snapshot>(sql`SELECT
    to_jsonb(p)::text AS payment,to_jsonb(r)::text AS refund,to_jsonb(c)::text AS child,to_jsonb(o)::text AS root,
    p.xmin::text AS payment_xmin,r.xmin::text AS refund_xmin,c.xmin::text AS child_xmin,o.xmin::text AS root_xmin,
    r.refund_price::text AS refund_price,o.pay_price::text AS total_price
    FROM public.store_order_refund_payment p
    JOIN public.store_order_refund r ON r.id=p.refund_id
    JOIN public.store_order c ON c.id=r.store_order_id
    JOIN public.store_order o ON o.id=CASE WHEN c.pid>0 THEN c.pid ELSE c.id END
    WHERE p.out_refund_no=${request.outRefundNo} LIMIT 2`);
  if (rows.length !== 1 || Object.values(rows[0]).some(value => typeof value !== 'string')
    || !['payment_xmin','refund_xmin','child_xmin','root_xmin'].every(key => /^\d+$/u.test(rows[0][key as keyof Snapshot]))) throw unavailable();
  return rows[0];
}
async function validate(tx: DbClient, request: Readonly<RefundProviderRequest>, mode: Mode, s: Snapshot) {
  const p = row(s.payment), r = row(s.refund), c = row(s.child), o = row(s.root);
  const [clock] = await tx.execute<{ now: number | string }>(sql`SELECT floor(extract(epoch FROM clock_timestamp()))::bigint AS now`);
  const now = Number(clock?.now);
  const allocated = o.pid === -1 && o.supplier_id === 0 && o.supplier_allocation_status === 2;
  const rootRelation = (c.pid === 0 || c.pid === -1) && o.id === c.id
    || positiveId(c.pid) && o.id === c.pid && o.pid === -1;
  const expectedTransaction = typeof o.trade_no === 'string' && o.trade_no && o.trade_no !== o.order_id ? o.trade_no : undefined;
  if (!Number.isSafeInteger(now) || now <= 0 || !positiveId(p.id) || !positiveId(r.id) || !positiveId(c.id) || !positiveId(o.id)
    || p.provider !== 'wechat' || p.refund_id !== r.id || p.store_order_id !== c.id || r.store_order_id !== c.id
    || p.out_refund_no !== 'CNSR' + r.id || p.out_refund_no !== request.outRefundNo
    || r.uid !== c.uid || r.store_id !== c.store_id || r.supplier_id !== c.supplier_id
    || !rootRelation || c.uid !== o.uid || c.pay_type !== 'weixin' || o.pay_type !== 'weixin' || c.paid !== 1 || o.paid !== 1
    || c.store_id !== o.store_id && !allocated || c.supplier_id !== o.supplier_id && !allocated
    || r.is_cancel !== 0 || r.is_del !== 0 || ![0,1,2,4,5,6].includes(Number(r.refund_type))
    || p.request_amount !== request.refundAmount || p.total_amount !== request.totalAmount
    || amountToCents(s.refund_price) !== request.refundAmount || amountToCents(s.total_price) !== request.totalAmount
    || o.order_id !== request.outTradeNo || expectedTransaction !== request.transactionId
    || (r.refund_reason || '订单售后退款') !== request.reason
    || !integer(p.attempt_count) || Number(p.attempt_count) < 1 || !integer(p.request_time)
    || Number(p.request_time) <= 0 || Number(p.request_time) > now || !integer(p.query_time) || Number(p.query_time) > now) throw unavailable();
  if (mode === 'request') {
    // This is a currently committed claim, not proof this invocation owns it.
    // The existing CNSR idempotency and actor/scope receipts remain authoritative.
    if (p.provider_status !== 'REQUESTING' || now - Number(p.request_time) >= 120) throw unavailable();
  } else if (!['REQUESTING','PROCESSING','UNKNOWN'].includes(String(p.provider_status))
    || p.provider_status === 'REQUESTING' && now - Number(p.request_time) < 120
    || Number(p.query_time) <= 0) throw unavailable();
}
async function identity(tx: DbClient): Promise<Identity> {
  const [id] = await tx.execute<Identity>(sql`SELECT pg_catalog.current_database() AS database,
    (SELECT oid::text FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS database_oid,
    pg_catalog.pg_backend_pid() AS pid,current_user AS role,session_user AS session`);
  if (!id || typeof id.database !== 'string' || !id.database || !/^\d+$/u.test(id.database_oid)
    || !positiveId(id.pid) || typeof id.role !== 'string' || id.role !== id.session) throw unavailable();
  return id;
}

/** An extra original-account restriction on existing committed refund paths.
 * It does not grant an actor, authorize a new refund, prove an exclusive claim,
 * or replace the business Container. All existing scope/receipt checks remain.
 * No transaction or connection from this function reaches provider network I/O. */
export async function assertNativeAppRefundProviderRequest(container: Container, env: Env,
  value: RefundProviderRequest, mode: Mode, merchantId: string): Promise<void> {
  const request = detach(value), binding = env.HYPERDRIVE?.connectionString;
  if (!['request','query'].includes(mode) || !Object.hasOwn(container.db, '$client')) throw unavailable();
  let verifier: DbClient | undefined;
  try {
    await withTx(container, async business => {
      await business.execute(sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED,READ ONLY`);
      await business.execute(sql`SELECT set_config('search_path','public,pg_temp',true),set_config('statement_timeout','8s',true),set_config('lock_timeout','2s',true),set_config('idle_in_transaction_session_timeout','8s',true)`);
      const [maintenance] = await business.execute<{ locked: boolean }>(sql`SELECT pg_try_advisory_xact_lock_shared(731663,0) AS locked`);
      if (maintenance?.locked !== true) throw unavailable();
      // Legacy absence is checked on the original business connection. Do not
      // open an App connection, demand App credentials or invent an original.
      if (!await refundBundlePresent(business)) return;
      if (typeof binding !== 'string' || !binding.trim() || !/^\d{1,32}$/u.test(merchantId)) throw unavailable();
      const before = await snapshot(business, request);
      await validate(business, request, mode, before);
      const originalIdentity = await identity(business);
      const [first, second] = crypto.getRandomValues(new Int32Array(2));
      const [challenge] = await business.execute<{ locked: boolean }>(sql`SELECT pg_try_advisory_xact_lock(${first}::integer,${second}::integer) AS locked`);
      if (challenge?.locked !== true) throw unavailable();
      verifier = createDbFromConnectionString(binding, 1, { searchPath: 'public,pg_temp', applicationName: 'cinashop_app_refund_verify' });
      await withTx(createContainerFromDb(verifier), async app => {
        await app.execute(sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED,READ ONLY`);
        await app.execute(sql`SELECT set_config('search_path','public,pg_temp',true),set_config('statement_timeout','5s',true),set_config('lock_timeout','2s',true),set_config('idle_in_transaction_session_timeout','5s',true)`);
        const appIdentity = await identity(app);
        if (appIdentity.database !== originalIdentity.database || appIdentity.database_oid !== originalIdentity.database_oid
          || appIdentity.pid === originalIdentity.pid) throw unavailable();
        // A same-named database or copied row/catalog cannot answer this live,
        // unpredictable challenge. Advisory locks are scoped to the database.
        const [probe] = await app.execute<{ acquired: boolean }>(sql`SELECT pg_try_advisory_xact_lock_shared(${first}::integer,${second}::integer) AS acquired`);
        if (probe?.acquired !== false) throw unavailable();
        const [held] = await app.execute<{ present: boolean }>(sql`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_locks
          WHERE locktype='advisory' AND database::text=${originalIdentity.database_oid} AND pid=${originalIdentity.pid}
            AND classid::text=${String(first >>> 0)} AND objid::text=${String(second >>> 0)} AND objsubid=2
            AND mode='ExclusiveLock' AND granted) AS present`);
        if (held?.present !== true) throw unavailable();
        await assertNativeAppRefundAccountInTx(app, env, { orderNo: request.outTradeNo, merchantId,
          totalAmount: request.totalAmount, ...(request.transactionId ? { transactionId: request.transactionId } : {}) });
        if (!same(await identity(app), appIdentity)) throw unavailable();
      });
      if (!same(await identity(business), originalIdentity)) throw unavailable();
      const after = await snapshot(business, request);
      if (!same(before, after)) throw unavailable();
      await validate(business, request, mode, after);
      const [deadline] = await business.execute<{ valid: boolean }>(sql`SELECT clock_timestamp()<=transaction_timestamp()+interval '8 seconds' AS valid`);
      if (deadline?.valid !== true) throw unavailable();
    });
  } catch (error) {
    if (error instanceof ServiceUnavailableException || error instanceof ValidateException) throw error;
    // Do not expose connection strings, role/database names or raw SQL causes.
    throw unavailable();
  } finally {
    if (verifier) {
      try { await verifier.$client.end({ timeout: 5 }); } catch { throw unavailable(); }
    }
  }
}
