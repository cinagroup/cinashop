import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { pricingIdentifier } from '@/migrations/checkoutPricingLockCatalog';
import { customerWorkCatalogSql } from '@/migrations/customerWorkCatalog';
import { NEWCOMER_CART_ADD_REPLAY_INSTALLATION_SQL } from '@/migrations/newcomerCartAddReplay';
import { outRequestHash } from '@/services/out/OutIdempotency';
import { HttpApiException } from '@/utils/errors';

/** The dedicated receipt is outside the fixed runAll and external cohorts.
 * Fingerprint the actual PG16 relation, constraints, indexes and triggers. */
export const NEWCOMER_CART_ADD_REPLAY_CATALOG_SQL = `SELECT jsonb_build_object(
  'receipt',(${customerWorkCatalogSql('newcomer_cart_add_replay').replace(' AS shape FROM', ' FROM')}),
  'policies',(SELECT count(*) FROM pg_catalog.pg_policy
    WHERE polrelid=to_regclass('public.newcomer_cart_add_replay')),
  'inbound_foreign_keys',(SELECT count(*) FROM pg_catalog.pg_constraint
    WHERE confrelid=to_regclass('public.newcomer_cart_add_replay'))
) AS shape WHERE to_regclass('public.newcomer_cart_add_replay') IS NOT NULL`;

/** Measured from the guarded installation on native PostgreSQL 16.15. */
export const NEWCOMER_CART_ADD_REPLAY_CATALOG_SHA256 = 'c2464dd3dedf050b12926124a875aab65080d7753ca5b828d18cdfbe1323f73e';

type Query = Pick<DbClient, 'execute'>;

export async function inspectNewcomerCartAddReplayCatalog(db: Query) {
  const rows = await db.execute<{ shape: unknown }>(sql.raw(NEWCOMER_CART_ADD_REPLAY_CATALOG_SQL));
  if (rows.length === 0) return { present: false, complete: false, fingerprint: null };
  if (rows.length !== 1) throw Error('Newcomer cart replay catalog ambiguous');
  const fingerprint = await outRequestHash(rows[0].shape);
  return { present: true, complete: fingerprint === NEWCOMER_CART_ADD_REPLAY_CATALOG_SHA256, fingerprint };
}

/** All checks are read-only and bounded by the caller's transaction timeout.
 * A Worker with the old schema or an uncommissioned app role fails before a
 * cart row can be inserted. The owner is admitted only for isolated fixtures;
 * production app identity is separately constrained by the global audit. */
export async function newcomerCartAddReplayReadiness(db: Query) {
  const catalog = await inspectNewcomerCartAddReplayCatalog(db);
  if (!catalog.complete) return { ready: false, reason: catalog.present
    ? 'newcomer_cart_replay_catalog_incompatible' : 'newcomer_cart_replay_not_installed', catalog };
  const [acl] = await db.execute<{
    read: boolean; append: boolean; owner: boolean; mutable: boolean; appendOnlyAcl: boolean;
  }>(sql`SELECT
    pg_catalog.has_table_privilege(current_user,'public.newcomer_cart_add_replay','SELECT') AS read,
    pg_catalog.has_table_privilege(current_user,'public.newcomer_cart_add_replay','INSERT') AS append,
    c.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) AS owner,
    (pg_catalog.has_table_privilege(current_user,c.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR pg_catalog.has_any_column_privilege(current_user,c.oid,'UPDATE,REFERENCES')) AS mutable,
    NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
      WHERE a.grantee<>c.relowner AND (a.grantee=0 OR a.is_grantable OR a.privilege_type NOT IN ('SELECT','INSERT')
        OR (c.relowner<>(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)
          AND a.grantee<>(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user))))
      AND ((c.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)
          AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
            WHERE a.grantee<>c.relowner))
        OR ((SELECT count(DISTINCT a.grantee)=1
          FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
          WHERE a.grantee<>c.relowner)
          AND EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
            WHERE a.grantee<>c.relowner AND a.privilege_type='SELECT')
          AND EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
            WHERE a.grantee<>c.relowner AND a.privilege_type='INSERT')))
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a
        WHERE a.attrelid=c.oid AND a.attacl IS NOT NULL) AS "appendOnlyAcl"
    FROM pg_catalog.pg_class c WHERE c.oid='public.newcomer_cart_add_replay'::regclass`);
  const ready = acl?.read === true && acl.append === true && acl.appendOnlyAcl === true
    && (acl.owner === true || acl.mutable === false);
  return { ready, reason: ready ? '' : 'newcomer_cart_replay_runtime_privileges_unreviewed', catalog };
}

export async function assertNewcomerCartAddReplayReady(db: Query): Promise<void> {
  if (!(await newcomerCartAddReplayReadiness(db)).ready) {
    throw new HttpApiException('新人原请求恢复尚未启用，请保留请求并人工核对', 503, 503);
  }
}

/** Explicit owner-maintenance operation. It never runs from a request or
 * startup hook. Table creation and the app's SELECT/INSERT grant are atomic. */
export async function installNewcomerCartAddReplay(
  db: Pick<DbClient, 'transaction'> & Partial<Pick<DbClient, '$client'>>,
  appRole: string,
  beforeCreate?: (tx: Pick<DbClient, 'execute'>) => Promise<void>,
): Promise<void> {
  if (!Object.hasOwn(db, '$client') || !db.$client) throw Error('Newcomer replay installation requires root maintenance client');
  const role = pricingIdentifier(appRole);
  await db.transaction(async tx => {
    if (beforeCreate) await beforeCreate(tx);
    await tx.execute(sql.raw(NEWCOMER_CART_ADD_REPLAY_INSTALLATION_SQL));
    await tx.execute(sql.raw(`GRANT SELECT, INSERT ON public.newcomer_cart_add_replay TO ${role}`));
    if (!(await inspectNewcomerCartAddReplayCatalog(tx)).complete) {
      throw Error('Newcomer replay installed catalog did not match reviewed PG16 shape');
    }
    const [selected] = await tx.execute<{ granted: boolean }>(sql`SELECT
      EXISTS(SELECT 1 FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_roles r ON r.rolname=${appRole} AND r.oid<>c.relowner
        CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
        WHERE c.oid='public.newcomer_cart_add_replay'::regclass AND a.grantee=r.oid
          AND a.privilege_type='SELECT')
      AND EXISTS(SELECT 1 FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_roles r ON r.rolname=${appRole} AND r.oid<>c.relowner
        CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
        WHERE c.oid='public.newcomer_cart_add_replay'::regclass AND a.grantee=r.oid
          AND a.privilege_type='INSERT') AS granted`);
    if (selected?.granted !== true || !(await newcomerCartAddReplayReadiness(tx)).ready) {
      throw Error('Newcomer replay installed ACL contains an unreviewed grant');
    }
  }, { isolationLevel: 'read committed', accessMode: 'read write' });
}
