import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { MANAGER_RUNTIME_ROLE, managerRuntimeGrantSql } from './managerRuntimePrivilegePlan';
import { inspectManagerRuntimeCatalogPrerequisites, inspectManagerRuntimePrivileges } from './auditManagerRuntimePrivileges';

type Root = Pick<DbClient, 'transaction'> & Partial<Pick<DbClient, '$client'>>;
type Query = Pick<DbClient, 'execute'>;
export const MANAGER_PROVISION_OPERATION = 'provision-manager-runtime-v1';
export const MANAGER_PROVISION_TARGET = { database: 'postgres', maintenanceRole: 'postgres' } as const;
export const MANAGER_PROVISION_CONNECTION_LIMIT = 15;
export interface ManagerProvisionTarget { database: string; maintenanceRole: string }
const rootOnly = (db: Root) => { if (!Object.hasOwn(db, '$client') || !db.$client) throw Error('Manager provisioning requires a root connection'); };
const validateTarget = (target: ManagerProvisionTarget) => {
  for (const name of Object.values(target)) if (!/^[a-z_][a-z_0-9]{0,62}$/.test(name)) throw Error('Invalid explicit maintenance target');
};
async function identity(tx: Query, target: ManagerProvisionTarget) {
  const [row] = await tx.execute(sql`SELECT current_database() AS database,current_user AS role,session_user AS session,
    (SELECT r.rolname FROM pg_stat_activity a JOIN pg_roles r ON r.oid=a.usesysid WHERE a.pid=pg_backend_pid()) AS backend_role,
    current_database()=${target.database} AND current_user=${target.maintenanceRole} AND session_user=current_user
    AND current_setting('server_version_num')::integer/10000=16 AND current_setting('session_replication_role')='origin'
    AND EXISTS(SELECT 1 FROM pg_stat_activity a JOIN pg_roles r ON r.oid=a.usesysid WHERE a.pid=pg_backend_pid() AND r.rolname=current_user AND r.rolsuper)
    AND NOT EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') AS supported`);
  return row;
}
async function roleState(tx: Query) {
  const rows = await tx.execute(sql`SELECT rolname AS name,rolcanlogin AS login,rolconnlimit AS connection_limit,
    NOT(rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls) AS restricted,
    NOT EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid) AS no_memberships
    FROM pg_roles r WHERE rolname=${MANAGER_RUNTIME_ROLE}`);
  if (rows.length > 1) throw Error('Fixed Manager role identity ambiguous');
  return rows[0] ?? null;
}

/** Only metadata is read; missing fixed prerequisites never install themselves. */
export async function inspectManagerProvisionState(db: Root, target: ManagerProvisionTarget = MANAGER_PROVISION_TARGET) {
  rootOnly(db); validateTarget(target);
  return db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL statement_timeout='10s'`);
    const current = await identity(tx, target);
    if (current?.supported !== true) return { identity: current, ready: false, role: null, prerequisites: null, privileges: null };
    const prerequisites = await inspectManagerRuntimeCatalogPrerequisites(tx), role = await roleState(tx);
    const privileges = role ? await inspectManagerRuntimePrivileges(tx, { requireLogin: role.login === true }) : null;
    return { identity: current, prerequisites, role, privileges,
      ready: prerequisites.ready && role?.login === true && role.connection_limit === MANAGER_PROVISION_CONNECTION_LIMIT && privileges?.ready === true };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

/** Single atomic create-and-commission. Existing roles are never modified,
 * passwords are never rotated, and missing catalogs never get repaired.
 * Maintenance target options are for isolated native fixtures; the HTTP Worker
 * always supplies the fixed production target and fixed role name. */
export async function provisionManagerRuntime(db: Root, managerPassword: string, target: ManagerProvisionTarget = MANAGER_PROVISION_TARGET) {
  rootOnly(db); validateTarget(target);
  if (!/^[a-f0-9]{64}$/.test(managerPassword)) throw Error('A generated Manager credential is required');
  try {
    return await db.transaction(async tx => {
      await tx.execute(sql`SELECT set_config('statement_timeout','10000',true),set_config('lock_timeout','1500',true),
        set_config('idle_in_transaction_session_timeout','10000',true),set_config('password_encryption','scram-sha-256',true)`);
      const current = await identity(tx, target);
      const [lock] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(731812,1) AS locked`);
      if (current?.supported !== true || lock?.locked !== true || await roleState(tx)) throw Error('Fixed role collision or maintenance target refused');
      const prerequisites = await inspectManagerRuntimeCatalogPrerequisites(tx);
      if (!prerequisites.ready) throw Error('Fixed Manager prerequisite catalogs are not commissioned');
      await tx.execute(sql.raw(`CREATE ROLE "${MANAGER_RUNTIME_ROLE}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT ${MANAGER_PROVISION_CONNECTION_LIMIT}`));
      await tx.execute(sql`GRANT CONNECT ON DATABASE ${sql.identifier(target.database)} TO ${sql.identifier(MANAGER_RUNTIME_ROLE)}`);
      await tx.execute(sql`GRANT USAGE ON SCHEMA public TO ${sql.identifier(MANAGER_RUNTIME_ROLE)}`);
      for (const grant of managerRuntimeGrantSql(prerequisites.profile)) await tx.execute(sql.raw(grant));
      if (!(await inspectManagerRuntimePrivileges(tx, { requireLogin: false })).ready) throw Error('NOLOGIN Manager profile failed exact commissioning');
      // Constrained utility PASSWORD cannot be a bind parameter. The driver
      // cause is discarded below, and neither this statement nor its input logs.
      await tx.execute(sql.raw(`ALTER ROLE "${MANAGER_RUNTIME_ROLE}" PASSWORD '${managerPassword}' LOGIN`));
      const role = await roleState(tx), privileges = await inspectManagerRuntimePrivileges(tx, { requireLogin: true });
      if (!privileges.ready || role?.login !== true || role.connection_limit !== MANAGER_PROVISION_CONNECTION_LIMIT || role.restricted !== true || role.no_memberships !== true)
        throw Error('Final fixed Manager role profile differs');
      return { created: true as const, commissioned: true as const, role, privileges };
    }, { isolationLevel: 'read committed', accessMode: 'read write' });
  } catch { throw Error('Manager provisioning outcome not confirmed; inspect the fixed role before further action'); }
}
