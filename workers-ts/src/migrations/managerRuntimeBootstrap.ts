import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { inspectManagerOrderOperation } from './runManagerOrderOperation';
import { MANAGER_ORDER_OPERATION_INSTALLATION_SQL } from './managerOrderOperation';
import { inspectManagerScopeLock } from './runManagerScopeLock';
import { MANAGER_SCOPE_OWNER_SETTING, managerScopeCatalogReady, managerScopeLockInstallationSql } from './managerScopeLock';
import { inspectCheckoutPricingLock } from './checkoutPricingLock';
import { pricingCatalogReady } from './checkoutPricingLockCatalog';
import { refundEntityAcceptedPairSql } from './guestRefundEntityCatalog';

type Root = Pick<DbClient, 'transaction'> & Partial<Pick<DbClient, '$client'>>;
type Query = Pick<DbClient, 'execute'>;
export const MANAGER_BOOTSTRAP_OPERATION = 'manager-ledger-scope-bootstrap-v1';
export const MANAGER_BOOTSTRAP_SCOPE_OWNER = 'cinashop_manager_scope_v1';
export const MANAGER_BOOTSTRAP_TARGET = { database: 'postgres', maintenanceRole: 'postgres' } as const;
export interface ManagerBootstrapTarget { database: string; maintenanceRole: string }
const rootOnly = (db: Root) => { if (!Object.hasOwn(db, '$client') || !db.$client) throw Error('Manager bootstrap requires an explicit root connection'); };
async function context(tx: Query, target: ManagerBootstrapTarget) {
  if (!Object.values(target).every(name => /^[a-z_][a-z_0-9]{0,62}$/.test(name))) throw Error('Invalid explicit bootstrap target');
  const [row] = await tx.execute(sql`SELECT current_database() AS database,current_user AS role,session_user AS session,
    (SELECT r.rolname FROM pg_stat_activity a JOIN pg_roles r ON r.oid=a.usesysid WHERE a.pid=pg_backend_pid()) AS backend_role,
    current_database()=${target.database} AND current_user=${target.maintenanceRole} AND session_user=current_user
    AND current_setting('server_version_num')::integer/10000=16 AND current_setting('session_replication_role')='origin'
    AND EXISTS(SELECT 1 FROM pg_stat_activity a JOIN pg_roles r ON r.oid=a.usesysid WHERE a.pid=pg_backend_pid() AND r.rolname=current_user AND r.rolsuper)
    AND NOT EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') AS supported`);
  return row;
}
async function inspect(tx: Query, target: ManagerBootstrapTarget) {
  const identity = await context(tx, target);
  if (identity?.supported !== true) return { identity, state: 'unavailable' as const, ready: false, reason: 'maintenance_target', ledger: null, scope: null, owner: null, dependencies: null };
  const ledger = await inspectManagerOrderOperation(tx), scope = await inspectManagerScopeLock(tx);
  const owners = await tx.execute(sql`SELECT oid::text AS oid,rolname AS name,
    NOT(rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls) AS restricted,
    NOT EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid) AS no_memberships
    FROM pg_roles r WHERE rolname=${MANAGER_BOOTSTRAP_SCOPE_OWNER}`);
  const owner = owners.length === 1 ? owners[0] : null;
  const [ledgerSafety] = await tx.execute(sql`SELECT c.relowner=(SELECT oid FROM pg_roles WHERE rolname=${target.maintenanceRole})
    AND NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
      WHERE a.grantee<>c.relowner AND(a.grantee=0 OR a.is_grantable OR a.privilege_type NOT IN('SELECT','INSERT')))
    AND NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=c.oid AND attacl IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM pg_constraint WHERE confrelid=c.oid) AS safe
    FROM pg_class c WHERE c.oid=to_regclass('public.manager_order_operation_request')`);
  const pricing = await inspectCheckoutPricingLock(tx);
  const [relations] = await tx.execute(sql`SELECT to_regclass('public.store_order_invoice') IS NOT NULL
    AND to_regclass('public.store_order_refund_split') IS NOT NULL AND to_regclass('public.store_order_fulfillment_branch') IS NOT NULL AS present`);
  const refunds = relations?.present === true ? await tx.execute<{ invoice: string; split: string; profile: string }>(sql.raw(refundEntityAcceptedPairSql(true))) : [];
  const refund = refunds.length === 1 ? refunds[0] : null;
  const dependencies = { pricing: pricingCatalogReady(pricing), refund: !!refund && (refund.invoice === 'v2' && refund.split === 'v1' && refund.profile === 'legacy'
    || refund.invoice === 'v3' && refund.split === 'v2' && refund.profile === 'guest') };
  const canonical = ledger.complete && ledgerSafety?.safe === true && managerScopeCatalogReady(scope)
    && owner?.restricted === true && owner.no_memberships === true && owner.oid === scope.ownerOid;
  const fresh = !ledger.present && scope.absent && scope.tablesSafe && owners.length === 0;
  const state = canonical ? 'canonical' as const : fresh ? 'fresh' as const : 'unavailable' as const;
  return { identity, state, ready: canonical && dependencies.pricing && dependencies.refund,
    reason: !dependencies.pricing || !dependencies.refund ? 'existing_pricing_or_refund_dependency' : state === 'unavailable' ? 'partial_catalog_drift_or_scope_role_collision' : '',
    ledger, scope, owner, dependencies };
}
export async function inspectManagerRuntimeBootstrap(db: Root, target: ManagerBootstrapTarget = MANAGER_BOOTSTRAP_TARGET) {
  rootOnly(db);
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT set_config('search_path','public,pg_temp',true),set_config('statement_timeout','10000',true),set_config('lock_timeout','1500',true)`);
    return inspect(tx, target);
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

type ManifestRow = { kind: string; key: string; name: string; owner: string | null; shape: string; acl: { grantee: string; grantor: string; privilege: string; grantable: boolean }[] };
const acl = (value: string) => `COALESCE((SELECT jsonb_agg(jsonb_build_object('grantee',a.grantee::text,'grantor',a.grantor::text,'privilege',a.privilege_type,'grantable',a.is_grantable)
 ORDER BY a.grantee,a.grantor,a.privilege_type,a.is_grantable) FROM aclexplode(${value}) a),'[]'::jsonb)`;
const digest = (value: string) => `encode(sha256(convert_to(${value},'UTF8')),'hex')`;
const MANIFEST_SQL = `SELECT * FROM (
 SELECT 'namespace' AS kind,oid::text AS key,nspname AS name,nspowner::text AS owner,nspname AS shape,${acl("COALESCE(nspacl,acldefault('n',nspowner))")} AS acl FROM pg_namespace WHERE nspname='public'
 UNION ALL SELECT 'relation',c.oid::text,c.relname,c.relowner::text,
  ${digest("jsonb_build_object('kind',relkind,'persistence',relpersistence,'rls',relrowsecurity,'force',relforcerowsecurity,'partition',relispartition,'options',reloptions,'index',CASE WHEN relkind IN('i','I') THEN pg_get_indexdef(c.oid) END)::text")},
  ${acl("COALESCE(relacl,acldefault(CASE WHEN relkind='S' THEN 'S'::\"char\" ELSE 'r'::\"char\" END,relowner))")} FROM pg_class c WHERE relnamespace='public'::regnamespace
 UNION ALL SELECT 'column',c.oid::text||'.'||a.attnum::text,c.relname||'.'||a.attname,NULL,
  ${digest("jsonb_build_object('type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'collation',a.attcollation,'dropped',a.attisdropped,'default',pg_get_expr(d.adbin,d.adrelid))::text")},
  ${acl('a.attacl')} FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0
  LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE c.relnamespace='public'::regnamespace
 UNION ALL SELECT 'routine',p.oid::text,p.proname,p.proowner::text,${digest('pg_get_functiondef(p.oid)')},
  ${acl("COALESCE(p.proacl,acldefault('f',p.proowner))")} FROM pg_proc p WHERE pronamespace='public'::regnamespace AND prokind IN('f','p')
 UNION ALL SELECT 'constraint',k.oid::text,c.relname||'.'||k.conname,NULL,${digest("pg_get_constraintdef(k.oid)||':'||k.convalidated::text")},'[]'::jsonb
  FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid WHERE c.relnamespace='public'::regnamespace
 UNION ALL SELECT 'trigger',t.oid::text,c.relname||'.'||t.tgname,NULL,${digest("pg_get_triggerdef(t.oid)||':'||t.tgenabled::text")},'[]'::jsonb
  FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace
 UNION ALL SELECT 'sequence',s.seqrelid::text,c.relname,NULL,${digest('to_jsonb(s)::text')},'[]'::jsonb
  FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid WHERE c.relnamespace='public'::regnamespace
 UNION ALL SELECT 'role',oid::text,rolname,NULL,${digest("jsonb_build_object('login',rolcanlogin,'super',rolsuper,'createDb',rolcreatedb,'createRole',rolcreaterole,'inherit',rolinherit,'replication',rolreplication,'bypass',rolbypassrls,'limit',rolconnlimit,'until',rolvaliduntil)::text")},'[]'::jsonb FROM pg_roles
 ) manifest ORDER BY kind,key LIMIT 20001`;
async function manifest(tx: Query) {
  const rows = await tx.execute<ManifestRow>(sql.raw(MANIFEST_SQL));
  if (rows.length > 20000) throw Error('Manager bootstrap metadata budget exceeded');
  return Array.from(rows);
}
function verifyPreservation(before: ManifestRow[], after: ManifestRow[], ownerOid: string) {
  for (const old of before) {
    const current = after.find(row => row.kind === old.kind && row.key === old.key);
    if (!current || JSON.stringify({ ...old, acl: [] }) !== JSON.stringify({ ...current, acl: [] })) throw Error('Manager bootstrap replaced or changed an existing object');
    const additions = current.acl.filter(entry => !old.acl.some(previous => JSON.stringify(previous) === JSON.stringify(entry)));
    const expected = old.kind === 'namespace' && old.name === 'public' ? ['USAGE']
      : old.kind === 'relation' && ['system_store_staff', 'express_company'].includes(old.name) ? ['SELECT', 'UPDATE'] : [];
    if (old.acl.some(entry => !current.acl.some(next => JSON.stringify(entry) === JSON.stringify(next)))
      || additions.some(entry => entry.grantee !== ownerOid || entry.grantable || !expected.includes(entry.privilege)))
      throw Error('Manager bootstrap changed previous grants or added unreviewed authority');
  }
  const added = after.filter(row => !before.some(old => old.kind === row.kind && old.key === row.key));
  const columns = ['actor_uid','request_key','request_hash','store_id','staff_id','order_id','kind','outcome','scope_key','expected_revision','intent','evidence','created_at'];
  const indexColumns = ['mor_pk.actor_uid','mor_pk.request_key','mor_order_history.store_id','mor_order_history.order_id','mor_order_history.created_at','mor_order_history.actor_uid','mor_order_history.request_key'];
  const constraints = ['mor_pk','mor_identity_ck','mor_key_ck','mor_hash_ck','mor_json_ck','mor_outcome_ck','mor_kind_ck'];
  const allowed = (row: ManifestRow) => row.kind === 'role' && row.name === MANAGER_BOOTSTRAP_SCOPE_OWNER
    || row.kind === 'relation' && ['manager_order_operation_request','mor_pk','mor_order_history'].includes(row.name)
    || row.kind === 'column' && (columns.some(name => row.name === 'manager_order_operation_request.' + name) || indexColumns.includes(row.name))
    || row.kind === 'constraint' && constraints.some(name => row.name === 'manager_order_operation_request.' + name)
    || row.kind === 'routine' && ['manager_lock_scope_v1','manager_lock_carrier_v1'].includes(row.name);
  if (added.length !== 33 || added.some(row => !allowed(row))) throw Error('Manager bootstrap added an unexpected metadata object');
  return { oldObjectsPreserved: before.length, newObjects: added.length, oldPrincipalGrantsPreserved: true as const,
    permittedAclAdditions: ['public:USAGE', 'system_store_staff:SELECT,UPDATE', 'express_company:SELECT,UPDATE'] };
}

/** Additive fixed Manager core only. No application/Admin grants, LOGIN/password,
 * business rows, sequence values, bootstrap history, or missing dependencies. */
export async function installManagerRuntimeBootstrap(db: Root, target: ManagerBootstrapTarget = MANAGER_BOOTSTRAP_TARGET) {
  rootOnly(db);
  try {
    return await db.transaction(async tx => {
      await tx.execute(sql`SELECT set_config('search_path','public,pg_temp',true),set_config('statement_timeout','10000',true),
        set_config('lock_timeout','1500',true),set_config('idle_in_transaction_session_timeout','10000',true)`);
      const [lock] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(731812,2) AS locked`);
      if (lock?.locked !== true) throw Error('Manager bootstrap is busy');
      const beforeState = await inspect(tx, target);
      if (beforeState.state === 'canonical' && beforeState.ready) return { operation: MANAGER_BOOTSTRAP_OPERATION, applied: false as const, state: beforeState };
      if (beforeState.state !== 'fresh' || !beforeState.dependencies?.pricing || !beforeState.dependencies.refund) throw Error('Manager bootstrap exact fresh state and existing dependencies required');
      const before = await manifest(tx);
      await tx.execute(sql.raw(`CREATE ROLE "${MANAGER_BOOTSTRAP_SCOPE_OWNER}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`));
      await tx.execute(sql.raw(MANAGER_ORDER_OPERATION_INSTALLATION_SQL));
      await tx.execute(sql`SELECT set_config(${MANAGER_SCOPE_OWNER_SETTING},${MANAGER_BOOTSTRAP_SCOPE_OWNER},true)`);
      await tx.execute(sql.raw(managerScopeLockInstallationSql('public')));
      const state = await inspect(tx, target);
      if (!state.ready || state.state !== 'canonical' || !state.owner || !state.scope) throw Error('Manager bootstrap canonical postcheck failed');
      const preservation = verifyPreservation(before, await manifest(tx), String(state.owner.oid));
      const [rows] = await tx.execute(sql`SELECT count(*)::integer AS count FROM public.manager_order_operation_request`);
      if (rows.count !== 0) throw Error('New Manager ledger is not empty');
      return { operation: MANAGER_BOOTSTRAP_OPERATION, applied: true as const, state, preservation, newLedgerRows: 0,
        applicationAdminGrantsApplied: false as const, businessDataWrites: false as const };
    }, { isolationLevel: 'read committed', accessMode: 'read write' });
  } catch { throw Error('Manager bootstrap outcome not confirmed; inspect the fixed catalogs and original attempt before further action'); }
}
