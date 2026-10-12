import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { DbClient } from '../src/lib/di';
import { systemAdmin, systemMenus, systemRole } from '../src/models/schema';
import { adminAuthorityOperation } from '../src/models/schema/adminAuthorityOperation';
import { assertAdminAuthorityOperationReady, assertAdminLegacyAdminOperationReady,
  installAdminAuthorityOperation, inspectAdminAuthorityOperation } from '../src/migrations/adminAuthorityOperation';
import { installAdminLegacyAdminOperationUpgrade, installAdminLegacyAdminOperationUpgradeInTransaction,
  runAdminLegacyAdminOperationUpgrade } from '../src/migrations/runAdminLegacyAdminOperationUpgrade';
import { runAdminAuthorityOperationUpgrade } from '../src/migrations/runAdminAuthorityOperationUpgrade';
import { runRuntimeBusinessCommissioning } from '../src/migrations/runRuntimeBusinessCommissioning';
import { auditRuntimeBusinessPrivileges } from '../src/migrations/auditRuntimeBusinessPrivileges';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';

type Fixture = Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
const receipt = (operation: string, state: 'committed' | 'not_applied' = 'committed', result: object | null = { id: 22, created: false }) => ({
  operationId: randomUUID(), actorId: 11, adminType: 1, relationId: 0, operation,
  requestHash: state === 'committed' ? 'a'.repeat(64) : '', revision: state === 'committed' ? 'b'.repeat(64) : '',
  // Negative cases intentionally bypass the compile-time result DTO so the
  // actual PostgreSQL CHECK must reject malformed persisted evidence.
  state, result: result as { id: number; created?: boolean; deleted?: boolean } | null, createdAt: 1_791_500_000,
});

/** Catalog and row comparisons execute on real PG16. They cover the fixed
 * two-CHECK extension, not the browser or business workflow. */
async function catalog(db: Pick<DbClient, 'execute'>) {
  return Array.from(await db.execute(sql`SELECT 'table' AS kind,c.oid::text AS id,c.relname AS name,
      concat_ws(':',c.relowner,c.relacl,c.relkind,c.reloptions,c.relrowsecurity,c.relforcerowsecurity) AS definition
    FROM pg_class c WHERE c.relnamespace='public'::regnamespace
    UNION ALL SELECT 'column',a.attrelid::text||'.'||a.attnum,a.attname,
      concat_ws(':',a.atttypid,a.atttypmod,a.attnotnull,a.attacl,a.attidentity,a.attgenerated)
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid WHERE c.relnamespace='public'::regnamespace AND a.attnum>0 AND NOT a.attisdropped
    UNION ALL SELECT 'constraint',oid::text,conname,pg_get_constraintdef(oid,false) FROM pg_constraint WHERE connamespace='public'::regnamespace
    UNION ALL SELECT 'function',oid::text,proname,pg_get_functiondef(oid)||':'||coalesce(proacl::text,'')
    FROM pg_proc WHERE pronamespace='public'::regnamespace AND prokind='f'
    UNION ALL SELECT 'trigger',t.oid::text,t.tgname,pg_get_triggerdef(t.oid)||':'||t.tgenabled::text
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace AND NOT t.tgisinternal
    UNION ALL SELECT 'default-acl',oid::text,defaclobjtype::text,defaclacl::text FROM pg_default_acl
    ORDER BY kind,id`));
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('legacy staff receipt extension on actual PG16', () => {
  let fixture: Fixture, ddl: string;
  beforeAll(async () => {
    const kit = await import('drizzle-kit/api');
    ddl = (await kit.generateMigration(kit.generateDrizzleJson({}), kit.generateDrizzleJson({ systemAdmin, systemRole, systemMenus }))).join('\n');
  });
  beforeEach(async () => {
    fixture = await sequenceRunnerDatabase();
    if (fixture.format !== 'pg16') throw Error('Actual PG16 maintenance connection required');
    await fixture.exec(ddl);
    await fixture.db.transaction(tx => installAdminAuthorityOperation(tx));
  }, 60_000);
  afterEach(async () => { await fixture?.close(); }, 30_000);

  it('retains old committed and sealed evidence, changes only two CHECKs, and repeats without changes', async () => {
    const old = [receipt('admin-save'), receipt('role-save', 'not_applied', null), receipt('role-delete', 'committed', { id: 22, deleted: true })];
    await fixture.db.insert(adminAuthorityOperation).values(old);
    const rows = () => fixture.db.select().from(adminAuthorityOperation).orderBy(adminAuthorityOperation.operationId);
    const beforeRows = await rows(), before = await catalog(fixture.db);
    await fixture.db.transaction(async tx => {
      expect(await inspectAdminAuthorityOperation(tx, undefined, 'v1')).toBe(true);
      await assertAdminAuthorityOperationReady(tx);
      await expect(assertAdminLegacyAdminOperationReady(tx)).rejects.toMatchObject({ code: 503 });
      expect(await installAdminLegacyAdminOperationUpgrade(tx)).toEqual({ operation: 'admin-legacy-admin-operation-v2', applied: true });
      expect(await inspectAdminAuthorityOperation(tx, undefined, 'v1')).toBe(false);
      expect(await inspectAdminAuthorityOperation(tx, undefined, 'legacy-admin-v2')).toBe(true);
      await assertAdminAuthorityOperationReady(tx); await assertAdminLegacyAdminOperationReady(tx);
    });
    const after = await catalog(fixture.db);
    const unchanged = (items: typeof before) => items.filter(row => row.kind !== 'constraint' || !['aao_operation_ck', 'aao_state_ck'].includes(String(row.name)));
    expect(unchanged(after)).toEqual(unchanged(before));
    expect(after.length).toBe(before.length); expect(await rows()).toEqual(beforeRows);
    expect(await fixture.db.transaction(tx => installAdminLegacyAdminOperationUpgrade(tx))).toEqual({ operation: 'admin-legacy-admin-operation-v2', applied: false });
    expect(await catalog(fixture.db)).toEqual(after); expect(await rows()).toEqual(beforeRows);
  });

  it('enforces all six finite kinds and their exact committed result shapes', async () => {
    await fixture.db.transaction(tx => installAdminLegacyAdminOperationUpgrade(tx));
    for (const operation of ['admin-save', 'role-save', 'legacy-admin-save', 'legacy-admin-status']) {
      await fixture.db.insert(adminAuthorityOperation).values(receipt(operation));
    }
    for (const operation of ['role-delete', 'legacy-admin-delete']) {
      await fixture.db.insert(adminAuthorityOperation).values(receipt(operation, 'committed', { id: 22, deleted: true }));
    }
    for (const operation of ['legacy-admin-save', 'legacy-admin-status', 'legacy-admin-delete']) {
      await fixture.db.insert(adminAuthorityOperation).values(receipt(operation, 'not_applied', null));
    }
    for (const [operation, result] of [
      ['unknown', { id: 22, created: false }], ['legacy-admin-status', { id: 22, status: 1 }],
      ['legacy-admin-save', { id: 22, created: false, pwd: 'secret' }], ['legacy-admin-delete', { id: 22, deleted: false }],
      ['legacy-admin-delete', { id: 22, created: false }], ['legacy-admin-save', { id: 0, created: true }],
      ['legacy-admin-status', { id: 22 }],
      ['legacy-admin-status', { id: 22, created: true }],
    ] as const) {
      await expect(fixture.db.insert(adminAuthorityOperation).values(receipt(operation, 'committed', result))).rejects.toThrow();
    }
    expect(await fixture.db.select().from(adminAuthorityOperation)).toHaveLength(9);
    await expect(fixture.exec('TRUNCATE public.admin_authority_operation')).rejects.toMatchObject({ code: '42501' });
  });

  it('rejects an altered catalog without repairing it', async () => {
    await fixture.exec("ALTER TABLE public.admin_authority_operation DROP CONSTRAINT aao_operation_ck; ALTER TABLE public.admin_authority_operation ADD CONSTRAINT aao_operation_ck CHECK (operation<>'')");
    const before = await catalog(fixture.db);
    await expect(fixture.db.transaction(tx => installAdminLegacyAdminOperationUpgrade(tx))).rejects.toThrow('catalog drift');
    expect(await catalog(fixture.db)).toEqual(before);
  });

  it('rejects third-party grants and ordinary LOGIN maintenance attempts', async () => {
    if (!fixture.withRuntimeRole) throw Error('Independent LOGIN required');
    await fixture.withRuntimeRole(async peer => {
      await fixture.exec(`GRANT SELECT ON public.admin_authority_operation TO "${peer.role}"`);
      const before = await catalog(fixture.db);
      await expect(fixture.db.transaction(tx => installAdminLegacyAdminOperationUpgrade(tx))).rejects.toThrow('catalog drift');
      await expect(peer.db.transaction(tx => installAdminLegacyAdminOperationUpgrade(tx))).rejects.toThrow('owner maintenance');
      expect(await catalog(fixture.db)).toEqual(before);
    });
  });
});

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('legacy staff receipt extension of complete commissioned runtime profiles', () => {
  it('preserves all 283 tables, rows and privileges, with independent app/Admin LOGINs and drift rejection', async () => {
    const whole = await refundRuntimeFixture();
    try {
      if (!whole.withRuntimeRole) throw Error('Actual independent runtime LOGINs required');
      await whole.withRuntimeRole(async app => whole.withRuntimeRole!(async admin => whole.withRuntimeRole!(async third => {
        const [identity] = await whole.db.execute(sql`SELECT current_database() AS database,current_user AS maintenance`);
        const target = { database: String(identity.database), maintenance: String(identity.maintenance), app: app.role, admin: admin.role };
        await runRuntimeBusinessCommissioning(whole.db, { ...target, pricingOwner: whole.pricingOwner });
        await runAdminAuthorityOperationUpgrade(whole.db, target);
        await whole.db.insert(adminAuthorityOperation).values([receipt('admin-save'), receipt('role-delete', 'not_applied', null)]);
        const rows = async (db: Pick<DbClient, 'execute'> = whole.db) => {
          const tables = Array.from(await db.execute(sql`SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY relname`));
          expect(tables).toHaveLength(283);
          return Array.from(await db.execute(sql.raw(tables.map(row => {
            const table = String(row.relname); expect(table).toMatch(/^[a-z_][a-z_0-9]*$/);
            return `SELECT '${table}' AS name,coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM public."${table}" t`;
          }).join(' UNION ALL ') + ' ORDER BY name')));
        };
        const before = await catalog(whole.db), beforeRows = await rows();
        expect(await runAdminLegacyAdminOperationUpgrade(whole.db, target)).toEqual({ operation: 'admin-legacy-admin-operation-v2', applied: true });
        const installed = await catalog(whole.db);
        const unchanged = (items: typeof before) => items.filter(row => row.kind !== 'constraint' || !['aao_operation_ck', 'aao_state_ck'].includes(String(row.name)));
        expect(unchanged(installed)).toEqual(unchanged(before)); expect(installed).toHaveLength(before.length); expect(await rows()).toEqual(beforeRows);
        for (const [kind, peer] of [['app', app], ['admin', admin]] as const) {
          const report = await auditRuntimeBusinessPrivileges(peer.db, kind, target);
          expect(report, JSON.stringify(report)).toMatchObject({ ready: true, failures: [], tableCount: 283, readOnly: true });
        }
        await admin.db.transaction(tx => assertAdminLegacyAdminOperationReady(tx));
        await expect(app.exec('SELECT * FROM public.admin_authority_operation')).rejects.toMatchObject({ code: '42501' });
        await expect(admin.exec('UPDATE public.admin_authority_operation SET state=state')).rejects.toMatchObject({ code: '42501' });
        await expect(admin.exec('TRUNCATE public.admin_authority_operation')).rejects.toMatchObject({ code: '42501' });
        expect(await runAdminLegacyAdminOperationUpgrade(whole.db, target)).toEqual({ operation: 'admin-legacy-admin-operation-v2', applied: false });
        expect(await catalog(whole.db)).toEqual(installed); expect(await rows()).toEqual(beforeRows);
        for (const statement of [`GRANT SELECT ON public.admin_authority_operation TO "${third.role}"`,
          'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO PUBLIC',
          `ALTER TABLE public.admin_authority_operation OWNER TO "${third.role}"`]) {
          const rollback = new Error('Roll back owned drift fixture');
          await expect(whole.db.transaction(async tx => {
            await tx.execute(sql.raw(statement)); const drifted = await catalog(tx);
            await expect(installAdminLegacyAdminOperationUpgradeInTransaction(tx, target)).rejects.toThrow('exact existing runtime profiles');
            expect(await catalog(tx)).toEqual(drifted); expect(await rows(tx)).toEqual(beforeRows); throw rollback;
          })).rejects.toBe(rollback);
          expect(await catalog(whole.db)).toEqual(installed); expect(await rows()).toEqual(beforeRows);
        }
      })));
    } finally { await whole.close(); }
  }, 180_000);
});
