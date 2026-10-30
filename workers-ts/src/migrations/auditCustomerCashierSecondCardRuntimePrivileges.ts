import { is, sql } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import * as models from '../models/schema';
import type { DbClient } from '../lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { inspectCustomerFinancialRuntimeCatalogPrerequisites } from './auditCustomerFinancialRuntimePrivileges';
import { CASHIER_SECOND_CARD_TABLES } from './cashierSecondCardRuntimePlan';
import { inspectCashierSecondCardOrigin } from './runCashierSecondCardOrigin';
import { inspectCustomerWriteoffOperation } from './runCustomerWriteoffOperation';
import { inspectCashierSecondCardAbandon } from './runCashierSecondCardAbandon';
import { inspectCashierSecondCardPromotionLock } from './cashierSecondCardPromotionLock';
import { inspectRoutinePaymentRuntime, routinePaymentRuntimeTablePrivileges, type RoutinePaymentRuntimeTarget } from './routinePaymentRuntime';
import { MANAGER_PUBLIC_INVOKER_BASELINE } from './managerRuntimePrivilegePlan';
import { inspectCashierRuntimeConditionalBoundary } from './cashierRuntimeConditionalBoundary';
import { cashierSecondCardAbandonRuntimePrivilegePlan } from './cashierSecondCardAbandonRuntimePlan';
import { inspectCashierSecondCardFormImagesRuntimeCatalog } from './cashierSecondCardFormImagesRuntimePlan';

type Query = Pick<DbClient, 'execute'>;
export interface CustomerCashierSecondCardRuntimeInspection {
  role: string;
  requireLogin: boolean;
  routine: { target: RoutinePaymentRuntimeTarget; stage: 'ready' };
  abandon: true;
  conditionalGuards?: true;
  formImages?: true;
}
const ledgers = [...CASHIER_SECOND_CARD_TABLES, 'customer_writeoff_operation_request', 'cashier_second_card_abandon_v1'];
const validators = ['cashier_second_card_origin_valid_v1', 'cashier_second_card_payment_valid_v1',
  'customer_writeoff_intent_valid_v1', 'customer_writeoff_evidence_valid_v1'];
const sourceTables = new Map(Object.values(models).filter(value => is(value, PgTable)).map(table => {
  const config = getTableConfig(table); return [config.name, config.columns.map(column => column.name)] as const;
}));
const sourceSequences = new Map(Object.values(models).filter(value => is(value, PgTable)).flatMap(table => {
  const config = getTableConfig(table);
  return config.columns.filter(column => column.generatedIdentity || ['serial', 'bigserial', 'smallserial'].includes(column.getSQLType()))
    .map(column => {
      const name = column.generatedIdentity?.sequenceName ?? `${config.name}_${column.name}_seq`; pricingIdentifier(name);
      return [name, { name, table: config.name, column: column.name }] as const;
    });
}));
sourceSequences.set('kefu_visitor_uid_seq', { name: 'kefu_visitor_uid_seq', table: 'kefu_visitor_session', column: 'visitor_uid' });

/** Complete published source privilege profile, not all Cashier business or
 * inherited conditional-write semantics. No caller-supplied plan, grants,
 * source installation, credential change or actual-LOGIN claim occurs here. */
export async function inspectCustomerCashierSecondCardRuntimePrivileges(db: Query, options: CustomerCashierSecondCardRuntimeInspection) {
  if (!options || typeof options.requireLogin !== 'boolean' || options.abandon !== true || options.routine?.stage !== 'ready')
    throw Error('Explicit published second-card LOGIN, ready routine binding and abandon addon required');
  if (options.conditionalGuards !== undefined && options.conditionalGuards !== true) throw Error('Explicit current Cashier conditional guard addon required');
  if (options.formImages !== undefined && options.formImages !== true) throw Error('Explicit Cashier form image addon required');
  const role = options.role, target = options.routine.target;
  for (const name of [role, target.database, target.maintenance, target.app, target.admin]) pricingIdentifier(name);
  if ([target.maintenance, target.app, target.admin].includes(role)) throw Error('Distinct declared local Cashier principal required');
  const catalogs = await inspectCustomerFinancialRuntimeCatalogPrerequisites(db, target.maintenance), failures = [...catalogs.failures];
  const conditional = options.conditionalGuards ? await inspectCashierRuntimeConditionalBoundary(db, target, role) : null;
  if (conditional && !conditional.ready) failures.push(...conditional.failures);
  const plan = cashierSecondCardAbandonRuntimePrivilegePlan(options.formImages === true);
  const formImages = options.formImages ? await inspectCashierSecondCardFormImagesRuntimeCatalog(db, target.maintenance) : null;
  if (formImages && !formImages.ready) failures.push(...formImages.failures);
  const routine = await inspectRoutinePaymentRuntime(db, target);
  const [binding] = await db.execute(sql`SELECT current_database()=${target.database} AS ready`);
  if (!routine.ready || binding?.ready !== true || target.local?.includes(role) !== true || target.caseLock?.runtimeRoles.includes(role))
    failures.push('cashier_routine_binding');
  if (routine.ready && binding?.ready === true && target.local?.includes(role) === true) {
    Object.assign(plan.tables, routinePaymentRuntimeTablePrivileges('local')); plan.tables.payment_reconciliation_action = ['SELECT'];
  }
  for (const [name, state] of [['cashier_origin', await inspectCashierSecondCardOrigin(db)],
    ['writeoff', await inspectCustomerWriteoffOperation(db)], ['cashier_abandon', await inspectCashierSecondCardAbandon(db)]] as const)
    if (!state.complete) failures.push(name + '_catalog');
  const promotion = await inspectCashierSecondCardPromotionLock(db, role);
  if (!promotion.ready) failures.push('cashier_promotion_guard');
  const [sourceAuthority] = await db.execute(sql`WITH ledgers AS(SELECT * FROM pg_catalog.pg_class
    WHERE relnamespace='public'::regnamespace AND relname IN(SELECT jsonb_array_elements_text(${JSON.stringify(ledgers)}::jsonb))),
    validators AS(SELECT * FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace
      AND proname IN(SELECT jsonb_array_elements_text(${JSON.stringify(validators)}::jsonb)))
    SELECT (SELECT count(*)=5 AND bool_and(c.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${target.maintenance})
      AND c.relkind='r' AND c.relpersistence='p' AND NOT(c.relrowsecurity OR c.relforcerowsecurity OR c.relispartition OR c.relhasrules)
      AND c.reloptions IS NULL AND c.relreplident='d') FROM ledgers c)
      AND NOT EXISTS(SELECT 1 FROM ledgers c CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
        WHERE a.grantee<>c.relowner AND(a.grantee=0 OR a.is_grantable OR a.privilege_type NOT IN('SELECT','INSERT')))
      AND NOT EXISTS(SELECT 1 FROM ledgers c JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid WHERE a.attacl IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM ledgers c JOIN pg_catalog.pg_depend d ON d.refobjid=c.oid
        JOIN pg_catalog.pg_class s ON s.oid=d.objid WHERE d.classid='pg_catalog.pg_class'::regclass AND d.refclassid=d.classid
          AND d.deptype IN('a','i') AND s.relkind='S') AS ledgers,
      (SELECT count(*)=4 AND bool_and(p.proowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${target.maintenance})
        AND NOT p.prosecdef) FROM validators p)
      AND NOT EXISTS(SELECT 1 FROM validators p CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND(a.grantee=0 OR a.is_grantable OR a.privilege_type<>'EXECUTE')) AS validators`);
  if (sourceAuthority?.ledgers !== true) failures.push('cashier_source_ledger_authority');
  if (sourceAuthority?.validators !== true) failures.push('cashier_source_validator_authority');
  const [identity] = await db.execute(sql`SELECT r.oid::text AS oid,current_setting('server_version_num')::integer/10000=16 AS pg16,
    r.rolcanlogin=${options.requireLogin} AS login_stage,
    NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls) AS restricted,
    NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid) AS no_memberships,
    NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend d WHERE d.refclassid='pg_catalog.pg_authid'::regclass AND d.refobjid=r.oid AND d.deptype='o') AS no_ownership,
    pg_catalog.has_database_privilege(r.oid,current_database(),'CONNECT') AND pg_catalog.has_schema_privilege(r.oid,'public','USAGE') AS connected,
    NOT pg_catalog.has_database_privilege(r.oid,current_database(),'CREATE')
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE')) AS no_ddl,
    NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET,ALTER SYSTEM')
      AND current_setting('session_replication_role')='origin' AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS no_replication_bypass,
    NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT IN('public','information_schema') AND n.nspname NOT LIKE 'pg_%'
      AND CASE WHEN c.relkind='S' THEN pg_catalog.has_sequence_privilege(r.oid,c.oid,'USAGE,SELECT,UPDATE')
        WHEN c.relkind IN('r','p','v','m','f') THEN pg_catalog.has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          OR pg_catalog.has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES') ELSE false END) AS no_other_schema_data
    FROM pg_catalog.pg_roles r WHERE r.rolname=${role}`);
  for (const key of ['pg16', 'login_stage', 'restricted', 'no_memberships', 'no_ownership', 'connected', 'no_ddl', 'no_replication_bypass', 'no_other_schema_data'])
    if (identity?.[key] !== true) failures.push(key);
  const tables = await db.execute(sql`SELECT c.relname AS name,c.relkind,c.relpersistence,c.relowner=(SELECT oid FROM pg_roles WHERE rolname=${target.maintenance}) AS owned,
    c.relrowsecurity OR c.relforcerowsecurity OR c.relispartition
      OR EXISTS(SELECT 1 FROM pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)
      OR EXISTS(SELECT 1 FROM pg_rewrite WHERE ev_class=c.oid) AS nonordinary,
    ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum) AS columns,
    p.privilege,has_table_privilege(${role},c.oid,p.privilege) AS allowed,
    has_table_privilege(${role},c.oid,p.privilege||' WITH GRANT OPTION') AS delegate
    FROM pg_class c CROSS JOIN(VALUES('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(privilege)
    WHERE c.relnamespace='public'::regnamespace AND c.relkind IN('r','p','v','m','f')`);
  const present = new Set<string>();
  for (const row of tables) {
    const name = String(row.name), privilege = String(row.privilege); present.add(name);
    if (row.allowed !== (plan.tables[name]?.some(value => value === privilege) ?? false) || row.delegate !== false) failures.push(`table:${name}:${privilege}`);
    if (plan.tables[name]) {
      if (row.relkind !== 'r' || row.relpersistence !== 'p' || row.nonordinary !== false || row.owned !== true) failures.push(`shape:${name}`);
      const expected = sourceTables.get(name);
      if (expected && (!Array.isArray(row.columns)
        || JSON.stringify([...row.columns].sort()) !== JSON.stringify([...expected].sort()))) failures.push(`columns:${name}`);
    }
  }
  for (const name of Object.keys(plan.tables)) if (!present.has(name)) failures.push(`missing:${name}`);
  const columns = await db.execute(sql`SELECT c.relname AS name,a.attname AS column,p.privilege,
    has_column_privilege(${role},c.oid,a.attnum,p.privilege) AS allowed,
    has_column_privilege(${role},c.oid,a.attnum,p.privilege||' WITH GRANT OPTION') AS delegate
    FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    CROSS JOIN(VALUES('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) p(privilege)
    WHERE c.relnamespace='public'::regnamespace AND c.relkind IN('r','p','v','m','f')`);
  for (const row of columns) {
    const name = String(row.name), column = String(row.column), privilege = String(row.privilege);
    const expected = (plan.tables[name]?.some(value => value === privilege) ?? false)
      || privilege === 'UPDATE' && (plan.updateColumns[name]?.includes(column) ?? false);
    if (row.allowed !== expected || row.delegate !== false) failures.push(`column:${name}.${column}:${privilege}`);
  }
  const ownedSequences = [...sourceSequences.values()].filter(row => plan.tables[row.table]?.includes('INSERT') || plan.standaloneSequences.includes(row.name));
  const bindings = await db.execute<{ name: string; table: string; column: string; ordinary: boolean }>(sql`SELECT s.relname AS name,t.relname AS "table",a.attname AS column,
    s.relpersistence='p' AND t.relnamespace=s.relnamespace AND t.relkind='r' AND d.deptype IN('a','i')
      AND s.relowner=(SELECT oid FROM pg_roles WHERE rolname=${target.maintenance}) AS ordinary
    FROM pg_class s JOIN pg_depend d ON d.classid='pg_class'::regclass AND d.refclassid=d.classid AND d.objid=s.oid AND d.deptype IN('a','i')
    JOIN pg_class t ON t.oid=d.refobjid JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid
    WHERE s.relnamespace='public'::regnamespace AND s.relkind='S'`);
  for (const expected of ownedSequences) {
    const actual = bindings.filter(row => row.table === expected.table && row.column === expected.column);
    if (actual.length !== 1 || actual[0].name !== expected.name || actual[0].ordinary !== true) failures.push(`sequence_binding:${expected.name}`);
  }
  for (const actual of bindings) if (plan.tables[actual.table]?.includes('INSERT')) {
    const expected = sourceSequences.get(actual.name);
    if (!expected || expected.table !== actual.table || expected.column !== actual.column || !actual.ordinary) failures.push(`sequence_binding:${actual.name}`);
  }
  const expectedSequences = new Set([...plan.standaloneSequences, ...ownedSequences.map(row => row.name)]);
  const sequences = await db.execute(sql`SELECT relname AS name,has_sequence_privilege(${role},oid,'USAGE') AS usage,
    has_sequence_privilege(${role},oid,'SELECT,UPDATE') AS extras,
    has_sequence_privilege(${role},oid,'USAGE WITH GRANT OPTION,SELECT WITH GRANT OPTION,UPDATE WITH GRANT OPTION') AS delegate
    FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='S'`);
  for (const row of sequences) if (row.usage !== expectedSequences.has(String(row.name)) || row.extras !== false || row.delegate !== false) failures.push(`sequence:${row.name}`);
  for (const name of expectedSequences) if (!sequences.some(row => row.name === name)) failures.push(`missing_sequence:${name}`);
  const routines = await db.execute(sql`SELECT p.oid::text AS oid,p.prosecdef,
    p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' AS signature,
    CASE WHEN p.prokind IN('f','p') THEN encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex') ELSE NULL END AS fingerprint,
    has_function_privilege(${role},p.oid,'EXECUTE') AS executable,has_function_privilege(${role},p.oid,'EXECUTE WITH GRANT OPTION') AS delegate
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace`);
  const declared = new Set(plan.functions), reviewed = new Set(catalogs.reviewedDefiners);
  for (const row of routines) {
    const signature = String(row.signature);
    if (row.delegate !== false) failures.push(`routine_delegation:${signature}`);
    if (row.executable !== true) continue;
    const privateInvoker = declared.has(signature) && row.prosecdef === false
      && (signature.startsWith('customer_') || signature.startsWith('cashier_second_card_'));
    if (!reviewed.has(String(row.oid)) && !privateInvoker
      && (row.prosecdef !== false || MANAGER_PUBLIC_INVOKER_BASELINE[signature] !== row.fingerprint)) failures.push(`unreviewed_routine:${signature}`);
  }
  for (const signature of declared) if (!routines.some(row => row.signature === signature && row.executable === true && row.delegate === false)) failures.push(`missing_function:${signature}`);
  const [foreign] = await db.execute(sql`SELECT NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE p.prosecdef AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND has_function_privilege(${role},p.oid,'EXECUTE')
      AND NOT(p.oid::text IN(SELECT jsonb_array_elements_text(${JSON.stringify([...reviewed])}::jsonb)))) AS safe`);
  if (foreign?.safe !== true) failures.push('unreviewed_definer');
  const [defaults] = await db.execute(sql`SELECT NOT EXISTS(SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
    WHERE a.grantee=(SELECT oid FROM pg_roles WHERE rolname=${role}) OR(a.grantee=0 AND d.defaclobjtype IN('r','S'))) AS safe`);
  if (defaults?.safe !== true) failures.push('default_grants');
  const giftTable = 'store_order_promotion_gift_coupon_reward', giftSequence = 'store_order_promotion_gift_coupon_reward_id_seq';
  if (JSON.stringify([...(plan.tables[giftTable] ?? [])].sort()) !== JSON.stringify(['INSERT', 'SELECT'])
    || !expectedSequences.has(giftSequence)) failures.push('cashier_gift_source_profile');
  const roleOid = typeof identity?.oid === 'string' && /^[1-9][0-9]*$/u.test(identity.oid) ? identity.oid : null;
  if (!roleOid) failures.push('cashier_role_missing');
  const unique = [...new Set(failures)].sort(), profileReady = unique.length === 0 && catalogs.ready;
  const ready = profileReady && options.requireLogin;
  return { ready, profileReady, role, roleOid, readOnly: true as const, failures: unique,
    tableCount: present.size, sequenceCount: sequences.length,
    inheritedAppConditionalGuardsReady: conditional?.ready === true,
    formImagesCatalogReady: formImages?.ready === true,
    conditionalWriteSemanticsVerified: false as const,
    completeServiceCoverageVerified: false as const,
    giftSourcePrivileges: ready ? { table: giftTable,
      privileges: ['SELECT', 'INSERT'] as const, sequence: giftSequence,
      sequencePrivileges: ['USAGE'] as const } : null };
}

/** Independent real LOGIN. Neither this result nor the named profile checker
 * asserts that inherited App-only conditional-write guards cover this role. */
export async function auditCustomerCashierSecondCardRuntimePrivileges(db: DbClient, role: string,
  target: RoutinePaymentRuntimeTarget, addon: { abandon: true; conditionalGuards?: true; formImages?: true }) {
  if (!Object.hasOwn(db, '$client') || !db.$client) throw Error('Root Cashier runtime connection required');
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT set_config('search_path','public,pg_temp',true),
      set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
      set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
      set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
    const [identity] = await tx.execute(sql`SELECT current_database() AS database,current_user AS role,session_user AS session,
      (SELECT r.rolname FROM pg_stat_activity a JOIN pg_roles r ON r.oid=a.usesysid WHERE a.pid=pg_backend_pid()) AS backend,
      current_setting('session_replication_role')='origin' AS origin`);
    const inspected = await inspectCustomerCashierSecondCardRuntimePrivileges(tx, { role, requireLogin: true,
      routine: { target, stage: 'ready' }, abandon: addon?.abandon,
      ...(addon?.conditionalGuards !== undefined ? { conditionalGuards: addon.conditionalGuards } : {}),
      ...(addon?.formImages !== undefined ? { formImages: addon.formImages } : {}) });
    const realLogin = identity?.role === role && identity.session === role && identity.backend === role
      && identity.database === target.database && identity.origin === true;
    return { ...inspected, identity, realLogin, ready: inspected.ready && realLogin,
      giftSourcePrivileges: inspected.ready && realLogin ? inspected.giftSourcePrivileges : null,
      failures: [...new Set([...inspected.failures, ...(realLogin ? [] : ['connection_identity'])])].sort() };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
