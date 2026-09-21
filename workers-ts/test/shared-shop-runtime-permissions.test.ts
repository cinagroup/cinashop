import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { checkoutPricingMigrationDatabase } from './helpers/checkoutPricingMigrationDatabase';
import { runOfflineOrderSchema } from '../src/migrations/runOfflineOrder';
import { runBrokeragePaidOrderFence } from '../src/migrations/runBrokeragePaidOrderFence';
import { installCheckoutPricingLock } from '../src/migrations/checkoutPricingLock';
import { offlineRuntimeGrantPlan } from '../src/migrations/offlineOrderRuntimeContract';
import { auditCheckoutRuntimePermissions } from '../src/migrations/auditPaidOrderRuntimePermissions';
import { auditOfflineOrderRuntimePermissions } from '../src/migrations/auditOfflineOrderRuntimePermissions';

describe('explicit shared shop role pricing capabilities PG16', () => {
  let f: Awaited<ReturnType<typeof checkoutPricingMigrationDatabase>>, ddl: string;
  beforeAll(async () => {
    if (!process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Owned native PG16 required');
    const kit = await import('drizzle-kit/api'), models = await import('../src/models/schema');
    ddl = (await kit.generateMigration(kit.generateDrizzleJson({}), kit.generateDrizzleJson(models))).join('\n');
  }, 30000);
  beforeEach(async () => {
    f = await checkoutPricingMigrationDatabase(); await f.exec(ddl);
    await runOfflineOrderSchema(f.db, true); await runBrokeragePaidOrderFence(f.db);
    await installCheckoutPricingLock(f.db, f.pricingOwner);
  }, 30000);
  afterEach(async () => { await f?.close(); }, 30000);
  const withRole = async (body: (r: Parameters<NonNullable<typeof f.withRuntimeRole>>[0] extends (p: infer P) => unknown ? P : never) => Promise<void>) => {
    await f.withRuntimeRole!(async r => {
      await f.exec(offlineRuntimeGrantPlan(r.role));
      await f.exec(`GRANT SELECT,INSERT,UPDATE ON public.store_order TO "${r.role}";
        GRANT EXECUTE ON FUNCTION public.checkout_lock_pricing_v1() TO "${r.role}"`);
      await body(r);
    });
  };
  const catalog = () => f.db.execute(sql`SELECT 'table' AS kind, oid::text, to_jsonb(c)::text AS value FROM pg_class c WHERE relnamespace='public'::regnamespace
    UNION ALL SELECT 'function', oid::text, to_jsonb(p)::text FROM pg_proc p WHERE pronamespace='public'::regnamespace ORDER BY kind,oid`);
  it('requires explicit shared scope; verifies both exact capabilities with an independently authenticated LOGIN', async () => {
    await withRole(async r => {
      expect((await auditCheckoutRuntimePermissions(r.db)).ready).toBe(false);
      expect((await auditOfflineOrderRuntimePermissions(r.db)).ready).toBe(false);
      const before = await catalog();
      await f.withPeer!(async writer => {
        await writer.exec('BEGIN; LOCK TABLE public.member_right IN ROW EXCLUSIVE MODE');
        try {
          expect(await auditCheckoutRuntimePermissions(r.db, 'public', 'shared-shop')).toMatchObject({ ready: true, failures: [] });
          expect(await auditOfflineOrderRuntimePermissions(r.db, 'shared-shop')).toMatchObject({ ready: true, failures: [] });
        } finally { await writer.exec('ROLLBACK'); }
      });
      expect(await catalog()).toEqual(before);
    });
  });
  it.each([
    "ALTER FUNCTION public.ooa_lock_pricing() RESET search_path",
    "GRANT EXECUTE ON FUNCTION public.ooa_lock_pricing() TO PUBLIC",
    "CREATE FUNCTION public.ooa_lock_pricing(integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS 'BEGIN NULL; END'",
    "ALTER TABLE public.offline_order_admission DISABLE TRIGGER USER",
    "ALTER FUNCTION public.checkout_lock_pricing_v1() SECURITY INVOKER",
    "GRANT EXECUTE ON FUNCTION public.checkout_lock_pricing_v1() TO PUBLIC",
    "ALTER ROLE OWNER LOGIN",
    "GRANT UPDATE(value) ON public.system_config TO RUNTIME",
    "CREATE SCHEMA shared_probe; CREATE FUNCTION shared_probe.ooa_lock_pricing() RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS 'BEGIN NULL; END'",
  ])('rejects protocol, ACL, owner, caller or second-schema drift: %s', async statement => {
    await withRole(async r => {
      await f.exec(statement.replaceAll('OWNER', '"' + f.pricingOwner + '"').replaceAll('RUNTIME', '"' + r.role + '"'));
      const before = await catalog();
      expect((await auditCheckoutRuntimePermissions(r.db, 'public', 'shared-shop')).ready).toBe(false);
      expect((await auditOfflineOrderRuntimePermissions(r.db, 'shared-shop')).ready).toBe(false);
      expect(await catalog()).toEqual(before);
    });
  });
  it('still rejects maintenance identity hidden with SET ROLE', async () => {
    await withRole(async r => {
      await f.exec('SET ROLE "' + r.role + '"');
      try {
        expect((await auditCheckoutRuntimePermissions(f.db, 'public', 'shared-shop')).ready).toBe(false);
        expect((await auditOfflineOrderRuntimePermissions(f.db, 'shared-shop')).ready).toBe(false);
      } finally { await f.exec('RESET ROLE'); }
    });
  });
});
