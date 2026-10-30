import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { inspectRoutinePaymentRuntime, type RoutinePaymentRuntimeTarget } from './routinePaymentRuntime';
import { MANAGER_RUNTIME_ROLE, MANAGER_PUBLIC_INVOKER_BASELINE } from './managerRuntimePrivilegePlan';
import { CUSTOMER_FINANCIAL_RUNTIME_ROLE } from './customerFinancialRuntimePlan';
import { captureCashierRuntimeConditionalBinding, type CashierRuntimeConditionalBinding } from './cashierRuntimeConditionalBinding';
import { inspectRuntimeAdminBoundary, runtimeAdminBoundaryBody } from './runtimeAdminBoundary';
import { inspectRuntimeLockOnlyBoundary, runtimeLockOnlyBoundaryBody, RUNTIME_LOCK_ONLY_RULES } from './runtimeLockOnlyBoundary';
import { inspectRuntimeSeckillScheduleLockBoundary, runtimeSeckillScheduleLockBoundaryBody } from './runtimeSeckillScheduleLockBoundary';
import { inspectRuntimeAgentLevelCatalogBoundary, runtimeAgentLevelCatalogFenceBody, runtimeAgentLevelRowGuardBody } from './runtimeAgentLevelCatalogBoundary';

type Query = Pick<DbClient, 'execute'>;
export const CASHIER_RUNTIME_CONDITIONAL_OPERATION = 'cashier-runtime-conditional-boundary-v1';
export const CASHIER_RUNTIME_CONDITIONAL_TABLES = [...new Set([
  ...Object.keys(RUNTIME_LOCK_ONLY_RULES.app), ...Object.keys(RUNTIME_LOCK_ONLY_RULES.admin),
  'system_admin', 'system_role', 'system_menus', 'store_activity', 'store_seckill_time',
  'agent_level_task', 'agent_level_task_record',
])].sort();

export function captureCashierConditionalTarget(value: RoutinePaymentRuntimeTarget, role: string): RoutinePaymentRuntimeTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.local)
    || !value.local.length || value.local.length > 16
    || value.caseLock && (!Array.isArray(value.caseLock.runtimeRoles) || !value.caseLock.runtimeRoles.length || value.caseLock.runtimeRoles.length > 16))
    throw Error('Complete bound Cashier routine target required');
  const t = { database: value.database, maintenance: value.maintenance, app: value.app, admin: value.admin,
    local: [...value.local], ...(value.caseLock ? { caseLock: { owner: value.caseLock.owner, runtimeRoles: [...value.caseLock.runtimeRoles] } } : {}) };
  const roles = [t.maintenance, t.app, t.admin, ...t.local];
  for (const n of [t.database, role, ...roles, ...(t.caseLock ? [t.caseLock.owner, ...t.caseLock.runtimeRoles] : [])]) pricingIdentifier(n);
  if (new Set(roles).size !== roles.length || !t.local.includes(role)
    || [CUSTOMER_FINANCIAL_RUNTIME_ROLE, MANAGER_RUNTIME_ROLE].includes(role)
    || t.caseLock && (roles.includes(t.caseLock.owner) || t.caseLock.runtimeRoles.includes(role)
      || new Set(t.caseLock.runtimeRoles).size !== t.caseLock.runtimeRoles.length
      || t.caseLock.runtimeRoles.some(r => !t.local.includes(r))))
    throw Error('Distinct declared local Cashier conditional identity required');
  return t;
}

export function cashierRuntimeConditionalDefinitions(target: RoutinePaymentRuntimeTarget, binding?: CashierRuntimeConditionalBinding) {
  if (binding) captureCashierConditionalTarget(target, binding.role);
  return [
    ['cinashop_runtime_admin_boundary_v1', runtimeAdminBoundaryBody(target.app, binding)],
    ['cinashop_runtime_lock_only_v1', runtimeLockOnlyBoundaryBody(target.app, target.admin, 'agent-levels', binding)],
    ['cinashop_runtime_seckill_schedule_lock_only_v1', runtimeSeckillScheduleLockBoundaryBody(target, binding)],
    ['cinashop_runtime_agent_level_catalog_fence_v1', runtimeAgentLevelCatalogFenceBody(target, binding)],
    ['cinashop_runtime_agent_level_row_guard_v1', runtimeAgentLevelRowGuardBody(target, binding)],
  ] as const;
}

/** Leaf proof only: the full Cashier profile calls this checker. Calling the
 * full profile here would recursively accept its own source exception. */
export async function inspectCashierRuntimeConditionalBoundary(db: Query, declared: RoutinePaymentRuntimeTarget, role: string) {
  const target = captureCashierConditionalTarget(declared, role), failures: string[] = [];
  const participants = [...new Set([target.maintenance,target.app,target.admin,...(target.local ?? []),
    ...(target.caseLock ? [target.caseLock.owner,...target.caseLock.runtimeRoles] : [])])];
  const [identity] = await db.execute(sql`SELECT r.oid::text AS role_oid,d.oid::text AS database_oid,
    current_database()=${target.database} AND current_setting('server_version_num')::integer/10000=16
      AND current_setting('session_replication_role')='origin' AS database,
    r.rolcanlogin AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=r.oid AND deptype='o')
      AND NOT pg_catalog.has_database_privilege(r.oid,d.oid,'CREATE')
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE'))
      AND NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET,ALTER SYSTEM') AS restricted,
    NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS no_event_triggers,
    NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(${JSON.stringify(participants)}::jsonb) n(name)
      LEFT JOIN pg_catalog.pg_roles participant ON participant.rolname=n.name WHERE participant.oid IS NULL) AS target_roles
    FROM pg_catalog.pg_roles r CROSS JOIN pg_catalog.pg_database d WHERE r.rolname=${role} AND d.datname=current_database()`);
  for (const name of ['database', 'restricted', 'no_event_triggers', 'target_roles']) if (identity?.[name] !== true) failures.push(name);
  // Name-based privilege helpers error for a missing participant. Report the
  // rejected binding before calling them, including during a role rename.
  if (identity?.target_roles !== true || !(await inspectRoutinePaymentRuntime(db, target)).ready) failures.push('routine_binding');
  let binding: CashierRuntimeConditionalBinding | null = null;
  if (typeof identity?.role_oid === 'string' && typeof identity.database_oid === 'string')
    binding = captureCashierRuntimeConditionalBinding({ role, roleOid: identity.role_oid, database: target.database, databaseOid: identity.database_oid });
  else failures.push('identity_missing');
  const guards = binding ? await inspectCashierRuntimeConditionalCatalogs(db, target, binding) : null;
  if (!guards?.ready) failures.push(...(guards?.failures ?? ['conditional_catalogs']));
  const functions = await db.execute(sql`SELECT p.oid::text AS oid,p.proname AS name,
    CASE WHEN p.prokind IN('f','p') THEN encode(sha256(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8')),'hex') ELSE NULL END AS sha256
    FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace
      AND p.proname IN(SELECT jsonb_array_elements_text(${JSON.stringify(cashierRuntimeConditionalDefinitions(target).map(([name]) => name))}::jsonb))
    ORDER BY p.proname,p.oid`);
  const triggers = await db.execute(sql`SELECT t.oid::text AS oid,c.oid::text AS table_oid,c.relname AS table_name,
    t.tgname AS name,t.tgfoid::text AS function_oid FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
    WHERE t.tgfoid IN(SELECT p.oid FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace
      AND p.proname IN(SELECT jsonb_array_elements_text(${JSON.stringify(cashierRuntimeConditionalDefinitions(target).map(([name]) => name))}::jsonb)))
    ORDER BY c.relname,t.tgname,t.oid`);
  const unique = [...new Set(failures)].sort();
  return { ready: unique.length === 0, readOnly: true as const, binding, failures: unique, functions, triggers,
    inheritedAppConditionalGuardsReady: unique.length === 0,
    conditionalWriteSemanticsVerified: false as const, completeServiceCoverageVerified: false as const };
}

export async function inspectCashierRuntimeConditionalCatalogs(db: Query, target: RoutinePaymentRuntimeTarget,
  binding?: CashierRuntimeConditionalBinding) {
  const states = {
    staff: await inspectRuntimeAdminBoundary(db, target.app, target.maintenance, binding),
    locks: await inspectRuntimeLockOnlyBoundary(db, target.app, target.admin, target.maintenance, 'agent-levels', binding),
    schedule: await inspectRuntimeSeckillScheduleLockBoundary(db, target, binding),
    agent: await inspectRuntimeAgentLevelCatalogBoundary(db, target, binding),
  };
  const failures = Object.entries(states).filter(([, state]) => !state.ready).map(([name]) => 'conditional_' + name);
  // The historical lock inspector counts its own triggers. The complete
  // successor additionally rejects sibling hooks and reverse attachments.
  // The only unrelated hooks here are the source-pinned coupon scope fence.
  const expected: Array<[string,string,string,number,string|null,string|null]> = [];
  const add = (table:string,name:string,kind:number,old:string|null=null,next:string|null=null) =>
    expected.push([table,name,name+'()',kind,old,next]);
  for (const table of ['system_admin','system_role','system_menus']) add(table,'cinashop_runtime_admin_boundary_v1',31);
  for (const table of [...new Set([...Object.keys(RUNTIME_LOCK_ONLY_RULES.app),...Object.keys(RUNTIME_LOCK_ONLY_RULES.admin)])])
    add(table,'cinashop_runtime_lock_only_v1',19);
  for (const table of ['store_activity','store_seckill_time']) add(table,'cinashop_runtime_seckill_schedule_lock_only_v1',19);
  for (const table of ['agent_level','agent_level_task','agent_level_task_record']) add(table,'cinashop_runtime_agent_level_catalog_fence_v1',30);
  add('agent_level','cinashop_runtime_agent_level_row_guard_v1',31);
  for (const [name,kind,old,next] of [
    ['coupon_product_insert_0151',4,null,'coupon_scope_new'],
    ['coupon_product_update_0151',16,'coupon_scope_old','coupon_scope_new'],
    ['coupon_product_delete_0151',8,'coupon_scope_old',null],
  ] as const) expected.push(['store_coupon_product',name,'coupon_product_scope_fence_0151()',kind,old,next]);
  const [closed] = await db.execute(sql`WITH expected AS(SELECT x->>0 AS table_name,x->>1 AS name,x->>2 AS signature,
      (x->>3)::integer AS kind,x->>4 AS old_name,x->>5 AS new_name FROM jsonb_array_elements(${JSON.stringify(expected)}::jsonb) x),
    functions AS(SELECT p.* FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace
      AND p.proname IN(SELECT split_part(signature,'(',1) FROM expected)),
    actual AS(SELECT g.*,c.relname AS table_name,c.relnamespace FROM pg_catalog.pg_trigger g
      JOIN pg_catalog.pg_class c ON c.oid=g.tgrelid WHERE NOT g.tgisinternal AND
      (g.tgfoid IN(SELECT oid FROM functions) OR (c.relnamespace='public'::regnamespace
        AND c.relname IN(SELECT jsonb_array_elements_text(${JSON.stringify(CASHIER_RUNTIME_CONDITIONAL_TABLES)}::jsonb)))))
    SELECT NOT EXISTS(SELECT 1 FROM actual g FULL JOIN expected e ON g.table_name=e.table_name AND g.tgname=e.name
      WHERE g.oid IS NULL OR e.name IS NULL OR g.relnamespace<>'public'::regnamespace
        OR g.tgfoid<>pg_catalog.to_regprocedure('public.'||e.signature)::oid OR g.tgtype<>e.kind
        OR g.tgenabled<>'O' OR g.tgnargs<>0 OR g.tgargs<>''::bytea OR g.tgattr<>''::int2vector OR g.tgqual IS NOT NULL
        OR g.tgdeferrable OR g.tginitdeferred OR g.tgconstraint<>0 OR g.tgconstrrelid<>0 OR g.tgparentid<>0
        OR g.tgoldtable::text IS DISTINCT FROM e.old_name OR g.tgnewtable::text IS DISTINCT FROM e.new_name)
      AND (SELECT count(*)=6 FROM functions)
      AND (SELECT count(*)=1 AND bool_and(p.pronargs=0 AND p.prokind='f' AND NOT p.prosecdef
        AND p.proowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${target.maintenance})
        AND CASE WHEN p.prokind IN('f','p') THEN encode(sha256(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8')),'hex') ELSE NULL END=${MANAGER_PUBLIC_INVOKER_BASELINE['coupon_product_scope_fence_0151()']}
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
          WHERE a.grantee<>p.proowner AND (a.grantee<>0 OR a.privilege_type<>'EXECUTE' OR a.is_grantable)))
        FROM functions p WHERE p.proname='coupon_product_scope_fence_0151') AS ready`);
  if (closed?.ready !== true) failures.push('conditional_trigger_closure');
  return { ready: failures.length === 0, failures, states };
}
