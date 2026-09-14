import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';
import { createContainerFromDb } from '../src/lib/di';
import { shippingTemplates, shippingTemplatesRegion, shippingTemplatesFree, shippingTemplatesNoDelivery, systemCity } from '../src/models/schema';
import { SHIPPING_TEMPLATE_CREATE_REPLAY_SQL } from '../src/migrations/shippingTemplateCreateReplay';
import { createFlatShippingTemplateOnce, createShippingTemplateOnce, findShippingCreationReceipt } from '../src/services/product/ShippingTemplateCreateReplay';

const actor = { ownerType: 2 as const, relationId: 20, actorId: 27 };
const input = () => ({ name: 'permission fixture', type: 1, appoint: 1, no_delivery: 1,
  region_info: [{ city_ids: [[0]], first: 1, first_price: 6, continue: 1, continue_price: 2 }],
  appoint_info: [{ city_ids: [[101]], number: 1, price: 20 }], no_delivery_info: [{ city_ids: [[101]] }] });
const parents = 'public.shipping_templates';
const children = ['shipping_templates_region', 'shipping_templates_free', 'shipping_templates_no_delivery'];
const ledger = 'public.shipping_template_create_replay';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('shipping creation receipts with a real restricted LOGIN', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  beforeAll(async () => {
    f = await sequenceRunnerDatabase();
    const api = await import('drizzle-kit/api');
    const ddl = await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson({ shippingTemplates,
      shippingTemplatesRegion, shippingTemplatesFree, shippingTemplatesNoDelivery, systemCity }));
    await f.exec(ddl.join('\n')); await f.exec(SHIPPING_TEMPLATE_CREATE_REPLAY_SQL);
  }, 30000);
  afterAll(async () => { await f?.close(); }, 45000);
  beforeEach(async () => {
    await f.exec(`TRUNCATE ${ledger},${parents},${children.map(t => 'public.' + t).join(',')},public.system_city RESTART IDENTITY;
      INSERT INTO public.system_city(city_id,parent_id,name) VALUES(101,0,'province')`);
  });
  const withRole = (run: (peer: SequenceRunnerPeer & { role: string }) => Promise<void>) => f.withRuntimeRole!(async peer => {
    await f.exec(`GRANT SELECT,INSERT ON ${parents},${ledger} TO "${peer.role}";
      GRANT SELECT,INSERT,DELETE ON ${children.map(t => 'public.' + t).join(',')} TO "${peer.role}";
      GRANT SELECT ON public.system_city TO "${peer.role}";
      GRANT USAGE ON SEQUENCE public.shipping_templates_id_seq,${children.map(t => 'public.' + t + '_id_seq').join(',')} TO "${peer.role}"`);
    await run(peer);
  });
  const counts = async () => {
    const [row] = await f.db.select({ parent: sql<number>`(SELECT count(*)::int FROM shipping_templates)`,
      region: sql<number>`(SELECT count(*)::int FROM shipping_templates_region)`,
      free: sql<number>`(SELECT count(*)::int FROM shipping_templates_free)`,
      deny: sql<number>`(SELECT count(*)::int FROM shipping_templates_no_delivery)`,
      receipt: sql<number>`(SELECT count(*)::int FROM shipping_template_create_replay)` }).from(sql`(values(1)) counts(n)`);
    return row;
  };
  const empty = { parent: 0, region: 0, free: 0, deny: 0, receipt: 0 };
  it('legacy flat creation needs no child DELETE, city read or grouped-rule permissions', async () => {
    await withRole(async peer => {
      await f.exec(`REVOKE DELETE ON public.shipping_templates_region FROM "${peer.role}";
        REVOKE ALL ON public.shipping_templates_free,public.shipping_templates_no_delivery,public.system_city FROM "${peer.role}"`);
      const platform = { ownerType: 0 as const, relationId: 0, actorId: 7 }, key = crypto.randomUUID();
      const container = createContainerFromDb(peer.db), raw = { name: 'legacy', regions: [{ region_id: 55, region_name: 'old label' }] };
      const first = await createFlatShippingTemplateOnce(container, platform, key, raw);
      expect(await createFlatShippingTemplateOnce(container, platform, key, raw)).toEqual({ ...first, replayed: true });
      expect(await findShippingCreationReceipt(container, platform, key)).toMatchObject({ id: first.id });
      expect(await counts()).toEqual({ parent: 1, region: 1, free: 0, deny: 0, receipt: 1 });
    });
  });
  for (const grant of [`SELECT ON ${ledger}`, `INSERT ON ${ledger}`, 'INSERT ON public.shipping_templates_region']) {
    it(`flat creation rolls back without ${grant}`, async () => {
      await withRole(async peer => {
        await f.exec(`REVOKE ${grant} FROM "${peer.role}"`);
        await expect(createFlatShippingTemplateOnce(createContainerFromDb(peer.db),
          { ownerType: 0, relationId: 0, actorId: 7 }, crypto.randomUUID(),
          { name: 'legacy', regions: [{ region_id: 0, region_name: '' }] })).rejects.toThrow();
        expect(await counts()).toEqual(empty);
      });
    });
  }
  it('creates and recovers with SELECT/INSERT-only receipts and cannot erase or change evidence', async () => {
    await withRole(async peer => {
      const container = createContainerFromDb(peer.db), key = crypto.randomUUID();
      const result = await createShippingTemplateOnce(container, actor, key, input());
      expect(await createShippingTemplateOnce(container, actor, key, input())).toEqual({ ...result, replayed: true });
      expect(await findShippingCreationReceipt(container, actor, key)).toMatchObject({ id: result.id });
      await expect(peer.exec(`UPDATE ${ledger} SET request_hash=repeat('0',64)`)).rejects.toThrow();
      await expect(peer.exec(`DELETE FROM ${ledger}`)).rejects.toThrow();
      await expect(peer.exec(`TRUNCATE ${ledger}`)).rejects.toThrow();
      await expect(peer.exec(`ALTER TABLE ${ledger} DISABLE TRIGGER ALL`)).rejects.toThrow();
      await peer.exec('RESET ROLE');
      expect(await peer.exec('SELECT current_user = session_user AS unchanged')).toMatchObject([{ unchanged: true }]);
      expect(await counts()).toEqual({ parent: 1, region: 1, free: 1, deny: 1, receipt: 1 });
    });
  });
  for (const grant of [`SELECT ON ${ledger}`, `INSERT ON ${ledger}`, 'INSERT ON public.shipping_templates_no_delivery']) {
    it(`rolls back without the required ${grant} permission`, async () => {
      await withRole(async peer => {
        await f.exec(`REVOKE ${grant} FROM "${peer.role}"`);
        await expect(createShippingTemplateOnce(createContainerFromDb(peer.db), actor, crypto.randomUUID(), input())).rejects.toThrow();
        expect(await counts()).toEqual(empty);
      });
    });
  }
  it('does not mistake an RLS-hidden receipt for an unused key', async () => {
    const key = crypto.randomUUID();
    const initial = await createShippingTemplateOnce(createContainerFromDb(f.db), actor, key, input());
    try {
      await f.exec(`ALTER TABLE ${ledger} ENABLE ROW LEVEL SECURITY;
        CREATE POLICY hide_receipts ON ${ledger} FOR SELECT USING (false)`);
      await withRole(async peer => {
        expect(await peer.exec(`SELECT * FROM ${ledger}`)).toHaveLength(0);
        await expect(createShippingTemplateOnce(createContainerFromDb(peer.db), actor, key, input())).rejects.toThrow();
        await expect(findShippingCreationReceipt(createContainerFromDb(peer.db), actor, key)).rejects.toThrow();
      });
      expect(await findShippingCreationReceipt(createContainerFromDb(f.db), actor, key)).toMatchObject({ id: initial.id });
      expect(await counts()).toEqual({ parent: 1, region: 1, free: 1, deny: 1, receipt: 1 });
    } finally { await f.exec(`DROP POLICY IF EXISTS hide_receipts ON ${ledger}; ALTER TABLE ${ledger} DISABLE ROW LEVEL SECURITY`); }
  });
  it('SQL uniqueness prevents direct callers from recording two keys for one template', async () => {
    const key = crypto.randomUUID(); const created = await createShippingTemplateOnce(createContainerFromDb(f.db), actor, key, input());
    await expect(f.db.execute(sql`INSERT INTO shipping_template_create_replay(owner_type,relation_id,actor_id,request_key,request_hash,template_id)
      VALUES(2,20,27,${crypto.randomUUID()}::uuid,${created.requestHash},${created.id})`)).rejects.toThrow();
    expect((await counts()).receipt).toBe(1);
  });
  const invalidRows = [
    { owner: 1, relation: 20 }, { owner: 0, relation: 20 }, { owner: 2, relation: 0 }, { actor: 0 }, { id: 0 },
    { hash: 'A'.repeat(64) }, { hash: '0'.repeat(63) }, { key: '11111111-1111-1111-8111-111111111111' },
  ];
  for (const invalid of invalidRows) it(`SQL rejects invalid receipt ${JSON.stringify(invalid)}`, async () => {
    const row = { owner: 2, relation: 20, actor: 27, id: 100, hash: 'a'.repeat(64), key: crypto.randomUUID(), ...invalid };
    await expect(f.db.execute(sql`INSERT INTO shipping_template_create_replay(owner_type,relation_id,actor_id,request_key,request_hash,template_id)
      VALUES(${row.owner},${row.relation},${row.actor},${row.key}::uuid,${row.hash},${row.id})`)).rejects.toThrow();
    expect(await counts()).toEqual(empty);
  });
});
