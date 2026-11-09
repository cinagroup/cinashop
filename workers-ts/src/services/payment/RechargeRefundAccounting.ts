import { eq, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { userBill } from '@/models/schema';
import { ServiceUnavailableException } from '@/utils/errors';
import { captureRechargeRefundRecord, type RechargeRefundRecord } from './RechargeRefundLedger';
import { rechargeRefundCents, rechargeRefundId } from './RechargeRefundMoney';
import { captureRechargeRefundJson } from './RechargeRefundJournalCodec';
import type { RechargeRefundStatus, RechargeRefundWalletState } from './RechargeRefundStateMachine';

const fail = (): never => { throw new ServiceUnavailableException('充值退款余额账本或资金状态需要人工核对'); };
/** ORM builders use unqualified business names. Pin their actual resolution,
 * including implicit pg_temp precedence, before reading or mutating money.
 * No temporary/session-owned substitute can receive a durable release bill. */
export async function assertRechargeRefundBusinessResolutionTx(tx: DbClient) {
  if (Object.hasOwn(tx, '$client')) return fail();
  const [row] = await tx.execute<{ ready: boolean }>(sql`SELECT pg_catalog.current_schema()='public'
    AND pg_catalog.current_setting('session_replication_role')='origin'
    AND pg_catalog.to_regclass('user')=pg_catalog.to_regclass('public.user')
    AND pg_catalog.to_regclass('user_recharge')=pg_catalog.to_regclass('public.user_recharge')
    AND pg_catalog.to_regclass('user_bill')=pg_catalog.to_regclass('public.user_bill') AS ready`);
  if (row?.ready !== true) return fail();
}
export interface RechargeRefundStateRow {
  readonly operation_id: string;
  readonly recharge_id: number;
  readonly admission: 'reserved';
  readonly status: RechargeRefundStatus;
  readonly wallet_state: RechargeRefundWalletState;
  readonly version: number;
  readonly lease_id: string | null;
  readonly lease_until: number | null;
  readonly provider_refund_id: string | null;
  readonly attempt_count: number;
  readonly next_query_at: number | null;
  readonly last_result_id: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

/** Shape validation of a mutable projection. This is never sufficient proof
 * of successful/refused provider money. Terminal readers additionally verify
 * the immutable result chain and local accounting receipts. */
export function captureRechargeRefundState(input: unknown, operation: RechargeRefundRecord): Readonly<RechargeRefundStateRow> {
  const row = captureRechargeRefundRecord('recharge_refund_state', input);
  if (operation.admission !== 'reserved' || row.operation_id !== operation.operation_id || row.recharge_id !== operation.recharge_id
    || row.admission !== 'reserved' || !['RESERVED','SUBMITTING','PROCESSING','UNKNOWN','SUCCEEDED','FAILED'].includes(String(row.status))
    || row.wallet_state !== (row.status === 'SUCCEEDED' ? 'captured' : row.status === 'FAILED' ? 'released' : 'held')
    || typeof row.version !== 'number' || row.version < 0 || typeof row.attempt_count !== 'number' || row.attempt_count < 0
    || row.created_at !== operation.created_at || typeof row.updated_at !== 'number' || row.updated_at < Number(row.created_at)
    || (row.lease_id === null) !== (row.lease_until === null)
    || row.lease_until !== null && (typeof row.lease_until !== 'number' || row.lease_until <= 0)
    || row.next_query_at !== null && (typeof row.next_query_at !== 'number' || row.next_query_at <= 0)
    || row.provider_refund_id !== null && (typeof row.provider_refund_id !== 'string' || !row.provider_refund_id || row.provider_refund_id.length > 128)
    || ['SUCCEEDED','FAILED','RESERVED'].includes(String(row.status)) && (row.lease_id !== null || row.next_query_at !== null)
    || row.status === 'SUBMITTING' && row.lease_id === null) return fail();
  return Object.freeze({ ...row }) as unknown as Readonly<RechargeRefundStateRow>;
}

export async function readRechargeRefundStateTx(tx: DbClient, operation: RechargeRefundRecord, locked = true) {
  const query = sql`SELECT * FROM public.recharge_refund_state WHERE operation_id=${operation.operation_id}::uuid LIMIT 2`;
  if (locked) query.append(sql` FOR UPDATE NOWAIT`);
  const rows = await tx.execute(query);
  if (rows.length !== 1) return fail();
  return captureRechargeRefundState(rows[0], operation);
}

/** The operation MAC authenticates the hold bill ID, original cents and time.
 * A different event, duplicated bill, hand-edited balance or missing bill must
 * never be accepted as authority to credit the wallet or settle external cash. */
export async function assertRechargeRefundHoldBillTx(tx: DbClient, operation: RechargeRefundRecord) {
  await assertRechargeRefundBusinessResolutionTx(tx);
  if (operation.admission !== 'reserved' || typeof operation.operation_id !== 'string'
    || typeof operation.order_no !== 'string' || typeof operation.created_at !== 'number'
    || typeof operation.debit_cents !== 'number' || operation.debit_cents <= 0
    || typeof operation.wallet_before !== 'number' || typeof operation.wallet_after !== 'number'
    || operation.wallet_before - operation.debit_cents !== operation.wallet_after
    || typeof operation.reclaim_gift !== 'boolean' || typeof operation.principal_cents !== 'number'
    || typeof operation.gift_cents !== 'number' || operation.principal_cents <= 0 || operation.gift_cents < 0
    || operation.debit_cents !== operation.principal_cents + (operation.reclaim_gift ? operation.gift_cents : 0)) return fail();
  const source = captureRechargeRefundJson(operation.payment_source);
  if (!source || typeof source !== 'object' || Array.isArray(source)
    || ![2,3].includes(Reflect.ownKeys(source).length) || !Object.hasOwn(source, 'original') || !Object.hasOwn(source, 'holdBillId')
    || Reflect.ownKeys(source).length === 3 && !Object.hasOwn(source, 'refundApproval')) return fail();
  const record = source as Readonly<Record<string, unknown>>;
  // Local release remains possible for an older unused two-field hold. Such
  // a hold has no new transport authority; dispatch must require its own
  // approved-account reference and fresh approval before a sole POST.
  if (Object.hasOwn(record, 'refundApproval')) captureRechargeRefundApprovalReference(record.refundApproval);
  const holdBillId = rechargeRefundId(record.holdBillId), uid = rechargeRefundId(operation.buyer_uid);
  const rows = await tx.select().from(userBill).where(eq(userBill.eventKey, `recharge_refund_hold:${operation.operation_id}`)).limit(2);
  const bill = rows[0];
  if (rows.length !== 1 || bill.id !== holdBillId || bill.uid !== uid || bill.linkId !== operation.order_no
    || bill.pm !== 0 || bill.title !== '充值退款余额预留' || bill.category !== 'now_money' || bill.type !== 'recharge_refund'
    || rechargeRefundCents(bill.number) !== operation.debit_cents || rechargeRefundCents(bill.balance, true) !== operation.wallet_after
    || bill.mark !== (operation.reclaim_gift ? '原路退本金，预留本金及原赠送额' : '原路退本金，保留原赠送额')
    || bill.status !== 1 || bill.take !== 0 || bill.frozenTime !== 0 || bill.addTime !== operation.created_at) return fail();
  return Object.freeze({ billId: holdBillId, uid, original: record.original });
}

export function captureRechargeRefundApprovalReference(input: unknown) {
  const value = captureRechargeRefundJson(input);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Reflect.ownKeys(value).length !== 2) return fail();
  const r = value as Readonly<Record<string, unknown>>;
  if (typeof r.recordId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(r.recordId)
    || typeof r.signature !== 'string' || !/^[a-f0-9]{64}$/.test(r.signature)) return fail();
  return Object.freeze({ recordId: r.recordId, signature: r.signature });
}
