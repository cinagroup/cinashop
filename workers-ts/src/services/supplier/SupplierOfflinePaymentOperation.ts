import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { assertSupplierOfflinePaymentOperationReady, assertSupplierOfflinePaymentOperationReadable } from '@/migrations/supplierOfflinePaymentOperation';
import { AuthException, ServiceUnavailableException } from '@/utils/errors';
import type { SupplierVideoActor } from './SupplierVideoAuthority';
import { prepareSupplierOfflinePayment, supplierPaymentCanonical, supplierPaymentConflict, supplierPaymentHash,
  supplierPaymentOperationId, type SupplierOfflinePaymentIntent } from './SupplierOfflinePaymentInput';
import type { storeOrder, storeOrderCartInfo, storeOrderStatus, storeOrderOutbox } from '@/models/schema';

export interface SupplierOfflinePaymentResult { id: number; order_no: string; paid: 1; pay_type: 'offline'; pay_price: string; pay_time: number }
export interface SupplierOfflinePaymentReceipt {
  operation_id: string; actor_id: number; supplier_id: number; order_id: number | null;
  state: 'unknown' | 'committed' | 'not_applied'; result: SupplierOfflinePaymentResult | null;
}
export interface SupplierOfflinePaymentSource {
  order: typeof storeOrder.$inferSelect; carts: (typeof storeOrderCartInfo.$inferSelect)[];
  statuses: (typeof storeOrderStatus.$inferSelect)[]; outboxes: (typeof storeOrderOutbox.$inferSelect)[];
}
export interface SupplierOfflinePaymentEvidence { primary_audit_id: number; outbox_id: number }
export interface SupplierOfflinePaymentRow extends Omit<SupplierOfflinePaymentReceipt, 'order_id' | 'state'> {
  order_id: number; state: 'committed' | 'not_applied'; request_hash: string;
  intent: SupplierOfflinePaymentIntent | null; source: SupplierOfflinePaymentSource | null;
  source_hash: string; evidence: SupplierOfflinePaymentEvidence | null; created_at: number;
}
const broken = () => new ServiceUnavailableException('供应商收款原请求或不可变凭据不完整');
const fact = (ok: unknown) => { if (!ok) throw broken(); };
export const supplierOfflinePaymentReceipt = (row: SupplierOfflinePaymentRow): SupplierOfflinePaymentReceipt => ({ operation_id: row.operation_id,
  actor_id: row.actor_id, supplier_id: row.supplier_id, order_id: row.order_id, state: row.state, result: row.result });
export const unknownSupplierOfflinePayment = (id: string, actor: SupplierVideoActor): SupplierOfflinePaymentReceipt => ({ operation_id: id,
  actor_id: actor.id, supplier_id: actor.supplierId, order_id: null, state: 'unknown', result: null });
export async function lockSupplierOfflinePaymentOperation(tx: DbClient, id: string) {
  supplierPaymentOperationId(id);
  const [row] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(731746,hashtext(${id})) AS held`);
  if (row?.held !== true) throw supplierPaymentConflict('原收款操作仍在处理，请查询原结果');
  await assertSupplierOfflinePaymentOperationReady(tx);
}
/** Also used by the refund source reader. Its authority is the protected row,
 * never today's roles or the mutable order's staff_id. */
export async function loadSupplierOfflinePaymentOperation(tx: DbClient, id: string): Promise<SupplierOfflinePaymentRow | undefined> {
  supplierPaymentOperationId(id); await assertSupplierOfflinePaymentOperationReadable(tx);
  const [row] = await tx.execute(sql`SELECT operation_id::text,actor_id,supplier_id,order_id,request_hash,state,intent,source,
    source_hash,evidence,result,created_at FROM public.supplier_offline_payment_operation_v1 WHERE operation_id=${id}::uuid`) as unknown as SupplierOfflinePaymentRow[];
  if (!row) return;
  return validateSupplierOfflinePaymentRow(row, id);
}
export function validateSupplierOfflinePaymentRow(row: SupplierOfflinePaymentRow, id: string): SupplierOfflinePaymentRow {
  supplierPaymentOperationId(id); fact(row.operation_id === id);
  fact(Number.isSafeInteger(row.actor_id) && row.actor_id > 0 && Number.isSafeInteger(row.supplier_id) && row.supplier_id > 0
    && Number.isSafeInteger(row.order_id) && row.order_id > 0 && Number.isSafeInteger(row.created_at) && row.created_at > 0);
  if (row.state === 'not_applied') {
    fact(row.request_hash === '' && row.source_hash === '' && row.intent === null && row.source === null && row.evidence === null && row.result === null);
  } else {
    fact(row.state === 'committed' && row.intent && row.source && row.result && row.evidence
      && /^[a-f0-9]{64}$/.test(row.request_hash) && /^[a-f0-9]{64}$/.test(row.source_hash));
    const input = row.intent!, { version, actor_id, supplier_id, order_id, ...body } = input;
    fact(supplierPaymentCanonical(prepareSupplierOfflinePayment(row.order_id, body, { id: row.actor_id, supplierId: row.supplier_id } as SupplierVideoActor)) === supplierPaymentCanonical(input)
      && supplierPaymentHash(input) === row.request_hash && supplierPaymentHash(row.source) === row.source_hash);
    const source = row.source!, result = row.result!, evidence = row.evidence!;
    fact(Object.keys(source).sort().join(',') === 'carts,order,outboxes,statuses' && source.order?.id === row.order_id
      && source.order.supplierId === row.supplier_id && source.order.orderId === input.order_no && source.order.payPrice === input.amount
      && source.order.paid === 0 && source.order.payType === 'offline' && source.order.pid === 0
      && Array.isArray(source.carts) && source.carts.length > 0 && source.carts.length <= 200
      && source.carts.every(c => c.oid === row.order_id && c.uid === source.order.uid)
      && Array.isArray(source.statuses) && source.statuses.length <= 1000 && source.statuses.every(s => s.oid === row.order_id)
      && Array.isArray(source.outboxes) && source.outboxes.length <= 1000 && source.outboxes.every(o => o.aggregateType === 'order' && o.aggregateId === row.order_id));
    fact(Object.keys(result).sort().join(',') === 'id,order_no,paid,pay_price,pay_time,pay_type' && result.id === row.order_id && result.order_no === input.order_no
      && result.paid === 1 && result.pay_type === 'offline' && result.pay_price === input.amount && result.pay_time === row.created_at
      && Object.keys(evidence).sort().join(',') === 'outbox_id,primary_audit_id'
      && Number.isSafeInteger(evidence.primary_audit_id) && evidence.primary_audit_id > 0 && Number.isSafeInteger(evidence.outbox_id) && evidence.outbox_id > 0);
  }
  return row;
}
export async function readSupplierOfflinePaymentOperation(tx: DbClient, id: string, actor: SupplierVideoActor) {
  const row = await loadSupplierOfflinePaymentOperation(tx, id);
  if (row && (row.actor_id !== actor.id || row.supplier_id !== actor.supplierId)) throw new AuthException('无权读取其他供应商或账号的收款操作', 400011);
  return row;
}
export async function replaySupplierOfflinePaymentOperation(tx: DbClient, intent: SupplierOfflinePaymentIntent, actor: SupplierVideoActor) {
  await lockSupplierOfflinePaymentOperation(tx, intent.operation_id);
  const row = await readSupplierOfflinePaymentOperation(tx, intent.operation_id, actor);
  if (!row) return;
  if (row.state !== 'committed' || row.order_id !== intent.order_id || row.request_hash !== supplierPaymentHash(intent))
    throw supplierPaymentConflict('同一收款操作ID不能改写原请求或重用已封存请求');
  return supplierOfflinePaymentReceipt(row);
}
export async function appendSupplierOfflinePaymentOperation(tx: DbClient, row: SupplierOfflinePaymentRow) {
  const [saved] = await tx.execute(sql`INSERT INTO public.supplier_offline_payment_operation_v1
    (operation_id,actor_id,supplier_id,order_id,request_hash,state,intent,source,source_hash,evidence,result,created_at)
    VALUES(${row.operation_id}::uuid,${row.actor_id},${row.supplier_id},${row.order_id},${row.request_hash},${row.state},
      ${row.intent === null ? null : JSON.stringify(row.intent)}::jsonb,${row.source === null ? null : JSON.stringify(row.source)}::jsonb,${row.source_hash},
      ${row.evidence === null ? null : JSON.stringify(row.evidence)}::jsonb,${row.result === null ? null : JSON.stringify(row.result)}::jsonb,${row.created_at})
    RETURNING operation_id::text,actor_id,supplier_id,order_id,request_hash,state,intent,source,source_hash,evidence,result,created_at`);
  if (supplierPaymentCanonical(saved) !== supplierPaymentCanonical(row)
    || supplierPaymentCanonical(await loadSupplierOfflinePaymentOperation(tx, row.operation_id)) !== supplierPaymentCanonical(row))
    throw supplierPaymentConflict('收款凭据完整回读不一致');
  return supplierOfflinePaymentReceipt(row);
}
