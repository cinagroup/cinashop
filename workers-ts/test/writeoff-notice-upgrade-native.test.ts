/** PG16 catalog specimens are structural migration evidence, never orders,
 * payments or provider facts. No runtime privilege is repaired by HTTP. */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { storeOrderOutbox } from '@/models/schema';
import { WRITEOFF_NOTICE_EVENT, WRITEOFF_NOTICE_EVENT_GENERATIONS, WRITEOFF_NOTICE_PREDECESSORS,
  runWriteoffNoticeUpgrade, writeoffNoticeCommissionedTx, writeoffNoticeEventGeneration } from '@/migrations/writeoffNotice';
import { runRefundSuccessNoticeUpgrade, refundSuccessNoticeCommissionedTx } from '@/migrations/refundSuccessNotice';
import { runSupplierOrderPriceRevision, assertSupplierOrderPriceRevisionReady } from '@/migrations/supplierOrderPriceRevision';
import { runWithdrawalEffectsUpgrade, inspectWithdrawalEffectsUpgrade } from '@/migrations/runWithdrawalEffectsUpgrade';
import { runWithdrawalReplayUpgrade } from '@/migrations/runWithdrawalReplayUpgrade';
import { inspectRoutineVirtualShippingSubjectsStructure, routineVirtualShippingSubjectsInstallSql } from '@/migrations/routineVirtualShippingSubjects';
import { runRoutineOriginalPaymentEvidenceUpgrade } from '@/migrations/runRoutineOriginalPaymentEvidenceUpgrade';
import { runRoutinePaymentAccountPolicyUpgrade } from '@/migrations/runRoutinePaymentAccountPolicyUpgrade';
import { runRoutineShippingUpgrade } from '@/migrations/runRoutineShippingUpgrade';
import { runRoutineVirtualShippingSubjectsUpgrade } from '@/migrations/runRoutineVirtualShippingSubjectsUpgrade';
import { financePostgres } from './helpers/financePostgres';
import { withFinancePeers } from './helpers/financePeers';
import { customerCashierRuntimeHttpFixture } from './helpers/customerCashierRuntimeHttpFixture';

const family = (price = false, virtual = false, addons: string[] = []) => {
  const found = WRITEOFF_NOTICE_EVENT_GENERATIONS.find(g => g.price === price && g.virtual === virtual && JSON.stringify(g.addons) === JSON.stringify(addons));
  if (!found) throw Error('Test requires one exact known family');
  return found;
};
const clause = (events: readonly string[]) => `CHECK(event_type IN (${events.map(e => `'${e}'`).join(',')}))`;
const refundEvent = 'order.refund.success.notice';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('PG16 explicit writeoff notice catalog commissioning', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>;
  beforeAll(async () => { f = await financePostgres([storeOrderOutbox], { namespace: 'public' }); }, 30000);
  beforeEach(async () => {
    await f.reset();
    await f.exec('DROP TABLE IF EXISTS public.order_notification_delivery,public.capital_flow,public.system_message,public.user_extract CASCADE');
    await setEvents(family().events);
    await f.db.insert(storeOrderOutbox).values({ eventKey: 'structural-owned', eventType: 'order.paid', aggregateId: 11,
      payload: { orderId: 11, orderNo: 'structural-specimen' } });
  });
  afterAll(async () => { await f?.close(); }, 30000);
  const setEvents = (events: readonly string[]) => f.exec(`ALTER TABLE public.store_order_outbox DROP CONSTRAINT IF EXISTS soob_event_type_ck;
    ALTER TABLE public.store_order_outbox ADD CONSTRAINT soob_event_type_ck ${clause(events)}`);
  const catalog = () => f.db.execute<{ oid: string; definition: string; comment: string | null }>(sql.raw("SELECT oid::text,pg_get_constraintdef(oid,false) AS definition,obj_description(oid,'pg_constraint') AS comment FROM pg_constraint WHERE conrelid='public.store_order_outbox'::regclass AND conname='soob_event_type_ck'"));
  const business = async () => ({ rows: await f.db.select().from(storeOrderOutbox),
    sequence: await f.exec('SELECT last_value,is_called FROM public.store_order_outbox_id_seq') });
  const createDelivery = () => f.exec(`CREATE TABLE public.order_notification_delivery(id serial PRIMARY KEY,
    order_id integer,withdrawal_id integer,event_key varchar(128) NOT NULL,channel varchar(32) NOT NULL,notice_mark varchar(50) NOT NULL,
    CONSTRAINT ond_subject_ck CHECK((withdrawal_id IS NULL AND order_id IS NOT NULL) OR (withdrawal_id IS NOT NULL AND withdrawal_id>0 AND order_id IS NULL)))`);

  it.each(WRITEOFF_NOTICE_PREDECESSORS.map((definition, index) => ({ definition, index })))('adds only writeoff to exact predecessor $index and preserves rows/sequence/comment on replay', async ({ definition }) => {
    const predecessor = writeoffNoticeEventGeneration(definition)!;
    await setEvents(predecessor.events);
    await f.exec("COMMENT ON CONSTRAINT soob_event_type_ck ON public.store_order_outbox IS 'owned comment '' preserved'");
    const before = await business();
    expect(await writeoffNoticeCommissionedTx(f.db)).toBe(false);
    expect(await refundSuccessNoticeCommissionedTx(f.db)).toBe(predecessor.addons.includes(refundEvent));
    await runWriteoffNoticeUpgrade(f.db);
    const installed = await catalog();
    expect(installed[0].definition).toBe(family(predecessor.price, predecessor.virtual, [...predecessor.addons, WRITEOFF_NOTICE_EVENT]).definition);
    expect(installed[0].comment).toBe("owned comment ' preserved");
    expect(await writeoffNoticeCommissionedTx(f.db)).toBe(true);
    expect(await refundSuccessNoticeCommissionedTx(f.db)).toBe(predecessor.addons.includes(refundEvent));
    await runWriteoffNoticeUpgrade(f.db);
    expect(await catalog()).toEqual(installed);
    expect(await business()).toEqual(before);
  });
  it.each([[WRITEOFF_NOTICE_EVENT, refundEvent], [refundEvent, WRITEOFF_NOTICE_EVENT]])('preserves independent tail order %s/%s through price and DB-007 replays', async (first, second) => {
    await createDelivery();
    await f.exec(`CREATE TABLE public.user_extract(id serial PRIMARY KEY,uid integer NOT NULL,wechat varchar(15) NOT NULL DEFAULT '');
      CREATE TABLE public.capital_flow(id serial PRIMARY KEY,amount numeric(12,2));
      CREATE TABLE public.system_message(id serial PRIMARY KEY,user_id integer,type smallint,status smallint,is_del smallint)`);
    await runWithdrawalReplayUpgrade(f.db); await runWithdrawalEffectsUpgrade(f.db);
    for (const addon of [first, second]) await (addon === WRITEOFF_NOTICE_EVENT ? runWriteoffNoticeUpgrade(f.db) : runRefundSuccessNoticeUpgrade(f.db));
    const before = await business();
    await runSupplierOrderPriceRevision(f.db); await assertSupplierOrderPriceRevisionReady(f.db);
    const installed = await catalog();
    expect(installed[0].definition).toBe(family(true, false, [first, second]).definition);
    await runWriteoffNoticeUpgrade(f.db); await runRefundSuccessNoticeUpgrade(f.db); await runSupplierOrderPriceRevision(f.db);
    expect(await runWithdrawalEffectsUpgrade(f.db)).toMatchObject({ applied: false, ready: true });
    expect(await inspectWithdrawalEffectsUpgrade(f.db)).toMatchObject({ supported: true, ready: true });
    expect(await catalog()).toEqual(installed); expect(await business()).toEqual(before);
  });
  it('classifies virtual successors and adds price while retaining independent refund/writeoff order', async () => {
    await createDelivery(); await runWriteoffNoticeUpgrade(f.db); await runRefundSuccessNoticeUpgrade(f.db);
    await f.exec(routineVirtualShippingSubjectsInstallSql(false, true, true, true));
    expect(await inspectRoutineVirtualShippingSubjectsStructure(f.db)).toMatchObject({ state: 'virtual16', ready: true, failures: [] });
    const before = await business();
    await runSupplierOrderPriceRevision(f.db); await assertSupplierOrderPriceRevisionReady(f.db);
    const installed = await catalog(); expect(installed[0].definition).toBe(family(true, true, [WRITEOFF_NOTICE_EVENT, refundEvent]).definition);
    expect(await inspectRoutineVirtualShippingSubjectsStructure(f.db)).toMatchObject({ state: 'virtual17', ready: true, failures: [] });
    await runRefundSuccessNoticeUpgrade(f.db); await runWriteoffNoticeUpgrade(f.db); await runSupplierOrderPriceRevision(f.db);
    expect(await catalog()).toEqual(installed); expect(await business()).toEqual(before);
  });
  it('rejects a partial virtual subject catalog instead of adding price', async () => {
    await createDelivery(); await runWriteoffNoticeUpgrade(f.db);
    await f.exec(routineVirtualShippingSubjectsInstallSql(false, false, true));
    await f.exec('DROP INDEX public.ond_virtual_subject'); const before = await catalog();
    await expect(runSupplierOrderPriceRevision(f.db)).rejects.toThrow();
    await expect(assertSupplierOrderPriceRevisionReady(f.db)).rejects.toMatchObject({ httpStatus: 503 });
    expect(await catalog()).toEqual(before);
  });
  it('refuses unknown, unvalidated, missing CHECK and column drift without automatic repair', async () => {
    for (const change of ["CHECK(event_type <> '')", `${clause(family().events)} NOT VALID`, null] as const) {
      await f.exec('ALTER TABLE public.store_order_outbox DROP CONSTRAINT soob_event_type_ck');
      if (change) await f.exec(`ALTER TABLE public.store_order_outbox ADD CONSTRAINT soob_event_type_ck ${change}`);
      const before = await catalog(), rows = await business();
      await expect(writeoffNoticeCommissionedTx(f.db)).rejects.toMatchObject({ httpStatus: 503 });
      await expect(runWriteoffNoticeUpgrade(f.db)).rejects.toThrow();
      expect(await catalog()).toEqual(before); expect(await business()).toEqual(rows);
      await f.exec(`ALTER TABLE public.store_order_outbox DROP CONSTRAINT IF EXISTS soob_event_type_ck;
        ALTER TABLE public.store_order_outbox ADD CONSTRAINT soob_event_type_ck ${clause(family().events)}`);
    }
    await f.exec('ALTER TABLE public.store_order_outbox ALTER COLUMN event_type TYPE varchar(65)');
    try { await expect(writeoffNoticeCommissionedTx(f.db)).rejects.toMatchObject({ httpStatus: 503 });
      await expect(runWriteoffNoticeUpgrade(f.db)).rejects.toThrow(); }
    finally { await f.exec('ALTER TABLE public.store_order_outbox ALTER COLUMN event_type TYPE varchar(64)'); }
  });
  it('refuses a shadow relation and held relation lock, then commissions after safe release', async () => {
    await f.db.transaction(async tx => {
      await tx.execute(sql`CREATE TEMP TABLE store_order_outbox(id integer) ON COMMIT DROP`);
      await tx.execute(sql`SET LOCAL search_path=pg_temp,public`);
      await expect(writeoffNoticeCommissionedTx(tx)).rejects.toMatchObject({ httpStatus: 503 });
    });
    await withFinancePeers(f.db, async ([peer]) => {
      await peer.db.transaction(async tx => {
        await tx.execute(sql`LOCK TABLE public.store_order_outbox IN ACCESS EXCLUSIVE MODE`);
        await expect(runWriteoffNoticeUpgrade(f.db)).rejects.toThrow();
      });
    });
    await runWriteoffNoticeUpgrade(f.db); expect(await writeoffNoticeCommissionedTx(f.db)).toBe(true);
  });
  it('refuses bounded row overflow without changing the original event contract', async () => {
    await f.exec("INSERT INTO public.store_order_outbox(event_key,event_type,aggregate_id,payload) SELECT 'owned-overflow:'||n,'order.paid',n,'{}'::jsonb FROM generate_series(1,10000)n");
    const before = await catalog();
    await expect(runWriteoffNoticeUpgrade(f.db)).rejects.toThrow();
    expect(await catalog()).toEqual(before); expect(await writeoffNoticeCommissionedTx(f.db)).toBe(false);
    await f.db.delete(storeOrderOutbox).where(sql`${storeOrderOutbox.eventKey} LIKE 'owned-overflow:%'`);
  });
});

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('formal virtual addon preserves writeoff then refund commissioning', () => {
  let f: Awaited<ReturnType<typeof customerCashierRuntimeHttpFixture>>, guard: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;
  beforeAll(async () => { guard = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No catalog acceptance provider request'));
    f = await customerCashierRuntimeHttpFixture(); }, 180000);
  afterAll(async () => { try { await f?.close(); expect(guard).not.toHaveBeenCalled(); } finally { guard?.mockRestore(); } }, 30000);
  it('uses actual formal profiles for virtual install and keeps every independent addon on idempotent replay', async () => {
    await runRoutineOriginalPaymentEvidenceUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders);
    await runRoutinePaymentAccountPolicyUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders);
    await runRoutineShippingUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders);
    await runWriteoffNoticeUpgrade(f.maintenanceDb); await runRefundSuccessNoticeUpgrade(f.maintenanceDb);
    const before = await f.facts();
    expect(await runRoutineVirtualShippingSubjectsUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders)).toMatchObject({ applied: true, state: 'virtual16' });
    expect(await f.facts()).toEqual(before);
    expect(await f.appRuntime.db.transaction(tx => writeoffNoticeCommissionedTx(tx))).toBe(true);
    expect(await f.appRuntime.db.transaction(tx => refundSuccessNoticeCommissionedTx(tx))).toBe(true);
    await runSupplierOrderPriceRevision(f.maintenanceDb); await assertSupplierOrderPriceRevisionReady(f.appRuntime.db);
    expect(await runRoutineVirtualShippingSubjectsUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders)).toMatchObject({ applied: false, state: 'virtual17' });
    await runRefundSuccessNoticeUpgrade(f.maintenanceDb); await runWriteoffNoticeUpgrade(f.maintenanceDb);
    const [installed] = await f.maintenanceDb.execute<{ definition: string }>(sql`SELECT pg_get_constraintdef(oid,false) AS definition FROM pg_constraint WHERE conrelid='public.store_order_outbox'::regclass AND conname='soob_event_type_ck'`);
    expect(installed.definition).toBe(family(true, true, [WRITEOFF_NOTICE_EVENT, refundEvent]).definition);
    expect(await f.facts()).toEqual(before);
  }, 120000);
});
