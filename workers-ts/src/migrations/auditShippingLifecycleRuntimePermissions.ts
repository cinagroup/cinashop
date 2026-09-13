import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { boundShippingLifecycleInspection } from './inspectShippingLifecycleBaseline';

/** Read-only CONNECTION identity envelope for the seven protected tables.
 * This is not a grant script, full service/RLS authorization audit, protocol
 * definition verifier or protection against a separate maintenance identity.
 * Parent templates use application soft retirement, so hard DELETE is excluded.
 */
export async function auditShippingLifecycleRuntimePermissions(
  db: Pick<DbClient, 'transaction'> & Partial<Pick<DbClient, '$client'>>,
) {
  if (!db.$client) throw new Error('Shipping runtime permission audit requires a root database');
  return db.transaction(async tx => {
    await boundShippingLifecycleInspection(tx);
    const [version] = await tx.select({ value: sql<number>`current_setting('server_version_num')::int` }).from(sql`(VALUES(1)) q(n)`);
    if (!version || Math.floor(version.value / 10000) !== 16) throw new Error('Shipping runtime permission audit requires PostgreSQL 16');
    const [checks] = await tx.select({
      connectionIdentityVisible: sql<boolean>`identity_visible`, objectsPresent: sql<boolean>`objects_present`,
      unprivilegedReachableRoles: sql<boolean>`unprivileged_roles`, noOwnerControl: sql<boolean>`no_owner_control`,
      noSchemaCreation: sql<boolean>`no_schema_creation`, noTriggerOrTruncate: sql<boolean>`no_trigger_or_truncate`,
      noTemplateHardDelete: sql<boolean>`no_template_delete`, noReplicationBypass: sql<boolean>`no_replication_bypass`,
      noSequenceReset: sql<boolean>`no_sequence_reset`, noGrantDelegation: sql<boolean>`no_grant_delegation`,
      noUnreviewedDefinerRoutine: sql<boolean>`no_definer_routine`, noUnreviewedRls: sql<boolean>`no_rls`,
      requiredTablePrivileges: sql<boolean>`table_privileges`, requiredSequenceUsage: sql<boolean>`sequence_privileges`,
      requiredFunctionExecute: sql<boolean>`function_privileges`,
    }).from(sql`(
      WITH connected AS (SELECT usesysid FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid()),
      identities AS (SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN(current_user,session_user) UNION SELECT usesysid FROM connected),
      reachable AS (SELECT r.* FROM pg_catalog.pg_roles r WHERE EXISTS(SELECT 1 FROM identities i
        WHERE pg_catalog.pg_has_role(i.oid,r.oid,'USAGE') OR pg_catalog.pg_has_role(i.oid,r.oid,'SET')
          OR pg_catalog.pg_has_role(i.oid,r.oid,'MEMBER WITH ADMIN OPTION'))),
      target_schema AS (SELECT oid,nspowner FROM pg_catalog.pg_namespace WHERE nspname='public'),
      target_database AS (SELECT oid,datdba FROM pg_catalog.pg_database WHERE datname=current_database()),
      wanted(name) AS (VALUES('shipping_templates'),('store_product'),('store_seckill'),('store_bargain'),('store_combination'),('store_integral'),('store_discounts_products')),
      objects AS (SELECT w.name,c.oid,c.relowner,c.relrowsecurity,c.relforcerowsecurity FROM wanted w CROSS JOIN target_schema n
        LEFT JOIN pg_catalog.pg_class c ON c.relnamespace=n.oid AND c.relname=w.name AND c.relkind='r' AND c.relpersistence='p'
          AND NOT c.relispartition AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)),
      sequences AS (SELECT o.name,s.oid,s.relowner FROM objects o
        LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=o.oid AND a.attname='id' AND NOT a.attisdropped
        LEFT JOIN pg_catalog.pg_depend d ON d.refclassid='pg_catalog.pg_class'::regclass AND d.refobjid=o.oid AND d.refobjsubid=a.attnum
          AND d.classid='pg_catalog.pg_class'::regclass AND d.deptype IN('a','i')
          AND EXISTS(SELECT 1 FROM pg_catalog.pg_class owned_sequence WHERE owned_sequence.oid=d.objid AND owned_sequence.relkind='S')
        LEFT JOIN pg_catalog.pg_class s ON s.oid=d.objid AND s.relkind='S'),
      wanted_functions(name,args) AS (VALUES('shipping_lifecycle_ref','23 23'),('shipping_lifecycle_bind','23 23 23'),
        ('shipping_lifecycle_child',''),('shipping_lifecycle_parent',''),('shipping_lifecycle_no_truncate','')),
      functions AS (SELECT w.name,p.oid,p.proowner FROM wanted_functions w CROSS JOIN target_schema n LEFT JOIN pg_catalog.pg_proc p
        ON p.pronamespace=n.oid AND p.proname=w.name AND p.proargtypes::text=w.args AND p.prokind='f')
      SELECT
        (SELECT count(*)=1 AND bool_and(usesysid IS NOT NULL) FROM connected)
          AND EXISTS(SELECT 1 FROM connected c JOIN pg_catalog.pg_roles r ON r.oid=c.usesysid) AS identity_visible,
        (SELECT count(*)=7 AND bool_and(oid IS NOT NULL) FROM objects)
          AND (SELECT count(*)=7 AND bool_and(oid IS NOT NULL) FROM sequences)
          AND (SELECT count(*)=5 AND bool_and(oid IS NOT NULL) FROM functions) AS objects_present,
        NOT EXISTS(SELECT 1 FROM reachable WHERE rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls
          OR rolname IN('pg_read_server_files','pg_write_server_files','pg_execute_server_program','pg_read_all_data','pg_write_all_data')) AS unprivileged_roles,
        NOT EXISTS(SELECT 1 FROM reachable WHERE oid IN(SELECT relowner FROM objects UNION SELECT relowner FROM sequences
          UNION SELECT proowner FROM functions UNION SELECT nspowner FROM target_schema UNION SELECT datdba FROM target_database)) AS no_owner_control,
        NOT EXISTS(SELECT 1 FROM reachable r CROSS JOIN target_schema n CROSS JOIN target_database d
          WHERE pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE') OR pg_catalog.has_database_privilege(r.oid,d.oid,'CREATE')) AS no_schema_creation,
        NOT EXISTS(SELECT 1 FROM reachable r CROSS JOIN objects o WHERE pg_catalog.has_table_privilege(r.oid,o.oid,'TRIGGER,TRUNCATE')) AS no_trigger_or_truncate,
        NOT EXISTS(SELECT 1 FROM reachable r CROSS JOIN objects o WHERE o.name='shipping_templates'
          AND pg_catalog.has_table_privilege(r.oid,o.oid,'DELETE')) AS no_template_delete,
        current_setting('session_replication_role') IN('origin','local') AND NOT EXISTS(SELECT 1 FROM reachable
          WHERE pg_catalog.has_parameter_privilege(oid,'session_replication_role','SET')
          OR pg_catalog.has_parameter_privilege(oid,'session_replication_role','ALTER SYSTEM')) AS no_replication_bypass,
        NOT EXISTS(SELECT 1 FROM reachable r CROSS JOIN sequences s WHERE pg_catalog.has_sequence_privilege(r.oid,s.oid,'UPDATE')) AS no_sequence_reset,
        NOT EXISTS(SELECT 1 FROM reachable r CROSS JOIN objects o WHERE pg_catalog.has_table_privilege(r.oid,o.oid,'SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION,DELETE WITH GRANT OPTION,REFERENCES WITH GRANT OPTION')
          OR pg_catalog.has_any_column_privilege(r.oid,o.oid,'SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION,REFERENCES WITH GRANT OPTION'))
          AND NOT EXISTS(SELECT 1 FROM reachable r CROSS JOIN functions f WHERE pg_catalog.has_function_privilege(r.oid,f.oid,'EXECUTE WITH GRANT OPTION'))
          AND NOT EXISTS(SELECT 1 FROM reachable r CROSS JOIN sequences s WHERE pg_catalog.has_sequence_privilege(r.oid,s.oid,'USAGE WITH GRANT OPTION,SELECT WITH GRANT OPTION'))
          AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m JOIN reachable r ON r.oid=m.member WHERE m.admin_option) AS no_grant_delegation,
        NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
          WHERE p.prosecdef AND NOT pg_catalog.starts_with(n.nspname::text,'pg_') AND n.nspname<>'information_schema'
            AND EXISTS(SELECT 1 FROM reachable r WHERE pg_catalog.has_function_privilege(r.oid,p.oid,'EXECUTE'))) AS no_definer_routine,
        (SELECT count(*)=7 AND bool_and(NOT COALESCE(relrowsecurity,true) AND NOT COALESCE(relforcerowsecurity,true)) FROM objects) AS no_rls,
        EXISTS(SELECT 1 FROM target_schema WHERE pg_catalog.has_schema_privilege(current_user,oid,'USAGE'))
          AND (SELECT count(*)=7 AND bool_and(COALESCE(pg_catalog.has_table_privilege(current_user,oid,'SELECT')
            AND pg_catalog.has_table_privilege(current_user,oid,'INSERT') AND pg_catalog.has_table_privilege(current_user,oid,'UPDATE')
            AND (name='shipping_templates' OR pg_catalog.has_table_privilege(current_user,oid,'DELETE')),false)) FROM objects) AS table_privileges,
        (SELECT count(*)=7 AND bool_and(COALESCE(pg_catalog.has_sequence_privilege(current_user,oid,'USAGE'),false)) FROM sequences) AS sequence_privileges,
        (SELECT count(*)=5 AND bool_and(COALESCE(pg_catalog.has_function_privilege(current_user,oid,'EXECUTE'),false)) FROM functions) AS function_privileges
    ) shipping_runtime_permissions`);
    if (!checks) throw new Error('Shipping runtime permission audit returned no result');
    const failures = Object.entries(checks).filter(([, value]) => value !== true).map(([name]) => name);
    return { scope: 'shipping-lifecycle-runtime-envelope' as const, ready: failures.length === 0,
      readOnly: true as const, protocolCatalogVerified: false as const, dataBaselineVerified: false as const,
      completeServicePrivilegesVerified: false as const, checks, failures };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
