import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { inspectRuntimeBusinessProfileInTransaction } from './auditRuntimeBusinessPrivileges';
import { ADMIN_WECHAT_ROUTINE_OPERATION_SQL, inspectAdminWechatRoutineOperation } from './adminWechatRoutineOperation';
import { ADMIN_WECHAT_ROUTINE_STORED_TEXT_SQL, ADMIN_WECHAT_ROUTINE_STORED_TEXT_SIGNATURE } from './adminWechatRoutineStoredText';
import { adminWechatRoutineWriteSql, ADMIN_WECHAT_ROUTINE_WRITE_SIGNATURE,
  type AdminWechatRoutineWriteBinding } from './adminWechatRoutineWriteCapability';
import { inspectAdminWechatRoutineWriteCatalog } from './adminWechatRoutineWriteCatalog';
import type { RoutinePaymentRuntimeTarget } from './routinePaymentRuntime';
import { captureRuntimeGiftPeerDeclarations, type RuntimeGiftPeerDeclarations } from './customerRuntimeGiftPeers';
import { captureRuntimeAppCashierOriginReader, type RuntimeAppCashierOriginReaderAddon } from './runtimeAppCashierOriginReader';

type Query = Pick<DbClient, 'execute'>;
export interface AdminWechatRoutineUpgradeTarget extends RoutinePaymentRuntimeTarget { writer: string }
export const ADMIN_WECHAT_ROUTINE_UPGRADE = 'admin-wechat-routine-author-v1';

/** A deployment-prepared, unused NOLOGIN is required. Creating a role, changing
 * its credentials or repairing prior grants is outside this forward protocol. */
async function emptyWriter(tx: Query, role: string): Promise<boolean> {
  const [row] = await tx.execute(sql`SELECT NOT(r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole
      OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity WHERE usesysid=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend WHERE refclassid='pg_catalog.pg_authid'::regclass
      AND refobjid=r.oid AND deptype='o')
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_database d WHERE pg_catalog.has_database_privilege(r.oid,d.oid,'CREATE'))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname NOT LIKE 'pg_%'
      AND pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE'))
    AND NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET,ALTER SYSTEM')
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND CASE
        WHEN c.relkind='S' THEN pg_catalog.has_sequence_privilege(r.oid,c.oid,'USAGE,SELECT,UPDATE')
        WHEN c.relkind IN('r','p','v','m','f') THEN pg_catalog.has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          OR pg_catalog.has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES') ELSE false END)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND p.prosecdef
        AND pg_catalog.has_function_privilege(r.oid,p.oid,'EXECUTE'))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_default_acl d CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a
      WHERE a.grantee=r.oid OR(a.grantee=0 AND d.defaclobjtype IN('r','S'))) AS ready
    FROM pg_catalog.pg_roles r WHERE r.rolname=${role}`);
  return row?.ready === true;
}

/** Capture before BEGIN can yield: a caller changing its own declarations
 * cannot redirect an already requested maintenance operation. */
function captureDeclaration(declaredTarget: AdminWechatRoutineUpgradeTarget,
  peers?: RuntimeGiftPeerDeclarations, appReader?: RuntimeAppCashierOriginReaderAddon) {
  const target: AdminWechatRoutineUpgradeTarget={database:declaredTarget.database,maintenance:declaredTarget.maintenance,
    app:declaredTarget.app,admin:declaredTarget.admin,writer:declaredTarget.writer,
    ...(declaredTarget.local ? {local:[...declaredTarget.local]} : {}),
    ...(declaredTarget.caseLock ? {caseLock:{owner:declaredTarget.caseLock.owner,runtimeRoles:[...declaredTarget.caseLock.runtimeRoles]}} : {})};
  const local=target.local??[];
  if (!Array.isArray(declaredTarget.local??[]) || local.length>16) throw Error('Explicit bounded Routine local identities required');
  const identities=[target.maintenance,target.app,target.admin,target.writer,...local];
  [...identities,target.database].forEach(pricingIdentifier);
  if (new Set(identities).size!==identities.length) throw Error('Distinct Routine maintenance, App, Admin, writer and local identities required');
  if (target.caseLock) {
    pricingIdentifier(target.caseLock.owner);
    if (!Array.isArray(declaredTarget.caseLock?.runtimeRoles) || !target.caseLock.runtimeRoles.length
      || target.caseLock.runtimeRoles.length>16 || identities.includes(target.caseLock.owner)
      || new Set(target.caseLock.runtimeRoles).size!==target.caseLock.runtimeRoles.length
      || target.caseLock.runtimeRoles.some(role=>!local.includes(role))) throw Error('Explicit local-only Routine case lock required');
  }
  peers=peers?captureRuntimeGiftPeerDeclarations(peers):undefined;
  appReader=appReader?captureRuntimeAppCashierOriginReader(appReader):undefined;
  const bindingNames=(value:RoutinePaymentRuntimeTarget)=>JSON.stringify([value.database,value.maintenance,value.app,value.admin,
    [...(value.local??[])].sort(),value.caseLock?[value.caseLock.owner,[...value.caseLock.runtimeRoles].sort()]:null]);
  if (peers && bindingNames(peers.target)!==bindingNames(target)) throw Error('Routine gift peers require the exact same declared runtime target');
  return {target,peers,appReader};
}

/** Explicit maintenance transaction only. Full existing App/Admin profiles,
 * fresh writer, DDL/ACL, exact joint catalog and both final profiles commit
 * together. No business rows, account ownership or credentials are rewritten.
 * A complete repeat is read-only; partial/drifted state is never repaired.
 */
export async function installAdminWechatRoutineUpgradeInTransaction(tx: Query, declaredTarget: AdminWechatRoutineUpgradeTarget,
  declaredPeers?: RuntimeGiftPeerDeclarations, declaredReader?: RuntimeAppCashierOriginReaderAddon) {
  if (Object.hasOwn(tx, '$client')) throw Error('Routine upgrade requires an existing maintenance transaction');
  const {target,peers,appReader}=captureDeclaration(declaredTarget,declaredPeers,declaredReader);
  await tx.execute(sql`SELECT set_config('search_path','public,pg_temp',true),set_config('statement_timeout','5000',true),
    set_config('lock_timeout','1000',true),set_config('idle_in_transaction_session_timeout','5000',true)`);
  const [context] = await tx.execute<{ ready: boolean; database_oid: string; admin_oid: string; writer_oid: string }>(sql`SELECT
    current_database()=${target.database} AND current_user=${target.maintenance} AND current_user=session_user
      AND current_schema()='public' AND current_setting('server_version_num')::integer/10000=16
      AND current_setting('transaction_isolation')='read committed' AND NOT current_setting('transaction_read_only')::boolean
      AND current_setting('session_replication_role')='origin'
      AND EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity a JOIN pg_catalog.pg_roles r ON r.oid=a.usesysid
        WHERE a.pid=pg_backend_pid() AND r.rolname=current_user AND r.rolsuper)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS ready,
    (SELECT oid::text FROM pg_catalog.pg_database WHERE datname=current_database()) AS database_oid,
    (SELECT oid::text FROM pg_catalog.pg_roles WHERE rolname=${target.admin}) AS admin_oid,
    (SELECT oid::text FROM pg_catalog.pg_roles WHERE rolname=${target.writer}) AS writer_oid`);
  if (context?.ready!==true) throw Error('Routine upgrade requires explicit PG16 owner/database maintenance');
  const [gate] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(731667,0)
    AND pg_try_advisory_xact_lock(731666,0) AS locked`);
  if (gate?.locked!==true) throw Error('Routine author commissioning or credentials are busy');
  await tx.execute(sql.raw('LOCK TABLE ONLY public.system_admin, ONLY public.system_role, ONLY public.system_config IN SHARE ROW EXCLUSIVE MODE NOWAIT'));
  const names={maintenance:target.maintenance,admin:target.admin,writer:target.writer};
  const before=await inspectAdminWechatRoutineWriteCatalog(tx,names);
  if (before.present && !before.ready) throw Error('Partial or drifted Routine author catalog requires review');
  if (before.present) await tx.execute(sql.raw('LOCK TABLE ONLY public.admin_wechat_routine_operation IN ACCESS EXCLUSIVE MODE NOWAIT'));
  const inspect = async () => ({
    app: await inspectRuntimeBusinessProfileInTransaction(tx,'app',target,'current',peers,appReader),
    admin: await inspectRuntimeBusinessProfileInTransaction(tx,'admin',target,'current',peers),
  });
  const prior=await inspect();
  if (!prior.app.ready || !prior.admin.ready) throw Error('Routine commissioning requires exact existing runtime profiles');
  if (before.ready) return {operation:ADMIN_WECHAT_ROUTINE_UPGRADE,applied:false as const,binding:before.binding!};
  if (!await emptyWriter(tx,target.writer)) throw Error('Routine writer requires a distinct unused restricted NOLOGIN role');
  const binding: AdminWechatRoutineWriteBinding={database:target.database,databaseOid:Number(context.database_oid),
    admin:target.admin,adminOid:Number(context.admin_oid),writer:target.writer,writerOid:Number(context.writer_oid)};
  // The builder validates all actual OIDs before any DDL or grant is issued.
  const capabilitySql=adminWechatRoutineWriteSql(binding);
  await tx.execute(sql.raw(ADMIN_WECHAT_ROUTINE_OPERATION_SQL));
  if (!await inspectAdminWechatRoutineOperation(tx)) throw Error('Routine initial owner-only receipt catalog verification failed');
  await tx.execute(sql.raw(ADMIN_WECHAT_ROUTINE_STORED_TEXT_SQL));
  await tx.execute(sql.raw(capabilitySql));
  const writer=pricingIdentifier(target.writer), admin=pricingIdentifier(target.admin);
  await tx.execute(sql.raw(`GRANT USAGE,CREATE ON SCHEMA public TO ${writer};
ALTER FUNCTION ${ADMIN_WECHAT_ROUTINE_WRITE_SIGNATURE} OWNER TO ${writer};
REVOKE CREATE ON SCHEMA public FROM ${writer};
GRANT SELECT,INSERT ON TABLE public.system_config,public.admin_wechat_routine_operation TO ${writer};
GRANT UPDATE(value) ON TABLE public.system_config TO ${writer};
GRANT USAGE ON SEQUENCE public.system_config_id_seq TO ${writer};
GRANT EXECUTE ON FUNCTION ${ADMIN_WECHAT_ROUTINE_STORED_TEXT_SIGNATURE} TO ${writer};
GRANT SELECT ON TABLE public.admin_wechat_routine_operation TO ${admin};
GRANT EXECUTE ON FUNCTION ${ADMIN_WECHAT_ROUTINE_WRITE_SIGNATURE} TO ${admin};`));
  const after=await inspectAdminWechatRoutineWriteCatalog(tx,names);
  if (!after.ready) throw Error('Routine installed catalog/ACL verification failed: '+after.failures.join(','));
  const commissioned=await inspect();
  if (!commissioned.app.ready || !commissioned.admin.ready) throw Error('Routine commissioned runtime profiles failed verification');
  return {operation:ADMIN_WECHAT_ROUTINE_UPGRADE,applied:true as const,binding};
}

export async function runAdminWechatRoutineUpgrade(db: DbClient, target: AdminWechatRoutineUpgradeTarget,
  peers?: RuntimeGiftPeerDeclarations, appReader?: RuntimeAppCashierOriginReaderAddon) {
  if (!Object.hasOwn(db,'$client') || !db.$client) throw Error('Routine upgrade requires a root maintenance connection');
  const captured=captureDeclaration(target,peers,appReader);
  return db.transaction(tx=>installAdminWechatRoutineUpgradeInTransaction(tx,captured.target,captured.peers,captured.appReader),
    {isolationLevel:'read committed',accessMode:'read write'});
}
