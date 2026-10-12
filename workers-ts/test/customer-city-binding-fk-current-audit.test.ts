import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import type { DbClient } from '../src/lib/di';
import { auditCustomerCityBindingFkCurrent } from '../src/migrations/auditCustomerCityBindingFkCurrent';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';

it('rejects a non-root client or unsafe expected identity before SQL', async () => {
  const unavailable = { $client: {}, transaction: () => { throw Error('SQL reached'); } } as unknown as DbClient;
  await expect(auditCustomerCityBindingFkCurrent({ transaction: unavailable.transaction },
    { role: 'app', database: 'postgres' })).rejects.toThrow('root database');
  for (const expected of [{ role: 'app;grant', database: 'postgres' },
    { role: 'app', database: 'postgres;drop' }])
    await expect(auditCustomerCityBindingFkCurrent(unavailable, expected)).rejects.toThrow('Invalid expected');
});

it('stops after backend identity mismatch in one read-only transaction', async () => {
  const execute = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ matches: false }]);
  const transaction = vi.fn((callback: (tx: { execute: typeof execute }) => Promise<unknown>) =>
    callback({ execute }));
  const db = { $client: {}, transaction } as unknown as DbClient;
  expect(await auditCustomerCityBindingFkCurrent(db,
    { role: 'cinashop_app_v1', database: 'postgres' })).toEqual({
    scope: 'city-binding-fk-metadata-only', identityMatch: false, catalogMatch: false,
    tables: null, foreignKey: null, indexes: null, readyForIndexDecision: false,
  });
  expect(transaction).toHaveBeenCalledExactlyOnceWith(expect.any(Function),
    { isolationLevel: 'repeatable read', accessMode: 'read only' });
  expect(execute).toHaveBeenCalledTimes(2);
});

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('native PG16 fixed city FK catalog', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  beforeAll(async () => {
    f = await sequenceRunnerDatabase();
    if (f.format !== 'pg16') throw Error('PG16 fixture required');
    await f.exec(`CREATE TABLE public.customer_city_delivery_attempt(id bigserial PRIMARY KEY);
      CREATE TABLE public.customer_city_delivery_binding(
        job_id bigint PRIMARY KEY, attempt_id bigint NOT NULL,
        delivery_order_id integer NOT NULL, provider varchar(8) NOT NULL,
        provider_order_id varchar(32) NOT NULL, order_id integer NOT NULL, active smallint NOT NULL,
        CONSTRAINT ccdbinding_attempt_fk FOREIGN KEY(attempt_id)
          REFERENCES public.customer_city_delivery_attempt(id) ON DELETE RESTRICT);
      CREATE UNIQUE INDEX ccdbinding_delivery_uq ON public.customer_city_delivery_binding(delivery_order_id);
      CREATE UNIQUE INDEX ccdbinding_provider_uq ON public.customer_city_delivery_binding(provider,provider_order_id);
      CREATE UNIQUE INDEX ccdbinding_active_order_uq ON public.customer_city_delivery_binding(order_id) WHERE active=1;
      INSERT INTO public.customer_city_delivery_attempt(id) VALUES(1),(2);
      INSERT INTO public.customer_city_delivery_binding
        (job_id,attempt_id,delivery_order_id,provider,provider_order_id,order_id,active)
        VALUES(1,1,1,'dada','a',1,1),(2,2,2,'dada','b',2,1);
      ANALYZE public.customer_city_delivery_attempt;
      ANALYZE public.customer_city_delivery_binding`);
  }, 120000);
  afterAll(async () => { await f?.close(); }, 45000);

  it('reads only fixed metadata under an actual unprivileged LOGIN and preserves business rows', async () => {
    if (!f.withRuntimeRole) throw Error('Actual PostgreSQL LOGIN required');
    await f.withRuntimeRole(async peer => {
      const [{ database }] = await peer.exec('SELECT current_database() AS database');
      const before = await f.query(`SELECT (SELECT count(*) FROM public.customer_city_delivery_attempt) AS attempts,
        (SELECT count(*) FROM public.customer_city_delivery_binding) AS bindings`);
      let transactions = 0;
      const observed = new Proxy(peer.db, { get(target, key, receiver) {
        if (key === 'transaction') return ((callback, config) => {
          transactions++;
          expect(config).toEqual({ isolationLevel: 'repeatable read', accessMode: 'read only' });
          return target.transaction(async tx => {
            expect(Array.from(await tx.execute(sql`SELECT current_setting('transaction_read_only') AS readonly`)))
              .toEqual([{ readonly: 'on' }]);
            return callback(tx);
          }, config);
        }) satisfies DbClient['transaction'];
        return Reflect.get(target, key, receiver);
      } });
      const result = await auditCustomerCityBindingFkCurrent(observed,
        { role: peer.role, database: String(database) });
      expect(result).toMatchObject({ identityMatch: true, catalogMatch: true,
        readyForIndexDecision: false, foreignKey: { name: 'ccdbinding_attempt_fk', exact: true },
        indexes: { count: 4, leadingAny: 0, leadingUsableNonpartial: 0,
          leadingUsablePartial: 0, expression: 0 } });
      expect(transactions).toBe(1);
      if (!result.tables || !result.indexes) throw Error('Complete metadata expected');
      expect(result.indexes.catalogSha256).toMatch(/^[a-f0-9]{64}$/);
      for (const table of Object.values(result.tables)) {
        expect(Number(table.estimatedRows)).toBeGreaterThanOrEqual(2);
        expect(Number(table.heapBytes)).toBeGreaterThan(0);
        expect(Number(table.totalBytes)).toBeGreaterThanOrEqual(Number(table.heapBytes));
        expect(table.lastAnalyzeMs).toMatch(/^\d{13}$/);
      }
      expect(await f.query(`SELECT (SELECT count(*) FROM public.customer_city_delivery_attempt) AS attempts,
        (SELECT count(*) FROM public.customer_city_delivery_binding) AS bindings`)).toEqual(before);
    });
  });

  it('caps inherited zero timeouts and preserves tighter settings inside the read-only transaction', async () => {
    if (!f.withRuntimeRole) throw Error('Actual PostgreSQL LOGIN required');
    await f.withRuntimeRole(async peer => {
      const [{ database }] = await peer.exec('SELECT current_database() AS database');
      for (const scenario of [
        { inherited: [0, 0, 0], expected: [5000, 1000, 5000] },
        { inherited: [4000, 750, 4000], expected: [4000, 750, 4000] },
      ]) {
        const bounded = new Proxy(peer.db, { get(target, key, receiver) {
          if (key === 'transaction') return ((callback, config) =>
            target.transaction(async tx => {
              await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${scenario.inherited[0]}ms'`));
              await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${scenario.inherited[1]}ms'`));
              await tx.execute(sql.raw(`SET LOCAL idle_in_transaction_session_timeout = '${scenario.inherited[2]}ms'`));
              const result = await callback(tx);
              const [settings] = await tx.execute(sql<{ statement: number; lock: number; idle: number }>`
                SELECT (SELECT setting::integer FROM pg_catalog.pg_settings WHERE name='statement_timeout') AS statement,
                  (SELECT setting::integer FROM pg_catalog.pg_settings WHERE name='lock_timeout') AS lock,
                  (SELECT setting::integer FROM pg_catalog.pg_settings
                    WHERE name='idle_in_transaction_session_timeout') AS idle`);
              expect([settings.statement, settings.lock, settings.idle]).toEqual(scenario.expected);
              return result;
            }, config)) satisfies DbClient['transaction'];
          return Reflect.get(target, key, receiver);
        } });
        expect(await auditCustomerCityBindingFkCurrent(bounded,
          { role: peer.role, database: String(database) })).toMatchObject({
          identityMatch: true, catalogMatch: true, readyForIndexDecision: false });
      }
    });
  });

  it('fails closed for wrong LOGIN/database and changed FK, but records a new leading index as evidence', async () => {
    if (!f.withRuntimeRole) throw Error('Actual PostgreSQL LOGIN required');
    await f.withRuntimeRole(async peer => {
      const [{ database }] = await peer.exec('SELECT current_database() AS database');
      for (const expected of [{ role: 'wrong_login', database: String(database) },
        { role: peer.role, database: 'wrong_database' }])
        expect(await auditCustomerCityBindingFkCurrent(peer.db, expected)).toMatchObject({
          identityMatch: false, catalogMatch: false, tables: null, indexes: null });
      await f.exec(`CREATE INDEX ccdbinding_attempt_probe_idx ON public.customer_city_delivery_binding(attempt_id)`);
      try {
        expect(await auditCustomerCityBindingFkCurrent(peer.db,
          { role: peer.role, database: String(database) })).toMatchObject({
          identityMatch: true, catalogMatch: true, indexes: { count: 5,
            leadingAny: 1, leadingUsableNonpartial: 1 } });
      } finally { await f.exec(`DROP INDEX public.ccdbinding_attempt_probe_idx`); }
      await f.exec(`ALTER TABLE public.customer_city_delivery_binding DROP CONSTRAINT ccdbinding_attempt_fk;
        ALTER TABLE public.customer_city_delivery_binding ADD CONSTRAINT ccdbinding_attempt_fk
          FOREIGN KEY(attempt_id) REFERENCES public.customer_city_delivery_attempt(id) ON DELETE CASCADE`);
      try {
        expect(await auditCustomerCityBindingFkCurrent(peer.db,
          { role: peer.role, database: String(database) })).toMatchObject({
          identityMatch: true, catalogMatch: false, tables: null, indexes: null });
      } finally {
        await f.exec(`ALTER TABLE public.customer_city_delivery_binding DROP CONSTRAINT ccdbinding_attempt_fk;
          ALTER TABLE public.customer_city_delivery_binding ADD CONSTRAINT ccdbinding_attempt_fk
            FOREIGN KEY(attempt_id) REFERENCES public.customer_city_delivery_attempt(id) ON DELETE RESTRICT`);
      }
    });
  });
});
