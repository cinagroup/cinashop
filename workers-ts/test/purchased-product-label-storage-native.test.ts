/** Structural specimens only: full ORM, actual PG16 maintenance and independent
 * restricted LOGINs. No checkout/payment/Queue author is claimed by this suite. */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DbClient } from '@/lib/di';
import { storeOrderOutbox } from '@/models/schema';
import { outRequestHash } from '@/services/out/OutIdempotency';
import { capturePurchasedLabelIntent } from '@/services/order/PurchasedProductLabelCodec';
import { PURCHASED_PRODUCT_LABEL_SQL } from '@/migrations/purchasedProductLabelContract';
import { capturePurchasedLabelStorageTarget, inspectPurchasedLabelStorage,
  PURCHASED_LABEL_CATALOG_SQL, PURCHASED_LABEL_CATALOG_SHA256, PURCHASED_LABEL_STORAGE_GATE } from '@/migrations/purchasedProductLabelStorage';
import { capturePurchasedLabelStorageAddon, installPurchasedProductLabelStorage,
  installPurchasedProductLabelStorageInTransaction } from '@/migrations/installPurchasedProductLabelStorage';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';

type Query = Pick<DbClient, 'execute'>;
const addon = { purchasedProductLabels: true } as const;
const hash = 'a'.repeat(64);
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('prospective purchased-label owner-only storage', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  let target: { database: string; maintenance: string };
  let network: ReturnType<typeof vi.spyOn>;
  const rollback = async (work: (tx: DbClient) => Promise<void>) => {
    await expect(f.db.transaction(async tx => { await work(tx as unknown as DbClient); throw Error('owned rollback'); }))
      .rejects.toThrow('owned rollback');
  };
  const shape = async (tx: Query) => (await tx.execute<{ shape: unknown }>(sql.raw(PURCHASED_LABEL_CATALOG_SQL))).map(r => r.shape);
  const source = () => capturePurchasedLabelIntent({ format: 1, paymentEventId: 1, paymentOrderId: 9, paymentOrderNo: 'paid9',
    paymentSourceHash: hash, orderId: 10, orderNo: 'child10', userId: 11, financialStoreId: 5, supplierId: 44,
    orderType: 5, activityId: 3, totalNum: 2, occurredAt: 1700000000,
    carts: [{ rowId: 20, cartId: 'original-cart', productId: 70, productType: 0, ownerType: 2, ownerId: 44,
      skuUnique: '', quantity: 2, isGift: 0 }] });
  const intent = async (tx: Query, id: string, value: unknown = source(), patch: { uid?: number; key?: string } = {}) => {
    await tx.execute(sql`INSERT INTO public.purchased_product_label_intent
      (task_id,event_key,payment_event_id,payment_order_id,order_id,customer_uid,source_hash,source,created_at)
      VALUES(${id}::uuid,${patch.key ?? 'order.product.labels:9:10'},1,9,10,${patch.uid ?? 11},${hash},${JSON.stringify(value)}::jsonb,1700000000)`);
  };
  beforeAll(async () => {
    network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No provider calls in purchased-label storage acceptance'));
    f = await sequenceRunnerDatabase();
    const api = await import('drizzle-kit/api'), schema = await import('@/models/schema');
    await f.exec((await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(schema))).join('\n'));
    const [id] = await f.db.execute<{ database: string; maintenance: string }>(sql`SELECT current_database() AS database,current_user AS maintenance`);
    target = id!;
    await f.db.insert(storeOrderOutbox).values({ id: 1, eventKey: 'order.paid:9', eventType: 'order.paid', aggregateId: 9,
      payload: { orderId: 9, orderNo: 'paid9' }, status: 'COMPLETED' });
  }, 120000);
  afterAll(async () => { try { expect(network).not.toHaveBeenCalled(); } finally { network?.mockRestore(); await f?.close(); } }, 30000);

  it('requires closed explicit data declarations without evaluating getters or issuing SQL', async () => {
    let reads = 0;
    for (const bad of [{}, [], { purchasedProductLabels: false }, { ...addon, extra: true },
      { get purchasedProductLabels() { reads++; return true; } }])
      expect(() => capturePurchasedLabelStorageAddon(bad as typeof addon)).toThrow();
    for (const bad of [{ ...target, extra: true }, { ...target, database: 'public;DROP DATABASE x' },
      { database: target.database, get maintenance() { reads++; return target.maintenance; } }])
      expect(() => capturePurchasedLabelStorageTarget(bad)).toThrow();
    expect(reads).toBe(0);
    expect(await inspectPurchasedLabelStorage(f.db, target)).toMatchObject({ present: false, storageReady: false, runtimeReady: false });
    await expect(installPurchasedProductLabelStorageInTransaction(f.db, target, addon)).rejects.toThrow('Caller-owned');
    await expect(installPurchasedProductLabelStorage(f.db, target, { ...addon, extra: true } as typeof addon)).rejects.toThrow();
  });
  it('pins complete PG16 columns, constraints, indexes and stable internal FK triggers', async () => {
    await rollback(async tx => {
      await tx.execute(sql.raw(PURCHASED_PRODUCT_LABEL_SQL));
      const observed = await shape(tx), digest = await outRequestHash(observed);
      console.log('purchased label canonical SHA256', digest);
      expect(digest).toBe(PURCHASED_LABEL_CATALOG_SHA256);
      expect(await inspectPurchasedLabelStorage(tx, target)).toMatchObject({ present: true, storageReady: true, runtimeReady: false });
    });
  });
  it('rolls back full DDL with the caller and never grants runtime rights', async () => {
    await rollback(async tx => {
      expect(await installPurchasedProductLabelStorageInTransaction(tx, target, addon)).toMatchObject({ applied: true, runtimeReady: false });
      expect(await inspectPurchasedLabelStorage(tx, target)).toMatchObject({ storageReady: true, runtimeReady: false });
    });
    expect(await inspectPurchasedLabelStorage(f.db, target)).toMatchObject({ present: false });
  });
  it('requires the actual named direct maintenance LOGIN and exact database', async () => {
    await expect(installPurchasedProductLabelStorage(f.db, { ...target, database: 'wrong_database' }, addon)).rejects.toThrow('Actual named');
    await expect(installPurchasedProductLabelStorage(f.db, { ...target, maintenance: 'wrong_owner' }, addon)).rejects.toThrow('Actual named');
    if (!f.withRuntimeRole) throw Error('Actual native restricted LOGIN required');
    await f.withRuntimeRole(async peer => {
      await expect(installPurchasedProductLabelStorage(peer.db, target, addon)).rejects.toThrow('Actual named');
      await peer.db.execute(sql`RESET ROLE`);
      const [id] = await peer.db.execute<{ actual: string }>(sql`SELECT current_user AS actual`); expect(id.actual).toBe(peer.role);
    });
    expect(await inspectPurchasedLabelStorage(f.db, target)).toMatchObject({ present: false });
  });
  it.each([
    'CREATE TYPE public.purchased_product_label_intent AS ENUM(\'partial\')',
    'CREATE TABLE public.purchased_product_label_shadow(id int)',
    'CREATE SCHEMA labels_partial; CREATE TYPE labels_partial.purchased_product_label_intent AS ENUM(\'partial\')',
  ])('refuses partial namespace state without replacing it: %s', async statement => {
    await rollback(async tx => {
      await tx.execute(sql.raw(statement));
      expect(await inspectPurchasedLabelStorage(tx, target)).toMatchObject({ present: true, storageReady: false });
      await expect(tx.transaction(inner => installPurchasedProductLabelStorageInTransaction(inner, target, addon))).rejects.toThrow('drift');
      expect(await inspectPurchasedLabelStorage(tx, target)).toMatchObject({ present: true, storageReady: false });
    });
    expect(await inspectPurchasedLabelStorage(f.db, target)).toMatchObject({ present: false });
  });
  it('refuses unexpected default grants and rolls all new storage back instead of repairing ACLs', async () => {
    if (!f.withRuntimeRole) throw Error('Actual native restricted LOGIN required');
    await f.withRuntimeRole(async peer => {
      await rollback(async tx => {
        await tx.execute(sql`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${sql.identifier(peer.role)}`);
        await expect(tx.transaction(inner => installPurchasedProductLabelStorageInTransaction(inner, target, addon))).rejects.toThrow('Fresh purchased label');
        expect(await inspectPurchasedLabelStorage(tx, target)).toMatchObject({ present: false });
      });
    });
  });
  it('installs once, repeats without rewriting objects or rows, and remains runtime-inactive', async () => {
    expect(await installPurchasedProductLabelStorage(f.db, target, addon)).toMatchObject({ applied: true, runtimeReady: false });
    const identities = () => f.db.execute(sql`SELECT oid::text,relname,relfilenode::text FROM pg_class
      WHERE relnamespace='public'::regnamespace AND relname ~ '^(purchased_product_label|ppli_|ppls_|pplr_)' ORDER BY relname`);
    const before = await shape(f.db), objects = await identities(), payments = await f.db.select().from(storeOrderOutbox);
    expect(await installPurchasedProductLabelStorage(f.db, target, addon)).toMatchObject({ applied: false, runtimeReady: false });
    expect(await shape(f.db)).toEqual(before);
    expect(await identities()).toEqual(objects); expect(await f.db.select().from(storeOrderOutbox)).toEqual(payments);
    const [count] = await f.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM public.purchased_product_label_intent`);
    expect(count.n).toBe(0);
  });
  it('gives independent runtime LOGINs no table or immutable-function capabilities', async () => {
    if (!f.withRuntimeRole) throw Error('Actual native restricted LOGIN required');
    for (let i = 0; i < 2; i++) await f.withRuntimeRole(async peer => {
      for (const table of ['intent', 'state', 'result']) {
        const name = 'purchased_product_label_' + table;
        const [caps] = await f.db.execute<{ any: boolean }>(sql`SELECT pg_catalog.has_table_privilege(${peer.role},${'public.'+name},
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR pg_catalog.has_any_column_privilege(${peer.role},${'public.'+name},'SELECT,INSERT,UPDATE,REFERENCES') AS any`);
        expect(caps.any).toBe(false);
        for (const statement of [`SELECT * FROM public.${name}`, `INSERT INTO public.${name} DEFAULT VALUES`,
          `DELETE FROM public.${name} WHERE false`, `TRUNCATE public.${name}`])
          await expect(peer.exec(statement)).rejects.toMatchObject({ code: '42501' });
      }
      const [caps] = await f.db.execute<{ any: boolean }>(sql`SELECT pg_catalog.has_function_privilege(${peer.role},
        'public.purchased_product_label_immutable_v1()','EXECUTE') AS any`); expect(caps.any).toBe(false);
    });
  });
  it('keeps intent and success evidence immutable while lease state remains a distinct row', async () => {
    await rollback(async tx => {
      const id = randomUUID(); await intent(tx, id);
      await tx.execute(sql`INSERT INTO public.purchased_product_label_state(task_id,updated_at) VALUES(${id}::uuid,1700000000)`);
      await tx.execute(sql`UPDATE public.purchased_product_label_state SET status='PROCESSING',attempt_count=1,lease_token=${randomUUID()},lease_until=1700000030 WHERE task_id=${id}::uuid`);
      await tx.execute(sql`INSERT INTO public.purchased_product_label_result(task_id,source_hash,result,completed_at)
        VALUES(${id}::uuid,${hash},'{}'::jsonb,1700000001)`);
      for (const table of ['intent', 'result']) for (const statement of [
        `UPDATE public.purchased_product_label_${table} SET source_hash=source_hash WHERE task_id='${id}'`,
        `DELETE FROM public.purchased_product_label_${table} WHERE task_id='${id}'`, `TRUNCATE public.purchased_product_label_${table} CASCADE`])
        await expect(tx.transaction(inner => inner.execute(sql.raw(statement)))).rejects.toMatchObject({ cause: { code: '42501' } });
      await expect(tx.transaction(inner => inner.execute(sql`DELETE FROM public.store_order_outbox WHERE id=1`)))
        .rejects.toMatchObject({ cause: { code: '23503' } });
    });
  });
  it('round-trips the full admitted cart capacity and Unicode SKU identity without truncation', async () => {
    await rollback(async tx => {
      const base = source(), value = capturePurchasedLabelIntent({ ...base, totalNum: 200,
        carts: Array.from({ length: 200 }, (_, i) => ({ ...base.carts[0], rowId: i+1, cartId: 'original-'+i,
          quantity: 1, skuUnique: '🙂'.repeat(100) })) });
      const id = randomUUID(); await intent(tx, id, value);
      const [stored] = await tx.execute<{ source: unknown }>(sql`SELECT source FROM public.purchased_product_label_intent WHERE task_id=${id}::uuid`);
      expect(capturePurchasedLabelIntent(stored.source)).toEqual(value);
    });
  });
  it('rejects missing/scalar/extra/foreign source fields and missing parents at the SQL boundary', async () => {
    await rollback(async tx => {
      const good = source();
      const missing = { ...good } as Record<string, unknown>; delete missing.financialStoreId;
      for (const value of [missing, { ...good, financialStoreId: null }, { ...good, financialStoreId: '5' },
        { ...good, userId: 99 }, { ...good, totalNum: 0 }, { ...good, paymentSourceHash: 'not-a-digest' },
        { ...good, carts: [{ ...good.carts[0], quantity: 0 }] }, { ...good, carts: [{ ...good.carts[0], surprise: true }] },
        { ...good, fulfillmentStoreId: 9 }, { ...good, carts: [] }, { ...good, orderNo: 'paid9' }])
        await expect(tx.transaction(inner => intent(inner, randomUUID(), value))).rejects.toMatchObject({ cause: { code: '23514' } });
      await expect(tx.transaction(inner => intent(inner, randomUUID(), good, { uid: 99 }))).rejects.toMatchObject({ cause: { code: '23514' } });
      await expect(tx.transaction(inner => intent(inner, randomUUID(), good, { key: 'order.product.labels:9:11' }))).rejects.toMatchObject({ cause: { code: '23514' } });
      await expect(tx.transaction(inner => intent(inner, randomUUID(), { ...good, paymentEventId: 99 }))).rejects.toMatchObject({ cause: { code: '23514' } });
      const id = randomUUID(); await intent(tx, id);
      await expect(tx.transaction(inner => inner.execute(sql`INSERT INTO public.purchased_product_label_result(task_id,source_hash,result,completed_at)
        VALUES(${id}::uuid,${'b'.repeat(64)},'{}'::jsonb,1700000001)`))).rejects.toMatchObject({ cause: { code: '23503' } });
      await expect(tx.transaction(inner => inner.execute(sql`INSERT INTO public.purchased_product_label_state(task_id,updated_at)
        VALUES(${randomUUID()}::uuid,1700000000)`))).rejects.toMatchObject({ cause: { code: '23503' } });
    });
  });
  const changes = [
    ['extra index', 'CREATE INDEX ppl_extra ON public.purchased_product_label_intent(customer_uid)'],
    ['disabled immutable trigger', 'ALTER TABLE public.purchased_product_label_intent DISABLE TRIGGER ppli_immutable_rows'],
    ['missing source check', 'ALTER TABLE public.purchased_product_label_intent DROP CONSTRAINT ppli_source_ck'],
    ['function cost', 'ALTER FUNCTION public.purchased_product_label_immutable_v1() COST 101'],
    ['PUBLIC function authority', 'GRANT EXECUTE ON FUNCTION public.purchased_product_label_immutable_v1() TO PUBLIC'],
    ['PUBLIC table authority', 'GRANT SELECT ON public.purchased_product_label_state TO PUBLIC'],
    ['column ACL', 'GRANT UPDATE(status) ON public.purchased_product_label_state TO PUBLIC'],
    ['RLS', 'ALTER TABLE public.purchased_product_label_intent ENABLE ROW LEVEL SECURITY'],
    ['prefix table', 'CREATE TABLE public.purchased_product_label_shadow(id int)'],
    ['cross-schema prefix type', 'CREATE SCHEMA label_shadow; CREATE TYPE label_shadow.purchased_product_label_extra AS ENUM(\'partial\')'],
    ['external referencing dependency', 'CREATE TABLE public.label_external(task_id uuid REFERENCES public.purchased_product_label_intent(task_id))'],
    ['foreign immutable-function attachment', 'CREATE TABLE public.label_other(id int); CREATE TRIGGER other_immutable BEFORE DELETE ON public.label_other FOR EACH ROW EXECUTE FUNCTION public.purchased_product_label_immutable_v1()'],
  ] as const;
  it.each(changes)('refuses %s without repairing the changed catalog', async (_name, statement) => {
    const before = await shape(f.db);
    await rollback(async tx => {
      await tx.execute(sql.raw(statement)); const changed = await shape(tx);
      expect((await inspectPurchasedLabelStorage(tx, target)).storageReady).toBe(false);
      await expect(tx.transaction(inner => installPurchasedProductLabelStorageInTransaction(inner, target, addon))).rejects.toThrow('drift');
      expect(await shape(tx)).toEqual(changed);
    });
    expect(await shape(f.db)).toEqual(before);
  });
  it('includes both directions of parent-table RI triggers in the pinned catalog', async () => {
    await rollback(async tx => {
      const [trigger] = await tx.execute<{ name: string }>(sql`SELECT t.tgname AS name FROM pg_trigger t JOIN pg_constraint k ON k.oid=t.tgconstraint
        WHERE k.conname='ppli_payment_fk' AND k.conrelid='public.purchased_product_label_intent'::regclass
          AND t.tgrelid='public.store_order_outbox'::regclass ORDER BY t.tgname LIMIT 1`);
      await tx.execute(sql`ALTER TABLE public.store_order_outbox DISABLE TRIGGER ${sql.identifier(trigger.name)}`);
      expect(await inspectPurchasedLabelStorage(tx, target)).toMatchObject({ storageReady: false, failures: ['logical_catalog'] });
      await expect(tx.transaction(inner => installPurchasedProductLabelStorageInTransaction(inner, target, addon))).rejects.toThrow('drift');
    });
  });
  it('refuses concurrent maintenance or physical DDL holders without waiting or partial changes', async () => {
    if (!f.withPeer) throw Error('Independent native maintenance peer required');
    for (const statement of [sql`SELECT pg_advisory_xact_lock(${PURCHASED_LABEL_STORAGE_GATE[0]},${PURCHASED_LABEL_STORAGE_GATE[1]})`,
      sql`LOCK TABLE ONLY public.purchased_product_label_intent IN ACCESS EXCLUSIVE MODE NOWAIT`])
      await f.withPeer(async peer => {
        let ready!: () => void, release!: () => void;
        const acquired = new Promise<void>(r => { ready = r; }), released = new Promise<void>(r => { release = r; });
        const held = peer.db.transaction(async tx => { await tx.execute(statement); ready(); await released; });
        try {
          await Promise.race([acquired, held.then(() => { throw Error('holder ended early'); })]);
          await expect(installPurchasedProductLabelStorage(f.db, target, addon)).rejects.toThrow();
        } finally { release(); await held; }
      });
    expect((await inspectPurchasedLabelStorage(f.db, target)).storageReady).toBe(true);
  });
});
