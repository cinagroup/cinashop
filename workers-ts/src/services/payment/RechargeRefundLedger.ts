import { sql } from 'drizzle-orm';
import type { Env } from '@/env';
import type { DbClient } from '@/lib/di';
import { RECHARGE_REFUND_TABLES, type RechargeRefundBinding, type RechargeRefundRuntimeRole } from '@/migrations/rechargeRefundContract';
import { assertRechargeRefundRuntimeTx } from '@/migrations/rechargeRefund';
import { normalizeOutRequestKey, outRequestHash } from '@/services/out/OutIdempotency';
import { HttpApiException, ServiceUnavailableException } from '@/utils/errors';
import { rechargeRefundId } from './RechargeRefundMoney';
import { captureRechargeRefundJson, parseRechargeRefundJournal, signRechargeRefundJournal, type RechargeRefundJson,
  type RechargeRefundJournalKind, type RechargeRefundScope } from './RechargeRefundJournalCodec';

type Signing = Pick<Env, 'APP_KEY'>;
export type RechargeRefundRecord = Readonly<Record<string, RechargeRefundJson>>;
const fail = (): never => { throw new ServiceUnavailableException('充值退款持久回执暂不可核对，请保留原请求'); };
const uuid = (value: unknown): value is string => typeof value === 'string' && value.length === 36
  && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
type TableName = 'recharge_refund_operation' | 'recharge_refund_attempt' | 'recharge_refund_result';
type RecordTableName = TableName | 'recharge_refund_state';

/** PostgreSQL bigint is returned as text. Reconstruct the SAME scalar body on
 * insertion/read, instead of signing driver-specific number/string encodings.
 * This checks the exact published column set; it does not accept extra fields. */
export function captureRechargeRefundRecord(table: RecordTableName, input: unknown): RechargeRefundRecord {
  const layout = RECHARGE_REFUND_TABLES.find(value => value.name === table);
  if (!layout || !input || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return fail();
  const fields = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(fields).length !== layout.columns.length) return fail();
  const result: Record<string, RechargeRefundJson> = Object.create(null);
  for (const [name, type, required] of layout.columns) {
    const descriptor = fields[name];
    if (!descriptor?.enumerable || !('value' in descriptor)) return fail();
    const value: unknown = descriptor.value;
    if (value === null && !required) { result[name] = null; continue; }
    if (type === 'bigint') {
      if (typeof value !== 'number' && (typeof value !== 'string' || !/^-?(?:0|[1-9]\d*)$/.test(value)
        || value.trim() !== value || value === '-0')) return fail();
      const number = Number(value);
      if (!Number.isSafeInteger(number) || Object.is(number, -0)) return fail();
      result[name] = number;
    } else if (type === 'integer') {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || Math.abs(value) > 2_147_483_647) return fail();
      result[name] = value;
    } else if (type === 'boolean') {
      if (typeof value !== 'boolean') return fail();
      result[name] = value;
    } else if (type === 'uuid') {
      if (!uuid(value)) return fail();
      result[name] = value;
    } else if (type === 'text') {
      if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > 16_384) return fail();
      result[name] = value;
    } else if (type === 'jsonb') {
      // Journal encoding below performs finite deep copying and authentication.
      if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
      result[name] = value as RechargeRefundJson;
    } else return fail();
  }
  return Object.freeze(result);
}

function kindFor(table: TableName, row: RechargeRefundRecord): RechargeRefundJournalKind {
  if (table === 'recharge_refund_operation') return 'operation';
  if (table === 'recharge_refund_attempt') return 'attempt';
  return ['local_cancel','local_settlement','local_release'].includes(String(row.source)) ? 'local-result' : 'provider-result';
}

function bodyOf(row: RechargeRefundRecord): Record<string, RechargeRefundJson> {
  return Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'signature'));
}

export function authenticateRechargeRefundRecord(env: Signing, scope: RechargeRefundScope,
  table: TableName, input: unknown): RechargeRefundRecord {
  const row = captureRechargeRefundRecord(table, input), data = bodyOf(row);
  const parsed = parseRechargeRefundJournal(env, kindFor(table, row), scope, {
    format: 1, kind: kindFor(table, row), scope, data, createdAt: row.created_at, signature: row.signature,
  });
  return Object.freeze({ ...(parsed.data as Record<string, RechargeRefundJson>), signature: parsed.signature });
}

/** A builder is internal to an already authorized business/transport phase.
 * The SQL reader always reconstructs and checks the signature after insertion. */
export function signRechargeRefundRecord(env: Signing, scope: RechargeRefundScope,
  table: TableName, input: unknown): RechargeRefundRecord {
  const data = captureUnsignedRecord(table, input), row: RechargeRefundRecord = { ...data, signature: '' };
  const envelope = signRechargeRefundJournal(env, kindFor(table, row), scope, data, Number(row.created_at));
  return Object.freeze({ ...(envelope.data as Record<string, RechargeRefundJson>), signature: envelope.signature });
}

function captureUnsignedRecord(table: TableName, input: unknown): RechargeRefundRecord {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Object.hasOwn(input, 'signature')) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(input), copy: Record<string, unknown> = Object.create(null);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string')) return fail();
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !('value' in descriptor)) return fail();
    copy[key] = descriptor.value;
  }
  // The placeholder is never persisted. It merely selects the exact full row
  // shape; nested values are copied before any catalog/SQL await can intervene.
  const row = captureRechargeRefundRecord(table, { ...copy, signature: '' });
  return captureRechargeRefundJson(bodyOf(row)) as RechargeRefundRecord;
}

async function runtime(tx: DbClient, role: RechargeRefundRuntimeRole, mode: 'read' | 'write'): Promise<RechargeRefundBinding> {
  if (Object.hasOwn(tx, '$client')) return fail();
  return assertRechargeRefundRuntimeTx(tx, role, mode);
}

export async function lockRechargeRefundKeyTx(tx: DbClient, adminId: number, requestKey: unknown): Promise<string> {
  adminId = rechargeRefundId(adminId);
  const key = normalizeOutRequestKey(requestKey), digest = await outRequestHash([adminId, key]);
  // Full admin/key remains the database uniqueness authority; a hash collision
  // only serializes unrelated keys. Caller has already set finite lock bounds.
  await tx.execute(sql`SELECT pg_catalog.pg_advisory_xact_lock(731730,${Number.parseInt(digest.slice(0,8),16) | 0}::integer)`);
  return key;
}

export async function readRechargeRefundOperationTx(tx: DbClient, env: Signing,
  adminId: number, requestKey: unknown, mode: 'read' | 'write' = 'read'): Promise<RechargeRefundRecord | null> {
  adminId = rechargeRefundId(adminId);
  const scope = await runtime(tx, 'admin', mode), key = normalizeOutRequestKey(requestKey);
  const rows = await tx.execute(sql`SELECT * FROM public.recharge_refund_operation
    WHERE admin_id=${adminId} AND request_key=${key}::uuid LIMIT 2`);
  if (!rows.length) return null;
  if (rows.length !== 1) return fail();
  return authenticateRechargeRefundRecord(env, scope, 'recharge_refund_operation', rows[0]);
}

export function assertRechargeRefundRequestReplay(row: RechargeRefundRecord, adminId: number,
  rechargeId: number, requestKey: string, requestHash: string): void {
  if (row.admin_id !== adminId || row.recharge_id !== rechargeId || row.request_key !== requestKey || row.request_hash !== requestHash) {
    throw new HttpApiException('该操作标识已用于不同充值退款内容，请保留原请求核对', 409, 409);
  }
}

export async function insertRechargeRefundOperationTx(tx: DbClient, env: Signing, input: unknown): Promise<RechargeRefundRecord> {
  const captured = captureUnsignedRecord('recharge_refund_operation', input);
  const scope = await runtime(tx, 'admin', 'write'), row = signRechargeRefundRecord(env, scope, 'recharge_refund_operation', captured);
  const adminId = rechargeRefundId(row.admin_id), key = await lockRechargeRefundKeyTx(tx, adminId, row.request_key);
  // This must remain an INSERT, not an upsert overwriting admitted money/source.
  // If the caller missed an earlier replay, throwing rolls back any wallet DML.
  if (await readRechargeRefundOperationTx(tx, env, adminId, key, 'write')) {
    throw new HttpApiException('原充值退款操作已存在，请读取原回执', 409, 409);
  }
  return insertSignedRowTx(tx, env, scope, 'recharge_refund_operation', row);
}

async function insertSignedRowTx(tx: DbClient, env: Signing, scope: RechargeRefundScope,
  table: TableName, row: RechargeRefundRecord) {
  const columns = RECHARGE_REFUND_TABLES.find(layout => layout.name === table)!.columns;
  const values = columns.map(([name, type]) => type === 'jsonb' && row[name] !== null
    ? sql`${JSON.stringify(row[name])}::jsonb` : sql`${row[name]}`);
  const rows = await tx.execute(sql`INSERT INTO ${sql.identifier('public')}.${sql.identifier(table)}
    (${sql.join(columns.map(([name]) => sql.identifier(name)), sql`,`)})
    VALUES (${sql.join(values, sql`,`)}) RETURNING *`);
  if (rows.length !== 1) return fail();
  const saved = authenticateRechargeRefundRecord(env, scope, table, rows[0]);
  if (saved.signature !== row.signature) return fail();
  return saved;
}

/** Internal authors only. A role check and HMAC do not establish a provider
 * response: the calling service must supply actual verified evidence and own
 * the matching state/operation locks in this same business transaction. */
export async function insertRechargeRefundEvidenceTx(tx: DbClient, env: Signing,
  role: RechargeRefundRuntimeRole, table: 'recharge_refund_attempt' | 'recharge_refund_result', input: unknown) {
  const captured = captureUnsignedRecord(table, input), scope = await runtime(tx, role, 'write');
  return insertSignedRowTx(tx, env, scope, table, signRechargeRefundRecord(env, scope, table, captured));
}

export async function readRechargeRefundOperationByIdTx(tx: DbClient, env: Signing,
  role: RechargeRefundRuntimeRole, operationId: unknown, mode: 'read' | 'write') {
  if (!uuid(operationId)) return fail();
  const scope = await runtime(tx, role, mode), rows = await tx.execute(sql`SELECT * FROM public.recharge_refund_operation
    WHERE operation_id=${operationId}::uuid LIMIT 2`);
  if (rows.length !== 1) return fail();
  return authenticateRechargeRefundRecord(env, scope, 'recharge_refund_operation', rows[0]);
}
