import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { memberRight, systemConfig } from '../src/models/schema';
import { financePostgres } from './helpers/financePostgres';
import { checkoutPricingFixture } from './helpers/checkoutPricingFixture';
import { inspectCheckoutPricingLock } from '../src/migrations/checkoutPricingLock';
import { protectCheckoutPricingSources } from '../src/services/order/CheckoutPricingSources';
import { createContainerFromDb, withTx } from '../src/lib/di';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('explicit local checkout fixture commissioning', () => {
  it('normalizes the real inet host and installs once in the exact owned non-public schema', async () => {
    const raw = await financePostgres([memberRight, systemConfig]);
    let f = raw;
    try {
      const [identity] = await raw.db.execute(sql`SELECT inet_server_addr()::text AS inet,host(inet_server_addr()) AS host,current_schema() AS namespace`);
      expect(identity.inet).toBe('127.0.0.1/32'); expect(identity.host).toBe('127.0.0.1');
      expect(identity.namespace).toMatch(/^finance_test_[a-f0-9]{32}$/);
      f = await checkoutPricingFixture(raw);
      expect(await checkoutPricingFixture(f)).toBe(f);
      await withTx(createContainerFromDb(f.db), tx => protectCheckoutPricingSources(tx));
      expect((await inspectCheckoutPricingLock(f.db)).absent).toBe(true);
    } finally { await f.close(); }
  }, 30_000);
  it('does not replace or repair an already drifted fixture capability', async () => {
    const raw = await financePostgres([memberRight, systemConfig]);
    let f = raw;
    try {
      f = await checkoutPricingFixture(raw);
      const [identity] = await f.db.execute(sql`SELECT current_schema() AS namespace`);
      if (typeof identity.namespace !== 'string') throw Error('Missing owned schema');
      await f.exec('GRANT EXECUTE ON FUNCTION checkout_lock_pricing_v1() TO PUBLIC');
      const before = await inspectCheckoutPricingLock(f.db, identity.namespace);
      await expect(checkoutPricingFixture(f)).rejects.toThrow('requires review');
      expect(await inspectCheckoutPricingLock(f.db, identity.namespace)).toEqual(before);
    } finally { await f.close(); }
  }, 30_000);
});
