import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { CASHIER_SECOND_CARD_TABLES } from './cashierSecondCardRuntimePlan';
import { inspectCashierSecondCardOrigin } from './runCashierSecondCardOrigin';

type Query = Pick<DbClient, 'execute'>;
export interface RuntimeAppCashierOriginReaderAddon { cashierOrigin: true }
export const RUNTIME_APP_CASHIER_ORIGIN_READ_TABLE = 'cashier_second_card_origin_v1';
const validators = ['cashier_second_card_origin_valid_v1', 'cashier_second_card_payment_valid_v1'];

export function captureRuntimeAppCashierOriginReader(value: RuntimeAppCashierOriginReaderAddon) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Reflect.ownKeys(value).length !== 1 || !Object.hasOwn(value, 'cashierOrigin') || value.cashierOrigin !== true)
    throw Error('Explicit App cashier-origin reader option required');
  return { cashierOrigin: true as const };
}

/** Named immutable source proof for App's assisted-order namespace exclusion.
 * The complete App auditor separately checks every other role privilege. This
 * never impersonates that LOGIN, installs sources or grants producer rights. */
export async function inspectRuntimeAppCashierOriginReader(db: Query, options: {
  role: string; maintenance: string; requirePrivileges: boolean; addon: RuntimeAppCashierOriginReaderAddon;
}) {
  const role = options.role, maintenance = options.maintenance;
  pricingIdentifier(role); pricingIdentifier(maintenance); captureRuntimeAppCashierOriginReader(options.addon);
  if (role === maintenance || typeof options.requirePrivileges !== 'boolean')
    throw Error('Distinct App reader and explicit maintenance source stage required');
  const catalogFailures: string[] = [], failures: string[] = [];
  const catalog = await inspectCashierSecondCardOrigin(db);
  if (!catalog.complete) catalogFailures.push('cashier_origin_catalog');
  const rows = await db.execute<Record<string, unknown>>(sql`WITH RECURSIVE
    runtime AS(SELECT * FROM pg_catalog.pg_roles WHERE rolname=${role}),
    maintenance AS(SELECT * FROM pg_catalog.pg_roles WHERE rolname=${maintenance}),
    authority(oid) AS(SELECT oid FROM runtime UNION SELECT m.roleid FROM pg_catalog.pg_auth_members m JOIN authority a ON m.member=a.oid),
    sources AS(SELECT c.* FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::regnamespace
      AND c.relname IN(SELECT jsonb_array_elements_text(${JSON.stringify(CASHIER_SECOND_CARD_TABLES)}::jsonb))),
    validators AS(SELECT p.* FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace
      AND p.proname IN(SELECT jsonb_array_elements_text(${JSON.stringify(validators)}::jsonb)))
    SELECT
      current_setting('server_version_num')::integer/10000=16 AND current_setting('session_replication_role')='origin'
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS supported,
      (SELECT count(*)=1 AND bool_and(rolsuper) FROM maintenance) AS maintenance_owner,
      (SELECT count(*)=3 AND bool_and(c.relowner=(SELECT oid FROM maintenance) AND c.relkind='r' AND c.relpersistence='p'
        AND NOT(c.relrowsecurity OR c.relforcerowsecurity OR c.relispartition OR c.relhasrules)
        AND c.reloptions IS NULL AND c.relreplident='d' AND c.relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='heap')) FROM sources c)
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_index x JOIN sources c ON c.oid=x.indrelid
          JOIN pg_catalog.pg_class i ON i.oid=x.indexrelid WHERE i.relowner<>c.relowner OR i.relnamespace<>c.relnamespace)
        AS source_owners,
      (SELECT count(*)=2 AND bool_and(p.proowner=(SELECT oid FROM maintenance) AND NOT p.prosecdef) FROM validators p) AS validator_owners,
      NOT EXISTS(SELECT 1 FROM sources c CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
        WHERE a.grantee<>c.relowner AND(a.grantee=0 OR a.is_grantable OR a.privilege_type NOT IN('SELECT','INSERT')))
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a JOIN sources c ON c.oid=a.attrelid WHERE a.attacl IS NOT NULL) AS source_acl,
      NOT EXISTS(SELECT 1 FROM validators p CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND(a.grantee=0 OR a.is_grantable OR a.privilege_type<>'EXECUTE')) AS validator_acl,
      NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d JOIN sources c ON c.oid=d.refobjid
        JOIN pg_catalog.pg_class s ON s.oid=d.objid WHERE d.classid='pg_catalog.pg_class'::regclass
          AND d.refclassid=d.classid AND d.deptype IN('a','i') AND s.relkind='S') AS no_source_sequence,
      NOT EXISTS(SELECT 1 FROM authority a JOIN sources c ON c.relowner=a.oid
        OR pg_catalog.has_table_privilege(a.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR pg_catalog.has_any_column_privilege(a.oid,c.oid,'INSERT,UPDATE,REFERENCES'))
        AND NOT EXISTS(SELECT 1 FROM authority a JOIN validators p ON p.proowner=a.oid
          OR pg_catalog.has_function_privilege(a.oid,p.oid,'EXECUTE')) AS no_source_writer_authority,
      NOT EXISTS(SELECT 1 FROM pg_catalog.pg_default_acl d CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a
        WHERE a.grantee=(SELECT oid FROM runtime) OR(a.grantee=0 AND d.defaclobjtype IN('r','S'))) AS no_default_grants,
      (SELECT count(*)=1 AND bool_and(r.rolcanlogin AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid)
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend d WHERE d.refclassid='pg_catalog.pg_authid'::regclass AND d.refobjid=r.oid AND d.deptype='o')
        AND pg_catalog.has_database_privilege(r.oid,current_database(),'CONNECT') AND pg_catalog.has_schema_privilege(r.oid,'public','USAGE')
        AND NOT pg_catalog.has_database_privilege(r.oid,current_database(),'CREATE')
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE'))
        AND NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET,ALTER SYSTEM')) FROM runtime r) AS target_identity,
      NOT EXISTS(SELECT 1 FROM authority a JOIN sources c ON c.relname<>${RUNTIME_APP_CASHIER_ORIGIN_READ_TABLE}
        WHERE pg_catalog.has_table_privilege(a.oid,c.oid,'SELECT') OR pg_catalog.has_any_column_privilege(a.oid,c.oid,'SELECT')) AS no_other_source_read,
      NOT EXISTS(SELECT 1 FROM authority a JOIN sources c ON c.relname=${RUNTIME_APP_CASHIER_ORIGIN_READ_TABLE}
        WHERE pg_catalog.has_table_privilege(a.oid,c.oid,'SELECT WITH GRANT OPTION')
          OR pg_catalog.has_any_column_privilege(a.oid,c.oid,'SELECT WITH GRANT OPTION')) AS no_read_delegation,
      (SELECT count(*)=1 AND bool_and(pg_catalog.has_table_privilege((SELECT oid FROM runtime),c.oid,'SELECT'))
        FROM sources c WHERE c.relname=${RUNTIME_APP_CASHIER_ORIGIN_READ_TABLE}) AS target_read,
      (SELECT oid::text FROM runtime) AS role_oid,(SELECT oid::text FROM maintenance) AS maintenance_oid,
      (SELECT jsonb_agg(jsonb_build_object('name',c.relname,'oid',c.oid::text,'owner',c.relowner::text) ORDER BY c.relname) FROM sources c) AS source_bindings,
      (SELECT jsonb_agg(jsonb_build_object('name',p.proname,'oid',p.oid::text,'owner',p.proowner::text) ORDER BY p.proname) FROM validators p) AS validator_bindings`);
  const row = rows[0];
  if (rows.length !== 1) catalogFailures.push('source_identity');
  for (const key of ['supported', 'maintenance_owner', 'source_owners', 'validator_owners', 'source_acl', 'validator_acl',
    'no_source_sequence', 'no_source_writer_authority', 'no_default_grants', 'target_identity', 'no_other_source_read', 'no_read_delegation'])
    if (row?.[key] !== true) catalogFailures.push(key);
  if (options.requirePrivileges && row?.target_read !== true) failures.push('target_read');
  const unique = [...new Set([...catalogFailures, ...failures])].sort();
  return { ready: unique.length === 0, catalogReady: catalogFailures.length === 0, failures: unique, readOnly: true as const,
    table: RUNTIME_APP_CASHIER_ORIGIN_READ_TABLE, sourceBindings: row?.source_bindings ?? null,
    validatorBindings: row?.validator_bindings ?? null, roleOid: row?.role_oid ?? null, maintenanceOid: row?.maintenance_oid ?? null,
    sourceWritesGranted: false as const, conditionalWriteSemanticsVerified: false as const, completeServiceCoverageVerified: false as const };
}
