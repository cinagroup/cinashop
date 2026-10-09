import { expect, it, describe } from 'vitest';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { DbClient } from '../src/lib/di';
import { systemAdmin } from '../src/models/schema';
import { adminAuthorityOperation } from '../src/models/schema/adminAuthorityOperation';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { runRuntimeBusinessCommissioning } from '../src/migrations/runRuntimeBusinessCommissioning';
import { installNewcomerCartAddReplay, inspectNewcomerCartAddReplayCatalog } from '../src/migrations/runNewcomerCartAddReplay';
import { applyAdminAuthorityMaintenance, inspectAdminAuthorityMaintenance, inspectAdminAuthorityMaintenanceSnapshot,
  inspectAdminAuthorityRuntimeLogin, adminAuthorityEvidenceSha256, adminAuthorityInstallSqlSha256,
  adminAuthorityPreflightEvidence, AdminAuthorityPreflightMismatch } from '../src/migrations/adminAuthorityOperationMaintenance';
import { ADMIN_LEGACY_ADMIN_OPERATION_UPGRADE_SQL } from '../src/migrations/runAdminLegacyAdminOperationUpgrade';
import { runAdminLegacyAdminOperationUpgrade } from '../src/migrations/runAdminLegacyAdminOperationUpgrade';
import { runAdminAuthorityOperationUpgrade } from '../src/migrations/runAdminAuthorityOperationUpgrade';
import { ADMIN_LEGACY_ROLE_OPERATION_UPGRADE_SQL } from '../src/migrations/runAdminLegacyRoleOperationUpgrade';
import { ADMIN_AUTHORITY_OPERATION_SQL, inspectAdminAuthorityOperation } from '../src/migrations/adminAuthorityOperation';

type Phase = 'after-v1' | 'after-v2' | 'after-v3-checks' | 'after-v3-grant' | 'final-inspection' | 'protected-data-drift';
type Trace = { transactions: number; mutationSql: string[]; reached: boolean };
const trace = (): Trace => ({ transactions: 0, mutationSql: [], reached: false });

async function tableAcl(db: Pick<DbClient, 'execute'>) {
  return Array.from(await db.execute(sql`SELECT c.relname AS name,a.grantor::text AS grantor,
    a.grantee::text AS grantee,a.privilege_type AS privilege,a.is_grantable AS delegate
    FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p')
    ORDER BY c.relname COLLATE "C",a.grantor,a.grantee,a.privilege_type COLLATE "C"`));
}

/** Inject a local exception at a real transaction boundary. No maintenance
 * fault switch, synthetic grant or retry is present in the production adapter. */
function observed(db: DbClient, observation: Trace, phase?: Phase): DbClient {
  const dialect = new PgDialect();
  return new Proxy(db, { get(target, key, receiver) {
    if (key !== 'transaction') return Reflect.get(target, key, receiver);
    return (callback: (tx: Pick<DbClient, 'execute'>) => Promise<unknown>, options: unknown) => target.transaction(async tx => {
      observation.transactions++;
      expect(options).toEqual({ isolationLevel: 'read committed', accessMode: 'read write' });
      let granted = false;
      const proxy = new Proxy(tx, { get(current, property, context) {
        if (property !== 'execute') return Reflect.get(current, property, context);
        return async (query: Parameters<typeof tx.execute>[0]) => {
          const text = dialect.sqlToQuery(query as Parameters<typeof dialect.sqlToQuery>[0]).sql;
          const roleGrant = text.startsWith('GRANT DELETE ON TABLE public.system_role TO ');
          const stop = phase === 'after-v1' && text === ADMIN_LEGACY_ADMIN_OPERATION_UPGRADE_SQL
            || phase === 'after-v2' && text === ADMIN_LEGACY_ROLE_OPERATION_UPGRADE_SQL
            || phase === 'after-v3-checks' && roleGrant
            || phase === 'final-inspection' && granted && text.includes('AS "tablePresent"');
          if (stop) { observation.reached = true; throw Error('Owned interruption ' + phase); }
          if (/^(CREATE|ALTER|GRANT|REVOKE|INSERT|UPDATE|DELETE|TRUNCATE|DROP)\b/.test(text.trim())) observation.mutationSql.push(text);
          const result = await tx.execute(query);
          if (roleGrant) {
            granted = true;
            if (phase === 'after-v3-grant') { observation.reached = true; throw Error('Owned interruption ' + phase); }
            if (phase === 'protected-data-drift') {
              // Real owned DML, not a forged snapshot: allow every remaining
              // inspector to finish and exercise the service's data guard.
              const changed = await tx.execute(sql`UPDATE public.system_admin SET real_name=real_name||'x' WHERE id=900 RETURNING id`);
              expect(Array.from(changed)).toEqual([{ id: 900 }]);
              observation.reached = true;
            }
          }
          return result;
        };
      } });
      return callback(proxy);
    }, options as Parameters<typeof target.transaction>[1]);
  } });
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('authority temporary adapter on genuine PG16', () => {
  it('coexists with newcomer, rolls all three stages back, commits once, and repeats exact v3 without mutation', async () => {
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
        for (const phase of ['after-v1', 'after-v2', 'after-v3-checks', 'after-v3-grant', 'final-inspection', 'protected-data-drift'] as const) {
          const interrupted = trace();
          await expect(applyAdminAuthorityMaintenance(observed(whole.db, interrupted, phase), target, approval)).rejects.toThrow(
            phase === 'protected-data-drift' ? 'changed protected data' : 'Owned interruption');
          expect(interrupted).toMatchObject({ transactions: 1, reached: true });
          expect(await inspectAdminAuthorityMaintenance(whole.db, target)).toEqual(before);
          expect(await full()).toEqual(beforeFull);
          const [roleDelete] = await whole.db.execute(sql`SELECT has_table_privilege(${app.role},'public.system_role','DELETE') AS app,
            has_table_privilege(${admin.role},'public.system_role','DELETE') AS admin`);
          expect(roleDelete).toEqual({ app: false, admin: false });
          const [objects] = await whole.db.execute(sql`SELECT to_regclass('public.admin_authority_operation') IS NULL
            AND to_regprocedure('public.admin_authority_operation_immutable_v1()') IS NULL
            AND to_regprocedure('public.admin_authority_menu_lock_v1()') IS NULL AS absent`);
          expect(objects.absent).toBe(true);
        }
        // A normal cart write changes optional business observation, not the
        // locked authority approval. No full-shop quiescence is required.
        await whole.exec('UPDATE public.store_cart SET is_new=1-is_new');
        expect((await approve()).fingerprint).toBe(approval.fingerprint);
        const applied = trace(), result = await applyAdminAuthorityMaintenance(observed(whole.db, applied), target, approval);
        expect(applied.transactions).toBe(1);
        expect(result).toMatchObject({ committed: true, targetCatalog: 'legacy-role-v3', fromCatalog: 'absent', toCatalog: 'legacy-role-v3',
          v1: { applied: true }, v2: { applied: true }, v3: { applied: true }, atomicBusinessDataProof: false, protectedDataObservationUnchanged: true });
        const after = await inspectAdminAuthorityMaintenance(whole.db, target);
        expect(after).toMatchObject({ ready: true, addon: 'legacy-role-v3' });
        expect(await inspectAdminAuthorityOperation(whole.db, target, 'legacy-role-v3')).toBe(true);
        expect(after.snapshot.tableCount).toBe(before.snapshot.tableCount + 1);
        const afterFull = await full();
        // Existing rows including newcomer are preserved by the installers.
        for (const row of beforeFull.data.filter(row => row.name !== 'store_cart')) expect(afterFull.data.find(next => next.name === row.name)).toEqual(row);
        const repeated = trace(), repeatApproval = await approve();
        const repeat = await applyAdminAuthorityMaintenance(observed(whole.db, repeated), target, repeatApproval);
        expect(repeat).toMatchObject({ committed: true, fromCatalog: 'legacy-role-v3', toCatalog: 'legacy-role-v3', v1: null, v2: null, v3: { applied: false } });
        expect(repeated).toEqual({ transactions: 1, mutationSql: [], reached: false });
        expect(await inspectAdminAuthorityMaintenance(whole.db, target)).toEqual(after); expect(await full()).toEqual(afterFull);
        // The adapter must not repair incomplete v3 or widen App privileges.
        for (const drift of [
          { change: `REVOKE DELETE ON TABLE public.system_role FROM "${admin.role}"`, restore: `GRANT DELETE ON TABLE public.system_role TO "${admin.role}"` },
          { change: `GRANT DELETE ON TABLE public.system_role TO "${app.role}"`, restore: `REVOKE DELETE ON TABLE public.system_role FROM "${app.role}"` },
          { change: `GRANT SELECT ON TABLE public.admin_authority_operation TO "${app.role}"`, restore: `REVOKE SELECT ON TABLE public.admin_authority_operation FROM "${app.role}"` },
        ]) {
          await whole.exec(drift.change);
          const drifted = await full(), refused = trace();
          expect((await inspectAdminAuthorityMaintenance(whole.db, target)).ready).toBe(false);
          await expect(applyAdminAuthorityMaintenance(observed(whole.db, refused), target, repeatApproval)).rejects.toBeInstanceOf(AdminAuthorityPreflightMismatch);
          expect(refused.mutationSql).toEqual([]); expect(await full()).toEqual(drifted);
          await whole.exec(drift.restore);
        }
        // Reject protected-data drift under the real staff barrier; no repair.
        const stale = await approve();
        expect(Array.from(await whole.db.execute(sql`UPDATE public.system_admin SET real_name=real_name||'x' WHERE id=900 RETURNING id`))).toEqual([{ id: 900 }]);
        const changed = await inspectAdminAuthorityMaintenance(whole.db, target);
        await expect(applyAdminAuthorityMaintenance(whole.db, target, stale)).rejects.toBeInstanceOf(AdminAuthorityPreflightMismatch);
        expect(await inspectAdminAuthorityMaintenance(whole.db, target)).toEqual(changed);
        for (const [kind, peer] of [['app', app], ['admin', admin]] as const) expect(await inspectAdminAuthorityRuntimeLogin(peer.db, target, kind)).toMatchObject({ ready: true, failures: [] });
        await expect(app.exec('SELECT * FROM public.admin_authority_operation')).rejects.toMatchObject({ code: '42501' });
        await expect(app.exec('DELETE FROM public.system_role WHERE false')).rejects.toMatchObject({ code: '42501' });
        await admin.exec('DELETE FROM public.system_role WHERE false');
        await admin.exec('SELECT * FROM public.admin_authority_operation LIMIT 0');
      }));
    } finally { await whole.close(); }
  }, 180_000);

  it.each(['v1', 'legacy-admin-v2'] as const)('upgrades exact %s without invoking earlier installers or changing existing receipts and other ACLs', async start => {
    const whole = await refundRuntimeFixture();
    try {
      if (!whole.withRuntimeRole) throw Error('Independent LOGIN fixtures required');
      await whole.withRuntimeRole(async app => whole.withRuntimeRole!(async admin => {
        const [identity] = await whole.db.execute(sql`SELECT current_database() AS database,current_user AS maintenance`);
        const target = { database: String(identity.database), maintenance: String(identity.maintenance), app: app.role, admin: admin.role };
        await runRuntimeBusinessCommissioning(whole.db, { ...target, pricingOwner: whole.pricingOwner });
        await runAdminAuthorityOperationUpgrade(whole.db, target);
        if (start === 'legacy-admin-v2') await runAdminLegacyAdminOperationUpgrade(whole.db, target);
        await whole.db.insert(adminAuthorityOperation).values([
          { operationId: 'b1b5c085-6d9e-48b2-8b34-7f9c4d7fea01', actorId: 900, adminType: 1, relationId: 0,
            operation: 'admin-save', requestHash: 'a'.repeat(64), revision: 'b'.repeat(64), state: 'committed', result: { id: 900, created: false }, createdAt: 1 },
          { operationId: 'b1b5c085-6d9e-48b2-8b34-7f9c4d7fea02', actorId: 900, adminType: 1, relationId: 0,
            operation: 'role-delete', requestHash: '', revision: '', state: 'not_applied', result: null, createdAt: 1 },
        ]);
        const full = () => whole.db.transaction(tx => inspectAdminAuthorityMaintenanceSnapshot(tx, { wholeData: true }), { isolationLevel: 'repeatable read', accessMode: 'read only' });
        const before = await inspectAdminAuthorityMaintenance(whole.db, target), beforeFull = await full(), beforeAcl = await tableAcl(whole.db);
        expect(before).toMatchObject({ ready: true, addon: start });
        const sourceSha = 'b'.repeat(40), installSqlSha256 = await adminAuthorityInstallSqlSha256(target);
        const appReport = await inspectAdminAuthorityRuntimeLogin(app.db, target, 'app'), adminReport = await inspectAdminAuthorityRuntimeLogin(admin.db, target, 'admin');
        const approval = { sourceSha, installSqlSha256, app: appReport, admin: adminReport,
          fingerprint: await adminAuthorityEvidenceSha256(adminAuthorityPreflightEvidence(sourceSha, installSqlSha256, target, before, appReport, adminReport)) };
        for (const phase of ['after-v3-checks', 'after-v3-grant'] as const) {
          const interrupted = trace();
          await expect(applyAdminAuthorityMaintenance(observed(whole.db, interrupted, phase), target, approval)).rejects.toThrow('Owned interruption');
          expect(interrupted).toMatchObject({ transactions: 1, reached: true });
          expect(await full()).toEqual(beforeFull); expect(await tableAcl(whole.db)).toEqual(beforeAcl);
        }
        // A prematurely granted DELETE is v1/v2 drift, not a prerequisite to adopt.
        await whole.exec(`GRANT DELETE ON TABLE public.system_role TO "${admin.role}"`);
        const drifted = await full(), rejected = trace();
        await expect(applyAdminAuthorityMaintenance(observed(whole.db, rejected), target, approval)).rejects.toBeInstanceOf(AdminAuthorityPreflightMismatch);
        expect(rejected.mutationSql).toEqual([]); expect(await full()).toEqual(drifted);
        await whole.exec(`REVOKE DELETE ON TABLE public.system_role FROM "${admin.role}"`);
        const applied = trace(), result = await applyAdminAuthorityMaintenance(observed(whole.db, applied), target, approval);
        expect(applied.transactions).toBe(1);
        expect(result).toMatchObject({ fromCatalog: start, toCatalog: 'legacy-role-v3', v1: null,
          v2: start === 'v1' ? { applied: true } : null, v3: { applied: true }, protectedDataObservationUnchanged: true });
        expect(applied.mutationSql).not.toContain(ADMIN_AUTHORITY_OPERATION_SQL);
        if (start === 'legacy-admin-v2') expect(applied.mutationSql).not.toContain(ADMIN_LEGACY_ADMIN_OPERATION_UPGRADE_SQL);
        expect(await inspectAdminAuthorityOperation(whole.db, target, 'legacy-role-v3')).toBe(true);
        expect((await full()).data).toEqual(beforeFull.data);
        const afterAcl = await tableAcl(whole.db), added = afterAcl.filter(row => !beforeAcl.some(previous => JSON.stringify(previous) === JSON.stringify(row)));
        expect(beforeAcl.every(row => afterAcl.some(next => JSON.stringify(row) === JSON.stringify(next)))).toBe(true);
        const [roleOids] = await whole.db.execute(sql`SELECT (SELECT oid::text FROM pg_roles WHERE rolname=${target.maintenance}) AS maintenance,
          (SELECT oid::text FROM pg_roles WHERE rolname=${admin.role}) AS admin`);
        expect(added).toEqual([{ name: 'system_role', grantor: roleOids.maintenance, grantee: roleOids.admin, privilege: 'DELETE', delegate: false }]);
        for (const [kind, peer] of [['app', app], ['admin', admin]] as const) expect(await inspectAdminAuthorityRuntimeLogin(peer.db, target, kind)).toMatchObject({ ready: true, failures: [] });
      }));
    } finally { await whole.close(); }
  }, 180_000);
});
