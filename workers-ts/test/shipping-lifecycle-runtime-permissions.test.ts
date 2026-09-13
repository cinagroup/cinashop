import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { auditShippingLifecycleRuntimePermissions } from '../src/migrations/auditShippingLifecycleRuntimePermissions';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';
import { installShippingTemplateLifecycleCandidate } from './helpers/shippingTemplateLifecycleCandidate';
import { inspectShippingLifecycleProtocol } from '../src/migrations/inspectShippingLifecycleProtocol';
import { createContainerFromDb, type DbClient } from '../src/lib/di';
import { retireShippingTemplate } from '../src/services/product/ShippingTemplateLifecycleService';

const children = ['store_product','store_seckill','store_bargain','store_combination','store_integral','store_discounts_products'];
const tables = ['shipping_templates', ...children];
type Runtime = SequenceRunnerPeer & { role: string; connectionString: string };
it('rejects a nested/non-root runtime audit before SQL', async () => {
  await expect(auditShippingLifecycleRuntimePermissions({ transaction: () => { throw new Error('SQL reached'); } }))
    .rejects.toThrow('root database');
});

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('shipping lifecycle actual LOGIN permission envelope', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  let sequences: string[];
  beforeAll(async () => {
    f = await sequenceRunnerDatabase();
    const api = await import('drizzle-kit/api'), models = await import('../src/models/schema');
    await f.exec((await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(models))).join('\n'));
    await installShippingTemplateLifecycleCandidate(f.db);
    await f.exec("INSERT INTO shipping_templates(name) VALUES('default'),('bound'); INSERT INTO store_product(temp_id,freight) VALUES(2,3); INSERT INTO store_order(id,order_id,pay_postage) VALUES(999,'permission-history','12.34')");
    sequences = (await f.query(`SELECT pg_get_serial_sequence('public.'||name,'id') AS name FROM unnest(ARRAY[${tables.map(t => `'${t}'`).join(',')}]) names(name)`)).rows
      .map(row => (row as { name: string }).name);
    expect(sequences).toHaveLength(7);
  }, 120000);
  afterAll(async () => { await f?.close(); }, 45000);
  const run = (callback: (runtime: Runtime) => Promise<void>) => f.withRuntimeRole!(async runtime => {
    await f.exec(`GRANT SELECT,INSERT,UPDATE ON public.shipping_templates TO "${runtime.role}";
      GRANT SELECT,INSERT,UPDATE,DELETE ON ${children.map(t => `public.${t}`).join(',')} TO "${runtime.role}";
      GRANT USAGE ON SEQUENCE ${sequences.join(',')} TO "${runtime.role}"`);
    await callback(runtime);
  });
  const snapshot = () => f.query(`SELECT jsonb_build_object(
    'rows',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM store_product p),
    'templates',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM shipping_templates p),
    'orders',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM store_order p),
    'sequences',(SELECT jsonb_agg(to_jsonb(s) ORDER BY sequencename) FROM pg_sequences s WHERE schemaname='public'),
    'acl',(SELECT jsonb_agg(jsonb_build_object('oid',c.oid,'acl',c.relacl) ORDER BY c.oid) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public')) AS state`);

  it('rejects the maintenance identity rather than calling it a runtime role', async () => {
    expect(await auditShippingLifecycleRuntimePermissions(f.db)).toMatchObject({ ready: false,
      checks: { noOwnerControl: false, noReplicationBypass: false, unprivilegedReachableRoles: false } });
  });

  it('qualifies an actual LOGIN in a read-only snapshot without changing rows, sequences, ACLs or stricter settings', async () => {
    await run(async runtime => {
      await runtime.exec("SET statement_timeout='4000ms'; SET lock_timeout='500ms'; SET idle_in_transaction_session_timeout='3500ms'");
      const before = await snapshot();
      const observed = new Proxy(runtime.db, { get(target, key, receiver) {
        if (key === 'transaction') return ((callback, config) => target.transaction(async tx => {
          expect(config).toEqual({ isolationLevel: 'repeatable read', accessMode: 'read only' });
          const result = await callback(tx);
          expect(Array.from(await tx.execute(sql`SELECT current_setting('transaction_read_only') AS readonly,
            current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock`)))
            .toEqual([{ readonly: 'on', statement: '4s', lock: '500ms' }]);
          return result;
        }, config)) satisfies DbClient['transaction'];
        return Reflect.get(target, key, receiver);
      } });
      const result = await auditShippingLifecycleRuntimePermissions(observed);
      expect(result).toMatchObject({ ready: true, failures: [], protocolCatalogVerified: false,
        dataBaselineVerified: false, completeServicePrivilegesVerified: false });
      expect(JSON.stringify(result)).not.toContain(runtime.role);
      expect(await snapshot()).toEqual(before);
      expect(await runtime.exec("SELECT current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock"))
        .toMatchObject([{ statement: '4s', lock: '500ms' }]);
    });
  });

  it('supports auto-ID binding and application soft retirement but denies DDL, trigger, truncate, hard delete, sequence reset and replication bypass', async () => {
    const orders = await f.query('SELECT * FROM store_order ORDER BY id');
    await run(async runtime => {
      expect((await auditShippingLifecycleRuntimePermissions(runtime.db)).ready).toBe(true);
      const [created] = await runtime.exec('INSERT INTO store_product(temp_id,freight) VALUES(2,3) RETURNING id');
      try {
        await runtime.exec(`UPDATE store_product SET stock=7 WHERE id=${created.id}`);
        await expect(retireShippingTemplate(createContainerFromDb(runtime.db), 2)).rejects.toThrow('仍被商品或活动引用');
        for (const statement of [
          'CREATE TABLE public.qa_forbidden_shipping(id integer)',
          'ALTER TABLE public.store_product DISABLE TRIGGER shipping_lifecycle_child',
          'DROP TRIGGER shipping_lifecycle_child ON public.store_product',
          'CREATE TRIGGER qa_forbidden_guard AFTER INSERT ON public.store_product FOR EACH ROW EXECUTE FUNCTION public.shipping_lifecycle_child()',
          'ALTER FUNCTION public.shipping_lifecycle_child() SECURITY DEFINER',
          'TRUNCATE public.store_product', 'DELETE FROM public.shipping_templates WHERE id=2',
          `SELECT setval('${sequences[0]}',1000)`, "SET session_replication_role='replica'",
        ]) await expect(runtime.exec(statement)).rejects.toMatchObject({ code: '42501' });
      } finally { await runtime.exec(`DELETE FROM store_product WHERE id=${created.id}`); }
      await runtime.exec('UPDATE store_product SET temp_id=0,freight=1 WHERE id=1');
      try {
        await retireShippingTemplate(createContainerFromDb(runtime.db), 2);
        expect(await runtime.exec('SELECT is_del FROM shipping_templates WHERE id=2')).toMatchObject([{ is_del: 1 }]);
      } finally { await f.exec('UPDATE shipping_templates SET is_del=0,status=1 WHERE id=2; UPDATE store_product SET temp_id=2,freight=3 WHERE id=1'); }
    });
    expect(await f.query('SELECT * FROM store_order ORDER BY id')).toEqual(orders);
  });

  it.each([
    ['TRIGGER ON public.store_product','noTriggerOrTruncate'],
    ['TRUNCATE ON public.store_bargain','noTriggerOrTruncate'],
    ['DELETE ON public.shipping_templates','noTemplateHardDelete'],
    ['CREATE ON SCHEMA public','noSchemaCreation'],
    ['UPDATE ON SEQUENCE public.store_product_id_seq','noSequenceReset'],
    ['SET ON PARAMETER session_replication_role','noReplicationBypass'],
    ['ALTER SYSTEM ON PARAMETER session_replication_role','noReplicationBypass'],
    ['UPDATE ON public.store_product WITH GRANT OPTION','noGrantDelegation'],
    ['UPDATE(stock) ON public.store_product WITH GRANT OPTION','noGrantDelegation'],
  ])('rejects excess %s capability', async (grant, check) => {
    await run(async runtime => {
      const withOption = grant.endsWith(' WITH GRANT OPTION');
      await f.exec(`GRANT ${grant.replace(' WITH GRANT OPTION','')} TO "${runtime.role}"${withOption ? ' WITH GRANT OPTION' : ''}`);
      const result = await auditShippingLifecycleRuntimePermissions(runtime.db);
      expect(result.ready).toBe(false); expect(result.failures).toContain(check);
    });
  });

  it.each([
    ['SELECT ON public.store_bargain','requiredTablePrivileges'],
    ['INSERT ON public.store_product','requiredTablePrivileges'],
    ['UPDATE ON public.shipping_templates','requiredTablePrivileges'],
    ['DELETE ON public.store_discounts_products','requiredTablePrivileges'],
    ['USAGE ON SEQUENCE public.store_product_id_seq','requiredSequenceUsage'],
  ])('rejects missing %s capability', async (revoke, check) => {
    await run(async runtime => {
      await f.exec(`REVOKE ${revoke} FROM "${runtime.role}"`);
      const result = await auditShippingLifecycleRuntimePermissions(runtime.db);
      expect(result.ready).toBe(false); expect(result.failures).toContain(check);
    });
  });

  it('rejects missing helper execution and RLS requiring separate review', async () => {
    await run(async runtime => {
      await f.exec('REVOKE EXECUTE ON FUNCTION public.shipping_lifecycle_ref(integer,integer) FROM PUBLIC');
      try { expect((await auditShippingLifecycleRuntimePermissions(runtime.db)).failures).toContain('requiredFunctionExecute'); }
      finally { await f.exec('GRANT EXECUTE ON FUNCTION public.shipping_lifecycle_ref(integer,integer) TO PUBLIC'); }
      await f.exec('ALTER TABLE store_bargain ENABLE ROW LEVEL SECURITY');
      try { expect((await auditShippingLifecycleRuntimePermissions(runtime.db)).failures).toContain('noUnreviewedRls'); }
      finally { await f.exec('ALTER TABLE store_bargain DISABLE ROW LEVEL SECURITY'); }
    });
  });

  it.each(['ROLE','SESSION AUTHORIZATION'])('retains original maintenance connection identity behind SET %s', async setting => {
    await run(async runtime => {
      await f.withPeer!(async maintenance => {
        await maintenance.exec(`SET ${setting} "${runtime.role}"`);
        try {
          expect(await auditShippingLifecycleRuntimePermissions(maintenance.db)).toMatchObject({ ready: false,
            checks: { connectionIdentityVisible: true, unprivilegedReachableRoles: false } });
        } finally { await maintenance.exec(`RESET ${setting}`); }
      });
    });
  });

  it('includes non-inherited SET-reachable roles and administrative membership rather than only current grants', async () => {
    await run(async runtime => {
      await f.withRuntimeRole!(async group => {
        await f.exec(`GRANT TRUNCATE ON public.store_product TO "${group.role}";
          GRANT "${group.role}" TO "${runtime.role}" WITH INHERIT FALSE, SET TRUE, ADMIN TRUE`);
        expect(await auditShippingLifecycleRuntimePermissions(runtime.db)).toMatchObject({ ready: false,
          checks: { noTriggerOrTruncate: false, noGrantDelegation: false } });
      });
    });
  });

  it('refuses callable user SECURITY DEFINER routines without attempting execution', async () => {
    await f.exec('CREATE FUNCTION public.qa_shipping_definer() RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN RAISE EXCEPTION \'must not execute\'; END $$');
    try { await run(async runtime => { expect((await auditShippingLifecycleRuntimePermissions(runtime.db)).failures).toContain('noUnreviewedDefinerRoutine'); }); }
    finally { await f.exec('DROP FUNCTION public.qa_shipping_definer()'); }
  });

  it.each(['SUPERUSER','CREATEDB','CREATEROLE','REPLICATION','BYPASSRLS'])('rejects the %s role attribute', async attribute => {
    await run(async runtime => {
      await f.exec(`ALTER ROLE "${runtime.role}" ${attribute}`);
      try { expect((await auditShippingLifecycleRuntimePermissions(runtime.db)).failures).toContain('unprivilegedReachableRoles'); }
      finally { await f.exec(`ALTER ROLE "${runtime.role}" NO${attribute}`); }
    });
  });

  it.each([
    ['TABLE public.store_bargain','TABLE public.store_bargain'],
    ['FUNCTION public.shipping_lifecycle_ref(integer,integer)','FUNCTION public.shipping_lifecycle_ref(integer,integer)'],
  ])('rejects ownership control of %s', async (object, restore) => {
    await run(async runtime => {
      await f.exec(`ALTER ${object} OWNER TO "${runtime.role}"`);
      try { expect((await auditShippingLifecycleRuntimePermissions(runtime.db)).failures).toContain('noOwnerControl'); }
      finally { await f.exec(`ALTER ${restore} OWNER TO finance_test`); }
    });
  });

  it.each([
    ['ALTER SEQUENCE public.store_product_id_seq OWNED BY NONE','ALTER SEQUENCE public.store_product_id_seq OWNED BY public.store_product.id'],
    ['ALTER FUNCTION public.shipping_lifecycle_child() RENAME TO qa_missing_shipping_child','ALTER FUNCTION public.qa_missing_shipping_child() RENAME TO shipping_lifecycle_child'],
  ])('fails closed when an expected object/ownership binding is absent: %s', async (change, restore) => {
    await run(async runtime => {
      await f.exec(change);
      try { expect(await auditShippingLifecycleRuntimePermissions(runtime.db)).toMatchObject({ ready: false, checks: { objectsPresent: false } }); }
      finally { await f.exec(restore); }
    });
  });

  it('includes inherited privileges even when SET ROLE is unavailable', async () => {
    await run(async runtime => {
      await f.withRuntimeRole!(async group => {
        await f.exec(`GRANT TRIGGER ON public.store_product TO "${group.role}";
          GRANT "${group.role}" TO "${runtime.role}" WITH INHERIT TRUE, SET FALSE, ADMIN FALSE`);
        expect((await auditShippingLifecycleRuntimePermissions(runtime.db)).failures).toContain('noTriggerOrTruncate');
      });
    });
  });

  it('does not conflate a qualified permission envelope with protocol catalog acceptance', async () => {
    await f.exec('ALTER TABLE public.store_product DISABLE TRIGGER shipping_lifecycle_child');
    try {
      await run(async runtime => {
        expect(await auditShippingLifecycleRuntimePermissions(runtime.db)).toMatchObject({ ready: true, protocolCatalogVerified: false });
        expect((await inspectShippingLifecycleProtocol(f.db)).state).toBe('drift');
      });
    } finally { await f.exec('ALTER TABLE public.store_product ENABLE TRIGGER shipping_lifecycle_child'); }
  });
});
