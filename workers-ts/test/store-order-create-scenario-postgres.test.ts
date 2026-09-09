import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sequenceRunnerDatabase, validateSequenceRunnerTestUrl } from './helpers/kefuSequenceRunnerDatabase';
import { runStoreOrderCreatePostgresScenario } from './integration/StoreOrderCreatePostgresScenario';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('complete order creation scenario on an owned local PG16 database', () => {
  it('runs actual concurrent claims, cancellation, pricing and reward checks after the complete migration history', async () => {
    const owned = await sequenceRunnerDatabase();
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
      const report = await runStoreOrderCreatePostgresScenario(target.href);
      expect(report).toMatchObject({ schema_created: true, schema_removed: true, public_state_unchanged: true,
        same_cart_claim: { successes: 1, rejections: 1, orders: 1 },
        concurrent_idempotence: { successes: 2, same_order_id: true, orders: 1 },
        stock_oversell_guard: { successes: 1, rejections: 1, product_stock: 0, sku_stock: 0 },
        pricing_and_reward_policy: { authoritative_address: true, quote_matches_order: true, pay_price: '13.50', one_coupon_for_duplicate_links: true },
      });
    } finally { await owned.close(); }
  }, 180_000);
});
