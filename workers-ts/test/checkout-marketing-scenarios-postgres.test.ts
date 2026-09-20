import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withCheckoutPricingScenarioDatabase, checkoutScenarioPublicState } from './helpers/checkoutPricingScenarioDatabase';
import { runFirstOrderDiscountPostgresScenario } from './integration/FirstOrderDiscountPostgresScenario';
import { runDiscountPackagePostgresScenario } from './integration/DiscountPackagePostgresScenario';
import { inspectCheckoutPricingLock } from '../src/migrations/checkoutPricingLock';

const scenarios = [
  { name: 'first-order', run: runFirstOrderDiscountPostgresScenario },
  { name: 'package', run: runDiscountPackagePostgresScenario },
] as const;

describe.each(scenarios)('$name scenario maintenance boundary', ({ run }) => {
  it('refuses missing or unsafe owners before connecting', async () => {
    await expect(run('not-a-database-url')).rejects.toThrow('explicit clone pricing owner');
    await expect(run('not-a-database-url', 'pg_database_owner')).rejects.toThrow('Invalid explicit pricing capability identifier');
  });
});

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('complete cloned marketing checkout scenarios on local PG16', () => {
  describe.each(scenarios)('$name native owner rejection and cleanup', ({ run }) => {
    it.each(['login', 'public-owner'] as const)('refuses %s without changing public or retaining a clone', async kind => {
      await withCheckoutPricingScenarioDatabase(async (url, owner, fixture) => {
        const before = await checkoutScenarioPublicState(fixture);
        const protocolBefore = await inspectCheckoutPricingLock(fixture.db);
        if (kind === 'login') await fixture.exec(`ALTER ROLE "${owner}" LOGIN`);
        await expect(run(url, kind === 'login' ? owner : fixture.pricingOwner)).rejects.toThrow(kind === 'login'
          ? 'Pricing capability owner must be a separate restricted NOLOGIN role' : 'Pricing capability final verification failed');
        expect(await checkoutScenarioPublicState(fixture)).toEqual(before);
        expect(await inspectCheckoutPricingLock(fixture.db)).toEqual(protocolBefore);
        expect(await fixture.db.execute(sql`SELECT nspname FROM pg_namespace
          WHERE nspname LIKE 'codex_first_order_it_%' OR nspname LIKE 'codex_discount_it_%'`)).toHaveLength(0);
      });
    }, 180_000);
  });
  it('preserves the PHP first-order cap, coupon exclusion, cancellation and concurrent single winner', async () => {
    await withCheckoutPricingScenarioDatabase(async (url, owner, fixture) => {
      const before = await checkoutScenarioPublicState(fixture);
      const report = await runFirstOrderDiscountPostgresScenario(url, owner);
      expect(report).toMatchObject({ schema_created: true, schema_removed: true, public_state_unchanged: true,
        capped_coupon_exclusion: { first_order_price: '15.00', coupon_price: '0.00', pay_price: '185.00', coupon_untouched: true },
        cancellation_non_restore: { qualification_still_consumed: true, next_pay_price: '95.00', coupon_reserved: true },
        paid_and_expired_disqualification: { both_full_price: true },
        concurrent_single_winner: { successes: 2, exactly_one_discounted: true },
        rollback_preserves_qualification: { business_rejected: true, qualification_available: true, cart_unclaimed: true, orders: 0 },
      });
      expect(await checkoutScenarioPublicState(fixture)).toEqual(before);
      expect(await fixture.db.execute(sql`SELECT nspname FROM pg_namespace WHERE nspname LIKE 'codex_first_order_it_%'`)).toHaveLength(0);
    });
  }, 180_000);

  it('preserves package price, selection, concurrent quota, rollback and partial/full refund assertions', async () => {
    await withCheckoutPricingScenarioDatabase(async (url, owner, fixture) => {
      const before = await checkoutScenarioPublicState(fixture);
      const report = await runDiscountPackagePostgresScenario(url, owner);
      expect(report).toMatchObject({ schema_created: true, schema_removed: true, public_state_unchanged: true,
        fixed_order_cancel: { total_price: '15.75', postage: '0.00', limit_reserved_once: true, resources_restored: true },
        mix_validation: { missing_required_rejected: true, minimum_two_rejected: true, valid_cart_rows: 2 },
        concurrent_limit: { successes: 1, rejections: 1, business_rejected: true, limit_num: 0 },
        forced_failure_rollback: { rejected: true, orders: 0, claimed_carts: 0, limit_num: 1, stock_decrements: 0 },
        partial_full_refund: { partial_limit_held: true, final_limit_restored_once: true, fully_refunded: true, stock_restored: true, refund_rows: 2 },
        non_refundable: { application_rejected: true, snapshot_blocked: true, refund_rows: 0 },
      });
      expect(await checkoutScenarioPublicState(fixture)).toEqual(before);
      expect(await fixture.db.execute(sql`SELECT nspname FROM pg_namespace WHERE nspname LIKE 'codex_discount_it_%'`)).toHaveLength(0);
    });
  }, 180_000);
});
