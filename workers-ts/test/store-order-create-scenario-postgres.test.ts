import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { validateSequenceRunnerTestUrl } from './helpers/kefuSequenceRunnerDatabase';
import { checkoutPricingMigrationDatabase } from './helpers/checkoutPricingMigrationDatabase';
import { runStoreOrderCreatePostgresScenario } from './integration/StoreOrderCreatePostgresScenario';

describe('order scenario explicit maintenance boundary', () => {
  it('refuses a missing clone owner before connecting or creating a schema', async () => {
    await expect(runStoreOrderCreatePostgresScenario('not-a-database-url'))
      .rejects.toThrow('Order scenario requires an explicit clone pricing owner');
  });
  it('refuses an unsafe clone owner before connecting or creating a schema', async () => {
    await expect(runStoreOrderCreatePostgresScenario('not-a-database-url', 'pg_database_owner'))
      .rejects.toThrow('Invalid explicit pricing capability identifier');
  });
});

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('complete order creation scenario on an owned local PG16 database', () => {
  it('runs actual concurrent claims, cancellation, pricing and reward checks after the complete migration history', async () => {
    const owned = await checkoutPricingMigrationDatabase();
    const cloneOwner = `cinashop_runtime_${randomUUID().replaceAll('-', '')}`;
    let cloneOwnerCreated = false;
    try {
      expect(owned.format).toBe('pg16');
      const identity = await owned.query('SELECT current_database() AS database');
      const row = identity.rows[0];
      if (!row || typeof row !== 'object' || !('database' in row)
        || typeof row.database !== 'string' || !/^cinashop_kefu_runner_[a-f0-9]{32}$/.test(row.database)) {
        throw new Error('Order scenario requires an owned disposable database');
      }
      const target = validateSequenceRunnerTestUrl(process.env.TEST_FINANCE_POSTGRES_URL ?? '');
      target.pathname = '/' + row.database;
      for (const file of readdirSync('migrations').filter(name => /^\d{4}.*\.sql$/.test(name)).sort()) {
        await owned.exec(`BEGIN; SET LOCAL search_path TO public,pg_temp; SET LOCAL statement_timeout='30s';\n${readFileSync(`migrations/${file}`, 'utf8')}\nCOMMIT;`);
      }
      await owned.exec(`CREATE ROLE "${cloneOwner}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
      cloneOwnerCreated = true;
      const report = await runStoreOrderCreatePostgresScenario(target.href, cloneOwner);
      expect(report).toMatchObject({ schema_created: true, schema_removed: true, public_state_unchanged: true,
        same_cart_claim: { successes: 1, rejections: 1, orders: 1 },
        concurrent_idempotence: { successes: 2, same_order_id: true, orders: 1 },
        stock_oversell_guard: { successes: 1, rejections: 1, product_stock: 0, sku_stock: 0 },
        pricing_and_reward_policy: { authoritative_address: true, quote_matches_order: true, pay_price: '13.50', one_coupon_for_duplicate_links: true },
      });
    } finally {
      try {
        if (cloneOwnerCreated) {
          if (!/^cinashop_runtime_[a-f0-9]{32}$/.test(cloneOwner)) throw Error('Unsafe owned clone pricing role');
          await owned.exec(`DROP OWNED BY "${cloneOwner}"; DROP ROLE "${cloneOwner}"`);
          const remaining = await owned.db.execute(sql`SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${cloneOwner}`);
          expect(remaining).toHaveLength(0);
        }
      } finally { await owned.close(); }
    }
  }, 180_000);
});
