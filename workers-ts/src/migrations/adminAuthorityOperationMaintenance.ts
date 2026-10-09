import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { ADMIN_AUTHORITY_OPERATION_SQL, inspectAdminAuthorityMenuLock,
  inspectAdminAuthorityOperation } from './adminAuthorityOperation';
import { auditRuntimeBusinessPrivileges, inspectRuntimeBusinessProfileInTransaction } from './auditRuntimeBusinessPrivileges';
import { installAdminAuthorityOperationUpgradeInTransaction } from './runAdminAuthorityOperationUpgrade';
import { ADMIN_LEGACY_ADMIN_OPERATION_UPGRADE_SQL,
  installAdminLegacyAdminOperationUpgradeInTransaction } from './runAdminLegacyAdminOperationUpgrade';
import { ADMIN_LEGACY_ROLE_OPERATION_UPGRADE_SQL,
  installAdminLegacyRoleOperationUpgradeInTransaction } from './runAdminLegacyRoleOperationUpgrade';
import type { SeckillScheduleRuntimeTarget } from './runSeckillScheduleRuntimeUpgrade';

export const ADMIN_AUTHORITY_MAINTENANCE_OPERATION = 'admin-authority-install-v1-and-legacy-v2-and-legacy-role-v3';
export const ADMIN_AUTHORITY_MAINTENANCE_TARGET_CATALOG = 'legacy-role-v3';
export type AdminAuthorityMaintenanceTarget = SeckillScheduleRuntimeTarget;
type Query = Pick<DbClient, 'execute'>;
type Root = Pick<DbClient, 'transaction'> & Partial<Pick<DbClient, '$client'>>;
export type AdminAuthorityRuntimeEvidence = Awaited<ReturnType<typeof auditRuntimeBusinessPrivileges>> & {
  identity: { database: string; role: string; session: string; backend: string; supported: boolean };
};
export const ADMIN_AUTHORITY_PRODUCTION_TARGET: AdminAuthorityMaintenanceTarget = Object.freeze({
  database: 'postgres', maintenance: 'postgres', app: 'cinashop_app_v1', admin: 'cinashop_admin_v1',
});
/** Reviewed control-plane intent, not a claim of runtime Cloudflare identity.
 * Actual database identities and profiles are independently checked below. */
export const ADMIN_AUTHORITY_PRODUCTION_DEPLOYMENT_SCOPE = Object.freeze({
  accountId: '7ea8e46d8210bad342fa7595f7935fea',
  hyperdriveBindings: Object.freeze({
    HYPERDRIVE_MAINTENANCE: '9748c294e21c49a99579c9cef70102e0',
    HYPERDRIVE: 'ba7faa6680cd48d4b3a1d36a7a5fc8f7',
    HYPERDRIVE_ADMIN: '446e94a4de0143f58c8e5178ec55db8b',
  }),
});

/** The original v1 grants remain exact. Historical grants are never repaired. */
export const ADMIN_AUTHORITY_MAINTENANCE_GRANTS_SQL = `GRANT SELECT,INSERT ON TABLE public.admin_authority_operation TO "cinashop_admin_v1";
GRANT EXECUTE ON FUNCTION public.admin_authority_menu_lock_v1() TO "cinashop_admin_v1";`;
export const ADMIN_AUTHORITY_MAINTENANCE_V3_GRANT_SQL = 'GRANT DELETE ON TABLE public.system_role TO "cinashop_admin_v1";';
export const ADMIN_AUTHORITY_MAINTENANCE_SQL = [ADMIN_AUTHORITY_OPERATION_SQL,
  ADMIN_AUTHORITY_MAINTENANCE_GRANTS_SQL, ADMIN_LEGACY_ADMIN_OPERATION_UPGRADE_SQL,
  ADMIN_LEGACY_ROLE_OPERATION_UPGRADE_SQL, ADMIN_AUTHORITY_MAINTENANCE_V3_GRANT_SQL].join('\n');

export async function adminAuthorityEvidenceSha256(value: unknown): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function adminAuthorityInstallSqlSha256(target: AdminAuthorityMaintenanceTarget = ADMIN_AUTHORITY_PRODUCTION_TARGET): Promise<string> {
  assertTarget(target);
  const grants = `GRANT SELECT,INSERT ON TABLE public.admin_authority_operation TO ${pricingIdentifier(target.admin)};\nGRANT EXECUTE ON FUNCTION public.admin_authority_menu_lock_v1() TO ${pricingIdentifier(target.admin)};`;
  const roleDeleteGrant = `GRANT DELETE ON TABLE public.system_role TO ${pricingIdentifier(target.admin)};`;
  const installation = [ADMIN_AUTHORITY_OPERATION_SQL, grants, ADMIN_LEGACY_ADMIN_OPERATION_UPGRADE_SQL,
    ADMIN_LEGACY_ROLE_OPERATION_UPGRADE_SQL, roleDeleteGrant].join('\n');
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(installation)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
function assertTarget(target: AdminAuthorityMaintenanceTarget) {
  Object.values(target).forEach(pricingIdentifier);
  if (new Set([target.maintenance, target.app, target.admin]).size !== 3) throw Error('Distinct maintenance/app/Admin identities required');
}
function assertRoot(db: Root) {
  if (!Object.hasOwn(db, '$client') || !db.$client) throw Error('Actual root connection required');
}
async function timeouts(tx: Query) {
  await tx.execute(sql`SELECT set_config('search_path','public,pg_temp',true),
    set_config('statement_timeout','5000',true),set_config('lock_timeout','1000',true),
    set_config('idle_in_transaction_session_timeout','5000',true)`);
}
/** Names originate only from the actual public catalog, never an HTTP argument. */
function quotedCatalogIdentifier(value: string) {
  if (!value || value.includes('\0') || new TextEncoder().encode(value).byteLength > 63) throw Error('Unsupported public catalog identifier');
  return '"' + value.replace(/"/g, '""') + '"';
}

/** No raw rows or function bodies leave PostgreSQL. The count is discovered,
 * including independent addons. Timeouts and census limits fail closed. */
export async function inspectAdminAuthorityMaintenanceSnapshot(tx: Query, options: { wholeData?: boolean } = {}) {
  const tables = Array.from(await tx.execute<{ name: string; ordinary: boolean }>(sql`SELECT relname AS name,
    relkind='r' AND relpersistence='p' AND NOT relispartition AND NOT relrowsecurity
      AND NOT relforcerowsecurity AND NOT EXISTS(SELECT 1 FROM pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid) AS ordinary
    FROM pg_class c WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p','f')
    ORDER BY relname COLLATE "C" LIMIT 2049`));
  if (tables.length > 2048 || tables.some(table => !table.ordinary)) throw Error('Unsupported or oversized public table census');
  const data: { name: string; rows: string; sha256: string }[] = [];
  const protectedTables = new Set(['system_admin', 'system_role', 'system_menus', 'admin_authority_operation']);
  // The HTTP gate hashes only data protected by the existing authority locks.
  // Whole-shop data is optional local evidence and is never an approval gate.
  for (const table of tables.filter(table => options.wholeData || protectedTables.has(table.name))) {
    const name = quotedCatalogIdentifier(table.name);
    // Sorted row-hash buckets retain multiplicity without returning rows and
    // avoid assembling the entire shop into one string. LIMIT is a fail-closed
    // bound, not a sample: one million rows per table are supported.
    const [row] = await tx.execute<{ rows: string; sha256: string }>(sql.raw(`WITH hashes AS MATERIALIZED (
      SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS hash
      FROM ONLY public.${name} t LIMIT 1000001
    ), buckets AS (
      SELECT left(hash,2) AS bucket,count(*)::text AS rows,
        encode(sha256(convert_to(string_agg(hash,'' ORDER BY hash COLLATE "C"),'UTF8')),'hex') AS digest
      FROM hashes GROUP BY left(hash,2)
    ) SELECT coalesce(sum(rows::bigint),0)::text AS rows,
      encode(sha256(convert_to(coalesce(string_agg(bucket||':'||rows||':'||digest,'|' ORDER BY bucket COLLATE "C"),''),'UTF8')),'hex') AS sha256
      FROM buckets`));
    if (!row || !/^\d+$/.test(row.rows) || BigInt(row.rows) > 1_000_000n || !/^[0-9a-f]{64}$/.test(row.sha256)) throw Error('Incomplete public table data digest');
    data.push({ name: table.name, rows: row.rows, sha256: row.sha256 });
  }
  const [catalog] = await tx.execute<{ sha256: string; objects: number }>(sql`WITH objects AS (
    SELECT 'relation' AS kind,c.oid::text AS id,jsonb_build_array(c.relname,c.relkind::text,c.relpersistence::text,
      c.relowner,c.relacl,c.reloptions,c.relrowsecurity,c.relforcerowsecurity,c.relreplident::text,c.relam,c.relispartition) AS value
      FROM pg_class c WHERE c.relnamespace='public'::regnamespace
    UNION ALL SELECT 'column',a.attrelid::text||'.'||a.attnum,to_jsonb(a)
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid WHERE c.relnamespace='public'::regnamespace AND a.attnum>0
    UNION ALL SELECT 'default',d.oid::text,to_jsonb(d) FROM pg_attrdef d JOIN pg_class c ON c.oid=d.adrelid WHERE c.relnamespace='public'::regnamespace
    UNION ALL SELECT 'constraint',oid::text,to_jsonb(c)||jsonb_build_object('definition',pg_get_constraintdef(oid,false)) FROM pg_constraint c WHERE connamespace='public'::regnamespace
    UNION ALL SELECT 'index',i.indexrelid::text,to_jsonb(i)||jsonb_build_object('definition',pg_get_indexdef(i.indexrelid)) FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid WHERE c.relnamespace='public'::regnamespace
    UNION ALL SELECT 'sequence',s.seqrelid::text,to_jsonb(s) FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid WHERE c.relnamespace='public'::regnamespace
    UNION ALL SELECT 'function',oid::text,to_jsonb(p) FROM pg_proc p WHERE pronamespace='public'::regnamespace
    UNION ALL SELECT 'trigger',t.oid::text,to_jsonb(t) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace
    UNION ALL SELECT 'rewrite',r.oid::text,to_jsonb(r) FROM pg_rewrite r JOIN pg_class c ON c.oid=r.ev_class WHERE c.relnamespace='public'::regnamespace
    UNION ALL SELECT 'policy',p.oid::text,to_jsonb(p) FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid WHERE c.relnamespace='public'::regnamespace
    UNION ALL SELECT 'namespace',oid::text,to_jsonb(n) FROM pg_namespace n WHERE nspname !~ '^pg_'
    UNION ALL SELECT 'role',oid::text,to_jsonb(r) FROM pg_roles r
    UNION ALL SELECT 'membership',roleid::text||'.'||member,to_jsonb(m) FROM pg_auth_members m
    UNION ALL SELECT 'default-acl',oid::text,to_jsonb(d) FROM pg_default_acl d
    UNION ALL SELECT 'database',oid::text,jsonb_build_array(datname,datdba,datacl,datallowconn) FROM pg_database WHERE datname=current_database()
  ) SELECT count(*)::integer AS objects,
    encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_array(kind,id,value) ORDER BY kind COLLATE "C",id COLLATE "C")::text,'[]'),'UTF8')),'hex') AS sha256 FROM objects`);
  if (!catalog || !/^[0-9a-f]{64}$/.test(catalog.sha256)) throw Error('Incomplete catalog digest');
  return { tableCount: tables.length, catalog, data, dataSha256: await adminAuthorityEvidenceSha256(data),
    dataScope: options.wholeData ? 'whole-shop-observation' as const : 'protected-authority' as const,
    observation: 'repeatable-read pre/postflight; read-committed apply; only staff/menu/receipt are fenced; no whole-shop write fence' as const };
}

async function inspectInTransaction(tx: Query, target: AdminAuthorityMaintenanceTarget, write: boolean) {
  const [identity] = await tx.execute<{ database: string; role: string; session: string; backend: string; supported: boolean; tablePresent: boolean; cleanAbsent: boolean }>(sql`SELECT
    current_database() AS database,current_user AS role,session_user AS session,
    (SELECT r.rolname FROM pg_stat_activity a JOIN pg_roles r ON r.oid=a.usesysid WHERE a.pid=pg_backend_pid()) AS backend,
    current_database()=${target.database} AND current_user=${target.maintenance} AND current_user=session_user
    AND current_setting('server_version_num')::integer/10000=16 AND current_setting('session_replication_role')='origin'
    AND current_setting('transaction_read_only')=${write ? 'off' : 'on'}
    AND current_setting('transaction_isolation')=${write ? 'read committed' : 'repeatable read'}
    AND EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper AND rolcanlogin)
    AND EXISTS(SELECT 1 FROM pg_database WHERE datname=current_database() AND datdba=(SELECT oid FROM pg_roles WHERE rolname=current_user))
    AND has_schema_privilege(current_user,'public','CREATE')
    AND NOT EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D')
    AND NOT EXISTS(SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
      WHERE d.defaclrole=(SELECT oid FROM pg_roles WHERE rolname=current_user)
      AND (d.defaclnamespace=0 OR d.defaclnamespace='public'::regnamespace)
      AND d.defaclobjtype IN ('r','f','S') AND a.grantee<>d.defaclrole) AS supported,
    to_regclass('public.admin_authority_operation') IS NOT NULL AS "tablePresent",
    NOT EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace
      AND proname IN ('admin_authority_operation_immutable_v1','admin_authority_menu_lock_v1'))
    AND NOT EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace
      AND (relname LIKE 'admin_authority_operation%' OR left(relname,4)='aao_'))
    AND NOT EXISTS(SELECT 1 FROM pg_constraint WHERE connamespace='public'::regnamespace AND left(conname,4)='aao_') AS "cleanAbsent"`);
  if (!identity) throw Error('Maintenance identity inspection returned no row');
  const names = { maintenance: target.maintenance, admin: target.admin };
  const addon = identity.tablePresent
    ? await inspectAdminAuthorityOperation(tx, names, 'legacy-role-v3') ? 'legacy-role-v3'
      : await inspectAdminAuthorityOperation(tx, names, 'legacy-admin-v2') ? 'legacy-admin-v2'
      : await inspectAdminAuthorityOperation(tx, names, 'v1') ? 'v1' : 'drift'
    : identity.cleanAbsent ? 'absent' : 'orphan';
  const menuLock = !identity.tablePresent ? addon === 'absent' : await inspectAdminAuthorityMenuLock(tx, names);
  const profiles = { app: await inspectRuntimeBusinessProfileInTransaction(tx, 'app', target, 'current'),
    admin: await inspectRuntimeBusinessProfileInTransaction(tx, 'admin', target, 'current') };
  const snapshot = await inspectAdminAuthorityMaintenanceSnapshot(tx);
  return { ready: identity.supported === true && identity.backend === target.maintenance
      && !['drift', 'orphan'].includes(addon) && menuLock && profiles.app.ready && profiles.admin.ready,
    // Isolation/readOnly mode is validated above but omitted from reusable fingerprints.
    identity: { database: identity.database, role: identity.role, session: identity.session, backend: identity.backend },
    addon, menuLock, profiles, snapshot };
}

export async function inspectAdminAuthorityMaintenance(db: Root, target: AdminAuthorityMaintenanceTarget) {
  assertTarget(target); assertRoot(db);
  return db.transaction(async tx => { await timeouts(tx); return inspectInTransaction(tx, target, false); },
    { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
export async function inspectAdminAuthorityRuntimeLogin(db: DbClient, target: AdminAuthorityMaintenanceTarget, kind: 'app' | 'admin'): Promise<AdminAuthorityRuntimeEvidence> {
  assertTarget(target); assertRoot(db);
  const identity = await db.transaction(async tx => {
    await timeouts(tx);
    const [row] = await tx.execute<AdminAuthorityRuntimeEvidence['identity']>(sql`SELECT
      current_database() AS database,current_user AS role,session_user AS session,
      (SELECT r.rolname FROM pg_stat_activity a JOIN pg_roles r ON r.oid=a.usesysid WHERE a.pid=pg_backend_pid()) AS backend,
      current_database()=${target.database} AND current_user=${target[kind]} AND session_user=current_user
      AND current_setting('server_version_num')::integer/10000=16 AND current_setting('transaction_read_only')='on'
      AND current_setting('transaction_isolation')='repeatable read' AND current_setting('session_replication_role')='origin' AS supported`);
    if (!row) throw Error('Runtime LOGIN context returned no row');
    return row;
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  const profile = await auditRuntimeBusinessPrivileges(db, kind, target);
  return { ...profile, identity, ready: profile.ready && identity.supported === true && identity.backend === target[kind] };
}
export function adminAuthorityPreflightEvidence(sourceSha: string, installSqlSha256: string,
  target: AdminAuthorityMaintenanceTarget, maintenance: Awaited<ReturnType<typeof inspectAdminAuthorityMaintenance>>,
  app: AdminAuthorityRuntimeEvidence, admin: AdminAuthorityRuntimeEvidence) {
  return { operation: ADMIN_AUTHORITY_MAINTENANCE_OPERATION,
    targetCatalog: ADMIN_AUTHORITY_MAINTENANCE_TARGET_CATALOG,
    deploymentScope: ADMIN_AUTHORITY_PRODUCTION_DEPLOYMENT_SCOPE,
    sourceSha, installSqlSha256, target, maintenance, app, admin };
}
export class AdminAuthorityPreflightMismatch extends Error {
  constructor() { super('Current locked preflight differs from approved evidence'); }
}

/** One real RC owner transaction; never retries. Independent LOGIN reports
 * originate from fresh preceding connections, while the full profiles and
 * owner/catalog/data evidence are checked again inside the locked transaction.
 * Ordinary business writes are not fenced and are excluded from approval. */
export async function applyAdminAuthorityMaintenance(db: Root, target: AdminAuthorityMaintenanceTarget,
  approval: { sourceSha: string; installSqlSha256: string; fingerprint: string;
    app: AdminAuthorityRuntimeEvidence; admin: AdminAuthorityRuntimeEvidence }) {
  assertTarget(target); assertRoot(db);
  if (!/^[0-9a-f]{40}$/.test(approval.sourceSha) || !/^[0-9a-f]{64}$/.test(approval.fingerprint)
    || approval.fingerprint === '0'.repeat(64) || !approval.app.ready || !approval.admin.ready
    || approval.installSqlSha256 !== await adminAuthorityInstallSqlSha256(target)) throw new AdminAuthorityPreflightMismatch();
  return db.transaction(async tx => {
    await timeouts(tx);
    const [lock] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(731626,8) AS locked`);
    if (lock?.locked !== true) throw Error('Authority maintenance is busy');
    await tx.execute(sql.raw('LOCK TABLE ONLY public.system_admin, ONLY public.system_role IN SHARE ROW EXCLUSIVE MODE NOWAIT'));
    await tx.execute(sql.raw('LOCK TABLE ONLY public.system_menus IN SHARE MODE NOWAIT'));
    const [present] = await tx.execute(sql`SELECT to_regclass('public.admin_authority_operation') IS NOT NULL AS present`);
    if (present?.present === true) await tx.execute(sql.raw('LOCK TABLE ONLY public.admin_authority_operation IN ACCESS EXCLUSIVE MODE NOWAIT'));
    const before = await inspectInTransaction(tx, target, true);
    const fingerprint = await adminAuthorityEvidenceSha256(adminAuthorityPreflightEvidence(approval.sourceSha,
      approval.installSqlSha256, target, before, approval.app, approval.admin));
    if (!before.ready || fingerprint !== approval.fingerprint) throw new AdminAuthorityPreflightMismatch();
    // Only missing stages run. In particular, the v2 installer must never be
    // called on v3: it intentionally rejects that catalog rather than repairing it.
    const v1 = before.addon === 'absent'
      ? await installAdminAuthorityOperationUpgradeInTransaction(tx, target) : null;
    const v2 = before.addon === 'absent' || before.addon === 'v1'
      ? await installAdminLegacyAdminOperationUpgradeInTransaction(tx, target) : null;
    const v3 = await installAdminLegacyRoleOperationUpgradeInTransaction(tx, target);
    const after = await inspectInTransaction(tx, target, true);
    if (!after.ready || after.addon !== ADMIN_AUTHORITY_MAINTENANCE_TARGET_CATALOG) throw Error('Authority maintenance final profile/catalog verification failed');
    const protectedDataObservationUnchanged = before.snapshot.data
      .every(row => after.snapshot.data.some(next => next.name === row.name && next.rows === row.rows && next.sha256 === row.sha256));
    if (!protectedDataObservationUnchanged) throw Error('Authority maintenance changed protected data');
    return { operation: ADMIN_AUTHORITY_MAINTENANCE_OPERATION,
      targetCatalog: ADMIN_AUTHORITY_MAINTENANCE_TARGET_CATALOG,
      fromCatalog: before.addon, toCatalog: after.addon, committed: true, v1, v2, v3,
      approvedPreflightFingerprint: fingerprint, before: before.snapshot, after: after.snapshot,
      protectedDataObservationUnchanged,
      atomicBusinessDataProof: false };
  }, { isolationLevel: 'read committed', accessMode: 'read write' });
}
