import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { sequenceRunnerDatabase } from './kefuSequenceRunnerDatabase';
import { PRICING_OWNER_SETTING } from '../../src/migrations/checkoutPricingLockCatalog';
export type { SequenceRunnerPeer } from './kefuSequenceRunnerDatabase';

/** Explicit full-migration fixture. Provision only a self-owned random NOLOGIN
 * role; the application installer never creates roles. Not a production helper. */
export async function checkoutPricingMigrationDatabase() {
  const fixture = await sequenceRunnerDatabase();
  if (fixture.format !== 'pg16') { await fixture.close(); throw Error('Explicit PG16 migration fixture required'); }
  const pricingOwner = `cinashop_runtime_${randomUUID().replaceAll('-', '')}`;
  let created = false;
  async function close() {
    try {
      await fixture.db.execute(sql`SELECT pg_catalog.set_config(${PRICING_OWNER_SETTING},'',false)`);
      if (created) {
        if (!/^cinashop_runtime_[a-f0-9]{32}$/.test(pricingOwner)) throw Error('Unsafe owned pricing role');
        await fixture.exec(`DROP OWNED BY "${pricingOwner}"; DROP ROLE "${pricingOwner}"`);
        const remaining = await fixture.db.execute(sql`SELECT oid FROM pg_roles WHERE rolname=${pricingOwner}`);
        if (remaining.length) throw Error('Owned pricing role cleanup unconfirmed');
        created = false;
      }
    } finally { await fixture.close(); }
  }
  try {
    await fixture.exec(`CREATE ROLE "${pricingOwner}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    created = true;
    // sequenceRunnerDatabase uses exactly one root connection. This explicit
    // test setting is not copied to any independently authenticated peer.
    await fixture.db.execute(sql`SELECT pg_catalog.set_config(${PRICING_OWNER_SETTING},${pricingOwner},false)`);
    return { ...fixture, pricingOwner, close };
  } catch (error) { await close(); throw error; }
}
