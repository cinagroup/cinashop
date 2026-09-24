import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createContainerFromDb } from '@/lib/di';
import { MigrationService } from '@/services/MigrationService';
import { PRESALE_DELIVERY_OUTBOX_SQL } from '@/migrations/presaleDeliveryOutbox';
import { runPresaleDeliveryOutbox } from '@/migrations/runPresaleDeliveryOutbox';
import { financePostgres } from './helpers/financePostgres';

const events = ['order.paid', 'order.delivery.notice', 'order.refund.refused.notice', 'order.second_card.advent.notice',
  'order.second_card.expired.notice', 'withdrawal.approved.notice', 'withdrawal.refused.notice',
  'withdrawal.applied.notice', 'withdrawal.staff.refresh'];
const oldCheck = `CHECK (event_type IN (${events.map(e => `'${e}'`).join(',')}))`;
const native = Boolean(process.env.TEST_FINANCE_POSTGRES_URL);
describe('presale event forward migration (no business/ACL mutation)', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>;
  const apply = async (failAfterDdl = false) => {
    if (native) return f.db.$client.begin(async tx => {
      await tx.unsafe(PRESALE_DELIVERY_OUTBOX_SQL);
      if (failAfterDdl) await tx.unsafe('SELECT 1/0');
    });
    // f.exec uses the driver's simple-query path for multi-statement DDL.
    await f.exec('BEGIN');
    try {
      await f.exec(PRESALE_DELIVERY_OUTBOX_SQL);
      if (failAfterDdl) await f.exec('SELECT 1/0');
      await f.exec('COMMIT');
    } catch (error) { await f.exec('ROLLBACK'); throw error; }
  };
  const state = async () => {
    const rows = await f.db.execute(sql`SELECT * FROM public.store_order_outbox ORDER BY id`);
    const catalog = await f.db.execute(sql`SELECT c.oid,c.convalidated,pg_get_constraintdef(c.oid) AS definition,
      t.relowner,t.relacl FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
      WHERE c.conrelid='public.store_order_outbox'::regclass AND c.conname='soob_event_type_ck'`);
    return { rows: Array.from(rows), catalog: Array.from(catalog) };
  };
  beforeAll(async () => {
    f = await financePostgres([]);
    await f.exec('CREATE TABLE public.store_order_outbox (id serial PRIMARY KEY, event_type varchar(64) NOT NULL, payload jsonb NOT NULL)');
  });
  afterAll(async () => { await f?.close(); });
  beforeEach(async () => {
    await f.exec(`TRUNCATE public.store_order_outbox RESTART IDENTITY;
      ALTER TABLE public.store_order_outbox DROP CONSTRAINT IF EXISTS soob_event_type_ck;
      ALTER TABLE public.store_order_outbox ADD CONSTRAINT soob_event_type_ck ${oldCheck};
      INSERT INTO public.store_order_outbox(event_type,payload) VALUES ('order.paid','{"local":true}')`);
  });
  it('keeps embedded and external SQL byte-identical for the caller-owned transaction', () => {
    expect(readFileSync('migrations/0161_presale_delivery_outbox.sql', 'utf8').trim()).toBe(PRESALE_DELIVERY_OUTBOX_SQL.trim());
    expect(new MigrationService(createContainerFromDb(f.db)).presaleDeliveryOutboxMigrationSqlForVerification()).toBe(PRESALE_DELIVERY_OUTBOX_SQL);
  });
  it('expands the known check, preserves all rows/owner/ACL and is a true no-op on repeat', async () => {
    const before = await state(); await apply(); const after = await state();
    expect(after.rows).toEqual(before.rows);
    expect(after.catalog[0]).toMatchObject({ relowner: before.catalog[0].relowner, relacl: before.catalog[0].relacl, convalidated: true });
    await f.exec("INSERT INTO public.store_order_outbox(event_type,payload) VALUES ('order.presale.fulfillment','{}')");
    const final = await state(); await apply(); expect(await state()).toEqual(final);
    await expect(f.exec("INSERT INTO public.store_order_outbox(event_type,payload) VALUES ('unknown.event','{}')")).rejects.toThrow();
  });
  it.each(['missing', 'widened', 'unvalidated'])('rejects %s CHECK drift without changing rows or schema', async fault => {
    await f.exec('ALTER TABLE public.store_order_outbox DROP CONSTRAINT soob_event_type_ck');
    if (fault !== 'missing') await f.exec(`ALTER TABLE public.store_order_outbox ADD CONSTRAINT soob_event_type_ck ${fault === 'widened' ? 'CHECK (true)' : oldCheck + ' NOT VALID'}`);
    const before = await state(); await expect(apply()).rejects.toThrow(); expect(await state()).toEqual(before);
  });
  it('rolls back expansion with a later SQL error', async () => {
    const before = await state();
    await expect(apply(true)).rejects.toThrow('division by zero');
    expect(await state()).toEqual(before);
  });
  it('refuses an oversized maintenance table without narrowing or changing rows', async () => {
    await f.exec("INSERT INTO public.store_order_outbox(event_type,payload) SELECT 'order.paid','{}' FROM generate_series(1,10000)");
    const before = await state();
    await expect(apply()).rejects.toThrow('row budget exceeded'); expect(await state()).toEqual(before);
  });
  it('refuses full-bootstrap replay before old narrowing migrations can execute', async () => {
    await apply(); const before = await state();
    expect(await new MigrationService(createContainerFromDb(f.db)).runAll()).toEqual({ executed: [],
      errors: ['Presale outbox already registered; use standalone forward upgrades, not runAll'] });
    expect(await state()).toEqual(before);
  });
  it.skipIf(!native)('executes the real standalone root transaction on PG16', async () => {
    await runPresaleDeliveryOutbox(f.db);
    expect(String((await state()).catalog[0].definition)).toContain('order.presale.fulfillment');
  });
});
