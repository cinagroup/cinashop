import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import type { DbClient } from '../src/lib/di';
import { auditWorkParentCapacityStats } from '../src/migrations/auditWorkParentCapacityStats';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';

it('rejects a non-root client or unsafe expected identity before SQL', async () => {
  const unavailable = { $client: {}, transaction: () => { throw Error('SQL reached'); } } as unknown as DbClient;
  await expect(auditWorkParentCapacityStats({ transaction: unavailable.transaction },
    { role: 'app', database: 'postgres' })).rejects.toThrow('root database');
  for (const expected of [{ role: 'app;grant', database: 'postgres' },
    { role: 'app', database: 'postgres;drop' }]) {
    await expect(auditWorkParentCapacityStats(unavailable, expected)).rejects.toThrow('Invalid expected');
  }
});

it('stops after a mismatched backend within one read-only transaction', async () => {
  const execute = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ matches: false }]);
  const transaction = vi.fn((callback: (tx: { execute: typeof execute }) => Promise<unknown>) =>
    callback({ execute }));
  const db = { $client: {}, transaction } as unknown as DbClient;
  expect(await auditWorkParentCapacityStats(db, { role: 'cinashop_app_v1', database: 'postgres' }))
    .toEqual({ scope: 'work-parent-capacity-metadata-only', identityMatch: false,
      catalogMatch: false, tables: null, index: null, statisticsTargets: null });
  expect(transaction).toHaveBeenCalledExactlyOnceWith(expect.any(Function),
    { isolationLevel: 'repeatable read', accessMode: 'read only' });
  expect(execute).toHaveBeenCalledTimes(2);
});

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('PG16 current-app metadata probe', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  type Runtime = SequenceRunnerPeer & { role: string; connectionString: string };
  const withRuntime = async (callback: (peer: Runtime, database: string) => Promise<void>) => {
    if (!f.withRuntimeRole) throw Error('Actual PostgreSQL LOGIN required');
    await f.withRuntimeRole(async peer => {
      await f.exec(`GRANT SELECT ON public.work_client_current,public.work_callback_event,
        public.work_contact_action_outbox TO "${peer.role}"`);
      const [{ database }] = await peer.exec('SELECT current_database() AS database');
      await callback(peer, String(database));
    });
  };
  beforeAll(async () => {
    f = await sequenceRunnerDatabase();
    if (f.format !== 'pg16') throw Error('PG16 fixture required');
    await f.exec(`CREATE TABLE public.work_client_current(corp_id varchar(18),id integer);
      CREATE TABLE public.work_callback_event(id integer);
      CREATE TABLE public.work_contact_action_outbox(corp_id varchar(18),client_id integer);
      CREATE INDEX wcao_client_ref ON public.work_contact_action_outbox USING btree(corp_id,client_id);
      INSERT INTO public.work_client_current VALUES('fixture',1),('fixture',2);
      INSERT INTO public.work_callback_event VALUES(1),(2);
      INSERT INTO public.work_contact_action_outbox VALUES('fixture',1),('fixture',2);
      ALTER TABLE public.work_contact_action_outbox ALTER COLUMN corp_id SET STATISTICS 250;
      ANALYZE public.work_client_current; ANALYZE public.work_callback_event;
      ANALYZE public.work_contact_action_outbox`);
  }, 120000);
  afterAll(async () => { await f?.close(); }, 45000);

  it('collects only fixed table/index estimates and targets under the actual least-privilege LOGIN', async () => {
    await withRuntime(async (peer, database) => {
      const before = await f.query(`SELECT
        (SELECT count(*) FROM public.work_client_current) AS clients,
        (SELECT count(*) FROM public.work_callback_event) AS events,
        (SELECT count(*) FROM public.work_contact_action_outbox) AS actions`);
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
      const result = await auditWorkParentCapacityStats(observed, { role: peer.role, database });
      expect(result).toMatchObject({ identityMatch: true, catalogMatch: true,
        index: { name: 'wcao_client_ref', exact: true },
        statisticsTargets: { corp_id: { configured: 250, effective: 250 },
          client_id: { configured: -1 } } });
      expect(transactions).toBe(1);
      if (!result.catalogMatch || !result.tables) throw Error('Complete catalog expected');
      expect(Object.keys(result.tables).sort()).toEqual([
        'work_callback_event', 'work_client_current', 'work_contact_action_outbox']);
      for (const table of Object.values(result.tables)) {
        expect(Number(table.estimatedRows)).toBeGreaterThanOrEqual(2);
        expect(Number(table.heapBytes)).toBeGreaterThan(0);
        expect(Number(table.totalBytes)).toBeGreaterThanOrEqual(Number(table.heapBytes));
        expect(table.lastAnalyzeMs).toMatch(/^\d{13}$/);
      }
      expect(await f.query(`SELECT
        (SELECT count(*) FROM public.work_client_current) AS clients,
        (SELECT count(*) FROM public.work_callback_event) AS events,
        (SELECT count(*) FROM public.work_contact_action_outbox) AS actions`)).toEqual(before);
    });
  });

  it('fails closed for a different LOGIN/database and index definition drift', async () => {
    await withRuntime(async (peer, database) => {
      for (const expected of [{ role: 'wrong_login', database },
        { role: peer.role, database: 'wrong_database' }]) {
        expect(await auditWorkParentCapacityStats(peer.db, expected)).toMatchObject({
          identityMatch: false, catalogMatch: false, tables: null, index: null });
      }
      await f.exec(`DROP INDEX public.wcao_client_ref;
        CREATE INDEX wcao_client_ref ON public.work_contact_action_outbox(client_id,corp_id)`);
      try {
        expect(await auditWorkParentCapacityStats(peer.db, { role: peer.role, database }))
          .toMatchObject({ identityMatch: true, catalogMatch: false,
            tables: null, index: null, statisticsTargets: null });
      } finally {
        await f.exec(`DROP INDEX public.wcao_client_ref;
          CREATE INDEX wcao_client_ref ON public.work_contact_action_outbox(corp_id,client_id)`);
      }
    });
  });
});
