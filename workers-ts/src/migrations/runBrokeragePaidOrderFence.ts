import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { BROKERAGE_PAID_ORDER_FENCE_SQL } from './brokeragePaidOrderFence';

/** Explicit maintenance runner, not invoked by checkout or automatically on startup.
 * Requires a root DB and an authorized target schema; no order replay or backfill.
 */
export async function runBrokeragePaidOrderFence(
  db: Pick<DbClient, 'transaction'> & Partial<Pick<DbClient, '$client'>>,
  schema = 'public',
): Promise<void> {
  if (!db.$client) throw new Error('Paid-order fence requires a root database');
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema) || schema.startsWith('pg_') || schema === 'information_schema') {
    throw new Error('Invalid paid-order fence schema');
  }
  await db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL search_path TO ${sql.identifier(schema)}, pg_temp`);
    await tx.execute(sql.raw(`SELECT
      pg_catalog.set_config('statement_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),30000)::text || 'ms',true),
      pg_catalog.set_config('idle_in_transaction_session_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true)`));
    await tx.execute(sql.raw(BROKERAGE_PAID_ORDER_FENCE_SQL));
  }, { isolationLevel: 'read committed' });
}
