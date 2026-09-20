import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { ValidateException } from '@/utils/errors';

/** Caller must provide its active transaction, never an autocommit client.
 * Keep the existing single-bigint withdrawal key for writer compatibility.
 * Order/cart/user locks precede this mutex; supplier ledger/extract row locks
 * follow it. Never acquire new order/user locks or perform external I/O afterwards.
 * At READ COMMITTED, read balances in statements AFTER this lock is acquired.
 * Refunds serialize here but must not be rejected for a supplier deficit. */
export async function lockSupplierFinance(tx: Pick<DbClient, 'execute'>, supplierId: number): Promise<void> {
  if (!Number.isSafeInteger(supplierId) || supplierId <= 0 || supplierId > 2147483647) {
    throw new ValidateException('供应商财务身份无效');
  }
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${supplierId}::bigint)`);
}
