import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { SHIPPING_CREATE_REPLAY_INSTALLATION_SQL } from './shippingTemplateCreateReplayInstallation';
import { SHIPPING_CREATE_REPLAY_COMPATIBILITY_SQL } from './shippingTemplateCreateReplayCatalog';

/** Read-only catalog check for the maintenance owner, not a business-row query. */
export async function inspectShippingTemplateCreateReplay(db: Pick<DbClient, 'execute'>) {
  const [row] = await db.execute(sql.raw(SHIPPING_CREATE_REPLAY_COMPATIBILITY_SQL));
  if (!row || typeof row.present !== 'boolean') throw new Error('Shipping replay catalog unavailable');
  return { present: row.present, complete: row.compatible === true, oid: row.oid };
}

/** Existing installations call only this bounded root transaction, never runAll. */
export async function runShippingTemplateCreateReplay(db: Pick<DbClient, 'transaction'> & Partial<Pick<DbClient, '$client'>>): Promise<void> {
  if (!db.$client) throw new Error('Shipping replay installation requires a root database');
  await db.transaction(async tx => {
    await tx.execute(sql.raw(SHIPPING_CREATE_REPLAY_INSTALLATION_SQL));
  }, { isolationLevel: 'read committed', accessMode: 'read write' });
}
