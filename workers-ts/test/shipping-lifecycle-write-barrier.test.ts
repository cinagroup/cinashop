import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { auditShippingLifecycleBaseline } from '../src/migrations/auditShippingLifecycleBaseline';
import { withShippingLifecycleWriteBarrier } from '../src/migrations/withShippingLifecycleWriteBarrier';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';
import { installShippingTemplateLifecycleCandidate, SHIPPING_LIFECYCLE_CANDIDATE_SQL } from './helpers/shippingTemplateLifecycleCandidate';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';

const refs = ['store_product', 'store_seckill', 'store_bargain', 'store_combination', 'store_integral', 'store_discounts_products'] as const;
const targets = ['shipping_templates', ...refs].sort();
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('shipping installation write barrier on full ORM PG16', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  beforeAll(async () => {
    f = await sequenceRunnerDatabase();
    const api = await import('drizzle-kit/api'), models = await import('../src/models/schema');
    await f.exec((await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(models))).join('\n'));
    await f.exec("INSERT INTO store_order(id,order_id,pay_postage) VALUES(999,'barrier-history','12.34')");
  }, 120000);
  afterAll(async () => { await f?.close(); }, 45000);
  beforeEach(async () => {
    // Only exact protocol objects and rows in this helper-owned random database.
    await f.exec(`DROP FUNCTION IF EXISTS public.shipping_lifecycle_child() CASCADE;
      DROP FUNCTION IF EXISTS public.shipping_lifecycle_parent() CASCADE;
      DROP FUNCTION IF EXISTS public.shipping_lifecycle_no_truncate() CASCADE;
      DROP FUNCTION IF EXISTS public.shipping_lifecycle_bind(integer,integer,integer);
      DROP FUNCTION IF EXISTS public.shipping_lifecycle_ref(integer,integer);
      DROP TABLE IF EXISTS public.qa_install_marker;
      TRUNCATE ${targets.join(',')} RESTART IDENTITY CASCADE;
      INSERT INTO shipping_templates(id,name) VALUES(1,'default'),(10,'bound');
      INSERT INTO store_product(id,temp_id,freight) VALUES(1,0,1)`);
  });
  const bind = (table: typeof refs[number], template = 10) => table === 'store_product'
    ? `UPDATE store_product SET temp_id=${template},freight=3 WHERE id=1`
    : `INSERT INTO ${table}(id,product_id,temp_id${table === 'store_discounts_products' ? '' : ',freight'}) VALUES(2,1,${template}${table === 'store_discounts_products' ? '' : ',3'})`;
  const state = () => f.query(`SELECT jsonb_build_object(${[...targets, 'store_order'].map(table =>
    `'${table}',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM ${table} r)`).join(',')}) AS snapshot`);
  const installed = () => f.query("SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'shipping_lifecycle_%' ORDER BY proname");

  it.each(refs)('refuses candidate installation over incompatible retained %s rows before creating any protocol object', async table => {
    await f.exec(bind(table, 999));
    const before = await state();
    await expect(installShippingTemplateLifecycleCandidate(f.db)).rejects.toThrow('baseline is incompatible');
    expect((await installed()).rows).toEqual([]);
    expect(await state()).toEqual(before);
  });

  it('does not trust a previously successful read-only report after another connection commits an invalid binding', async () => {
    expect((await auditShippingLifecycleBaseline(f.db)).baselineReady).toBe(true);
    await f.withPeer!(async writer => { await writer.exec(bind('store_bargain', 999)); });
    const callback = vi.fn(async () => {}), before = await state();
    await expect(withShippingLifecycleWriteBarrier(f.db, callback)).rejects.toThrow('baseline is incompatible');
    expect(callback).not.toHaveBeenCalled(); expect(await state()).toEqual(before);
  });

  it.each(targets)('refuses NOWAIT when %s already has a writer, releases partial locks and never calls installation', async table => {
    await f.withPeer!(async writer => {
      await writer.exec(`BEGIN; LOCK TABLE public.${table} IN ROW EXCLUSIVE MODE`);
      try {
        const callback = vi.fn(async () => {});
        await expect(withShippingLifecycleWriteBarrier(f.db, callback)).rejects.toMatchObject({ cause: { code: '55P03' } });
        expect(callback).not.toHaveBeenCalled();
        expect((await f.query("SELECT relation FROM pg_locks WHERE pid=pg_backend_pid() AND mode='ShareRowExclusiveLock'")).rows).toEqual([]);
      } finally { await writer.exec('ROLLBACK'); }
    });
    await withShippingLifecycleWriteBarrier(f.db, async () => {});
  });

  it('holds all seven write barriers, permits readers and refuses a second installer', async () => {
    await f.withPeer!(async installer => {
      await withShippingLifecycleWriteBarrier(installer.db, async tx => {
        const locks = await tx.select({ table: sql<string>`c.relname` }).from(sql`pg_catalog.pg_locks l
          JOIN pg_catalog.pg_class c ON c.oid=l.relation JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
          WHERE l.pid=pg_backend_pid() AND l.granted AND l.mode='ShareRowExclusiveLock' AND n.nspname='public'`).orderBy(sql`c.relname`);
        expect(locks.map(row => row.table)).toEqual(targets);
        expect((await f.query('SELECT count(*)::int AS n FROM shipping_templates')).rows).toEqual([{ n: 2 }]);
        await expect(withShippingLifecycleWriteBarrier(f.db, async () => {})).rejects.toMatchObject({ cause: { code: '55P03' } });
      });
    });
  });

  it('keeps a queued writer outside validation and DDL, then enforces the newly committed trigger', async () => {
    await f.withPeer!(async installer => f.withPeer!(async writer => {
      let writing: ReturnType<typeof outcome> | undefined;
      await withShippingLifecycleWriteBarrier(installer.db, async tx => {
        writing = outcome(writer.exec(bind('store_bargain', 999)));
        await waitForFinanceBlock(f.db, writer.pid, installer.pid);
        await tx.execute(sql.raw(SHIPPING_LIFECYCLE_CANDIDATE_SQL));
      });
      expect(await writing).toMatchObject({ ok: false, error: { code: '23503' } });
      expect((await f.query('SELECT * FROM store_bargain')).rows).toEqual([]);
      expect((await auditShippingLifecycleBaseline(f.db)).baselineReady).toBe(true);
    }));
  }, 15000);

  it('rolls back partial DDL and data on callback failure, then releases the barrier for a new installer', async () => {
    const before = await state();
    await expect(withShippingLifecycleWriteBarrier(f.db, async tx => {
      await tx.execute(sql.raw('CREATE TABLE public.qa_install_marker(id integer); UPDATE public.store_product SET stock=99'));
      throw new Error('synthetic-install-failure');
    })).rejects.toThrow('synthetic-install-failure');
    expect((await f.query("SELECT to_regclass('public.qa_install_marker') AS marker")).rows).toEqual([{ marker: null }]);
    expect(await state()).toEqual(before);
    await installShippingTemplateLifecycleCandidate(f.db);
    expect((await installed()).rows).toHaveLength(5);
  });

  it('rejects incompatible schema before callback and preserves the existing shape', async () => {
    await f.exec('ALTER TABLE store_bargain ALTER COLUMN temp_id DROP NOT NULL');
    try {
      const callback = vi.fn(async () => {});
      await expect(withShippingLifecycleWriteBarrier(f.db, callback)).rejects.toThrow('baseline is incompatible');
      expect(callback).not.toHaveBeenCalled();
    } finally { await f.exec('ALTER TABLE store_bargain ALTER COLUMN temp_id SET NOT NULL'); }
  });

  it('refuses inherited target tables without touching the descendant', async () => {
    await f.exec('CREATE TABLE public.qa_barrier_descendant() INHERITS(public.store_bargain)');
    try {
      const callback = vi.fn(async () => {});
      await expect(withShippingLifecycleWriteBarrier(f.db, callback)).rejects.toThrow('baseline is incompatible');
      expect(callback).not.toHaveBeenCalled();
      expect((await f.query("SELECT to_regclass('public.qa_barrier_descendant')::text AS name")).rows)
        .toEqual([{ name: 'qa_barrier_descendant' }]);
    } finally { await f.exec('DROP TABLE public.qa_barrier_descendant'); }
  });

  it('preserves a colliding function and rolls back every earlier candidate DDL statement', async () => {
    await f.exec('CREATE FUNCTION public.shipping_lifecycle_parent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$');
    const definition = () => f.query("SELECT oid,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE oid='public.shipping_lifecycle_parent()'::regprocedure");
    const before = await definition(), rows = await state();
    await expect(installShippingTemplateLifecycleCandidate(f.db)).rejects.toMatchObject({ cause: { code: '42723' } });
    expect(await definition()).toEqual(before); expect(await state()).toEqual(rows);
    expect((await installed()).rows).toEqual([{ proname: 'shipping_lifecycle_parent' }]);
  });

  it('refuses a SELECT-only LOGIN and fails closed when a writable LOGIN would have RLS-hidden rows', async () => {
    await f.exec(bind('store_bargain', 999));
    await f.withRuntimeRole!(async runtime => {
      await f.exec(`GRANT SELECT ON ${targets.join(',')} TO "${runtime.role}"`);
      const callback = vi.fn(async () => {});
      await expect(withShippingLifecycleWriteBarrier(runtime.db, callback)).rejects.toMatchObject({ cause: { code: '42501' } });
      await f.exec(`GRANT UPDATE ON ${targets.join(',')} TO "${runtime.role}";
        ALTER TABLE store_bargain ENABLE ROW LEVEL SECURITY; CREATE POLICY qa_barrier_hidden ON store_bargain USING(false)`);
      try {
        await expect(withShippingLifecycleWriteBarrier(runtime.db, callback)).rejects.toMatchObject({ cause: { code: '42501' } });
        expect(callback).not.toHaveBeenCalled();
      } finally { await f.exec('DROP POLICY qa_barrier_hidden ON store_bargain; ALTER TABLE store_bargain DISABLE ROW LEVEL SECURITY'); }
    });
  });

  it('preserves stricter session deadlines, overrides inherited RR locally and rejects nested transaction input', async () => {
    await f.withPeer!(async peer => {
      await peer.exec("SET default_transaction_isolation='repeatable read'; SET statement_timeout='4000ms'; SET lock_timeout='500ms'; SET idle_in_transaction_session_timeout='3500ms'");
      await withShippingLifecycleWriteBarrier(peer.db, async tx => {
        const [row] = await tx.select({ isolation: sql<string>`current_setting('transaction_isolation')`,
          statement: sql<string>`current_setting('statement_timeout')`, lock: sql<string>`current_setting('lock_timeout')`,
          idle: sql<string>`current_setting('idle_in_transaction_session_timeout')` }).from(sql`(VALUES(1)) q(n)`);
        expect(row).toEqual({ isolation: 'read committed', statement: '4s', lock: '500ms', idle: '3500ms' });
        await expect(withShippingLifecycleWriteBarrier(tx, async () => {})).rejects.toThrow('root database');
      });
      expect(await peer.exec("SELECT current_setting('default_transaction_isolation') AS isolation")).toMatchObject([{ isolation: 'repeatable read' }]);
    });
  });
});
