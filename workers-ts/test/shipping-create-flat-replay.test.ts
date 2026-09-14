import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createContainerFromDb, withTx } from '../src/lib/di';
import { shippingTemplates, shippingTemplatesRegion, shippingTemplatesFree, shippingTemplatesNoDelivery, systemCity } from '../src/models/schema';
import { SHIPPING_TEMPLATE_CREATE_REPLAY_SQL } from '../src/migrations/shippingTemplateCreateReplay';
import { createFlatShippingTemplateOnce, createShippingTemplateOnce, findShippingCreationReceipt } from '../src/services/product/ShippingTemplateCreateReplay';
import { outRequestHash } from '../src/services/out/OutIdempotency';
import { normalizeSupplierShippingTemplateInput } from '../src/services/product/ShippingTemplateRules';
import { financePostgres } from './helpers/financePostgres';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';

const actor = { ownerType: 0 as const, relationId: 0, actorId: 7 };
const flat = () => ({ name: 'legacy flat', type: 2, sort: 4, status: 0,
  regions: [{ region_id: 98765, region_name: 'preserved legacy name', first: '1', first_price: '6', continue: '2', continue_price: '3' }] });
const grouped = () => ({ name: 'legacy flat', type: 1, appoint: 0, no_delivery: 0,
  region_info: [{ city_ids: [[0]], first: 1, first_price: 0, continue: 1, continue_price: 0 }],
  appoint_info: [], no_delivery_info: [] });

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('legacy flat creation durable replay on PG16', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>;
  beforeEach(async () => {
    f = await financePostgres([shippingTemplates, shippingTemplatesRegion, shippingTemplatesFree, shippingTemplatesNoDelivery, systemCity]);
    await f.exec(SHIPPING_TEMPLATE_CREATE_REPLAY_SQL);
  }, 30000);
  afterEach(async () => { await f?.close(); });
  const create = (key: unknown, raw: unknown = { name: 'legacy flat' }) =>
    createFlatShippingTemplateOnce(createContainerFromDb(f.db), actor, key, raw);
  const snapshot = async () => (await f.db.execute(sql`SELECT jsonb_build_object(
    'parents',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM shipping_templates t),
    'regions',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM shipping_templates_region t),
    'free',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM shipping_templates_free t),
    'deny',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM shipping_templates_no_delivery t),
    'receipts',(SELECT jsonb_agg(to_jsonb(t) ORDER BY template_id) FROM shipping_template_create_replay t)
  ) AS state`))[0];
  it('recovers a lost success without creating a second template', async () => {
    const key = crypto.randomUUID(), first = await create(key), retry = await create(key);
    expect(retry.id).toBe(first.id);
    expect(await f.db.select().from(shippingTemplates)).toHaveLength(1);
  });
  it('serializes same-key concurrent flat creates to one template', async () => {
    const key = crypto.randomUUID(), results = await Promise.all([create(key), create(key)]);
    expect(new Set(results.map(r => r.id)).size).toBe(1);
    expect(await f.db.select().from(shippingTemplates)).toHaveLength(1);
  });
  it('normalizes name-only creation, explicit defaults, omitted regions and [] to the same receipt', async () => {
    const key = crypto.randomUUID(), first = await create(key), before = await snapshot();
    expect(first).toEqual({ version: 'shipping-create-v1', requestKey: key, requestHash: expect.stringMatching(/^[a-f0-9]{64}$/), id: expect.any(Number), replayed: false });
    expect(await create(` ${key.toUpperCase()} `, { name: ' legacy flat ', id: '0', type: '1', sort: '0', status: '1', regions: [] }))
      .toEqual({ ...first, replayed: true });
    expect(await f.db.select().from(shippingTemplates)).toMatchObject([{ ownerType: 0, relationId: 0,
      name: 'legacy flat', type: 1, status: 1, sort: 0, appoint: 0, noDelivery: 0, isDel: 0 }]);
    expect(await f.db.select().from(shippingTemplatesRegion)).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });
  it.each([1, 2, 3])('retains legacy decimal defaults and region names for billing type %i', async type => {
    const key = crypto.randomUUID(), input = { ...flat(), type }, first = await create(key, input);
    expect(await f.db.select().from(shippingTemplatesRegion)).toMatchObject([{ templateId: first.id,
      regionId: 98765, regionName: 'preserved legacy name', provinceId: 0, value: '', uniqid: '',
      first: '1.00', firstPrice: '6.00', continue: '2.00', continuePrice: '3.00', billingGroup: type }]);
    const before = await snapshot();
    expect(await create(key, { ...input, regions: [{ ...input.regions[0], first: '01.00', first_price: 6, continue: '02.0' }] }))
      .toEqual({ ...first, replayed: true });
    expect(await snapshot()).toEqual(before);
  });
  it('supports omitted row amounts and the legacy zero-quantity contract without synthesizing grouped paths', async () => {
    const first = await create(crypto.randomUUID(), { name: 'legacy', regions: [
      { region_id: 0, region_name: '' }, { region_id: 4, region_name: 'kept', first: 0, continue: 0 },
    ] });
    const rows = await f.db.select().from(shippingTemplatesRegion).orderBy(shippingTemplatesRegion.id);
    expect(rows).toMatchObject([{ templateId: first.id, first: '1.00', firstPrice: '0.00', continue: '1.00', continuePrice: '0.00' },
      { first: '0.00', continue: '0.00' }]);
    expect(rows.every(row => row.value === '' && row.uniqid === '')).toBe(true);
  });
  it('does not let forged ownership or ignored fields influence persisted data or request hashes', async () => {
    const key = crypto.randomUUID(), first = await create(key, { name: 'legacy flat', actorId: 99, owner_type: 2, relation_id: 20,
      appoint: 1, no_delivery: 1, is_del: 1, add_time: 1, token: 'not persisted' }), before = await snapshot();
    expect(await create(key)).toEqual({ ...first, replayed: true });
    expect(await snapshot()).toEqual(before);
    expect(JSON.stringify(before)).not.toContain('not persisted');
  });
  it.each(['name', 'type', 'sort', 'status', 'region_name', 'first_price'])('rejects a changed persisted %s with HTTP 409', async field => {
    const key = crypto.randomUUID(); await create(key, flat()); const before = await snapshot(), input = flat();
    const changed = field === 'region_name' ? { ...input, regions: [{ ...input.regions[0], region_name: 'different' }] }
      : field === 'first_price' ? { ...input, regions: [{ ...input.regions[0], first_price: '7' }] }
      : { ...input, [field]: field === 'name' ? 'different' : field === 'status' ? 1 : 3 };
    await expect(create(key, changed)).rejects.toMatchObject({ code: 409, httpStatus: 409 });
    expect(await snapshot()).toEqual(before);
  });
  it.each(['flat-first', 'grouped-first'])('uses one key namespace for both representations: %s', async order => {
    const key = crypto.randomUUID(), container = createContainerFromDb(f.db);
    const makeFlat = () => create(key), makeGrouped = () => createShippingTemplateOnce(container, actor, key, grouped());
    const first = await (order === 'flat-first' ? makeFlat() : makeGrouped()), before = await snapshot();
    await expect(order === 'flat-first' ? makeGrouped() : makeFlat()).rejects.toMatchObject({ code: 409, httpStatus: 409 });
    expect(await snapshot()).toEqual(before);
    expect(await findShippingCreationReceipt(container, actor, key)).toEqual({ version: first.version, id: first.id,
      requestKey: first.requestKey, requestHash: first.requestHash });
  });
  it('retains the original grouped hash protocol after transaction extraction', async () => {
    const raw = grouped(), result = await createShippingTemplateOnce(createContainerFromDb(f.db), actor, crypto.randomUUID(), raw);
    expect(result.requestHash).toBe(await outRequestHash({ version: 'shipping-create-v1', input: normalizeSupplierShippingTemplateInput(raw), status: 1 }));
  });
  it.each(['flat-first', 'grouped-first'])('serializes an actual cross-format key race: %s', async order => {
    const key = crypto.randomUUID();
    await withFinancePeers(f.db, async ([writer, contender, observer]) => {
      let release!: () => void, entered!: () => void;
      const hold = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
      const first = outcome(withTx(createContainerFromDb(writer.db), async tx => {
        const container = createContainerFromDb(tx);
        const result = await (order === 'flat-first' ? createFlatShippingTemplateOnce(container, actor, key, flat())
          : createShippingTemplateOnce(container, actor, key, grouped()));
        entered(); await hold; return result;
      }));
      let second: ReturnType<typeof outcome<Awaited<ReturnType<typeof createFlatShippingTemplateOnce>>>> | undefined;
      try {
        await Promise.race([started, first.then(result => { if (!result.ok) throw result.error; })]);
        const container = createContainerFromDb(contender.db);
        second = outcome(order === 'flat-first' ? createShippingTemplateOnce(container, actor, key, grouped())
          : createFlatShippingTemplateOnce(container, actor, key, flat()));
        await waitForFinanceBlock(observer.db, contender.pid, writer.pid);
        expect(await f.db.select().from(shippingTemplates)).toEqual([]);
        release(); expect((await first).ok).toBe(true);
        const result = await second; expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatchObject({ code: 409, httpStatus: 409 });
        expect(await f.db.select().from(shippingTemplates)).toHaveLength(1);
      } finally { release(); await first; if (second) await second; }
    });
  });
  it.each([undefined, null, '', 'bad', 5, '11111111-1111-1111-8111-111111111111'])('rejects invalid key %s before writing', async key => {
    const before = await snapshot(); await expect(create(key)).rejects.toThrow('Idempotency-Key'); expect(await snapshot()).toEqual(before);
  });
  it.each([null, [], { name: 'x', id: 1 }, { name: 'x', type: 4 }, { name: 'x', status: null },
    { name: 'x', regions: {} }, { name: 'x', region_info: [] }, { name: 'x', regions: Array(1001).fill({ region_id: 0, region_name: '' }) }])
    ('rejects invalid or wrong-protocol input %# before writing', async raw => {
      const before = await snapshot(); await expect(create(crypto.randomUUID(), raw)).rejects.toThrow(); expect(await snapshot()).toEqual(before);
    });
  it('copies identity, form and nested rows before awaiting, and separates platform actors', async () => {
    const key = crypto.randomUUID(), raw = flat(), identity = { ...actor }, container = createContainerFromDb(f.db);
    const pending = createFlatShippingTemplateOnce(container, identity, key, raw);
    identity.actorId = 99; raw.name = 'mutated'; raw.regions[0].first_price = '999';
    const first = await pending;
    expect(await create(key, flat())).toEqual({ ...first, replayed: true });
    expect(await findShippingCreationReceipt(container, identity, key)).toBeNull();
    const second = await createFlatShippingTemplateOnce(container, identity, key, flat()); expect(second.id).not.toBe(first.id);
    await expect(createFlatShippingTemplateOnce(container, { ownerType: 2, relationId: 20, actorId: 27 }, key, flat())).rejects.toThrow('平台');
  });
  it.each(['edit', 'retire', 'transfer', 'delete'])('retains creation evidence after later %s', async mutation => {
    const key = crypto.randomUUID(), first = await create(key, flat());
    if (mutation === 'edit') await f.exec("UPDATE shipping_templates SET name='changed'");
    if (mutation === 'retire') await f.exec('UPDATE shipping_templates SET is_del=1,status=0');
    if (mutation === 'transfer') await f.exec('UPDATE shipping_templates SET owner_type=2,relation_id=20');
    if (mutation === 'delete') await f.exec('DELETE FROM shipping_templates');
    const before = await snapshot(); expect(await create(key, flat())).toEqual({ ...first, replayed: true }); expect(await snapshot()).toEqual(before);
  });
  it.each(['shipping_templates_region', 'shipping_template_create_replay'])('rolls back parent and all rules if %s insert fails', async table => {
    const key = crypto.randomUUID(), before = await snapshot();
    await f.exec(`CREATE FUNCTION reject_flat() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$;
      CREATE TRIGGER reject_flat BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_flat()`);
    await expect(create(key, flat())).rejects.toThrow(); expect(await snapshot()).toEqual(before);
    await f.exec(`DROP TRIGGER reject_flat ON ${table}`);
    const created = await create(key, flat()); expect(created.replayed).toBe(false);
  });
  it('fails closed with no ledger rather than returning an empty recovery result', async () => {
    await f.exec('DROP TABLE shipping_template_create_replay');
    await expect(create(crypto.randomUUID())).rejects.toThrow();
    await expect(findShippingCreationReceipt(createContainerFromDb(f.db), actor, crypto.randomUUID())).rejects.toThrow();
    expect(await f.db.select().from(shippingTemplates)).toEqual([]);
  });
  it.each(['commit', 'rollback'])('recovery waits for an actual flat creation transaction to %s', async mode => {
    const key = crypto.randomUUID();
    await withFinancePeers(f.db, async ([writer, reader, observer]) => {
      let release!: () => void, entered!: () => void;
      const hold = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
      const first = outcome(withTx(createContainerFromDb(writer.db), async tx => {
        const result = await createFlatShippingTemplateOnce(createContainerFromDb(tx), actor, key, flat());
        entered(); await hold; if (mode === 'rollback') throw new Error('rollback held create'); return result;
      }));
      let lookup: ReturnType<typeof outcome<Awaited<ReturnType<typeof findShippingCreationReceipt>>>> | undefined;
      try {
        await Promise.race([started, first.then(result => { if (!result.ok) throw result.error; })]);
        lookup = outcome(findShippingCreationReceipt(createContainerFromDb(reader.db), actor, key));
        await waitForFinanceBlock(observer.db, reader.pid, writer.pid);
        expect(await f.db.select().from(shippingTemplates)).toEqual([]);
        release(); const saved = await first, recovered = await lookup;
        expect(recovered.ok).toBe(true);
        if (mode === 'commit') { expect(saved.ok).toBe(true); if (saved.ok && recovered.ok) expect(recovered.value?.id).toBe(saved.value.id); }
        else { expect(saved.ok).toBe(false); if (recovered.ok) expect(recovered.value).toBeNull(); }
        const retry = await create(key, flat()); expect(retry.replayed).toBe(mode === 'commit');
        expect(await f.db.select().from(shippingTemplates)).toHaveLength(1);
      } finally { release(); await first; if (lookup) await lookup; }
    });
  });
});
