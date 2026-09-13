import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Container, DbClient } from '../src/lib/di';
import { MigrationService } from '../src/services/MigrationService';
import { COUPON_PRODUCT_SCOPE_FENCE_SQL, COUPON_PRODUCT_SCOPE_FENCE_BODY } from '../src/migrations/couponProductScopeFence';
import { BROKERAGE_PAID_ORDER_FENCE_SQL } from '../src/migrations/brokeragePaidOrderFence';
import { runCouponProductScopeFence } from '../src/migrations/runCouponProductScopeFence';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';
import { assertCheckoutCouponTemplate, couponTemplateSnapshot } from '../src/services/order/CheckoutCouponTemplateAuthority';
import { storeCouponIssue } from '../src/models/schema';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';

type Owned = Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
const service = (db: DbClient) => new MigrationService({ db } as Container);
const steps = (length: number) => Array.from({ length }, (_, i) => String(i).padStart(4, '0'));
const dialect = new PgDialect();
const catalog = (f: Owned) => f.db.select({ oid: sql<number>`t.oid::int`, name: sql<string>`t.tgname`,
  functionOid: sql<number>`p.oid::int`, body: sql<string>`p.prosrc` })
  .from(sql`pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid`).where(sql`t.tgrelid='store_coupon_product'::regclass AND NOT t.tgisinternal`).orderBy(sql`t.tgname`);

it('registers filesystem 0151 as embedded 0157 without changing the SQL', () => {
  const source = readFileSync('src/services/MigrationService.ts', 'utf8');
  expect(source).toContain('this.migration_0157(),');
  const probe = new MigrationService({} as Container), method = Reflect.get(probe, 'couponProductScopeFenceMigrationSqlForVerification');
  expect(typeof method).toBe('function'); expect(method.call(probe).trim()).toBe(COUPON_PRODUCT_SCOPE_FENCE_SQL.trim());
});

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('coupon relation migration registration on PostgreSQL 16', () => {
  it.each(['external', 'embedded', 'orm'] as const)('constructs the complete %s schema and exercises the real checkout guard', async path => {
    const f = await sequenceRunnerDatabase();
    try {
      if (path === 'external') {
        for (const file of readdirSync('migrations').filter(name => /^[0-9]{4}.*\.sql$/.test(name)).sort()) {
          await f.exec(`BEGIN; SET LOCAL search_path TO public,pg_temp; SET LOCAL statement_timeout='30s'; ${readFileSync(`migrations/${file}`, 'utf8')}\nCOMMIT;`);
        }
      } else if (path === 'embedded') {
        expect(await service(f.db).runAll()).toEqual({ executed: steps(159), errors: [] });
      } else {
        const api = await import('drizzle-kit/api'), models = await import('../src/models/schema');
        await f.exec((await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(models))).join('\n'));
        expect(await catalog(f)).toEqual([]);
      }
      if (path !== 'orm') expect(await catalog(f)).toHaveLength(3);
      await f.exec('INSERT INTO store_coupon_issue(id,coupon_type) VALUES(1,2); INSERT INTO store_coupon_product VALUES(1,70),(1,70)');
      const physical = () => f.query("SELECT oid::int,relfilenode::int FROM pg_class WHERE oid IN ('store_coupon_issue'::regclass,'store_coupon_product'::regclass) ORDER BY oid");
      const before = await physical(); await runCouponProductScopeFence(f.db); const installed = await catalog(f);
      expect(installed).toHaveLength(3); expect(installed.every(row => row.body === COUPON_PRODUCT_SCOPE_FENCE_BODY)).toBe(true);
      await runCouponProductScopeFence(f.db); expect(await catalog(f)).toEqual(installed); expect(await physical()).toEqual(before);
      const [template] = await f.db.select().from(storeCouponIssue);
      await f.db.transaction(async tx => assertCheckoutCouponTemplate(tx, couponTemplateSnapshot(template, [70,70])));
      await f.exec('INSERT INTO store_coupon_product VALUES(1,71)');
      await expect(f.db.transaction(async tx => assertCheckoutCouponTemplate(tx, couponTemplateSnapshot(template, [70,70])))).rejects.toThrow('规则已变化');
      expect((await f.query('SELECT coupon_id,product_id FROM store_coupon_product ORDER BY product_id')).rows)
        .toEqual([{ coupon_id: 1, product_id: 70 }, { coupon_id: 1, product_id: 70 }, { coupon_id: 1, product_id: 71 }]);
      if (path === 'orm') {
        if (!f.withRuntimeRole || !f.withPeer) throw new Error('Actual nonowner PostgreSQL connections required');
        await f.withRuntimeRole(async runtime => {
          await f.exec(`GRANT SELECT ON store_coupon_issue,store_coupon_product TO "${runtime.role}"`);
          const denied = await outcome(runtime.db.transaction(async tx => assertCheckoutCouponTemplate(tx, couponTemplateSnapshot(template, [70,71]))));
          expect(denied.ok).toBe(false);
          if (!denied.ok) {
            let cause: unknown = denied.error, code: unknown;
            for (let i = 0; i < 8 && cause && typeof cause === 'object'; i++) {
              if ('code' in cause) code = cause.code;
              if (!('cause' in cause) || cause.cause === cause) break; cause = cause.cause;
            }
            expect(code).toBe('42501');
          }
          await f.exec(`GRANT UPDATE(title) ON store_coupon_issue TO "${runtime.role}"`);
          await f.withPeer!(async writer => {
            let writing: ReturnType<typeof outcome> | undefined;
            try {
              await runtime.db.transaction(async tx => {
                await assertCheckoutCouponTemplate(tx, couponTemplateSnapshot(template, [70,71]));
                writing = outcome(writer.exec('INSERT INTO store_coupon_product VALUES(1,71)'));
                await waitForFinanceBlock(f.db, writer.pid, runtime.pid);
              });
              expect(writing).toBeDefined(); expect((await writing)?.ok).toBe(true);
            } finally { await writing; }
          });
        });
        expect((await f.query('SELECT count(*)::int AS count FROM store_coupon_product')).rows).toEqual([{ count: 4 }]);
      }
    } finally { await f.close(); }
  }, 120_000);

  it.each(['previous-step', 'fence-step', 'after-ddl'] as const)('stops on %s failure and rolls back partially installed objects', async fault => {
    const f = await sequenceRunnerDatabase(); let observed = 0;
    try {
      const db = new Proxy(f.db, { get(target, key, receiver) {
        if (key === 'transaction') return ((callback, config) => target.transaction(async tx => {
          const proxy = new Proxy(tx, { get(transaction, property, txReceiver) {
            if (property === 'execute') return async (query: SQL) => {
              const statement = dialect.sqlToQuery(query).sql;
              if (statement === BROKERAGE_PAID_ORDER_FENCE_SQL && fault === 'previous-step') throw new Error('already exists: preceding step failed');
              if (statement === COUPON_PRODUCT_SCOPE_FENCE_SQL) {
                observed++; expect(config).toMatchObject({ isolationLevel: 'read committed' });
                if (fault === 'fence-step') throw new Error('already exists: coupon fence failed');
                await tx.execute(query);
                return tx.execute(sql.raw("DO $$ BEGIN RAISE EXCEPTION 'already exists: after coupon DDL'; END $$"));
              }
              return tx.execute(query);
            };
            return Reflect.get(transaction, property, txReceiver);
          } });
          return callback(proxy);
        }, config)) satisfies DbClient['transaction'];
        return Reflect.get(target, key, receiver);
      } });
      const result = await service(db).runAll(), failed = fault === 'previous-step' ? 156 : 157;
      expect(result.executed).toEqual(steps(failed)); expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain(`${String(failed).padStart(4,'0')}:`); expect(result.errors[0]).toContain('already exists');
      expect(observed).toBe(fault === 'previous-step' ? 0 : 1); expect(await catalog(f)).toEqual([]);
      expect((await f.query("SELECT to_regprocedure('coupon_product_scope_fence_0151()') AS object")).rows).toEqual([{ object: null }]);
    } finally { await f.close(); }
  }, 120_000);
});
