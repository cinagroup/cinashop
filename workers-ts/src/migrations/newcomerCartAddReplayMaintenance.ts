import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { pricingIdentifier } from '@/migrations/checkoutPricingLockCatalog';
import { NEWCOMER_CART_ADD_REPLAY_INSTALLATION_SQL } from '@/migrations/newcomerCartAddReplay';
import {
  inspectNewcomerCartAddReplayCatalog, installNewcomerCartAddReplay,
} from '@/migrations/runNewcomerCartAddReplay';

export const NEWCOMER_CART_REPLAY_MAINTENANCE_OPERATION = 'newcomer-cart-replay-install-v1';

export interface NewcomerCartReplayMaintenanceTarget {
  database: string;
  maintenance: string;
  app: string;
  admin: string;
}

type Query = Pick<DbClient, 'execute'>;
type Root = Pick<DbClient, 'transaction'> & Partial<Pick<DbClient, '$client'>>;

function assertTarget(target: NewcomerCartReplayMaintenanceTarget): void {
  for (const value of Object.values(target)) pricingIdentifier(value);
  if (new Set([target.maintenance, target.app, target.admin]).size !== 3) {
    throw Error('Newcomer replay maintenance identities must be distinct');
  }
}

export async function newcomerCartReplayInstallSqlSha256(): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(NEWCOMER_CART_ADD_REPLAY_INSTALLATION_SQL)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function newcomerCartReplayEvidenceSha256(evidence: unknown): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(JSON.stringify(evidence))));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function setReadTimeouts(tx: Query): Promise<void> {
  await tx.execute(sql`SELECT
    pg_catalog.set_config('statement_timeout','5000',true),
    pg_catalog.set_config('lock_timeout','1000',true),
    pg_catalog.set_config('idle_in_transaction_session_timeout','5000',true),
    pg_catalog.set_config('search_path','public,pg_temp',true)`);
}

type RootRow = {
  database: string; role: string; session: string; backend: string | null;
  pg16: boolean; readOnly: boolean; replicationOrigin: boolean;
  databaseOwner: boolean; schemaCreate: boolean; maintenanceLogin: boolean;
  storeCartSafe: boolean; receiptAbsent: boolean; indexAbsent: boolean;
  enabledEventTriggers: number; relevantDefaultAcls: number;
};

async function inspectRoot(tx: Query, target: NewcomerCartReplayMaintenanceTarget): Promise<RootRow> {
  const [row] = await tx.execute<RootRow>(sql`SELECT
    current_database() AS database, current_user AS role, session_user AS session,
    (SELECT r.rolname FROM pg_catalog.pg_stat_activity a
      JOIN pg_catalog.pg_roles r ON r.oid=a.usesysid WHERE a.pid=pg_backend_pid()) AS backend,
    current_setting('server_version_num')::integer/10000=16 AS pg16,
    current_setting('transaction_read_only')='on' AS "readOnly",
    current_setting('session_replication_role')='origin' AS "replicationOrigin",
    (SELECT d.datdba=r.oid FROM pg_catalog.pg_database d
      JOIN pg_catalog.pg_roles r ON r.rolname=${target.maintenance}
      WHERE d.datname=current_database()) AS "databaseOwner",
    pg_catalog.has_schema_privilege(current_user,'public','CREATE') AS "schemaCreate",
    (SELECT r.rolcanlogin FROM pg_catalog.pg_roles r WHERE r.rolname=${target.maintenance}) AS "maintenanceLogin",
    COALESCE((SELECT c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition
      AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
      FROM pg_catalog.pg_class c WHERE c.oid=to_regclass('public.store_cart')),false) AS "storeCartSafe",
    to_regclass('public.newcomer_cart_add_replay') IS NULL AS "receiptAbsent",
    to_regclass('public.ncar_cart_uq') IS NULL AS "indexAbsent",
    (SELECT count(*)::integer FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS "enabledEventTriggers",
    (SELECT count(*)::integer FROM pg_catalog.pg_default_acl a
      JOIN pg_catalog.pg_roles r ON r.oid=a.defaclrole AND r.rolname=${target.maintenance}
      WHERE a.defaclobjtype='r'
        AND (a.defaclnamespace=0 OR a.defaclnamespace='public'::regnamespace)) AS "relevantDefaultAcls"`);
  if (!row) throw Error('Newcomer replay maintenance root inspection returned no row');
  return row;
}

type NamedRoleRow = {
  name: string; login: boolean; restricted: boolean; noMemberships: boolean;
  noOwnership: boolean; noDdl: boolean; noReplicationBypass: boolean;
  schemaUsage: boolean;
};

async function inspectNamedRoles(tx: Query, target: NewcomerCartReplayMaintenanceTarget) {
  const rows = await tx.execute<NamedRoleRow>(sql`SELECT r.rolname AS name,
    r.rolcanlogin AS login,
    NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit
      OR r.rolreplication OR r.rolbypassrls) AS restricted,
    NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m
      WHERE m.member=r.oid OR m.roleid=r.oid) AS "noMemberships",
    NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend d
      WHERE d.refclassid='pg_catalog.pg_authid'::regclass
        AND d.refobjid=r.oid AND d.deptype='o') AS "noOwnership",
    NOT pg_catalog.has_database_privilege(r.oid,current_database(),'CREATE')
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n
        WHERE n.nspname !~ '^pg_'
          AND pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE')) AS "noDdl",
    NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET,ALTER SYSTEM')
      AS "noReplicationBypass",
    pg_catalog.has_schema_privilege(r.oid,'public','USAGE') AS "schemaUsage"
    FROM pg_catalog.pg_roles r WHERE r.rolname=${target.app} OR r.rolname=${target.admin}
    ORDER BY r.rolname`);
  return rows.map(row => ({ ...row, safe: row.login && row.restricted && row.noMemberships
    && row.noOwnership && row.noDdl && row.noReplicationBypass && row.schemaUsage }));
}

function rootReady(row: RootRow, target: NewcomerCartReplayMaintenanceTarget, readOnly: boolean) {
  return row.database === target.database && row.role === target.maintenance
    && row.session === target.maintenance && row.backend === target.maintenance
    && row.pg16 && row.readOnly === readOnly && row.replicationOrigin
    && row.databaseOwner && row.schemaCreate && row.maintenanceLogin
    && row.storeCartSafe && row.receiptAbsent && row.indexAbsent
    && row.enabledEventTriggers === 0 && row.relevantDefaultAcls === 0;
}

async function inspectBeforeCreate(tx: Query, target: NewcomerCartReplayMaintenanceTarget,
  readOnly: boolean) {
  const root = await inspectRoot(tx, target);
  const roles = await inspectNamedRoles(tx, target);
  const ready = rootReady(root, target, readOnly) && roles.length === 2
    && roles.every(role => role.safe)
    && roles.some(role => role.name === target.app)
    && roles.some(role => role.name === target.admin);
  return { ready, root, roles };
}

/** Read-only root authority and fresh-object preflight. No business rows are read. */
export async function inspectNewcomerCartReplayMaintenance(db: Root,
  target: NewcomerCartReplayMaintenanceTarget) {
  assertTarget(target);
  if (!Object.hasOwn(db, '$client') || !db.$client) throw Error('Root maintenance connection required');
  return db.transaction(async tx => {
    await setReadTimeouts(tx);
    return inspectBeforeCreate(tx, target, true);
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

/** Exactly one fresh-table transaction. Guard rechecks identity and drift inside
 * the install transaction before DDL/GRANT. A lost response is UNKNOWN: callers
 * must independently inspect, never invoke this function again automatically. */
export async function applyNewcomerCartReplayMaintenance(db: Root,
  target: NewcomerCartReplayMaintenanceTarget) {
  assertTarget(target);
  if (!Object.hasOwn(db, '$client') || !db.$client) throw Error('Root maintenance connection required');
  await installNewcomerCartAddReplay(db, target.app, async tx => {
    await setReadTimeouts(tx);
    const preflight = await inspectBeforeCreate(tx, target, false);
    if (!preflight.ready) throw Error('Newcomer replay maintenance transaction authority or catalog drift');
  });
  return { operation: NEWCOMER_CART_REPLAY_MAINTENANCE_OPERATION, committed: true };
}

/** Independent root connection, read-only after installation. */
export async function inspectNewcomerCartReplayPostflight(db: Root,
  target: NewcomerCartReplayMaintenanceTarget) {
  assertTarget(target);
  if (!Object.hasOwn(db, '$client') || !db.$client) throw Error('Root maintenance connection required');
  return db.transaction(async tx => {
    await setReadTimeouts(tx);
    const root = await inspectRoot(tx, target);
    const roles = await inspectNamedRoles(tx, target);
    const catalog = await inspectNewcomerCartAddReplayCatalog(tx);
    if (!catalog.complete) return { ready: false, root, roles, catalog, acl: null, rows: null };
    const [acl] = await tx.execute<{
      owner: boolean; exactGrants: boolean; noColumnGrants: boolean;
      adminDenied: boolean;
    }>(sql`SELECT
      c.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${target.maintenance}) AS owner,
      (SELECT count(*)=2 FROM pg_catalog.aclexplode(
        COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(
        COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
        WHERE a.grantee<>c.relowner AND (a.grantee<>(SELECT oid FROM pg_catalog.pg_roles
          WHERE rolname=${target.app}) OR a.is_grantable OR a.privilege_type NOT IN ('SELECT','INSERT')))
      AND EXISTS(SELECT 1 FROM pg_catalog.aclexplode(
        COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
        WHERE a.grantee=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${target.app})
          AND a.privilege_type='SELECT')
      AND EXISTS(SELECT 1 FROM pg_catalog.aclexplode(
        COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
        WHERE a.grantee=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${target.app})
          AND a.privilege_type='INSERT') AS "exactGrants",
      NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a
        WHERE a.attrelid=c.oid AND a.attacl IS NOT NULL) AS "noColumnGrants",
      NOT pg_catalog.has_table_privilege(${target.admin},c.oid,
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        AND NOT pg_catalog.has_any_column_privilege(${target.admin},c.oid,
          'SELECT,INSERT,UPDATE,REFERENCES') AS "adminDenied"
      FROM pg_catalog.pg_class c WHERE c.oid='public.newcomer_cart_add_replay'::regclass`);
    const [count] = await tx.execute<{ rows: number }>(sql`SELECT count(*)::integer AS rows
      FROM public.newcomer_cart_add_replay`);
    const ready = root.database === target.database && root.role === target.maintenance
      && root.session === target.maintenance && root.backend === target.maintenance
      && root.pg16 && root.readOnly && root.replicationOrigin && root.databaseOwner
      && root.schemaCreate && root.maintenanceLogin && root.storeCartSafe
      && !root.receiptAbsent && !root.indexAbsent && root.enabledEventTriggers === 0
      && root.relevantDefaultAcls === 0 && roles.length === 2 && roles.every(role => role.safe)
      && acl?.owner === true && acl.exactGrants === true && acl.noColumnGrants === true
      && acl.adminDenied === true && count?.rows === 0;
    return { ready, root, roles, catalog, acl, rows: count?.rows ?? null };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

/** Called through actual app/Admin credentials, never through SET ROLE. */
export async function inspectNewcomerCartReplayRuntimeLogin(db: Root,
  target: NewcomerCartReplayMaintenanceTarget, kind: 'app' | 'admin', installed: boolean) {
  assertTarget(target);
  if (!Object.hasOwn(db, '$client') || !db.$client) throw Error('Root runtime connection required');
  const expected = target[kind];
  return db.transaction(async tx => {
    await setReadTimeouts(tx);
    const [row] = await tx.execute<{
      database: string; role: string; session: string; backend: string | null;
      pg16: boolean; readOnly: boolean; replicationOrigin: boolean;
      login: boolean; restricted: boolean; noMemberships: boolean; noOwnership: boolean;
      noDdl: boolean; noReplicationBypass: boolean;
      schemaUsage: boolean;
      read: boolean; append: boolean; mutable: boolean;
      grantable: boolean; columnExtras: boolean;
    }>(sql`SELECT current_database() AS database,current_user AS role,session_user AS session,
      (SELECT r.rolname FROM pg_catalog.pg_stat_activity a
        JOIN pg_catalog.pg_roles r ON r.oid=a.usesysid WHERE a.pid=pg_backend_pid()) AS backend,
      current_setting('server_version_num')::integer/10000=16 AS pg16,
      current_setting('transaction_read_only')='on' AS "readOnly",
      current_setting('session_replication_role')='origin' AS "replicationOrigin",
      r.rolcanlogin AS login,
      NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit
        OR r.rolreplication OR r.rolbypassrls) AS restricted,
      NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m
        WHERE m.member=r.oid OR m.roleid=r.oid) AS "noMemberships",
      NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend d
        WHERE d.refclassid='pg_catalog.pg_authid'::regclass AND d.refobjid=r.oid
          AND d.deptype='o') AS "noOwnership",
      NOT pg_catalog.has_database_privilege(r.oid,current_database(),'CREATE')
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n
          WHERE n.nspname !~ '^pg_'
            AND pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE')) AS "noDdl",
      NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET,ALTER SYSTEM')
        AS "noReplicationBypass",
      pg_catalog.has_schema_privilege(r.oid,'public','USAGE') AS "schemaUsage",
      CASE WHEN receipt.oid IS NULL THEN false
        ELSE pg_catalog.has_table_privilege(current_user,
          receipt.oid,'SELECT') END AS read,
      CASE WHEN receipt.oid IS NULL THEN false
        ELSE pg_catalog.has_table_privilege(current_user,
          receipt.oid,'INSERT') END AS append,
      CASE WHEN receipt.oid IS NULL THEN false
        ELSE pg_catalog.has_table_privilege(current_user,
          receipt.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') END AS mutable,
      CASE WHEN receipt.oid IS NULL THEN false
        ELSE pg_catalog.has_table_privilege(current_user,
          receipt.oid,
          'SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION') END AS grantable,
      CASE WHEN receipt.oid IS NULL THEN false
        ELSE pg_catalog.has_any_column_privilege(current_user,
          receipt.oid,'UPDATE,REFERENCES') END AS "columnExtras"
      FROM pg_catalog.pg_roles r
      LEFT JOIN LATERAL (SELECT c.oid FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname='newcomer_cart_add_replay') receipt ON true
      WHERE r.rolname=${expected}`);
    const base = row && row.database === target.database && row.role === expected
      && row.session === expected && row.backend === expected && row.pg16 && row.readOnly
      && row.replicationOrigin && row.login && row.restricted && row.noMemberships
      && row.noOwnership && row.noDdl && row.noReplicationBypass && row.schemaUsage
      && !row.mutable && !row.grantable
      && !row.columnExtras;
    const ready = base && (installed
      ? kind === 'app' ? row.read && row.append : !row.read && !row.append
      : !row.read && !row.append);
    if (ready && installed && kind === 'app') {
      // Exercise effective schema + table visibility through the actual app
      // LOGIN, without reading a business row or changing data.
      await tx.execute(sql`SELECT uid FROM public.newcomer_cart_add_replay LIMIT 0`);
    }
    return { ready: ready === true, kind, identity: row ?? null };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
