import { getTableColumns, sql, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { DbClient } from '@/lib/di';
import { ServiceUnavailableException } from '@/utils/errors';

const ROW_CAPACITY = 10_000;
const STRING_COLUMNS = new Set(['PgText', 'PgVarchar', 'PgChar']);

function aggregateInteger(value: unknown): bigint {
  // Both aggregates are explicitly returned as decimal text so neither driver
  // bigint coercion nor a large numeric sum can silently lose precision.
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value) || value.length > 32)
    throw new ServiceUnavailableException('商品详情读取容量统计无效');
  return BigInt(value);
}

/** Preflight raw collections inside the caller's read snapshot. Only aggregate
 * integers leave PostgreSQL; no source text is materialized in the Worker. */
export async function budgetLegacyProductRead(
  tx: DbClient,
  scans: Array<{ table: PgTable; where: SQL }>,
  remainingBytes = 1024 * 1024,
): Promise<number> {
  if (!Number.isSafeInteger(remainingBytes) || remainingBytes < 0)
    throw new ServiceUnavailableException('商品详情读取容量预算无效');
  const budget = BigInt(remainingBytes);
  let used = 0n;
  for (const { table, where } of scans) {
    const columns = Object.values(getTableColumns(table));
    // Fixed fields, property names, separators and row/object bookkeeping are
    // charged even for NULL values; variable strings add their actual DB bytes.
    const fixedBytes = 64 + columns.length * 64;
    const terms = [sql`${fixedBytes}::bigint`, ...columns
      .filter(column => STRING_COLUMNS.has(column.columnType))
      .map(column => sql`coalesce(octet_length(${column})::bigint, 0::bigint)`)];
    const rows = await tx.execute(sql`
      SELECT count(*)::text AS row_count,
        coalesce(sum("legacy_product_read_budget"."row_bytes"), 0)::text AS byte_count
      FROM (
        SELECT (${sql.join(terms, sql` + `)}) AS row_bytes
        FROM ${table}
        WHERE ${where}
        LIMIT ${ROW_CAPACITY + 1}
      ) AS "legacy_product_read_budget"
    `) as unknown as Array<{ row_count: unknown; byte_count: unknown }>;
    if (rows.length !== 1) throw new ServiceUnavailableException('商品详情读取容量统计无效');
    const count = aggregateInteger(rows[0].row_count);
    const bytes = aggregateInteger(rows[0].byte_count);
    if (count > BigInt(ROW_CAPACITY))
      throw new ServiceUnavailableException('商品详情完整集合超过10000项容量');
    used += bytes;
    if (used > budget) throw new ServiceUnavailableException('商品详情完整集合超过读取容量');
  }
  return Number(used);
}
