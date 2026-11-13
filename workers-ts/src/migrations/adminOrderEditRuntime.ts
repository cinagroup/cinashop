import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { installAdminOrderEditOperation, inspectAdminOrderEditOperation, adminOrderEditOperationCatalogReady } from './adminOrderEditOperation';
import { installAdminOrderGainPartition, inspectAdminOrderGainPartition, adminOrderGainPartitionCatalogReady } from './adminOrderGainPartition';
import { assertSupplierOrderEditOperationReadable, inspectSupplierOrderEditOperation, SUPPLIER_ORDER_EDIT_OPERATION_CONSTRAINTS_SHA256 } from './supplierOrderEditOperation';
import { orderEditOperationColumnsMatch } from './adminOrderPriceOperation';
import { assertAdminOrderPriceOperationReadable } from './adminOrderPriceOperation';
import { assertSupplierOrderPriceRevisionReady, installSupplierOrderPriceRevision } from './supplierOrderPriceRevision';

export const ADMIN_ORDER_EDIT_RUNTIME_PRIVILEGES = { app: ['SELECT'], admin: ['SELECT', 'INSERT'] } as const;
export const ADMIN_ORDER_GAIN_RUNTIME_PRIVILEGES = ['SELECT', 'INSERT'] as const;

/** Optional extension of the frozen App/Admin profiles. Every financial writer
 * must append child provenance but only the declared Admin may edit a root. */
export async function inspectAdminOrderEditRuntime(tx: Pick<DbClient, 'execute'>,
  names: { app: string; admin: string; maintenance: string }): Promise<boolean> {
  if (!adminOrderEditOperationCatalogReady(await inspectAdminOrderEditOperation(tx, 'read'))
    || !adminOrderGainPartitionCatalogReady(await inspectAdminOrderGainPartition(tx, 'write'))) return false;
  for (const table of ['admin_order_edit_operation_v1', 'admin_order_gain_partition_v1']) {
    const partition = table === 'admin_order_gain_partition_v1';
    const [row] = await tx.execute(sql`SELECT c.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${names.maintenance} AND rolsuper)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
        WHERE a.grantee<>c.relowner AND (a.is_grantable OR a.grantee=0 OR a.privilege_type NOT IN ('SELECT','INSERT')
          OR (NOT ${partition} AND a.privilege_type='INSERT' AND a.grantee<>(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${names.admin}))))
      AND has_table_privilege(${names.admin},c.oid,'SELECT') AND has_table_privilege(${names.admin},c.oid,'INSERT')
      AND NOT has_table_privilege(${names.admin},c.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND has_table_privilege(${names.app},c.oid,'SELECT')
      AND (CASE WHEN ${partition} THEN has_table_privilege(${names.app},c.oid,'INSERT') ELSE NOT has_table_privilege(${names.app},c.oid,'INSERT') END)
      AND NOT has_table_privilege(${names.app},c.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS ready
      FROM pg_catalog.pg_class c WHERE c.oid=to_regclass(${'public.' + table})`);
    if (row?.ready !== true) return false;
  }
  const [supplier] = await tx.execute(sql`SELECT to_regclass('public.supplier_order_edit_operation_v1') IS NOT NULL AS present`);
  if (supplier?.present) {
    const state = await inspectSupplierOrderEditOperation(tx, 'read');
    if (!state || ['supported','safe','constraint_count','indexes','triggers','function','privileges'].some(key => state[key] !== true)
      || state.constraints_hash !== SUPPLIER_ORDER_EDIT_OPERATION_CONSTRAINTS_SHA256 || !orderEditOperationColumnsMatch(state.columns)) return false;
    for (const role of [names.app, names.admin]) {
      const [rights] = await tx.execute(sql`SELECT c.relowner=(SELECT oid FROM pg_roles WHERE rolname=${names.maintenance} AND rolsuper)
        AND has_table_privilege(${role},c.oid,'SELECT') AND NOT has_table_privilege(${role},c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS ready
        FROM pg_class c WHERE c.oid='public.supplier_order_edit_operation_v1'::regclass`);
      if (rights?.ready !== true) return false;
    }
  }
  return true;
}

/** Explicit PG16 owner transaction only. List all App/Customer/Supplier readers
 * as financial writers; no HTTP/bootstrap installer or existing grant repair. */
export async function installAdminOrderEditRuntime(tx: Pick<DbClient, 'execute'>,
  roles: { admin: string; financial: readonly string[] }) {
  const names = [roles.admin, ...roles.financial];
  if (!roles.financial.length || names.length > 32 || new Set(names).size !== names.length
    || names.some(name => !/^[a-z][a-z0-9_]{0,62}$/.test(name))) throw Error('Invalid explicit Admin edit runtime identities');
  for (const name of names) {
    const [role] = await tx.execute(sql`SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb
      AND NOT rolinherit AND NOT rolreplication AND NOT rolbypassrls AS safe FROM pg_catalog.pg_roles WHERE rolname=${name}`);
    if (role?.safe !== true) throw Error('Admin edit requires separate restricted LOGIN identities');
  }
  const [presence] = await tx.execute(sql`SELECT
    to_regclass('public.admin_order_edit_operation_v1') IS NOT NULL OR to_regprocedure('public.admin_order_edit_operation_immutable_v1()') IS NOT NULL AS operation,
    to_regclass('public.admin_order_gain_partition_v1') IS NOT NULL OR to_regprocedure('public.admin_order_gain_partition_immutable_v1()') IS NOT NULL AS partition`);
  if (presence.operation !== presence.partition) throw Error('Partial Admin order edit runtime requires review');
  const result = await installAdminOrderEditOperation(tx, roles.admin);
  await installAdminOrderGainPartition(tx, roles.admin);
  for (const role of roles.financial) {
    if (result.applied) {
      await tx.execute(sql.raw(`GRANT SELECT ON public.admin_order_edit_operation_v1 TO "${role}"`));
      await tx.execute(sql.raw(`GRANT SELECT,INSERT ON public.admin_order_gain_partition_v1 TO "${role}"`));
    }
    const [rights] = await tx.execute(sql`SELECT has_table_privilege(${role},'public.admin_order_edit_operation_v1','SELECT')
      AND NOT has_table_privilege(${role},'public.admin_order_edit_operation_v1','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND has_table_privilege(${role},'public.admin_order_gain_partition_v1','SELECT') AND has_table_privilege(${role},'public.admin_order_gain_partition_v1','INSERT')
      AND NOT has_table_privilege(${role},'public.admin_order_gain_partition_v1','UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS ready`);
    if (rights?.ready !== true) throw Error('Existing Admin edit financial grants require review');
  }
  for (const table of ['supplier_order_edit_operation_v1', 'admin_order_price_operation_v1'] as const) {
    const [catalog] = await tx.execute(sql`SELECT to_regclass(${'public.' + table}) IS NOT NULL AS present`);
    if (!catalog?.present) continue;
    if (table === 'supplier_order_edit_operation_v1') await assertSupplierOrderEditOperationReadable(tx);
    else await assertAdminOrderPriceOperationReadable(tx);
    for (const name of names) {
      if (result.applied) await tx.execute(sql.raw(`GRANT SELECT ON public.${table} TO "${name}"`));
      const [rights] = await tx.execute(sql`SELECT has_table_privilege(${name},${'public.' + table},'SELECT') AS ready`);
      if (rights?.ready !== true) throw Error('Existing mixed edit ancestry reader grants require review');
    }
  }
  const [settings] = await tx.execute(sql`SELECT current_setting('search_path') AS path`);
  await installSupplierOrderPriceRevision(tx);
  await tx.execute(sql`SELECT pg_catalog.set_config('search_path',${String(settings.path)},true)`);
  await assertSupplierOrderPriceRevisionReady(tx);
  return result;
}
