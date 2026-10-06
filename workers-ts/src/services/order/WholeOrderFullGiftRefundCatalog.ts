import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { INVOICE_EVIDENCE_CATALOG_SQL, INVOICE_CATALOG_VERSIONS } from '@/migrations/invoiceEvidenceCatalog';
import { REFUND_SPLIT_CATALOG_SQL, REFUND_SPLIT_CATALOG_VERSIONS } from '@/migrations/refundOrderSplitCatalog';
import { HttpApiException } from '@/utils/errors';

const expected = new Map<string, string>([
  ['table:store_order_invoice', INVOICE_CATALOG_VERSIONS.capturedBase],
  ['table:store_order_invoice_evidence', INVOICE_CATALOG_VERSIONS.history],
  ['table:store_order_invoice_allocation', INVOICE_CATALOG_VERSIONS.allocation],
  ['function:capture_invoice_evidence', INVOICE_CATALOG_VERSIONS.capture],
  ['function:protect_invoice_evidence', INVOICE_CATALOG_VERSIONS.protect],
  ['table:store_order_refund_split', REFUND_SPLIT_CATALOG_VERSIONS.split],
  ['table:store_order_fulfillment_branch', REFUND_SPLIT_CATALOG_VERSIONS.branch],
  ['function:protect_refund_order_split', REFUND_SPLIT_CATALOG_VERSIONS.protect],
]);
const unavailable = () => new HttpApiException('满送退款运行合同尚未就绪，请联系商家核对', 503, 503);

/** Public whole-order activation checks existing reviewed protocols only.
 * Runtime LOGINs need not own them. No DDL, grants, ownership change, cache or
 * missing-schema fallback is performed; maintenance commissioning stays explicit.
 * The same check runs before a quote, new claim and actual financial settlement. */
export async function assertWholeOrderFullGiftRefundCatalog(tx: DbClient): Promise<void> {
  if (Object.hasOwn(tx, '$client')) throw Error('Full-gift refund catalog requires the owning transaction');
  const [environment] = await tx.execute(sql`SELECT current_schema()='public'
    AND current_setting('server_version_num')::integer/10000=16
    AND current_setting('transaction_isolation')='read committed'
    AND current_setting('session_replication_role')='origin'
    AND NOT EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') AS ready`);
  if (environment?.ready !== true) throw unavailable();
  const rows = await tx.execute(sql.raw(`SELECT * FROM (${INVOICE_EVIDENCE_CATALOG_SQL}) invoice
    UNION ALL SELECT * FROM (${REFUND_SPLIT_CATALOG_SQL}) refund`));
  const seen = new Set<string>();
  if (rows.length !== expected.size) throw unavailable();
  for (const row of rows) {
    const key = `${row.kind}:${row.name}`;
    if (seen.has(key) || row.present !== true || row.safe !== true
      || row.fingerprint !== expected.get(key) || !expected.has(key)) throw unavailable();
    seen.add(key);
  }
  const [authority] = await tx.execute(sql`WITH owners AS (
    SELECT relowner AS owner FROM pg_class WHERE oid IN (
      'public.store_order_invoice'::regclass,'public.store_order_invoice_evidence'::regclass,
      'public.store_order_invoice_allocation'::regclass,'public.store_order_refund_split'::regclass,
      'public.store_order_fulfillment_branch'::regclass)
    UNION ALL SELECT proowner FROM pg_proc WHERE oid IN (
      'public.capture_invoice_evidence()'::regprocedure,'public.protect_invoice_evidence()'::regprocedure,
      'public.protect_refund_order_split()'::regprocedure)
  ) SELECT (SELECT count(DISTINCT owner) FROM owners)=1
    AND NOT EXISTS(SELECT 1 FROM (VALUES
      ('public.store_order_invoice','SELECT'),('public.store_order_invoice','UPDATE'),
      ('public.store_order_invoice_evidence','SELECT'),('public.store_order_invoice_allocation','SELECT'),
      ('public.store_order_invoice_allocation','INSERT'),('public.store_order_refund_split','SELECT'),
      ('public.store_order_refund_split','INSERT'),('public.store_order_fulfillment_branch','SELECT'),
      ('public.store_order_fulfillment_branch','INSERT')) required(name,privilege)
      WHERE NOT has_table_privilege(current_user,required.name,required.privilege)) AS ready`);
  if (authority?.ready !== true) throw unavailable();
}
