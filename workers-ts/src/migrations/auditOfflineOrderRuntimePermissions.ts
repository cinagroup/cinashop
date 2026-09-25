import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { OFFLINE_BARCODE_CATALOG_VERSIONS, OFFLINE_CATALOG_SQL, OFFLINE_CATALOG_VERSIONS, OFFLINE_FUNCTIONS, OFFLINE_TABLES, OFFLINE_DISPATCH_COLUMNS } from './offlineOrderCatalog';
import { OFFLINE_RUNTIME_READ_TABLES, OFFLINE_RUNTIME_INSERT_TABLES, OFFLINE_RUNTIME_UPDATE_TABLES,
  OFFLINE_RUNTIME_UPDATE_COLUMNS, OFFLINE_RUNTIME_SEQUENCES } from './offlineOrderRuntimeContract';
import { auditCheckoutPricingLockRuntime, inspectCheckoutPricingLock } from './checkoutPricingLock';
import { validatePricingRuntimeScope, type PricingRuntimeScope } from './reviewedOfflinePricingCapability';

const literals = (names: readonly string[]) => names.map(n => "'" + n + "'").join(',');
const values = (names: readonly string[]) => names.map(n => '(' + "'" + n + "'" + ')').join(',');
const requirements = [
  ...OFFLINE_RUNTIME_READ_TABLES.map(n => `('${n}','SELECT')`),
  ...OFFLINE_RUNTIME_INSERT_TABLES.map(n => `('${n}','INSERT')`),
  ...OFFLINE_RUNTIME_UPDATE_TABLES.map(n => `('${n}','UPDATE')`),
].join(',');
const columns = Object.entries(OFFLINE_RUNTIME_UPDATE_COLUMNS).flatMap(([table, names]) => names.map(name => `('${table}','${name}')`)).join(',');

/** Read-only release preflight of the actual connection, not a named-role
 * simulation. No business rows, GRANT, DDL, nextval, provider I/O or implicit
 * credentials. Catalog and permissions share one repeatable-read snapshot.
 * It does not certify all app features, data history or later admin changes. */
export async function auditOfflineOrderRuntimePermissions(
  db: Pick<DbClient, 'transaction'> & Partial<Pick<DbClient, '$client'>>,
  scope: PricingRuntimeScope = 'isolated',
) {
  validatePricingRuntimeScope(scope);
  if (!Object.hasOwn(db, '$client') || !db.$client) throw Error('Offline runtime audit requires a root database');
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT
      pg_catalog.set_config('search_path','public, pg_temp',true),
      pg_catalog.set_config('row_security','off',true),
      pg_catalog.set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
      pg_catalog.set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
      pg_catalog.set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
    const [version] = await tx.execute(sql`SELECT current_setting('server_version_num')::int/10000 AS major`);
    if (version?.major !== 16) throw Error('Offline runtime audit requires PostgreSQL 16');
    const rows = await tx.execute(sql.raw(OFFLINE_CATALOG_SQL));
    const expected = OFFLINE_CATALOG_VERSIONS.v1;
    const catalogVerified = rows.length === 27 && new Set(rows.map(r => r.name)).size === 27
      && rows.every(r => typeof r.name === 'string' && Object.hasOwn(expected,r.name)
        && r.present === true && r.safe === true
        && (r.fingerprint === expected[r.name] || r.fingerprint === OFFLINE_BARCODE_CATALOG_VERSIONS.v1[r.name]));
    const offlineOid = catalogVerified ? rows.find(row => row.kind === 'function' && row.name === 'ooa_lock_pricing')?.oid : null;
    // Explicit shared scope additionally verifies checkout's exact definition,
    // restricted NOLOGIN owner, ACLs AND this connection's pricing authority.
    const pricing = scope === 'shared-shop' ? await auditCheckoutPricingLockRuntime(tx, 'public', scope) : null;
    const checkoutOid = pricing?.ready ? (await inspectCheckoutPricingLock(tx)).functionOid : null;
    const reviewedOids = [offlineOid, checkoutOid].filter((oid): oid is string => typeof oid === 'string' && /^\d+$/.test(oid));
    const reviewedDefiners = reviewedOids.length ? `p.oid::text IN (${literals(reviewedOids)})` : 'false';
    // Catalog 'owned' is intentionally not used: the application MUST NOT own
    // these objects. Reachable ownership is checked independently below.
    const [raw] = await tx.execute(sql.raw(`WITH
      connected AS (SELECT usesysid FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid()),
      identities AS (SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN(current_user,session_user) UNION SELECT usesysid FROM connected),
      reachable AS (SELECT r.* FROM pg_catalog.pg_roles r WHERE EXISTS(SELECT 1 FROM identities i
        WHERE pg_catalog.pg_has_role(i.oid,r.oid,'USAGE') OR pg_catalog.pg_has_role(i.oid,r.oid,'SET')
          OR pg_catalog.pg_has_role(i.oid,r.oid,'MEMBER WITH ADMIN OPTION'))),
      target_schema AS (SELECT oid,nspowner FROM pg_catalog.pg_namespace WHERE nspname='public'),
      target_database AS (SELECT oid,datdba FROM pg_catalog.pg_database WHERE datname=current_database()),
      wanted(name) AS (VALUES ${values(OFFLINE_RUNTIME_READ_TABLES)}),
      objects AS (SELECT w.name,c.* FROM wanted w CROSS JOIN target_schema n LEFT JOIN pg_catalog.pg_class c
        ON c.relnamespace=n.oid AND c.relname=w.name),
      required(table_name,privilege) AS (VALUES ${requirements}),
      required_columns(table_name,column_name) AS (VALUES ${columns}),
      sequence_names(name,table_name,column_name) AS (VALUES ${OFFLINE_RUNTIME_SEQUENCES.map(row => '(' + literals(row) + ')').join(',')}),
      sequences AS (SELECT w.name,s.oid,s.relowner,s.relacl,s.relkind,
        EXISTS(SELECT 1 FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_class t ON t.oid=d.refobjid
          JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid
          WHERE d.classid='pg_catalog.pg_class'::regclass AND d.objid=s.oid AND d.deptype IN('a','i')
            AND d.refclassid='pg_catalog.pg_class'::regclass AND t.relnamespace=n.oid AND t.relname=w.table_name
            AND a.attname=w.column_name AND NOT a.attisdropped) AS owned_by_column
        FROM sequence_names w CROSS JOIN target_schema n LEFT JOIN pg_catalog.pg_class s ON s.relnamespace=n.oid AND s.relname=w.name),
      functions AS (SELECT p.oid,p.proowner,p.proname FROM pg_catalog.pg_proc p CROSS JOIN target_schema n
        WHERE p.pronamespace=n.oid AND p.proname IN(${literals(OFFLINE_FUNCTIONS)}))
      SELECT
        (SELECT count(*)=1 AND bool_and(usesysid IS NOT NULL) FROM connected)
          AND EXISTS(SELECT 1 FROM connected c JOIN pg_catalog.pg_roles r ON r.oid=c.usesysid AND r.rolcanlogin)
          AND (SELECT count(*) FROM identities)>=1 AS "connectionIdentityVisible",
        (SELECT count(*)=${OFFLINE_RUNTIME_READ_TABLES.length} AND bool_and(COALESCE(oid IS NOT NULL AND relkind='r'
          AND relpersistence='p' AND NOT relispartition AND NOT relrowsecurity AND NOT relforcerowsecurity,false)) FROM objects)
          AND NOT EXISTS(SELECT 1 FROM objects o WHERE EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=o.oid OR inhparent=o.oid)
            OR EXISTS(SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid=o.oid)
            OR EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=o.oid)) AS "objectsPresentAndUnrestricted",
        NOT EXISTS(SELECT 1 FROM reachable WHERE rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls
          OR rolname IN('pg_read_server_files','pg_write_server_files','pg_execute_server_program','pg_read_all_data','pg_write_all_data')) AS "unprivilegedReachableRoles",
        NOT EXISTS(SELECT 1 FROM reachable WHERE oid IN(SELECT relowner FROM objects UNION SELECT relowner FROM sequences
          UNION SELECT proowner FROM functions UNION SELECT nspowner FROM target_schema UNION SELECT datdba FROM target_database)) AS "noOwnerControl",
        NOT EXISTS(SELECT 1 FROM reachable r CROSS JOIN target_schema n CROSS JOIN target_database d
          WHERE pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE') OR pg_catalog.has_database_privilege(r.oid,d.oid,'CREATE')) AS "noSchemaCreation",
        NOT EXISTS(SELECT 1 FROM reachable r CROSS JOIN objects o WHERE pg_catalog.has_table_privilege(r.oid,o.oid,'TRIGGER,TRUNCATE')) AS "noTriggerOrTruncate",
        NOT EXISTS(SELECT 1 FROM reachable r CROSS JOIN objects o WHERE o.name IN(${literals(OFFLINE_TABLES)})
          AND (pg_catalog.has_table_privilege(r.oid,o.oid,'DELETE,UPDATE') OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a
            WHERE a.attrelid=o.oid AND a.attnum>0 AND NOT a.attisdropped AND pg_catalog.has_column_privilege(r.oid,o.oid,a.attnum,'UPDATE')
            AND NOT(o.name='offline_order_payment_dispatch' AND a.attname IN(${literals(OFFLINE_DISPATCH_COLUMNS)}))))) AS "noLedgerRewrite",
        current_setting('session_replication_role')='origin' AND NOT EXISTS(SELECT 1 FROM reachable WHERE
          pg_catalog.has_parameter_privilege(oid,'session_replication_role','SET,ALTER SYSTEM')) AS "noReplicationBypass",
        NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS "noDdlHooks",
        (SELECT count(*)=7 AND bool_and(COALESCE(oid IS NOT NULL AND relkind='S' AND owned_by_column,false)) FROM sequences) AS "sequenceBindingsVerified",
        NOT EXISTS(SELECT 1 FROM reachable r CROSS JOIN sequences s WHERE pg_catalog.has_sequence_privilege(r.oid,s.oid,'UPDATE')) AS "noSequenceReset",
        NOT EXISTS(SELECT 1 FROM reachable r CROSS JOIN objects o WHERE
          pg_catalog.has_table_privilege(r.oid,o.oid,'SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION,DELETE WITH GRANT OPTION,REFERENCES WITH GRANT OPTION')
          OR pg_catalog.has_any_column_privilege(r.oid,o.oid,'SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION,REFERENCES WITH GRANT OPTION'))
          AND NOT EXISTS(SELECT 1 FROM reachable r CROSS JOIN functions p WHERE pg_catalog.has_function_privilege(r.oid,p.oid,'EXECUTE WITH GRANT OPTION'))
          AND NOT EXISTS(SELECT 1 FROM reachable r CROSS JOIN sequences s WHERE pg_catalog.has_sequence_privilege(r.oid,s.oid,'USAGE WITH GRANT OPTION,SELECT WITH GRANT OPTION'))
          AND NOT EXISTS(SELECT 1 FROM reachable r CROSS JOIN target_schema n CROSS JOIN target_database d
            WHERE pg_catalog.has_schema_privilege(r.oid,n.oid,'USAGE WITH GRANT OPTION') OR pg_catalog.has_database_privilege(r.oid,d.oid,'CONNECT WITH GRANT OPTION,TEMP WITH GRANT OPTION'))
          AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m JOIN reachable r ON r.oid=m.member WHERE m.admin_option) AS "noGrantDelegation",
        NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
          WHERE p.prosecdef AND n.nspname!~'^pg_' AND n.nspname<>'information_schema'
            AND NOT(${reviewedDefiners})
            AND EXISTS(SELECT 1 FROM reachable r WHERE pg_catalog.has_function_privilege(r.oid,p.oid,'EXECUTE'))) AS "noUnreviewedDefinerRoutine",
        EXISTS(SELECT 1 FROM target_schema WHERE pg_catalog.has_schema_privilege(current_user,oid,'USAGE'))
          AND NOT EXISTS(SELECT 1 FROM required r LEFT JOIN objects o ON o.name=r.table_name
            WHERE NOT COALESCE(pg_catalog.has_table_privilege(current_user,o.oid,r.privilege),false)) AS "requiredTablePrivileges",
        NOT EXISTS(SELECT 1 FROM required_columns r LEFT JOIN objects o ON o.name=r.table_name
          LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=o.oid AND a.attname=r.column_name AND NOT a.attisdropped
          WHERE NOT COALESCE(pg_catalog.has_column_privilege(current_user,o.oid,a.attnum,'UPDATE'),false)) AS "requiredColumnPrivileges",
        (SELECT count(*)=7 AND bool_and(COALESCE(pg_catalog.has_sequence_privilege(current_user,oid,'USAGE'),false)) FROM sequences) AS "requiredSequenceUsage",
        EXISTS(SELECT 1 FROM functions WHERE proname='ooa_lock_pricing' AND pg_catalog.has_function_privilege(current_user,oid,'EXECUTE')) AS "requiredFunctionExecute"
    `));
    if (!raw) throw Error('Offline runtime audit returned no result');
    const checks = { protectedCatalogVerified: catalogVerified,
      ...(scope === 'shared-shop' ? { sharedCheckoutPricingReady: pricing?.ready === true } : {}),
      ...Object.fromEntries(Object.entries(raw).map(([key,value]) => [key,value === true])) };
    const failures = Object.entries(checks).filter(([,value]) => !value).map(([key]) => key);
    return { scope: 'offline-cashier-collection-v1' as const, ready: failures.length === 0, readOnly: true as const,
      completeApplicationVerified: false as const, businessDataVerified: false as const, checks, failures };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
