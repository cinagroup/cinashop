import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { DbClient } from '../../src/lib/di';
import { inspectCheckoutPricingLock, installCheckoutPricingLock } from '../../src/migrations/checkoutPricingLock';
import { pricingCatalogReady, pricingIdentifier } from '../../src/migrations/checkoutPricingLockCatalog';
import { ownsFinanceFixtureTarget, validateFinanceFixtureUrl } from './financePostgres';

type Fixture = { db: DbClient; exec: (statement: string) => Promise<unknown>; close: () => Promise<void> };

/** Explicit local PG16 commissioning for a test-owned checkout database.
 * Never emulates this protocol in PGlite, changes business-role DML, repairs
 * drift, or falls back to production. Caller must own and close the fixture. */
export async function checkoutPricingFixture<T extends Fixture>(fixture: T): Promise<T> {
  const target = validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL ?? '');
  const [identity] = await fixture.db.execute(sql`SELECT pg_catalog.current_database() AS database,
    pg_catalog.current_schema() AS namespace, current_user AS role,
    pg_catalog.current_setting('server_version_num') AS version,
    pg_catalog.host(pg_catalog.inet_server_addr()) AS host,pg_catalog.inet_server_port() AS port`);
  if (!identity || typeof identity.database !== 'string' || typeof identity.namespace !== 'string'
    || identity.role !== 'finance_test' || Math.floor(Number(identity.version) / 10000) !== 16
    || identity.host !== '127.0.0.1' || identity.port !== Number(target.port || 5432)
    || !(ownsFinanceFixtureTarget(identity.database, identity.namespace, target.href)
      || (/^cinashop_kefu_runner_[a-f0-9]{32}$/.test(identity.database) && identity.namespace === 'public'))) {
    throw Error('Checkout commissioning requires the exact owned loopback PG16 fixture');
  }
  const namespace = identity.namespace;
  const initial = await inspectCheckoutPricingLock(fixture.db, namespace);
  if (!initial.absent) {
    if (!pricingCatalogReady(initial)) throw Error('Existing checkout test capability requires review');
    return fixture;
  }
  const role = `cinashop_runtime_${randomUUID().replaceAll('-', '')}`;
  const quotedRole = pricingIdentifier(role);
  let created = false;
  let closing: Promise<void> | undefined;
  const removeRole = async () => {
    if (created) {
      await fixture.exec(`DROP OWNED BY ${quotedRole}; DROP ROLE ${quotedRole}`);
      if ((await fixture.db.execute(sql`SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${role}`)).length)
        throw Error('Owned checkout fixture role cleanup unconfirmed');
      created = false;
    }
  };
  const close = () => closing ??= (async () => {
    try { await removeRole(); } finally { await fixture.close(); }
  })();
  try {
    await fixture.exec(`CREATE ROLE ${quotedRole} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    created = true;
    await installCheckoutPricingLock(fixture.db, role, namespace);
    return { ...fixture, close };
  } catch (error) { await removeRole(); throw error; }
}
