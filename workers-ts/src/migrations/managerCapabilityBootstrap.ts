import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { inspectManagerRuntimeCatalogPrerequisites } from './auditManagerRuntimePrivileges';
import { installManagerRuntimeCapabilities, MANAGER_WAYBILL_OWNER, MANAGER_PROMOTION_OWNER } from './managerRuntimeCapabilities';
import { inspectCustomerManualRefund } from './runCustomerManualRefund';
import { MANAGER_BOOTSTRAP_SCOPE_OWNER, MANAGER_BOOTSTRAP_TARGET, type ManagerBootstrapTarget } from './managerRuntimeBootstrap';

type Root = Pick<DbClient, 'transaction'> & Partial<Pick<DbClient, '$client'>>;
type Query = Pick<DbClient, 'execute'>;
export const MANAGER_CAPABILITY_BOOTSTRAP_OPERATION = 'manager-fixed-capabilities-bootstrap-v1';
export { MANAGER_PROMOTION_OWNER } from './managerRuntimeCapabilities';
const rootOnly = (db: Root) => { if (!Object.hasOwn(db, '$client') || !db.$client) throw Error('Manager capability bootstrap requires an explicit root connection'); };
async function inspect(tx: Query, target: ManagerBootstrapTarget) {
  if (!Object.values(target).every(name => /^[a-z_][a-z_0-9]{0,62}$/.test(name))) throw Error('Invalid explicit capability target');
  const [identity] = await tx.execute(sql`SELECT current_database() AS database,current_user AS role,session_user AS session,
    (SELECT r.rolname FROM pg_stat_activity a JOIN pg_roles r ON r.oid=a.usesysid WHERE a.pid=pg_backend_pid()) AS backend_role,
    current_database()=${target.database} AND current_user=${target.maintenanceRole} AND session_user=current_user
    AND current_setting('server_version_num')::integer/10000=16 AND current_setting('session_replication_role')='origin'
    AND EXISTS(SELECT 1 FROM pg_stat_activity a JOIN pg_roles r ON r.oid=a.usesysid WHERE a.pid=pg_backend_pid() AND r.rolname=current_user AND r.rolsuper)
    AND NOT EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') AS supported`);
  if (identity?.supported !== true) return { identity, state: 'unavailable' as const, ready: false, prerequisites: null, promotionOwner: null, reason: 'maintenance_target' };
  const prerequisites = await inspectManagerRuntimeCatalogPrerequisites(tx), caps = prerequisites.capabilities;
  const [coreOwner] = await tx.execute(sql`SELECT oid::text AS oid,
    NOT(rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls)
    AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid) AS restricted
    FROM pg_roles r WHERE rolname=${MANAGER_BOOTSTRAP_SCOPE_OWNER}`);
  const [coreLedger] = await tx.execute(sql`SELECT c.relowner=(SELECT oid FROM pg_roles WHERE rolname=${target.maintenanceRole})
    AND NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
      WHERE a.grantee<>c.relowner AND(a.grantee=0 OR a.is_grantable OR a.privilege_type NOT IN('SELECT','INSERT')))
    AND NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=c.oid AND attacl IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM pg_constraint WHERE confrelid=c.oid) AS safe
    FROM pg_class c WHERE c.oid=to_regclass('public.manager_order_operation_request')`);
  const manual = await inspectCustomerManualRefund(tx);
  const manualOwners = await tx.execute<{ oid: string; name: string; restricted: boolean; exact: boolean }>(sql`SELECT r.oid::text AS oid,r.rolname AS name,
    NOT(r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
    AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid) AS restricted,
    p.proargtypes='23 23'::oidvector AS exact FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
    WHERE p.pronamespace='public'::regnamespace AND p.proname='customer_manual_refund_promotion_delete_v1'`);
  const manualPresent = manual.present || manualOwners.length > 0;
  const manualSafe = !manualPresent || manual.complete && manualOwners.length === 1 && manualOwners[0].restricted && manualOwners[0].exact;
  const [cashier] = await tx.execute(sql`SELECT EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='cashier_second_card_promotion_lock_v1')
    OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.store_order_promotions') AND tgname='cashier_second_card_promotion_lock_v1') AS present`);
  const promotionOwner = manualPresent && manualSafe ? { ...manualOwners[0], reuse: true }
    : { oid: caps.promotion.ownerOid, name: MANAGER_PROMOTION_OWNER, restricted: true, exact: true, reuse: false };
  const roles = await tx.execute<{ name: string; oid: string }>(sql`SELECT rolname AS name,oid::text AS oid FROM pg_roles WHERE rolname IN(${MANAGER_WAYBILL_OWNER},${MANAGER_PROMOTION_OWNER})`);
  const [deleteAcl] = await tx.execute(sql`SELECT NOT EXISTS(SELECT 1 FROM pg_class c
    CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
    WHERE c.oid=to_regclass('public.store_order_promotions') AND a.grantee<>c.relowner AND a.privilege_type='DELETE'
      AND (a.is_grantable OR a.grantee::text IS DISTINCT FROM ${promotionOwner.oid})) AS single_owner`);
  const coreReady = prerequisites.operation.complete && coreLedger?.safe === true && coreOwner?.restricted === true && coreOwner.oid === prerequisites.scope.ownerOid;
  const baseReady = prerequisites.presence.ready && coreReady
    && !prerequisites.failures.some(f => !['manager_waybill_missing','manager_delivery_missing','manager_promotion_missing'].includes(f)) && manualSafe && deleteAcl?.single_owner === true
    && !(cashier?.present === true && !manualPresent);
  const allAbsent = caps.waybill.absent && caps.delivery.absent && caps.promotion.absent;
  const fixedPromotionCollision = roles.some(r => r.name === MANAGER_PROMOTION_OWNER && (!promotionOwner.reuse || r.oid !== promotionOwner.oid));
  const fresh = baseReady && allAbsent && !roles.some(r => r.name === MANAGER_WAYBILL_OWNER) && !fixedPromotionCollision;
  const canonical = prerequisites.ready && coreReady && manualSafe && deleteAcl?.single_owner === true && !(cashier?.present === true && !manualPresent)
    && caps.waybill.ownerOid === roles.find(r => r.name === MANAGER_WAYBILL_OWNER)?.oid
    && caps.promotion.ownerOid === (promotionOwner.reuse ? promotionOwner.oid : roles.find(r => r.name === MANAGER_PROMOTION_OWNER)?.oid)
    && (promotionOwner.reuse ? !fixedPromotionCollision : true);
  const state = canonical ? 'canonical' as const : fresh ? 'fresh' as const : 'unavailable' as const;
  return { identity, state, ready: canonical, prerequisites, promotionOwner,
    reason: state === 'unavailable' ? 'fixed_dependencies_partial_drift_role_collision_or_promotion_owner' : '' };
}
export async function inspectManagerCapabilityBootstrap(db: Root, target: ManagerBootstrapTarget = MANAGER_BOOTSTRAP_TARGET) {
  rootOnly(db); return db.transaction(async tx => {
    await tx.execute(sql`SELECT set_config('search_path','public,pg_temp',true),set_config('statement_timeout','10000',true)`);
    return inspect(tx, target);
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

// Fixed installation only grants privileges and creates three routines/at most
// two roles. Preserve identities, definitions and previous grants of every old
// public relation/column/routine and role; allow only the reviewed owner delta.
type ObjectRow = { kind: string; key: string; name: string; shape: string; acl: { grantee: string; grantor: string; privilege: string; grantable: boolean }[] };
const acl = (value: string) => `COALESCE((SELECT jsonb_agg(jsonb_build_object('grantee',a.grantee::text,'grantor',a.grantor::text,'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY a.grantee,a.grantor,a.privilege_type,a.is_grantable) FROM aclexplode(${value}) a),'[]'::jsonb)`;
const hash = (value: string) => `encode(sha256(convert_to(${value},'UTF8')),'hex')`;
const OBJECTS_SQL = `SELECT * FROM (
 SELECT 'schema' kind,oid::text key,nspname name,${hash("nspowner::text||':'||nspname")} shape,${acl("COALESCE(nspacl,acldefault('n',nspowner))")} acl FROM pg_namespace WHERE nspname='public'
 UNION ALL SELECT 'relation',c.oid::text,c.relname,${hash("jsonb_build_object('owner',relowner,'kind',relkind,'persistence',relpersistence,'rls',relrowsecurity,'force',relforcerowsecurity,'partition',relispartition,'options',reloptions,'index',CASE WHEN relkind IN('i','I') THEN pg_get_indexdef(c.oid) END)::text")},${acl("COALESCE(relacl,acldefault(CASE WHEN relkind='S' THEN 'S'::\"char\" ELSE 'r'::\"char\" END,relowner))")} FROM pg_class c WHERE relnamespace='public'::regnamespace
 UNION ALL SELECT 'column',c.oid::text||'.'||a.attnum::text,c.relname||'.'||a.attname,${hash("jsonb_build_object('type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'collation',a.attcollation,'dropped',a.attisdropped,'default',pg_get_expr(d.adbin,d.adrelid))::text")},${acl('a.attacl')} FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE c.relnamespace='public'::regnamespace
 UNION ALL SELECT 'routine',p.oid::text,p.proname,${hash("p.proowner::text||':'||pg_get_functiondef(p.oid)")},${acl("COALESCE(p.proacl,acldefault('f',p.proowner))")} FROM pg_proc p WHERE pronamespace='public'::regnamespace AND prokind IN('f','p')
 UNION ALL SELECT 'constraint',k.oid::text,c.relname||'.'||k.conname,${hash("pg_get_constraintdef(k.oid)||':'||k.convalidated::text")},'[]'::jsonb FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid WHERE c.relnamespace='public'::regnamespace
 UNION ALL SELECT 'trigger',t.oid::text,c.relname||'.'||t.tgname,${hash("pg_get_triggerdef(t.oid)||':'||t.tgenabled::text")},'[]'::jsonb FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace
 UNION ALL SELECT 'role',oid::text,rolname,${hash("jsonb_build_object('login',rolcanlogin,'super',rolsuper,'createDb',rolcreatedb,'createRole',rolcreaterole,'inherit',rolinherit,'replication',rolreplication,'bypass',rolbypassrls,'limit',rolconnlimit,'until',rolvaliduntil)::text")},'[]'::jsonb FROM pg_roles
 ) x ORDER BY kind,key LIMIT 20001`;
async function objects(tx: Query) { const rows = await tx.execute<ObjectRow>(sql.raw(OBJECTS_SQL)); if (rows.length > 20000) throw Error('Capability metadata budget exceeded'); return Array.from(rows); }
const promotionReads = ['manager_order_operation_request','store_order','store_order_promotions','system_store','system_store_staff','user'];
function preserved(before: ObjectRow[], after: ObjectRow[], waybillOid: string, promotionOid: string, reuse: boolean) {
  const index = (rows: ObjectRow[]) => {
    const kinds = new Map<string, Map<string, ObjectRow>>();
    for (const row of rows) {
      let keys = kinds.get(row.kind);
      if (!keys) { keys = new Map<string, ObjectRow>(); kinds.set(row.kind, keys); }
      // Preserve the first matching row, as the original Array.find did.
      if (!keys.has(row.key)) keys.set(row.key, row);
    }
    return kinds;
  };
  const beforeIndex = index(before), afterIndex = index(after);
  for (const old of before) {
    const current = afterIndex.get(old.kind)?.get(old.key);
    if (!current || old.name !== current.name || old.shape !== current.shape) throw Error('Capability bootstrap changed an old object');
    if (old.acl.some(a => !current.acl.some(b => JSON.stringify(a) === JSON.stringify(b)))) throw Error('Capability bootstrap removed an old grant');
    for (const a of current.acl.filter(a => !old.acl.some(b => JSON.stringify(a) === JSON.stringify(b)))) {
      const allowed = a.grantee === waybillOid ? old.kind === 'schema' && old.name === 'public' && a.privilege === 'USAGE'
        || old.kind === 'relation' && (['order_waybill_job','delivery_service','manager_order_operation_request'].includes(old.name) && a.privilege === 'SELECT'
          || ['order_waybill_job','delivery_service'].includes(old.name) && a.privilege === 'UPDATE')
        : a.grantee === promotionOid && (old.kind === 'schema' && old.name === 'public' && a.privilege === 'USAGE'
          || old.kind === 'relation' && (promotionReads.includes(old.name) && a.privilege === 'SELECT' || old.name === 'store_order_promotions' && a.privilege === 'DELETE'));
      if (!allowed || a.grantable) throw Error('Capability bootstrap added unreviewed authority');
    }
  }
  const added = after.filter(a => !beforeIndex.get(a.kind)?.has(a.key));
  if (added.length !== (reuse ? 4 : 5) || added.some(a => !(a.kind === 'role' && [MANAGER_WAYBILL_OWNER,...(reuse ? [] : [MANAGER_PROMOTION_OWNER])].includes(a.name)
    || a.kind === 'routine' && ['manager_lock_waybill_v1','manager_lock_delivery_agents_v1','manager_delete_order_promotions_v1'].includes(a.name)))) throw Error('Capability bootstrap created an unreviewed object');
  return { oldObjectsPreserved: before.length, oldPrincipalGrantsPreserved: true as const, newObjects: added.length, existingManualOwnerReused: reuse };
}
export async function bootstrapManagerRuntimeCapabilities(db: Root, target: ManagerBootstrapTarget = MANAGER_BOOTSTRAP_TARGET) {
  rootOnly(db);
  try { return await db.transaction(async tx => {
    await tx.execute(sql`SELECT set_config('search_path','public,pg_temp',true),set_config('statement_timeout','10000',true),set_config('lock_timeout','1500',true),set_config('idle_in_transaction_session_timeout','10000',true)`);
    const [lock] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(731812,3) AS locked`); if (lock?.locked !== true) throw Error('Capability bootstrap busy');
    const initial = await inspect(tx, target);
    if (initial.state === 'canonical' && initial.ready) return { operation: MANAGER_CAPABILITY_BOOTSTRAP_OPERATION, applied: false as const, state: initial };
    if (initial.state !== 'fresh' || !initial.promotionOwner) throw Error('Exact fresh fixed capability state required');
    const before = await objects(tx);
    for (const name of [MANAGER_WAYBILL_OWNER,...(initial.promotionOwner.reuse ? [] : [MANAGER_PROMOTION_OWNER])])
      await tx.execute(sql`CREATE ROLE ${sql.identifier(name)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    const caps = await installManagerRuntimeCapabilities(tx, { waybillOwner: MANAGER_WAYBILL_OWNER, promotionOwner: initial.promotionOwner.name });
    const state = await inspect(tx, target);
    if (!state.ready || !caps.ready || !caps.waybill.ownerOid || !caps.promotion.ownerOid) throw Error('Canonical capability postcheck failed');
    const [newAcl] = await tx.execute(sql`SELECT NOT EXISTS(SELECT 1 FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
      WHERE p.oid::text IN(${caps.waybill.functionOid},${caps.delivery.functionOid},${caps.promotion.functionOid}) AND a.grantee<>p.proowner) AS owner_only`);
    if (newAcl?.owner_only !== true) throw Error('New capability default grants are unreviewed');
    const preservation = preserved(before, await objects(tx), caps.waybill.ownerOid, caps.promotion.ownerOid, initial.promotionOwner.reuse);
    return { operation: MANAGER_CAPABILITY_BOOTSTRAP_OPERATION, applied: true as const, state, preservation,
      applicationAdminGrantsApplied: false as const, businessDataWrites: false as const, credentialsCreated: false as const };
  }, { isolationLevel: 'read committed', accessMode: 'read write' }); }
  catch { throw Error('Manager capability bootstrap outcome not confirmed; inspect the fixed catalogs before further action'); }
}
