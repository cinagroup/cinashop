import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { ValidateException } from '@/utils/errors';

/** Reserve the actual snapshot primary keys inside an existing order transaction.
 * A new split cart uses the same positive integer for its row ID and cart_id,
 * so numeric refund selectors cannot collide with another row's legacy alias.
 * Sequence gaps on rollback are intentional; never MAX+1 or reset a sequence.
 * The transaction-local search_path selects the table and its owned sequence. */
export async function reserveOrderCartRowIds(tx: DbClient, count: number): Promise<number[]> {
  if (Object.hasOwn(tx, '$client')) throw Error('Order cart identities require an order transaction');
  if (!Number.isSafeInteger(count) || count < 1 || count > 400) throw new ValidateException('拆单商品数量无效');
  const rows = await tx.execute<{ id: number }>(sql`
    SELECT nextval(pg_get_serial_sequence('store_order_cart_info', 'id'))::integer AS id
    FROM generate_series(1, ${count}) AS item(position) ORDER BY item.position
  `);
  const ids = rows.map(row => row.id);
  if (ids.length !== count || new Set(ids).size !== count
    || ids.some(id => !Number.isSafeInteger(id) || id <= 0 || id > 2147483647)) {
    throw new ValidateException('拆单商品标识分配失败');
  }
  return ids;
}
