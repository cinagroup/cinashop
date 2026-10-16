import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { assertSupplierOrderEditOperationReady, assertSupplierOrderEditOperationReadable } from '@/migrations/supplierOrderEditOperation';
import { AuthException, ServiceUnavailableException } from '@/utils/errors';
import type { SupplierVideoActor } from './SupplierVideoAuthority';
import { supplierOrderEditCanonical, supplierOrderEditConflict, supplierOrderEditMoney,
  supplierOrderEditOperationId, type SupplierOrderEditIntent } from './SupplierUnpaidOrderEditInput';

export interface SupplierOrderEditResult {
  id: number; order_id: string; pay_price: string; change_price: string; gain_integral: string; changed: boolean;
}
export interface SupplierOrderEditReceipt {
  operation_id: string; actor_id: number; supplier_id: number; order_id: number | null;
  state: 'unknown' | 'committed' | 'not_applied'; result: SupplierOrderEditResult | null;
}
interface OperationRow extends Omit<SupplierOrderEditReceipt, 'order_id' | 'state'> {
  order_id: number; state: 'committed' | 'not_applied'; request_hash: string;
  before_hash: string; after_hash: string; evidence: unknown; created_at: number;
}
export function unknownSupplierOrderEdit(operationId: string, actor: SupplierVideoActor): SupplierOrderEditReceipt {
  return { operation_id: operationId, actor_id: actor.id, supplier_id: actor.supplierId, order_id: null, state: 'unknown', result: null };
}
export function supplierOrderEditReceipt(row: OperationRow): SupplierOrderEditReceipt {
  return { operation_id: row.operation_id, actor_id: row.actor_id, supplier_id: row.supplier_id,
    order_id: row.order_id, state: row.state, result: row.result };
}
export async function lockSupplierOrderEditOperation(tx: DbClient, operationId: string): Promise<void> {
  supplierOrderEditOperationId(operationId);
  const [held] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(731744, hashtext(${operationId})) AS held`);
  if (held?.held !== true) throw supplierOrderEditConflict('原订单编辑操作仍在处理，请查询原操作结果');
  await assertSupplierOrderEditOperationReady(tx);
}
export async function readSupplierOrderEditOperation(tx: DbClient, operationId: string, actor: SupplierVideoActor): Promise<OperationRow | undefined> {
  supplierOrderEditOperationId(operationId); await assertSupplierOrderEditOperationReadable(tx);
  const [row] = await tx.execute(sql`SELECT operation_id::text, actor_id, supplier_id, order_id, request_hash, state,
    before_hash, after_hash, evidence, result, created_at FROM public.supplier_order_edit_operation_v1
    WHERE operation_id = ${operationId}::uuid`) as unknown as OperationRow[];
  if (!row) return;
  if (row.actor_id !== actor.id || row.supplier_id !== actor.supplierId) throw new AuthException('无权读取其他身份的订单编辑操作', 400011);
  const broken = () => new ServiceUnavailableException('订单编辑操作回执不完整');
  if (!Number.isSafeInteger(row.order_id) || row.order_id <= 0 || row.order_id > 2_147_483_647
    || !Number.isSafeInteger(row.created_at) || row.created_at <= 0) throw broken();
  if (row.state === 'not_applied') {
    if (row.request_hash !== '' || row.before_hash !== '' || row.after_hash !== '' || row.result !== null || row.evidence !== null) throw broken();
  } else if (row.state === 'committed') {
    const result = row.result;
    if (![row.request_hash, row.before_hash, row.after_hash].every(value => /^[a-f0-9]{64}$/.test(value))
      || !result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).length !== 6
      || result.id !== row.order_id || !/^[A-Za-z0-9]{1,32}$/.test(result.order_id)
      || !/^-?(?:0|[1-9]\d{0,5})\.\d{2}$/.test(result.change_price)
      || !/^(?:0|[1-9]\d{0,9})\.00$/.test(result.gain_integral) || typeof result.changed !== 'boolean') throw broken();
    try { if (supplierOrderEditMoney(result.pay_price) !== result.pay_price) throw broken(); } catch { throw broken(); }
    if (!row.evidence || typeof row.evidence !== 'object' || Array.isArray(row.evidence)) throw broken();
    const evidence = row.evidence as Record<string, unknown>;
    if (evidence.version !== 'supplier-unpaid-gain-edit-v1' || evidence.operation_id !== operationId
      || !Array.isArray(evidence.lines) || !evidence.lines.length || evidence.lines.length > 200) throw broken();
  } else throw broken();
  return row;
}
export async function replaySupplierOrderEditOperation(tx: DbClient, intent: SupplierOrderEditIntent, actor: SupplierVideoActor): Promise<SupplierOrderEditReceipt | undefined> {
  await lockSupplierOrderEditOperation(tx, intent.operationId);
  const row = await readSupplierOrderEditOperation(tx, intent.operationId, actor);
  if (!row) return;
  if (row.order_id !== intent.orderId || row.state !== 'committed' || row.request_hash !== intent.requestHash)
    throw supplierOrderEditConflict('同一订单编辑操作ID不能更改订单、正文或重用已封存请求');
  return supplierOrderEditReceipt(row);
}
export async function appendSupplierOrderEditOperation(tx: DbClient, input: {
  operationId: string; orderId: number; actor: SupplierVideoActor; now: number;
  requestHash: string; beforeHash: string; afterHash: string; evidence: unknown; result: SupplierOrderEditResult | null;
}): Promise<SupplierOrderEditReceipt> {
  const { operationId, orderId, actor, now, requestHash, beforeHash, afterHash, evidence, result } = input;
  const expected: OperationRow = { operation_id: operationId, actor_id: actor.id, supplier_id: actor.supplierId,
    order_id: orderId, request_hash: requestHash, state: result ? 'committed' : 'not_applied',
    before_hash: beforeHash, after_hash: afterHash, evidence, result, created_at: now };
  const [saved] = await tx.execute(sql`INSERT INTO public.supplier_order_edit_operation_v1
    (operation_id, actor_id, supplier_id, order_id, request_hash, state, before_hash, after_hash, evidence, result, created_at)
    VALUES (${operationId}::uuid, ${actor.id}, ${actor.supplierId}, ${orderId}, ${requestHash}, ${expected.state},
      ${beforeHash}, ${afterHash}, ${evidence === null ? null : JSON.stringify(evidence)}::jsonb,
      ${result === null ? null : JSON.stringify(result)}::jsonb, ${now})
    RETURNING operation_id::text, actor_id, supplier_id, order_id, request_hash, state, before_hash, after_hash, evidence, result, created_at`) as unknown as OperationRow[];
  if (supplierOrderEditCanonical(saved) !== supplierOrderEditCanonical(expected)
    || supplierOrderEditCanonical(await readSupplierOrderEditOperation(tx, operationId, actor)) !== supplierOrderEditCanonical(expected))
    throw supplierOrderEditConflict('订单编辑回执完整回读不一致');
  return supplierOrderEditReceipt(expected);
}
