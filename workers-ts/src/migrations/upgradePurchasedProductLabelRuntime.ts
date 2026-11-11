/** Formal forward-only commissioning. Caller declares the complete existing
 * five profiles plus the new fixed App/Admin addon before the first SQL await. */
import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { capturePurchasedLabelRuntimeDeclaration } from '@/services/order/PurchasedProductLabelRuntimeDeclaration';
import type { RuntimeGiftPeerDeclarations } from './customerRuntimeGiftPeers';
import { inspectReviewedRuntimeGiftPeers } from './customerRuntimeGiftPeers';
import { inspectRuntimeBusinessProfileInTransaction } from './auditRuntimeBusinessPrivileges';
import type { RuntimeAppCashierOriginReaderAddon } from './runtimeAppCashierOriginReader';
import { captureRuntimeAppCashierOriginReader } from './runtimeAppCashierOriginReader';
import { inspectPurchasedLabelStorage, PURCHASED_LABEL_STORAGE_GATE } from './purchasedProductLabelStorage';
import { inspectPurchasedLabelRuntime, purchasedLabelNamedBinding } from './purchasedProductLabelRuntime';
import { FULFILLMENT_CITY_CONFLICT_GATE } from './fulfillmentCityConflictReader';
import { STORE_ORDER_FULFILLMENT_ASSIGNMENTS_GATE } from './storeOrderFulfillmentAssignment';
import { PURCHASED_LABEL_TABLE_PRIVILEGES, PURCHASED_LABEL_STATE_UPDATE } from './purchasedProductLabelPermissions';

type Query = Pick<DbClient, 'execute'>;
export async function upgradePurchasedProductLabelRuntimeInTransaction(tx: Query, declaration: RuntimeGiftPeerDeclarations,
  appReader?: RuntimeAppCashierOriginReaderAddon) {
  const peers = capturePurchasedLabelRuntimeDeclaration(declaration), t = peers.target;
  const reader = appReader === undefined ? undefined : captureRuntimeAppCashierOriginReader(appReader);
  if (Object.hasOwn(tx, '$client')) throw Error('Caller-owned purchased label commissioning transaction required');
  await tx.execute(sql`SET LOCAL search_path TO public,pg_temp`);
  await tx.execute(sql`SELECT
    pg_catalog.set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
    pg_catalog.set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
    pg_catalog.set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
  const [identity] = await tx.execute<{ ready: boolean }>(sql`SELECT pg_catalog.current_database()=${t.database}
    AND current_user=${t.maintenance} AND current_user=session_user AND pg_catalog.current_setting('role')='none'
    AND r.rolsuper AND r.rolcanlogin AND r.oid=(SELECT usesysid FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid())
    AND pg_catalog.current_setting('server_version_num')::int/10000=16
    AND pg_catalog.current_setting('transaction_isolation')='read committed' AND pg_catalog.current_setting('transaction_read_only')='off'
    AND pg_catalog.current_setting('session_replication_role')='origin'
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS ready
    FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`);
  if (identity?.ready !== true) throw Error('Actual named PG16 purchased label maintenance LOGIN required');
  for (const [key, subkey] of [[731669,0],[731670,0],[731625,2],[731624,0],[731685,0],[731812,1],
    [731714,0],[731717,0],[731718,0],[731719,0],[731735,0],FULFILLMENT_CITY_CONFLICT_GATE,[731722,0],STORE_ORDER_FULFILLMENT_ASSIGNMENTS_GATE,PURCHASED_LABEL_STORAGE_GATE]) {
    const [gate] = await tx.execute<{ held: boolean }>(sql`SELECT pg_catalog.pg_try_advisory_xact_lock(${key},${subkey}) AS held`);
    if (gate?.held !== true) throw Error('Purchased label profile commissioning is busy');
  }
  await tx.execute(sql`LOCK TABLE ONLY public.purchased_product_label_intent,ONLY public.purchased_product_label_state,
    ONLY public.purchased_product_label_result IN ACCESS EXCLUSIVE MODE NOWAIT`);
  await tx.execute(sql`LOCK TABLE ONLY public.store_order_outbox IN ACCESS SHARE MODE NOWAIT`);
  const profiles = async (p: RuntimeGiftPeerDeclarations) => {
    const app = await inspectRuntimeBusinessProfileInTransaction(tx, 'app', t, 'current', p, reader);
    const admin = await inspectRuntimeBusinessProfileInTransaction(tx, 'admin', t, 'current', p);
    const others = await inspectReviewedRuntimeGiftPeers(tx, { app: t.app, admin: t.admin }, t.maintenance, p);
    if (!app.ready || !admin.ready || !others.ready) throw Error('Complete five purchased label profiles required: '+
      [...app.failures.map(f => 'app:'+f), ...admin.failures.map(f => 'admin:'+f), ...others.failures].slice(0,32).join(','));
  };
  const existing = await inspectPurchasedLabelRuntime(tx, t, peers.purchasedProductLabels!);
  if (existing.ready) {
    await profiles(peers);
    return { applied: false as const, binding: existing.binding!, peers };
  }
  const ownerOnly = await inspectPurchasedLabelStorage(tx, { database: t.database, maintenance: t.maintenance });
  const [comment] = await tx.execute<{ value: string | null }>(sql`SELECT pg_catalog.obj_description(
    pg_catalog.to_regclass('public.purchased_product_label_intent'),'pg_class') AS value`);
  if (!ownerOnly.storageReady || comment?.value !== null) throw Error('Exact unbound owner-only purchased label storage required; no repair');
  const { purchasedProductLabels: _, ...previous } = peers;
  await profiles(previous);
  const binding = await purchasedLabelNamedBinding(tx, t);
  for (const kind of ['app', 'admin'] as const) {
    for (const [table, privileges] of Object.entries(PURCHASED_LABEL_TABLE_PRIVILEGES[kind]))
      await tx.execute(sql`GRANT ${sql.raw(privileges.join(','))} ON TABLE public.${sql.identifier(table)} TO ${sql.identifier(t[kind])}`);
    await tx.execute(sql`GRANT UPDATE (${sql.join(PURCHASED_LABEL_STATE_UPDATE[kind].map(c => sql.identifier(c)), sql`,`)})
      ON TABLE public.purchased_product_label_state TO ${sql.identifier(t[kind])}`);
  }
  const text = JSON.stringify(binding);
  await tx.execute(sql.raw("COMMENT ON TABLE public.purchased_product_label_intent IS '"+text.replaceAll("'", "''")+"'"));
  const after = await inspectPurchasedLabelRuntime(tx, t, peers.purchasedProductLabels!);
  if (!after.ready || JSON.stringify(after.binding) !== JSON.stringify(binding)) throw Error('Purchased label post-grant catalog differs');
  await profiles(peers);
  return { applied: true as const, binding, peers };
}
export async function upgradePurchasedProductLabelRuntime(db: DbClient, declaration: RuntimeGiftPeerDeclarations,
  appReader?: RuntimeAppCashierOriginReaderAddon) {
  const peers = capturePurchasedLabelRuntimeDeclaration(declaration);
  const reader = appReader === undefined ? undefined : captureRuntimeAppCashierOriginReader(appReader);
  if (!Object.hasOwn(db, '$client') || !db.$client) throw Error('Root purchased label maintenance connection required');
  return db.transaction(tx => upgradePurchasedProductLabelRuntimeInTransaction(tx, peers, reader),
    { isolationLevel: 'read committed', accessMode: 'read write' });
}
