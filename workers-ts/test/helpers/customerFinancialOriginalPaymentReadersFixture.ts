import { sql } from 'drizzle-orm';
import { customerFinancialManualRuntimeFixture } from './customerFinancialManualRuntimeFixture';
import { upgradeCustomerFinancialManualRefundRuntime } from '../../src/migrations/upgradeCustomerFinancialManualRefundRuntime';
import { runCashierSecondCardOrigin } from '../../src/migrations/runCashierSecondCardOrigin';
import { installSupplierOrderEditOperation } from '../../src/migrations/supplierOrderEditOperation';
import { installLegacyOrderGainPartition } from '../../src/migrations/legacyOrderGainPartition';
import { CUSTOMER_FINANCIAL_ORIGINAL_PAYMENT_READ_TABLES } from '../../src/migrations/customerFinancialOriginalPaymentReaders';

/** Canonical185 and a genuine fixed manual Financial LOGIN. Source protocols
 * are explicitly installed by their existing maintenance APIs; no source
 * reader grant or reader forward is performed by this fixture. */
export async function customerFinancialOriginalPaymentReadersFixture() {
  const f = await customerFinancialManualRuntimeFixture();
  try {
    const manual = await upgradeCustomerFinancialManualRefundRuntime(f.db, f.target, f.addon);
    if (!manual.commissioned || !manual.audit.ready) throw Error('Complete manual profile required before original-payment readers');
    await runCashierSecondCardOrigin(f.db);
    await f.db.transaction(async tx => {
      await tx.execute(sql`SELECT set_config('search_path','public,pg_temp',true),
        set_config('statement_timeout','5000',true),set_config('lock_timeout','1000',true),
        set_config('idle_in_transaction_session_timeout','5000',true)`);
      await installSupplierOrderEditOperation(tx);
      await installLegacyOrderGainPartition(tx);
    }, { isolationLevel: 'read committed', accessMode: 'read write' });
    const originalPaymentReaders = { secondCard: true as const };
    const sourceAcl = () => f.db.execute(sql`SELECT c.relname,c.relowner::text AS owner,c.relacl::text,
      ARRAY(SELECT a.attacl::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 ORDER BY a.attnum) AS columns
      FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname IN
      (${sql.join(CUSTOMER_FINANCIAL_ORIGINAL_PAYMENT_READ_TABLES.map(name => sql`${name}`), sql`, `)}) ORDER BY c.relname`);
    const sourceRows = () => f.db.execute(sql`SELECT * FROM(SELECT 'origin' AS kind,to_jsonb(t) AS payload FROM public.cashier_second_card_origin_v1 t
      UNION ALL SELECT 'payment',to_jsonb(t) FROM public.cashier_second_card_payment_v1 t
      UNION ALL SELECT 'supplier_edit',to_jsonb(t) FROM public.supplier_order_edit_operation_v1 t
      UNION ALL SELECT 'legacy_partition',to_jsonb(t) FROM public.legacy_order_gain_partition_v1 t) sources ORDER BY kind,payload::text`);
    return { ...f, originalPaymentReaders, sourceAcl, sourceRows };
  } catch (error) { await f.close(); throw error; }
}
