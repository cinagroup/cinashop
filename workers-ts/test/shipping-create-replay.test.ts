import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb, withTx, type DbClient } from '../src/lib/di';
import { shippingTemplates, shippingTemplatesRegion, shippingTemplatesFree, shippingTemplatesNoDelivery, systemCity } from '../src/models/schema';
import { createShippingTemplateOnce, findShippingCreationReceipt } from '../src/services/product/ShippingTemplateCreateReplay';
import { SHIPPING_TEMPLATE_CREATE_REPLAY_SQL } from '../src/migrations/shippingTemplateCreateReplay';
import { financePostgres } from './helpers/financePostgres';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';

const body = () => ({ name: '创建回执测试', type: 2, appoint: 1, no_delivery: 1, sort: 9,
  region_info: [{ city_ids: [[0]], first: '1', first_price: '6', continue: '1', continue_price: '2' }],
  appoint_info: [{ city_ids: [[101]], number: '2', price: '99' }],
  no_delivery_info: [{ city_ids: [[101, 102]] }] });
const actor = { ownerType: 2 as const, relationId: 20, actorId: 27 };
const createOnce = (db: DbClient, key: unknown, raw: Record<string, unknown> = body()) =>
  createShippingTemplateOnce(createContainerFromDb(db), actor, key, raw);
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('durable shipping creation replay on isolated PG16', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>;
  const receipts = () => f.db.select({ ownerType: sql<number>`owner_type`, relationId: sql<number>`relation_id`,
    actorId: sql<number>`actor_id`, key: sql<string>`request_key::text`, hash: sql<string>`request_hash`, id: sql<number>`template_id` })
    .from(sql`shipping_template_create_replay`).orderBy(sql`template_id`);
  const snapshot = async () => ({ parent: await f.db.select().from(shippingTemplates).orderBy(shippingTemplates.id),
    regions: await f.db.select().from(shippingTemplatesRegion).orderBy(shippingTemplatesRegion.id),
    free: await f.db.select().from(shippingTemplatesFree).orderBy(shippingTemplatesFree.id),
    deny: await f.db.select().from(shippingTemplatesNoDelivery).orderBy(shippingTemplatesNoDelivery.id), receipts: await receipts() });
  beforeEach(async () => {
    f = await financePostgres([shippingTemplates, shippingTemplatesRegion, shippingTemplatesFree, shippingTemplatesNoDelivery, systemCity]);
    await f.exec(SHIPPING_TEMPLATE_CREATE_REPLAY_SQL);
    await f.db.insert(systemCity).values([{ cityId: 101, parentId: 0, name: '省' }, { cityId: 102, parentId: 101, name: '市' }]);
  }, 30000);
  afterEach(async () => { await f?.close(); });
  it('returns the original template after losing a successful response', async () => {
    const key = crypto.randomUUID();
    const first = await createOnce(f.db, key);
    const retry = await createOnce(f.db, key);
    expect(retry.id).toBe(first.id);
    expect(first.replayed).toBe(false); expect(retry.replayed).toBe(true);
    expect(await receipts()).toHaveLength(1);
    expect(await f.db.select().from(shippingTemplates)).toHaveLength(1);
  });
  it('concurrent identical creates commit only one four-table template', async () => {
    const key = crypto.randomUUID();
    const results = await Promise.all([createOnce(f.db, key), createOnce(f.db, key)]);
    expect(new Set(results.map(r => r.id)).size).toBe(1);
    for (const table of [shippingTemplates, shippingTemplatesRegion, shippingTemplatesFree, shippingTemplatesNoDelivery]) {
      expect(await f.db.select().from(table)).toHaveLength(1);
    }
  });
  it('normalizes the request key and persisted fields without rewriting rules on replay', async () => {
    const key = crypto.randomUUID(), first = await createOnce(f.db, key), before = await snapshot();
    const raw = body(); raw.name = '  创建回执测试  '; raw.region_info[0].first_price = '06.00';
    const replay = await createOnce(f.db, ` ${key.toUpperCase()} `, { ...raw, ignored: 'not persisted', actorId: 99 });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(await snapshot()).toEqual(before);
  });
  it('rejects reuse for different persisted content with a non-success conflict', async () => {
    const key = crypto.randomUUID(); await createOnce(f.db, key); const before = await snapshot();
    await expect(createOnce(f.db, key, { ...body(), name: 'different' })).rejects.toMatchObject({ code: 409, httpStatus: 409 });
    expect(await snapshot()).toEqual(before);
  });
  for (const key of [undefined, null, '', 'bad', 123, '11111111-1111-1111-8111-111111111111', '11111111-1111-4111-1111-111111111111']) {
    it(`requires a real UUID-v4 key before any write: ${String(key)}`, async () => {
      await expect(createOnce(f.db, key)).rejects.toThrow('Idempotency-Key');
      expect(await snapshot()).toEqual({ parent: [], regions: [], free: [], deny: [], receipts: [] });
    });
  }
  for (const invalid of [{ ...actor, actorId: 0 }, { ...actor, actorId: 2147483648 }, { ...actor, relationId: 0 },
    { ...actor, relationId: 2147483648 }, { ownerType: 0 as const, relationId: 20, actorId: 27 }]) {
    it(`rejects invalid server identity ${JSON.stringify(invalid)}`, async () => {
      await expect(createShippingTemplateOnce(createContainerFromDb(f.db), invalid, crypto.randomUUID(), body())).rejects.toThrow('身份');
      expect(await receipts()).toEqual([]);
    });
  }
  it('keeps actor, supplier tenant and platform namespaces separate and derives ownership from trusted arguments', async () => {
    const key = crypto.randomUUID(); const ids: number[] = [];
    for (const identity of [actor, { ...actor, actorId: 28 }, { ...actor, relationId: 21 }, { ownerType: 0 as const, relationId: 0, actorId: 27 }]) {
      expect(await findShippingCreationReceipt(createContainerFromDb(f.db), identity, key)).toBeNull();
      const result = await createShippingTemplateOnce(createContainerFromDb(f.db), identity, key, { ...body(), owner_type: 99, relation_id: 999 });
      ids.push(result.id);
      const [row] = await f.db.select().from(shippingTemplates).where(eq(shippingTemplates.id, result.id));
      expect(row).toMatchObject({ ownerType: identity.ownerType, relationId: identity.relationId });
    }
    expect(new Set(ids).size).toBe(4); expect(await receipts()).toHaveLength(4);
  });
  it('supports platform status but never lets a supplier body choose a disabled status', async () => {
    const admin = await createShippingTemplateOnce(createContainerFromDb(f.db), { ownerType: 0, relationId: 0, actorId: 27 }, crypto.randomUUID(), { ...body(), status: 0 });
    const supplier = await createOnce(f.db, crypto.randomUUID(), { ...body(), status: 0 });
    const rows = await f.db.select().from(shippingTemplates).orderBy(shippingTemplates.id);
    expect(rows).toMatchObject([{ id: admin.id, status: 0 }, { id: supplier.id, status: 1 }]);
  });
  it('recovers through a separate connection and returns only durable receipt fields', async () => {
    const key = crypto.randomUUID(), created = await createOnce(f.db, key);
    await withFinancePeers(f.db, async ([peer]) => {
      const found = await findShippingCreationReceipt(createContainerFromDb(peer.db), actor, key);
      expect(found).toEqual({ version: 'shipping-create-v1', requestKey: key, requestHash: created.requestHash, id: created.id });
      expect(await createOnce(peer.db, key)).toEqual({ ...created, replayed: true });
      expect(await findShippingCreationReceipt(createContainerFromDb(peer.db), { ...actor, actorId: 28 }, key)).toBeNull();
    });
  });
  for (const mutation of ['edit', 'retire', 'delete', 'transfer']) it(`does not recreate a committed request after template ${mutation} or city changes`, async () => {
    const key = crypto.randomUUID(), first = await createOnce(f.db, key);
    if (mutation === 'edit') await f.db.update(shippingTemplates).set({ name: 'later name' }).where(eq(shippingTemplates.id, first.id));
    if (mutation === 'retire') await f.db.update(shippingTemplates).set({ isDel: 1, status: 0 }).where(eq(shippingTemplates.id, first.id));
    if (mutation === 'transfer') await f.db.update(shippingTemplates).set({ relationId: 21 }).where(eq(shippingTemplates.id, first.id));
    if (mutation === 'delete') await f.db.delete(shippingTemplates).where(eq(shippingTemplates.id, first.id));
    await f.db.delete(systemCity); const before = await snapshot();
    expect(await createOnce(f.db, key)).toEqual({ ...first, replayed: true });
    expect(await snapshot()).toEqual(before);
  });
  for (const table of ['shipping_templates_free', 'shipping_templates_no_delivery', 'shipping_template_create_replay']) {
    it(`rolls back all tables if ${table} insertion fails, then safely retries the same key`, async () => {
      const key = crypto.randomUUID();
      await f.exec(`CREATE FUNCTION reject_creation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$;
        CREATE TRIGGER fail_creation BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_creation()`);
      await expect(createOnce(f.db, key)).rejects.toThrow();
      expect(await snapshot()).toEqual({ parent: [], regions: [], free: [], deny: [], receipts: [] });
      await f.exec(`DROP TRIGGER fail_creation ON ${table}`);
      await createOnce(f.db, key); expect(await receipts()).toHaveLength(1);
      expect((await snapshot()).parent).toHaveLength(1);
    });
  }
  it('fails closed when the receipt table has not been installed', async () => {
    await f.exec('DROP TABLE shipping_template_create_replay');
    await expect(createOnce(f.db, crypto.randomUUID())).rejects.toThrow();
    expect(await f.db.select().from(shippingTemplates)).toEqual([]);
  });
  it('an absent lookup does not reserve a key, and a later identical submission can still commit exactly once', async () => {
    const key = crypto.randomUUID(), before = await snapshot();
    expect(await findShippingCreationReceipt(createContainerFromDb(f.db), actor, key)).toBeNull();
    expect(await snapshot()).toEqual(before);
    const created = await createOnce(f.db, key);
    expect(await createOnce(f.db, key)).toEqual({ ...created, replayed: true });
  });
  it('copies mutable input and identity before awaiting the request hash', async () => {
    const key = crypto.randomUUID(), raw = body(), identity = { ...actor };
    const work = createShippingTemplateOnce(createContainerFromDb(f.db), identity, key, raw);
    raw.name = 'mutated'; raw.region_info[0].first_price = '900'; identity.relationId = 30;
    const created = await work;
    expect(await createOnce(f.db, key)).toEqual({ ...created, replayed: true });
    expect((await snapshot()).parent[0]).toMatchObject({ name: body().name, relationId: 20 });
    expect((await snapshot()).regions[0]).toMatchObject({ firstPrice: '6.00' });
  });
  it('city validation failure does not consume the key or leave partial data', async () => {
    const key = crypto.randomUUID(), raw = body(); raw.no_delivery_info[0].city_ids = [[999]];
    await expect(createOnce(f.db, key, raw)).rejects.toThrow('地区');
    expect(await snapshot()).toEqual({ parent: [], regions: [], free: [], deny: [], receipts: [] });
    expect((await createOnce(f.db, key)).replayed).toBe(false);
  });
  it('preserves a stricter lock timeout, never retries automatically, and can later recover the committed receipt', async () => {
    const key = crypto.randomUUID();
    await withFinancePeers(f.db, async ([firstPeer, secondPeer, observer]) => {
      await secondPeer.exec("SET lock_timeout='250ms'");
      let release!: () => void, entered!: () => void;
      const hold = new Promise<void>(resolve => { release = resolve; });
      const started = new Promise<void>(resolve => { entered = resolve; });
      const first = outcome(withTx(createContainerFromDb(firstPeer.db), async tx => {
        const result = await createOnce(tx, key); entered(); await hold; return result;
      }));
      let second: ReturnType<typeof outcome> | undefined;
      try {
        await Promise.race([started, first.then(result => { if (!result.ok) throw result.error; })]);
        second = outcome(createOnce(secondPeer.db, key));
        await waitForFinanceBlock(observer.db, secondPeer.pid, firstPeer.pid);
        expect((await second).ok).toBe(false);
        expect(await receipts()).toEqual([]);
        expect((await secondPeer.db.execute(sql`SHOW lock_timeout`))[0].lock_timeout).toBe('250ms');
        release(); const committed = await first;
        if (!committed.ok) throw committed.error;
        expect(await createOnce(secondPeer.db, key)).toEqual({ ...committed.value, replayed: true });
        expect(await receipts()).toHaveLength(1);
      } finally { release(); await first; await second; }
    });
  });
  it('refuses non-READ-COMMITTED callers without changing their isolation level', async () => {
    await withFinancePeers(f.db, async ([peer]) => {
      await peer.exec("SET default_transaction_isolation='repeatable read'");
      await expect(createOnce(peer.db, crypto.randomUUID())).rejects.toThrow('READ COMMITTED');
      const rows = await peer.db.execute(sql`SHOW default_transaction_isolation`);
      expect(rows[0].default_transaction_isolation).toBe('repeatable read');
    });
    expect(await receipts()).toEqual([]);
  });
  for (const commit of [true, false]) for (const lookup of [true, false]) {
    it(`${lookup ? 'lookup' : 'second create'} waits on an independent backend and observes ${commit ? 'commit' : 'rollback'}`, async () => {
      const key = crypto.randomUUID();
      await withFinancePeers(f.db, async ([firstPeer, secondPeer, observer]) => {
        let release!: () => void, entered!: () => void;
        const hold = new Promise<void>(resolve => { release = resolve; });
        const started = new Promise<void>(resolve => { entered = resolve; });
        const first = outcome(withTx(createContainerFromDb(firstPeer.db), async tx => {
          const result = await createOnce(tx, key); entered(); await hold;
          if (!commit) throw new Error('test rollback');
          return result;
        }));
        let second: ReturnType<typeof outcome> | undefined;
        try {
          await Promise.race([started, first.then(result => { if (!result.ok) throw result.error; })]);
          second = outcome(lookup ? findShippingCreationReceipt(createContainerFromDb(secondPeer.db), actor, key) : createOnce(secondPeer.db, key));
          await waitForFinanceBlock(observer.db, secondPeer.pid, firstPeer.pid);
          // Uncommitted business rows and receipts are both invisible to a third backend.
          expect(await observer.db.select().from(shippingTemplates)).toEqual([]);
          expect(await observer.db.execute(sql`SELECT * FROM shipping_template_create_replay`)).toHaveLength(0);
          release(); const a = await first, b = await second;
          expect(a.ok).toBe(commit); expect(b.ok).toBe(true);
          if (!b.ok) throw b.error;
          if (lookup && !commit) expect(b.value).toBeNull();
          else expect(b.value).toMatchObject({ id: expect.any(Number), ...(lookup ? {} : { replayed: commit }) });
          expect(await receipts()).toHaveLength(commit || !lookup ? 1 : 0);
        } finally { release(); await first; await second; }
      });
    });
  }
});
