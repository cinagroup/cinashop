import { sql } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { HttpApiException, ValidateException } from '@/utils/errors';
import { normalizeOutRequestKey, outRequestHash } from '@/services/out/OutIdempotency';

export type AdminRefundOperationAction = 'return' | 'refuse' | 'refund';
export type AdminRefundOperationOutcome = 'return-approved' | 'refused' | 'balance-settled' | 'provider-admitted' | 'abandoned';
export interface AdminRefundOperationIdentity {
  readonly adminId: number;
  readonly requestKey: string;
  readonly requestHash: string;
  readonly refundId: number;
  readonly action: AdminRefundOperationAction;
}
export interface AdminRefundOperationReceipt extends AdminRefundOperationIdentity {
  readonly version: 'admin-refund-operation-v1';
  readonly outcome: AdminRefundOperationOutcome;
}
const LOCK_NAMESPACE = 731_607;
const actions = new Set<string>(['return', 'refuse', 'refund']);
const validId = (id: unknown): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0 && id <= 2_147_483_647;
const outcomeMatches = (action: AdminRefundOperationAction, outcome: unknown): outcome is AdminRefundOperationOutcome =>
  outcome === 'abandoned' || action === 'return' && outcome === 'return-approved'
  || action === 'refuse' && outcome === 'refused' || action === 'refund' && (outcome === 'balance-settled' || outcome === 'provider-admitted');

function identity(value: AdminRefundOperationIdentity): AdminRefundOperationIdentity {
  if (!value || !validId(value.adminId) || !validId(value.refundId) || !actions.has(value.action)
    || typeof value.requestHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.requestHash)) throw new ValidateException('退款操作标识无效');
  return Object.freeze({ adminId: value.adminId, refundId: value.refundId, action: value.action,
    requestKey: normalizeOutRequestKey(value.requestKey), requestHash: value.requestHash });
}

/** Requires an existing business transaction, not a root client. Authorization
 * and normalized body hashing belong to the decision service, not this ledger.
 * Its stable admin ID must be trusted middleware identity, never request JSON. */
async function lock(tx: DbClient, adminId: number, key: string): Promise<void> {
  if (Object.hasOwn(tx, '$client')) throw new Error('Refund operation ledger requires the caller business transaction');
  if (!validId(adminId)) throw new ValidateException('退款操作账号无效');
  await tx.execute(sql`SET LOCAL row_security = off`);
  await tx.execute(sql`SELECT
    set_config('statement_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
    set_config('lock_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1500)::text || 'ms',true)`);
  const hash = await outRequestHash([adminId, key]);
  // Hash collisions only serialize. The full database primary key is authority.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE}::int,${Number.parseInt(hash.slice(0,8),16)|0}::int)`);
}

async function read(tx: DbClient, adminId: number, key: string): Promise<AdminRefundOperationReceipt | null> {
  const rows = await tx.select({ refundId: sql<number>`refund_id`, action: sql<string>`action`,
    requestHash: sql<string>`request_hash`, outcome: sql<string>`outcome` })
    .from(sql`admin_refund_operation`).where(sql`admin_id=${adminId} AND request_key=${key}::uuid`).limit(2);
  if (!rows.length) return null;
  const row = rows[0];
  if (rows.length !== 1 || !validId(row.refundId) || !actions.has(row.action)
    || typeof row.requestHash !== 'string' || !/^[a-f0-9]{64}$/.test(row.requestHash)
    || !outcomeMatches(row.action as AdminRefundOperationAction, row.outcome)) {
    throw new HttpApiException('退款操作回执异常，请人工核对', 503, 503);
  }
  return Object.freeze({ version: 'admin-refund-operation-v1', adminId, requestKey: key,
    requestHash: row.requestHash, refundId: row.refundId, action: row.action as AdminRefundOperationAction, outcome: row.outcome });
}

function sameRequest(prior: AdminRefundOperationReceipt, operation: AdminRefundOperationIdentity): void {
  if (prior.requestHash !== operation.requestHash || prior.refundId !== operation.refundId || prior.action !== operation.action) {
    throw new HttpApiException('该操作标识已用于不同退款内容，请核对原操作', 409, 409);
  }
}

/** Check before any business write. The key lock is held to business commit,
 * including when no receipt exists. A missing receipt is never proof no sender
 * can arrive later. Abandonment is a persisted fence, not deleting local state. */
export async function checkAdminRefundOperation(tx: DbClient, value: AdminRefundOperationIdentity): Promise<AdminRefundOperationReceipt | null> {
  const operation = identity(value);
  await lock(tx, operation.adminId, operation.requestKey);
  const prior = await read(tx, operation.adminId, operation.requestKey);
  if (prior) sameRequest(prior, operation);
  return prior;
}

/** Insert only in the SAME transaction as the named business outcome/admission.
 * No response body, refund reason, credentials, update, deletion, TTL or external
 * call is part of the ledger. The caller must honor check() before doing work. */
export async function appendAdminRefundOperation(tx: DbClient, value: AdminRefundOperationIdentity,
  outcome: AdminRefundOperationOutcome): Promise<AdminRefundOperationReceipt> {
  const operation = identity(value);
  if (!outcomeMatches(operation.action, outcome)) throw new ValidateException('退款回执结果与操作不一致');
  const prior = await checkAdminRefundOperation(tx, operation);
  if (prior) {
    if (prior.outcome !== outcome) throw new HttpApiException('原操作已有确定回执，不能覆盖', 409, 409);
    return prior;
  }
  await tx.execute(sql`INSERT INTO admin_refund_operation(admin_id,request_key,request_hash,refund_id,action,outcome)
    VALUES(${operation.adminId},${operation.requestKey}::uuid,${operation.requestHash},${operation.refundId},${operation.action},${outcome})`);
  const receipt = await read(tx, operation.adminId, operation.requestKey);
  if (!receipt) throw new Error('退款操作回执未持久化');
  sameRequest(receipt, operation);
  if (receipt.outcome !== outcome) throw new Error('退款操作回执写入不一致');
  return receipt;
}

/** Read-only lookup for an authenticated, currently authorized owner. The HTTP
 * adapter must authorize that owner before calling. No business data is joined,
 * and provider-admitted must never be presented as money already settled. */
export async function findAdminRefundOperation(container: Container, adminId: number, requestKey: unknown): Promise<AdminRefundOperationReceipt | null> {
  if (!validId(adminId)) throw new ValidateException('退款操作账号无效');
  const key = normalizeOutRequestKey(requestKey);
  return withTx(container, async tx => { await lock(tx, adminId, key); return read(tx, adminId, key); });
}
