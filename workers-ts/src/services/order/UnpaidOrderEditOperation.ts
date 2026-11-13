import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { assertSupplierOrderEditOperationReadable } from '@/migrations/supplierOrderEditOperation';
import { assertAdminOrderPriceOperationReadable } from '@/migrations/adminOrderPriceOperation';
import { assertAdminOrderEditOperationReadable } from '@/migrations/adminOrderEditOperation';
import { ValidateException } from '@/utils/errors';

export interface UnpaidOrderEditOperation {
  kind: 'supplier' | 'admin' | 'admin-edit';
  operation_id: string; actor_id: number; supplier_id: number; order_id: number; state: string;
  request_hash: string; before_hash: string; after_hash: string;
  evidence: Record<string, unknown> & { source: { order_id: number; buyer_id: number; supplier_id: number }; status_id: number }; result: Record<string, unknown>; created_at: number;
}
const invalid = () => new ValidateException('受保护订单编辑回执缺失、冲突或归属不一致');

/** An outbox reference never selects the authority realm. Inspect every present
 * protected ledger and reject UUID collisions, including across realms. An
 * absent addon imposes no new catalog or grant on historical Supplier readers. */
async function locateUnpaidOrderEditOperation(db: Pick<DbClient, 'execute'>, id: string): Promise<UnpaidOrderEditOperation> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw invalid();
  const result: UnpaidOrderEditOperation[] = [];
  for (const kind of ['supplier', 'admin', 'admin-edit'] as const) {
    const table = kind === 'supplier' ? 'supplier_order_edit_operation_v1' : kind === 'admin' ? 'admin_order_price_operation_v1' : 'admin_order_edit_operation_v1';
    const [catalog] = await db.execute(sql`SELECT to_regclass(${'public.' + table}) IS NOT NULL AS present`);
    if (!catalog?.present) continue;
    if (kind === 'supplier') await assertSupplierOrderEditOperationReadable(db);
    else if (kind === 'admin') await assertAdminOrderPriceOperationReadable(db);
    else await assertAdminOrderEditOperationReadable(db);
    const rows = await db.execute(sql`SELECT operation_id::text,actor_id,supplier_id,order_id,state,request_hash,before_hash,after_hash,
      CASE WHEN octet_length(evidence::text)<=196608 THEN evidence ELSE NULL END AS evidence,result,created_at
      FROM ${sql.raw('public.' + table)} WHERE operation_id=${id}::uuid`) as unknown as UnpaidOrderEditOperation[];
    result.push(...rows.map(row => ({ ...row, kind })));
  }
  if (result.length !== 1) throw invalid();
  const row = result[0], e = row.evidence, r = row.result;
  if (row.operation_id !== id || row.state !== 'committed' || !Number.isSafeInteger(row.actor_id) || row.actor_id <= 0
    || !Number.isSafeInteger(row.supplier_id) || row.supplier_id < (row.kind === 'supplier' ? 1 : 0)
    || !Number.isSafeInteger(row.order_id) || row.order_id <= 0 || !Number.isSafeInteger(row.created_at) || row.created_at <= 0
    || [row.request_hash, row.before_hash, row.after_hash].some(hash => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))
    || !e || typeof e !== 'object' || Array.isArray(e) || !r || typeof r !== 'object' || Array.isArray(r)
    || e.version !== (row.kind === 'supplier' ? 'supplier-unpaid-gain-edit-v1' : row.kind === 'admin' ? 'admin-unpaid-price-v1' : 'admin-unpaid-gain-edit-v1')
    || !e.source || typeof e.source !== 'object' || Array.isArray(e.source)
    || e.source.order_id !== row.order_id || e.source.supplier_id !== row.supplier_id
    || !Number.isSafeInteger(e.source.buyer_id) || e.source.buyer_id < 0
    || e.operation_id !== id || r.id !== row.order_id || typeof r.changed !== 'boolean' || Object.keys(r).length !== 6) throw invalid();
  return row;
}

/** Financial gain provenance predates the status-linked cashier chain. Keep
 * its independently validated receipt admission while checking every realm for
 * UUID collisions. It cannot be substituted for a cashier edit proof. */
export async function readUnpaidOrderGainEditOperation(db: Pick<DbClient, 'execute'>, id: string) {
  const row = await locateUnpaidOrderEditOperation(db, id);
  if (row.kind === 'admin') throw invalid();
  return row;
}
export async function readUnpaidOrderEditOperation(db: Pick<DbClient, 'execute'>, id: string): Promise<UnpaidOrderEditOperation> {
  const row = await locateUnpaidOrderEditOperation(db, id);
  if (!Number.isSafeInteger(row.evidence.status_id) || row.evidence.status_id <= 0 || row.result.changed !== true) throw invalid();
  return row;
}
