import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { DbClient } from '../../src/lib/di';
import { installSeckillTimeReferenceLock } from '../../src/migrations/seckillTimeReferenceLock';
import { SECKILL_TIME_REFERENCE_OWNER_SETTING } from '../../src/migrations/seckillTimeReferenceLockCatalog';
import { ownsFinanceFixtureEndpoint, validateFinanceFixtureUrl } from './financePostgres';
import { ownsSequenceRunnerEndpoint } from './kefuSequenceRunnerDatabase';

type Fixture = { format?: string; db: DbClient; exec: (statement: string) => Promise<unknown>; close: () => Promise<void> };

/** Exact disposable loopback PG16 only. Memory SQL tests do not emulate this
 * capability. install=false provisions the explicit setting before full schema
 * construction; numbered migration performs the actual installation later. */
export async function seckillTimeReferenceLockFixture<T extends Fixture>(fixture: T, install = true): Promise<T & { seckillTimeReferenceOwner?: string }> {
  if (fixture.format !== 'pg16') return fixture;
  const target = validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL ?? '');
  const [identity] = await fixture.db.execute(sql`SELECT current_database() AS database,current_schema() AS namespace,
    current_user AS role,current_setting('server_version_num') AS version,
    host(inet_server_addr()) AS host,inet_server_port() AS port`);
  if (!identity || typeof identity.database !== 'string' || typeof identity.namespace !== 'string'
    || identity.role !== 'finance_test' || Math.floor(Number(identity.version) / 10000) !== 16
    || !(ownsFinanceFixtureEndpoint(identity.database, identity.namespace, target.href, identity.host, identity.port)
      || ownsSequenceRunnerEndpoint(identity.database, identity.namespace, target.href, identity.host, identity.port))) {
    throw Error('Seckill time lock commissioning requires the exact owned loopback PG16 fixture');
  }
  const role = `cinashop_runtime_${randomUUID().replaceAll('-', '')}`;
  let created = false, closing: Promise<void> | undefined;
  const remove = async () => {
    await fixture.db.execute(sql`SELECT set_config(${SECKILL_TIME_REFERENCE_OWNER_SETTING},'',false)`);
    if (created) {
      if (!/^cinashop_runtime_[a-f0-9]{32}$/.test(role)) throw Error('Unsafe owned seckill time lock role');
      await fixture.exec(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`);
      if ((await fixture.db.execute(sql`SELECT oid FROM pg_roles WHERE rolname=${role}`)).length) throw Error('Seckill time lock owner cleanup unconfirmed');
      created = false;
    }
  };
  const close = () => closing ??= (async () => { try { await remove(); } finally { await fixture.close(); } })();
  try {
    await fixture.exec(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    created = true;
    await fixture.db.execute(sql`SELECT set_config(${SECKILL_TIME_REFERENCE_OWNER_SETTING},${role},false)`);
    if (install) await installSeckillTimeReferenceLock(fixture.db, role, identity.namespace);
    return { ...fixture, seckillTimeReferenceOwner: role, close };
  } catch (error) { await remove(); throw error; }
}
