import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { DbClient } from '../src/lib/di';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';
import { installShippingTemplateLifecycleCandidate } from './helpers/shippingTemplateLifecycleCandidate';
import { inspectShippingLifecycleProtocol } from '../src/migrations/inspectShippingLifecycleProtocol';
import { outcome } from './helpers/financePeers';
import { withShippingLifecycleWriteBarrier } from '../src/migrations/withShippingLifecycleWriteBarrier';
import { assertShippingLifecycleInstallationEnvironment } from '../src/migrations/assertShippingLifecycleInstallationEnvironment';

it.each([undefined,
  { originTriggersActive: false, noEnabledEventTriggers: true },
  { originTriggersActive: true, noEnabledEventTriggers: false },
  { originTriggersActive: true, noEnabledEventTriggers: null },
  { originTriggersActive: 1, noEnabledEventTriggers: true },
  { originTriggersActive: true, noEnabledEventTriggers: 1 },
])('fails closed for an absent or non-true installation environment result: %j', async environment => {
  const db = { select: () => ({ from: async () => environment === undefined ? [] : [environment] }) } as unknown as Pick<DbClient, 'select'>;
  await expect(assertShippingLifecycleInstallationEnvironment(db)).rejects.toThrow('installation environment requires review');
});

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('shipping installer execution environment on owned PG16', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  beforeAll(async () => {
    f = await sequenceRunnerDatabase();
    const api = await import('drizzle-kit/api'), models = await import('../src/models/schema');
    await f.exec((await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(models))).join('\n'));
    await f.exec("INSERT INTO shipping_templates(id,name) VALUES(1,'default'),(10,'bound'); INSERT INTO store_product(id,temp_id,freight) VALUES(1,10,3); INSERT INTO store_order(id,order_id,pay_postage) VALUES(999,'environment-history','12.34')");
  }, 120000);
  afterAll(async () => { await f?.close(); }, 45000);
  const removeEvents = async () => {
    await f.exec('DROP EVENT TRIGGER IF EXISTS qa_shipping_event; DROP FUNCTION IF EXISTS public.qa_shipping_event()');
  };
  beforeEach(async () => {
    // Exact test objects in the fixture-owned random DB, never the service DB.
    await removeEvents();
    await f.exec(`SET session_replication_role=origin;
      DROP FUNCTION IF EXISTS public.shipping_lifecycle_child() CASCADE;
      DROP FUNCTION IF EXISTS public.shipping_lifecycle_parent() CASCADE;
      DROP FUNCTION IF EXISTS public.shipping_lifecycle_no_truncate() CASCADE;
      DROP FUNCTION IF EXISTS public.shipping_lifecycle_bind(integer,integer,integer);
      DROP FUNCTION IF EXISTS public.shipping_lifecycle_ref(integer,integer);
      UPDATE public.store_order SET pay_postage='12.34' WHERE id=999`);
  });
  const event = async (kind: string, tags = "WHEN TAG IN ('CREATE FUNCTION','CREATE TRIGGER')") => {
    await f.exec(`CREATE FUNCTION public.qa_shipping_event() RETURNS event_trigger LANGUAGE plpgsql AS $$
      BEGIN UPDATE public.store_order SET pay_postage='99.99' WHERE id=999; END $$;
      CREATE EVENT TRIGGER qa_shipping_event ON ${kind} ${tags} EXECUTE FUNCTION public.qa_shipping_event()`);
  };
  const postage = async () => (await f.query('SELECT pay_postage::text AS value FROM public.store_order WHERE id=999')).rows[0];
  const snapshot = () => f.query(`SELECT jsonb_build_object(
    'product',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.store_product p),
    'templates',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.shipping_templates p),
    'orders',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.store_order p),
    'sequences',(SELECT jsonb_agg(to_jsonb(s) ORDER BY sequencename) FROM pg_sequences s WHERE schemaname='public'),
    'event',(SELECT jsonb_agg(to_jsonb(e) ORDER BY oid) FROM pg_event_trigger e)) AS state`);

  it.each(['ddl_command_start', 'ddl_command_end'])('refuses %s before it can mutate historical order data during successful DDL', async kind => {
    await event(kind);
    try {
      const result = await outcome(installShippingTemplateLifecycleCandidate(f.db));
      expect({ outcome: result.ok ? 'committed' : 'rejected', postage: await postage(),
        protocol: (await inspectShippingLifecycleProtocol(f.db)).state })
        .toEqual({ outcome: 'rejected', postage: { value: '12.34' }, protocol: 'absent' });
    } finally { await removeEvents(); }
  });

  it('rejects inherited replica mode without changing it or installing an origin-only protocol', async () => {
    await f.exec('SET session_replication_role=replica');
    try {
      await expect(installShippingTemplateLifecycleCandidate(f.db)).rejects.toThrow('installation environment requires review');
      expect((await inspectShippingLifecycleProtocol(f.db)).state).toBe('absent');
      expect((await f.query("SELECT current_setting('session_replication_role') AS mode")).rows).toEqual([{ mode: 'replica' }]);
    } finally { await f.exec('SET session_replication_role=origin'); }
  });

  it.each(['ENABLE', 'ENABLE ALWAYS', 'ENABLE REPLICA'])('rejects %s events even when current command tags would not fire them', async mode => {
    await event('ddl_command_end', "WHEN TAG IN ('ALTER TABLE')");
    await f.exec(`ALTER EVENT TRIGGER qa_shipping_event ${mode}`);
    try {
      const before = await snapshot(), callback = vi.fn(async () => {});
      await expect(withShippingLifecycleWriteBarrier(f.db, callback)).rejects.toThrow('installation environment requires review');
      expect(callback).not.toHaveBeenCalled();
      expect(await snapshot()).toEqual(before);
      expect((await f.query("SELECT relation FROM pg_locks WHERE pid=pg_backend_pid() AND mode='ShareRowExclusiveLock'")).rows).toEqual([]);
    } finally { await removeEvents(); }
  });

  it.each(['sql_drop', 'table_rewrite'])('requires explicit review of an enabled %s event', async kind => {
    await event(kind, '');
    try {
      const before = await snapshot();
      await expect(installShippingTemplateLifecycleCandidate(f.db)).rejects.toThrow('installation environment requires review');
      expect(await snapshot()).toEqual(before);
      expect((await inspectShippingLifecycleProtocol(f.db)).state).toBe('absent');
    } finally { await removeEvents(); }
  });

  it.each(['origin', 'local'])('permits normal first/repeat installation with disabled events in %s mode', async mode => {
    await event('ddl_command_end', '');
    await f.exec(`ALTER EVENT TRIGGER qa_shipping_event DISABLE; SET session_replication_role=${mode}`);
    try {
      const before = await snapshot();
      expect(await installShippingTemplateLifecycleCandidate(f.db)).toEqual({ applied: true });
      expect(await installShippingTemplateLifecycleCandidate(f.db)).toEqual({ applied: false });
      expect(await snapshot()).toEqual(before);
      await expect(f.exec('UPDATE public.shipping_templates SET is_del=1 WHERE id=10')).rejects.toMatchObject({ code: '23503' });
      expect((await f.query("SELECT current_setting('session_replication_role') AS mode")).rows).toEqual([{ mode }]);
    } finally { await removeEvents(); await f.exec('SET session_replication_role=origin'); }
  });

  it('does not reuse an old environment check if a peer enables an event after the table locks', async () => {
    await event('ddl_command_end');
    await f.exec('ALTER EVENT TRIGGER qa_shipping_event DISABLE');
    try {
      await f.withPeer!(async peer => {
        let intercepted = false;
        const db = new Proxy(f.db, { get(target, key, receiver) {
          if (key === 'transaction') return ((callback, config) => target.transaction(async tx => {
            const observed = new Proxy(tx, { get(inner, field, innerReceiver) {
              // Instrument the installer's awaited execute call, not Drizzle's
              // additional lazy PgRaw/batch methods (which this test never uses).
              if (field === 'execute') return async (statement: Parameters<typeof tx.execute>[0]) => {
                const result = await inner.execute(statement);
                const command = typeof statement === 'string' ? statement : new PgDialect().sqlToQuery(statement.getSQL()).sql;
                if (command.trimStart().startsWith('LOCK TABLE ONLY')) {
                  intercepted = true;
                  await peer.exec('ALTER EVENT TRIGGER qa_shipping_event ENABLE');
                }
                return result;
              };
              return Reflect.get(inner, field, innerReceiver);
            } });
            return callback(observed);
          }, config)) satisfies DbClient['transaction'];
          return Reflect.get(target, key, receiver);
        } });
        const callback = vi.fn(async () => {});
        await expect(withShippingLifecycleWriteBarrier(db, callback)).rejects.toThrow('installation environment requires review');
        expect(intercepted).toBe(true); expect(callback).not.toHaveBeenCalled();
        expect(await postage()).toEqual({ value: '12.34' });
        expect((await f.query("SELECT evtenabled FROM pg_event_trigger WHERE evtname='qa_shipping_event'")).rows).toEqual([{ evtenabled: 'O' }]);
        expect((await f.query("SELECT relation FROM pg_locks WHERE pid=pg_backend_pid() AND mode='ShareRowExclusiveLock'")).rows).toEqual([]);
      });
    } finally { await removeEvents(); }
  });

  it('rejects a newly enabled event even for a complete idempotent protocol', async () => {
    await installShippingTemplateLifecycleCandidate(f.db);
    await event('ddl_command_start');
    try {
      const before = await snapshot();
      await expect(installShippingTemplateLifecycleCandidate(f.db)).rejects.toThrow('installation environment requires review');
      expect(await snapshot()).toEqual(before);
      expect((await inspectShippingLifecycleProtocol(f.db)).state).toBe('complete');
    } finally { await removeEvents(); }
  });

  it('allows a fresh installation after the maintenance operator explicitly disables the event', async () => {
    await event('ddl_command_end');
    try {
      await expect(installShippingTemplateLifecycleCandidate(f.db)).rejects.toThrow('installation environment requires review');
      await f.exec('ALTER EVENT TRIGGER qa_shipping_event DISABLE');
      expect(await installShippingTemplateLifecycleCandidate(f.db)).toEqual({ applied: true });
      expect(await postage()).toEqual({ value: '12.34' });
    } finally { await removeEvents(); }
  });
});
