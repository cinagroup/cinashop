import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { PRODUCT_SKU_RETIREMENT_SQL } from '@/migrations/productSkuRetirement';
import { PRODUCT_RECYCLE_SKU_GUARD_SQL, PRODUCT_RECYCLE_SKU_GUARD, PRODUCT_RECYCLE_SKU_LEGACY_GUARD, PRODUCT_PERMANENT_DELETE_LOG_GUARD,
  assertProductRecycleSkuGuardReady, inspectProductRecycleSkuGuard, installProductRecycleSkuGuard } from '@/migrations/productRecycleSkuGuard';
import { MANAGER_PUBLIC_INVOKER_BASELINE } from '@/migrations/managerRuntimePrivilegePlan';
import { supplierProductRecycleFixture, seedSupplierRecycle, supplierRecycleSnapshot, supplierRecycleActor } from './helpers/supplierProductRecycle';
import type { DbClient } from '@/lib/di';
function deepest(error: unknown): { message?: string; code?: string } {
  let value = error;
  for (let depth = 0; depth < 8 && value && typeof value === 'object' && 'cause' in value && value.cause; depth++) value = value.cause;
  return value && typeof value === 'object' ? value as { message?: string; code?: string } : {};
}
function deepestMessage(error: unknown) { return deepest(error).message ?? ''; }
async function fact(tx: DbClient, id = 302) {
  return tx.execute(sql`INSERT INTO public.store_product_sku_retirement_log
    (product_id,sku_id,unique_snapshot,suk_snapshot,action,actor_id,dependency_snapshot,add_time)
    SELECT p.id,s.id,s."unique",s.suk,'permanent_delete',21,
      jsonb_build_object('version',1,'kind','supplier_product_permanent_delete','owner_type',2,'supplier_id',p.relation_id,'product_type',p.product_type)::text,10
      FROM public.store_product p JOIN public.store_product_attr_value s ON s.product_id=p.id WHERE s.id=${id} RETURNING id`);
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('independent 0189 exact predecessor/successor retirement guard on real PG16', () => {
  let f: Awaited<ReturnType<typeof supplierProductRecycleFixture>>;
  beforeAll(async () => { f = await supplierProductRecycleFixture(false); }, 60000);
  beforeEach(async () => {
    await f.reset(); await seedSupplierRecycle(f.db);
    // A new test starts at the historical contract. CREATE OR REPLACE retains
    // function ACL, so restore its actual source-default PUBLIC ACL explicitly.
    await f.exec(PRODUCT_SKU_RETIREMENT_SQL);
    await f.exec('DROP TRIGGER IF EXISTS spsrl_permanent_rows ON public.store_product_sku_retirement_log; DROP TRIGGER IF EXISTS spsrl_permanent_truncate ON public.store_product_sku_retirement_log; DROP FUNCTION IF EXISTS public.guard_product_permanent_delete_log()');
    await f.exec('ALTER FUNCTION public.guard_retired_product_sku() RESET ALL; GRANT EXECUTE ON FUNCTION public.guard_retired_product_sku() TO PUBLIC');
  }, 30000);
  afterAll(async () => { await f?.close(); }, 30000);
  const identity = () => f.db.execute(sql`SELECT p.oid::text, p.prosrc,p.proconfig,p.proacl::text AS acl,
    encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex') AS fingerprint,
    (SELECT oid::text FROM pg_trigger WHERE tgname='store_product_attr_value_retired_guard' AND tgrelid='public.store_product_attr_value'::regclass) AS trigger_oid
    FROM pg_proc p WHERE p.oid='public.guard_retired_product_sku()'::regprocedure`);

  it('pins the unchanged historical body and installs only the explicit successor with the exact SQL mirror and stable object identities', async () => {
    const before = await supplierRecycleSnapshot(f.db), [old] = await identity();
    expect(old.prosrc).toBe(PRODUCT_RECYCLE_SKU_LEGACY_GUARD);
    expect(old.fingerprint).toBe(MANAGER_PUBLIC_INVOKER_BASELINE['guard_retired_product_sku()']);
    expect(readFileSync(resolve(import.meta.dirname, '../src/migrations/maintenance/0189_product_recycle_sku_guard.sql'), 'utf8').split('\n').slice(1).join('\n')).toBe(PRODUCT_RECYCLE_SKU_GUARD_SQL);
    expect(await f.db.transaction(tx => installProductRecycleSkuGuard(tx))).toEqual({ applied: true });
    const [current] = await identity(); expect(current.oid).toBe(old.oid); expect(current.trigger_oid).toBe(old.trigger_oid);
    expect(current.prosrc).toBe(PRODUCT_RECYCLE_SKU_GUARD); expect(current.proconfig).toEqual(['search_path=pg_catalog']);
    expect((await inspectProductRecycleSkuGuard(f.db))?.ready).toBe(true);
    expect(await f.db.transaction(tx => installProductRecycleSkuGuard(tx))).toEqual({ applied: false });
    expect(await supplierRecycleSnapshot(f.db)).toEqual(before);
    console.log('PRODUCT_RECYCLE_SKU_GUARD_NATIVE_FINGERPRINT', current.fingerprint);
    const bootstrap = readFileSync(resolve(import.meta.dirname, '../src/services/MigrationService.ts'), 'utf8');
    expect(bootstrap).not.toContain('productRecycleSkuGuard');
    expect(readFileSync(resolve(import.meta.dirname, '../src/migrations/productSkuRetirement.ts'), 'utf8')).not.toContain('TG_TABLE_SCHEMA');
  });

  it('refuses the missing successor at runtime without performing any request-time repair or row write', async () => {
    const before = await identity(), rows = await supplierRecycleSnapshot(f.db);
    await expect(f.db.transaction(tx => assertProductRecycleSkuGuardReady(tx))).rejects.toMatchObject({ httpStatus: 503 });
    await expect(f.service.thorough(81, supplierRecycleActor())).rejects.toMatchObject({ httpStatus: 503 });
    expect(await identity()).toEqual(before); expect(await supplierRecycleSnapshot(f.db)).toEqual(rows);
  });

  it('rejects unsupported maintenance contexts and preserves every old object and row', async () => {
    const before = await identity(), rows = await supplierRecycleSnapshot(f.db);
    await expect(installProductRecycleSkuGuard(f.db)).rejects.toSatisfy((error: unknown) => deepestMessage(error).includes('transaction'));
    await expect(f.db.transaction(tx => installProductRecycleSkuGuard(tx), { isolationLevel: 'repeatable read' })).rejects.toSatisfy((error: unknown) => deepestMessage(error).includes('PG16'));
    await expect(f.db.transaction(tx => installProductRecycleSkuGuard(tx), { accessMode: 'read only' })).rejects.toSatisfy((error: unknown) => deepestMessage(error).includes('PG16'));
    await expect(f.db.transaction(async tx => { await tx.execute(sql`SET LOCAL session_replication_role='replica'`); await installProductRecycleSkuGuard(tx); })).rejects.toSatisfy((error: unknown) => deepestMessage(error).includes('PG16'));
    await expect(f.db.transaction(async tx => { await tx.execute(sql`SET LOCAL search_path=pg_catalog`); await installProductRecycleSkuGuard(tx); })).rejects.toSatisfy((error: unknown) => deepestMessage(error).includes('PG16'));
    expect(await identity()).toEqual(before); expect(await supplierRecycleSnapshot(f.db)).toEqual(rows);
  });

  it('rejects altered function text, attributes, PUBLIC ACL and disabled or extra guard trigger bindings rather than adopting or repairing them', async () => {
    const drifts = [
      `CREATE OR REPLACE FUNCTION public.guard_retired_product_sku() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN OLD; END$$`,
      'ALTER FUNCTION public.guard_retired_product_sku() SECURITY DEFINER',
      "ALTER FUNCTION public.guard_retired_product_sku() SET search_path=public",
      'REVOKE ALL ON FUNCTION public.guard_retired_product_sku() FROM PUBLIC',
      'ALTER TABLE public.store_product_attr_value DISABLE TRIGGER store_product_attr_value_retired_guard',
      'CREATE TRIGGER unexpected_retired_guard BEFORE DELETE ON public.store_product_attr_value FOR EACH ROW EXECUTE FUNCTION public.guard_retired_product_sku()',
    ];
    const before = await identity(), rows = await supplierRecycleSnapshot(f.db);
    for (const drift of drifts) {
      await expect(f.db.transaction(async tx => { await tx.execute(sql.raw(drift)); await installProductRecycleSkuGuard(tx); })).rejects.toSatisfy((error: unknown) => deepestMessage(error).includes('drift'));
      expect(await identity()).toEqual(before); expect(await supplierRecycleSnapshot(f.db)).toEqual(rows);
    }
  });

  it('rejects RLS, table identity/column and enabled event-trigger drift without modifying the historical guard', async () => {
    const before = await identity();
    for (const drift of [
      'ALTER TABLE public.store_product ENABLE ROW LEVEL SECURITY',
      'ALTER TABLE public.store_product_attr_value ENABLE ROW LEVEL SECURITY',
      'ALTER TABLE public.store_product_attr_value RENAME COLUMN is_retired TO drifted_retirement',
      'ALTER TABLE public.store_product RENAME COLUMN id TO drifted_product_id',
    ]) {
      await expect(f.db.transaction(async tx => { await tx.execute(sql.raw(drift)); await installProductRecycleSkuGuard(tx); })).rejects.toSatisfy((error: unknown) => deepestMessage(error).includes('drift'));
      expect(await identity()).toEqual(before);
    }
    await expect(f.db.transaction(async tx => {
      await tx.execute(sql.raw("CREATE FUNCTION recycle_event() RETURNS event_trigger LANGUAGE plpgsql AS $$BEGIN END$$; CREATE EVENT TRIGGER recycle_event ON ddl_command_start EXECUTE FUNCTION recycle_event()"));
      await installProductRecycleSkuGuard(tx);
    })).rejects.toSatisfy((error: unknown) => deepestMessage(error).includes('PG16'));
    expect(await identity()).toEqual(before);
  });

  it('retains every old identity and stock rule while the root exists and allows only type-zero orphan retirement deletion after its root is removed', async () => {
    await f.db.transaction(tx => installProductRecycleSkuGuard(tx));
    const before = await supplierRecycleSnapshot(f.db);
    for (const statement of [
      'DELETE FROM store_product_attr_value WHERE id=302',
      'UPDATE store_product_attr_value SET product_id=80 WHERE id=302',
      'UPDATE store_product_attr_value SET type=1 WHERE id=302',
      "UPDATE store_product_attr_value SET suk='changed' WHERE id=302",
      "UPDATE store_product_attr_value SET \"unique\"='changed1' WHERE id=302",
      'UPDATE store_product_attr_value SET stock=stock-1 WHERE id=302',
    ]) await expect(f.exec(statement)).rejects.toSatisfy((error: unknown) => deepestMessage(error).includes('retired product SKU'));
    expect(await supplierRecycleSnapshot(f.db)).toEqual(before);
    await expect(f.db.transaction(async tx => {
      await fact(tx as unknown as DbClient);
      await tx.execute(sql`DELETE FROM public.store_product WHERE id=81`);
      expect(await tx.execute(sql`DELETE FROM public.store_product_attr_value WHERE id=302 RETURNING id`)).toEqual([{ id: 302 }]);
      await tx.execute(sql`DELETE FROM public.store_product_attr_value WHERE id=303`);
    })).rejects.toSatisfy((error: unknown) => deepestMessage(error).includes('retired product SKU cannot be deleted'));
    expect(await supplierRecycleSnapshot(f.db)).toEqual(before);
    await f.db.transaction(async tx => {
      await fact(tx as unknown as DbClient);
      await tx.execute(sql`DELETE FROM public.store_product WHERE id=81`);
      expect(await tx.execute(sql`DELETE FROM public.store_product_attr_value WHERE id=302 RETURNING id`)).toEqual([{ id: 302 }]);
    });
    expect(await f.db.execute(sql`SELECT id FROM public.store_product_sku_retirement_log WHERE sku_id=302 AND action='retire'`)).toEqual([{ id: 601 }]);
  });

  it('uses actual public operands even when a temp shadow is supplied and refuses successor function or ACL drift at runtime', async () => {
    await f.db.transaction(tx => installProductRecycleSkuGuard(tx));
    const before = await identity();
    await expect(f.db.transaction(async tx => {
      await tx.execute(sql`CREATE TEMP TABLE store_product(id integer)`);
      await tx.execute(sql`SET LOCAL search_path=pg_temp,public`);
      // The real public root still exists, so a shadow empty table cannot
      // turn a retained SKU into an orphan and authorize its destruction.
      await tx.execute(sql`DELETE FROM public.store_product_attr_value WHERE id=302`);
    })).rejects.toSatisfy((error: unknown) => deepestMessage(error).includes('retired product SKU cannot be deleted'));
    for (const drift of ['GRANT EXECUTE ON FUNCTION public.guard_retired_product_sku() TO PUBLIC', 'ALTER FUNCTION public.guard_retired_product_sku() RESET ALL']) {
      await expect(f.db.transaction(async tx => { await tx.execute(sql.raw(drift)); await assertProductRecycleSkuGuardReady(tx); })).rejects.toMatchObject({ httpStatus: 503 });
      expect(await identity()).toEqual(before);
    }
    const [publicExecute] = await f.db.execute(sql`SELECT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
      WHERE p.oid='public.guard_retired_product_sku()'::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE') AS allowed`);
    expect(publicExecute.allowed).toBe(false); // no new executable routine is added to the immutable manager baseline
  });

  it('protects permanent facts against forged source identity, duplicate SKU, UPDATE, DELETE and TRUNCATE while preserving ordinary retirement actions', async () => {
    await f.db.transaction(tx => installProductRecycleSkuGuard(tx));
    const before = await supplierRecycleSnapshot(f.db);
    await f.db.transaction(tx => fact(tx as unknown as DbClient));
    const [guard] = await f.db.execute(sql`SELECT prosrc FROM pg_proc WHERE oid='public.guard_product_permanent_delete_log()'::regprocedure`);
    expect(guard.prosrc).toBe(PRODUCT_PERMANENT_DELETE_LOG_GUARD);
    await expect(f.db.transaction(tx => fact(tx as unknown as DbClient))).rejects.toSatisfy((error: unknown) => deepestMessage(error).includes('already exists'));
    for (const statement of [
      "UPDATE store_product_sku_retirement_log SET reason='changed' WHERE action='permanent_delete'",
      "UPDATE store_product_sku_retirement_log SET action='retire' WHERE action='permanent_delete'",
      "UPDATE store_product_sku_retirement_log SET action='permanent_delete' WHERE id=601",
      "DELETE FROM store_product_sku_retirement_log WHERE action='permanent_delete'",
      'TRUNCATE public.store_product_sku_retirement_log',
    ]) await expect(f.exec(statement)).rejects.toSatisfy((error: unknown) => deepestMessage(error).includes('Permanent product deletion facts'));
    await expect(f.exec(`INSERT INTO store_product_sku_retirement_log(product_id,sku_id,unique_snapshot,suk_snapshot,action,actor_id,dependency_snapshot)
      VALUES(81,301,'wrong001','','permanent_delete',21,'{"version":1,"kind":"supplier_product_permanent_delete","owner_type":2,"supplier_id":20,"product_type":1}')`)).rejects.toSatisfy((error: unknown) => deepestMessage(error).includes('does not match'));
    await expect(f.exec(`INSERT INTO store_product_sku_retirement_log(product_id,sku_id,unique_snapshot,suk_snapshot,action,actor_id,dependency_snapshot)
      VALUES(81,301,'card0001','','permanent_delete',21,'{"version":1,"kind":"supplier_product_permanent_delete","owner_type":2,"supplier_id":30,"product_type":1}')`)).rejects.toSatisfy((error: unknown) => deepestMessage(error).includes('does not match'));
    await f.exec("UPDATE store_product_sku_retirement_log SET reason='ordinary edit remains supported' WHERE id=601");
    const after = await supplierRecycleSnapshot(f.db);
    for (const name of Object.keys(before).filter(name => name !== 'store_product_sku_retirement_log')) expect(after[name]).toEqual(before[name]);
  });

  it('refuses partial log guard installations, preexisting unprotected facts and changed successor metadata without repairing them', async () => {
    const before = await identity();
    for (const statement of [
      "CREATE FUNCTION public.guard_product_permanent_delete_log() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$",
      "INSERT INTO store_product_sku_retirement_log(product_id,sku_id,action) VALUES(81,302,'permanent_delete')",
    ]) await expect(f.db.transaction(async tx => { await tx.execute(sql.raw(statement)); await installProductRecycleSkuGuard(tx); })).rejects.toSatisfy((error: unknown) => deepestMessage(error).includes('drift'));
    expect(await identity()).toEqual(before);
    await f.db.transaction(tx => installProductRecycleSkuGuard(tx));
    for (const statement of [
      'ALTER TABLE store_product_sku_retirement_log DISABLE TRIGGER spsrl_permanent_rows',
      'ALTER TABLE store_product_sku_retirement_log DISABLE TRIGGER spsrl_permanent_truncate',
      'GRANT EXECUTE ON FUNCTION public.guard_product_permanent_delete_log() TO PUBLIC',
      'ALTER FUNCTION public.guard_product_permanent_delete_log() SECURITY DEFINER',
      'ALTER TABLE store_product_sku_retirement_log ENABLE ROW LEVEL SECURITY',
    ]) await expect(f.db.transaction(async tx => { await tx.execute(sql.raw(statement)); await assertProductRecycleSkuGuardReady(tx); })).rejects.toMatchObject({ httpStatus: 503 });
  });

  it('refuses duplicate permanent facts while an independent INSERT holds the same real SKU identity reservation', async () => {
    await f.db.transaction(tx => installProductRecycleSkuGuard(tx));
    const { withFinancePeers } = await import('./helpers/financePeers');
    await withFinancePeers(f.db, async ([first, second]) => {
      await first.db.transaction(async tx => {
        await fact(tx as unknown as DbClient);
        await expect(second.db.transaction(peer => fact(peer as unknown as DbClient))).rejects.toSatisfy((error: unknown) => deepest(error).code === '55P03');
      });
      await expect(second.db.transaction(tx => fact(tx as unknown as DbClient))).rejects.toSatisfy((error: unknown) => deepest(error).code === '23505');
    });
  });

  it('holds the exact successor function/table identity through maintenance and refuses a concurrent physical catalog change', async () => {
    // A transaction-level table fence is exercised by runtime/native peers;
    // owner maintenance must also refuse a busy fixed advisory namespace.
    const { withFinancePeers } = await import('./helpers/financePeers');
    await withFinancePeers(f.db, async ([owner, blocker]) => {
      await blocker.exec('SELECT pg_advisory_lock(731627,13)');
      try { await expect(owner.db.transaction(tx => installProductRecycleSkuGuard(tx))).rejects.toSatisfy((error: unknown) => deepestMessage(error).includes('PG16')); }
      finally { await blocker.exec('SELECT pg_advisory_unlock(731627,13)'); }
      expect(await owner.db.transaction(tx => installProductRecycleSkuGuard(tx))).toEqual({ applied: true });
    });
  });
});
