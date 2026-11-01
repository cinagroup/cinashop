/** Real PG16 named-catalog proof only. These tests do not commission refund
 * privileges, authorize a human actor, authenticate the leaf's caller session,
 * call a provider, or establish historical payment ownership. */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DbClient } from '@/lib/di';
import { inspectRoutineRefundActorPrincipals, type RoutineRefundActorPrincipalNames } from '@/migrations/routineRefundActorPrincipals';
import { AGENT_LEVEL_CATALOG_FENCE, AGENT_LEVEL_ROW_GUARD } from '@/migrations/runtimeAgentLevelCatalogBoundary';
import { MANAGER_RUNTIME_ROLE } from '@/migrations/managerRuntimePrivilegePlan';
import { CUSTOMER_FINANCIAL_RUNTIME_ROLE } from '@/migrations/customerFinancialRuntimePlan';
import { routineRefundRuntimeFixture } from './helpers/routineRefundRuntimeFixture';
import { customerCashierRuntimeHttpFixture } from './helpers/customerCashierRuntimeHttpFixture';

type Query = Pick<DbClient, 'execute'>;
type Full = Awaited<ReturnType<typeof customerCashierRuntimeHttpFixture>>;
const enabled = Boolean(process.env.TEST_FINANCE_POSTGRES_URL);
async function rollback(db: Pick<DbClient, 'transaction'>, run: (tx: Query) => Promise<void>) {
  await expect(db.transaction(async tx => { await run(tx); throw Error('phase31 owned metadata rollback'); }))
    .rejects.toThrow('phase31 owned metadata rollback');
}
async function definitions(db: Query) {
  return Array.from(await db.execute(sql`SELECT oid::text,proname,proowner::text,proacl::text,prosrc,proconfig,procost
    FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace AND proname IN
      ('cinashop_runtime_admin_boundary_v1','cinashop_runtime_lock_only_v1',${AGENT_LEVEL_CATALOG_FENCE},${AGENT_LEVEL_ROW_GUARD})
    ORDER BY proname COLLATE "C",oid`));
}

describe.runIf(enabled)('Routine refund principal leaf with the commissioned base App/Admin catalog', () => {
  it('derives Admin from named source rather than extra ACLs, supports an absent Manager, and makes no changes', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No provider transport belongs to a principal catalog proof'));
    try {
      await routineRefundRuntimeFixture(async c => {
        const names = { maintenance: c.target.maintenance, app: c.target.app };
        expect(await c.f.db.execute(sql`SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${MANAGER_RUNTIME_ROLE}`)).toHaveLength(0);
        const before = await definitions(c.f.db), result = await inspectRoutineRefundActorPrincipals(c.f.db, names);
        expect(result).toMatchObject({ ready: true, failures: [], binding: { database: c.target.database,
          maintenance: c.target.maintenance, app: c.app.role, admin: c.admin.role, manager: null, managerOid: null } });
        const [actual] = await c.f.db.execute<{ appOid: string; adminOid: string; maintenanceOid: string; databaseOid: string }>(sql`SELECT
          (SELECT oid::text FROM pg_catalog.pg_roles WHERE rolname=${c.app.role}) AS "appOid",
          (SELECT oid::text FROM pg_catalog.pg_roles WHERE rolname=${c.admin.role}) AS "adminOid",
          (SELECT oid::text FROM pg_catalog.pg_roles WHERE rolname=${c.target.maintenance}) AS "maintenanceOid",
          (SELECT oid::text FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS "databaseOid"`);
        expect(result.binding).toMatchObject(actual);
        expect(await inspectRoutineRefundActorPrincipals(c.app.db, names)).toEqual(result);
        expect(await inspectRoutineRefundActorPrincipals(c.admin.db, names)).toEqual(result);
        if (!c.f.withRuntimeRole) throw Error('Independent lookalike LOGIN required');
        await c.f.withRuntimeRole(async lookalike => {
          await c.f.db.execute(sql`GRANT SELECT,INSERT ON public.admin_refund_operation TO ${sql.identifier(lookalike.role)}`);
          expect(await inspectRoutineRefundActorPrincipals(c.f.db, { ...names, admin: lookalike.role }))
            .toEqual({ ready: false, failures: ['named_candidates'], binding: null });
          expect(await inspectRoutineRefundActorPrincipals(lookalike.db, names)).toEqual(result);
        });
        expect(await definitions(c.f.db)).toEqual(before);
      }, false);
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  }, 180000);
});

describe.runIf(enabled)('Routine refund principal leaf with the complete conditional Cashier catalog', () => {
  let f: Full, names: RoutineRefundActorPrincipalNames;
  let network: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;
  beforeAll(async () => {
    network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Unexpected provider call during principal metadata validation'));
    f = await customerCashierRuntimeHttpFixture();
    names = { maintenance: f.target.maintenance, app: f.target.app, admin: f.target.admin };
  }, 180000);
  afterAll(async () => { try { if (f) await f.close(); } finally { network?.mockRestore(); } }, 30000);

  it('returns current exact OIDs consistently from all five independent LOGINs without writing business or catalog state', async () => {
    const before = await definitions(f.maintenanceDb), business = await f.facts();
    const result = await inspectRoutineRefundActorPrincipals(f.maintenanceDb, names);
    expect(result).toMatchObject({ ready: true, failures: [], binding: { database: f.target.database,
      maintenance: names.maintenance, app: names.app, admin: names.admin, manager: MANAGER_RUNTIME_ROLE } });
    const [actual] = await f.maintenanceDb.execute<{ managerOid: string }>(sql`SELECT oid::text AS "managerOid"
      FROM pg_catalog.pg_roles WHERE rolname=${MANAGER_RUNTIME_ROLE}`);
    expect(result.binding).toMatchObject(actual);
    for (const peer of [f.appRuntime, f.adminRuntime, f.financialRuntime, f.managerRuntime, f.cashierRuntime])
      expect(await inspectRoutineRefundActorPrincipals(peer.db, names)).toEqual(result);
    expect(await definitions(f.maintenanceDb)).toEqual(before); expect(await f.facts()).toEqual(business);
    expect(network).not.toHaveBeenCalled();
  });

  it('captures declarations before I/O and rejects getters or unknown fields without invoking a getter', async () => {
    const mutable = { ...names }, promise = inspectRoutineRefundActorPrincipals(f.maintenanceDb, mutable);
    mutable.app = 'changed_after_call'; mutable.admin = 'changed_after_call'; mutable.maintenance = 'changed_after_call';
    expect(await promise).toMatchObject({ ready: true, binding: { app: names.app, admin: names.admin, maintenance: names.maintenance } });
    let reads = 0;
    const getter = { maintenance: names.maintenance, get app() { reads++; return names.app; } };
    expect(await inspectRoutineRefundActorPrincipals(f.maintenanceDb, getter)).toEqual({ ready: false, failures: ['declaration'], binding: null });
    expect(reads).toBe(0);
    expect(await inspectRoutineRefundActorPrincipals(f.maintenanceDb, { ...names, unreviewed: true } as RoutineRefundActorPrincipalNames))
      .toEqual({ ready: false, failures: ['declaration'], binding: null });
    for (const reserved of [MANAGER_RUNTIME_ROLE, CUSTOMER_FINANCIAL_RUNTIME_ROLE])
      for (const key of ['maintenance', 'app', 'admin'] as const)
        expect(await inspectRoutineRefundActorPrincipals(f.maintenanceDb, { ...names, [key]: reserved }))
          .toEqual({ ready: false, failures: ['declaration'], binding: null });
  });

  it('rejects full-body, flags, owner and trigger drift rather than trusting the matching role prefix', async () => {
    const before = await definitions(f.maintenanceDb);
    const changes = [
      (tx: Query) => tx.execute(sql`ALTER FUNCTION public.cinashop_runtime_agent_level_catalog_fence_v1() COST 101`),
      async (tx: Query) => {
        const [row] = await tx.execute<{ ddl: string }>(sql`SELECT pg_catalog.pg_get_functiondef(
          'public.cinashop_runtime_agent_level_row_guard_v1()'::regprocedure) AS ddl`);
        const changed = row.ddl.replace("Invalid distributor row guard", "Changed distributor row guard");
        expect(changed).not.toBe(row.ddl); await tx.execute(sql.raw(changed));
      },
      (tx: Query) => tx.execute(sql`ALTER FUNCTION public.cinashop_runtime_agent_level_row_guard_v1() OWNER TO ${sql.identifier(f.target.app)}`),
      (tx: Query) => tx.execute(sql`ALTER TABLE public.agent_level DISABLE TRIGGER cinashop_runtime_agent_level_row_guard_v1`),
    ];
    for (const change of changes) await rollback(f.maintenanceDb, async tx => {
      await change(tx);
      expect(await inspectRoutineRefundActorPrincipals(tx, names)).toMatchObject({ ready: false, binding: null });
    });
    expect(await definitions(f.maintenanceDb)).toEqual(before);
    expect(await inspectRoutineRefundActorPrincipals(f.maintenanceDb, names)).toMatchObject({ ready: true });
  });

  it('rejects disagreement between Agent candidates and the independent named staff/lock bodies', async () => {
    await rollback(f.maintenanceDb, async tx => {
      for (const name of [AGENT_LEVEL_CATALOG_FENCE, AGENT_LEVEL_ROW_GUARD]) {
        const [row] = await tx.execute<{ ddl: string }>(sql`SELECT pg_catalog.pg_get_functiondef(
          pg_catalog.to_regprocedure(${'public.' + name + '()'})) AS ddl`);
        const changed = row.ddl.replaceAll(`'${names.admin}'`, `'${CUSTOMER_FINANCIAL_RUNTIME_ROLE}'`);
        expect(changed).not.toBe(row.ddl); await tx.execute(sql.raw(changed));
      }
      expect(await inspectRoutineRefundActorPrincipals(tx, { maintenance: names.maintenance, app: names.app }))
        .toMatchObject({ ready: false, failures: ['named_candidates'], binding: null });
    });
    await rollback(f.maintenanceDb, async tx => {
      const [row] = await tx.execute<{ ddl: string }>(sql`SELECT pg_catalog.pg_get_functiondef(
        'public.cinashop_runtime_agent_level_row_guard_v1()'::regprocedure) AS ddl`);
      const changed = row.ddl.replaceAll(`'${names.admin}'`, `'${f.financialRuntime.role}'`);
      expect(changed).not.toBe(row.ddl); await tx.execute(sql.raw(changed));
      expect(await inspectRoutineRefundActorPrincipals(tx, names)).toMatchObject({ ready: false, failures: ['named_candidates'], binding: null });
    });
    await rollback(f.maintenanceDb, async tx => {
      const [row] = await tx.execute<{ ddl: string }>(sql`SELECT pg_catalog.pg_get_functiondef(
        'public.cinashop_runtime_admin_boundary_v1()'::regprocedure) AS ddl`);
      const changed = row.ddl.replace('Application identity cannot rewrite platform authority', 'Changed staff boundary');
      expect(changed).not.toBe(row.ddl); await tx.execute(sql.raw(changed));
      expect(await inspectRoutineRefundActorPrincipals(tx, names)).toMatchObject({ ready: false, failures: ['staff_boundary'], binding: null });
    });
  });

  it('rejects a reversed attachment outside the named target tables', async () => {
    await rollback(f.maintenanceDb, async tx => {
      await tx.execute(sql`CREATE TABLE public.phase31_actor_attachment_probe(id integer)`);
      await tx.execute(sql`CREATE TRIGGER phase31_actor_attachment_probe BEFORE INSERT OR UPDATE OR DELETE
        ON public.phase31_actor_attachment_probe FOR EACH ROW EXECUTE FUNCTION public.cinashop_runtime_admin_boundary_v1()`);
      expect(await inspectRoutineRefundActorPrincipals(tx, names)).toMatchObject({ ready: false, failures: ['trigger_closure'], binding: null });
    });
  });

  it('uses actual public/catalog OIDs despite TEMP table shadowing', async () => {
    await rollback(f.maintenanceDb, async tx => {
      const before = await inspectRoutineRefundActorPrincipals(tx, names); expect(before.ready).toBe(true);
      await tx.execute(sql`CREATE TEMP TABLE pg_roles(rolname text,oid oid)`);
      await tx.execute(sql`CREATE TEMP TABLE pg_proc(proname text,prosrc text)`);
      await tx.execute(sql`CREATE TEMP TABLE pg_trigger(tgname text)`);
      await tx.execute(sql`CREATE TEMP TABLE system_admin(id integer)`);
      await tx.execute(sql`CREATE TEMP TABLE agent_level(id integer)`);
      await tx.execute(sql`SET LOCAL search_path=pg_temp,public,pg_catalog`);
      // Caller/public-resolution authorization is deliberately outside this
      // metadata leaf. Its public objects remain the same genuine objects.
      expect(await inspectRoutineRefundActorPrincipals(tx, names)).toEqual(before);
    });
  });

  it('rejects a stale conditional Cashier OID/name and a present but disabled fixed Manager', async () => {
    await rollback(f.maintenanceDb, async tx => {
      await tx.execute(sql`ALTER ROLE ${sql.identifier(f.cashierRuntime.role)} RENAME TO phase31_renamed_owned_cashier`);
      expect(await inspectRoutineRefundActorPrincipals(tx, names)).toMatchObject({ ready: false, failures: ['principal_roles'], binding: null });
    });
    await rollback(f.maintenanceDb, async tx => {
      await tx.execute(sql`ALTER ROLE ${sql.identifier(MANAGER_RUNTIME_ROLE)} NOLOGIN`);
      expect(await inspectRoutineRefundActorPrincipals(tx, names)).toMatchObject({ ready: false, failures: ['principal_roles'], binding: null });
    });
    expect(await inspectRoutineRefundActorPrincipals(f.maintenanceDb, names)).toMatchObject({ ready: true });
    expect(network).not.toHaveBeenCalled();
  });
});
