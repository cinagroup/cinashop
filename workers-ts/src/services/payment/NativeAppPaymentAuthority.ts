import { createHmac } from 'node:crypto';
import { and, desc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { paymentReconciliationCase, systemConfig } from '@/models/schema';
import { assertNativeAppPaymentAuthorityReady } from '@/migrations/nativeAppPaymentAuthority';
import { inspectAdminWechatAppOperation } from '@/migrations/adminWechatAppOperation';
import { normalizeConfigScalar } from '@/utils/config';
import { ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { parseWechatAppStoredText, wechatAppRequestId, wechatAppRevision, wechatAppStoredValue } from '../../../../view/common/wechatApp';
import { lockStoreOrderPaymentBoundary } from './StoreOrderPaymentBoundary';
import type { VerifiedPaymentCallback } from './PaymentCallbackPersistence';
import type { PaymentProviderQueryRequest, PaymentProviderQueryResult } from './PaymentProviderQuery';

type RuntimeEnv = Pick<Env, 'APP_KEY'>;
type Pair = { appId: string; merchantId: string };
type AccountRow = { account_id: string; app_id: string; mch_id: string; operation_id: string; actor_id: number;
  source_revision: string; format_version: number; created_at: number | string; signature: string };
type EvidenceKind = 'initiation' | 'callback' | 'signed_query';
type EvidenceRow = { evidence_id: string; order_no: string; kind: EvidenceKind; format_version: number;
  payload: Record<string, unknown>; created_at: number | string; signature: string };
type Initiation = Pair & { profile: 'app'; orderNo: string; amountCents: number; orderDomain: string; currency: 'CNY'; configStamp: string };
type ProviderFacts = Pair & { orderNo: string; amountCents: number; currency: 'CNY'; transactionId: string;
  tradeState: string; providerEventTime: number; tradeType: 'APP' };
const canonical = (value: unknown) => JSON.stringify(value, (_key, row) => row && typeof row === 'object' && !Array.isArray(row)
  ? Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])) : row);
const unavailable = () => new ServiceUnavailableException('原生App支付账号或身份见证未完整就绪');
const merchant = (value: unknown): value is string => typeof value === 'string' && /^\d{1,32}$/u.test(value);
const app = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,32}$/u.test(value);
const order = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{2,64}$/u.test(value);
const cents = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 2147483647;
const fields = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).sort().join(',') === [...keys].sort().join(',');
function hash(env: RuntimeEnv, domain: string, value: unknown) {
  if (!env.APP_KEY) throw unavailable();
  return createHmac('sha256', env.APP_KEY).update('cinashop.native-app-payment.' + domain + '.v1\0').update(canonical(value)).digest('hex');
}
function whole<Row extends { created_at: number | string }>(row: Row) { return { ...row, created_at: Number(row.created_at) }; }
async function clock(tx: DbClient) {
  const [row] = await tx.execute<{ now: number }>(sql`SELECT floor(extract(epoch FROM clock_timestamp()))::bigint AS now`);
  const now = Number(row?.now); if (!Number.isSafeInteger(now) || now <= 0) throw unavailable(); return now;
}
async function state(tx: DbClient, env: RuntimeEnv) {
  const rows = await tx.select({ ...getTableColumns(systemConfig), version: sql<string>`xmin::text` }).from(systemConfig)
    .where(and(eq(systemConfig.isStore, 0), inArray(systemConfig.menuName, ['wechat_app_appid', 'pay_weixin_mchid'])))
    .orderBy(desc(systemConfig.sort), desc(systemConfig.id)).limit(65);
  if (rows.length > 64 || new TextEncoder().encode(JSON.stringify(rows)).byteLength > 1024 * 1024) throw unavailable();
  const appId = parseWechatAppStoredText(rows.find(row => row.menuName === 'wechat_app_appid')?.value) ?? '';
  const configuredMerchant = normalizeConfigScalar(rows.find(row => row.menuName === 'pay_weixin_mchid')?.value);
  return { appId, merchantId: merchant(configuredMerchant) ? configuredMerchant : '', rows,
    stamp: hash(env, 'current-public-source', rows) };
}
async function accounts(tx: DbClient, env: RuntimeEnv): Promise<Array<Pair & { row: AccountRow }>> {
  const rows = await tx.execute<AccountRow>(sql`SELECT account_id,app_id,mch_id,operation_id,actor_id,source_revision,format_version,created_at,signature
    FROM public.native_app_payment_account ORDER BY account_id LIMIT 65`);
  if (rows.length > 64 || new TextEncoder().encode(JSON.stringify(rows)).byteLength > 1024 * 1024) throw unavailable();
  return rows.map(raw => {
    const row = whole(raw), { signature, ...facts } = row;
    let appId: unknown;
    try { appId = JSON.parse(row.app_id); if (typeof appId !== 'string' || !appId || wechatAppStoredValue(appId) !== row.app_id) throw unavailable(); }
    catch { throw unavailable(); }
    if (row.format_version !== 1 || !wechatAppRequestId(row.operation_id) || !Number.isSafeInteger(row.actor_id) || row.actor_id <= 0
      || !wechatAppRevision(row.source_revision) || !Number.isSafeInteger(row.created_at) || row.created_at <= 0
      || row.mch_id !== '' && !merchant(row.mch_id) || row.account_id !== hash(env, 'account-key', [appId, row.mch_id])
      || signature !== hash(env, 'account-record', facts)) throw unavailable();
    return { appId: appId as string, merchantId: row.mch_id, row };
  });
}

/** Caller already holds the author exclusive731664 gate and config table fence.
 * Empty mch records retain provenance but grant no future merchant authority. */
export async function appendNativeAppPaymentAccounts(tx: DbClient, env: RuntimeEnv, input: {
  appIds: readonly (string | null)[]; requestId: string; actorId: number; sourceRevision: string;
}): Promise<void> {
  await assertNativeAppPaymentAuthorityReady(tx, 'admin');
  const current = await state(tx, env), existing = await accounts(tx, env), created_at = await clock(tx);
  const additions = [...new Set(input.appIds.filter((value): value is string => typeof value === 'string' && value !== ''))]
    .filter(appId => !existing.some(row => row.appId === appId && row.merchantId === current.merchantId));
  if (existing.length + additions.length > 64) throw unavailable();
  for (const appId of additions) {
    const facts = { account_id: hash(env, 'account-key', [appId, current.merchantId]), app_id: wechatAppStoredValue(appId), mch_id: current.merchantId,
      operation_id: input.requestId, actor_id: input.actorId, source_revision: hash(env, 'account-source', [input.sourceRevision, current.rows]),
      format_version: 1, created_at };
    const signature = hash(env, 'account-record', facts);
    await tx.execute(sql`INSERT INTO public.native_app_payment_account(account_id,app_id,mch_id,operation_id,actor_id,source_revision,format_version,created_at,signature)
      VALUES(${facts.account_id},${facts.app_id},${facts.mch_id},${facts.operation_id}::uuid,${facts.actor_id},${facts.source_revision},1,${created_at},${signature})`);
  }
  const after = await accounts(tx, env);
  if (after.length !== existing.length + additions.length || additions.some(appId => !after.some(row => row.appId === appId && row.merchantId === current.merchantId))) throw unavailable();
}

async function authority<T>(container: Container, env: RuntimeEnv, write: boolean,
  action: (tx: DbClient, current: Awaited<ReturnType<typeof state>>, history: Awaited<ReturnType<typeof accounts>>) => Promise<T>) {
  return withTx(container, async tx => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`);
    await tx.execute(sql`SELECT set_config('statement_timeout','5s',true),set_config('lock_timeout','2s',true),set_config('idle_in_transaction_session_timeout','5s',true)`);
    await assertNativeAppPaymentAuthorityReady(tx, 'app');
    const [gate] = await tx.execute<{ locked: boolean }>(sql`SELECT pg_try_advisory_xact_lock_shared(731664,0) AS locked`);
    if (gate?.locked !== true) throw unavailable();
    const current = await state(tx, env), history = await accounts(tx, env);
    const result = await action(tx, current, history);
    if (canonical(await state(tx, env)) !== canonical(current) || canonical(await accounts(tx, env)) !== canonical(history)) throw unavailable();
    if (write) {
      const [deadline] = await tx.execute<{ valid: boolean }>(sql`SELECT clock_timestamp()<=transaction_timestamp()+interval '5 seconds' AS valid`);
      if (deadline?.valid !== true) throw unavailable();
    }
    return result;
  });
}

/** Verification/query may continue after current AppID is cleared. AppSecret is
 * never used for payment. Merchant/key rotation is a separate maintenance task. */
export function readNativeAppPaymentAccount(container: Container, env: RuntimeEnv) {
  return authority(container, env, false, async (_tx, current) => {
    if (!merchant(current.merchantId)) throw unavailable();
    return { appId: current.appId, merchantId: current.merchantId, stamp: current.stamp };
  });
}
function authorized(pair: Pair, current: Pair, history: readonly Pair[]) {
  return app(pair.appId) && merchant(pair.merchantId) && pair.merchantId === current.merchantId
    && (pair.appId === current.appId || history.some(row => row.appId === pair.appId && row.merchantId === pair.merchantId));
}

/** Absence is a legacy state only when the whole optional namespace is empty.
 * A partial install, orphan function/type or renamed owned index is not absence. */
export async function refundBundlePresent(tx: DbClient): Promise<boolean> {
  const [row] = await tx.execute<{ complete: boolean; present: boolean }>(sql`SELECT
    to_regclass('public.admin_wechat_app_operation') IS NOT NULL
      AND to_regclass('public.native_app_payment_account') IS NOT NULL
      AND to_regclass('public.native_app_payment_evidence') IS NOT NULL AS complete,
    EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace
      AND (starts_with(relname,'admin_wechat_app_operation') OR starts_with(relname,'awao_')
        OR starts_with(relname,'native_app_payment_') OR starts_with(relname,'napa_') OR starts_with(relname,'nape_')))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace
      AND (starts_with(proname,'admin_wechat_app_operation') OR starts_with(proname,'awao_')
        OR starts_with(proname,'native_app_payment_') OR starts_with(proname,'napa_') OR starts_with(proname,'nape_')))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE connamespace='public'::regnamespace
      AND (starts_with(conname,'awao_') OR starts_with(conname,'native_app_payment_') OR starts_with(conname,'napa_') OR starts_with(conname,'nape_')))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
      WHERE c.relnamespace='public'::regnamespace
      AND (starts_with(t.tgname,'awao_') OR starts_with(t.tgname,'native_app_payment_') OR starts_with(t.tgname,'napa_') OR starts_with(t.tgname,'nape_')))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_type WHERE typnamespace='public'::regnamespace
      AND (starts_with(typname,'admin_wechat_app_operation') OR starts_with(typname,'_admin_wechat_app_operation')
        OR starts_with(typname,'awao_') OR starts_with(typname,'native_app_payment_') OR starts_with(typname,'_native_app_payment_')
        OR starts_with(typname,'napa_') OR starts_with(typname,'nape_'))) AS present`);
  if (!row || typeof row.complete !== 'boolean' || typeof row.present !== 'boolean' || row.present && !row.complete) throw unavailable();
  return row.present;
}

/** App-only internal primitive. Financial roles use the explicit read-only
 * provider verifier without replacing their business container or authority.
 * A merchant-only refund may outlive every current AppID/Secret. Only a
 * provider-confirmed immutable original narrows legacy refund authority; an
 * init attempt or historical account alone never establishes an original.
 * Call outside provider I/O and before any caller-held order lock. */
export async function assertNativeAppRefundAccount(container: Container, env: RuntimeEnv, input: {
  orderNo: string; merchantId: string; totalAmount: number; transactionId?: string;
}): Promise<void> {
  // Legacy refund numbers are not required to use the newer App order syntax.
  if (typeof input.orderNo !== 'string' || !merchant(input.merchantId)
    || !Number.isSafeInteger(input.totalAmount) || input.totalAmount <= 0) throw new ValidateException('原生App退款商户或原支付金额无效');
  await withTx(container, async tx => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`);
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    await tx.execute(sql`SELECT set_config('statement_timeout','5s',true),set_config('lock_timeout','2s',true),set_config('idle_in_transaction_session_timeout','5s',true)`);
    await assertNativeAppRefundAccountInTx(tx, env, input);
  });
}

/** Caller owns a fresh root RC READ ONLY App transaction. This does not admit a
 * financial operation or grant a provider dispatch claim. */
export async function assertNativeAppRefundAccountInTx(tx: DbClient, env: RuntimeEnv, input: {
  orderNo: string; merchantId: string; totalAmount: number; transactionId?: string;
}): Promise<void> {
  if (typeof input.orderNo !== 'string' || !merchant(input.merchantId)
    || !Number.isSafeInteger(input.totalAmount) || input.totalAmount <= 0) throw new ValidateException('原生App退款商户或原支付金额无效');
  const [context] = await tx.execute<{ safe: boolean }>(sql`SELECT current_setting('transaction_isolation')='read committed'
    AND current_setting('transaction_read_only')='on' AS safe`);
  if (context?.safe !== true) throw unavailable();
  const [maintenance] = await tx.execute<{ locked: boolean }>(sql`SELECT pg_try_advisory_xact_lock_shared(731663,0) AS locked`);
  if (maintenance?.locked !== true) throw unavailable();
  if (!await refundBundlePresent(tx)) return;
  await assertNativeAppPaymentAuthorityReady(tx, 'app');
  // The third table must belong to the same exact maintenance/Admin pair as
  // the already validated payment catalog, not merely look safe in isolation.
  const owners = await tx.execute<{ maintenance: string; admin: string }>(sql`SELECT o.rolname AS maintenance,r.rolname AS admin
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_roles o ON o.oid=c.relowner
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
    JOIN pg_catalog.pg_roles r ON r.oid=a.grantee
    WHERE c.oid=to_regclass('public.native_app_payment_account') AND a.grantee<>c.relowner AND a.privilege_type='INSERT'`);
  if (owners.length !== 1 || !await inspectAdminWechatAppOperation(tx, owners[0])) throw unavailable();
  const [gate] = await tx.execute<{ locked: boolean }>(sql`SELECT pg_try_advisory_xact_lock_shared(731664,0) AS locked`);
  if (gate?.locked !== true) throw unavailable();
  const current = await state(tx, env), history = await accounts(tx, env);
  if (current.merchantId !== input.merchantId) throw new ValidateException('原生App退款商户配置已变化');
  await lockStoreOrderPaymentBoundary(tx, input.orderNo);
  const original = initiation(await getEvidence(tx, env, 'original:' + input.orderNo));
  if (original && (original.orderDomain !== 'store_order' || original.merchantId !== input.merchantId || original.amountCents !== input.totalAmount))
    throw new ValidateException('原生App退款商户、订单域或原支付金额与已确认原单不一致');
  if (canonical(await state(tx, env)) !== canonical(current) || canonical(await accounts(tx, env)) !== canonical(history)) throw unavailable();
  const [deadline] = await tx.execute<{ valid: boolean }>(sql`SELECT clock_timestamp()<=transaction_timestamp()+interval '5 seconds' AS valid`);
  if (deadline?.valid !== true) throw unavailable();
}

function evidence(env: RuntimeEnv, raw: EvidenceRow): EvidenceRow {
  const row = whole(raw), { signature, ...facts } = row;
  if (row.format_version !== 1 || !order(row.order_no) || !Number.isSafeInteger(row.created_at) || row.created_at <= 0
    || !row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload)
    || !['initiation', 'callback', 'signed_query'].includes(row.kind)
    || (row.kind === 'initiation' ? row.evidence_id !== 'original:' + row.order_no
      && !new RegExp('^init:' + row.order_no + ':[a-f0-9]{64}$', 'u').test(row.evidence_id)
      : row.kind === 'callback' ? !/^callback:[A-Za-z0-9_-]{1,64}$/u.test(row.evidence_id)
        : !row.evidence_id.startsWith('query:') || !wechatAppRequestId(row.evidence_id.slice(6)))
    || signature !== hash(env, 'evidence-record', facts)) throw unavailable();
  return row;
}
async function getEvidence(tx: DbClient, env: RuntimeEnv, id: string): Promise<EvidenceRow | null> {
  const rows = await tx.execute<EvidenceRow>(sql`SELECT evidence_id,order_no,kind,format_version,payload,created_at,signature
    FROM public.native_app_payment_evidence WHERE evidence_id=${id} LIMIT 2`);
  if (rows.length > 1) throw unavailable(); return rows.length ? evidence(env, rows[0]) : null;
}
async function appendEvidence(tx: DbClient, env: RuntimeEnv, id: string, kind: EvidenceKind, orderNo: string, payload: Record<string, unknown>) {
  const existing = await getEvidence(tx, env, id);
  if (existing) {
    if (existing.order_no !== orderNo || existing.kind !== kind || canonical(existing.payload) !== canonical(payload)) throw new ValidateException('原生App支付见证发生不可变冲突');
    return existing;
  }
  const facts = { evidence_id: id, order_no: orderNo, kind, format_version: 1, payload, created_at: await clock(tx) };
  const signature = hash(env, 'evidence-record', facts);
  await tx.execute(sql`INSERT INTO public.native_app_payment_evidence(evidence_id,order_no,kind,format_version,payload,created_at,signature)
    VALUES(${id},${orderNo},${kind},1,${JSON.stringify(payload)}::jsonb,${facts.created_at},${signature})`);
  const saved = await getEvidence(tx, env, id);
  if (!saved || canonical(saved) !== canonical({ ...facts, signature })) throw unavailable(); return saved;
}
function initiation(row: EvidenceRow | null): Initiation | null {
  if (!row) return null;
  const p = row.payload;
  const confirmed = row.evidence_id === 'original:' + row.order_no;
  if (row.kind !== 'initiation' || !fields(p, ['appId','merchantId','profile','orderNo','amountCents','orderDomain','currency','configStamp',
      ...(confirmed ? ['confirmation_source','prepayIdHash'] : [])])
    || !app(p.appId) || !merchant(p.merchantId) || p.profile !== 'app' || p.orderNo !== row.order_no || !cents(p.amountCents)
    || !['store_order', 'recharge', 'membership'].includes(String(p.orderDomain)) || p.currency !== 'CNY' || !wechatAppRevision(p.configStamp)
    || confirmed && (p.confirmation_source !== 'wechat-signed-query-after-prepay' || !wechatAppRevision(p.prepayIdHash))) throw unavailable();
  return p as unknown as Initiation;
}
function attemptId(env: RuntimeEnv, input: Initiation) {
  // A credential/source refresh may replay the same attempt. A different pair
  // gets a separate immutable attempt; only a provider-confirmed original can
  // bind every later retry to one account.
  const { configStamp: _stamp, ...identity } = input;
  return 'init:' + input.orderNo + ':' + hash(env, 'attempt-key', identity);
}

/** A pre-request selection is not an original provider identity. Only the
 * strict signed query performed after the signed prepay response supplies that
 * stronger fact, including for orders imported without an initiation record. */
export function confirmNativeAppPaymentInitiation(container: Container, env: RuntimeEnv, input: Initiation, confirmation: {
  appId: string; merchantId: string; orderNo: string; amountCents: number; currency: 'CNY'; tradeType: 'APP'; prepayId: string;
}) {
  if (!app(confirmation.appId) || !merchant(confirmation.merchantId) || !order(confirmation.orderNo) || !cents(confirmation.amountCents)
    || confirmation.appId !== input.appId || confirmation.merchantId !== input.merchantId || confirmation.orderNo !== input.orderNo
    || confirmation.amountCents !== input.amountCents || confirmation.currency !== 'CNY' || confirmation.tradeType !== 'APP'
    || !/^[A-Za-z0-9_-]{1,64}$/u.test(confirmation.prepayId)) throw new ValidateException('原生App预支付实际订单身份不一致');
  return authority(container, env, true, async (tx, current, history) => {
    if (!authorized(input, current, history)) throw new ValidateException('原生App预支付账号已不在当前商户授权范围');
    await lockStoreOrderPaymentBoundary(tx, input.orderNo);
    const attempted = initiation(await getEvidence(tx, env, attemptId(env, input)));
    if (!attempted || canonical(attempted) !== canonical(input)) throw new ValidateException('原生App预支付发起见证不一致');
    const original = initiation(await getEvidence(tx, env, 'original:' + input.orderNo));
    if (original) {
      for (const key of ['appId','merchantId','orderNo','amountCents','orderDomain','currency','profile'] as const)
        if (original[key] !== input[key]) throw new ValidateException('原生App原单身份发生冲突');
      return original;
    }
    await appendEvidence(tx, env, 'original:' + input.orderNo, 'initiation', input.orderNo, { ...input,
      confirmation_source: 'wechat-signed-query-after-prepay', prepayIdHash: hash(env, 'prepay-id', confirmation.prepayId) });
    return input;
  });
}

/** All order locks are acquired after the account gate. Existing registry
 * registration/assisted claims finish before calling this primitive. */
export function recordNativeAppPaymentInitiation(container: Container, env: RuntimeEnv, input: Initiation) {
  if (!fields(input as unknown as Record<string, unknown>, ['appId','merchantId','profile','orderNo','amountCents','orderDomain','currency','configStamp'])
    || !order(input.orderNo) || !app(input.appId) || !merchant(input.merchantId) || !cents(input.amountCents)
    || input.profile !== 'app' || input.currency !== 'CNY' || !wechatAppRevision(input.configStamp)
    || !['store_order', 'recharge', 'membership'].includes(input.orderDomain)) throw new ValidateException('原生App支付发起身份无效');
  return authority(container, env, true, async (tx, current) => {
    if (input.appId !== current.appId || input.merchantId !== current.merchantId || input.configStamp !== current.stamp)
      throw new ValidateException('原生App支付账号已变化，请重新发起');
    await lockStoreOrderPaymentBoundary(tx, input.orderNo);
    const [registered] = await tx.select().from(paymentReconciliationCase).where(and(eq(paymentReconciliationCase.provider, 'wechat'),
      eq(paymentReconciliationCase.orderNo, input.orderNo))).limit(1).for('update');
    if (!registered || registered.status === 'CONFLICT' || registered.profile !== 'app' || registered.orderDomain !== input.orderDomain
      || registered.currency !== 'CNY' || registered.expectedAmountCents !== input.amountCents || !registered.initiatedTime)
      throw new ValidateException('原生App支付与已登记的订单、金额或渠道不一致');
    const original = initiation(await getEvidence(tx, env, 'original:' + input.orderNo));
    if (original) {
      for (const key of ['appId','merchantId','orderNo','amountCents','orderDomain','currency','profile'] as const)
        if (original[key] !== input[key]) throw new ValidateException('订单已确认其他原生App原交易身份，请先核对原交易');
    }
    const id = attemptId(env, input), prior = initiation(await getEvidence(tx, env, id));
    if (prior) {
      const { configStamp: _a, ...a } = prior, { configStamp: _b, ...b } = input;
      if (canonical(a) !== canonical(b)) throw new ValidateException('订单已绑定其他原生App支付身份，请先核对原交易');
      return prior;
    }
    await appendEvidence(tx, env, id, 'initiation', input.orderNo, input as unknown as Record<string, unknown>);
    return input;
  });
}

function validProvider(input: ProviderFacts) {
  return app(input.appId) && merchant(input.merchantId) && order(input.orderNo) && cents(input.amountCents)
    && input.currency === 'CNY' && /^[A-Za-z0-9_-]{1,100}$/u.test(input.transactionId)
    && /^[A-Z][A-Z0-9_]{1,31}$/u.test(input.tradeState) && input.tradeType === 'APP'
    && Number.isSafeInteger(input.providerEventTime) && input.providerEventTime >= 0
    && (input.tradeState !== 'SUCCESS' || input.providerEventTime > 0);
}
function matchesOriginal(original: Initiation | null, input: ProviderFacts) {
  return !original || original.appId === input.appId && original.merchantId === input.merchantId && original.amountCents === input.amountCents;
}
export function assertNativeAppQueryAccount(container: Container, env: RuntimeEnv, request: PaymentProviderQueryRequest, pair: Pair) {
  if (request.provider !== 'wechat' || request.profile !== 'app' || request.currency !== 'CNY' || !order(request.orderNo)
    || !cents(request.expectedAmountCents) || !['store_order','recharge','membership'].includes(request.orderDomain))
    throw new ValidateException('原生App查单请求身份无效');
  return authority(container, env, false, async (tx, current, history) => {
    if (!authorized(pair, current, history)) throw new ValidateException('原生App查单账号不在当前商户授权历史中');
    const original = initiation(await getEvidence(tx, env, 'original:' + request.orderNo));
    if (original && (original.appId !== pair.appId || original.merchantId !== pair.merchantId
      || original.amountCents !== request.expectedAmountCents || original.orderDomain !== request.orderDomain))
      throw new ValidateException('原生App查单账号与原单身份不一致');
  });
}
/** Called only after real provider signature/decryption or strict signed-query
 * verification. The legacy classification never asserts an original AppID. */
export async function recordNativeAppProviderEvidence(container: Container, env: RuntimeEnv,
  input: ProviderFacts & ({ source: 'callback'; providerEventId: string } | { source: 'signed_query' })) {
  if (!fields(input as unknown as Record<string, unknown>, ['appId','merchantId','orderNo','amountCents','currency','transactionId',
      'tradeState','providerEventTime','tradeType','source', ...(input.source === 'callback' ? ['providerEventId'] : [])])
    || !validProvider(input) || !['callback','signed_query'].includes(input.source)
    || input.source === 'callback' && !/^[A-Za-z0-9_-]{1,64}$/u.test(input.providerEventId))
    throw new ValidateException('原生App支付提供方身份无效');
  const result = await authority(container, env, true, async (tx, current, history) => {
    if (!authorized(input, current, history)) throw new ValidateException('原生App支付账号不在当前商户的授权历史中');
    await lockStoreOrderPaymentBoundary(tx, input.orderNo);
    const original = initiation(await getEvidence(tx, env, 'original:' + input.orderNo));
    const accepted = matchesOriginal(original, input);
    const id = input.source === 'callback' ? 'callback:' + input.providerEventId : 'query:' + crypto.randomUUID();
    const prior = input.source === 'callback' ? await getEvidence(tx, env, id) : null;
    if (prior && accepted && input.source === 'callback') {
      checkProviderWitness(prior, input, input.source);
      if (prior.payload.providerEventId !== input.providerEventId) throw unavailable();
      return { id, accepted };
    }
    const payload = { ...input, profile: 'app', admission: accepted ? original ? 'exact_initiation' : 'provider_verified_legacy' : 'original_mismatch' };
    await appendEvidence(tx, env, id, input.source, input.orderNo, payload);
    return { id, accepted };
  });
  if (!result.accepted) throw new ValidateException('原生App支付提供方身份与原订单不一致');
  return result.id;
}

function checkProviderWitness(row: EvidenceRow | null, input: ProviderFacts, source: 'callback' | 'signed_query') {
  if (!row || row.kind !== source || row.order_no !== input.orderNo || !validProvider(input)) throw unavailable();
  const p = row.payload;
  if (!fields(p, ['appId','merchantId','orderNo','amountCents','currency','transactionId','tradeState','providerEventTime','tradeType','source',
      'profile','admission', ...(source === 'callback' ? ['providerEventId'] : [])])
    || p.source !== source || p.profile !== 'app' || !['exact_initiation','provider_verified_legacy'].includes(String(p.admission))) throw unavailable();
  for (const [key, value] of Object.entries(input)) if (p[key] !== value) throw new ValidateException('原生App支付见证与当前交易不一致');
  return p;
}
/** The caller owns the order boundary. No account gate is acquired in this
 * direction, avoiding order→account / account→order lock inversion. */
export async function assertNativeAppCallbackWitnessInTx(tx: DbClient, env: RuntimeEnv, callback: VerifiedPaymentCallback) {
  if (callback.provider !== 'wechat' || callback.profile !== 'app' || callback.currency !== 'CNY')
    throw new ValidateException('原生App回调渠道或币种无效');
  await assertNativeAppPaymentAuthorityReady(tx, 'app');
  const row = await getEvidence(tx, env, 'callback:' + callback.providerEventId);
  const input: ProviderFacts = { appId: String(row?.payload.appId ?? ''), merchantId: String(row?.payload.merchantId ?? ''),
    orderNo: callback.orderNo, amountCents: callback.amountCents, currency: callback.currency, transactionId: callback.transactionId,
    tradeState: callback.tradeState, providerEventTime: callback.providerEventTime, tradeType: 'APP' };
  const payload = checkProviderWitness(row, input, 'callback');
  const original = initiation(await getEvidence(tx, env, 'original:' + callback.orderNo));
  if (payload.providerEventId !== callback.providerEventId || !matchesOriginal(original, input))
    throw new ValidateException('原生App回调与原交易身份不一致');
  if (original) {
    const [registered] = await tx.select().from(paymentReconciliationCase).where(and(eq(paymentReconciliationCase.provider, 'wechat'),
      eq(paymentReconciliationCase.orderNo, callback.orderNo))).limit(1);
    if (!registered || registered.profile !== 'app' || registered.orderDomain !== original.orderDomain
      || registered.expectedAmountCents !== original.amountCents || registered.currency !== 'CNY' || registered.status === 'CONFLICT')
      throw new ValidateException('原生App回调与已登记订单域不一致');
  }
}
export async function assertNativeAppQueryWitnessInTx(tx: DbClient, env: RuntimeEnv, request: PaymentProviderQueryRequest, result: PaymentProviderQueryResult) {
  if (request.provider !== 'wechat' || request.profile !== 'app' || request.currency !== 'CNY'
    || !['store_order','recharge','membership'].includes(request.orderDomain) || !order(request.orderNo) || !cents(request.expectedAmountCents)
    || result.status !== 'SUCCESS' || result.providerTradeState !== 'SUCCESS' || result.currency !== 'CNY' || result.orderNo !== request.orderNo || result.errorCode !== '')
    throw new ValidateException('原生App查单渠道、订单域或结果无效');
  await assertNativeAppPaymentAuthorityReady(tx, 'app');
  if (typeof result.nativeAppEvidenceId !== 'string') throw unavailable();
  const row = await getEvidence(tx, env, result.nativeAppEvidenceId);
  const input: ProviderFacts = { appId: String(row?.payload.appId ?? ''), merchantId: String(row?.payload.merchantId ?? ''),
    orderNo: request.orderNo, amountCents: result.amountCents, currency: 'CNY', transactionId: result.transactionId,
    tradeState: result.providerTradeState, providerEventTime: result.providerEventTime, tradeType: 'APP' };
  checkProviderWitness(row, input, 'signed_query');
  const original = initiation(await getEvidence(tx, env, 'original:' + request.orderNo));
  if (input.amountCents !== request.expectedAmountCents || !matchesOriginal(original, input) || original && original.orderDomain !== request.orderDomain)
    throw new ValidateException('原生App查单与原交易身份不一致');
}
