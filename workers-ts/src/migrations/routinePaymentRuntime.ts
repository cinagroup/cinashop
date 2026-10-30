import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { inspectRoutineIdentityWitness, ROUTINE_IDENTITY_WITNESS_SQL } from './routineIdentityWitness';
import { inspectRoutinePaymentAttempt, ROUTINE_PAYMENT_ATTEMPT_SQL } from './routinePaymentAttempt';
import { inspectLocalPaymentCaseLock, installLocalPaymentCaseLock } from './localPaymentCaseLock';

type Query = Pick<DbClient, 'execute'>;
export interface RoutinePaymentRuntimeNames {
  maintenance: string;
  app: string;
  admin: string;
  /** Explicit additional local-settlement LOGINs, never inferred from ACLs. */
  local?: readonly string[];
  /** Optional lock-only capability, bound to an explicit subset of local. */
  caseLock?: { owner: string; runtimeRoles: readonly string[] };
}
export interface RoutinePaymentRuntimeTarget extends RoutinePaymentRuntimeNames { database: string }
export const ROUTINE_PAYMENT_RUNTIME_OPERATION = 'routine-payment-storage-runtime-v1';
const TABLES = ['routine_identity_witness', 'routine_payment_attempt'] as const;

function roles(names: RoutinePaymentRuntimeNames) {
  const locals = names.local ?? [];
  if (!Array.isArray(locals) || locals.length > 16) throw Error('Explicit bounded local runtime identities required');
  const all = [names.maintenance, names.app, names.admin, ...locals];
  all.forEach(pricingIdentifier);
  if (new Set(all).size !== all.length) throw Error('Distinct routine runtime identities required');
  if (names.caseLock) {
    pricingIdentifier(names.caseLock.owner);
    const lockRoles = names.caseLock.runtimeRoles;
    if (!Array.isArray(lockRoles) || !lockRoles.length || lockRoles.length > 16 || all.includes(names.caseLock.owner)
      || new Set(lockRoles).size !== lockRoles.length || lockRoles.some(role => !locals.includes(role)))
      throw Error('Explicit local-only case lock binding required');
  }
  return [names.app, names.admin, ...locals].sort();
}

/** Addon grants only. Historical whole-shop/custom base plans retain their
 * meaning. App owns login observations and Mini initiation; Admin and declared
 * local principals only need immutable attempt presence and action evidence. */
export function routinePaymentRuntimeTablePrivileges(kind: 'app' | 'admin' | 'local') {
  if (!['app', 'admin', 'local'].includes(kind)) throw Error('Fixed routine runtime profile required');
  return {
    routine_identity_witness: kind === 'app' ? ['SELECT', 'INSERT'] as const : [],
    routine_payment_attempt: kind === 'app' ? ['SELECT', 'INSERT'] as const : ['SELECT'] as const,
  };
}

async function inspectRoles(tx: Query, names: RoutinePaymentRuntimeNames) {
  const expected = roles(names);
  const rows = await tx.execute(sql`SELECT r.rolname AS name,
    r.rolcanlogin AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=r.oid AND deptype='o')
    AND NOT pg_catalog.has_database_privilege(r.oid,current_database(),'CREATE')
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname NOT LIKE 'pg_%'
      AND pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE'))
    AND NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET,ALTER SYSTEM')
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_default_acl d CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a
      WHERE a.grantee=r.oid OR (a.grantee=0 AND d.defaclobjtype IN('r','S'))) AS restricted
    FROM pg_catalog.pg_roles r WHERE r.rolname IN (${sql.join(expected.map(r => sql`${r}`), sql`, `)}) ORDER BY r.rolname`);
  return rows.length === expected.length && rows.every(r => r.restricted === true);
}

/** Exact owner/catalog/ACL comparison. No business rows, historical backfill,
 * repair, SET ROLE or grant inference. The caller supplies every allowed LOGIN.
 * This addon audit complements, and never replaces, the complete base audit. */
export async function inspectRoutinePaymentRuntime(tx: Query, names: RoutinePaymentRuntimeNames) {
  const runtimeRoles = roles(names), failures: string[] = [];
  const objects = await tx.execute(sql`SELECT 'relation' AS kind,c.relname AS name FROM pg_catalog.pg_class c
    WHERE c.relnamespace='public'::regnamespace AND (starts_with(c.relname,'routine_identity_witness')
      OR starts_with(c.relname,'routine_payment_attempt') OR starts_with(c.relname,'riw_') OR starts_with(c.relname,'rpa_'))
    UNION ALL SELECT 'function',p.proname FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace
      AND (starts_with(p.proname,'routine_identity_witness') OR starts_with(p.proname,'routine_payment_attempt')
        OR starts_with(p.proname,'riw_') OR starts_with(p.proname,'rpa_'))`);
  const present = objects.length > 0;
  if (!present) return { present: false, storageReady: false, storageOnly: false, ledgerReady: false, ready: false, failures: [] as string[] };
  const expectedObjects = [
    'relation:routine_identity_witness', 'relation:riw_pk', 'relation:riw_binding_latest',
    'relation:routine_payment_attempt', 'relation:rpa_pk',
    'function:routine_identity_witness_immutable_v1', 'function:routine_payment_attempt_immutable_v1',
  ].sort();
  if (JSON.stringify(objects.map(r => `${r.kind}:${r.name}`).sort()) !== JSON.stringify(expectedObjects)) failures.push('namespace');
  const witness = await inspectRoutineIdentityWitness(tx), attempt = await inspectRoutinePaymentAttempt(tx);
  if (!witness) failures.push('witness_catalog');
  if (!attempt) failures.push('attempt_catalog');
  const [owner] = await tx.execute(sql`SELECT count(*)=2 AND bool_and(c.relowner=(SELECT oid FROM pg_catalog.pg_roles
    WHERE rolname=${names.maintenance} AND rolsuper)) AS exact FROM pg_catalog.pg_class c
    WHERE c.relnamespace='public'::regnamespace AND c.relname IN('routine_identity_witness','routine_payment_attempt')`);
  if (owner?.exact !== true) failures.push('maintenance_owner');
  const storageReady = failures.length === 0;
  const grants = await tx.execute(sql`SELECT c.relname AS name,a.privilege_type AS privilege,a.is_grantable AS delegate,
    CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END AS role
    FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
    WHERE c.relnamespace='public'::regnamespace AND c.relname IN('routine_identity_witness','routine_payment_attempt') AND a.grantee<>c.relowner`);
  const expectedGrants: string[] = [];
  for (const role of runtimeRoles) {
    const plan = routinePaymentRuntimeTablePrivileges(role === names.app ? 'app' : role === names.admin ? 'admin' : 'local');
    for (const table of TABLES) for (const privilege of plan[table]) expectedGrants.push(`${table}:${role}:${privilege}`);
  }
  const actualGrants = grants.map(r => `${r.name}:${r.role}:${r.privilege}`).sort();
  const exactGrants = !grants.some(r => r.delegate !== false)
    && JSON.stringify(actualGrants) === JSON.stringify(expectedGrants.sort());
  const storageOnly = storageReady && grants.length === 0;
  if (!exactGrants) failures.push('ledger_acl');
  if (!await inspectRoles(tx, names)) failures.push('runtime_identities');
  const [action] = await tx.execute(sql`SELECT c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition
    AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
    AND c.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${names.maintenance})
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=c.oid) AS ordinary
    FROM pg_catalog.pg_class c WHERE c.oid=to_regclass('public.payment_reconciliation_action')`);
  if (action?.ordinary !== true) failures.push('action_catalog');
  if (action?.ordinary === true) {
    for (const role of runtimeRoles) {
      const [allowed] = await tx.execute(sql`SELECT pg_catalog.has_table_privilege(${role},'public.payment_reconciliation_action','SELECT')
        AND NOT pg_catalog.has_table_privilege(${role},'public.payment_reconciliation_action','SELECT WITH GRANT OPTION') AS ready`);
      if (allowed?.ready !== true) failures.push(`action_read:${role}`);
    }
  }
  const ledgerReady = failures.length === 0;
  const capability = await inspectLocalPaymentCaseLock(tx);
  if (!capability.absent || names.caseLock) {
    if (!names.caseLock || !capability.ready || capability.ownerName !== names.caseLock.owner
      || JSON.stringify(capability.grantees) !== JSON.stringify([...names.caseLock.runtimeRoles].sort())) failures.push('local_case_lock_binding');
    else for (const role of names.caseLock.runtimeRoles)
      if (!(await inspectLocalPaymentCaseLock(tx, role)).runtimeReady) failures.push(`local_case_lock_runtime:${role}`);
  }
  return { present, storageReady, storageOnly, ledgerReady, ready: failures.length === 0, failures: [...new Set(failures)].sort() };
}

async function setup(tx: Query, target: RoutinePaymentRuntimeTarget) {
  roles(target); pricingIdentifier(target.database);
  if (Object.hasOwn(tx, '$client')) throw Error('Routine installation requires a caller-owned maintenance transaction');
  await tx.execute(sql`SELECT set_config('search_path','public,pg_temp',true),
    set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
    set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
    set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
  const [environment] = await tx.execute(sql`SELECT current_database()=${target.database} AND current_user=${target.maintenance}
    AND session_user=current_user AND current_setting('server_version_num')::integer/10000=16
    AND current_setting('transaction_isolation')='read committed' AND current_setting('transaction_read_only')='off'
    AND current_setting('session_replication_role')='origin'
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity a JOIN pg_catalog.pg_roles r ON r.oid=a.usesysid
      WHERE a.pid=pg_backend_pid() AND r.rolname=current_user AND r.rolsuper)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS ready`);
  if (environment?.ready !== true) throw Error('Routine maintenance target requires review');
  for (const gate of [731669, 731670]) {
    const [lock] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${gate},0) AS locked`);
    if (lock?.locked !== true) throw Error('Routine storage maintenance is busy');
  }
}

/** Explicit absent-or-exact owner installation. Both ledgers and all addon
 * grants commit together. Partial namespaces/ACLs refuse; a replay validates
 * every catalog and grant without modifying data. No role creation or DDL is
 * reachable from request/startup. Existing users, orders and rows are retained. */
export async function installRoutinePaymentRuntimeInTransaction(tx: Query, target: RoutinePaymentRuntimeTarget) {
  await setup(tx, target);
  if (!await inspectRoles(tx, target)) throw Error('Routine runtime identities require review');
  let before = await inspectRoutinePaymentRuntime(tx, target);
  if (before.present && !before.storageReady) throw Error(`Routine storage preflight refused: ${before.failures.join(',')}`);
  if (before.present) {
    await tx.execute(sql.raw('LOCK TABLE ONLY public.routine_identity_witness, ONLY public.routine_payment_attempt IN ACCESS EXCLUSIVE MODE NOWAIT'));
    before = await inspectRoutinePaymentRuntime(tx, target);
    if (!before.storageReady) throw Error('Routine storage changed during maintenance locking');
    if (!before.ledgerReady && !before.storageOnly) throw Error('Routine addon partial grants require review');
  } else {
    await tx.execute(sql.raw(ROUTINE_IDENTITY_WITNESS_SQL));
    await tx.execute(sql.raw(ROUTINE_PAYMENT_ATTEMPT_SQL));
    const created = await inspectRoutinePaymentRuntime(tx, target);
    if (!created.storageOnly) throw Error('Routine storage creation verification refused');
  }
  if (!before.ledgerReady) {
    const [action] = await tx.execute(sql`SELECT c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition
      AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
      AND c.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${target.maintenance}) AS ready
      FROM pg_catalog.pg_class c WHERE c.oid=to_regclass('public.payment_reconciliation_action')`);
    if (action?.ready !== true) throw Error('Routine action evidence table requires review');
    await tx.execute(sql.raw('LOCK TABLE ONLY public.payment_reconciliation_action IN SHARE MODE NOWAIT'));
    for (const role of roles(target)) {
      const name = pricingIdentifier(role), plan = routinePaymentRuntimeTablePrivileges(role === target.app ? 'app' : role === target.admin ? 'admin' : 'local');
      await tx.execute(sql.raw(`GRANT USAGE ON SCHEMA public TO ${name}`));
      for (const table of TABLES) if (plan[table].length)
        await tx.execute(sql.raw(`GRANT ${plan[table].join(',')} ON TABLE public.${table} TO ${name}`));
      await tx.execute(sql.raw(`GRANT SELECT ON TABLE public.payment_reconciliation_action TO ${name}`));
    }
  }
  const caseLock = target.caseLock ? await installLocalPaymentCaseLock(tx, { database: target.database,
    maintenance: target.maintenance, owner: target.caseLock.owner, runtimeRoles: target.caseLock.runtimeRoles }) : null;
  const after = await inspectRoutinePaymentRuntime(tx, target);
  if (!after.ready) throw Error(`Routine installation verification refused: ${after.failures.join(',')}`);
  return { operation: ROUTINE_PAYMENT_RUNTIME_OPERATION, applied: !before.ledgerReady || caseLock?.applied === true, before, after, caseLock,
    baseProfilesVerified: false as const, businessValidationRequired: true as const, historicalRowsReassigned: false as const };
}

export async function runRoutinePaymentRuntimeInstallation(db: DbClient, target: RoutinePaymentRuntimeTarget) {
  if (!Object.hasOwn(db, '$client')) throw Error('Root maintenance connection required');
  return db.transaction(tx => installRoutinePaymentRuntimeInTransaction(tx, target),
    { isolationLevel: 'read committed', accessMode: 'read write' });
}

/** Real LOGIN addon audit, read-only. A positive result is scoped to this
 * fixed storage delta; the separate complete base-role audit is still needed. */
export async function auditRoutinePaymentRuntime(db: DbClient, kind: 'app' | 'admin' | 'local', target: RoutinePaymentRuntimeTarget, localRole?: string) {
  if (!Object.hasOwn(db, '$client')) throw Error('Root runtime connection required');
  const expected = kind === 'local' ? localRole : target[kind];
  if (!expected || !roles(target).includes(expected) || (kind === 'local' && !target.local?.includes(expected))) throw Error('Explicit runtime audit identity required');
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT set_config('statement_timeout','5000',true),set_config('lock_timeout','1000',true),
      set_config('idle_in_transaction_session_timeout','5000',true),set_config('search_path','public,pg_temp',true)`);
    const [identity] = await tx.execute(sql`SELECT current_database()=${target.database} AND current_user=${expected}
      AND session_user=current_user AND current_setting('server_version_num')::integer/10000=16
      AND current_setting('session_replication_role')='origin' AND EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity a
        JOIN pg_catalog.pg_roles r ON r.oid=a.usesysid WHERE a.pid=pg_backend_pid() AND r.rolname=${expected}) AS ready`);
    const state = await inspectRoutinePaymentRuntime(tx, target);
    return { ...state, ready: state.ready && identity?.ready === true, realLogin: identity?.ready === true,
      readOnly: true as const, baseProfilesVerified: false as const, kind };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
