import { afterEach,beforeEach,describe,expect,it } from 'vitest';
import { readFileSync } from 'node:fs';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';
import { inspectTestReleaseSchemaUpgrade,runTestReleaseSchemaUpgrade } from '../src/migrations/runTestReleaseSchemaUpgrade';
import { inspectTestReleaseCoreSchemaUpgrade,runTestReleaseCoreSchemaUpgrade } from '../src/migrations/runTestReleaseCoreSchemaUpgrade';
import * as models from '../src/models/schema';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('fixed 0146–0151 online-test schema bundle',()=>{
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  beforeEach(async()=>{
    f=await sequenceRunnerDatabase();
    const api=await import('drizzle-kit/api');
    await f.exec((await api.generateMigration(api.generateDrizzleJson({}),api.generateDrizzleJson(models))).join('\n'));
    await f.exec('DROP INDEX sor_pink_recovery_scan,prc_callback_event,spr_order_cart_info,wcao_client_ref; ALTER TABLE store_cart DROP CONSTRAINT sc_bargain_participation_ck; ALTER TABLE store_cart DROP bargain_user_id; INSERT INTO store_cart DEFAULT VALUES');
  },30_000);
  afterEach(async()=>{ await f?.close(); });
  it('atomically installs all six existing contracts with unchanged data and an idempotent repeat',async()=>{
    const before=await inspectTestReleaseSchemaUpgrade(f.db);
    expect(before).toMatchObject({ supported:true,ready:false,withinBudget:true });
    const first=await runTestReleaseSchemaUpgrade(f.db);
    expect(first).toMatchObject({ applied:true,ready:true,before:before.fingerprint,after:before.fingerprint });
    expect(first.before.tables).toHaveLength(9);
    const after=await inspectTestReleaseSchemaUpgrade(f.db);
    expect(after).toMatchObject({ ready:true,fingerprint:first.after });
    expect(await runTestReleaseSchemaUpgrade(f.db)).toMatchObject({ applied:false,ready:true,before:first.after,after:first.after });
    expect(await inspectTestReleaseSchemaUpgrade(f.db)).toEqual(after);
  });
  it('rolls back all earlier increments on a late existing function drift',async()=>{
    await f.exec("CREATE FUNCTION coupon_product_scope_fence_0151() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NULL; END'");
    const before=await inspectTestReleaseSchemaUpgrade(f.db);
    await expect(runTestReleaseSchemaUpgrade(f.db)).rejects.toThrow('existing fence function drift');
    expect(await inspectTestReleaseSchemaUpgrade(f.db)).toEqual(before);
  });
  it('preserves orphan test orders, explicitly excludes 0150, and never claims full readiness',async()=>{
    await f.exec("INSERT INTO store_order(order_id,uid,pid,paid,pay_price) VALUES('orphan-test',987654,0,1,12.34)");
    const before=await inspectTestReleaseSchemaUpgrade(f.db);
    expect(before.diagnostics?.dangling_paid_users).toBe(1);
    await expect(runTestReleaseSchemaUpgrade(f.db)).rejects.toThrow('dangling paid-order users');
    expect(await inspectTestReleaseSchemaUpgrade(f.db)).toEqual(before);
    expect(await runTestReleaseCoreSchemaUpgrade(f.db)).toMatchObject({ applied:true,ready:true,excluded:['0150-brokerage-paid-order-fence'],before:before.fingerprint,after:before.fingerprint });
    expect(await inspectTestReleaseCoreSchemaUpgrade(f.db)).toMatchObject({ ready:true,excluded:['0150-brokerage-paid-order-fence'],fingerprint:before.fingerprint });
    expect((await inspectTestReleaseSchemaUpgrade(f.db)).ready).toBe(false);
    expect(await runTestReleaseCoreSchemaUpgrade(f.db)).toMatchObject({ applied:false,before:before.fingerprint,after:before.fingerprint });
  });
  it('refuses competing locks without retaining locks on earlier tables',async()=>{
    if (!f.withPeer) throw new Error('Real PostgreSQL backend required');
    const before=await inspectTestReleaseSchemaUpgrade(f.db);
    await f.withPeer(async p=>{
      await p.exec('BEGIN');
      try {
        await p.exec('LOCK TABLE store_cart IN ROW EXCLUSIVE MODE');
        await expect(runTestReleaseSchemaUpgrade(f.db)).rejects.toMatchObject({ code:'55P03' });
        await p.exec('LOCK TABLE payment_reconciliation_case IN ACCESS EXCLUSIVE MODE NOWAIT');
      } finally { await p.exec('ROLLBACK'); }
    });
    expect(await inspectTestReleaseSchemaUpgrade(f.db)).toEqual(before);
  });
  it('refuses RLS before acquiring maintenance locks or modifying schema',async()=>{
    await f.exec('ALTER TABLE store_cart ENABLE ROW LEVEL SECURITY');
    expect(await inspectTestReleaseSchemaUpgrade(f.db)).toMatchObject({ supported:false,ready:false,fingerprint:null });
    await expect(runTestReleaseSchemaUpgrade(f.db)).rejects.toThrow('prerequisite drift');
  });
  it('shares the generated diagnostic bindings and requires explicit operation',()=>{
    const read=JSON.parse(readFileSync('test/integration/paid-runtime-audit.wrangler.jsonc','utf8'));
    const write=JSON.parse(readFileSync('test/integration/test-release-schema-migrate.wrangler.jsonc','utf8'));
    expect(write.vars).toEqual(read.vars); expect(write.hyperdrive).toEqual(read.hyperdrive);
    expect(readFileSync('scripts/run-test-release-schema-production-migration.ps1','utf8')).toContain('0146-0151-test-release-schema');
  });
});
