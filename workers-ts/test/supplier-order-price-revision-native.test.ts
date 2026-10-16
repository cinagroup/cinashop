import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { storeOrderOutbox } from '@/models/schema';
import { PRODUCT_SAVE_EFFECTS_EVENTS } from '@/migrations/productSaveEffects';
import { SUPPLIER_ORDER_PRICE_REVISION_SQL, SUPPLIER_ORDER_PRICE_REVISION_CHECK_DEFINITION, runSupplierOrderPriceRevision, assertSupplierOrderPriceRevisionReady } from '@/migrations/supplierOrderPriceRevision';
import { readFileSync } from 'node:fs';
import { outcome, withFinancePeers } from './helpers/financePeers';
import { financePostgres } from './helpers/financePostgres';
const oldCheck=`CHECK (event_type IN (${PRODUCT_SAVE_EFFECTS_EVENTS.map(value=>`'${value}'`).join(',')}))`;
function signal(){let resolve!:()=>void;return{promise:new Promise<void>(done=>{resolve=done;}),resolve:()=>resolve()};}
const messages=(error:unknown):string=>error instanceof Error?`${error.message} ${messages(error.cause)}`:String(error);
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('PG16 standalone Supplier order revision event whitelist maintenance',()=>{
  let f:Awaited<ReturnType<typeof financePostgres>>;
  beforeAll(async()=>{f=await financePostgres([storeOrderOutbox],{namespace:'public'});},30000);
  beforeEach(async()=>{await f.reset();await f.db.insert(storeOrderOutbox).values({eventKey:'order.paid:1',eventType:'order.paid',aggregateId:1,payload:{orderId:1,orderNo:'ownedRevisionOrigin'}});await f.exec(`ALTER TABLE store_order_outbox DROP CONSTRAINT IF EXISTS soob_event_type_ck; ALTER TABLE store_order_outbox ADD CONSTRAINT soob_event_type_ck ${oldCheck}`);});
  afterAll(async()=>{await f?.close();});
  const catalog=()=>f.exec("SELECT oid::text,pg_get_constraintdef(oid) definition,obj_description(oid,'pg_constraint') comment FROM pg_constraint WHERE conrelid='public.store_order_outbox'::regclass AND conname='soob_event_type_ck'");
  it('upgrades only the exact previous whitelist, preserves comments, repeats without OID replacement and leaves business rows/sequences unchanged',async()=>{
    expect(readFileSync('src/migrations/maintenance/0193_supplier_order_price_revision.sql','utf8')).toBe(SUPPLIER_ORDER_PRICE_REVISION_SQL);
    await expect(assertSupplierOrderPriceRevisionReady(f.db)).rejects.toMatchObject({httpStatus:503});
    await f.exec("COMMENT ON CONSTRAINT soob_event_type_ck ON store_order_outbox IS 'owned maintenance comment'");
    const before=await f.db.select().from(storeOrderOutbox),sequence=await f.exec('SELECT last_value,is_called FROM store_order_outbox_id_seq');
    await runSupplierOrderPriceRevision(f.db); await assertSupplierOrderPriceRevisionReady(f.db); const installed=await catalog();expect(installed).toMatchObject([{definition:SUPPLIER_ORDER_PRICE_REVISION_CHECK_DEFINITION,comment:'owned maintenance comment'}]);
    await runSupplierOrderPriceRevision(f.db);expect(await catalog()).toEqual(installed);expect(await f.db.select().from(storeOrderOutbox)).toEqual(before);expect(await f.exec('SELECT last_value,is_called FROM store_order_outbox_id_seq')).toEqual(sequence);
  });
  it('refuses an unknown existing CHECK without repairing it or mutating data',async()=>{
    await f.exec("ALTER TABLE store_order_outbox DROP CONSTRAINT soob_event_type_ck;ALTER TABLE store_order_outbox ADD CONSTRAINT soob_event_type_ck CHECK(event_type <> '')");
    const before=await catalog(),data=await f.db.select().from(storeOrderOutbox),result=await outcome(runSupplierOrderPriceRevision(f.db));expect(result.ok).toBe(false);if(!result.ok)expect(messages(result.error)).toContain('CHECK drift');expect(await catalog()).toEqual(before);expect(await f.db.select().from(storeOrderOutbox)).toEqual(data);
  });
  it('refuses structural column and row-security drift even when the whitelist text looks correct',async()=>{
    await f.exec('ALTER TABLE store_order_outbox ALTER COLUMN event_type TYPE varchar(65)');
    const before=await catalog(),data=await f.db.select().from(storeOrderOutbox);
    try {
      const column=await outcome(runSupplierOrderPriceRevision(f.db));
      expect(column.ok).toBe(false);if(!column.ok)expect(messages(column.error)).toContain('CHECK drift');
      expect(await catalog()).toEqual(before);expect(await f.db.select().from(storeOrderOutbox)).toEqual(data);
    } finally { await f.exec('ALTER TABLE store_order_outbox ALTER COLUMN event_type TYPE varchar(64)'); }
    const securityBefore=await catalog();
    await f.exec('ALTER TABLE store_order_outbox ENABLE ROW LEVEL SECURITY');
    try {
      const security=await outcome(runSupplierOrderPriceRevision(f.db));
      expect(security.ok).toBe(false);if(!security.ok)expect(messages(security.error)).toContain('prerequisite drift');
      expect(await catalog()).toEqual(securityBefore);expect(await f.db.select().from(storeOrderOutbox)).toEqual(data);
    } finally { await f.exec('ALTER TABLE store_order_outbox DISABLE ROW LEVEL SECURITY'); }
  });
  it('refuses a concurrent real outbox writer immediately and succeeds after release',async()=>{
    await f.db.insert(storeOrderOutbox).values({id:9,eventKey:'order.paid:70',eventType:'order.paid',aggregateId:70,payload:{orderId:70,orderNo:'stock-unrelated-order'}});
    await withFinancePeers(f.db,async([writer,maintainer])=>{const held=signal(),release=signal();const holding=writer.db.transaction(async tx=>{await tx.update(storeOrderOutbox).set({updateTime:1}).where(eq(storeOrderOutbox.id,9));held.resolve();await release.promise;});
      try{await held.promise;const before=await catalog(),result=await outcome(runSupplierOrderPriceRevision(maintainer.db));expect(result.ok).toBe(false);if(!result.ok)expect(messages(result.error)).toMatch(/lock|55P03/);expect(await catalog()).toEqual(before);}finally{release.resolve();await holding;}
      await runSupplierOrderPriceRevision(maintainer.db);
    });
  });
  it('preserves stricter caller timeout budgets and rolls back an over-budget candidate without CHECK replacement',async()=>{
    await f.db.transaction(async tx=>{
      await tx.execute(sql`SET LOCAL statement_timeout='900ms'`);await tx.execute(sql`SET LOCAL lock_timeout='700ms'`);await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='800ms'`);
      const probe=()=>tx.execute(sql`SELECT current_setting('statement_timeout') s,current_setting('lock_timeout') l,current_setting('idle_in_transaction_session_timeout') i`),initial=await probe();
      await tx.execute(sql.raw(SUPPLIER_ORDER_PRICE_REVISION_SQL));expect(await probe()).toEqual(initial);
    });
    await f.exec(`ALTER TABLE store_order_outbox DROP CONSTRAINT soob_event_type_ck; ALTER TABLE store_order_outbox ADD CONSTRAINT soob_event_type_ck ${oldCheck}`);
    await f.exec("INSERT INTO store_order_outbox(event_key,event_type,aggregate_id) SELECT 'order.paid:'||n,'order.paid',n FROM generate_series(1,10001) n");
    const before=await catalog(),result=await outcome(runSupplierOrderPriceRevision(f.db));expect(result.ok).toBe(false);if(!result.ok)expect(messages(result.error)).toContain('row budget exceeded');expect(await catalog()).toEqual(before);
  });
});
