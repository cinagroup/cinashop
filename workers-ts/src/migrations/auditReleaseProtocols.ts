import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { inspectAdminRefundOperation } from './runAdminRefundOperation';
import { inspectAdminRefundCreation } from './runAdminRefundCreation';
import { inspectCheckoutPricingLock } from './checkoutPricingLock';
import { INVOICE_EVIDENCE_STATE_SQL } from './invoiceEvidenceCatalog';
import { REFUND_SPLIT_STATE_SQL } from './refundOrderSplitCatalog';
import { OFFLINE_STATE_SQL, OFFLINE_CATALOG_SQL, OFFLINE_CATALOG_VERSIONS } from './offlineOrderCatalog';
import { inspectTestReleaseSchemaUpgrade } from './runTestReleaseSchemaUpgrade';

/** Fixed read-only release inventory. No SQL/schema/role input, installation,
 * grants, business mutation or inference that catalog presence means readiness.
 * The predecessor inspection is a separate bounded snapshot, not one global one. */
export async function auditReleaseProtocols(db: Pick<DbClient, 'transaction' | '$client'>) {
  if (!db.$client) throw Error('Release protocol inspection requires a root database');
  const protocols = await db.transaction(async tx => {
    await tx.execute(sql`SELECT
      pg_catalog.set_config('search_path','public,pg_temp',true),
      pg_catalog.set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
      pg_catalog.set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
      pg_catalog.set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
    const [identity] = await tx.execute(sql`SELECT current_database() AS database, current_user AS role,
      session_user AS session_role, current_setting('server_version_num')::integer AS server_version,
      current_setting('transaction_read_only') AS read_only,
      (SELECT count(*)::integer FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind IN ('r','p')) AS tables,
      r.rolsuper AS superuser,r.rolcreatedb AS create_db,r.rolcreaterole AS create_role,r.rolbypassrls AS bypass_rls
      FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`);
    if (!identity || identity.read_only !== 'on' || !Number.isInteger(Number(identity.server_version)) || Number(identity.server_version) < 160000
      || Number(identity.server_version) >= 170000) throw Error('Unsupported release inspection target');
    const adminRefundOperation = await inspectAdminRefundOperation(tx);
    const adminRefundCreation = await inspectAdminRefundCreation(tx);
    const [invoice] = await tx.execute(sql.raw(INVOICE_EVIDENCE_STATE_SQL));
    const [refundSplit] = await tx.execute(sql.raw(REFUND_SPLIT_STATE_SQL));
    const [offline] = await tx.execute(sql.raw(OFFLINE_STATE_SQL));
    const states = [invoice?.state, refundSplit?.state, offline?.state];
    if (states.some(state => typeof state !== 'string' || !['fresh','v1','v2','orm-pending','drift'].includes(state)))
      throw Error('Protocol inspection returned an invalid state');
    const checkoutPricing = await inspectCheckoutPricingLock(tx);
    // Catalog hashes only: expose the exact mismatched dependency names without
    // emitting table rows, routine bodies, credentials or target-learned approval.
    const offlineCatalog = await tx.execute(sql.raw(OFFLINE_CATALOG_SQL));
    const offlinePredecessor = Object.entries(OFFLINE_CATALOG_VERSIONS.fresh).map(([name,expected]) => {
      const matches = offlineCatalog.filter(row => row.name === name);
      return { name, present: matches.length === 1 && matches[0].present === true,
        owned: matches.length === 1 && matches[0].owned === true,
        safe: matches.length === 1 && matches[0].safe === true,
        fingerprintMatches: matches.length === 1 && matches[0].fingerprint === expected };
    });
    // Fixed, bounded index inventory for dependency drift triage only. Do not
    // expose expression/predicate text: catalog defaults may contain literals.
    // Names and hashes never become an accepted installation fingerprint.
    const offlineIndexes = await tx.execute(sql`SELECT c.relname AS table_name,ic.relname AS index_name,
      i.indisvalid AS valid,i.indisready AS ready,i.indisunique AS unique_index,
      (SELECT array_agg(a.attname ORDER BY k.ordinality) FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ordinality)
        LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.attnum) AS columns,
      encode(sha256(convert_to(pg_catalog.pg_get_indexdef(i.indexrelid),'UTF8')),'hex') AS definition_hash
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_catalog.pg_index i ON i.indrelid=c.oid JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid
      WHERE n.nspname='public' AND c.relname IN ('system_config','user','user_bill','user_money')
      ORDER BY c.relname COLLATE "C",ic.relname COLLATE "C" LIMIT 101`);
    if (offlineIndexes.length > 100) throw Error('Release index inspection budget exceeded');
    return { identity, adminRefundOperation, adminRefundCreation, invoice: invoice.state,
      refundSplit: refundSplit.state, offline: offline.state, checkoutPricing, offlinePredecessor, offlineIndexes };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  const predecessor = await inspectTestReleaseSchemaUpgrade(db);
  return { scope: 'release-protocol-preflight', ready: false, protocols,
    predecessor: { supported: predecessor.supported, ready: predecessor.ready,
      withinBudget: predecessor.withinBudget, diagnostics: predecessor.diagnostics, fingerprint: predecessor.fingerprint },
    limitation: 'Read-only evidence; no runtime commissioning or release authorization inferred' };
}
