import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';
import { installShippingTemplateLifecycleCandidate } from './helpers/shippingTemplateLifecycleCandidate';
import { inspectShippingLifecycleProtocol } from '../src/migrations/inspectShippingLifecycleProtocol';

import { shippingLifecycleCatalogMutations as alterations } from './helpers/shippingLifecycleCatalogMutations';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('shipping protocol exact catalog and idempotence on owned PG16', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  beforeAll(async () => {
    f = await sequenceRunnerDatabase();
    const api = await import('drizzle-kit/api'), models = await import('../src/models/schema');
    await f.exec((await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(models))).join('\n'));
    await f.exec("INSERT INTO shipping_templates(id,name) VALUES(1,'default'),(10,'bound'); INSERT INTO store_product(id,temp_id,freight) VALUES(1,10,3); INSERT INTO store_order(id,order_id,pay_postage) VALUES(999,'catalog-history','12.34')");
  }, 120000);
  afterAll(async () => { await f?.close(); }, 45000);
  const removeOwnedProtocol = async () => {
    // Resolve exact routine identities only in this helper-created random DB.
    // CASCADE removes this test's trigger attachments, including deliberate drift.
    const rows = await f.query("SELECT p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND starts_with(p.proname,'shipping_lifecycle_') ORDER BY p.oid");
    for (const row of rows.rows as Array<{ signature: string }>) await f.exec(`DROP ROUTINE IF EXISTS ${row.signature} CASCADE`);
  };
  beforeEach(async () => { await removeOwnedProtocol(); });
  const data = () => f.query("SELECT jsonb_build_object('products',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM store_product p),'templates',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM shipping_templates p),'orders',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM store_order p)) AS snapshot");
  const catalog = () => f.query(`SELECT jsonb_build_object(
    'functions',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND starts_with(p.proname,'shipping_lifecycle_')),
    'triggers',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND starts_with(p.proname,'shipping_lifecycle_'))) AS snapshot`);

  it('creates the absent protocol once and repeat installation preserves exact OIDs, definitions, ACLs, triggers and nonempty data', async () => {
    const before = await data();
    expect(await inspectShippingLifecycleProtocol(f.db)).toMatchObject({ state: 'absent', functionCount: 0, triggerCount: 0 });
    expect(await installShippingTemplateLifecycleCandidate(f.db)).toEqual({ applied: true });
    expect(await inspectShippingLifecycleProtocol(f.db)).toMatchObject({ state: 'complete', functionCount: 5, triggerCount: 9, runtimePrivilegesVerified: false });
    const installed = await catalog();
    expect(await installShippingTemplateLifecycleCandidate(f.db)).toEqual({ applied: false });
    expect(await catalog()).toEqual(installed); expect(await data()).toEqual(before);
    await expect(f.exec('UPDATE shipping_templates SET is_del=1 WHERE id=10')).rejects.toMatchObject({ code: '23503' });
  });

  it.each(alterations)('rejects %s drift without overwriting or repairing existing objects', async (_kind, statement) => {
    await installShippingTemplateLifecycleCandidate(f.db); await f.exec(statement);
    const before = await catalog(), rows = await data();
    expect((await inspectShippingLifecycleProtocol(f.db)).state).toBe('drift');
    await expect(installShippingTemplateLifecycleCandidate(f.db)).rejects.toThrow('protocol catalog differs');
    expect(await catalog()).toEqual(before); expect(await data()).toEqual(rows);
  });

  it('treats a partial preexisting function as drift, not an empty installation', async () => {
    await f.exec('CREATE FUNCTION public.shipping_lifecycle_parent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$');
    const before = await catalog();
    await expect(installShippingTemplateLifecycleCandidate(f.db)).rejects.toThrow('protocol catalog differs');
    expect(await catalog()).toEqual(before);
  });

  it('rejects changed function ownership and an additional grantee/grant option without modifying them', async () => {
    await installShippingTemplateLifecycleCandidate(f.db);
    await f.withRuntimeRole!(async runtime => {
      await f.exec(`GRANT EXECUTE ON FUNCTION public.shipping_lifecycle_ref(integer,integer) TO "${runtime.role}" WITH GRANT OPTION`);
      const granted = await catalog();
      await expect(installShippingTemplateLifecycleCandidate(f.db)).rejects.toThrow('protocol catalog differs');
      expect(await catalog()).toEqual(granted);
      await f.exec(`REVOKE ALL ON FUNCTION public.shipping_lifecycle_ref(integer,integer) FROM "${runtime.role}";
        ALTER FUNCTION public.shipping_lifecycle_ref(integer,integer) OWNER TO "${runtime.role}"`);
      try {
        const owned = await catalog();
        await expect(installShippingTemplateLifecycleCandidate(f.db)).rejects.toThrow('protocol catalog differs');
        expect(await catalog()).toEqual(owned);
      } finally { await f.exec('ALTER FUNCTION public.shipping_lifecycle_ref(integer,integer) OWNER TO finance_test'); }
    });
  });

  it('post-validates default privilege drift and rolls back all newly created functions and triggers', async () => {
    await f.withRuntimeRole!(async runtime => {
      await f.exec(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO "${runtime.role}"`);
      try {
        const before = await data();
        await expect(installShippingTemplateLifecycleCandidate(f.db)).rejects.toThrow('catalog differs after installation');
        expect((await inspectShippingLifecycleProtocol(f.db)).state).toBe('absent');
        expect(await data()).toEqual(before);
      } finally { await f.exec(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM "${runtime.role}"`); }
    });
  });

  it('rejects changed trigger-table ownership without transferring it back automatically', async () => {
    await installShippingTemplateLifecycleCandidate(f.db);
    await f.withRuntimeRole!(async runtime => {
      await f.exec(`ALTER TABLE public.store_bargain OWNER TO "${runtime.role}"`);
      try {
        await expect(installShippingTemplateLifecycleCandidate(f.db)).rejects.toThrow('protocol catalog differs');
        expect((await f.query("SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid='public.store_bargain'::regclass")).rows)
          .toEqual([{ owner: runtime.role }]);
      } finally { await f.exec('ALTER TABLE public.store_bargain OWNER TO finance_test'); }
    });
  });
});
