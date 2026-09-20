import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import type { DbClient } from '../lib/di';

const referenceColumns = ['order_id', 'order_no', 'order_id_key', 'store_order_id', 'source_order_id',
  'payment_order_id', 'selected_order_id', 'remaining_order_id', 'root_order_id', 'child_order_id',
  'fulfilled_order_id', 'oid', 'link_id', 'aggregate_id'];
export const ORPHAN_TEST_PREDICATE = `o.uid>0 AND o.pid<>-1 AND o.paid=1 AND o.is_del=0
  AND o.refund_status IN (0,3) AND o.pay_price<>0 AND NOT EXISTS(SELECT 1 FROM public."user" u WHERE u.uid=o.uid)`;
export const snapshotHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function configureOrphanInspection(tx: postgres.TransactionSql) {
  await tx`SELECT set_config('search_path','public,pg_temp',true),
    set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
    set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
    set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`;
}

/** Private snapshot only, never deletion authority. Polymorphic/numeric matches
 * are candidates until their business domain and ownership have been reviewed.
 * JSON remains text so numeric values are not rounded by JavaScript parsing. */
export async function collectOrphanTestOrderSnapshot(tx: postgres.TransactionSql) {
  const orders = Array.from(await tx.unsafe<{ id: number; row_json: string }[]>(`SELECT o.id,to_jsonb(o)::text AS row_json
    FROM public.store_order o WHERE ${ORPHAN_TEST_PREDICATE} ORDER BY o.id LIMIT 13`));
  if (orders.length !== 12 || orders.some(o => !Number.isSafeInteger(o.id) || o.id <= 0)
    || new Set(orders.map(o => o.id)).size !== 12) throw Error('Authorized twelve-order target has changed');
  const ids = orders.map(o => String(o.id));
  const orderNos: string[] = [];
  for (const order of orders) {
    const row: unknown = JSON.parse(order.row_json);
    if (!row || typeof row !== 'object' || !('order_id' in row) || typeof row.order_id !== 'string'
      || !/^[A-Za-z0-9_-]{1,64}$/.test(row.order_id)) throw Error('Unsupported order identity');
    orderNos.push(row.order_id);
  }
  const references = [...new Set([...ids, ...orderNos])];
  const candidates = await tx<{ table_name: string; columns: string[] }[]>`SELECT c.relname AS table_name,
    array_agg(a.attname::text ORDER BY a.attname COLLATE "C") AS columns
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    WHERE n.nspname='public' AND c.relkind='r' AND c.relname<>'store_order'
    AND (a.attname=ANY(${referenceColumns}::text[]) OR a.attname='payload')
    GROUP BY c.relname ORDER BY c.relname COLLATE "C" LIMIT 101`;
  if (candidates.length > 100 || candidates.some(t => !/^[a-z][a-z0-9_]*$/.test(t.table_name)))
    throw Error('Reference identifier or table budget exceeded');
  const related: { table: string; columns: string[]; rows: string[]; sha256: string }[] = [];
  let bytes = Buffer.byteLength(JSON.stringify(orders));
  if (bytes > 5_000_000) throw Error('Private snapshot byte budget exceeded');
  for (const candidate of candidates) {
    const columns = candidate.columns.filter(c => referenceColumns.includes(c));
    const [batch] = await tx.unsafe<{ rows: string[] | null; count: number; bytes: number }[]>(`WITH matches AS MATERIALIZED (SELECT j.data::text AS row_json
      FROM public."${candidate.table_name}" t CROSS JOIN LATERAL (SELECT to_jsonb(t) AS data) j
      WHERE EXISTS(SELECT 1 FROM unnest($1::text[]) k WHERE j.data->>k=ANY($2::text[]))
        OR (j.data->'payload'->>'orderId')=ANY($3::text[])
        OR (j.data->'payload'->>'orderNo')=ANY($2::text[])
      ORDER BY j.data::text COLLATE "C" LIMIT 1001),
      budget AS (SELECT count(*)::integer AS count,COALESCE(sum(octet_length(row_json)),0)::integer AS bytes FROM matches)
      SELECT count,bytes,CASE WHEN count<=1000 AND bytes<=$4 THEN
        (SELECT COALESCE(jsonb_agg(row_json ORDER BY row_json COLLATE "C"),'[]'::jsonb) FROM matches) END AS rows FROM budget`,
      [columns, references, ids, 5_000_000 - bytes]);
    if (!batch || batch.count > 1000) throw Error('Reference row budget exceeded');
    if (!Array.isArray(batch.rows) || batch.rows.some(r => typeof r !== 'string')) throw Error('Private snapshot byte budget exceeded');
    const content = batch.rows;
    bytes += Buffer.byteLength(JSON.stringify(content));
    if (bytes > 5_000_000) throw Error('Private snapshot byte budget exceeded');
    related.push({ table: candidate.table_name, columns: candidate.columns, rows: content, sha256: snapshotHash(content) });
  }
  const descendants = Array.from(await tx<{ id: number; row_json: string }[]>`SELECT o.id,to_jsonb(o)::text AS row_json
    FROM public.store_order o WHERE o.pid::text=ANY(${ids}::text[]) AND NOT o.id::text=ANY(${ids}::text[])
    ORDER BY o.id LIMIT 101`);
  if (descendants.length > 100) throw Error('Descendant order budget exceeded');
  const foreignKeys = Array.from(await tx`SELECT c.conname AS name,c.conrelid::regclass::text AS child,
    c.confrelid::regclass::text AS parent,pg_get_constraintdef(c.oid,false) AS definition
    FROM pg_catalog.pg_constraint c WHERE c.contype='f' AND c.connamespace='public'::regnamespace
    ORDER BY c.conname COLLATE "C"`);
  return { orders, related, descendants, foreignKeys };
}

export async function exportOrphanTestOrderSnapshot(db: Pick<DbClient, '$client'>) {
  if (!db.$client) throw Error('Root database required');
  return db.$client.begin('isolation level repeatable read read only', async tx => {
    await configureOrphanInspection(tx);
    const [identity] = await tx`SELECT current_database() AS database,current_user AS role,
      current_setting('server_version_num')::integer AS version,current_setting('transaction_read_only') AS read_only`;
    if (identity?.database !== 'postgres' || identity?.role !== 'postgres' || identity?.read_only !== 'on'
      || Math.floor(Number(identity?.version)/10000) !== 16) throw Error('Unexpected export target');
    const snapshot = await collectOrphanTestOrderSnapshot(tx);
    return { scope: 'orphan-test-order-backup', ready: false, targetCount: 12, snapshotSha256: snapshotHash(snapshot),
      candidateTables: snapshot.related.filter(r => r.rows.length).map(r => ({ table: r.table, rows: r.rows.length })),
      descendantOrders: snapshot.descendants.length, backup: { version: 1, identity, ...snapshot },
      limitation: 'Private read-only backup and candidate links; no deletion performed or inferred' };
  });
}
