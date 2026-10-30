import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { inspectRuntimeBusinessProfileInTransaction } from './auditRuntimeBusinessPrivileges';
import {
  SUPPLIER_PRODUCT_LABEL_CAPABILITY, SUPPLIER_PRODUCT_LABEL_CAPABILITY_FUNCTION,
  SUPPLIER_PRODUCT_LABEL_CAPABILITY_SIGNATURE, SUPPLIER_PRODUCT_LABEL_CAPABILITY_GATE,
  SUPPLIER_PRODUCT_LABEL_CAPABILITY_TABLES, supplierProductLabelCapabilityBody,
  supplierProductLabelOwnerGrantSql, inspectSupplierProductLabelOwner,
  inspectSupplierProductLabelCapability, type SupplierProductLabelCapabilityTarget,
} from './supplierProductLabelCapability';

/** Explicit existing PG16 maintenance only. The independently precreated empty
 * NOLOGIN owner and the already commissioned App/Admin profiles are inspected
 * before any grant. No role/credential/data/old stage is created or repaired. */
export async function installSupplierProductLabelUpgradeInTransaction(
  tx: Pick<DbClient,'execute'>, target: SupplierProductLabelCapabilityTarget,
): Promise<{operation:typeof SUPPLIER_PRODUCT_LABEL_CAPABILITY;applied:boolean}> {
  if (Object.hasOwn(tx,'$client')) throw Error('Supplier label upgrade requires an existing maintenance transaction');
  Object.values(target).forEach(pricingIdentifier);
  if (new Set([target.app,target.admin,target.maintenance,target.owner]).size!==4) throw Error('Supplier label capability requires four distinct identities');
  await tx.execute(sql`SELECT set_config('search_path','public,pg_temp',true),set_config('statement_timeout','5000',true),
    set_config('lock_timeout','1000',true),set_config('idle_in_transaction_session_timeout','5000',true)`);
  const [context]=await tx.execute(sql`SELECT current_database()=${target.database} AND current_user=${target.maintenance} AND current_user=session_user
    AND current_schema()='public' AND current_setting('server_version_num')::integer/10000=16
    AND current_setting('transaction_isolation')='read committed' AND NOT current_setting('transaction_read_only')::boolean
    AND current_setting('session_replication_role')='origin'
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND rolsuper)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS ready`);
  if (context?.ready!==true) throw Error('Supplier label capability requires explicit owner/database PG16 maintenance');
  const [gate]=await tx.execute(sql`SELECT pg_catalog.pg_try_advisory_xact_lock(${SUPPLIER_PRODUCT_LABEL_CAPABILITY_GATE[0]},${SUPPLIER_PRODUCT_LABEL_CAPABILITY_GATE[1]}) AS locked`);
  if (gate?.locked!==true) throw Error('Supplier label capability commissioning is busy');
  await tx.execute(sql.raw(`LOCK TABLE ${SUPPLIER_PRODUCT_LABEL_CAPABILITY_TABLES.map(t=>`ONLY public.${pricingIdentifier(t)}`).join(',')} IN ACCESS EXCLUSIVE MODE NOWAIT`));
  const inspectProfiles=async()=>({
    app:await inspectRuntimeBusinessProfileInTransaction(tx,'app',target,'current'),
    admin:await inspectRuntimeBusinessProfileInTransaction(tx,'admin',target,'current'),
  });
  const beforeProfiles=await inspectProfiles();
  if (!beforeProfiles.app.ready || !beforeProfiles.admin.ready) throw Error('Supplier label capability requires exact existing current App/Admin profiles');
  const before=await inspectSupplierProductLabelCapability(tx,target);
  if (!before.absent) {
    if (!before.ready) throw Error(`Supplier label capability catalog/owner/ACL drift: ${JSON.stringify(before)}`);
    return {operation:SUPPLIER_PRODUCT_LABEL_CAPABILITY,applied:false};
  }
  if (!await inspectSupplierProductLabelOwner(tx,target.owner,false)) throw Error('Supplier label capability owner must be a precreated empty restricted NOLOGIN');
  const owner=pricingIdentifier(target.owner),app=pricingIdentifier(target.app);
  for (const statement of supplierProductLabelOwnerGrantSql(target.owner)) await tx.execute(sql.raw(statement));
  // ALTER OWNER requires temporary schema CREATE. It is removed in this same
  // transaction before final checks; any interruption rolls all grants back.
  await tx.execute(sql.raw(`GRANT USAGE,CREATE ON SCHEMA public TO ${owner}`));
  await tx.execute(sql.raw(`CREATE FUNCTION public.${SUPPLIER_PRODUCT_LABEL_CAPABILITY_FUNCTION}(
    p_context jsonb,p_operation text,p_id integer,p_expected jsonb,p_payload jsonb)
    RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path=pg_catalog,pg_temp AS $supplier_label_cap$${supplierProductLabelCapabilityBody(target.app)}$supplier_label_cap$`));
  await tx.execute(sql.raw(`REVOKE ALL ON FUNCTION ${SUPPLIER_PRODUCT_LABEL_CAPABILITY_SIGNATURE} FROM PUBLIC`));
  await tx.execute(sql.raw(`ALTER FUNCTION ${SUPPLIER_PRODUCT_LABEL_CAPABILITY_SIGNATURE} OWNER TO ${owner}`));
  await tx.execute(sql.raw(`REVOKE CREATE ON SCHEMA public FROM ${owner}`));
  await tx.execute(sql.raw(`GRANT EXECUTE ON FUNCTION ${SUPPLIER_PRODUCT_LABEL_CAPABILITY_SIGNATURE} TO ${app}`));
  const after=await inspectSupplierProductLabelCapability(tx,target);
  if (!after.ready) throw Error(`Supplier label capability installed catalog verification failed: ${JSON.stringify(after)}`);
  const afterProfiles=await inspectProfiles();
  if (!afterProfiles.app.ready || !afterProfiles.admin.ready) throw Error('Supplier label capability final current App/Admin profile verification failed');
  return {operation:SUPPLIER_PRODUCT_LABEL_CAPABILITY,applied:true};
}

export async function runSupplierProductLabelUpgrade(db:DbClient,target:SupplierProductLabelCapabilityTarget) {
  if (!Object.hasOwn(db,'$client') || !db.$client) throw Error('Supplier label upgrade requires a root maintenance connection');
  return db.transaction(tx=>installSupplierProductLabelUpgradeInTransaction(tx,target),{isolationLevel:'read committed',accessMode:'read write'});
}
