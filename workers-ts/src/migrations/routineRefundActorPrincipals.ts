import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { MANAGER_RUNTIME_ROLE } from './managerRuntimePrivilegePlan';
import { CUSTOMER_FINANCIAL_RUNTIME_ROLE } from './customerFinancialRuntimePlan';
import { captureCashierRuntimeConditionalBinding, type CashierRuntimeConditionalBinding } from './cashierRuntimeConditionalBinding';
import { inspectRuntimeAdminBoundary } from './runtimeAdminBoundary';
import { inspectRuntimeLockOnlyBoundary, RUNTIME_LOCK_ONLY_RULES } from './runtimeLockOnlyBoundary';
import { AGENT_LEVEL_CATALOG_FENCE, AGENT_LEVEL_ROW_GUARD, inspectRuntimeAgentLevelCatalogBoundary } from './runtimeAgentLevelCatalogBoundary';

type Query = Pick<DbClient, 'execute'>;
export interface RoutineRefundActorPrincipalNames { maintenance: string; app: string; admin?: string }
export interface RoutineRefundActorPrincipalBinding {
  database: string; databaseOid: string; maintenance: string; maintenanceOid: string;
  app: string; appOid: string; admin: string; adminOid: string;
  manager: string | null; managerOid: string | null;
}
export interface RoutineRefundActorPrincipals {
  ready: boolean; failures: string[]; binding: RoutineRefundActorPrincipalBinding | null;
}
interface RoutineRow { name: string; oid: string; ownerOid: string; source: string | null }
interface Context extends Record<string,unknown> {
  database: string; databaseOid: string; maintenanceOid: string; supported: boolean; routines: RoutineRow[];
}
interface RoleRow extends Record<string,unknown> { name: string; oid: string; safe: boolean }
const STAFF = 'cinashop_runtime_admin_boundary_v1';
const LOCK = 'cinashop_runtime_lock_only_v1';
const routines = [STAFF, LOCK, AGENT_LEVEL_CATALOG_FENCE, AGENT_LEVEL_ROW_GUARD];
const oid = (value: unknown): value is string => typeof value === 'string'
  && /^[1-9][0-9]{0,9}$/u.test(value) && BigInt(value) <= 4294967295n;
const rejected = (...failures: string[]): RoutineRefundActorPrincipals => ({ ready: false, failures, binding: null });

/** Detach primitive declarations before metadata I/O; getters are not names. */
function capture(value: RoutineRefundActorPrincipalNames): RoutineRefundActorPrincipalNames {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw Error();
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value);
  if (keys.length < 2 || keys.length > 3 || keys.some(key => typeof key !== 'string'
    || !['maintenance', 'app', 'admin'].includes(key) || !descriptors[key]?.enumerable || !('value' in descriptors[key]))) throw Error();
  const maintenance = descriptors.maintenance?.value, app = descriptors.app?.value, admin = descriptors.admin?.value;
  if (typeof maintenance !== 'string' || typeof app !== 'string' || admin !== undefined && typeof admin !== 'string') throw Error();
  for (const name of [maintenance, app, ...(admin === undefined ? [] : [admin])]) {
    pricingIdentifier(name);
    if ([MANAGER_RUNTIME_ROLE, CUSTOMER_FINANCIAL_RUNTIME_ROLE].includes(name)) throw Error();
  }
  if (new Set([maintenance, app, ...(admin === undefined ? [] : [admin])]).size !== (admin === undefined ? 2 : 3)) throw Error();
  return { maintenance, app, ...(admin === undefined ? {} : { admin }) };
}

async function context(tx: Query, maintenance: string): Promise<Context | undefined> {
  const [row] = await tx.execute<Context>(sql`SELECT pg_catalog.current_database() AS database,
    (SELECT oid::text FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS "databaseOid",
    r.oid::text AS "maintenanceOid",
    pg_catalog.current_setting('server_version_num')::integer/10000=16 AND r.rolsuper AND r.rolcanlogin AS supported,
    COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',p.proname,'oid',p.oid::text,
      'ownerOid',p.proowner::text,'source',CASE WHEN pg_catalog.octet_length(p.prosrc)<=65536 THEN p.prosrc ELSE NULL END)
      ORDER BY p.proname COLLATE "C",p.oid) FROM (
        SELECT * FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace
          AND proname IN (${sql.join(routines.map(name => sql`${name}`), sql`, `)}) ORDER BY proname COLLATE "C",oid LIMIT 5
      ) p),'[]'::jsonb) AS routines
    FROM pg_catalog.pg_roles r WHERE r.rolname=${maintenance}`);
  return row;
}

function candidates(c: Context, names: RoutineRefundActorPrincipalNames) {
  if (c.supported !== true || !oid(c.databaseOid) || !oid(c.maintenanceOid)
    || !Array.isArray(c.routines) || c.routines.length !== routines.length) throw Error();
  pricingIdentifier(c.database);
  for (const name of routines) {
    const rows = c.routines.filter(row => row.name === name);
    if (rows.length !== 1 || !oid(rows[0].oid) || rows[0].ownerOid !== c.maintenanceOid || typeof rows[0].source !== 'string') throw Error();
  }
  const prefix = /^BEGIN\nIF current_user IN \('([a-z_][a-z0-9_]{0,62})','([a-z_][a-z0-9_]{0,62})'\)/u;
  const pairs = [AGENT_LEVEL_CATALOG_FENCE, AGENT_LEVEL_ROW_GUARD].map(name => prefix.exec(c.routines.find(row => row.name === name)!.source!));
  if (!pairs[0] || !pairs[1] || pairs[0][1] !== pairs[1][1] || pairs[0][2] !== pairs[1][2]
    || pairs[0][1] !== names.app || names.admin !== undefined && pairs[0][2] !== names.admin) throw Error();
  const admin = pairs[0][2]; pricingIdentifier(admin);
  if (new Set([names.maintenance, names.app, admin, MANAGER_RUNTIME_ROLE, CUSTOMER_FINANCIAL_RUNTIME_ROLE]).size !== 5) throw Error();

  const staff = c.routines.find(row => row.name === STAFF)!.source!;
  const base = /^\nBEGIN\n  IF current_user = '([a-z_][a-z0-9_]{0,62})' THEN\n/u.exec(staff);
  let cashier: CashierRuntimeConditionalBinding | undefined;
  if (base) {
    if (base[1] !== names.app) throw Error();
  } else {
    // These literals only select the canonical generator. The inspectors below
    // must still validate every byte, owner, flag and trigger in all four bodies.
    const principal = /^\nBEGIN\n  IF \(current_user = '([a-z_][a-z0-9_]{0,62})' OR \(current_user='([a-z_][a-z0-9_]{0,62})' OR \(SELECT oid FROM pg_catalog\.pg_roles WHERE rolname=current_user\)='([1-9][0-9]*)'::oid\)\) THEN\n/u.exec(staff);
    const database = /\nIF current_database\(\)<>'([a-z_][a-z0-9_]{0,62})' OR\n  \(SELECT oid FROM pg_catalog\.pg_database WHERE datname=current_database\(\)\)<>'([1-9][0-9]*)'::oid OR\n/u.exec(staff);
    if (!principal || !database || principal[1] !== names.app) throw Error();
    cashier = captureCashierRuntimeConditionalBinding({ role: principal[2], roleOid: principal[3], database: database[1], databaseOid: database[2] });
    if (cashier.database !== c.database || cashier.databaseOid !== c.databaseOid
      || [names.maintenance, names.app, admin, MANAGER_RUNTIME_ROLE, CUSTOMER_FINANCIAL_RUNTIME_ROLE].includes(cashier.role)) throw Error();
  }
  return { admin, cashier };
}

async function roles(tx: Query, names: readonly string[]) {
  return Array.from(await tx.execute<RoleRow>(sql`SELECT r.rolname AS name,r.oid::text AS oid,
    r.rolcanlogin AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=r.oid AND deptype='o')
    AND pg_catalog.has_database_privilege(r.oid,pg_catalog.current_database(),'CONNECT') AND pg_catalog.has_schema_privilege(r.oid,'public','USAGE')
    AND NOT pg_catalog.has_database_privilege(r.oid,pg_catalog.current_database(),'CREATE')
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE'))
    AND NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET,ALTER SYSTEM')
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_default_acl d CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a WHERE a.grantee=r.oid) AS safe
    FROM pg_catalog.pg_roles r WHERE r.rolname IN (${sql.join(names.map(name => sql`${name}`), sql`, `)}) ORDER BY r.rolname COLLATE "C"`));
}

/** Existing inspectors check the canonical target triggers. Also reject a
 * reversed attachment of any of these named functions on a different table. */
async function closedAttachments(tx: Query): Promise<boolean> {
  const expected: Array<[string, string, string, number]> = [];
  for (const table of ['system_admin', 'system_role', 'system_menus']) expected.push([table, STAFF, STAFF, 31]);
  for (const table of [...new Set([...Object.keys(RUNTIME_LOCK_ONLY_RULES.app), ...Object.keys(RUNTIME_LOCK_ONLY_RULES.admin)])].sort())
    expected.push([table, LOCK, LOCK, 19]);
  for (const table of ['agent_level', 'agent_level_task', 'agent_level_task_record']) expected.push([table, AGENT_LEVEL_CATALOG_FENCE, AGENT_LEVEL_CATALOG_FENCE, 30]);
  expected.push(['agent_level', AGENT_LEVEL_ROW_GUARD, AGENT_LEVEL_ROW_GUARD, 31]);
  const [row] = await tx.execute<{ ready: boolean }>(sql`WITH expected AS (
    SELECT x->>0 AS table_name,x->>1 AS trigger_name,x->>2 AS function_name,(x->>3)::integer AS kind
    FROM pg_catalog.jsonb_array_elements(${JSON.stringify(expected)}::jsonb) x
  ), actual AS (
    SELECT t.*,c.relname AS table_name,c.relnamespace,p.proname AS function_name
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
      JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid WHERE p.pronamespace='public'::regnamespace
      AND p.proname IN (${sql.join(routines.map(name => sql`${name}`), sql`, `)})
  ) SELECT NOT EXISTS(SELECT 1 FROM actual t FULL JOIN expected e
    ON t.table_name=e.table_name AND t.tgname=e.trigger_name AND t.function_name=e.function_name
    WHERE t.oid IS NULL OR e.table_name IS NULL OR t.relnamespace<>'public'::regnamespace OR t.tgtype<>e.kind
      OR t.tgenabled<>'O' OR t.tgisinternal OR t.tgnargs<>0 OR t.tgargs<>''::bytea OR t.tgattr<>''::int2vector
      OR t.tgqual IS NOT NULL OR t.tgdeferrable OR t.tginitdeferred OR t.tgconstraint<>0 OR t.tgconstrrelid<>0 OR t.tgparentid<>0
      OR t.tgoldtable IS NOT NULL OR t.tgnewtable IS NOT NULL) AS ready`);
  return row?.ready === true;
}

/** Metadata-only principal proof, not a grant, full runtime profile, human
 * actor authorization or authenticated caller-session proof. No refund/source
 * inspector is called here: those catalogs may depend on this leaf. No DDL,
 * row/advisory lock, named-routine execution or current config is used. No
 * principal name is learned from an ACL grantee. */
export async function inspectRoutineRefundActorPrincipals(tx: Query, value: RoutineRefundActorPrincipalNames): Promise<RoutineRefundActorPrincipals> {
  let names: RoutineRefundActorPrincipalNames;
  try { names = capture(value); } catch { return rejected('declaration'); }
  try {
    const before = await context(tx, names.maintenance);
    if (!before) return rejected('maintenance');
    let inferred: ReturnType<typeof candidates>;
    try { inferred = candidates(before, names); } catch { return rejected('named_candidates'); }
    const { admin, cashier } = inferred, named = { maintenance: names.maintenance, app: names.app, admin };
    const participants = [names.app, admin, MANAGER_RUNTIME_ROLE, ...(cashier ? [cashier.role] : [])];
    const principals = await roles(tx, participants), app = principals.find(row => row.name === names.app),
      adminRole = principals.find(row => row.name === admin), manager = principals.find(row => row.name === MANAGER_RUNTIME_ROLE),
      cashierRole = cashier ? principals.find(row => row.name === cashier.role) : undefined;
    if (!app || !adminRole || principals.some(row => row.safe !== true || !oid(row.oid))
      || cashier && (!cashierRole || cashierRole.oid !== cashier.roleOid)
      || new Set(principals.map(row => row.oid)).size !== principals.length) return rejected('principal_roles');
    const agent = await inspectRuntimeAgentLevelCatalogBoundary(tx, named, cashier);
    if (!agent.ready) return rejected('agent_boundary');
    if (!(await inspectRuntimeAdminBoundary(tx, names.app, names.maintenance, cashier)).ready) return rejected('staff_boundary');
    if (!(await inspectRuntimeLockOnlyBoundary(tx, names.app, admin, names.maintenance, 'agent-levels', cashier)).ready) return rejected('lock_boundary');
    if (!await closedAttachments(tx)) return rejected('trigger_closure');
    const after = await context(tx, names.maintenance), currentRoles = await roles(tx, participants);
    if (JSON.stringify(before) !== JSON.stringify(after) || JSON.stringify(principals) !== JSON.stringify(currentRoles)) return rejected('metadata_changed');
    return { ready: true, failures: [], binding: { database: before.database, databaseOid: before.databaseOid,
      maintenance: names.maintenance, maintenanceOid: before.maintenanceOid, app: names.app, appOid: app.oid,
      admin, adminOid: adminRole.oid, manager: manager?.name ?? null, managerOid: manager?.oid ?? null } };
  } catch { return rejected('catalog_query'); }
}
