import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { isIP } from 'node:net';
import { memberRight, systemConfig } from '../src/models/schema';
import { financePostgres, ownsFinanceFixtureEndpoint, validateFinanceFixtureUrl } from './helpers/financePostgres';
import { ownsSequenceRunnerEndpoint, sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';
import { checkoutPricingFixture } from './helpers/checkoutPricingFixture';
import { inspectCheckoutPricingLock } from '../src/migrations/checkoutPricingLock';
import { protectCheckoutPricingSources } from '../src/services/order/CheckoutPricingSources';
import { createContainerFromDb, withTx } from '../src/lib/di';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('explicit local checkout fixture commissioning', () => {
  it('normalizes the real inet host and installs once in the exact owned non-public schema', async () => {
    const raw = await financePostgres([memberRight, systemConfig]);
    let f = raw;
    try {
      const [identity] = await raw.db.execute(sql`SELECT inet_server_addr()::text AS inet,host(inet_server_addr()) AS host,
        inet_server_port() AS port,current_database() AS database,current_schema() AS namespace`);
      // The client URL is constrained to loopback by financePostgres. GitHub's
      // container server reports its bridge address; commissioning verifies it
      // against the actual owned coordinator instead of accepting arbitrary IPs.
      expect(typeof identity.host).toBe('string');
      const version = isIP(String(identity.host)); expect(version).toBeGreaterThan(0);
      expect(identity.inet).toBe(`${identity.host}/${version === 4 ? 32 : 128}`);
      expect(identity.namespace).toMatch(/^finance_test_[a-f0-9]{32}$/);
      const base = validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL!).href;
      const matches = (host: unknown, port: unknown) => ownsFinanceFixtureEndpoint(String(identity.database), String(identity.namespace), base, host, port);
      expect(matches(identity.host, identity.port)).toBe(true);
      expect(matches('unowned-host', identity.port)).toBe(false);
      expect(matches(identity.host, Number(identity.port) + 1)).toBe(false);
      expect(ownsFinanceFixtureEndpoint(String(identity.database), 'public', base, identity.host, identity.port)).toBe(false);
      expect(ownsFinanceFixtureEndpoint('finance_fixture_' + 'f'.repeat(32), String(identity.namespace), base, identity.host, identity.port)).toBe(false);
      f = await checkoutPricingFixture(raw);
      expect(await checkoutPricingFixture(f)).toBe(f);
      await withTx(createContainerFromDb(f.db), tx => protectCheckoutPricingSources(tx));
      expect((await inspectCheckoutPricingLock(f.db)).absent).toBe(true);
    } finally { await f.close(); }
  }, 30_000);
  it('commissions only a created sequence-runner endpoint and forgets ownership after cleanup', async () => {
    const raw = await sequenceRunnerDatabase(); let f = raw;
    const base = validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL!).href;
    let database = '', host: unknown, port: unknown;
    try {
      const [identity] = await raw.db.execute(sql`SELECT current_database() AS database,host(inet_server_addr()) AS host,inet_server_port() AS port`);
      database = String(identity.database); host = identity.host; port = identity.port;
      expect(ownsSequenceRunnerEndpoint(database, 'public', base, host, port)).toBe(true);
      expect(ownsSequenceRunnerEndpoint(database, 'public', base, 'other-host', port)).toBe(false);
      expect(ownsSequenceRunnerEndpoint(database, 'other_schema', base, host, port)).toBe(false);
      expect(ownsSequenceRunnerEndpoint(database, 'public', base, host, Number(port) + 1)).toBe(false);
      await raw.exec('CREATE TABLE public.member_right(id integer PRIMARY KEY); CREATE TABLE public.system_config(id integer PRIMARY KEY)');
      f = await checkoutPricingFixture(raw);
      await withTx(createContainerFromDb(f.db), tx => protectCheckoutPricingSources(tx));
    } finally { await f.close(); }
    expect(ownsSequenceRunnerEndpoint(database, 'public', base, host, port)).toBe(false);
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
