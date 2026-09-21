import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';

export const PRODUCTION_RUNTIME_ROLES = {
  app: 'cinashop_app_v1', admin: 'cinashop_admin_v1', pricingOwner: 'cinashop_pricing_owner_v1',
} as const;
export interface RuntimeRoleNames { app: string; admin: string; pricingOwner: string }
type Root = Pick<DbClient, 'transaction'> & Partial<Pick<DbClient, '$client'>>;
type Query = Pick<DbClient, 'execute'>;
const identifier = (name: string) => {
  if (!/^cinashop_[a-z0-9_]{1,54}$/.test(name)) throw Error('Invalid dedicated runtime role');
  return '"' + name + '"';
};
const validate = (names: RuntimeRoleNames) => {
  const values = Object.values(names);
  if (values.length !== 3 || new Set(values).size !== 3) throw Error('Three distinct runtime roles required');
  values.forEach(identifier);
};

async function inspect(tx: Query, names: RuntimeRoleNames) {
  const rows = await tx.execute(sql`SELECT r.rolname AS name, r.rolcanlogin AS login,
    NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls) AS restricted,
    NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid) AS no_memberships,
    NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=r.oid AND deptype='o') AS no_ownership,
    NOT pg_catalog.has_schema_privilege(r.oid,'public','CREATE')
      AND NOT pg_catalog.has_database_privilege(r.oid,current_database(),'CREATE') AS no_ddl,
    NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET,ALTER SYSTEM') AS no_replication_bypass,
    NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN('r','p','v','m','f')
        AND (pg_catalog.has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          OR pg_catalog.has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))) AS no_business_grants,
    NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND CASE WHEN c.relkind='S'
        THEN pg_catalog.has_sequence_privilege(r.oid,c.oid,'SELECT,USAGE,UPDATE') ELSE false END) AS no_sequence_grants
    FROM pg_catalog.pg_roles r WHERE r.rolname IN (${names.app},${names.admin},${names.pricingOwner}) ORDER BY r.rolname`);
  return Array.from(rows);
}

export async function inspectUncommissionedRuntimeRoles(db: Root, names: RuntimeRoleNames = PRODUCTION_RUNTIME_ROLES) {
  validate(names);
  if (!Object.hasOwn(db, '$client') || !db.$client) throw Error('Role inspection requires a root connection');
  return db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
    const [identity] = await tx.execute(sql`SELECT current_database() AS database, current_user AS role, session_user AS session,
      (SELECT r.rolname FROM pg_catalog.pg_stat_activity a JOIN pg_catalog.pg_roles r ON r.oid=a.usesysid WHERE a.pid=pg_backend_pid()) AS backend_role`);
    return { identity, roles: await inspect(tx, names), commissioned: false as const };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

/** Provisioning ONLY: no application table/function/sequence grants, catalog
 * installation, ownership transfer, existing-role modification or cutover.
 * Collision (including a prior success) refuses atomically. Unknown outcomes
 * require read-only inspection, never automatic password rotation/retry.
 * Passwords are 256-bit random hex supplied through a private secret channel. */
export async function provisionRuntimeRoles(db: Root, options: {
  expectedDatabase: string; expectedMaintenanceRole: string; names: RuntimeRoleNames;
  appPassword: string; adminPassword: string;
}) {
  if (!Object.hasOwn(db, '$client') || !db.$client) throw Error('Role provisioning requires a root connection');
  validate(options.names);
  if (!/^[a-f0-9]{64}$/.test(options.appPassword) || !/^[a-f0-9]{64}$/.test(options.adminPassword)
    || options.appPassword === options.adminPassword) throw Error('Distinct generated credentials required');
  // Never surface a driver error or nested query containing password literals.
  try {
    return await db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_catalog.set_config('statement_timeout','5000',true),
        pg_catalog.set_config('lock_timeout','1000',true), pg_catalog.set_config('idle_in_transaction_session_timeout','5000',true),
        pg_catalog.set_config('password_encryption','scram-sha-256',true)`);
      const [target] = await tx.execute(sql`SELECT current_database()=${options.expectedDatabase}
        AND current_user=${options.expectedMaintenanceRole} AND session_user=current_user
        AND current_setting('server_version_num')::integer/10000=16 AND current_setting('session_replication_role')='origin'
        AND EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity a JOIN pg_catalog.pg_roles r ON r.oid=a.usesysid
          WHERE a.pid=pg_backend_pid() AND r.rolname=current_user AND r.rolsuper)
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS supported,
        pg_catalog.pg_try_advisory_xact_lock(731625,1) AS locked`);
      if (target?.supported !== true || target.locked !== true || (await inspect(tx, options.names)).length)
        throw Error('Target, role collision or commissioning lock refused');
      const attributes = 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
      // Identifiers and credentials are constrained above; PostgreSQL utility
      // CREATE ROLE cannot use bind parameters for PASSWORD. Never log this SQL.
      await tx.execute(sql.raw(`CREATE ROLE ${identifier(options.names.app)} LOGIN ${attributes} CONNECTION LIMIT 40 PASSWORD '${options.appPassword}'`));
      await tx.execute(sql.raw(`CREATE ROLE ${identifier(options.names.admin)} LOGIN ${attributes} CONNECTION LIMIT 15 PASSWORD '${options.adminPassword}'`));
      await tx.execute(sql.raw(`CREATE ROLE ${identifier(options.names.pricingOwner)} NOLOGIN ${attributes}`));
      await tx.execute(sql`GRANT CONNECT ON DATABASE ${sql.identifier(options.expectedDatabase)} TO ${sql.identifier(options.names.app)},${sql.identifier(options.names.admin)}`);
      await tx.execute(sql.raw(`GRANT USAGE ON SCHEMA public TO ${identifier(options.names.app)},${identifier(options.names.admin)}`));
      const rows = await inspect(tx, options.names);
      if (rows.length !== 3 || rows.some(row => row.login !== (row.name !== options.names.pricingOwner)
        || ['restricted','no_memberships','no_ownership','no_ddl','no_replication_bypass','no_business_grants','no_sequence_grants'].some(key => row[key] !== true)))
        throw Error('New role authority differs from the uncommissioned envelope');
      return { created: true as const, roles: rows, commissioned: false as const };
    }, { isolationLevel: 'read committed', accessMode: 'read write' });
  } catch { throw Error('Role provisioning outcome not confirmed; inspect the fixed roles before any further action'); }
}
