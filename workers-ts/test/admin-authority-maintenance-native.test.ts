import { expect, it, describe } from 'vitest';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { DbClient } from '../src/lib/di';
import { systemAdmin } from '../src/models/schema';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { runRuntimeBusinessCommissioning } from '../src/migrations/runRuntimeBusinessCommissioning';
import { installNewcomerCartAddReplay, inspectNewcomerCartAddReplayCatalog } from '../src/migrations/runNewcomerCartAddReplay';
import { applyAdminAuthorityMaintenance, inspectAdminAuthorityMaintenance, inspectAdminAuthorityMaintenanceSnapshot,
  inspectAdminAuthorityRuntimeLogin, adminAuthorityEvidenceSha256, adminAuthorityInstallSqlSha256,
  adminAuthorityPreflightEvidence, AdminAuthorityPreflightMismatch } from '../src/migrations/adminAuthorityOperationMaintenance';
import { ADMIN_LEGACY_ADMIN_OPERATION_UPGRADE_SQL } from '../src/migrations/runAdminLegacyAdminOperationUpgrade';

/** Inject a local exception at a real transaction boundary. No maintenance
 * fault switch, synthetic grant or retry is present in the production adapter. */
function interrupted(db: DbClient, phase: 'second-install' | 'after-install'): DbClient {
  const dialect = new PgDialect();
  return new Proxy(db, { get(target, key, receiver) {
    if (key !== 'transaction') return Reflect.get(target, key, receiver);
    return (callback: (tx: Pick<DbClient, 'execute'>) => Promise<unknown>, options: unknown) => target.transaction(async tx => {
      let installed = false;
      const proxy = new Proxy(tx, { get(current, property, context) {
        if (property !== 'execute') return Reflect.get(current, property, context);
        return async (query: Parameters<typeof tx.execute>[0]) => {
          const text = dialect.sqlToQuery(query as Parameters<typeof dialect.sqlToQuery>[0]).sql;
          const second = text === ADMIN_LEGACY_ADMIN_OPERATION_UPGRADE_SQL;
          if (phase === 'second-install' && second) throw Error('Owned interruption before second-stage SQL');
          if (phase === 'after-install' && installed && text.includes('current_database() AS database')) throw Error('Owned interruption after both stage SQL');
          const result = await tx.execute(query);
          if (second) installed = true;
          return result;
        };
      } });
      return callback(proxy);
    }, options as Parameters<typeof target.transaction>[1]);
  } });
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('authority temporary adapter on genuine PG16', () => {
  it('coexists with newcomer, rolls both stages back, commits atomically, and repeats exact v2 without catalog/data/ACL changes', async () => {
    const whole = await refundRuntimeFixture();
    try {
      if (!whole.withRuntimeRole) throw Error('Independent LOGIN fixtures required');
      await whole.withRuntimeRole(async app => whole.withRuntimeRole!(async admin => {
        const [identity] = await whole.db.execute(sql`SELECT current_database() AS database,current_user AS maintenance`);
        const target = { database: String(identity.database), maintenance: String(identity.maintenance), app: app.role, admin: admin.role };
        await runRuntimeBusinessCommissioning(whole.db, { ...target, pricingOwner: whole.pricingOwner });
        await installNewcomerCartAddReplay(whole.db, app.role);
        await whole.db.insert(systemAdmin).values({ id: 900, account: 'owned_maintenance', pwd: 'owned-fixture-hash',
          realName: 'Owned authority', phone: '13800000900', roles: '', status: 1, level: 1, adminType: 1, relationId: 0, isDel: 0 });
        expect(await inspectNewcomerCartAddReplayCatalog(whole.db)).toMatchObject({ complete: true });
        await app.exec('SELECT uid FROM public.newcomer_cart_add_replay LIMIT 0');
        await expect(admin.exec('SELECT uid FROM public.newcomer_cart_add_replay LIMIT 0')).rejects.toMatchObject({ code: '42501' });
        const sourceSha = 'b'.repeat(40), installSqlSha256 = await adminAuthorityInstallSqlSha256(target);
        expect(await inspectAdminAuthorityRuntimeLogin(app.db, { ...target, database: 'wrong_database' }, 'app')).toMatchObject({
          ready: false, identity: { database: target.database, role: app.role, session: app.role, backend: app.role, supported: false },
        });
        const approve = async () => {
          const maintenance = await inspectAdminAuthorityMaintenance(whole.db, target);
          const appReport = await inspectAdminAuthorityRuntimeLogin(app.db, target, 'app');
          const adminReport = await inspectAdminAuthorityRuntimeLogin(admin.db, target, 'admin');
          expect(maintenance).toMatchObject({ ready: true }); expect(appReport.ready).toBe(true); expect(adminReport.ready).toBe(true);
          return { sourceSha, installSqlSha256, app: appReport, admin: adminReport,
            fingerprint: await adminAuthorityEvidenceSha256(adminAuthorityPreflightEvidence(sourceSha, installSqlSha256, target, maintenance, appReport, adminReport)) };
        };
        const before = await inspectAdminAuthorityMaintenance(whole.db, target), approval = await approve();
        const full = () => whole.db.transaction(tx => inspectAdminAuthorityMaintenanceSnapshot(tx, { wholeData: true }), { isolationLevel: 'repeatable read', accessMode: 'read only' });
        const beforeFull = await full();
        // The census comes from actual catalog; newcomer is independent of the
        // authority addon. No fixed 282/283/284 readiness assumption exists.
        expect(beforeFull.data.some(row => row.name === 'newcomer_cart_add_replay')).toBe(true);
        expect(beforeFull.tableCount).toBe(before.snapshot.tableCount);
        await whole.exec("CREATE FUNCTION public.admin_authority_menu_lock_v1() RETURNS void LANGUAGE sql AS 'SELECT pg_catalog.pg_sleep(0)'");
        const orphan = await inspectAdminAuthorityMaintenance(whole.db, target);
        expect(orphan).toMatchObject({ ready: false, addon: 'orphan' });
        await expect(applyAdminAuthorityMaintenance(whole.db, target, approval)).rejects.toBeInstanceOf(AdminAuthorityPreflightMismatch);
        expect(await inspectAdminAuthorityMaintenance(whole.db, target)).toEqual(orphan);
        await whole.exec('DROP FUNCTION public.admin_authority_menu_lock_v1()');
        expect(await inspectAdminAuthorityMaintenance(whole.db, target)).toEqual(before);
        for (const phase of ['second-install', 'after-install'] as const) {
          await expect(applyAdminAuthorityMaintenance(interrupted(whole.db, phase), target, approval)).rejects.toThrow('Owned interruption');
          expect(await inspectAdminAuthorityMaintenance(whole.db, target)).toEqual(before);
          expect(await full()).toEqual(beforeFull);
          const [objects] = await whole.db.execute(sql`SELECT to_regclass('public.admin_authority_operation') IS NULL
            AND to_regprocedure('public.admin_authority_operation_immutable_v1()') IS NULL
            AND to_regprocedure('public.admin_authority_menu_lock_v1()') IS NULL AS absent`);
          expect(objects.absent).toBe(true);
        }
        // A normal cart write changes optional business observation, not the
        // locked authority approval. No full-shop quiescence is required.
        await whole.exec('UPDATE public.store_cart SET is_new=1-is_new');
        expect((await approve()).fingerprint).toBe(approval.fingerprint);
        const result = await applyAdminAuthorityMaintenance(whole.db, target, approval);
        expect(result).toMatchObject({ committed: true, v1: { applied: true }, v2: { applied: true }, atomicBusinessDataProof: false, protectedDataObservationUnchanged: true });
        const after = await inspectAdminAuthorityMaintenance(whole.db, target);
        expect(after).toMatchObject({ ready: true, addon: 'legacy-admin-v2' });
        expect(after.snapshot.tableCount).toBe(before.snapshot.tableCount + 1);
        const afterFull = await full();
        // Existing rows including newcomer are preserved by the installers.
        for (const row of beforeFull.data.filter(row => row.name !== 'store_cart')) expect(afterFull.data.find(next => next.name === row.name)).toEqual(row);
        const repeat = await applyAdminAuthorityMaintenance(whole.db, target, await approve());
        expect(repeat).toMatchObject({ committed: true, v1: { applied: false }, v2: { applied: false } });
        expect(await inspectAdminAuthorityMaintenance(whole.db, target)).toEqual(after); expect(await full()).toEqual(afterFull);
        // Reject protected-data drift under the real staff barrier; no repair.
        const stale = await approve();
        expect(Array.from(await whole.db.execute(sql`UPDATE public.system_admin SET real_name=real_name||'x' WHERE id=900 RETURNING id`))).toEqual([{ id: 900 }]);
        const changed = await inspectAdminAuthorityMaintenance(whole.db, target);
        await expect(applyAdminAuthorityMaintenance(whole.db, target, stale)).rejects.toBeInstanceOf(AdminAuthorityPreflightMismatch);
        expect(await inspectAdminAuthorityMaintenance(whole.db, target)).toEqual(changed);
        for (const [kind, peer] of [['app', app], ['admin', admin]] as const) expect(await inspectAdminAuthorityRuntimeLogin(peer.db, target, kind)).toMatchObject({ ready: true, failures: [] });
        await expect(app.exec('SELECT * FROM public.admin_authority_operation')).rejects.toMatchObject({ code: '42501' });
        await admin.exec('SELECT * FROM public.admin_authority_operation LIMIT 0');
      }));
    } finally { await whole.close(); }
  }, 180_000);
});
