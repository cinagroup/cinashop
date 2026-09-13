import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Container, DbClient } from '../src/lib/di';
import { MigrationService } from '../src/services/MigrationService';
import { runShippingLifecycle } from '../src/migrations/runShippingLifecycle';
import { SHIPPING_LIFECYCLE_INSTALLATION_SQL } from '../src/migrations/shippingLifecycleInstallation';
import { inspectShippingLifecycleProtocol } from '../src/migrations/inspectShippingLifecycleProtocol';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';
import { shippingLifecycleCatalogMutations } from './helpers/shippingLifecycleCatalogMutations';

const fileSql = readFileSync('migrations/0152_shipping_lifecycle.sql', 'utf8');
type Owned = Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
const rawInstall = (db: DbClient) => db.transaction(async tx => { await tx.execute(sql.raw(fileSql)); },
  { isolationLevel: 'read committed', accessMode: 'read write' });
const orm = async (f: Owned) => {
  const api = await import('drizzle-kit/api'), models = await import('../src/models/schema');
  await f.exec((await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(models))).join('\n'));
};
const seed = (f: Owned) => f.exec(`INSERT INTO public."user"(uid,account) VALUES(101,'shipping-history-user');
  INSERT INTO public.shipping_templates(id,name) VALUES(1,'default'),(10,'bound');
  INSERT INTO public.store_product(id,temp_id,freight) VALUES(1,10,3);
  INSERT INTO public.store_order(id,uid,order_id,pay_postage) VALUES(999,101,'shipping-upgrade-history','12.34')`);
const data = (f: Owned) => f.query(`SELECT jsonb_build_object(
  'products',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.store_product p),
  'templates',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.shipping_templates p),
  'orders',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.store_order p),
  'users',(SELECT jsonb_agg(to_jsonb(p) ORDER BY uid) FROM public."user" p),
  'sequences',(SELECT jsonb_agg(to_jsonb(p) ORDER BY sequencename) FROM pg_sequences p WHERE schemaname='public')) AS state`);
const protocol = (f: Owned) => f.query(`SELECT jsonb_build_object(
  'functions',(SELECT jsonb_agg(to_jsonb(p) ORDER BY oid) FROM pg_proc p WHERE pronamespace='public'::regnamespace AND starts_with(proname,'shipping_lifecycle_')),
  'triggers',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
    WHERE p.pronamespace='public'::regnamespace AND starts_with(p.proname,'shipping_lifecycle_'))) AS state`);
const removeProtocol = async (f: Owned) => {
  const rows = (await f.query("SELECT oid::regprocedure::text AS signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'shipping_lifecycle_') ORDER BY oid")).rows;
  // Exact signatures in a helper-owned random database, including test mutations.
  for (const row of rows as { signature: string }[]) await f.exec(`DROP ROUTINE IF EXISTS ${row.signature} CASCADE`);
};

it('mirrors filesystem 0152 exactly in embedded 0158', () => {
  expect(fileSql.trim()).toBe(SHIPPING_LIFECYCLE_INSTALLATION_SQL.trim());
  expect(new MigrationService({} as Container).shippingLifecycleMigrationSqlForVerification()).toBe(SHIPPING_LIFECYCLE_INSTALLATION_SQL);
});
it('rejects non-root maintenance input before invoking a transaction', async () => {
  await expect(runShippingLifecycle({ transaction: () => { throw new Error('unexpected SQL'); } })).rejects.toThrow('root database');
});

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('registered shipping migration complete PG16 construction paths', () => {
  it.each(['external', 'embedded', 'orm-upgrade'])('verifies complete %s construction, preserved history and repeat upgrade', async path => {
    const f = await sequenceRunnerDatabase();
    try {
      if (path === 'external') {
        for (const name of readdirSync('migrations').filter(n => /^\d{4}.*\.sql$/.test(n)).sort()) {
          await f.db.transaction(async tx => {
            await tx.execute(sql.raw('SET LOCAL search_path=public,pg_temp'));
            await tx.execute(sql.raw(readFileSync(`migrations/${name}`, 'utf8')));
          });
        }
      } else if (path === 'embedded') {
        const result = await new MigrationService({ db: f.db } as Container).runAll();
        expect(result).toEqual({ executed: Array.from({ length: 160 }, (_, i) => String(i).padStart(4,'0')), errors: [] });
      } else await orm(f);
      expect((await inspectShippingLifecycleProtocol(f.db)).state).toBe(path === 'orm-upgrade' ? 'absent' : 'complete');
      await seed(f);
      const before = await data(f);
      expect(await runShippingLifecycle(f.db)).toEqual({ applied: path === 'orm-upgrade' });
      expect(await data(f)).toEqual(before);
      expect((await inspectShippingLifecycleProtocol(f.db)).state).toBe('complete');
      const installed = await protocol(f);
      expect(await runShippingLifecycle(f.db)).toEqual({ applied: false });
      await rawInstall(f.db);
      expect(await protocol(f)).toEqual(installed); expect(await data(f)).toEqual(before);
      await expect(f.exec('UPDATE public.shipping_templates SET is_del=1 WHERE id=10')).rejects.toMatchObject({ code: '23503' });
      await expect(f.exec('UPDATE public.store_product SET temp_id=999 WHERE id=1')).rejects.toMatchObject({ code: '23503' });
      expect(await data(f)).toEqual(before);
    } finally { await f.close(); }
  }, 120000);
});

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('raw shipping SQL cannot bypass maintenance validation on PG16', () => {
  let f: Owned;
  beforeAll(async () => { f=await sequenceRunnerDatabase(); await orm(f); await seed(f); }, 120000);
  afterAll(async () => { await f?.close(); }, 45000);
  beforeEach(async () => { await removeProtocol(f); });

  it('installs atomically when the complete file is sent as one implicit-transaction SQL message', async () => {
    const before = await data(f);
    await f.exec(fileSql);
    expect((await inspectShippingLifecycleProtocol(f.db)).state).toBe('complete');
    expect(await data(f)).toEqual(before);
  });

  it('rejects a detached DO block without the required bounded transaction settings', async () => {
    const body = fileSql.slice(fileSql.indexOf('DO $shipping_install_0152$'));
    await expect(f.db.transaction(async tx => {
      await tx.execute(sql.raw("SET LOCAL statement_timeout='0'"));
      await tx.execute(sql.raw(body));
    })).rejects.toMatchObject({ cause: { message: 'Shipping installation requires bounded transaction settings' } });
    expect((await inspectShippingLifecycleProtocol(f.db)).state).toBe('absent');
  });

  it.each(shippingLifecycleCatalogMutations)('rejects raw-file %s drift and preserves exact prior objects/data', async (_kind, alteration) => {
    await rawInstall(f.db);
    await f.exec(alteration);
    const before = await protocol(f), rows = await data(f);
    await expect(rawInstall(f.db)).rejects.toMatchObject({ cause: { message: 'Shipping lifecycle protocol catalog differs' } });
    expect(await protocol(f)).toEqual(before); expect(await data(f)).toEqual(rows);
  });

  it.each(['store_product','store_seckill','store_bargain','store_combination','store_integral','store_discounts_products'])(
    'rejects invalid retained %s references before raw DDL', async table => {
      const packageTable = table === 'store_discounts_products';
      if (table === 'store_product') await f.exec('UPDATE store_product SET temp_id=999 WHERE id=1');
      else await f.exec(`INSERT INTO ${table}(id,product_id,temp_id${packageTable ? '' : ',freight'}) VALUES(20,1,999${packageTable ? '' : ',3'})`);
      try {
        const before = await data(f), rows = await f.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY id`);
        await expect(rawInstall(f.db)).rejects.toMatchObject({ cause: { message: 'Shipping installation baseline is incompatible' } });
        expect((await inspectShippingLifecycleProtocol(f.db)).state).toBe('absent');
        expect(await data(f)).toEqual(before); expect(await f.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY id`)).toEqual(rows);
      } finally {
        if (table === 'store_product') await f.exec('UPDATE store_product SET temp_id=10 WHERE id=1');
        else await f.exec(`DELETE FROM ${table} WHERE id=20`);
      }
    });

  it('rolls back every newly created object when default ACLs fail the post-install check', async () => {
    await f.withRuntimeRole!(async role => {
      await f.exec(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO "${role.role}"`);
      try {
        const before = await data(f);
        await expect(rawInstall(f.db)).rejects.toMatchObject({ cause: { message: 'Shipping lifecycle protocol catalog differs after installation' } });
        expect((await inspectShippingLifecycleProtocol(f.db)).state).toBe('absent'); expect(await data(f)).toEqual(before);
      } finally { await f.exec(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM "${role.role}"`); }
    });
  });

  it.each(['ddl_command_start','ddl_command_end'])('refuses raw-file %s side effects without changing history', async event => {
    await f.exec(`CREATE FUNCTION public.qa_shipping_file_event() RETURNS event_trigger LANGUAGE plpgsql AS $$
      BEGIN UPDATE public.store_order SET pay_postage='99.99' WHERE id=999; END $$;
      CREATE EVENT TRIGGER qa_shipping_file_event ON ${event} WHEN TAG IN ('CREATE FUNCTION','CREATE TRIGGER') EXECUTE FUNCTION public.qa_shipping_file_event()`);
    try {
      const before = await data(f);
      await expect(rawInstall(f.db)).rejects.toMatchObject({ cause: { message: 'Shipping installation environment requires review' } });
      expect(await data(f)).toEqual(before); expect((await inspectShippingLifecycleProtocol(f.db)).state).toBe('absent');
    } finally { await f.exec('DROP EVENT TRIGGER qa_shipping_file_event; DROP FUNCTION public.qa_shipping_file_event()'); }
  });

  it('refuses raw-file replica mode without rewriting the session', async () => {
    await f.exec('SET session_replication_role=replica');
    try {
      await expect(rawInstall(f.db)).rejects.toMatchObject({ cause: { message: 'Shipping installation environment requires review' } });
      expect((await f.query("SELECT current_setting('session_replication_role') AS mode")).rows).toEqual([{ mode: 'replica' }]);
      expect((await inspectShippingLifecycleProtocol(f.db)).state).toBe('absent');
    } finally { await f.exec('SET session_replication_role=origin'); }
  });

  it('refuses a raw-file RR transaction without changing its isolation', async () => {
    await expect(f.db.transaction(async tx => { await tx.execute(sql.raw(fileSql)); }, { isolationLevel: 'repeatable read' }))
      .rejects.toMatchObject({ cause: { message: 'Shipping installation requires a PostgreSQL 16 read-write read-committed transaction' } });
    expect((await inspectShippingLifecycleProtocol(f.db)).state).toBe('absent');
  });

  it('refuses an existing writer and releases every partial raw-file table lock', async () => {
    await f.withPeer!(async writer => {
      await writer.exec('BEGIN; LOCK TABLE public.store_product IN ROW EXCLUSIVE MODE');
      try {
        await expect(rawInstall(f.db)).rejects.toMatchObject({ cause: { code: '55P03' } });
        expect((await f.query("SELECT relation FROM pg_locks WHERE pid=pg_backend_pid() AND mode='ShareRowExclusiveLock'")).rows).toEqual([]);
        expect((await inspectShippingLifecycleProtocol(f.db)).state).toBe('absent');
      } finally { await writer.exec('ROLLBACK'); }
    });
  });
});
