/** Explicit prospective owner-only migration. The business producer, runtime
 * grants, Queue/scanner and replay author require a separate reviewed successor.
 * Installing this storage never grants a label or changes a paid order. */
import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { PURCHASED_PRODUCT_LABEL_SQL } from './purchasedProductLabelContract';
import { capturePurchasedLabelStorageTarget, inspectPurchasedLabelStorage, PURCHASED_LABEL_STORAGE_GATE,
  type PurchasedLabelStorageTarget } from './purchasedProductLabelStorage';

type Query = Pick<DbClient, 'execute'>;
export interface PurchasedLabelStorageAddon { purchasedProductLabels: true }
export function capturePurchasedLabelStorageAddon(input: PurchasedLabelStorageAddon): Readonly<PurchasedLabelStorageAddon> {
  if (!input || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Reflect.ownKeys(input).length !== 1)
    throw Error('Explicit purchased product label storage intent required');
  const d = Object.getOwnPropertyDescriptor(input, 'purchasedProductLabels');
  if (!d?.enumerable || !('value' in d) || d.value !== true) throw Error('Data-only purchased product label storage intent required');
  return Object.freeze({ purchasedProductLabels: true });
}

export async function installPurchasedProductLabelStorageInTransaction(tx: Query, input: PurchasedLabelStorageTarget,
  addon: PurchasedLabelStorageAddon) {
  const target = capturePurchasedLabelStorageTarget(input); capturePurchasedLabelStorageAddon(addon);
  if (Object.hasOwn(tx, '$client')) throw Error('Caller-owned purchased label maintenance transaction required');
  await tx.execute(sql`SELECT pg_catalog.set_config('search_path','public,pg_temp',true),
    pg_catalog.set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
    pg_catalog.set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true)`);
  const [identity] = await tx.execute<{ ready: boolean }>(sql`SELECT
    pg_catalog.current_database()=${target.database} AND current_user=${target.maintenance} AND current_user=session_user
    AND pg_catalog.current_setting('role')='none' AND r.rolsuper AND r.rolcanlogin
    AND r.oid=(SELECT usesysid FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid())
    AND pg_catalog.current_setting('server_version_num')::integer/10000=16
    AND pg_catalog.current_setting('transaction_isolation')='read committed'
    AND pg_catalog.current_setting('transaction_read_only')='off'
    AND pg_catalog.current_setting('session_replication_role')='origin'
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS ready
    FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`);
  if (identity?.ready !== true) throw Error('Actual named PG16 maintenance LOGIN/database required');
  const [gate] = await tx.execute<{ locked: boolean }>(sql`SELECT pg_catalog.pg_try_advisory_xact_lock(
    ${PURCHASED_LABEL_STORAGE_GATE[0]},${PURCHASED_LABEL_STORAGE_GATE[1]}) AS locked`);
  if (gate?.locked !== true) throw Error('Purchased product label storage maintenance is busy');
  const before = await inspectPurchasedLabelStorage(tx, target);
  if (before.present && !before.storageReady) throw Error('Purchased label catalog drift; no repair: '+before.failures.join(','));
  if (before.present) {
    await tx.execute(sql`LOCK TABLE ONLY public.store_order_outbox, ONLY public.purchased_product_label_intent, ONLY public.purchased_product_label_state,
      ONLY public.purchased_product_label_result IN ACCESS SHARE MODE NOWAIT`);
    if (!(await inspectPurchasedLabelStorage(tx, target)).storageReady) throw Error('Locked purchased label storage differs');
    return { applied: false as const, target, runtimeReady: false as const };
  }
  // Bind the structural parent FK to a real ordinary public table, without
  // claiming that arbitrary rows are valid payment or author evidence.
  await tx.execute(sql`LOCK TABLE ONLY public.store_order_outbox IN ACCESS SHARE MODE NOWAIT`);
  const [parent] = await tx.execute<{ safe: boolean }>(sql`SELECT c.relkind='r' AND c.relpersistence='p'
    AND NOT c.relispartition AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity AND NOT c.relhasrules
    AND c.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${target.maintenance})
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid=c.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_publication_rel WHERE prrelid=c.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_publication WHERE puballtables)
    AS safe FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass('public.store_order_outbox')`);
  if (parent?.safe !== true) throw Error('Owned ordinary payment Outbox parent required');
  await tx.execute(sql.raw(PURCHASED_PRODUCT_LABEL_SQL));
  const after = await inspectPurchasedLabelStorage(tx, target);
  if (!after.storageReady) throw Error('Fresh purchased label owner-only catalog refused: '+after.failures.join(','));
  return { applied: true as const, target, runtimeReady: false as const };
}

export async function installPurchasedProductLabelStorage(db: DbClient, input: PurchasedLabelStorageTarget,
  addon: PurchasedLabelStorageAddon) {
  const target = capturePurchasedLabelStorageTarget(input), captured = capturePurchasedLabelStorageAddon(addon);
  if (!Object.hasOwn(db, '$client') || !db.$client) throw Error('Root purchased label maintenance connection required');
  return db.transaction(tx => installPurchasedProductLabelStorageInTransaction(tx, target, captured),
    { isolationLevel: 'read committed', accessMode: 'read write' });
}
