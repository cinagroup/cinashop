import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { inspectCustomerManualRefund } from './runCustomerManualRefund';
import { inspectCustomerFinancialOperation } from './runCustomerFinancialOperation';
import { CUSTOMER_FINANCIAL_MANUAL_CATALOG_SHA256 } from './customerManualRefundPins';
import { customerManualGuestIdentityReadiness } from './guestRefundEntityCatalog';
import { reviewedManualRefundPromotionLockCatalogQuery } from './cashierSecondCardPromotionLock';
import { inspectCustomerManualManagerOriginReadiness } from './customerManualOfflineOriginCatalog';
import { inspectManagerRuntimeCapabilities, managerRuntimeCapabilityDefinitions } from './managerRuntimeCapabilities';

type Query = Pick<DbClient, 'execute'>;
export interface CustomerFinancialManualRefundRuntimeOptions {
  role: string;
  promotionOwner: string;
  requirePrivileges: boolean;
}
const ownerReads = ['customer_financial_manual_refund_v1', 'customer_financial_operation_request',
  'store_order', 'store_order_refund', 'store_order_refund_split', 'store_order_promotions'] as const;
const guardKeys = ['tablesSafe', 'definitionSafe', 'triggerSafe', 'ownerSafe', 'roleSafe', 'aclSafe'] as const;
const catalogKeys = ['pg16', 'owner_bound', 'owner_restricted', 'owner_isolated', 'owner_data', 'owner_columns',
  'owner_sequences', 'owner_functions', 'owner_defaults', 'owner_no_delegation', 'target_restricted',
  'manual_acl', 'financial_acl', 'function_acl', 'target_manual_safe', 'target_promotion_safe', 'target_sequence_safe',
  'target_function_safe'] as const;
const privilegeKeys = ['target_manual_read', 'target_manual_append', 'target_promotion_read', 'target_promotion_append',
  'target_promotion_lock', 'target_sequence_usage', 'target_function_execute'] as const;

/** Exact optional addon inspection, independent of the maintenance connection's
 * identity. The whole Financial profile and routine binding are checked by its
 * enclosing full-role auditor. Missing source-approved addon grants are allowed
 * only at the explicit pre-grant stage; extra authority is never accepted. */
export async function inspectCustomerFinancialManualRefundRuntime(db: Query, options: CustomerFinancialManualRefundRuntimeOptions) {
  pricingIdentifier(options.role); pricingIdentifier(options.promotionOwner);
  if (options.role === options.promotionOwner || typeof options.requirePrivileges !== 'boolean')
    throw Error('Explicit independent manual refund runtime and NOLOGIN owner required');
  const { role, promotionOwner, requirePrivileges } = options;
  const failures: string[] = [], catalogFailures: string[] = [];
  const [version] = await db.execute<{ pg16: boolean }>(sql`SELECT pg_catalog.current_setting('server_version_num')::integer/10000=16 AS pg16`);
  const promotionSequence = { name: 'store_order_promotions_id_seq', table: 'store_order_promotions', column: 'id' } as const;
  if (version?.pg16 !== true) return { ready: false, catalogReady: false, readOnly: true as const,
    failures: ['manual_pg16'], manualFunctionOid: null, promotionOwnerOid: null, promotionSequence: null, managerOrigin: null };
  const manual = await inspectCustomerManualRefund(db), financial = await inspectCustomerFinancialOperation(db),
    guest = await customerManualGuestIdentityReadiness(db),
    managerOrigin = await inspectCustomerManualManagerOriginReadiness(db, role, false);
  if (!manual.complete) catalogFailures.push('manual_catalog');
  if (!financial.complete || financial.fingerprint !== CUSTOMER_FINANCIAL_MANUAL_CATALOG_SHA256) catalogFailures.push('manual_financial_catalog');
  if (!guest.ready) catalogFailures.push('manual_guest_catalog');
  if (!managerOrigin.ready) catalogFailures.push('manual_manager_origin');
  // Do not resolve missing protocol names as regclass/regprocedure literals.
  // Full source pins are a prerequisite to every authority exception below.
  if (catalogFailures.length) return { ready: false, catalogReady: false, readOnly: true as const,
    failures: [...new Set(catalogFailures)].sort(), manualFunctionOid: null, promotionOwnerOid: null,
    promotionSequence: null, managerOrigin };
  // The published Manager installer deliberately shares the reviewed manual
  // owner. Its complete independent capability proof must precede any union
  // of source reads or ownership exceptions; a function name proves nothing.
  const [managerPresence] = await db.execute<{ present: boolean }>(sql`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_proc
    WHERE pronamespace='public'::regnamespace AND proname='manager_delete_order_promotions_v1') AS present`);
  // Absence needs no composition exception. Presence only selects the full
  // inspector; it cannot admit an overload, changed body or matching name.
  const managerPromotion = managerPresence?.present === true ? (await inspectManagerRuntimeCapabilities(db)).promotion : null;
  const ownerRows = managerPromotion ? await db.execute<{ oid: string }>(sql`SELECT oid::text AS oid FROM pg_catalog.pg_roles WHERE rolname=${promotionOwner}`) : [];
  let managerFunctionOid: string | null = null;
  if (managerPromotion && !managerPromotion.absent) {
    if (!managerPromotion.ready || ownerRows.length !== 1 || managerPromotion.ownerOid !== ownerRows[0].oid
      || !managerPromotion.functionOid || !/^[1-9][0-9]*$/u.test(managerPromotion.functionOid))
      catalogFailures.push('manual_manager_promotion_composition');
    else managerFunctionOid = managerPromotion.functionOid;
  }
  const managerDefinition = managerRuntimeCapabilityDefinitions().find(definition => definition.key === 'promotion');
  const reviewedOwnerReads = [...new Set<string>([...ownerReads, ...(managerFunctionOid && managerDefinition ? managerDefinition.reads : [])])];
  if (catalogFailures.length) return { ready: false, catalogReady: false, readOnly: true as const,
    failures: [...new Set(catalogFailures)].sort(), manualFunctionOid: null, promotionOwnerOid: null,
    promotionSequence: null, managerOrigin };
  const rows = await db.execute<Record<string, unknown>>(sql`WITH
    owner AS(SELECT * FROM pg_catalog.pg_roles WHERE rolname=${promotionOwner}),
    runtime AS(SELECT * FROM pg_catalog.pg_roles WHERE rolname=${role}),
    manual_function AS(SELECT * FROM pg_catalog.pg_proc WHERE oid=pg_catalog.to_regprocedure('public.customer_manual_refund_promotion_delete_v1(integer,integer)')),
    ledger AS(SELECT * FROM pg_catalog.pg_class WHERE oid=pg_catalog.to_regclass('public.customer_financial_manual_refund_v1')),
    financial AS(SELECT * FROM pg_catalog.pg_class WHERE oid=pg_catalog.to_regclass('public.customer_financial_operation_request')),
    promotion AS(SELECT * FROM pg_catalog.pg_class WHERE oid=pg_catalog.to_regclass('public.store_order_promotions')),
    promotion_sequence AS(SELECT * FROM pg_catalog.pg_class WHERE oid=pg_catalog.to_regclass('public.store_order_promotions_id_seq') AND relkind='S'),
    owner_reads AS(SELECT c.* FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::regnamespace
      AND c.relname IN(${sql.join(reviewedOwnerReads.map(name => sql`${name}`), sql`, `)})),
    owner_functions AS(SELECT oid FROM manual_function UNION SELECT ${managerFunctionOid}::oid WHERE ${managerFunctionOid}::oid IS NOT NULL),
    user_relations AS(SELECT c.* FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT IN('pg_catalog','information_schema','pg_toast') AND c.relkind IN('r','p','v','m','f')),
    financial_validators AS(SELECT * FROM pg_catalog.pg_proc WHERE oid IN(
      pg_catalog.to_regprocedure('public.customer_financial_intent_valid_v1(text,jsonb)'),
      pg_catalog.to_regprocedure('public.customer_financial_evidence_valid_v1(text,text,jsonb,jsonb)')))
    SELECT pg_catalog.current_setting('server_version_num')::integer/10000=16 AS pg16,
      f.oid::text AS manual_function_oid,o.oid::text AS promotion_owner_oid,
      f.proowner=o.oid AND f.prosecdef AND o.oid<>r.oid
        AND(${managerFunctionOid}::oid IS NULL OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p
          WHERE p.oid=${managerFunctionOid}::oid AND p.proowner=o.oid AND p.prosecdef))
        AND (SELECT count(*)=${reviewedOwnerReads.length} AND count(DISTINCT relowner)=1 AND min(relowner::bigint)=(SELECT relowner::bigint FROM ledger) FROM owner_reads)
        AND (SELECT relowner FROM ledger)=(SELECT relowner FROM financial)
        AND o.oid<>(SELECT relowner FROM ledger)
        AND (SELECT count(*)=2 AND bool_and(proowner=(SELECT relowner FROM financial) AND NOT prosecdef) FROM financial_validators) AS owner_bound,
      NOT(o.rolcanlogin OR o.rolsuper OR o.rolcreatedb OR o.rolcreaterole OR o.rolinherit OR o.rolreplication OR o.rolbypassrls)
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity WHERE usesysid=o.oid)
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=o.oid OR roleid=o.oid)
        AND NOT pg_catalog.has_parameter_privilege(o.oid,'session_replication_role','SET,ALTER SYSTEM') AS owner_restricted,
      NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend d WHERE d.refclassid='pg_catalog.pg_authid'::regclass AND d.refobjid=o.oid AND d.deptype='o'
          AND NOT(d.dbid=(SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AND d.classid='pg_catalog.pg_proc'::regclass
            AND d.objid IN(SELECT oid FROM owner_functions)))
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspowner=o.oid OR(n.oid<>pg_catalog.pg_my_temp_schema()
          AND n.nspname NOT IN('pg_catalog','information_schema','pg_toast') AND pg_catalog.has_schema_privilege(o.oid,n.oid,'CREATE')))
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_database d WHERE d.datdba=o.oid OR pg_catalog.has_database_privilege(o.oid,d.oid,'CREATE'))
        AND pg_catalog.has_schema_privilege(o.oid,'public','USAGE') AS owner_isolated,
      NOT EXISTS(SELECT 1 FROM user_relations c CROSS JOIN(VALUES('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(privilege)
        WHERE pg_catalog.has_table_privilege(o.oid,c.oid,p.privilege) IS DISTINCT FROM
          (p.privilege='SELECT' AND c.oid IN(SELECT oid FROM owner_reads) OR p.privilege='DELETE' AND c.oid=(SELECT oid FROM promotion)))
        AND (SELECT count(*)=${reviewedOwnerReads.length} AND bool_and(pg_catalog.has_table_privilege(o.oid,c.oid,'SELECT')) FROM owner_reads c)
        AND pg_catalog.has_table_privilege(o.oid,(SELECT oid FROM promotion),'DELETE') AS owner_data,
      NOT EXISTS(SELECT 1 FROM user_relations c JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
        CROSS JOIN(VALUES('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) p(privilege)
        WHERE pg_catalog.has_column_privilege(o.oid,c.oid,a.attnum,p.privilege) IS DISTINCT FROM
          (p.privilege='SELECT' AND c.oid IN(SELECT oid FROM owner_reads))) AS owner_columns,
      NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname NOT IN('pg_catalog','information_schema','pg_toast') AND c.relkind='S'
          AND(c.relowner=o.oid OR pg_catalog.has_sequence_privilege(o.oid,c.oid,'USAGE,SELECT,UPDATE'))) AS owner_sequences,
      NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.proowner=o.oid AND p.oid NOT IN(SELECT oid FROM owner_functions))
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname NOT IN('pg_catalog','information_schema','pg_toast') AND p.prosecdef AND p.oid NOT IN(SELECT oid FROM owner_functions)
            AND pg_catalog.has_function_privilege(o.oid,p.oid,'EXECUTE'))
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a
          WHERE a.grantee=o.oid AND(p.oid NOT IN(SELECT oid FROM owner_functions) OR a.is_grantable OR a.privilege_type<>'EXECUTE')) AS owner_functions,
      NOT EXISTS(SELECT 1 FROM pg_catalog.pg_default_acl d WHERE d.defaclrole=o.oid
        OR EXISTS(SELECT 1 FROM pg_catalog.aclexplode(d.defaclacl) a WHERE a.grantee=o.oid)) AS owner_defaults,
      NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a WHERE a.grantee=o.oid AND a.is_grantable)
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute c CROSS JOIN LATERAL pg_catalog.aclexplode(c.attacl) a WHERE a.grantee=o.oid AND a.is_grantable)
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace c CROSS JOIN LATERAL pg_catalog.aclexplode(c.nspacl) a
          WHERE a.grantee=o.oid AND(a.is_grantable OR c.nspname<>'public' OR a.privilege_type<>'USAGE'))
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_database c CROSS JOIN LATERAL pg_catalog.aclexplode(c.datacl) a WHERE a.grantee=o.oid)
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_parameter_acl c CROSS JOIN LATERAL pg_catalog.aclexplode(c.paracl) a WHERE a.grantee=o.oid) AS owner_no_delegation,
      r.rolcanlogin AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=r.oid AND deptype='o')
        AND NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET,ALTER SYSTEM')
        AND NOT pg_catalog.has_database_privilege(r.oid,pg_catalog.current_database(),'CREATE')
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspowner=r.oid OR(n.oid<>pg_catalog.pg_my_temp_schema()
          AND n.nspname NOT IN('pg_catalog','information_schema','pg_toast') AND pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE'))) AS target_restricted,
      NOT EXISTS(SELECT 1 FROM ledger c CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
        WHERE a.grantee<>c.relowner AND(a.grantee=0 OR a.is_grantable OR a.privilege_type NOT IN('SELECT','INSERT')))
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=(SELECT oid FROM ledger) AND a.attacl IS NOT NULL) AS manual_acl,
      NOT EXISTS(SELECT 1 FROM financial c CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
        WHERE a.grantee<>c.relowner AND(a.grantee=0 OR a.is_grantable OR a.privilege_type NOT IN('SELECT','INSERT')))
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=(SELECT oid FROM financial) AND a.attacl IS NOT NULL)
        AND NOT EXISTS(SELECT 1 FROM financial_validators p CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
          WHERE a.grantee<>p.proowner AND(a.grantee=0 OR a.is_grantable OR a.privilege_type<>'EXECUTE')) AS financial_acl,
      NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(f.proacl,pg_catalog.acldefault('f',f.proowner))) a
        WHERE a.grantee<>f.proowner AND(a.grantee=0 OR a.is_grantable OR a.privilege_type<>'EXECUTE')) AS function_acl,
      NOT pg_catalog.has_table_privilege(r.oid,(SELECT oid FROM ledger),'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        AND NOT pg_catalog.has_any_column_privilege(r.oid,(SELECT oid FROM ledger),'UPDATE,REFERENCES')
        AND NOT pg_catalog.has_table_privilege(r.oid,(SELECT oid FROM ledger),'SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION') AS target_manual_safe,
      NOT pg_catalog.has_table_privilege(r.oid,(SELECT oid FROM promotion),'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        AND NOT pg_catalog.has_table_privilege(r.oid,(SELECT oid FROM promotion),'SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION')
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=(SELECT oid FROM promotion) AND a.attnum>0 AND NOT a.attisdropped
          AND(pg_catalog.has_column_privilege(r.oid,a.attrelid,a.attnum,'UPDATE WITH GRANT OPTION,INSERT WITH GRANT OPTION,SELECT WITH GRANT OPTION,REFERENCES')
            OR(a.attname<>'id' AND pg_catalog.has_column_privilege(r.oid,a.attrelid,a.attnum,'UPDATE')))) AS target_promotion_safe,
      (SELECT count(*)=1 AND bool_and(NOT pg_catalog.has_sequence_privilege(r.oid,s.oid,'SELECT,UPDATE,USAGE WITH GRANT OPTION,SELECT WITH GRANT OPTION,UPDATE WITH GRANT OPTION')) FROM promotion_sequence s)
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_class s ON s.oid=d.objid AND s.relkind='S'
          WHERE d.classid='pg_catalog.pg_class'::regclass AND d.refclassid=d.classid AND d.refobjid=(SELECT oid FROM promotion)
            AND d.deptype IN('a','i') AND s.oid<>(SELECT oid FROM promotion_sequence)) AS target_sequence_safe,
      NOT pg_catalog.has_function_privilege(r.oid,f.oid,'EXECUTE WITH GRANT OPTION')
        AND(${managerFunctionOid}::oid IS NULL OR NOT pg_catalog.has_function_privilege(r.oid,${managerFunctionOid}::oid,'EXECUTE')) AS target_function_safe,
      pg_catalog.has_table_privilege(r.oid,(SELECT oid FROM ledger),'SELECT') AS target_manual_read,
      pg_catalog.has_table_privilege(r.oid,(SELECT oid FROM ledger),'INSERT') AS target_manual_append,
      pg_catalog.has_table_privilege(r.oid,(SELECT oid FROM promotion),'SELECT') AS target_promotion_read,
      pg_catalog.has_table_privilege(r.oid,(SELECT oid FROM promotion),'INSERT') AS target_promotion_append,
      pg_catalog.has_column_privilege(r.oid,(SELECT oid FROM promotion),'id','UPDATE') AS target_promotion_lock,
      (SELECT pg_catalog.has_sequence_privilege(r.oid,s.oid,'USAGE') FROM promotion_sequence s) AS target_sequence_usage,
      pg_catalog.has_function_privilege(r.oid,f.oid,'EXECUTE') AS target_function_execute
    FROM owner o CROSS JOIN runtime r CROSS JOIN manual_function f`);
  const row = rows[0];
  if (rows.length !== 1) catalogFailures.push('manual_named_identity');
  for (const key of catalogKeys) if (row?.[key] !== true) catalogFailures.push(`manual_${key}`);
  const rawFunctionOid = row?.manual_function_oid, rawOwnerOid = row?.promotion_owner_oid;
  const ownerOid = typeof rawOwnerOid === 'string' && /^[1-9][0-9]*$/u.test(rawOwnerOid) ? Number(rawOwnerOid) : NaN;
  const functionOid = typeof rawFunctionOid === 'string' && /^[1-9][0-9]*$/u.test(rawFunctionOid) ? rawFunctionOid : null;
  if (!Number.isSafeInteger(ownerOid) || ownerOid <= 0 || !functionOid) catalogFailures.push('manual_named_oid');
  // This OID exception follows complete source pins and the explicit owner
  // checks. Other legitimate cashier UPDATE(id) grantees remain governed by
  // every predicate in the original global promotion guard catalog query.
  if (!catalogFailures.length) {
    const guardRows = await db.execute<Record<string, unknown>>(reviewedManualRefundPromotionLockCatalogQuery(role, ownerOid));
    const guard = guardRows[0];
    if (guardRows.length !== 1 || guard?.absent !== false || !guardKeys.every(key => guard?.[key] === true))
      catalogFailures.push('manual_promotion_guard');
  }
  if (requirePrivileges) {
    for (const key of privilegeKeys) if (row?.[key] !== true) failures.push(`manual_${key}`);
    if (managerOrigin.privileges?.read !== true) failures.push('manual_target_manager_read');
  }
  const catalogReady = catalogFailures.length === 0;
  failures.push(...catalogFailures);
  return { ready: catalogReady && failures.length === 0, catalogReady, readOnly: true as const,
    failures: [...new Set(failures)].sort(), manualFunctionOid: catalogReady ? functionOid : null,
    promotionOwnerOid: catalogReady ? String(ownerOid) : null, promotionSequence: catalogReady ? promotionSequence : null,
    managerOrigin };
}
