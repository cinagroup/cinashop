import { afterEach, beforeEach, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { financePostgres, ownsFinanceFixtureTarget, validateFinanceFixtureUrl } from './helpers/financePostgres';
import { createContainerFromDb, withTx, type DbClient } from '../src/lib/di';
import { storeOrder, storeOrderInvoice } from '../src/models/schema';
import { storeOrderInvoiceAllocation } from '../src/models/schema/invoice_allocation';
import { prepareSplitInvoice, materializeSplitInvoice } from '../src/services/order/SplitInvoiceAllocation';
import { storeOrderInvoiceEvidence } from '../src/models/schema/invoice_evidence';
import { INVOICE_EVIDENCE_SQL } from '../src/migrations/invoiceEvidence';
import { withFinancePeers } from './helpers/financePeers';

let f: Awaited<ReturnType<typeof financePostgres>>;
let role: string, schema: string, created = false;
const asRuntime = <T>(work: (tx: DbClient) => Promise<T>, db: DbClient = f.db) => withTx(createContainerFromDb(db), async tx => {
  await tx.execute(sql.raw(`SET LOCAL ROLE "${role}"`));
  const [identity] = await tx.select({ name: sql<string>`current_user`, superuser: sql<boolean>`rolsuper` })
    .from(sql`pg_roles`).where(sql`rolname=current_user`);
  expect(identity).toEqual({ name: role, superuser: false });
  return work(tx);
});
const expectDenied = async (work: () => Promise<unknown>) => {
  let state = '';
  try { await work(); } catch (error) {
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
      if ('code' in current && typeof current.code === 'string') state = current.code;
      current = 'cause' in current ? current.cause : null;
    }
  }
  expect(state).toBe('42501');
};
beforeEach(async () => {
  created = false;
  const base = validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL ?? '');
  f = await financePostgres([storeOrderInvoice, storeOrder]);
  const [identity] = await f.db.select({ schema: sql<string>`current_schema()`, database: sql<string>`current_database()`,
    maintenance: sql<boolean>`rolsuper AND rolcreaterole` }).from(sql`pg_roles`).where(sql`rolname=current_user`);
  schema = identity.schema;
  if (!identity.maintenance || !/^finance_test_[a-f0-9]{32}$/.test(schema)
    || !ownsFinanceFixtureTarget(identity.database, schema, base.href)) throw Error('Requires owned local schema-maintenance fixture');
  await f.exec(INVOICE_EVIDENCE_SQL);
  role = `invoice_runtime_${crypto.randomUUID().replaceAll('-', '')}`;
  if (!/^invoice_runtime_[a-f0-9]{32}$/.test(role)) throw Error('Unsafe test role');
  await f.exec(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOINHERIT NOCREATEROLE NOCREATEDB NOREPLICATION`); created = true;
  await f.exec(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}";
    GRANT SELECT, INSERT, UPDATE, DELETE ON store_order_invoice TO "${role}";
    GRANT USAGE, SELECT ON SEQUENCE store_order_invoice_id_seq TO "${role}";
    GRANT SELECT ON store_order_invoice_evidence TO "${role}";
    GRANT SELECT, INSERT ON store_order_invoice_allocation TO "${role}";
    GRANT SELECT, INSERT, UPDATE ON store_order TO "${role}"`);
  await f.db.insert(storeOrder).values({ id: 10, orderId: 'permission-root', uid: 11, paid: 1, payType: 'yue', payPrice: '10.00' });
  await asRuntime(tx => tx.insert(storeOrderInvoice).values({ uid: 11, orderId: 10, isPay: 1, invoiceAmount: '10.00' }));
}, 30_000);
afterEach(async () => {
  try {
    if (created) await f.exec(`REVOKE ALL ON store_order_invoice,store_order_invoice_evidence,store_order_invoice_allocation,store_order FROM "${role}";
      REVOKE ALL ON SEQUENCE store_order_invoice_id_seq FROM "${role}";
      REVOKE ALL ON SCHEMA "${schema}" FROM "${role}"; DROP ROLE "${role}"`);
  } finally { await f?.close(); }
});

it('captures actual runtime-role mutations without granting it evidence INSERT or function execution', async () => {
  await asRuntime(async tx => {
    const [rights] = await tx.select({ insert: sql<boolean>`has_table_privilege(current_user,'store_order_invoice_evidence','INSERT')`,
      update: sql<boolean>`has_table_privilege(current_user,'store_order_invoice_evidence','UPDATE')`,
      execute: sql<boolean>`has_function_privilege(current_user,'capture_invoice_evidence()','EXECUTE')` }).from(sql`(values(1)) probe(n)`);
    expect(rights).toEqual({ insert: false, update: false, execute: false });
    await tx.update(storeOrderInvoice).set({ isInvoice: 1, invoiceNumber: '12345678' });
    await tx.update(storeOrderInvoice).set({ isInvoice: -1, invoiceNumber: '' });
    await tx.delete(storeOrderInvoice);
    expect((await tx.select().from(storeOrderInvoiceEvidence)).map(row => row.kind).sort()).toEqual(['created', 'issued']);
  });
});

it.each([
  'INSERT INTO store_order_invoice_evidence SELECT * FROM store_order_invoice_evidence',
  "UPDATE store_order_invoice_evidence SET kind='unverified'",
  'DELETE FROM store_order_invoice_evidence', 'TRUNCATE store_order_invoice_evidence',
  'TRUNCATE store_order_invoice',
  'ALTER TABLE store_order_invoice DISABLE TRIGGER soi_capture_evidence', 'SELECT capture_invoice_evidence()',
])('rejects runtime-role evidence forgery, erasure or capture bypass: %s', async statement => {
  const before = await f.db.select().from(storeOrderInvoiceEvidence);
  await expectDenied(() => asRuntime(tx => tx.execute(sql.raw(statement))));
  expect(await f.db.select().from(storeOrderInvoiceEvidence)).toEqual(before);
});

it('ignores a caller-owned temporary table shadow while capturing into the source schema', async () => {
  await asRuntime(async tx => {
    await tx.execute(sql`CREATE TEMP TABLE store_order_invoice_evidence (fake integer) ON COMMIT DROP`);
    await tx.execute(sql.raw(`SET LOCAL search_path=pg_temp,"${schema}"`));
    await tx.update(storeOrderInvoice).set({ isInvoice: 1, invoiceNumber: '12345678' });
    const [shadow] = await tx.select({ count: sql<number>`count(*)::integer` }).from(sql`pg_temp.store_order_invoice_evidence`);
    expect(shadow.count).toBe(0);
  });
  expect((await f.db.select().from(storeOrderInvoiceEvidence)).map(row => row.kind).sort()).toEqual(['created', 'issued']);
});

it('resolves catalog types before caller temporary types on a fresh independent backend', async () => {
  await withFinancePeers(f.db, async ([peer]) => {
    await asRuntime(async tx => {
      // A temp table also defines a same-named composite type. The capture
      // function has not yet been compiled or invoked on this backend.
      await tx.execute(sql`CREATE TEMP TABLE regclass (fake integer) ON COMMIT DROP`);
      await tx.execute(sql.raw(`SET LOCAL search_path=pg_temp,"${schema}"`));
      await tx.update(storeOrderInvoice).set({ isInvoice: 1, invoiceNumber: '87654321' });
    }, peer.db);
  });
  expect((await f.db.select().from(storeOrderInvoiceEvidence)).map(row => row.documentNumber).sort()).toEqual(['', '87654321']);
});

async function splitAsRuntime() {
  await asRuntime(async tx => {
    const [source] = await tx.select().from(storeOrder).where(eq(storeOrder.id, 10)).for('update');
    const invoice = await prepareSplitInvoice(tx, source);
    await tx.insert(storeOrder).values([
      { ...source, id: 11, pid: 10, orderId: 'permission-child-a', payPrice: '3.33' },
      { ...source, id: 12, pid: 10, orderId: 'permission-child-b', payPrice: '6.67' },
    ]);
    await tx.update(storeOrder).set({ pid: -1 }).where(eq(storeOrder.id, 10));
    await materializeSplitInvoice(tx, source, invoice, [11, 12], 'fulfillment', 100);
    expect(await tx.select().from(storeOrderInvoiceAllocation)).toHaveLength(1);
    expect(await tx.select().from(storeOrderInvoiceEvidence)).toHaveLength(3);
  });
}
it('the actual allocation helper works with only receipt SELECT/INSERT and trigger-owned creation evidence', async () => {
  await splitAsRuntime();
  expect((await f.db.select().from(storeOrderInvoice).orderBy(storeOrderInvoice.id)).map(row => [row.invoiceAmount, row.isDel]))
    .toEqual([['10.00', 1], ['3.33', 0], ['6.67', 0]]);
});
it.each(['UPDATE store_order_invoice_allocation SET reason=\'supplier\'', 'DELETE FROM store_order_invoice_allocation',
  'TRUNCATE store_order_invoice_allocation'])('runtime cannot rewrite allocation lineage: %s', async statement => {
  await splitAsRuntime(); const before = await f.db.select().from(storeOrderInvoiceAllocation);
  await expectDenied(() => asRuntime(tx => tx.execute(sql.raw(statement))));
  expect(await f.db.select().from(storeOrderInvoiceAllocation)).toEqual(before);
});
