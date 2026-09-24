import { sql } from 'drizzle-orm';
import type { DbClient } from '../../src/lib/di';
import { runPurchaseOriginEvidenceSchema } from '../../src/migrations/runPurchaseOriginEvidence';
import { ownsFinanceFixtureEndpoint, validateFinanceFixtureUrl } from './financePostgres';
import { ownsSequenceRunnerEndpoint } from './kefuSequenceRunnerDatabase';

/** Real public-schema origin protocol on a process-owned disposable PG16 DB.
 * The narrow column fixture adds only the two required source lookup indexes;
 * the reviewed installer still verifies all source types, ownership and guards.
 * Quote-only fixtures without detail rows do not need a checkout protocol.
 * This is neither a full-schema certification nor a production installer. */
export async function purchaseOriginCheckoutFixture(fixture: { db: DbClient }) {
  const target = validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL ?? '');
  const [identity] = await fixture.db.execute(sql`SELECT current_database() AS database,
    current_schema() AS namespace,current_user AS role,current_setting('server_version_num') AS version,
    host(inet_server_addr()) AS host,inet_server_port() AS port`);
  if (!identity || typeof identity.database !== 'string' || identity.namespace !== 'public'
    || identity.role !== 'finance_test' || Math.floor(Number(identity.version) / 10000) !== 16)
    throw Error('Origin checkout commissioning requires an owned public PG16 fixture');
  const narrow = ownsFinanceFixtureEndpoint(identity.database, identity.namespace, target.href, identity.host, identity.port);
  if (!narrow && !ownsSequenceRunnerEndpoint(identity.database, identity.namespace, target.href, identity.host, identity.port))
    throw Error('Origin checkout fixture ownership is unproven');
  const [sources] = await fixture.db.execute(sql`SELECT to_regclass('public.store_order_cart_info') IS NOT NULL AS details`);
  if (!sources.details) return;
  if (narrow) {
    await fixture.db.execute(sql`CREATE INDEX fixture_origin_order_pid ON public.store_order(pid)`);
    await fixture.db.execute(sql`CREATE INDEX fixture_origin_line_oid ON public.store_order_cart_info(oid)`);
  }
  await runPurchaseOriginEvidenceSchema(fixture.db);
}
