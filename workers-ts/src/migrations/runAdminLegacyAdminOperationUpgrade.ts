import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { inspectRuntimeBusinessProfileInTransaction } from './auditRuntimeBusinessPrivileges';
import { inspectAdminAuthorityMenuLock, inspectAdminAuthorityOperation } from './adminAuthorityOperation';
import type { SeckillScheduleRuntimeTarget } from './runSeckillScheduleRuntimeUpgrade';

export const ADMIN_LEGACY_ADMIN_OPERATION_UPGRADE = 'admin-legacy-admin-operation-v2';

/** Only two reviewed CHECK constraints change. No receipt/business-row DML,
 * grant, trigger, sequence, function or ownership change is included. */
export const ADMIN_LEGACY_ADMIN_OPERATION_UPGRADE_SQL = `
ALTER TABLE ONLY public.admin_authority_operation
  DROP CONSTRAINT aao_operation_ck,
  DROP CONSTRAINT aao_state_ck,
  ADD CONSTRAINT aao_operation_ck CHECK (operation IN
    ('admin-save','role-save','role-delete','legacy-admin-save','legacy-admin-status','legacy-admin-delete')),
  ADD CONSTRAINT aao_state_ck CHECK ((
    (state = 'not_applied' AND request_hash = '' AND revision = '' AND result IS NULL) OR
    (state = 'committed' AND request_hash ~ '^[0-9a-f]{64}$' AND revision ~ '^[0-9a-f]{64}$'
      AND result IS NOT NULL AND jsonb_typeof(result) = 'object'
      AND jsonb_typeof(result->'id') = 'number' AND (result->>'id') ~ '^[1-9][0-9]{0,9}$'
      AND (result->>'id')::bigint <= 2147483647
      AND ((operation IN ('role-delete','legacy-admin-delete') AND result->'deleted' = 'true'::jsonb
        AND result - 'id' - 'deleted' = '{}'::jsonb AND result ? 'deleted') OR
        (operation IN ('admin-save','role-save','legacy-admin-save','legacy-admin-status')
          AND jsonb_typeof(result->'created') = 'boolean'
          AND (operation <> 'legacy-admin-status' OR result->'created' = 'false'::jsonb)
          AND result - 'id' - 'created' = '{}'::jsonb AND result ? 'created')))) IS TRUE);
`;

/** Low-level installer for an already-open, explicit PG16 maintenance
 * transaction. Without supplied runtime identities it permits owner-only ACLs.
 * Runtime/startup/request handlers never call this function. */
export async function installAdminLegacyAdminOperationUpgrade(
  tx: Pick<DbClient, 'execute'>, names?: { maintenance: string; admin: string },
): Promise<{ operation: typeof ADMIN_LEGACY_ADMIN_OPERATION_UPGRADE; applied: boolean }> {
  if (Object.hasOwn(tx, '$client')) throw Error('Legacy administrator receipt upgrade requires an existing maintenance transaction');
  if (names) [names.maintenance, names.admin].forEach(pricingIdentifier);
  const [gate] = await tx.execute(sql`SELECT current_user AS identity,
    current_user=session_user AND current_setting('server_version_num')::integer/10000=16
    AND current_setting('transaction_isolation')='read committed'
    AND NOT current_setting('transaction_read_only')::boolean
    AND current_setting('session_replication_role')='origin' AND current_schema()='public'
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND rolsuper)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D')
    AND pg_try_advisory_xact_lock(731626,8) AS supported,
    (SELECT relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)
      FROM pg_catalog.pg_class WHERE oid=to_regclass('public.admin_authority_operation')) AS owned`);
  if (gate?.supported !== true || gate.owned !== true || typeof gate.identity !== 'string'
    || names && names.maintenance !== gate.identity) {
    throw Error('Legacy administrator receipt upgrade requires explicit PG16 owner maintenance');
  }
  const identities = names ?? { maintenance: gate.identity, admin: gate.identity };
  await tx.execute(sql.raw('LOCK TABLE ONLY public.system_admin, ONLY public.system_role IN SHARE ROW EXCLUSIVE MODE NOWAIT'));
  await tx.execute(sql.raw('LOCK TABLE ONLY public.system_menus IN SHARE MODE NOWAIT'));
  // Fence both existing evidence and its schema before deciding which exact
  // version is present. No malformed or third-party catalog is repaired.
  await tx.execute(sql.raw('LOCK TABLE ONLY public.admin_authority_operation IN ACCESS EXCLUSIVE MODE NOWAIT'));
  if (!(await inspectAdminAuthorityMenuLock(tx, identities))) throw Error('Legacy administrator receipt lock catalog drift requires review');
  if (await inspectAdminAuthorityOperation(tx, identities, 'legacy-admin-v2')) {
    return { operation: ADMIN_LEGACY_ADMIN_OPERATION_UPGRADE, applied: false };
  }
  if (!(await inspectAdminAuthorityOperation(tx, identities, 'v1'))) throw Error('Legacy administrator receipt catalog drift requires review');
  await tx.execute(sql.raw(ADMIN_LEGACY_ADMIN_OPERATION_UPGRADE_SQL));
  if (!(await inspectAdminAuthorityOperation(tx, identities, 'legacy-admin-v2'))) throw Error('Legacy administrator receipt upgraded catalog verification failed');
  return { operation: ADMIN_LEGACY_ADMIN_OPERATION_UPGRADE, applied: true };
}

/** Full runtime commissioning wrapper preserves the exact existing app/Admin
 * profiles and all previous addon evidence. It does not broaden any grant. */
export async function installAdminLegacyAdminOperationUpgradeInTransaction(
  tx: Pick<DbClient, 'execute'>, target: SeckillScheduleRuntimeTarget,
) {
  if (Object.hasOwn(tx, '$client')) throw Error('Legacy administrator receipt upgrade requires an existing maintenance transaction');
  const identities = [target.maintenance, target.app, target.admin];
  [...identities, target.database].forEach(pricingIdentifier);
  if (new Set(identities).size !== 3) throw Error('Distinct legacy administrator runtime identities required');
  await tx.execute(sql`SELECT set_config('search_path','public,pg_temp',true),
    set_config('statement_timeout','5000',true),set_config('lock_timeout','1000',true),
    set_config('idle_in_transaction_session_timeout','5000',true)`);
  const [context] = await tx.execute(sql`SELECT current_database()=${target.database} AND current_user=${target.maintenance}
    AND session_user=current_user AND current_setting('server_version_num')::integer/10000=16
    AND current_setting('transaction_isolation')='read committed' AND NOT current_setting('transaction_read_only')::boolean
    AND current_setting('session_replication_role')='origin'
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND rolsuper)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS supported`);
  if (context?.supported !== true) throw Error('Legacy administrator receipt maintenance identity/database requires review');
  const [gate] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(731626,8) AS locked`);
  if (gate?.locked !== true) throw Error('Legacy administrator receipt commissioning is busy');
  await tx.execute(sql.raw('LOCK TABLE ONLY public.system_admin, ONLY public.system_role IN SHARE ROW EXCLUSIVE MODE NOWAIT'));
  await tx.execute(sql.raw('LOCK TABLE ONLY public.system_menus IN SHARE MODE NOWAIT'));
  const inspect = async () => ({
    app: await inspectRuntimeBusinessProfileInTransaction(tx, 'app', target, 'current'),
    admin: await inspectRuntimeBusinessProfileInTransaction(tx, 'admin', target, 'current'),
  });
  const before = await inspect();
  if (!before.app.ready || !before.admin.ready) throw Error('Legacy administrator receipt commissioning requires exact existing runtime profiles');
  const result = await installAdminLegacyAdminOperationUpgrade(tx, { maintenance: target.maintenance, admin: target.admin });
  const after = await inspect();
  if (!after.app.ready || !after.admin.ready) throw Error('Legacy administrator receipt commissioned profile verification failed');
  return result;
}

export async function runAdminLegacyAdminOperationUpgrade(db: DbClient, target: SeckillScheduleRuntimeTarget) {
  if (!Object.hasOwn(db, '$client') || !db.$client) throw Error('Legacy administrator receipt upgrade requires a root maintenance connection');
  return db.transaction(tx => installAdminLegacyAdminOperationUpgradeInTransaction(tx, target),
    { isolationLevel: 'read committed', accessMode: 'read write' });
}
