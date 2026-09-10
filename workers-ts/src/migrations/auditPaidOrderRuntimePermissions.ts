import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';

/** Explicit, read-only release preflight for the CONNECTION's real identity.
 * Not a GRANT script, request middleware, complete app privilege audit, or proof
 * against a separate maintenance administrator changing the catalog later.
 * Function/trigger definitions and RLS are checked separately by checkout's
 * installed-protocol guard; ready here means this permission envelope only.
 * Callable user SECURITY DEFINER routines conservatively require manual review.
 */
export async function auditPaidOrderRuntimePermissions(
  db: Pick<DbClient, 'transaction'> & Partial<Pick<DbClient, '$client'>>,
  schema = 'public',
) {
  if (!db.$client) throw new Error('Runtime permission audit requires a root database');
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema) || schema.startsWith('pg_') || schema === 'information_schema') {
    throw new Error('Invalid runtime permission audit schema');
  }
  return db.transaction(async tx => {
    await tx.execute(sql.raw(`SELECT
      pg_catalog.set_config('statement_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
      pg_catalog.set_config('lock_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text || 'ms',true),
      pg_catalog.set_config('idle_in_transaction_session_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true)`));
    const [checks] = await tx.select({
      connectionIdentityVisible: sql<boolean>`connection_identity_visible`,
      objectsPresent: sql<boolean>`objects_present`,
      unprivilegedReachableRoles: sql<boolean>`unprivileged_roles`,
      noOwnerControl: sql<boolean>`no_owner_control`,
      noSchemaCreation: sql<boolean>`no_schema_creation`,
      noTriggerCreation: sql<boolean>`no_trigger_creation`,
      noTruncate: sql<boolean>`no_truncate`,
      noReplicationBypass: sql<boolean>`no_replication_bypass`,
      noUnreviewedDefinerRoutine: sql<boolean>`no_definer_routine`,
      protocolReadWritePrivileges: sql<boolean>`protocol_privileges`,
    }).from(sql`(
      WITH connected AS (
        SELECT usesysid FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid()
      ), identities AS (
        SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN (current_user,session_user)
        UNION SELECT usesysid FROM connected
      ), reachable AS (
        SELECT r.* FROM pg_catalog.pg_roles r WHERE EXISTS (
          SELECT 1 FROM identities i WHERE pg_catalog.pg_has_role(i.oid,r.oid,'USAGE')
            OR pg_catalog.pg_has_role(i.oid,r.oid,'SET')
            OR pg_catalog.pg_has_role(i.oid,r.oid,'MEMBER WITH ADMIN OPTION')
        )
      ), objects AS (
        SELECT n.oid AS schema_oid,n.nspowner AS schema_owner,
          o.oid AS order_oid,o.relowner AS order_owner,u.oid AS user_oid,u.relowner AS user_owner,
          p.oid AS function_oid,p.proowner AS function_owner,d.oid AS database_oid,d.datdba AS database_owner
        FROM pg_catalog.pg_database d
        LEFT JOIN pg_catalog.pg_namespace n ON n.nspname=${schema}
        LEFT JOIN pg_catalog.pg_class o ON o.relnamespace=n.oid AND o.relname='store_order' AND o.relkind='r'
        LEFT JOIN pg_catalog.pg_class u ON u.relnamespace=n.oid AND u.relname='user' AND u.relkind='r'
        LEFT JOIN pg_catalog.pg_proc p ON p.pronamespace=n.oid AND p.proname='brokerage_paid_order_fence_0150' AND p.pronargs=0
        WHERE d.datname=current_database()
      )
      SELECT
        (SELECT count(*)=1 AND bool_and(usesysid IS NOT NULL) FROM connected)
          AND EXISTS (SELECT 1 FROM connected c JOIN pg_catalog.pg_roles r ON r.oid=c.usesysid) AS connection_identity_visible,
        schema_oid IS NOT NULL AND order_oid IS NOT NULL AND user_oid IS NOT NULL AND function_oid IS NOT NULL AS objects_present,
        NOT EXISTS (SELECT 1 FROM reachable WHERE rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls
          OR rolname IN ('pg_write_server_files','pg_execute_server_program')) AS unprivileged_roles,
        NOT EXISTS (SELECT 1 FROM reachable WHERE oid IN
          (schema_owner,order_owner,user_owner,function_owner,database_owner)) AS no_owner_control,
        NOT EXISTS (SELECT 1 FROM reachable WHERE pg_catalog.has_schema_privilege(oid,schema_oid,'CREATE')
          OR pg_catalog.has_database_privilege(oid,database_oid,'CREATE')) AS no_schema_creation,
        NOT EXISTS (SELECT 1 FROM reachable WHERE pg_catalog.has_table_privilege(oid,order_oid,'TRIGGER')
          OR pg_catalog.has_table_privilege(oid,user_oid,'TRIGGER')) AS no_trigger_creation,
        NOT EXISTS (SELECT 1 FROM reachable WHERE pg_catalog.has_table_privilege(oid,order_oid,'TRUNCATE')
          OR pg_catalog.has_table_privilege(oid,user_oid,'TRUNCATE')) AS no_truncate,
        current_setting('session_replication_role') IN ('origin','local') AND NOT EXISTS (
          SELECT 1 FROM reachable WHERE pg_catalog.has_parameter_privilege(oid,'session_replication_role','SET')
            OR pg_catalog.has_parameter_privilege(oid,'session_replication_role','ALTER SYSTEM')) AS no_replication_bypass,
        NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
          WHERE p.prosecdef AND NOT pg_catalog.starts_with(n.nspname::text,'pg_') AND n.nspname<>'information_schema'
            AND EXISTS (SELECT 1 FROM reachable r WHERE pg_catalog.has_function_privilege(r.oid,p.oid,'EXECUTE'))) AS no_definer_routine,
        COALESCE(pg_catalog.has_schema_privilege(current_user,schema_oid,'USAGE')
          AND pg_catalog.has_table_privilege(current_user,order_oid,'SELECT')
          AND pg_catalog.has_table_privilege(current_user,order_oid,'INSERT')
          AND pg_catalog.has_table_privilege(current_user,order_oid,'UPDATE')
          AND pg_catalog.has_table_privilege(current_user,user_oid,'SELECT')
          AND pg_catalog.has_any_column_privilege(current_user,user_oid,'UPDATE'),false) AS protocol_privileges
      FROM objects
    ) AS permission_audit`);
    if (!checks) throw new Error('Runtime permission audit returned no catalog result');
    const failures = Object.entries(checks).filter(([, value]) => value !== true).map(([name]) => name);
    return { ready: failures.length === 0, checks, failures };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
