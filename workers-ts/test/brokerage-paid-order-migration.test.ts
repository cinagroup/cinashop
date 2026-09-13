import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Container, DbClient } from '../src/lib/di';
import { MigrationService } from '../src/services/MigrationService';
import { BROKERAGE_PAID_ORDER_FENCE_BODY, BROKERAGE_PAID_ORDER_FENCE_SQL } from '../src/migrations/brokeragePaidOrderFence';
import { BARGAIN_CART_PARTICIPATION_SQL } from '../src/migrations/bargainCartParticipation';
import { runBrokeragePaidOrderFence } from '../src/migrations/runBrokeragePaidOrderFence';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';

const dialect = new PgDialect();
type Owned = Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
const steps = (length: number) => Array.from({ length }, (_, i) => String(i).padStart(4, '0'));
const service = (db: DbClient) => new MigrationService({ db } as Container);
const fenceNames = ['brokerage_paid_delete_0150', 'brokerage_paid_insert_0150', 'brokerage_paid_update_0150'];

async function catalog(owned: Owned) {
  return owned.db.select({
    oid: sql<number>`t.oid::int`, tgname: sql<string>`t.tgname`, tgtype: sql<number>`t.tgtype`,
    tgenabled: sql<string>`t.tgenabled`, tgoldtable: sql<string | null>`t.tgoldtable`,
    tgnewtable: sql<string | null>`t.tgnewtable`, function_oid: sql<number>`p.oid::int`,
    prosrc: sql<string>`p.prosrc`, proconfig: sql<string[]>`p.proconfig`, prosecdef: sql<boolean>`p.prosecdef`,
  }).from(sql`pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid`)
    .where(sql`t.tgrelid='public.store_order'::regclass AND t.tgname IN
      ('brokerage_paid_delete_0150','brokerage_paid_insert_0150','brokerage_paid_update_0150')`)
    .orderBy(sql`t.tgname`);
}
async function businessState(owned: Owned) {
  return {
    users: (await owned.query('SELECT to_jsonb(u) AS row FROM public."user" u ORDER BY uid')).rows,
    orders: (await owned.query('SELECT to_jsonb(o) AS row FROM public.store_order o ORDER BY id')).rows,
    relations: (await owned.query(`SELECT c.oid::int, c.relfilenode::int, c.relname
      FROM pg_class c WHERE c.oid IN ('public."user"'::regclass,'public.store_order'::regclass) ORDER BY c.relname`)).rows,
  };
}

it('registers filesystem 0150 as embedded 0156 with the identical SQL', () => {
  const source = readFileSync('src/services/MigrationService.ts', 'utf8');
  expect(source.includes('this.migration_0156(),')).toBe(true);
  const method = Reflect.get(new MigrationService({} as Container), 'brokeragePaidOrderFenceMigrationSqlForVerification');
  expect(typeof method).toBe('function');
  expect(method.call(new MigrationService({} as Container)).trim()).toBe(BROKERAGE_PAID_ORDER_FENCE_SQL.trim());
  expect(readFileSync('migrations/0150_brokerage_paid_order_fence.sql', 'utf8').trim())
    .toBe(BROKERAGE_PAID_ORDER_FENCE_SQL.trim());
});

// Each case owns a newly created random database. Never runs history against
// public in the shared test DB, DATABASE_URL, Hyperdrive or production.
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('paid-order fence migration registration on PostgreSQL 16', () => {
  for (const path of ['external', 'embedded', 'orm'] as const) {
    it(`installs from complete ${path} construction and preserves repeated-upgrade data/catalog`, async () => {
      const owned = await sequenceRunnerDatabase();
      try {
        if (path === 'external') {
          for (const file of readdirSync('migrations').filter(name => /^\d{4}.*\.sql$/.test(name)).sort()) {
            await owned.exec(`BEGIN; SET LOCAL search_path TO public,pg_temp; SET LOCAL statement_timeout='30s';
              ${readFileSync(`migrations/${file}`, 'utf8')}\nCOMMIT;`);
          }
        } else if (path === 'embedded') {
          const result = await service(owned.db).runAll();
          expect(result.errors.map(error => error.slice(0, 200))).toEqual([]);
          expect(result.executed).toEqual(steps(160));
        } else {
          const api = await import('drizzle-kit/api'), models = await import('../src/models/schema');
          await owned.exec((await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(models))).join('\n'));
          expect(await catalog(owned)).toEqual([]);
        }
        if (path !== 'orm') expect((await catalog(owned)).map(row => row.tgname)).toEqual(fenceNames);
        await owned.exec(`INSERT INTO public."user"(uid,account) VALUES(101,'migration-first'),(202,'migration-second');
          INSERT INTO public.store_order(id,uid,order_id,paid,pay_price) VALUES
            (501,101,'migration-paid',1,60),(502,202,'migration-unpaid',0,70)`);
        const before = await businessState(owned);
        await runBrokeragePaidOrderFence(owned.db);
        expect(await businessState(owned)).toEqual(before);
        const installed = await catalog(owned);
        expect(installed.map(row => row.tgname)).toEqual(fenceNames);
        expect(installed.map(row => Number(row.tgtype))).toEqual([8,4,16]);
        for (const row of installed) {
          expect(row.prosrc).toBe(BROKERAGE_PAID_ORDER_FENCE_BODY);
          expect(row.proconfig).toEqual(['search_path=pg_catalog']);
          expect(row.prosecdef).toBe(false);
          expect(row.tgenabled).toBe('O');
        }
        await runBrokeragePaidOrderFence(owned.db);
        expect(await catalog(owned)).toEqual(installed);
        expect(await businessState(owned)).toEqual(before);
        // Exercise the installed functions, not only their names/catalog.
        await owned.exec('UPDATE public.store_order SET paid=1 WHERE id=502');
        await owned.exec('UPDATE public.store_order SET refund_status=1 WHERE id=501');
        await owned.exec('DELETE FROM public.store_order WHERE id=502');
        const stable = await businessState(owned);
        await expect(owned.exec("INSERT INTO public.store_order(id,uid,order_id,paid,pay_price) VALUES(503,999,'missing-user',1,1)"))
          .rejects.toMatchObject({ code: '23503' });
        expect(await businessState(owned)).toEqual(stable);
      } finally { await owned.close(); }
    }, 120_000);
  }

  it.each(['previous-step', 'fence-step', 'after-fence-ddl'] as const)(
    'stops and rolls back without treating already-exists as success: %s', async fault => {
      const owned = await sequenceRunnerDatabase();
      const observed: string[] = [];
      try {
        // Intercept only the transaction boundary; execute the real complete history
        // and real runner SQL on the disposable PG16 database.
        const db = new Proxy(owned.db, { get(target, key, receiver) {
          if (key === 'transaction') return ((callback, config) => target.transaction(async tx => {
            const proxy = new Proxy(tx, { get(transaction, property, txReceiver) {
              if (property === 'execute') return async (query: SQL) => {
                const text = dialect.sqlToQuery(query).sql;
                if (text === BARGAIN_CART_PARTICIPATION_SQL && fault === 'previous-step')
                  throw new Error('already exists: intentional preceding-step failure');
                if (text === BROKERAGE_PAID_ORDER_FENCE_SQL) {
                  observed.push('fence');
                  expect(config).toMatchObject({ isolationLevel: 'read committed' });
                  const settings = await tx.execute(sql`SELECT current_setting('transaction_isolation') AS isolation,
                    current_setting('search_path') AS path,
                    (SELECT setting FROM pg_settings WHERE name='statement_timeout') AS statement,
                    (SELECT setting FROM pg_settings WHERE name='idle_in_transaction_session_timeout') AS idle`);
                  expect(Array.from(settings)).toEqual([{ isolation: 'read committed', path: 'public, pg_temp', statement: '30000', idle: '5000' }]);
                  if (fault === 'fence-step') throw new Error('already exists: intentional fence-step failure');
                  await tx.execute(query);
                  // A real server error after installing all four objects must
                  // roll back the entire runner, not leave partial installation.
                  return tx.execute(sql.raw("DO $$BEGIN RAISE EXCEPTION 'already exists: intentional post-DDL failure'; END$$;"));
                }
                return tx.execute(query);
              };
              return Reflect.get(transaction, property, txReceiver);
            } });
            return callback(proxy);
          }, config)) satisfies DbClient['transaction'];
          return Reflect.get(target, key, receiver);
        } });
        const result = await service(db).runAll();
        const failedStep = fault === 'previous-step' ? 155 : 156;
        expect(result.executed).toEqual(steps(failedStep));
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toMatch(new RegExp(`^${String(failedStep).padStart(4, '0')}:`));
        expect(result.errors[0]).toContain('already exists');
        expect(observed).toEqual(fault === 'previous-step' ? [] : ['fence']);
        expect(await catalog(owned)).toEqual([]);
        expect((await owned.query("SELECT to_regprocedure('public.brokerage_paid_order_fence_0150()') AS object")).rows)
          .toEqual([{ object: null }]);
        if (fault !== 'previous-step') {
          await runBrokeragePaidOrderFence(owned.db);
          expect((await catalog(owned)).map(row => row.tgname)).toEqual(fenceNames);
        }
      } finally { await owned.close(); }
    }, 120_000);
});
