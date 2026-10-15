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
  adminAuthorityPreflightEvidence, AdminAuthorityPreflightMismatch, applyAdminAuthorityV2Maintenance,
  inspectAdminAuthorityV2Maintenance, adminAuthorityV2InstallSqlSha256, adminAuthorityV2PreflightEvidence,
  applyAdminLegacyRoleMaintenance, inspectAdminLegacyRoleMaintenance, adminLegacyRoleInstallSqlSha256, adminLegacyRolePreflightEvidence } from '../src/migrations/adminAuthorityOperationMaintenance';
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

function interruptV3BeforeGrant(db: DbClient): DbClient {
  const dialect = new PgDialect();
  return new Proxy(db, { get(target, key, receiver) {
    if (key !== 'transaction') return Reflect.get(target, key, receiver);
    return (callback: (tx: Pick<DbClient, 'execute'>) => Promise<unknown>, options: unknown) => target.transaction(async tx => {
      let altered = false;
      const proxy = new Proxy(tx, { get(current, property, context) {
        if (property !== 'execute') return Reflect.get(current, property, context);
        return async (query: Parameters<typeof tx.execute>[0]) => {
          const text = dialect.sqlToQuery(query as Parameters<typeof dialect.sqlToQuery>[0]).sql;
          if (text.startsWith('GRANT DELETE ON TABLE public.system_role TO ')) {
            expect(altered).toBe(true);
            throw Error('Owned v3 interruption after CHECK replacement');
          }
          const result = await tx.execute(query);
          if (text === ADMIN_LEGACY_ROLE_OPERATION_UPGRADE_SQL) altered = true;
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
  it('requires exact v2 evidence, rolls v3 DDL back before grant, then commits and repeats without changing receipt data', async () => {
    const whole = await refundRuntimeFixture();
    try {
      if (!whole.withRuntimeRole) throw Error('Independent LOGIN fixtures required');
      await whole.withRuntimeRole(async app => whole.withRuntimeRole!(async admin => {
        const [identity] = await whole.db.execute(sql`SELECT current_database() AS database,current_user AS maintenance`);
        const target = { database: String(identity.database), maintenance: String(identity.maintenance), app: app.role, admin: admin.role };
        await runRuntimeBusinessCommissioning(whole.db, { ...target, pricingOwner: whole.pricingOwner });
        const absent = await inspectAdminLegacyRoleMaintenance(whole.db, target);
        expect(absent).toMatchObject({ ready: false, addon: 'absent' });
        await runAdminAuthorityOperationUpgrade(whole.db, target);
        expect(await inspectAdminLegacyRoleMaintenance(whole.db, target)).toMatchObject({ ready: false, addon: 'v1' });
        await whole.db.insert(adminAuthorityOperation).values({
          operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', actorId: 11, adminType: 1, relationId: 0,
          operation: 'admin-save', requestHash: 'a'.repeat(64), revision: 'b'.repeat(64),
          state: 'committed', result: { id: 22, created: false }, createdAt: 1_791_500_000,
        });
        const v1Before = await inspectAdminAuthorityV2Maintenance(whole.db, target);
        const v1SqlSha256 = await adminAuthorityV2InstallSqlSha256(target);
        const v1App = await inspectAdminAuthorityRuntimeLogin(app.db, target, 'app');
        const v1Admin = await inspectAdminAuthorityRuntimeLogin(admin.db, target, 'admin');
        const v1Fingerprint = await adminAuthorityEvidenceSha256(adminAuthorityV2PreflightEvidence(
          'c'.repeat(40), v1SqlSha256, target, v1Before, v1App, v1Admin));
        expect(await applyAdminAuthorityV2Maintenance(whole.db, target, { sourceSha: 'c'.repeat(40),
          installSqlSha256: v1SqlSha256, fingerprint: v1Fingerprint, app: v1App, admin: v1Admin }))
          .toMatchObject({ committed: true, v1: null, v2: { applied: true }, protectedDataObservationUnchanged: true });
        const v2After = await inspectAdminAuthorityV2Maintenance(whole.db, target);
        expect(v2After.snapshot.dataSha256).toBe(v1Before.snapshot.dataSha256);
        expect(v2After.snapshot.tableCount).toBe(v1Before.snapshot.tableCount);
        // Exercise preservation of real, nonempty immutable v2 evidence.
        // Empty receipt tables cannot prove that old rows survive CHECK replacement.
        await whole.db.insert(adminAuthorityOperation).values({
          operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', actorId: 11, adminType: 1, relationId: 0,
          operation: 'legacy-admin-status', requestHash: 'd'.repeat(64), revision: 'e'.repeat(64),
          state: 'committed', result: { id: 22, created: false }, createdAt: 1_791_500_000,
        });
        const sourceSha = 'c'.repeat(40), installSqlSha256 = await adminLegacyRoleInstallSqlSha256(target);
        const approve = async () => {
          const maintenance = await inspectAdminLegacyRoleMaintenance(whole.db, target);
          const appReport = await inspectAdminAuthorityRuntimeLogin(app.db, target, 'app');
          const adminReport = await inspectAdminAuthorityRuntimeLogin(admin.db, target, 'admin');
          expect(maintenance).toMatchObject({ ready: true, addon: expect.stringMatching(/legacy-admin-v2|legacy-role-v3/) });
          expect(appReport.ready).toBe(true); expect(adminReport.ready).toBe(true);
          return { sourceSha, installSqlSha256, app: appReport, admin: adminReport,
            fingerprint: await adminAuthorityEvidenceSha256(adminLegacyRolePreflightEvidence(sourceSha, installSqlSha256, target, maintenance, appReport, adminReport)) };
        };
        const before = await inspectAdminLegacyRoleMaintenance(whole.db, target), approval = await approve();
        expect(before).toMatchObject({ ready: true, addon: 'legacy-admin-v2' });
        expect(before.snapshot.data.find(row => row.name === 'admin_authority_operation')?.rows).toBe('2');
        expect(before.identity).toMatchObject({ primary: true, originSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
        expect(approval.app.identity.originSha256).toBe(before.identity.originSha256);
        expect(approval.admin.identity.originSha256).toBe(before.identity.originSha256);
        // Bind the altered report into an otherwise correct fingerprint. The
        // locked origin comparison must reject it independently of hashing.
        for (const changed of [{ primary: false }, { originSha256: 'f'.repeat(64) }]) {
          const changedAdmin = { ...approval.admin, identity: { ...approval.admin.identity, ...changed } };
          const mismatched = { ...approval, admin: changedAdmin,
            fingerprint: await adminAuthorityEvidenceSha256(adminLegacyRolePreflightEvidence(sourceSha,
              installSqlSha256, target, before, approval.app, changedAdmin)) };
          await expect(applyAdminLegacyRoleMaintenance(whole.db, target, mismatched))
            .rejects.toBeInstanceOf(AdminAuthorityPreflightMismatch);
          expect(await inspectAdminLegacyRoleMaintenance(whole.db, target)).toEqual(before);
        }
        await expect(applyAdminLegacyRoleMaintenance(whole.db, target,
          { ...approval, installSqlSha256: '0'.repeat(64) })).rejects.toBeInstanceOf(AdminAuthorityPreflightMismatch);
        await expect(applyAdminLegacyRoleMaintenance(interruptV3BeforeGrant(whole.db), target, approval))
          .rejects.toThrow('Owned v3 interruption');
        expect(await inspectAdminLegacyRoleMaintenance(whole.db, target)).toEqual(before);
        await expect(app.exec('DELETE FROM public.system_role WHERE false')).rejects.toMatchObject({ code: '42501' });
        await expect(admin.exec('DELETE FROM public.system_role WHERE false')).rejects.toMatchObject({ code: '42501' });
        const result = await applyAdminLegacyRoleMaintenance(whole.db, target, approval);
        expect(result).toMatchObject({ committed: true, v3: { applied: true }, protectedDataObservationUnchanged: true });
        const after = await inspectAdminLegacyRoleMaintenance(whole.db, target);
        expect(after).toMatchObject({ ready: true, addon: 'legacy-role-v3' });
        expect(after.snapshot.dataSha256).toBe(before.snapshot.dataSha256);
        expect(after.snapshot.tableCount).toBe(before.snapshot.tableCount);
        expect(await inspectAdminAuthorityV2Maintenance(whole.db, target)).toMatchObject({ ready: false, addon: 'legacy-role-v3' });
        await admin.exec('DELETE FROM public.system_role WHERE false');
        await expect(app.exec('DELETE FROM public.system_role WHERE false')).rejects.toMatchObject({ code: '42501' });
        const repeat = await applyAdminLegacyRoleMaintenance(whole.db, target, await approve());
        expect(repeat).toMatchObject({ committed: true, v3: { applied: false }, protectedDataObservationUnchanged: true });
        expect(await inspectAdminLegacyRoleMaintenance(whole.db, target)).toEqual(after);
        for (const statement of [
          'UPDATE public.admin_authority_operation SET created_at=created_at+1',
          'DELETE FROM public.admin_authority_operation',
          'TRUNCATE public.admin_authority_operation',
        ]) await expect(whole.exec(statement)).rejects.toMatchObject({ code: '42501' });
        expect(await inspectAdminLegacyRoleMaintenance(whole.db, target)).toEqual(after);
      }));
    } finally { await whole.close(); }
  }, 180_000);
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
        const sourceSha = 'b'.repeat(40), installSqlSha256 = await adminAuthorityV2InstallSqlSha256(target);
        expect(await inspectAdminAuthorityRuntimeLogin(app.db, { ...target, database: 'wrong_database' }, 'app')).toMatchObject({
          ready: false, identity: { database: target.database, role: app.role, session: app.role, backend: app.role, supported: false },
        });
        const approve = async () => {
          const maintenance = await inspectAdminAuthorityV2Maintenance(whole.db, target);
          const appReport = await inspectAdminAuthorityRuntimeLogin(app.db, target, 'app');
          const adminReport = await inspectAdminAuthorityRuntimeLogin(admin.db, target, 'admin');
          expect(maintenance).toMatchObject({ ready: true }); expect(appReport.ready).toBe(true); expect(adminReport.ready).toBe(true);
          return { sourceSha, installSqlSha256, app: appReport, admin: adminReport,
            fingerprint: await adminAuthorityEvidenceSha256(adminAuthorityV2PreflightEvidence(sourceSha, installSqlSha256, target, maintenance, appReport, adminReport)) };
        };
        const before = await inspectAdminAuthorityV2Maintenance(whole.db, target), approval = await approve();
        const full = () => whole.db.transaction(tx => inspectAdminAuthorityMaintenanceSnapshot(tx, { wholeData: true }), { isolationLevel: 'repeatable read', accessMode: 'read only' });
        const beforeFull = await full();
        // The census comes from actual catalog; newcomer is independent of the
        // authority addon. No fixed 282/283/284 readiness assumption exists.
        expect(beforeFull.data.some(row => row.name === 'newcomer_cart_add_replay')).toBe(true);
        expect(beforeFull.tableCount).toBe(before.snapshot.tableCount);
        await whole.exec("CREATE FUNCTION public.admin_authority_menu_lock_v1() RETURNS void LANGUAGE sql AS 'SELECT pg_catalog.pg_sleep(0)'");
        const orphan = await inspectAdminAuthorityV2Maintenance(whole.db, target);
        expect(orphan).toMatchObject({ ready: false, addon: 'orphan' });
        await expect(applyAdminAuthorityV2Maintenance(whole.db, target, approval)).rejects.toBeInstanceOf(AdminAuthorityPreflightMismatch);
        expect(await inspectAdminAuthorityV2Maintenance(whole.db, target)).toEqual(orphan);
        await whole.exec('DROP FUNCTION public.admin_authority_menu_lock_v1()');
        expect(await inspectAdminAuthorityV2Maintenance(whole.db, target)).toEqual(before);
        for (const phase of ['second-install', 'after-install'] as const) {
          await expect(applyAdminAuthorityV2Maintenance(interrupted(whole.db, phase), target, approval)).rejects.toThrow('Owned interruption');
          expect(await inspectAdminAuthorityV2Maintenance(whole.db, target)).toEqual(before);
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
        const result = await applyAdminAuthorityV2Maintenance(whole.db, target, approval);
        expect(result).toMatchObject({ committed: true, v1: { applied: true }, v2: { applied: true }, atomicBusinessDataProof: false, protectedDataObservationUnchanged: true });
        const after = await inspectAdminAuthorityV2Maintenance(whole.db, target);
        expect(after).toMatchObject({ ready: true, addon: 'legacy-admin-v2' });
        expect(after.snapshot.tableCount).toBe(before.snapshot.tableCount + 1);
        const afterFull = await full();
        // Existing rows including newcomer are preserved by the installers.
        for (const row of beforeFull.data.filter(row => row.name !== 'store_cart')) expect(afterFull.data.find(next => next.name === row.name)).toEqual(row);
        const repeat = await applyAdminAuthorityV2Maintenance(whole.db, target, await approve());
        expect(repeat).toMatchObject({ committed: true, v1: null, v2: null });
        expect(await inspectAdminAuthorityV2Maintenance(whole.db, target)).toEqual(after); expect(await full()).toEqual(afterFull);
        // Reject protected-data drift under the real staff barrier; no repair.
        const stale = await approve();
        expect(Array.from(await whole.db.execute(sql`UPDATE public.system_admin SET real_name=real_name||'x' WHERE id=900 RETURNING id`))).toEqual([{ id: 900 }]);
        const changed = await inspectAdminAuthorityV2Maintenance(whole.db, target);
        await expect(applyAdminAuthorityV2Maintenance(whole.db, target, stale)).rejects.toBeInstanceOf(AdminAuthorityPreflightMismatch);
        expect(await inspectAdminAuthorityV2Maintenance(whole.db, target)).toEqual(changed);
        for (const [kind, peer] of [['app', app], ['admin', admin]] as const) expect(await inspectAdminAuthorityRuntimeLogin(peer.db, target, kind)).toMatchObject({ ready: true, failures: [] });
        await expect(app.exec('SELECT * FROM public.admin_authority_operation')).rejects.toMatchObject({ code: '42501' });
        await admin.exec('SELECT * FROM public.admin_authority_operation LIMIT 0');
      }));
    } finally { await whole.close(); }
  }, 180_000);


});
