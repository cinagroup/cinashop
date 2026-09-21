import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { ADMIN_REFUND_OPERATION_INSTALLATION_SQL } from './adminRefundOperationInstallation';
import { ADMIN_REFUND_CREATION_INSTALLATION_SQL } from './adminRefundCreationInstallation';
import { inspectAdminRefundOperation } from './runAdminRefundOperation';
import { inspectAdminRefundCreation } from './runAdminRefundCreation';
import { INVOICE_EVIDENCE_INSTALLATION_SQL } from './invoiceEvidenceInstallation';
import { INVOICE_EVIDENCE_STATE_SQL } from './invoiceEvidenceCatalog';
import { REFUND_SPLIT_INSTALLATION_SQL } from './refundOrderSplitInstallation';
import { REFUND_SPLIT_STATE_SQL } from './refundOrderSplitCatalog';
import { OFFLINE_INSTALLATION_SQL } from './offlineOrderInstallation';
import { OFFLINE_DEPENDENCIES, OFFLINE_STATE_SQL } from './offlineOrderCatalog';
import { CHECKOUT_PRICING_LOCK_INSTALLATION_SQL } from './checkoutPricingLockInstallation';
import { PRICING_OWNER_SETTING, pricingIdentifier, pricingCatalogReady } from './checkoutPricingLockCatalog';
import { inspectCheckoutPricingLock } from './checkoutPricingLock';
import { installReleaseSharedIndexesInTransaction } from './releaseSharedIndexes';

type Root = Pick<DbClient,'transaction'> & Partial<Pick<DbClient,'$client'>>;
type Query = Pick<DbClient,'execute'>;
export const RELEASE_PROTOCOL_OPERATION = 'reviewed-indexes-and-0155-0160-schema-v1';
export const RELEASE_PROTOCOL_BASE_TABLES = [...OFFLINE_DEPENDENCIES, 'store_order_invoice', 'store_order',
  'store_order_refund', 'store_order_cart_info'].sort();
export interface ReleaseProtocolTarget { database: string; maintenanceRole: string; pricingOwner: string }
function validate(db: Root, target: ReleaseProtocolTarget) {
  if (!Object.hasOwn(db,'$client') || !db.$client) throw Error('Release schema requires a root connection');
  for (const name of Object.values(target)) pricingIdentifier(name);
}
async function setup(tx: Query, target: ReleaseProtocolTarget) {
  await tx.execute(sql`SELECT pg_catalog.set_config('search_path','public,pg_temp',true),
    pg_catalog.set_config('row_security','off',true),pg_catalog.set_config('statement_timeout','5000',true),
    pg_catalog.set_config('lock_timeout','1000',true),pg_catalog.set_config('idle_in_transaction_session_timeout','5000',true)`);
  const [row] = await tx.execute(sql`SELECT current_database()=${target.database}
    AND current_user=${target.maintenanceRole} AND session_user=current_user
    AND current_setting('server_version_num')::integer/10000=16
    AND current_setting('session_replication_role')='origin'
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity a JOIN pg_catalog.pg_roles r ON r.oid=a.usesysid
      WHERE a.pid=pg_backend_pid() AND r.rolname=current_user AND r.rolsuper)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS supported`);
  if (row?.supported !== true) throw Error('Release schema target or environment requires review');
}
async function fingerprint(tx: Query) {
  const rows = [];
  for (const name of RELEASE_PROTOCOL_BASE_TABLES) {
    const [row] = await tx.execute(sql`SELECT count(*)::int AS rows,
      encode(sha256(convert_to(COALESCE(jsonb_agg(data ORDER BY data::text COLLATE "C")::text,'[]'),'UTF8')),'hex') AS sha256
      FROM (SELECT to_jsonb(t) AS data FROM public.${sql.identifier(name)} t LIMIT 10001) bounded`);
    if (!row || Number(row.rows)>10000) throw Error('Release schema row budget exceeded');
    rows.push({ table:name, rows:row.rows, sha256:row.sha256 });
  }
  return rows;
}
async function inspect(tx: Query) {
  const operation = await inspectAdminRefundOperation(tx), creation = await inspectAdminRefundCreation(tx);
  const [invoice] = await tx.execute(sql.raw(INVOICE_EVIDENCE_STATE_SQL));
  const [refund] = await tx.execute(sql.raw(REFUND_SPLIT_STATE_SQL));
  const [offline] = await tx.execute(sql.raw(OFFLINE_STATE_SQL));
  const pricing = await inspectCheckoutPricingLock(tx);
  return { schemaReady:operation.complete && creation.complete && invoice?.state==='v2' && refund?.state==='v1'
      && offline?.state==='v1' && pricingCatalogReady(pricing),
    adminRefundOperation:operation, adminRefundCreation:creation, invoice:invoice?.state, refund:refund?.state, offline:offline?.state, pricing };
}
export async function inspectReleaseProtocolSchema(db: Root, target: ReleaseProtocolTarget) {
  validate(db,target);
  return db.transaction(async tx => { await setup(tx,target); return { operation:RELEASE_PROTOCOL_OPERATION,
    ...await inspect(tx), fingerprint:await fingerprint(tx), runtimeCommissioned:false as const }; },
  { isolationLevel:'repeatable read', accessMode:'read only' });
}
/** Atomic fixed schema phase only. No historical runAll, data backfill, caller
 * business grants, credential changes, role creation or application activation.
 * Existing installers retain all exact-catalog, owner and ACL checks. */
export async function runReleaseProtocolSchema(db: Root, target: ReleaseProtocolTarget) {
  validate(db,target);
  return db.transaction(async tx => {
    await setup(tx,target);
    const [gate] = await tx.execute(sql`SELECT pg_catalog.pg_try_advisory_xact_lock(731626,1) AS locked`);
    if (gate?.locked !== true) throw Error('Release schema maintenance is busy');
    await tx.execute(sql.raw('LOCK TABLE '+RELEASE_PROTOCOL_BASE_TABLES.map(name=>'public."'+name+'"').join(',')+' IN ACCESS EXCLUSIVE MODE NOWAIT'));
    const before = await fingerprint(tx);
    const indexes = await installReleaseSharedIndexesInTransaction(tx);
    for (const statement of [ADMIN_REFUND_OPERATION_INSTALLATION_SQL, ADMIN_REFUND_CREATION_INSTALLATION_SQL,
      INVOICE_EVIDENCE_INSTALLATION_SQL, REFUND_SPLIT_INSTALLATION_SQL, OFFLINE_INSTALLATION_SQL])
      await tx.execute(sql.raw(statement));
    await tx.execute(sql`SELECT pg_catalog.set_config(${PRICING_OWNER_SETTING},${target.pricingOwner},true)`);
    await tx.execute(sql.raw(CHECKOUT_PRICING_LOCK_INSTALLATION_SQL));
    await setup(tx,target);
    const state = await inspect(tx), after = await fingerprint(tx);
    if (!state.schemaReady || JSON.stringify(before)!==JSON.stringify(after)) throw Error('Release schema postflight mismatch');
    return { operation:RELEASE_PROTOCOL_OPERATION, ...state, indexesCreated:indexes.created, before, after,
      runtimeCommissioned:false as const };
  }, { isolationLevel:'read committed', accessMode:'read write' });
}
