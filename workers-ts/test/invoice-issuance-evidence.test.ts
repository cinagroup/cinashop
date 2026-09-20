import { afterEach, beforeEach, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { financePostgres } from './helpers/financePostgres';
import { storeOrderInvoice } from '../src/models/schema';
import { storeOrderInvoiceEvidence } from '../src/models/schema/invoice_evidence';
import { INVOICE_EVIDENCE_SQL } from '../src/migrations/invoiceEvidence';

let f: Awaited<ReturnType<typeof financePostgres>>;
const install = () => f.exec(INVOICE_EVIDENCE_SQL);
const seed = async (issued = false) => (await f.db.insert(storeOrderInvoice).values({ uid: 11, orderId: 10,
  name: 'Local initial title', isPay: 1, invoiceAmount: '10.00', isInvoice: issued ? 1 : 0,
  invoiceNumber: issued ? '12345678' : '' }).returning())[0];
const evidence = () => f.db.select().from(storeOrderInvoiceEvidence)
  .orderBy(storeOrderInvoiceEvidence.invoiceId, storeOrderInvoiceEvidence.kind, storeOrderInvoiceEvidence.documentNumber);
const state = async () => ({ invoices: await f.db.select().from(storeOrderInvoice), evidence: await evidence() });
beforeEach(async () => { f = await financePostgres([storeOrderInvoice]); }, 30_000);
afterEach(async () => { await f?.close(); });

it.each([false, true])('captures insertion and the first reported issuance snapshot in the row transaction: %s', async issued => {
  await install(); const row = await seed(issued), rows = await evidence();
  expect(rows.map(item => item.kind)).toEqual(issued ? ['created', 'issued'] : ['created']);
  for (const record of rows) expect(JSON.parse(record.snapshot)).toMatchObject({ v: 1,
    invoice: { id: row.id, uid: 11, order_id: 10, name: row.name, invoice_amount: 10,
      is_invoice: issued ? 1 : 0, invoice_number: issued ? '12345678' : '' } });
});

it('retains every reported number and its first snapshot through rejection, replacement and business deletion', async () => {
  await install(); const row = await seed();
  await f.db.update(storeOrderInvoice).set({ isInvoice: 1, invoiceNumber: '12345678', name: 'First document' });
  await f.db.update(storeOrderInvoice).set({ isInvoice: -1, invoiceNumber: '', name: 'Manual rejection' });
  await f.db.update(storeOrderInvoice).set({ isInvoice: 1, invoiceNumber: '87654321', name: 'Second document' });
  await f.db.update(storeOrderInvoice).set({ isInvoice: 1, invoiceNumber: '12345678', name: 'Do not rewrite first' });
  const before = await evidence(); expect(before).toHaveLength(3);
  expect(before.filter(item => item.kind === 'issued').map(item => JSON.parse(item.snapshot).invoice.name))
    .toEqual(['First document', 'Second document']);
  await f.db.delete(storeOrderInvoice); expect(await evidence()).toEqual(before);
  await expect(f.db.insert(storeOrderInvoice).values(row)).rejects.toThrow();
  expect(await state()).toEqual({ invoices: [], evidence: before });
});

it.each([{ id: 100 }, { uid: 22 }, { orderId: 20 }, { category: 'other' }])('does not repoint a recorded invoice identity: %j', async changes => {
  await install(); await seed(); const before = await state();
  await expect(f.db.update(storeOrderInvoice).set(changes)).rejects.toThrow(); expect(await state()).toEqual(before);
});

it.each(['UPDATE store_order_invoice_evidence SET uid=22', 'DELETE FROM store_order_invoice_evidence',
  'TRUNCATE store_order_invoice_evidence', 'TRUNCATE store_order_invoice'])('protects append-only evidence: %s', async statement => {
  await install(); await seed(); const before = await state();
  await expect(f.exec(statement)).rejects.toThrow('append-only'); expect(await state()).toEqual(before);
});

it.each(['update', 'delete'])('does not invent a created-unissued baseline for a pre-install row on %s', async mode => {
  await seed(); await install(); expect(await evidence()).toEqual([]);
  if (mode === 'update') await f.db.update(storeOrderInvoice).set({ name: 'Observed later' });
  else await f.db.delete(storeOrderInvoice);
  const rows = await evidence(); expect(rows.map(item => item.kind)).toEqual(['unverified']);
  expect(JSON.parse(rows[0].snapshot).invoice.name).toBe('Local initial title');
});

it('preserves pre-install OLD issuance even when the first observed update clears its number', async () => {
  await seed(true); await install();
  await f.db.update(storeOrderInvoice).set({ isInvoice: -1, invoiceNumber: '' });
  const rows = await evidence(); expect(rows.map(item => item.kind)).toEqual(['issued', 'unverified']);
  expect(JSON.parse(rows[0].snapshot).invoice.invoice_number).toBe('12345678');
});

it.each(['created', 'issued', 'unverified'])('rolls back the business mutation if %s capture is suppressed', async kind => {
  if (kind === 'unverified') await seed(); await install();
  if (kind === 'issued') await seed(); const before = await state();
  await f.exec(`CREATE FUNCTION suppress_evidence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.kind='${kind}' THEN RETURN NULL; END IF; RETURN NEW; END $$;
    CREATE TRIGGER suppress_evidence BEFORE INSERT ON store_order_invoice_evidence
    FOR EACH ROW EXECUTE FUNCTION suppress_evidence()`);
  if (kind === 'created') await expect(seed()).rejects.toThrow();
  else await expect(f.db.update(storeOrderInvoice).set(kind === 'issued'
    ? { isInvoice: 1, invoiceNumber: '12345678' } : { name: 'Unverified update' })).rejects.toThrow();
  expect(await state()).toEqual(before);
});

it('rolls back captured evidence when a later business trigger fails', async () => {
  await install(); await seed(); const before = await state();
  await f.exec(`CREATE FUNCTION fail_after_capture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    RAISE EXCEPTION 'Local late failure'; END $$;
    CREATE TRIGGER z_fail_after_capture AFTER UPDATE ON store_order_invoice FOR EACH ROW EXECUTE FUNCTION fail_after_capture()`);
  await expect(f.db.update(storeOrderInvoice).set({ isInvoice: 1, invoiceNumber: '12345678' })).rejects.toThrow();
  expect(await state()).toEqual(before);
});

it('records a nonempty reported number even when the mutable state says pending or rejected', async () => {
  await install(); const row = await seed();
  await f.db.update(storeOrderInvoice).set({ isInvoice: -1, invoiceNumber: '12345678' }).where(eq(storeOrderInvoice.id, row.id));
  expect((await evidence()).map(item => item.kind)).toEqual(['created', 'issued']);
});

it('uses fixed search_path, trigger-source qualification and no public function execution', async () => {
  await install();
  const rows = await f.db.select({ name: sql<string>`p.proname`, definer: sql<boolean>`p.prosecdef`,
    config: sql<string[]>`p.proconfig`, publicExecute: sql<boolean>`EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE')` })
    .from(sql`pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace`)
    .where(sql`n.nspname=current_schema() AND p.proname IN ('capture_invoice_evidence','protect_invoice_evidence')`);
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    expect(row.config.map(value => value.replaceAll(' ', ''))).toEqual(['search_path=pg_catalog,pg_temp']);
    expect(row.publicExecute).toBe(false);
  }
  expect(rows.find(row => row.name === 'capture_invoice_evidence')?.definer).toBe(true);
});

it.each(['oversized', 'null-owner', 'missing-owner', 'boolean-state', 'null-number', 'wrong-owner', 'wrong-version'])
  ('rejects malformed or unbounded evidence snapshots: %s', async mode => {
  await install();
  const row: Record<string, unknown> = { id: 999, order_id: 10, uid: 11, category: 'order', is_invoice: 0, invoice_number: '' };
  if (mode === 'oversized') row.remark = 'x'.repeat(16384);
  if (mode === 'null-owner') row.uid = null;
  if (mode === 'missing-owner') delete row.uid;
  if (mode === 'boolean-state') row.is_invoice = false;
  if (mode === 'null-number') row.invoice_number = null;
  if (mode === 'wrong-owner') row.uid = 22;
  await expect(f.db.insert(storeOrderInvoiceEvidence).values({ invoiceId: 999, kind: 'created', documentNumber: '',
    uid: 11, orderId: 10, snapshot: JSON.stringify({ v: mode === 'wrong-version' ? 2 : 1, invoice: row }) })).rejects.toThrow();
  expect(await evidence()).toEqual([]);
});
