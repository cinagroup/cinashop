import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { installAdminOrderPriceOperation, inspectAdminOrderPriceOperation, adminOrderPriceOperationCatalogReady, orderEditOperationColumnsMatch } from './adminOrderPriceOperation';
import { assertSupplierOrderEditOperationReadable, inspectSupplierOrderEditOperation, SUPPLIER_ORDER_EDIT_OPERATION_CONSTRAINTS_SHA256 } from './supplierOrderEditOperation';
import { assertSupplierOrderPriceRevisionReady, installSupplierOrderPriceRevision } from './supplierOrderPriceRevision';

export interface AdminOrderPriceRuntimeRoles { admin: string; readers: readonly string[] }
export const ADMIN_ORDER_PRICE_RUNTIME_PRIVILEGES = { app: ['SELECT'], admin: ['SELECT','INSERT'] } as const;

/** Optional exact profile addition: only the declared Admin can append. */
export async function inspectAdminOrderPriceRuntime(tx: Pick<DbClient,'execute'>,
  names: { app: string; admin: string; maintenance: string }): Promise<boolean> {
  if (!adminOrderPriceOperationCatalogReady(await inspectAdminOrderPriceOperation(tx,'read'))) return false;
  const [row] = await tx.execute(sql`SELECT c.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${names.maintenance} AND rolsuper)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
      WHERE a.grantee<>c.relowner AND (a.is_grantable OR a.grantee=0 OR
        a.privilege_type<>'SELECT' AND NOT (a.privilege_type='INSERT' AND a.grantee=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${names.admin}))))
    AND has_table_privilege(${names.admin},c.oid,'SELECT') AND has_table_privilege(${names.admin},c.oid,'INSERT')
    AND NOT has_table_privilege(${names.admin},c.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    AND has_table_privilege(${names.app},c.oid,'SELECT')
    AND NOT has_table_privilege(${names.app},c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS ready,
    to_regclass('public.supplier_order_edit_operation_v1') IS NOT NULL AS supplier
    FROM pg_catalog.pg_class c WHERE c.oid=to_regclass('public.admin_order_price_operation_v1')`);
  if (row?.ready !== true) return false;
  if (row.supplier === true) {
    // Catalog-only inspection keeps a missing SELECT grant from aborting the
    // enclosing read-only audit transaction. A failed audit never probes data.
    const supplier = await inspectSupplierOrderEditOperation(tx,'read');
    if (!supplier || ['supported','safe','constraint_count','indexes','triggers','function','privileges'].some(key => supplier[key] !== true)
      || supplier.constraints_hash !== SUPPLIER_ORDER_EDIT_OPERATION_CONSTRAINTS_SHA256
      || !orderEditOperationColumnsMatch(supplier.columns)) return false;
    for (const role of [names.app,names.admin]) {
      const [rights] = await tx.execute(sql`SELECT c.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${names.maintenance} AND rolsuper)
        AND has_table_privilege(${role},c.oid,'SELECT')
        AND NOT has_table_privilege(${role},c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS ready
        FROM pg_catalog.pg_class c WHERE c.oid='public.supplier_order_edit_operation_v1'::regclass`);
      if (rights?.ready !== true) return false;
    }
  }
  return true;
}

/** Explicit owner maintenance in an existing READ COMMITTED transaction. The
 * caller lists every App/Customer/Supplier financial reader that will consume
 * edited purchases. No bootstrap, HTTP, role creation or existing grant repair. */
export async function installAdminOrderPriceRuntime(tx: Pick<DbClient, 'execute'>, roles: AdminOrderPriceRuntimeRoles) {
  const names = [roles.admin, ...roles.readers];
  if (!roles.readers.length || names.length > 32 || new Set(names).size !== names.length
    || names.some(name => !/^[a-z][a-z0-9_]{0,62}$/.test(name))) throw Error('Invalid explicit Admin price runtime identities');
  for (const name of names) {
    const [role] = await tx.execute(sql`SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb
      AND NOT rolinherit AND NOT rolreplication AND NOT rolbypassrls AS safe FROM pg_catalog.pg_roles WHERE rolname=${name}`);
    if (role?.safe !== true) throw Error('Admin price requires separate restricted LOGIN identities');
  }
  const result = await installAdminOrderPriceOperation(tx, roles.admin);
  for (const reader of roles.readers) {
    if (result.applied) await tx.execute(sql.raw(`GRANT SELECT ON TABLE public.admin_order_price_operation_v1 TO "${reader}"`));
    const [rights] = await tx.execute(sql`SELECT has_table_privilege(${reader},'public.admin_order_price_operation_v1','SELECT')
      AND NOT has_table_privilege(${reader},'public.admin_order_price_operation_v1','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS ready`);
    if (rights?.ready !== true) throw Error('Existing Admin price reader grants require review');
  }
  // Both ledgers can occur in one purchase's ancestry. A fresh installation
  // explicitly commissions only SELECT on an existing protected Supplier
  // ledger, including for the Admin writer. Never copy its INSERT capability.
  const [supplier] = await tx.execute(sql`SELECT to_regclass('public.supplier_order_edit_operation_v1') IS NOT NULL AS present`);
  if (supplier?.present === true) {
    await assertSupplierOrderEditOperationReadable(tx);
    for (const name of names) {
      if (result.applied) await tx.execute(sql.raw(`GRANT SELECT ON TABLE public.supplier_order_edit_operation_v1 TO "${name}"`));
      const [rights] = await tx.execute(sql`SELECT has_table_privilege(${name},'public.supplier_order_edit_operation_v1','SELECT') AS ready`);
      if (rights?.ready !== true) throw Error('Existing Supplier edit ancestry reader grants require review');
    }
  }
  const [settings] = await tx.execute(sql`SELECT current_setting('search_path') AS path`);
  await installSupplierOrderPriceRevision(tx);
  await tx.execute(sql`SELECT pg_catalog.set_config('search_path',${String(settings.path)},true)`);
  await assertSupplierOrderPriceRevisionReady(tx);
  return result;
}
