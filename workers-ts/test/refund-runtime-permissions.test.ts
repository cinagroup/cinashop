import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { refundRuntimeFixture, runtimeTablePrivileges, runtimeRowLockTables, runtimeSequenceTables, shipping } from './helpers/refundRuntimeFixture';
import { SupplierFulfillmentService } from '../src/services/supplier/SupplierFulfillmentService';
import { SupplierFinanceService } from '../src/services/supplier/SupplierFinanceService';
import { storeOrderInvoice, storeOrderFulfillmentBranch, storeOrderInvoiceEvidence, user } from '../src/models/schema';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('complete-schema independent runtime LOGIN', () => {
  let f: Awaited<ReturnType<typeof refundRuntimeFixture>>;
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
    f = await refundRuntimeFixture();
  }, 45_000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); }
  }, 45_000);

  it('has exactly the reviewed table/sequence/column grants, no ownership or maintenance authority', async () => {
    await f.withRuntime(async r => {
      const rows = await r.db.execute(sql`SELECT c.relname AS name,p.priv
        FROM pg_class c CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(priv)
        WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND has_table_privilege(current_user,c.oid,p.priv)`);
      const actual = rows.map(row => `${row.name}:${row.priv}`).sort();
      const expected = Object.entries(runtimeTablePrivileges).flatMap(([table, privileges]) => privileges.map(p => `${table}:${p}`)).sort();
      expect(actual).toEqual(expected);
      const sequences = await r.db.execute(sql`SELECT c.relname AS name,p.priv FROM pg_class c
        CROSS JOIN (VALUES ('SELECT'),('UPDATE'),('USAGE')) p(priv) WHERE c.relnamespace='public'::regnamespace
        AND c.relkind='S' AND has_sequence_privilege(current_user,c.oid,p.priv)`);
      expect(sequences.map(row => `${row.name}:${row.priv}`).sort()).toEqual(runtimeSequenceTables.map(t => `${t}_id_seq:USAGE`).sort());
      const columns = await r.db.execute(sql`SELECT c.relname AS name,a.attname AS col FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid
        WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped
        AND NOT has_table_privilege(current_user,c.oid,'UPDATE') AND has_column_privilege(current_user,c.oid,a.attnum,'UPDATE')`);
      expect(columns.map(row => `${row.name}:${row.col}`).sort()).toEqual(runtimeRowLockTables.map(t => `${t}:id`).sort());
      const [authority] = await r.db.execute(sql`SELECT current_user=session_user AS direct_login,
        rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls,
        has_schema_privilege(current_user,'public','CREATE') AS schema_create,
        EXISTS(SELECT 1 FROM pg_class WHERE relowner=r.oid AND relnamespace='public'::regnamespace) AS owns_objects,
        EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS membership
        FROM pg_roles r WHERE rolname=current_user`);
      expect(authority).toEqual({ direct_login: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false,
        rolinherit: false, rolreplication: false, rolbypassrls: false, schema_create: false, owns_objects: false, membership: false });
    });
  });

  it.each(['member_right', 'system_config'])('SELECT-only pricing authority creates through the fixed capability but cannot directly lock or write: %s', async table => {
    await f.withRuntime(async r => {
      const before = await f.state();
      await expect(r.db.transaction(tx => tx.execute(sql.raw(`LOCK TABLE public.${table} IN SHARE MODE NOWAIT`))))
        .rejects.toMatchObject({ cause: { code: '42501' } });
      await expect(r.exec(`UPDATE public.${table} SET id=id`)).rejects.toMatchObject({ code: '42501' });
      expect(await f.state()).toEqual(before);
      expect((await r.checkout()).orderId).toBe('runtime_checkout');
    });
  });

  it('runs checkout, invoice, refund, fulfillment fork, receipt and repeated refunds without owner authority', async () => {
    await f.withRuntime(async r => {
      const source = await r.createPaid(); expect(source.payPrice).toBe('55.00');
      await r.invoice(source.id);
      const first = await r.apply(source.id); expect(await r.finish(first.refundId)).toBe('completed');
      const remainder = (await r.receipt(first.refundId)).remainingOrderId!;
      expect((await r.order(remainder)).payPrice).toBe('42.20');
      const fulfillment = new SupplierFulfillmentService(r.container, f.env);
      const line = (await r.carts(remainder)).find(row => row.productId === 70)!;
      const fork = await fulfillment.splitDelivery(7, remainder, shipping, [{ cartId: line.cartId, cartNum: 1 }]);
      await fulfillment.confirmTake(7, fork.order_id);
      const second = await r.apply(fork.order_id); expect(await r.finish(second.refundId)).toBe('completed');
      const third = await r.apply(fork.remaining_order_id!, 71); expect(await r.finish(third.refundId)).toBe('completed');
      const [account] = await r.db.select().from(user).where(eq(user.uid, 11));
      expect(account.nowMoney).toBe('55.00'); expect(account.integral).toBe(100);
      const invoices = await r.db.select().from(storeOrderInvoice).where(eq(storeOrderInvoice.isDel, 0));
      expect(invoices.every(row => row.isRefund === 1)).toBe(true);
      expect(invoices.reduce((sum, row) => sum + Math.round(Number(row.invoiceAmount) * 100), 0)).toBe(5500);
      expect((await r.db.select().from(storeOrderFulfillmentBranch)).length).toBeGreaterThan(0);
      expect((await r.db.select().from(storeOrderInvoiceEvidence)).length).toBeGreaterThan(0);
      expect(await new SupplierFinanceService(r.container, f.env).summary(7)).toMatchObject({
        available: '0.00', pending_settlement: '0.00', total_refund: '31.00', pending_extract: '0.00', paid_extract: '0.00',
      });
      const done = await f.state();
      for (const id of [first.refundId, second.refundId, third.refundId]) expect(await r.finish(id)).toBe('already-completed');
      expect(await f.state()).toEqual(done);
    });
  });

  it.each(['store_order_refund_split', 'store_order_invoice'])('missing late INSERT on %s rolls back the refund and can recover once restored', async table => {
    await f.withRuntime(async r => {
      const source = await r.createPaid(); await r.invoice(source.id); const application = await r.apply(source.id);
      await f.exec(`REVOKE INSERT ON public.${table} FROM "${r.role}"`);
      const before = await f.state();
      await expect(r.finish(application.refundId)).rejects.toMatchObject({ cause: { code: '42501', message: `permission denied for table ${table}` } });
      expect(await f.state()).toEqual(before);
      await f.exec(`GRANT INSERT ON public.${table} TO "${r.role}"`);
      expect(await r.finish(application.refundId)).toBe('completed');
      expect((await r.receipt(application.refundId)).refundId).toBe(application.refundId);
      const recovered = await f.state(); expect(await r.finish(application.refundId)).toBe('already-completed');
      expect(await f.state()).toEqual(recovered);
    });
  });

  it('requires only a column UPDATE for the invoice title row lock, not broad template writes', async () => {
    await f.withRuntime(async r => {
      const source = await r.createPaid();
      await f.exec(`REVOKE UPDATE(id) ON public.user_invoice FROM "${r.role}"`);
      const before = await f.state();
      await expect(r.invoice(source.id)).rejects.toMatchObject({ cause: { code: '42501', message: 'permission denied for table user_invoice' } });
      expect(await f.state()).toEqual(before);
      await f.exec(`GRANT UPDATE(id) ON public.user_invoice TO "${r.role}"`);
      await r.invoice(source.id);
      await expect(r.exec("UPDATE public.user_invoice SET name='forbidden' WHERE id=1")).rejects.toMatchObject({ code: '42501' });
    });
  });

  it.each(['store_order_fulfillment_branch', 'store_order_invoice_allocation'])('rolls back a post-refund fulfillment fork without INSERT on %s', async table => {
    await f.withRuntime(async r => {
      const source = await r.createPaid(); await r.invoice(source.id);
      const first = await r.apply(source.id); await r.finish(first.refundId);
      const remaining = (await r.receipt(first.refundId)).remainingOrderId!;
      const line = (await r.carts(remaining)).find(row => row.productId === 70)!;
      const service = new SupplierFulfillmentService(r.container, f.env);
      const split = () => service.splitDelivery(7, remaining, shipping, [{ cartId: line.cartId, cartNum: 1 }]);
      await f.exec(`REVOKE INSERT ON public.${table} FROM "${r.role}"`);
      const before = await f.state();
      await expect(split()).rejects.toMatchObject({ cause: { code: '42501', message: `permission denied for table ${table}` } });
      expect(await f.state()).toEqual(before);
      await f.exec(`GRANT INSERT ON public.${table} TO "${r.role}"`);
      expect((await split()).split).toBe(true);
      expect((await r.db.select().from(storeOrderFulfillmentBranch)).length).toBeGreaterThan(0);
    });
  });

  it('cannot erase evidence, bypass triggers, reset sequences or recover maintenance authority', async () => {
    await f.withRuntime(async r => {
      const source = await r.createPaid(); await r.invoice(source.id);
      const first = await r.apply(source.id); await r.finish(first.refundId);
      const before = await f.state();
      for (const table of ['store_order_invoice_evidence', 'store_order_invoice_allocation', 'store_order_refund_split', 'store_order_fulfillment_branch']) {
        for (const statement of [`UPDATE public.${table} SET uid=uid`, `DELETE FROM public.${table}`, `TRUNCATE public.${table}`,
          `ALTER TABLE public.${table} DISABLE TRIGGER ALL`])
          await expect(r.exec(statement)).rejects.toMatchObject({ code: '42501' });
      }
      for (const statement of ["SET ROLE finance_test", "SET session_replication_role=replica",
        "SELECT setval('public.store_order_cart_info_id_seq',1,false)",
        'CREATE TABLE public.forbidden_runtime_ddl(id integer)',
        'INSERT INTO public.store_order_invoice_evidence SELECT * FROM public.store_order_invoice_evidence LIMIT 1',
        'UPDATE public.supplier_transactions SET pay_price=0'])
        await expect(r.exec(statement)).rejects.toMatchObject({ code: '42501' });
      const [functions] = await r.db.execute(sql`SELECT bool_and(NOT has_function_privilege(current_user,p.oid,'EXECUTE')) AS denied
        FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname IN
        ('capture_invoice_evidence','protect_invoice_evidence','protect_refund_order_split')`);
      expect(functions.denied).toBe(true);
      await r.exec('RESET ROLE');
      const [identity] = await r.db.execute(sql`SELECT current_user AS role, session_user AS session, pg_backend_pid() AS pid`);
      expect(identity).toEqual({ role: r.role, session: r.role, pid: r.pid });
      expect(await f.state()).toEqual(before);
    });
  });
});
