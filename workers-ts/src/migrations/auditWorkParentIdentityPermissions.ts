import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';

/** Read-only parent-identity envelope, NOT a complete application grant/RLS
 * audit or automatic GRANT/REVOKE plan. Ordinary non-key updates remain allowed.
 * A separate maintenance identity can still change the catalog after this check.
 */
export async function auditWorkParentIdentityPermissions(
  db: Pick<DbClient, 'transaction'> & Partial<Pick<DbClient, '$client'>>,
  schema = 'public',
) {
  if (!db.$client) throw new Error('Work parent identity audit requires a root database');
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema) || schema.startsWith('pg_') || schema === 'information_schema') {
    throw new Error('Invalid work parent identity audit schema');
  }
  return db.transaction(async tx => {
    await tx.execute(sql.raw(`SELECT
      pg_catalog.set_config('statement_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
      pg_catalog.set_config('lock_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text || 'ms',true),
      pg_catalog.set_config('idle_in_transaction_session_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true)`));
    const [checks] = await tx.select({
      connectionIdentityVisible: sql<boolean>`connection_identity_visible`,
      objectsAndKeysPresent: sql<boolean>`objects_and_keys_present`,
      unprivilegedReachableRoles: sql<boolean>`unprivileged_roles`,
      noOwnerControl: sql<boolean>`no_owner_control`,
      noSchemaCreation: sql<boolean>`no_schema_creation`,
      noParentRemovalOrTriggerCreation: sql<boolean>`no_parent_removal`,
      noReferencedKeyUpdate: sql<boolean>`no_key_update`,
      noReplicationBypass: sql<boolean>`no_replication_bypass`,
      noUnreviewedDefinerRoutine: sql<boolean>`no_definer_routine`,
      parentReadAccess: sql<boolean>`parent_read_access`,
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
      ), target_schema AS (
        SELECT n.oid,n.nspowner FROM pg_catalog.pg_namespace n WHERE n.nspname=${schema}
      ), wanted(relname,keys) AS (VALUES
        ('work_client_current',ARRAY['corp_id','id']::text[]),
        ('work_callback_event',ARRAY['id','corp_id','event_key','subject_key_hash','event_time','sequence_rank']::text[])
      ), objects AS (
        SELECT w.relname,w.keys,c.oid,c.relowner FROM wanted w CROSS JOIN target_schema n
        LEFT JOIN pg_catalog.pg_class c ON c.relnamespace=n.oid AND c.relname=w.relname AND c.relkind='r'
      ), key_columns AS (
        SELECT o.oid,a.attnum FROM objects o CROSS JOIN LATERAL unnest(o.keys) k(name)
        LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=o.oid AND a.attname=k.name AND a.attnum>0 AND NOT a.attisdropped
      ), current_database_owner AS (
        SELECT oid,datdba FROM pg_catalog.pg_database WHERE datname=current_database()
      )
      SELECT
        (SELECT count(*)=1 AND bool_and(usesysid IS NOT NULL) FROM connected)
          AND EXISTS (SELECT 1 FROM connected c JOIN pg_catalog.pg_roles r ON r.oid=c.usesysid) AS connection_identity_visible,
        (SELECT count(*)=2 AND bool_and(oid IS NOT NULL) FROM objects)
          AND (SELECT count(*)=8 AND bool_and(attnum IS NOT NULL) FROM key_columns) AS objects_and_keys_present,
        NOT EXISTS (SELECT 1 FROM reachable WHERE rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls
          OR rolname IN ('pg_write_server_files','pg_execute_server_program')) AS unprivileged_roles,
        NOT EXISTS (SELECT 1 FROM reachable WHERE oid IN
          (SELECT relowner FROM objects UNION SELECT nspowner FROM target_schema UNION SELECT datdba FROM current_database_owner)) AS no_owner_control,
        NOT EXISTS (SELECT 1 FROM reachable r CROSS JOIN target_schema n CROSS JOIN current_database_owner d
          WHERE pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE') OR pg_catalog.has_database_privilege(r.oid,d.oid,'CREATE')) AS no_schema_creation,
        NOT EXISTS (SELECT 1 FROM reachable r CROSS JOIN objects o
          WHERE pg_catalog.has_table_privilege(r.oid,o.oid,'DELETE,TRUNCATE,TRIGGER')) AS no_parent_removal,
        NOT EXISTS (SELECT 1 FROM reachable r CROSS JOIN key_columns k
          WHERE pg_catalog.has_column_privilege(r.oid,k.oid,k.attnum,'UPDATE')) AS no_key_update,
        current_setting('session_replication_role') IN ('origin','local') AND NOT EXISTS (
          SELECT 1 FROM reachable WHERE pg_catalog.has_parameter_privilege(oid,'session_replication_role','SET')
            OR pg_catalog.has_parameter_privilege(oid,'session_replication_role','ALTER SYSTEM')) AS no_replication_bypass,
        NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
          WHERE p.prosecdef AND NOT pg_catalog.starts_with(n.nspname::text,'pg_') AND n.nspname<>'information_schema'
            AND EXISTS (SELECT 1 FROM reachable r WHERE pg_catalog.has_function_privilege(r.oid,p.oid,'EXECUTE'))) AS no_definer_routine,
        (SELECT count(*)=2 AND bool_and(COALESCE(pg_catalog.has_table_privilege(current_user,oid,'SELECT'),false)) FROM objects)
          AND EXISTS (SELECT 1 FROM target_schema WHERE pg_catalog.has_schema_privilege(current_user,oid,'USAGE')) AS parent_read_access
    ) AS work_parent_permissions`);
    if (!checks) throw new Error('Work parent identity audit returned no catalog result');
    const failures = Object.entries(checks).filter(([, value]) => value !== true).map(([name]) => name);
    return { scope: 'work-parent-identity-only' as const, ready: failures.length === 0, checks, failures };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
