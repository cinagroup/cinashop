import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { CASHIER_SECOND_CARD_TABLES } from './cashierSecondCardRuntimePlan';
import { inspectCashierSecondCardOrigin } from './runCashierSecondCardOrigin';
import { inspectSupplierOrderEditOperation, SUPPLIER_ORDER_EDIT_OPERATION_CONSTRAINTS_SHA256 } from './supplierOrderEditOperation';
import { inspectLegacyOrderGainPartition, LEGACY_ORDER_GAIN_PARTITION_CONSTRAINTS_SHA256 } from './legacyOrderGainPartition';

type Query = Pick<DbClient, 'execute'>;
/** Explicit immutable source readers. This is not a cashier producer profile. */
export interface CustomerFinancialOriginalPaymentReadersAddon { secondCard: true }
export const CUSTOMER_FINANCIAL_ORIGINAL_PAYMENT_READ_TABLES = [
  'cashier_second_card_origin_v1', 'cashier_second_card_payment_v1',
  'supplier_order_edit_operation_v1', 'legacy_order_gain_partition_v1',
] as const;
const sourceTables = [...CASHIER_SECOND_CARD_TABLES, 'supplier_order_edit_operation_v1', 'legacy_order_gain_partition_v1'];
const functions = ['cashier_second_card_origin_valid_v1', 'cashier_second_card_payment_valid_v1',
  'supplier_order_edit_operation_immutable_v1', 'legacy_order_gain_partition_immutable_v1'];

export function captureCustomerFinancialOriginalPaymentReaders(value: CustomerFinancialOriginalPaymentReadersAddon) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).join(',') !== 'secondCard' || value.secondCard !== true)
    throw Error('Explicit complete second-card original-payment reader option required');
  return { secondCard: true as const };
}

// Exact columns of the existing independent protocols. Their inspectors bind
// all CHECK/index/trigger/function attributes; current-user read permission is
// deliberately checked separately against the named target below.
const column = (index: number, name: string, type = 'integer', nullable = false) =>
  [index, name, type, !nullable, false, '', '', false, type.startsWith('character varying') ? '"default"' : null];
const editColumns = [column(1, 'operation_id', 'uuid'), column(2, 'actor_id'), column(3, 'supplier_id'), column(4, 'order_id'),
  column(5, 'request_hash', 'character varying(64)'), column(6, 'state', 'character varying(16)'),
  column(7, 'before_hash', 'character varying(64)'), column(8, 'after_hash', 'character varying(64)'),
  column(9, 'evidence', 'jsonb', true), column(10, 'result', 'jsonb', true), column(11, 'created_at')];
const partitionColumns = [column(1, 'partition_id', 'uuid'), column(2, 'operation_id', 'uuid'), column(3, 'source_order_id'),
  column(4, 'child_order_id'), column(5, 'buyer_id'), column(6, 'supplier_id'), column(7, 'kind', 'character varying(16)'),
  column(8, 'source_hash', 'character varying(64)'), column(9, 'child_hash', 'character varying(64)'),
  column(10, 'evidence', 'jsonb'), column(11, 'created_at')];

/** Named-role/catalog proof, never SET ROLE or a substitute actual LOGIN audit.
 * The four reads cover ordinary and protected supplier-edited second-card
 * ancestry. Creating new legacy gain partitions still needs a separate writer
 * contract; this addon confers no INSERT or function EXECUTE authority. */
export async function inspectCustomerFinancialOriginalPaymentReaders(db: Query, options: {
  role: string; maintenance: string; readers: CustomerFinancialOriginalPaymentReadersAddon; requirePrivileges: boolean;
}) {
  const role = options.role, maintenance = options.maintenance;
  pricingIdentifier(role); pricingIdentifier(maintenance); captureCustomerFinancialOriginalPaymentReaders(options.readers);
  if (typeof options.requirePrivileges !== 'boolean' || role === maintenance) throw Error('Distinct named source reader and maintenance required');
  const catalogFailures: string[] = [], failures: string[] = [];
  const cashier = await inspectCashierSecondCardOrigin(db);
  if (!cashier.complete) catalogFailures.push('second_card_catalog');
  const edit = await inspectSupplierOrderEditOperation(db, 'read'), partition = await inspectLegacyOrderGainPartition(db, 'read');
  for (const [name, state, columns, hash] of [
    ['supplier_edit', edit, editColumns, SUPPLIER_ORDER_EDIT_OPERATION_CONSTRAINTS_SHA256],
    ['legacy_gain_partition', partition, partitionColumns, LEGACY_ORDER_GAIN_PARTITION_CONSTRAINTS_SHA256],
  ] as const) {
    if (!state || ['supported', 'safe', 'constraint_count', 'indexes', 'triggers', 'function'].some(key => state[key] !== true)
      || state.constraints_hash !== hash || JSON.stringify(state.columns) !== JSON.stringify(columns)) catalogFailures.push(name + '_catalog');
  }
  const rows = await db.execute<Record<string, unknown>>(sql`WITH RECURSIVE
    runtime AS(SELECT * FROM pg_catalog.pg_roles WHERE rolname=${role}),
    maintenance AS(SELECT * FROM pg_catalog.pg_roles WHERE rolname=${maintenance}),
    authority(oid) AS(SELECT oid FROM runtime UNION SELECT m.roleid FROM pg_catalog.pg_auth_members m JOIN authority a ON m.member=a.oid),
    sources AS(SELECT c.* FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::regnamespace
      AND c.relname IN(SELECT jsonb_array_elements_text(${JSON.stringify(sourceTables)}::jsonb))),
    readers AS(SELECT * FROM sources WHERE relname IN(SELECT jsonb_array_elements_text(${JSON.stringify(CUSTOMER_FINANCIAL_ORIGINAL_PAYMENT_READ_TABLES)}::jsonb))),
    validators AS(SELECT p.* FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace
      AND p.proname IN(SELECT jsonb_array_elements_text(${JSON.stringify(functions)}::jsonb)))
    SELECT
      current_setting('server_version_num')::integer/10000=16 AND current_setting('session_replication_role')='origin'
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS supported,
      (SELECT count(*)=1 AND bool_and(rolsuper) FROM maintenance) AS maintenance_owner,
      (SELECT count(*)=5 AND bool_and(c.relowner=(SELECT oid FROM maintenance) AND c.relkind='r' AND c.relpersistence='p'
        AND NOT(c.relrowsecurity OR c.relforcerowsecurity OR c.relispartition OR c.relhasrules)
        AND c.reloptions IS NULL AND c.relreplident='d' AND c.relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='heap')) FROM sources c)
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_index x JOIN sources c ON c.oid=x.indrelid
          JOIN pg_catalog.pg_class i ON i.oid=x.indexrelid WHERE i.relowner<>c.relowner OR i.relnamespace<>c.relnamespace)
        AS source_owners,
      (SELECT count(*)=4 AND bool_and(p.proowner=(SELECT oid FROM maintenance) AND NOT p.prosecdef) FROM validators p) AS validator_owners,
      NOT EXISTS(SELECT 1 FROM sources c CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
        WHERE a.grantee<>c.relowner AND(a.grantee=0 OR a.is_grantable OR a.privilege_type NOT IN('SELECT','INSERT')))
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a JOIN sources c ON c.oid=a.attrelid WHERE a.attacl IS NOT NULL) AS source_acl,
      NOT EXISTS(SELECT 1 FROM validators p CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND(a.grantee=0 OR a.is_grantable OR a.privilege_type<>'EXECUTE'
          OR p.proname IN('supplier_order_edit_operation_immutable_v1','legacy_order_gain_partition_immutable_v1'))) AS validator_acl,
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
      (SELECT count(*)=1 AND bool_and(NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid)
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend d WHERE d.refclassid='pg_catalog.pg_authid'::regclass AND d.refobjid=r.oid AND d.deptype='o')
        AND NOT pg_catalog.has_database_privilege(r.oid,current_database(),'CREATE')
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE'))
        AND NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET,ALTER SYSTEM')) FROM runtime r) AS target_identity,
      NOT EXISTS(SELECT 1 FROM runtime r JOIN sources c ON c.relname='cashier_second_card_cart_v1'
        WHERE pg_catalog.has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          OR pg_catalog.has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')) AS no_cashier_cart,
      (SELECT count(*)=4 AND bool_and(pg_catalog.has_table_privilege((SELECT oid FROM runtime),c.oid,'SELECT')
        AND NOT pg_catalog.has_table_privilege((SELECT oid FROM runtime),c.oid,'SELECT WITH GRANT OPTION')) FROM readers c) AS target_read,
      (SELECT jsonb_agg(jsonb_build_object('name',c.relname,'oid',c.oid::text,'owner',c.relowner::text) ORDER BY c.relname) FROM sources c) AS source_bindings,
      (SELECT jsonb_agg(jsonb_build_object('name',p.proname,'oid',p.oid::text,'owner',p.proowner::text) ORDER BY p.proname) FROM validators p) AS validator_bindings`);
  const row = rows[0];
  if (rows.length !== 1) catalogFailures.push('source_identity');
  for (const key of ['supported', 'maintenance_owner', 'source_owners', 'validator_owners', 'source_acl', 'validator_acl',
    'no_source_sequence', 'no_source_writer_authority', 'no_default_grants', 'target_identity', 'no_cashier_cart'])
    if (row?.[key] !== true) catalogFailures.push(key);
  if (options.requirePrivileges && row?.target_read !== true) failures.push('target_read');
  const unique = [...new Set([...catalogFailures, ...failures])].sort();
  return { ready: unique.length === 0, catalogReady: catalogFailures.length === 0, failures: unique, readOnly: true as const,
    tables: [...CUSTOMER_FINANCIAL_ORIGINAL_PAYMENT_READ_TABLES], sourceBindings: row?.source_bindings ?? null,
    validatorBindings: row?.validator_bindings ?? null, completeServiceCoverageVerified: false as const,
    sourceWritesGranted: false as const, legacyGainPartitionWriterCommissioned: false as const };
}
