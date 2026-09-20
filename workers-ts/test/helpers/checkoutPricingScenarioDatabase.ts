import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { checkoutPricingMigrationDatabase } from './checkoutPricingMigrationDatabase';
import { validateSequenceRunnerTestUrl } from './kefuSequenceRunnerDatabase';
import { pricingIdentifier } from '../../src/migrations/checkoutPricingLockCatalog';

/** Explicit local native fixture. Public has the entire numbered history; the
 * clone gets a different, fixture-owned NOLOGIN owner. No remote fallback. */
export async function withCheckoutPricingScenarioDatabase<T>(
  run: (connectionString: string, cloneOwner: string,
    fixture: Awaited<ReturnType<typeof checkoutPricingMigrationDatabase>>) => Promise<T>,
): Promise<T> {
  const owned = await checkoutPricingMigrationDatabase();
  const cloneOwner = `cinashop_runtime_${randomUUID().replaceAll('-', '')}`;
  const quotedOwner = pricingIdentifier(cloneOwner);
  let created = false;
  try {
    const [identity] = await owned.db.execute(sql`SELECT current_database() AS database`);
    if (owned.format !== 'pg16' || typeof identity?.database !== 'string'
      || !/^cinashop_kefu_runner_[a-f0-9]{32}$/.test(identity.database)) {
      throw Error('Checkout scenarios require an owned disposable PG16 database');
    }
    const target = validateSequenceRunnerTestUrl(process.env.TEST_FINANCE_POSTGRES_URL ?? '');
    target.pathname = '/' + identity.database;
    await owned.exec("SET client_min_messages='warning'");
    for (const file of readdirSync('migrations').filter(name => /^\d{4}.*\.sql$/.test(name)).sort()) {
      await owned.exec(`BEGIN; SET LOCAL search_path TO public,pg_temp; SET LOCAL statement_timeout='30s';\n${readFileSync(`migrations/${file}`, 'utf8')}\nCOMMIT;`);
    }
    await owned.exec(`CREATE ROLE ${quotedOwner} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    created = true;
    return await run(target.href, cloneOwner, owned);
  } finally {
    try {
      if (created) {
        if (!/^cinashop_runtime_[a-f0-9]{32}$/.test(cloneOwner)) throw Error('Unsafe owned scenario role');
        await owned.exec(`DROP OWNED BY ${quotedOwner}; DROP ROLE ${quotedOwner}`);
        if ((await owned.db.execute(sql`SELECT oid FROM pg_roles WHERE rolname=${cloneOwner}`)).length)
          throw Error('Owned checkout scenario role cleanup unconfirmed');
      }
    } finally { await owned.close(); }
  }
}

/** All-row/sequence evidence in the owned local database, not a production
 * audit API. Includes relations not listed in the older scenario snapshots. */
export async function checkoutScenarioPublicState(fixture: Awaited<ReturnType<typeof checkoutPricingMigrationDatabase>>) {
  const tables = await fixture.db.execute(sql`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`);
  const fingerprints: Array<{ table: string; value: unknown }> = [];
  for (const table of tables) {
    if (typeof table.tablename !== 'string') throw Error('Unexpected owned public table');
    const name = pricingIdentifier(table.tablename);
    const [row] = await fixture.db.execute(sql.raw(`SELECT count(*)::text AS rows,
      md5(coalesce(string_agg(to_jsonb(t)::text,chr(10) ORDER BY to_jsonb(t)::text),'')) AS digest FROM public.${name} t`));
    fingerprints.push({ table: table.tablename, value: row });
  }
  const sequences = await fixture.db.execute(sql`SELECT sequencename,last_value::text FROM pg_sequences
    WHERE schemaname='public' ORDER BY sequencename`);
  return { fingerprints, sequences: Array.from(sequences) };
}
