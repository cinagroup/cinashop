import { is, sql } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import * as models from '../models/schema';
import type { DbClient } from '../lib/di';
import { MANAGER_RUNTIME_ROLE, managerRuntimePrivilegePlan, MANAGER_PUBLIC_INVOKER_BASELINE,type ManagerRuntimeProfile } from './managerRuntimePrivilegePlan';
import { inspectManagerOrderOperation } from './runManagerOrderOperation';
import { inspectManagerScopeLock } from './runManagerScopeLock';
import { managerScopeCatalogReady } from './managerScopeLock';
import { inspectCheckoutPricingLock } from './checkoutPricingLock';
import { pricingCatalogReady } from './checkoutPricingLockCatalog';
import { refundEntityAcceptedPairSql } from './guestRefundEntityCatalog';
import { inspectManagerRuntimeCapabilities } from './managerRuntimeCapabilities';
import { inspectOrderPromotionGiftReceiptCatalog } from './orderPromotionGiftReceipt';
import { inspectRoutinePaymentRuntime, routinePaymentRuntimeTablePrivileges, type RoutinePaymentRuntimeTarget } from './routinePaymentRuntime';
import { inspectLocalPaymentCaseLock } from './localPaymentCaseLock';

type Query = Pick<DbClient, 'execute'>;
const modelColumns=new Map(Object.values(models).filter(value=>is(value,PgTable)).map(table=>{
  const config=getTableConfig(table);return[config.name,config.columns.map(c=>c.name)] as const;
}));
// Both profiles share the registered legacy base. These source-declared
// columns belong to separately commissioned customer-city/waybill forwards;
// none is read or written by the 29 manager handlers or their proven helpers.
// Keep them known if present, without turning unused addons into prerequisites.
const optionalSourceColumns:Readonly<Record<string,readonly string[]>>={
  // models/schema/waybill_job.ts actorServiceId;
  // migrations/customerWaybillActor.ts, explicit runCustomerWaybillActor.
  order_waybill_job:['actor_service_id'],
  // models/schema/store_operations.ts business/cityShopId;
  // migrations/customerCityDelivery.ts CUSTOMER_CITY_DELIVERY_SQL (explicit).
  system_store:['business','city_shop_id'],
};
/** Fixed source profiles before any role creation. Metadata only; no business
 * rows, server-learned definitions, automatic DDL or partial-fixture inference. */
export async function inspectManagerRuntimeCatalogPresence(db:Query){
  const failures:string[]=[];
  const [giftPresence]=await db.execute(sql`SELECT to_regclass('public.store_order_promotion_gift_coupon_reward') IS NOT NULL AS present,
    to_regclass('public.store_order_promotion_gift_coupon_reward_id_seq') IS NOT NULL AS sequence`);
  const profile:ManagerRuntimeProfile=giftPresence?.present===true?'current':'legacy-without-promotion-gift-receipt';
  if(giftPresence?.present===true){if(!(await inspectOrderPromotionGiftReceiptCatalog(db)).ready)failures.push('promotion_gift_catalog');}
  else if(giftPresence?.sequence===true)failures.push('promotion_gift_residue');
  const plan=managerRuntimePrivilegePlan(profile);
  const relations=await db.execute<{name:string;ordinary:boolean;columns:string[]}>(sql`SELECT c.relname AS name,
    c.relkind='r' AND c.relpersistence='p' AND NOT(c.relrowsecurity OR c.relforcerowsecurity OR c.relispartition)
      AND NOT EXISTS(SELECT 1 FROM pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_rewrite WHERE ev_class=c.oid) AS ordinary,
    ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum) AS columns
    FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN('r','p','v','m','f')`);
  for(const name of Object.keys(plan.tables)){
    const relation=relations.find(r=>r.name===name);
    if(!relation){failures.push(`missing:${name}`);continue;}
    if(relation.ordinary!==true)failures.push(`shape:${name}`);
    const expectedColumns=modelColumns.get(name);
    for(const column of expectedColumns??[])if(!relation.columns.includes(column)&&!optionalSourceColumns[name]?.includes(column))failures.push(`missing_column:${name}.${column}`);
    if(expectedColumns)for(const column of relation.columns)if(!expectedColumns.includes(column))failures.push(`unexpected_column:${name}.${column}`);
    for(const column of plan.updateColumns[name]??[])if(!relation.columns.includes(column))failures.push(`missing_column:${name}.${column}`);
  }
  const sequences=await db.execute<{name:string;parent:string|null;column:string|null;ordinary:boolean}>(sql`SELECT s.relname AS name,
    t.relname AS parent,a.attname AS column,s.relkind='S' AND s.relpersistence='p' AND t.relnamespace=s.relnamespace AND d.deptype IN('a','i') AS ordinary
    FROM pg_class s LEFT JOIN pg_depend d ON d.classid='pg_class'::regclass AND d.refclassid=d.classid AND d.objid=s.oid AND d.deptype IN('a','i')
    LEFT JOIN pg_class t ON t.oid=d.refobjid LEFT JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid
    WHERE s.relnamespace='public'::regnamespace AND s.relkind='S'`);
  for(const name of plan.standaloneSequences){const rows=sequences.filter(s=>s.name===name);
    if(!rows.length)failures.push(`missing_sequence:${name}`);
    else if(rows.length!==1||rows[0].ordinary!==true||rows[0].parent!==name.replace(/_id_seq$/,'')||rows[0].column!=='id')failures.push(`sequence_owner:${name}`);
  }
  const publicFunctions=await db.execute<{signature:string;fingerprint:string|null;definer:boolean;delegate:boolean}>(sql`SELECT
    p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' AS signature,p.prosecdef AS definer,
    CASE WHEN p.prokind IN('f','p') THEN encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex') ELSE NULL END AS fingerprint,
    EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.is_grantable) AS delegate
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE')`);
  for(const f of publicFunctions)if(f.definer!==false||f.delegate!==false||MANAGER_PUBLIC_INVOKER_BASELINE[f.signature]!==f.fingerprint)failures.push(`unreviewed_public_routine:${f.signature}`);
  const [publicData]=await db.execute<{safe:boolean}>(sql`SELECT NOT EXISTS(SELECT 1 FROM pg_class c
    CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END,c.relowner))) a
    WHERE c.relnamespace='public'::regnamespace AND c.relkind IN('r','p','v','m','f','S') AND a.grantee=0)
    AND NOT EXISTS(SELECT 1 FROM pg_attribute c CROSS JOIN LATERAL aclexplode(c.attacl) a
      WHERE c.attrelid IN(SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace) AND a.grantee=0) AS safe`);
  if(publicData?.safe!==true)failures.push('public_data_authority');
  const unique=[...new Set(failures)].sort();
  return{ready:unique.length===0,readOnly:true as const,profile,failures:unique.slice(0,80),failureCount:unique.length,
    requiredTableCount:Object.keys(plan.tables).length,tableCount:relations.length,sequenceCount:sequences.length,publicInvokerCount:publicFunctions.length};
}
/** Catalog inspection only. No table/function creation, grants or row locks. */
export async function inspectManagerRuntimeCatalogPrerequisites(db: Query) {
  const failures: string[] = [];
  const presence=await inspectManagerRuntimeCatalogPresence(db);failures.push(...presence.failures);
  const operation = await inspectManagerOrderOperation(db);
  if (!operation.complete) failures.push(operation.present ? 'manager_operation_catalog' : 'manager_operation_missing');
  const scope = await inspectManagerScopeLock(db);
  if (!managerScopeCatalogReady(scope)) failures.push(scope.absent ? 'manager_scope_missing' : 'manager_scope_catalog');
  const pricing = await inspectCheckoutPricingLock(db);
  if (!pricingCatalogReady(pricing)) failures.push('checkout_pricing_catalog');
  const capabilities = await inspectManagerRuntimeCapabilities(db);
  if (!capabilities.waybill.ready) failures.push(capabilities.waybill.absent ? 'manager_waybill_missing' : 'manager_waybill_catalog');
  if (!capabilities.delivery.ready) failures.push(capabilities.delivery.absent ? 'manager_delivery_missing' : 'manager_delivery_catalog');
  if (!capabilities.promotion.ready) failures.push(capabilities.promotion.absent ? 'manager_promotion_missing' : 'manager_promotion_catalog');
  const [present] = await db.execute(sql`SELECT to_regclass('public.store_order_invoice') IS NOT NULL AS invoice`);
  let refund: { invoice: string; split: string; profile: string } | null = null;
  if (present?.invoice === true) {
    const rows = await db.execute<{ invoice: string; split: string; profile: string }>(sql.raw(refundEntityAcceptedPairSql(true)));
    if (rows.length === 1) refund = rows[0];
  }
  if (!refund || !(refund.invoice === 'v2' && refund.split === 'v1' && refund.profile === 'legacy'
    || refund.invoice === 'v3' && refund.split === 'v2' && refund.profile === 'guest')) failures.push('refund_entity_catalog');
  return { ready: failures.length === 0 && presence.ready, readOnly: true as const, profile:presence.profile,failures, presence,operation, scope, pricing, refund, capabilities };
}

/** Named-role inspection over a maintenance connection, never SET ROLE.
 * false requires NOLOGIN while staged; true requires the commissioned LOGIN.
 * A complete ACL result does not replace actual manager business/HTTP tests. */
export interface ManagerRuntimeInspectionOptions {
  requireLogin: boolean;
  /** before-manager validates the complete old profile for an explicit forward;
   * it never reports a commissioned runtime as ready. */
  routine?: { target: RoutinePaymentRuntimeTarget; stage: 'before-manager' | 'ready' };
}
export async function inspectManagerRuntimePrivileges(db: Query, options: ManagerRuntimeInspectionOptions) {
  if (typeof options?.requireLogin !== 'boolean') throw Error('Explicit manager LOGIN stage required');
  const role = MANAGER_RUNTIME_ROLE, failures: string[] = [];
  const catalogs = await inspectManagerRuntimeCatalogPrerequisites(db);
  const plan=managerRuntimePrivilegePlan(catalogs.profile);
  failures.push(...catalogs.failures);
  const [rawPresence] = await db.execute(sql`SELECT to_regclass('public.routine_identity_witness') IS NOT NULL
    OR to_regclass('public.routine_payment_attempt') IS NOT NULL AS present`);
  let routineLockOid: string | null = null;
  const routine = options.routine;
  if (routine) {
    if (!['before-manager', 'ready'].includes(routine.stage)) throw Error('Explicit manager routine stage required');
    const [binding] = await db.execute(sql`SELECT current_database()=${routine.target.database} AS ready`);
    const state = await inspectRoutinePaymentRuntime(db, routine.target);
    const included = routine.target.local?.includes(role) === true;
    const lock = await inspectLocalPaymentCaseLock(db, role);
    const bindingReady = routine.stage === 'ready'
      ? included && routine.target.caseLock?.runtimeRoles.includes(role) === true && lock.runtimeReady
      : !included && routine.target.caseLock?.runtimeRoles.includes(role) !== true;
    if (binding?.ready !== true || !state.ready || !bindingReady) failures.push('manager_routine_payment_binding');
    if (routine.stage === 'ready' && state.ready && bindingReady && binding?.ready === true) {
      Object.assign(plan.tables, routinePaymentRuntimeTablePrivileges('local'));
      plan.tables.payment_reconciliation_action = ['SELECT'];
      routineLockOid = lock.functionOid;
    }
  } else if (rawPresence?.present === true) failures.push('manager_routine_payment_unbound');
  const [identity] = await db.execute(sql`SELECT
    current_setting('server_version_num')::int/10000=16 AS pg16,
    r.rolcanlogin=${options.requireLogin} AS login_stage,
    NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls) AS restricted,
    NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid) AS no_memberships,
    NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=r.oid AND deptype='o') AS no_ownership,
    pg_catalog.has_database_privilege(r.oid,current_database(),'CONNECT') AND pg_catalog.has_schema_privilege(r.oid,'public','USAGE') AS connected,
    NOT pg_catalog.has_database_privilege(r.oid,current_database(),'CREATE')
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE')) AS no_ddl,
    NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET,ALTER SYSTEM') AS no_replication_bypass,
    NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT IN('public','information_schema') AND n.nspname NOT LIKE 'pg_%'
      AND CASE WHEN c.relkind='S' THEN pg_catalog.has_sequence_privilege(r.oid,c.oid,'USAGE,SELECT,UPDATE')
        WHEN c.relkind IN('r','p','v','m','f') THEN pg_catalog.has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          OR pg_catalog.has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES') ELSE false END) AS no_other_schema_data
    FROM pg_catalog.pg_roles r WHERE r.rolname=${role}`);
  for (const key of ['pg16', 'login_stage', 'restricted', 'no_memberships', 'no_ownership', 'connected', 'no_ddl', 'no_replication_bypass', 'no_other_schema_data'])
    if (identity?.[key] !== true) failures.push(key);
  if (!identity) return { ready: false, profileReady: false, readOnly: true as const, completeServiceCoverageVerified: false as const,
    failures: [...new Set([...failures, 'manager_role_missing'])].sort(), tableCount: 0, sequenceCount: 0 };

  const tables = await db.execute(sql`SELECT c.relname AS name,c.relkind,c.relpersistence,
    c.relrowsecurity OR c.relforcerowsecurity OR c.relispartition
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=c.oid) AS nonordinary,
    p.privilege,pg_catalog.has_table_privilege(${role},c.oid,p.privilege) AS allowed,
    pg_catalog.has_table_privilege(${role},c.oid,p.privilege||' WITH GRANT OPTION') AS delegate
    FROM pg_catalog.pg_class c CROSS JOIN(VALUES('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(privilege)
    WHERE c.relnamespace='public'::regnamespace AND c.relkind IN('r','p','v','m','f')`);
  const present = new Set<string>();
  for (const row of tables) {
    const name = String(row.name), privilege = String(row.privilege); present.add(name);
    if (row.allowed !== (plan.tables[name]?.some(p => p === privilege) ?? false) || row.delegate !== false)
      failures.push(`table:${name}:${privilege}`);
    if (plan.tables[name] && (row.relkind !== 'r' || row.relpersistence !== 'p' || row.nonordinary !== false)) failures.push(`shape:${name}`);
  }
  for (const name of Object.keys(plan.tables)) if (!present.has(name)) failures.push(`missing:${name}`);
  const columns = await db.execute(sql`SELECT c.relname AS name,a.attname AS column,p.privilege,
    pg_catalog.has_column_privilege(${role},c.oid,a.attnum,p.privilege) AS allowed,
    pg_catalog.has_column_privilege(${role},c.oid,a.attnum,p.privilege||' WITH GRANT OPTION') AS delegate
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    CROSS JOIN(VALUES('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) p(privilege)
    WHERE c.relnamespace='public'::regnamespace AND c.relkind IN('r','p','v','m','f')`);
  for (const row of columns) {
    const name = String(row.name), column = String(row.column), privilege = String(row.privilege);
    const expected = (plan.tables[name]?.some(p => p === privilege) ?? false)
      || privilege === 'UPDATE' && (plan.updateColumns[name]?.includes(column) ?? false);
    if (row.allowed !== expected || row.delegate !== false) failures.push(`column:${name}.${column}:${privilege}`);
  }
  for (const [name, expected] of Object.entries(plan.updateColumns))
    for (const column of expected) if (!columns.some(row => row.name === name && row.column === column)) failures.push(`missing_column:${name}.${column}`);
  const sequences = await db.execute(sql`SELECT c.relname AS name,
    (SELECT t.relname FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_class t ON t.oid=d.refobjid
      JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid
      WHERE d.classid='pg_catalog.pg_class'::regclass AND d.refclassid=d.classid AND d.objid=c.oid
        AND d.deptype IN('a','i') AND t.relnamespace=c.relnamespace AND a.attname='id' LIMIT 1) AS parent,
    pg_catalog.has_sequence_privilege(${role},c.oid,'USAGE') AS usage,
    pg_catalog.has_sequence_privilege(${role},c.oid,'SELECT,UPDATE') AS extras,
    pg_catalog.has_sequence_privilege(${role},c.oid,'USAGE WITH GRANT OPTION,SELECT WITH GRANT OPTION,UPDATE WITH GRANT OPTION') AS delegate
    FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='S'`);
  for (const row of sequences) if (row.usage !== plan.standaloneSequences.includes(String(row.name)) || row.extras !== false || row.delegate !== false
    || plan.standaloneSequences.includes(String(row.name)) && row.parent !== String(row.name).replace(/_id_seq$/, ''))
    failures.push(`sequence:${row.name}`);
  for (const name of plan.standaloneSequences) if (!sequences.some(row => row.name === name)) failures.push(`missing_sequence:${name}`);
  const functionRows = await db.execute(sql`SELECT p.oid::text AS oid,p.proname,p.prosecdef,
    p.proname||'('||pg_catalog.pg_get_function_identity_arguments(p.oid)||')' AS signature,
    CASE WHEN p.prokind IN('f','p') THEN encode(sha256(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8')),'hex') ELSE NULL END AS fingerprint,
    pg_catalog.has_function_privilege(${role},p.oid,'EXECUTE') AS executable,
    pg_catalog.has_function_privilege(${role},p.oid,'EXECUTE WITH GRANT OPTION') AS delegate
    FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace`);
  const reviewed = [...catalogs.scope.functionOids, ...(catalogs.pricing.functionOid ? [catalogs.pricing.functionOid] : []),
    ...(routineLockOid ? [routineLockOid] : []),
    ...[catalogs.capabilities.waybill,catalogs.capabilities.delivery,catalogs.capabilities.promotion].filter(c=>c.ready&&c.functionOid).map(c=>c.functionOid!)];
  const [routines] = await db.execute(sql`SELECT NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE p.prosecdef AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
      AND pg_catalog.has_function_privilege(${role},p.oid,'EXECUTE')
      AND NOT(p.oid::text IN(SELECT jsonb_array_elements_text(${JSON.stringify(reviewed)}::jsonb)))) AS safe`);
  if (!routines?.safe) failures.push('unreviewed_definer');
  for (const oid of reviewed) if (!functionRows.some(row => row.oid === oid && row.executable === true && row.delegate === false)) failures.push('missing_lock_execute');
  if (functionRows.some(row => row.delegate !== false)) failures.push('routine_delegation');
  for(const row of functionRows)if(row.executable===true&&!reviewed.includes(String(row.oid))
    &&(row.prosecdef!==false||MANAGER_PUBLIC_INVOKER_BASELINE[String(row.signature)]!==row.fingerprint))failures.push(`unreviewed_routine:${row.signature}`);
  const [defaults] = await db.execute(sql`SELECT NOT EXISTS(SELECT 1 FROM pg_catalog.pg_default_acl d
    CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a WHERE a.grantee=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${role})
      OR(a.grantee=0 AND d.defaclobjtype IN('r','S'))) AS safe`);
  if (defaults?.safe !== true) failures.push('default_grants');
  const unique = [...new Set(failures)].sort();
  const profileReady = unique.length === 0 && catalogs.ready;
  return { ready: profileReady && routine?.stage !== 'before-manager', profileReady,
    routineStage: routine?.stage ?? 'absent', profile:catalogs.profile,readOnly: true as const, completeServiceCoverageVerified: false as const,
    failures: unique, tableCount: present.size, sequenceCount: sequences.length };
}

/** Actual independently authenticated connection, not role impersonation. */
export async function auditManagerRuntimePrivileges(db: DbClient, routine?: RoutinePaymentRuntimeTarget) {
  if (!Object.hasOwn(db, '$client') || !db.$client) throw Error('Root manager connection required');
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT set_config('statement_timeout','5000',true),set_config('lock_timeout','1000',true),
      set_config('idle_in_transaction_session_timeout','5000',true),set_config('search_path','public,pg_temp',true)`);
    const [identity] = await tx.execute(sql`SELECT current_database() AS database,current_user AS role,session_user AS session,
      (SELECT r.rolname FROM pg_catalog.pg_stat_activity a JOIN pg_catalog.pg_roles r ON r.oid=a.usesysid WHERE a.pid=pg_backend_pid()) AS backend_role,
      current_setting('session_replication_role')='origin' AS origin`);
    const result = await inspectManagerRuntimePrivileges(tx, { requireLogin: true,
      ...(routine ? { routine: { target: routine, stage: 'ready' as const } } : {}) });
    if (identity?.role === MANAGER_RUNTIME_ROLE && identity.session === MANAGER_RUNTIME_ROLE && identity.backend_role === MANAGER_RUNTIME_ROLE && identity.origin === true
      && (!routine || identity.database === routine.database)) return { ...result, identity };
    return { ...result, identity, ready: false, failures: [...new Set([...result.failures, 'connection_identity'])].sort() };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
